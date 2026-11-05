'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const resources = path.join(root, 'resources', 'voice');
const cache = path.join(root, '.voice-cache');
const ASSETS = Object.freeze({
  runtime: { filename: 'whisper-b5454-cpu-x64.zip', size: 8928640,
    url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip',
    sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb' },
  model: { filename: 'ggml-tiny.bin', size: 77691713,
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny.bin',
    sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21' },
  microsoft: { filename: 'VC_redist-14.51.36247-x64.exe', size: 18731856,
    url: 'https://download.visualstudio.microsoft.com/download/pr/ebdab8e5-1d7b-4d9f-a11b-cbb1720c3b12/843068991DAAA1F73AD9F6239BCE4D0F6A07A51F18C37EA2A867E9BECA71295C/VC_redist.x64.exe',
    sha256: '843068991daaa1f73ad9f6239bce4d0f6a07a51f18c37ea2a867e9beca71295c' },
});

async function fileHash(filename) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
async function validAsset(filename, asset) {
  return fs.existsSync(filename) && fs.statSync(filename).size === asset.size && await fileHash(filename) === asset.sha256;
}
async function download(asset) {
  const destination = path.join(cache, asset.filename);
  if (await validAsset(destination, asset)) return destination;
  console.log(`Downloading verified offline speech asset: ${asset.filename} (${Math.ceil(asset.size / 1024 / 1024)} MiB)`);
  const temporary = destination + '.part';
  try {
    const response = await fetch(asset.url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
    if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
    if (new URL(response.url).protocol !== 'https:') throw new Error('A download was redirected away from HTTPS.');
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary));
    if (!(await validAsset(temporary, asset))) throw new Error(`Checksum or size mismatch for ${asset.filename}; the file was not used.`);
    fs.renameSync(temporary, destination);
    return destination;
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}
function command(file, args, options = {}) {
  return execFileSync(file, args, { windowsHide: true, timeout: 120000, stdio: 'pipe', ...options });
}
function expandCab(filename, destination) {
  fs.mkdirSync(destination, { recursive: true });
  command(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'expand.exe'), ['-F:*', filename, destination]);
}
function unpackMicrosoft(filename, staging, bin) {
  // The hash-pinned official Burn bundle contains an attached cabinet. Reading
  // the CAB archive does not run its installer or change Windows. Only the x64
  // redistributable DLLs are copied beside our speech executable.
  const bytes = fs.readFileSync(filename);
  const cabinets = [];
  for (let offset = bytes.indexOf('MSCF'); offset >= 0; offset = bytes.indexOf('MSCF', offset + 1)) {
    if (offset + 36 > bytes.length || bytes.readUInt32LE(offset + 4) !== 0) continue;
    const size = bytes.readUInt32LE(offset + 8);
    if (size > 36 && offset + size <= bytes.length) cabinets.push({ offset, size });
  }
  const attached = cabinets.sort((a, b) => b.size - a.size)[0];
  if (!attached) throw new Error('The pinned Microsoft runtime cabinet could not be found.');
  const cabinet = path.join(staging, 'microsoft.cab');
  fs.writeFileSync(cabinet, bytes.subarray(attached.offset, attached.offset + attached.size));
  const payload = path.join(staging, 'microsoft-payload');
  expandCab(cabinet, payload);
  const minimum = path.join(staging, 'microsoft-minimum');
  // a4 is the x64 minimum-runtime CAB in the pinned 14.51.36247 bundle.
  expandCab(path.join(payload, 'a4'), minimum);
  const names = fs.readdirSync(minimum).filter(name => /^(concrt140|msvcp140(?:_[a-z0-9_]+)?|vcruntime140(?:_[a-z0-9_]+)?|vcomp140)\.dll_amd64$/i.test(name));
  for (const required of ['msvcp140.dll_amd64', 'vcruntime140.dll_amd64', 'vcruntime140_1.dll_amd64', 'vcomp140.dll_amd64']) {
    if (!names.includes(required)) throw new Error(`The pinned Microsoft package is missing ${required}.`);
  }
  for (const name of names) fs.copyFileSync(path.join(minimum, name), path.join(bin, name.replace(/_amd64$/, '')));
}

async function setupVoice() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Bundled offline voice is built for Windows x64.');
  fs.mkdirSync(cache, { recursive: true });
  fs.mkdirSync(resources, { recursive: true });
  // Start the model first, so a slower model transfer can finish while assets are fetched.
  const modelPromise = download(ASSETS.model);
  const archivePromise = download(ASSETS.runtime);
  const microsoftPromise = download(ASSETS.microsoft);
  const [model, archive, microsoft] = await Promise.all([modelPromise, archivePromise, microsoftPromise]);
  const staging = fs.mkdtempSync(path.join(cache, 'stage-'));
  try {
    const extracted = path.join(staging, 'whisper');
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    command(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      'Expand-Archive -LiteralPath $env:STUDIO_VOICE_ARCHIVE -DestinationPath $env:STUDIO_VOICE_EXTRACT -Force'],
    { env: { ...process.env, STUDIO_VOICE_ARCHIVE: archive, STUDIO_VOICE_EXTRACT: extracted } });
    const source = path.join(extracted, 'Release');
    const bin = path.join(resources, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    for (const name of fs.readdirSync(source)) {
      if (name === 'whisper-cli.exe' || name === 'whisper.dll' || name === 'ggml.dll' || name === 'ggml-base.dll' || /^ggml-cpu-[a-z0-9]+\.dll$/i.test(name)) {
        fs.copyFileSync(path.join(source, name), path.join(bin, name));
      }
    }
    unpackMicrosoft(microsoft, staging, bin);
    fs.copyFileSync(model, path.join(resources, 'ggml-tiny.bin'));
    const licenses = path.join(resources, 'licenses');
    fs.mkdirSync(licenses, { recursive: true });
    for (const name of ['whisper.cpp-LICENSE.txt', 'whisper-model-LICENSE.txt', 'MICROSOFT-VC-RUNTIME-NOTICE.md']) {
      fs.copyFileSync(path.join(root, 'third-party', name), path.join(licenses, name));
    }
    const manifest = { schemaVersion: 1, whisperVersion: '1.9.5', build: 'b5454', cli: 'bin/whisper-cli.exe', model: 'ggml-tiny.bin',
      modelSha256: ASSETS.model.sha256, modelBytes: ASSETS.model.size, microsoftRuntime: '14.51.36247', platform: 'win32-x64' };
    fs.writeFileSync(path.join(resources, 'voice.json'), JSON.stringify(manifest, null, 2) + '\n');
    const result = command(path.join(bin, 'whisper-cli.exe'), ['-ng', '--help'], { encoding: 'utf8' });
    if (!String(result).includes('usage:')) {
      // whisper-cli prints help to stderr; successful exit is sufficient when
      // execFileSync captured its empty stdout.
      console.log('Whisper CPU executable passed its startup check.');
    }
    console.log(`Offline voice ready: ${path.relative(root, resources)} (multilingual tiny, CPU only).`);
    return manifest;
  } finally {
    if (path.dirname(staging) !== cache || !path.basename(staging).startsWith('stage-')) throw new Error('Unsafe speech staging directory.');
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

if (require.main === module) setupVoice().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { setupVoice, ASSETS, fileHash, validAsset };
