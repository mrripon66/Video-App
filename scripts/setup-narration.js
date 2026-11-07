'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { execFileSync } = require('node:child_process');
const { validAsset } = require('./setup-voice');

const root = path.resolve(__dirname, '..');
const cache = path.join(root, '.narration-cache');
const resources = path.join(root, 'resources', 'narration');
const release = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';
const runtimeStem = 'sherpa-onnx-v2.0.1-win-x64-shared-MT-Release';
const modelStem = 'kitten-mini-en-v0_8';
const assets = {
  runtime: { filename: `${runtimeStem}.tar.bz2`, url: `${release}/v2.0.1/${runtimeStem}.tar.bz2`, size: 26664192,
    sha256: 'dc703575a68594435f53dec93df775ff4913af851a196c0537163f21d8d2364e' },
  model: { filename: `${modelStem}.tar.bz2`, url: `${release}/tts-models/${modelStem}.tar.bz2`, size: 67547594,
    sha256: '518f9b130320f690d5b5476df77bde4215fca67773cda16710318e5081234b9d' },
  lexicon: { filename: 'lexicon-en-us.txt', url: `${release}/tts-models/lexicon-en-us.txt`, size: 6305773,
    sha256: '8b67ae549a465eee78f92ecb74644ad90c3c58ce65f19c68baf85878a10ef73a' },
  sherpaLicense: { filename: 'sherpa-LICENSE.txt', url: 'https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/v2.0.1/LICENSE', size: 11358,
    sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30' },
  onnxLicense: { filename: 'onnxruntime-LICENSE.txt', url: 'https://raw.githubusercontent.com/microsoft/onnxruntime/v1.28.2/LICENSE', size: 1073,
    sha256: '2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c' },
  onnxNotices: { filename: 'onnxruntime-ThirdPartyNotices.txt', url: 'https://raw.githubusercontent.com/microsoft/onnxruntime/v1.28.2/ThirdPartyNotices.txt', size: 325054,
    sha256: '0e07b95f3a8d6230037707c5c4a2b554d12c4cb67369669ac255635528ffcee2' },
  cmuLicense: { filename: 'CMUDict-LICENSE.txt', url: 'https://raw.githubusercontent.com/cmusphinx/cmudict/74790861f652b15e4ac49015a90074ad62a27690/LICENSE', size: 1754,
    sha256: 'bd4ce8e44170a5f9f481310ca85c51de3c4f851a65e679b40e603b143bd3542a' },
};

async function download(asset) {
  const destination = path.join(cache, asset.filename);
  if (await validAsset(destination, asset)) return destination;
  console.log(`Fetching verified narration asset ${asset.filename}`);
  const temporary = destination + '.' + randomUUID() + '.part';
  try {
    const response = await fetch(asset.url, { signal: AbortSignal.timeout(600000) });
    if (!response.ok || !response.body || new URL(response.url).protocol !== 'https:') throw new Error(`Could not download ${asset.filename}.`);
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary, { flags: 'wx' }));
    if (!await validAsset(temporary, asset)) throw new Error(`The downloaded ${asset.filename} failed checksum verification.`);
    fs.renameSync(temporary, destination);
    return destination;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

async function setupNarration() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Bundled narration is built for Windows x64.');
  fs.mkdirSync(cache, { recursive: true });
  const [runtime, model, lexicon, ...licenses] = await Promise.all(Object.values(assets).map(download));
  const staging = fs.mkdtempSync(path.join(cache, 'stage-'));
  try {
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    for (const archive of [runtime, model]) execFileSync(tar, ['-xf', archive, '-C', staging], { windowsHide: true, timeout: 120000 });
    for (const folder of ['bin', 'model', 'licenses']) fs.mkdirSync(path.join(resources, folder), { recursive: true });
    const engineFiles = ['sherpa-onnx-offline-tts.exe', 'onnxruntime.dll', 'onnxruntime_providers_shared.dll'];
    for (const filename of engineFiles) fs.copyFileSync(path.join(staging, runtimeStem, 'bin', filename), path.join(resources, 'bin', filename));
    for (const filename of ['model.onnx', 'voices.bin', 'tokens.txt']) {
      fs.copyFileSync(path.join(staging, modelStem, filename), path.join(resources, 'model', filename));
    }
    fs.copyFileSync(lexicon, path.join(resources, 'model', assets.lexicon.filename));
    fs.copyFileSync(path.join(staging, modelStem, 'LICENSE'), path.join(resources, 'licenses', 'KittenTTS-Mini-LICENSE.txt'));
    for (const license of licenses) fs.copyFileSync(license, path.join(resources, 'licenses', path.basename(license)));
    fs.copyFileSync(path.join(root, 'third-party', 'NARRATION-NOTICE.md'), path.join(resources, 'licenses', 'NARRATION-NOTICE.md'));

    // Verify the delivered CPU engine can speak, rather than only checking file names.
    const { writeNarration } = require('../src/main/narration');
    const audio = await writeNarration({ filename: path.join(staging, 'offline-smoke.wav'), text: 'Offline narration is ready.' });
    if (audio.durationSeconds < 0.2) throw new Error('The narration setup test returned an implausibly short result.');
    console.log(`KittenTTS Mini offline narration is ready (${audio.durationSeconds.toFixed(2)} s sample).`);
  } finally {
    const absoluteCache = fs.realpathSync(cache);
    const absoluteStage = fs.realpathSync(staging);
    if (path.dirname(absoluteStage) === absoluteCache && path.basename(absoluteStage).startsWith('stage-')) {
      fs.rmSync(absoluteStage, { recursive: true, force: true });
    }
  }
}

if (require.main === module) setupNarration().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { setupNarration };
