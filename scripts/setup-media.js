'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const EXPECTED_SHA256 = '04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00';
function setupMedia() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('The packaged media tool targets Windows x64.');
  const binary = require('ffmpeg-static');
  const hash = createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
  if (hash !== EXPECTED_SHA256) throw new Error('The video assembly binary checksum does not match the reviewed Windows build.');
  const destination = path.resolve(__dirname, '..', 'resources', 'media');
  fs.mkdirSync(destination, { recursive: true });
  for (const name of ['ffmpeg.exe', 'ffmpeg.exe.LICENSE', 'ffmpeg.exe.README']) {
    fs.copyFileSync(path.join(path.dirname(binary), name), path.join(destination, name));
  }
  console.log('Verified and staged FFmpeg 6.1.1 for local video assembly.');
}
if (require.main === module) setupMedia();
module.exports = { setupMedia, EXPECTED_SHA256 };
