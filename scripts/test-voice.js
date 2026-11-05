'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { execFileSync } = require('node:child_process');
const { ASSETS, validAsset } = require('./setup-voice');

const root = path.resolve(__dirname, '..');
const fixture = Object.freeze({ filename: 'jfk.wav', size: 352078,
  url: 'https://raw.githubusercontent.com/ggml-org/whisper.cpp/v1.9.5/samples/jfk.wav',
  sha256: '59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e' });

async function testVoice() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This bundled voice test requires Windows x64.');
  const cli = path.join(root, 'resources', 'voice', 'bin', 'whisper-cli.exe');
  const model = path.join(root, 'resources', 'voice', 'ggml-tiny.bin');
  assert.ok(fs.existsSync(cli), 'Run npm run setup:voice before testing bundled voice.');
  assert.ok(await validAsset(model, ASSETS.model), 'The bundled speech model must match its pinned checksum.');
  const results = path.join(root, 'test-results', 'voice');
  fs.mkdirSync(results, { recursive: true });
  const audio = path.join(results, fixture.filename);
  if (!(await validAsset(audio, fixture))) {
    console.log('Fetching the official small speech fixture; no microphone will be recorded.');
    const temporary = audio + '.part';
    try {
      const response = await fetch(fixture.url, { signal: AbortSignal.timeout(60000) });
      if (!response.ok || !response.body) throw new Error(`Speech fixture download failed: HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary));
      assert.ok(await validAsset(temporary, fixture), 'Official speech fixture checksum mismatch.');
      fs.renameSync(temporary, audio);
    } catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
  }
  const output = path.join(results, 'jfk-transcript');
  fs.rmSync(output + '.txt', { force: true });
  const started = Date.now();
  execFileSync(cli, ['-m', model, '-f', audio, '-l', 'auto', '-ng', '-t', '4', '-otxt', '-of', output, '-nt', '-np'],
    { windowsHide: true, timeout: 90000, maxBuffer: 1024 * 1024, stdio: 'pipe' });
  const elapsedMs = Date.now() - started;
  const text = fs.readFileSync(output + '.txt', 'utf8').trim();
  assert.match(text, /ask not/i, 'CPU transcription should recognize the sample speech.');
  assert.match(text, /your country/i);
  assert.match(text, /what you can do/i);
  const report = { passed: true, fixture: fixture.url, fixtureSha256: fixture.sha256, model: 'Whisper tiny multilingual',
    modelSha256: ASSETS.model.sha256, cpuOnly: true, threads: 4, microphoneRecorded: false, providerCreditsUsed: false,
    elapsedMs, transcript: text, completedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(results, 'voice-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Offline CPU voice test passed in ${elapsedMs} ms. No microphone capture or provider credits used.`);
  return report;
}
if (require.main === module) testVoice().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { testVoice };
