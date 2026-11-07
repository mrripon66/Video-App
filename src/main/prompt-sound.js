'use strict';
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');

const exec = promisify(execFile);
const REVISION = '30cb2644da54bfa63275d1bc7f1fa67fc718680f';
const SOURCE_REVISION = '790793b89ddceea612be9ce42ff6830d18f6fa57';
const LAUNCH = "import runpy,sys;sys.path.insert(0,sys.argv.pop(1));runpy.run_path(sys.argv.pop(1),run_name='__main__')";
const MODEL_FILES = [
  'models/tokenizer.model', 'models/tflite/t5gemma/encoder_fp16.tflite',
  'models/tflite/sa3-sm-sfx/dit_w8a8.tflite', 'models/tflite/same-s/dec_w8a8.tflite',
];
let generating = false;

function soundEngine() {
  const configured = process.env.AI_VIDEO_STUDIO_PROMPT_SOUND_DIR;
  const local = process.env.LOCALAPPDATA;
  if (process.platform !== 'win32' || (!configured && !local)) return null;
  const directory = path.resolve(configured || path.join(local, 'AI Video Studio', 'prompt-sound'));
  try {
    const info = JSON.parse(fs.readFileSync(path.join(directory, 'ready.json'), 'utf8'));
    if (info.schema !== 1 || info.model !== REVISION || info.source !== SOURCE_REVISION ||
      !path.isAbsolute(info.python) || !fs.statSync(info.python).isFile()) return null;
    const engine = path.join(directory, 'engine');
    const dependencies = path.join(directory, 'python-deps');
    const script = path.join(engine, 'scripts', 'sa3_tflite.py');
    if (!fs.statSync(dependencies).isDirectory() || !fs.statSync(script).isFile() ||
      MODEL_FILES.some(filename => !fs.statSync(path.join(engine, filename)).isFile())) return null;
    return { python: info.python, engine, dependencies, script };
  } catch {
    return null;
  }
}

function promptSoundAvailable() {
  return soundEngine() !== null;
}

function checkWave(bytes, durationSeconds) {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('The local sound model did not return a WAV file.');
  }
  let pcm = false, samples;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > bytes.length) break;
    if (id === 'fmt ' && size >= 16) {
      pcm = bytes.readUInt16LE(start) === 1 && bytes.readUInt16LE(start + 2) === 2 &&
        bytes.readUInt32LE(start + 4) === 44100 && bytes.readUInt16LE(start + 14) === 16;
    } else if (id === 'data') samples = bytes.subarray(start, start + size);
    offset = start + size + (size % 2);
  }
  if (!pcm || !samples || samples.length % 4 || Math.abs(samples.length / 176400 - durationSeconds) > 0.08) {
    throw new Error('The local model returned sound in an unexpected format or length.');
  }
  for (let offset = 0; offset < samples.length; offset += 2) {
    if (Math.abs(samples.readInt16LE(offset)) > 32) return;
  }
  throw new Error('The model returned a silent clip. Try describing a clearer sound.');
}

async function writePromptSound({ filename, prompt, durationSeconds }) {
  if (typeof filename !== 'string' || !/\.wav$/i.test(filename)) throw new Error('Choose a WAV destination for generated sound.');
  const description = typeof prompt === 'string' ? prompt.replace(/\s+/g, ' ').trim() : '';
  if (!description || description.length > 600 || description.includes('\0')) throw new Error('Describe the sound in 1 to 600 characters.');
  if (!Number.isFinite(durationSeconds) || durationSeconds < 1 || durationSeconds > 60) {
    throw new Error('Prompt-generated sound supports clips from 1 to 60 seconds.');
  }
  const engine = soundEngine();
  if (!engine) throw new Error('Install the optional local sound model before generating sound from a description.');
  if (generating) throw new Error('The local sound model is already working on another clip.');
  generating = true;
  let staging;
  try {
    const target = path.resolve(filename);
    staging = await fs.promises.mkdtemp(path.join(path.dirname(target), '.prompt-sound-'));
    const sample = path.join(staging, 'sound.wav');
    const environment = { ...process.env, HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', HF_HUB_DISABLE_IMPLICIT_TOKEN: '1' };
    for (const key of ['HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN', 'HUGGINGFACE_HUB_TOKEN', 'PYTHONPATH', 'PYTHONHOME']) delete environment[key];
    try {
      await exec(engine.python, ['-I', '-u', '-c', LAUNCH, engine.dependencies, engine.script,
        `--prompt=${description}`, '--dit=sm-sfx', '--decoder=same-s', '--precision=w8a8',
        `--seconds=${durationSeconds}`, '--steps=8', '--threads=4', `--out=${sample}`], {
        cwd: engine.engine, env: environment, windowsHide: true, timeout: 12 * 60 * 1000, maxBuffer: 256 * 1024,
      });
    } catch (error) {
      throw new Error(error.killed ? 'The local sound model timed out. Try a shorter clip.' :
        'The local sound model could not finish. Check the model installation and try again.', { cause: error });
    }
    if ((await fs.promises.stat(sample)).size > 11 * 1024 * 1024) throw new Error('The generated sound was unexpectedly large.');
    checkWave(await fs.promises.readFile(sample), durationSeconds);
    await fs.promises.copyFile(sample, target, fs.constants.COPYFILE_EXCL);
    return { durationSeconds, sampleRate: 44100 };
  } finally {
    if (staging) {
      await fs.promises.unlink(path.join(staging, 'sound.wav')).catch(() => {});
      await fs.promises.rmdir(staging).catch(() => {});
    }
    generating = false;
  }
}

module.exports = { promptSoundAvailable, writePromptSound };
