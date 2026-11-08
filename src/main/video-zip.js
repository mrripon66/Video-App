'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { ZipFile } = require('yazl');

function entryName(video, index, count) {
  const title = Array.from(video.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim())
    .slice(0, 70).join('').replace(/[. ]+$/, '');
  const number = String(index + 1).padStart(String(count).length, '0');
  return `${number} - ${title || 'Video'}${path.extname(video.source).toLowerCase()}`;
}

async function writeVideoZip(destination, videos) {
  const temporary = path.join(path.dirname(destination), `.ai-video-${randomUUID()}.zip.partial`);
  const zip = new ZipFile();
  const output = fs.createWriteStream(temporary, { flags: 'wx' });
  const transfer = pipeline(zip.outputStream, output);
  zip.on('error', error => zip.outputStream.destroy(error));
  try {
    try {
      // Video files are already compressed. Stream them directly, with ZIP64 when needed.
      for (const [index, video] of videos.entries()) {
        zip.addFile(video.source, entryName(video, index, videos.length), { compress: false });
      }
      zip.end();
    } catch (error) {
      zip.outputStream.destroy(error);
    }
    await transfer;
    await fs.promises.rename(temporary, destination);
  } finally {
    await fs.promises.unlink(temporary).catch(() => {});
  }
}

module.exports = { writeVideoZip };
