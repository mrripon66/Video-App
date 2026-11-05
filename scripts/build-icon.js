'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const size = 256;
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function chunk(type, bytes) {
  const body = Buffer.concat([Buffer.from(type), bytes]);
  let c = 0xffffffff;
  for (const b of body) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  const result = Buffer.alloc(bytes.length + 12);
  result.writeUInt32BE(bytes.length); body.copy(result, 4); result.writeUInt32BE((c ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}
function polygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i], [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const pixels = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const offset = y * (size * 4 + 1) + 1 + x * 4;
  const corner = Math.hypot(Math.max(44 - x, x - 211, 0), Math.max(44 - y, y - 211, 0)) > 44;
  const v = polygon(x, y, [[46, 63], [91, 63], [130, 159], [165, 63], [208, 63], [148, 199], [111, 199]]);
  const color = v ? [23, 52, 57] : [183, 225, 207];
  pixels[offset] = color[0]; pixels[offset + 1] = color[1]; pixels[offset + 2] = color[2]; pixels[offset + 3] = corner ? 0 : 255;
}
const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
const icoHeader = Buffer.alloc(22); icoHeader.writeUInt16LE(1, 2); icoHeader.writeUInt16LE(1, 4); icoHeader.writeUInt16LE(1, 10); icoHeader.writeUInt16LE(32, 12); icoHeader.writeUInt32LE(png.length, 14); icoHeader.writeUInt32LE(22, 18);
const directory = path.join(__dirname, '..', 'src', 'assets'); fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(directory, 'icon.png'), png); fs.writeFileSync(path.join(directory, 'icon.ico'), Buffer.concat([icoHeader, png]));
