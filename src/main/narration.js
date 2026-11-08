'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const exec = promisify(execFile);
const MAX_NARRATION_CHARS = 700;
const NARRATION_VOICES = Object.freeze({ warm: 'Warm English voice', clear: 'Clear English voice' });
const speakerIds = Object.freeze({ kokoro: { warm: 3, clear: 16 }, kitten: { warm: 3, clear: 0 } });

function narrationAssets() {
  if (process.platform !== 'win32' || process.arch !== 'x64') return null;
  const packaged = process.versions.electron && require('electron').app?.isPackaged;
  const root = packaged ? path.join(process.resourcesPath, 'narration')
    : path.resolve(__dirname, '..', '..', 'resources', 'narration');
  const bin = path.join(root, 'bin');
  const executable = path.join(bin, 'sherpa-onnx-offline-tts.exe');
  if (![executable, path.join(bin, 'onnxruntime.dll'), path.join(bin, 'onnxruntime_providers_shared.dll')].every(file => fs.existsSync(file))) return null;

  for (const [engine, folder, model, lexicon] of [
    ['kokoro', 'kokoro', 'model.int8.onnx', 'lexicon-us-en.txt'],
    ['kitten', 'model', 'model.onnx', 'lexicon-en-us.txt'],
  ]) {
    // Relative model paths keep commas in an install location out of Kokoro's lexicon list.
    const files = Object.fromEntries(Object.entries({ model, lexicon, voices: 'voices.bin', tokens: 'tokens.txt' })
      .map(([kind, filename]) => [kind, path.join('..', folder, filename)]));
    if (Object.values(files).every(file => fs.existsSync(path.resolve(bin, file)))) return { executable, engine, files };
  }
  return null;
}

function narrationEngine() { return narrationAssets()?.engine ?? null; }

function narrationAvailable() {
  return narrationEngine() !== null;
}

function readWave(bytes) {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('The voice engine did not produce a valid WAV file.');
  }
  let sampleRate, blockAlign, samples;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const type = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > bytes.length) throw new Error('The narration WAV ended early.');
    if (type === 'fmt ' && size >= 16) {
      const format = bytes.readUInt16LE(start);
      const channels = bytes.readUInt16LE(start + 2);
      sampleRate = bytes.readUInt32LE(start + 4);
      blockAlign = bytes.readUInt16LE(start + 12);
      if (format !== 1 || channels !== 1 || sampleRate !== 24000 || blockAlign !== 2 || bytes.readUInt16LE(start + 14) !== 16) {
        throw new Error('The voice engine returned an unsupported audio format.');
      }
    } else if (type === 'data') samples = bytes.subarray(start, start + size);
    offset = start + size + (size % 2);
  }
  if (!sampleRate || !samples?.length || samples.length % blockAlign) throw new Error('The voice engine returned an empty or incomplete recording.');
  for (let offset = 0; offset < samples.length; offset += 2) {
    if (Math.abs(samples.readInt16LE(offset)) > 32) return { durationSeconds: samples.length / (sampleRate * blockAlign), sampleRate };
  }
  throw new Error('The voice engine returned a silent recording. Try a complete English sentence.');
}

async function writeNarration({ filename, text, voice = 'warm' }) {
  if (typeof filename !== 'string' || !/\.wav$/i.test(filename)) throw new Error('Choose a WAV output for narration.');
  if (!Object.hasOwn(NARRATION_VOICES, voice)) throw new Error('Choose a supported English narration voice.');
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_NARRATION_CHARS || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new Error(`Enter narration of 1 to ${MAX_NARRATION_CHARS} characters.`);
  }
  const assets = narrationAssets();
  if (!assets) throw new Error('The offline narration assets are missing. Reinstall the Windows update to restore them.');

  const line = text.trim().replace(/\s+/g, ' ').replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, ', ').replace(/…/g, '...');
  const { engine, files } = assets;
  const output = path.resolve(filename);
  const temporary = path.join(path.dirname(output), `.studio-narration-${randomUUID()}.wav`);
  try {
    const args = [
      ...Object.entries(files).map(([kind, file]) => `--${engine}-${kind}=${file}`),
      '--provider=cpu', '--num-threads=2', '--debug=false',
      ...(engine === 'kokoro' ? ['--tts-silence-scale=0.7'] : []),
      `--sid=${speakerIds[engine][voice]}`, '--print-args=false', `--output-filename=${temporary}`, '--', line,
    ];
    try {
      // The explicit option terminator treats the script as a single literal argument.
      await exec(assets.executable, args, { windowsHide: true, cwd: path.dirname(assets.executable), timeout: 90000, maxBuffer: 2 * 1024 * 1024 });
    } catch {
      throw new Error('Offline narration could not render. Use a short English script with ordinary spelling and punctuation.');
    }
    const size = (await fs.promises.stat(temporary)).size;
    if (size > 8 * 1024 * 1024) throw new Error('The generated narration is too long. Shorten your script.');
    const audio = readWave(await fs.promises.readFile(temporary));
    await fs.promises.copyFile(temporary, output, fs.constants.COPYFILE_EXCL);
    return audio;
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
}

module.exports = { writeNarration, narrationAvailable, narrationEngine, NARRATION_VOICES, MAX_NARRATION_CHARS };
