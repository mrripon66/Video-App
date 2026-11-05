'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

function validateMediaUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
    !(url.hostname === 'fal.media' || url.hostname.endsWith('.fal.media') || url.hostname === 'fal-cdn.batuhan-941.workers.dev' || url.hostname === 'lightricks-ltx-video-distilled.hf.space')) {
    throw new Error('The provider returned an unsupported media host. No file was downloaded.');
  }
  return url;
}
function isMp4(buffer, totalBytes) {
  if (buffer.length < 32 || buffer.toString('latin1', 4, 8) !== 'ftyp') return false;
  const typeSize = buffer.readUInt32BE(0);
  if (typeSize < 16 || typeSize % 4 || typeSize > buffer.length || typeSize > totalBytes) return false;
  const brands = [buffer.toString('latin1', 8, 12)];
  for (let offset = 16; offset < typeSize; offset += 4) brands.push(buffer.toString('latin1', offset, offset + 4));
  const imageOrAudioBrands = new Set(['avif', 'avis', 'heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'miaf', 'M4A ', 'M4B ', 'M4P ', 'F4A ', 'F4B ']);
  if (brands.some(brand => imageOrAudioBrands.has(brand))) return false;
  if (!brands.some(brand => /^(isom|iso[2-9]|mp4[12]|avc[1-4]|hvc[12]|hev[12]|av01|M4V |MSNV|dash|qt  |3gp[4-9]|3g2[a-c])$/.test(brand))) return false;
  // Require a movie/media box beyond ftyp, with a size that fits the complete
  // download. This is container screening, not a replacement for a decoder.
  for (let offset = typeSize; offset + 8 <= buffer.length;) {
    let size = buffer.readUInt32BE(offset), headerSize = 8;
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    if (size === 1) {
      if (offset + 16 > buffer.length) return false;
      const large = buffer.readBigUInt64BE(offset + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return false;
      size = Number(large); headerSize = 16;
    } else if (size === 0) size = totalBytes - offset;
    if (size < headerSize || offset + size > totalBytes) return false;
    if (type === 'moov' || type === 'mdat') return size > headerSize;
    offset += size;
  }
  return false;
}
function ebmlInteger(buffer, offset, maximumLength, isId = false) {
  const first = buffer[offset];
  if (!first) return null;
  let mask = 0x80, length = 1;
  while (!(first & mask)) { mask >>= 1; length++; }
  if (length > maximumLength || offset + length > buffer.length) return null;
  let value = isId ? first : first & (mask - 1);
  let unknown = !isId && value === mask - 1;
  for (let index = 1; index < length; index++) {
    value = value * 256 + buffer[offset + index];
    unknown = unknown && buffer[offset + index] === 255;
  }
  if (!unknown && !Number.isSafeInteger(value)) return null;
  return { value: unknown ? 0 : value, length, unknown };
}
function isWebM(buffer, totalBytes) {
  if (buffer.length < 32 || buffer.readUInt32BE(0) !== 0x1a45dfa3) return false;
  const headerSize = ebmlInteger(buffer, 4, 8);
  if (!headerSize || headerSize.unknown) return false;
  const headerEnd = 4 + headerSize.length + headerSize.value;
  if (headerEnd > buffer.length) return false;
  let docTypeFound = false;
  for (let offset = 4 + headerSize.length; offset < headerEnd;) {
    const id = ebmlInteger(buffer, offset, 4, true);
    if (!id) return false;
    const size = ebmlInteger(buffer, offset + id.length, 8);
    if (!size || size.unknown) return false;
    const start = offset + id.length + size.length, end = start + size.value;
    if (end > headerEnd) return false;
    if (id.value === 0x4282) {
      if (docTypeFound || buffer.toString('latin1', start, end) !== 'webm') return false;
      docTypeFound = true;
    }
    offset = end;
  }
  if (!docTypeFound || headerEnd + 5 > buffer.length || buffer.readUInt32BE(headerEnd) !== 0x18538067) return false;
  const segmentSize = ebmlInteger(buffer, headerEnd + 4, 8);
  if (!segmentSize) return false;
  const segmentStart = headerEnd + 4 + segmentSize.length;
  if (segmentStart + 8 >= totalBytes || (!segmentSize.unknown && (segmentSize.value < 8 || segmentStart + segmentSize.value > totalBytes))) return false;
  const firstChild = ebmlInteger(buffer, segmentStart, 4, true);
  if (!firstChild || ![0x114d9b74, 0x1549a966, 0x1654ae6b, 0x1f43b675, 0xec, 0xbf].includes(firstChild.value)) return false;
  const childSize = ebmlInteger(buffer, segmentStart + firstChild.length, 8);
  if (!childSize) return false;
  if (childSize.unknown) return firstChild.value === 0x1f43b675;
  const childEnd = segmentStart + firstChild.length + childSize.length + childSize.value;
  return childSize.value > 0 && childEnd <= totalBytes && (segmentSize.unknown || childEnd <= segmentStart + segmentSize.value);
}
function isVideo(buffer, totalBytes = buffer.length) {
  return Buffer.isBuffer(buffer) && Number.isSafeInteger(totalBytes) && totalBytes >= buffer.length &&
    (isMp4(buffer, totalBytes) || isWebM(buffer, totalBytes));
}
async function downloadVideo(url, jobId, directory, fetchImpl = fetch) {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(jobId)) throw new Error('Invalid video identifier.');
  let current = validateMediaUrl(url);
  const signal = AbortSignal.timeout(10 * 60 * 1000);
  let response;
  for (let i = 0; i <= 5; i++) {
    response = await fetchImpl(current, { signal, redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      if (i === 5) throw new Error('Too many media download redirects.');
      current = validateMediaUrl(new URL(response.headers.get('location'), current).href);
      continue;
    }
    break;
  }
  if (!response.ok || !response.body) throw new Error(`Video download failed (HTTP ${response.status}). Retry download in the queue.`);
  const maxBytes = 1024 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body.cancel();
    throw new Error('Video exceeds the 1 GB download limit.');
  }
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `${jobId}.part`);
  let bytes = 0;
  let header = Buffer.alloc(0);
  try {
    await pipeline(Readable.fromWeb(response.body), new Transform({
      transform(chunk, encoding, callback) {
        bytes += chunk.length;
        if (header.length < 4096) header = Buffer.concat([header, chunk.subarray(0, 4096 - header.length)]);
        callback(bytes > maxBytes ? new Error('Video exceeds the 1 GB download limit.') : null, chunk);
      }
    }), fs.createWriteStream(temporary), { signal });
    if (!isVideo(header, bytes)) throw new Error('The provider output is not a supported MP4 or WebM video.');
    const extension = header.toString('latin1', 4, 8) === 'ftyp' ? '.mp4' : '.webm';
    const destination = path.join(directory, jobId + extension);
    fs.renameSync(temporary, destination);
    return destination;
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}
module.exports = { downloadVideo, validateMediaUrl, isVideo };
