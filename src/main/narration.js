'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const exec = promisify(execFile);
const MAX_NARRATION_CHARS = 700;
const NARRATION_VOICES = Object.freeze({ warm: 'Warm English voice', clear: 'Clear English voice' });
const speakerIds = Object.freeze({ warm: 3, clear: 0 });

function assetPaths() {
  const packaged = process.versions.electron && require('electron').app?.isPackaged;
  const root = packaged ? path.join(process.resourcesPath, 'narration')
    : path.resolve(__dirname, '..', '..', 'resources', 'narration');
  return {
    executable: path.join(root, 'bin', 'sherpa-onnx-offline-tts.exe'),
    runtime: path.join(root, 'bin', 'onnxruntime.dll'),
    providers: path.join(root, 'bin', 'onnxruntime_providers_shared.dll'),
    model: path.join(root, 'model', 'model.onnx'),
    voices: path.join(root, 'model', 'voices.bin'),
    tokens: path.join(root, 'model', 'tokens.txt'),
    lexicon: path.join(root, 'model', 'lexicon-en-us.txt'),
  };
}

function narrationAvailable() {
  return process.platform === 'win32' && process.arch === 'x64' && Object.values(assetPaths()).every(file => fs.existsSync(file));
}

function readWave(bytes) {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('The voice engine did not produce a valid WAV file.');
  }
  let sampleRate, blockAlign, dataBytes;
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
    } else if (type === 'data') dataBytes = size;
    offset = start + size + (size % 2);
  }
  if (!sampleRate || !dataBytes || dataBytes % blockAlign) throw new Error('The voice engine returned an empty or incomplete recording.');
  return { durationSeconds: dataBytes / (sampleRate * blockAlign), sampleRate };
}

async function writeNarration({ filename, text, voice = 'warm' }) {
  if (typeof filename !== 'string' || !/\.wav$/i.test(filename)) throw new Error('Choose a WAV output for narration.');
  if (!Object.hasOwn(speakerIds, voice)) throw new Error('Choose a supported English narration voice.');
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_NARRATION_CHARS || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new Error(`Enter narration of 1 to ${MAX_NARRATION_CHARS} characters.`);
  }
  if (!narrationAvailable()) throw new Error('The offline narration assets are missing. Reinstall the Windows update to restore them.');

  const line = text.trim().replace(/\s+/g, ' ').replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, ', ').replace(/…/g, '...');
  const assets = assetPaths();
  const output = path.resolve(filename);
  const temporary = path.join(path.dirname(output), `.studio-narration-${randomUUID()}.wav`);
  try {
    const args = [
      `--kitten-model=${assets.model}`, `--kitten-voices=${assets.voices}`, `--kitten-tokens=${assets.tokens}`,
      `--kitten-lexicon=${assets.lexicon}`, '--provider=cpu', '--num-threads=2', '--debug=false',
      `--sid=${speakerIds[voice]}`, '--print-args=false', `--output-filename=${temporary}`, '--', line,
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

module.exports = { writeNarration, narrationAvailable, NARRATION_VOICES, MAX_NARRATION_CHARS };
