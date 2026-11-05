'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
let nativeSpeech;

function run(executable, args, timeout) {
  return new Promise((resolve, reject) => execFile(executable, args,
    { windowsHide: true, timeout, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) return reject(Object.assign(new Error('Local voice processing did not finish.'), { stdout, stderr }));
      resolve(stdout);
    }));
}
function scriptPath(filename) {
  return path.join(__dirname, filename).replace('app.asar', 'app.asar.unpacked');
}
async function powershell(filename, args, timeout) {
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let output;
  try { output = await run(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath(filename), ...args], timeout); }
  catch (error) { output = error.stdout || ''; }
  let result;
  try { result = JSON.parse(output.replace(/^\uFEFF/, '').trim()); }
  catch { throw new Error('Windows could not access voice input. Check your microphone and try again.'); }
  if (result.error) throw new Error(result.error);
  return result;
}
function voicePaths() {
  const directory = process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'voice'))
    ? path.join(process.resourcesPath, 'voice') : path.join(__dirname, '..', '..', 'resources', 'voice');
  return { cli: path.join(directory, 'bin', 'whisper-cli.exe'), model: path.join(directory, 'ggml-tiny.bin') };
}
async function dictate(check = false) {
  if (process.platform !== 'win32') throw new Error('Voice prompts are available on Windows.');
  if (nativeSpeech === undefined) {
    try { await powershell('dictation.ps1', ['-Check'], 15000); nativeSpeech = true; }
    catch { nativeSpeech = false; }
  }
  if (nativeSpeech) return check ? { available: true, engine: 'Windows speech' } : powershell('dictation.ps1', [], 35000);
  const { cli, model } = voicePaths();
  if (!fs.existsSync(cli) || !fs.existsSync(model)) throw new Error('Offline voice files are missing. Reinstall AI Video Studio, or type your prompt.');
  if (check) return { available: true, engine: 'Offline Whisper', seconds: 10 };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-video-voice-'));
  const audio = path.join(directory, 'prompt.wav');
  const result = path.join(directory, 'transcript');
  try {
    await powershell('record-audio.ps1', ['-OutputPath', audio], 25000);
    await run(cli, ['-m', model, '-f', audio, '-l', 'auto', '-ng', '-t', '4', '-otxt', '-of', result, '-nt', '-np'], 90000);
    const text = fs.readFileSync(result + '.txt', 'utf8').trim();
    if (!text || /^\[.*\]$/.test(text) || /^\(.*\)$/.test(text)) throw new Error('No clear speech was recognized. Try again closer to your microphone.');
    return { text, engine: 'Offline Whisper' };
  } finally {
    for (const name of ['prompt.wav', 'transcript.txt']) fs.rmSync(path.join(directory, name), { force: true });
    try { fs.rmdirSync(directory); } catch { /* Do not remove anything unexpected. */ }
  }
}
module.exports = { dictate, voicePaths };
