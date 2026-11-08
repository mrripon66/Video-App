'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { _electron: electron } = require('@playwright/test');

async function main() {
  const executablePath = path.resolve(process.argv[2] || 'dist/win-unpacked/AI Video Studio.exe');
  assert.ok(fs.existsSync(executablePath), 'The packaged executable must exist.');
  const evidence = path.resolve('test-results');
  fs.mkdirSync(evidence, { recursive: true });
  // Local editor fixtures only. These synthetic patterns never enter the user's
  // library and are not presented as AI-generated video or provider evidence.
  const assemblyDirectory = fs.mkdtempSync(path.join(evidence, 'packaged-compose-'));
  const developmentFfmpeg = require('ffmpeg-static');
  const firstShot = path.join(assemblyDirectory, 'test-pattern-10s.mp4');
  const secondShot = path.join(assemblyDirectory, 'test-blue-5s.mp4');
  for (const [filename, source, seconds] of [[firstShot, 'testsrc2=size=160x96:rate=24', 10], [secondShot, 'color=c=blue:size=160x96:rate=24', 5]]) {
    execFileSync(developmentFfmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', source,
      '-t', String(seconds), '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '2', filename],
    { windowsHide: true, timeout: 30000 });
  }
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.STUDIO_DATA_DIR;
  const application = await electron.launch({ executablePath, env: environment, timeout: 30000 });
  try {
    await application.evaluate(() => {
      global.__packagedNetworkCalls = 0;
      global.fetch = async () => { global.__packagedNetworkCalls++; throw new Error('All provider requests are disabled during installed-app verification.'); };
    });
    const page = await application.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(async () => Boolean(window.studio && (await window.studio.snapshot()).models.some(model => model.id === 'ltx2-story-free')));
    await page.waitForFunction(async () => (await window.studio.snapshot()).voiceAvailable === true, undefined, { timeout: 20000 });
    const info = await application.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion(), dataPath: app.getPath('userData'), resources: process.resourcesPath }));
    assert.equal(info.packaged, true);
    assert.equal(info.version, require('../package.json').version);
    assert.equal(await page.evaluate(() => typeof window.studio.makeReel), 'function');
    assert.equal(await page.evaluate(async () => (await window.studio.snapshot()).narrationAvailable), true);
    const installedNarration = await application.evaluate(({ app }) => {
      const path = process.getBuiltinModule('path');
      const requirePackaged = process.getBuiltinModule('module').createRequire(path.join(app.getAppPath(), 'package.json'));
      return requirePackaged('./src/main/narration.js').narrationEngine();
    });
    assert.equal(installedNarration, 'kokoro', 'The installer includes the upgraded voice model.');
    assert.equal(await page.evaluate(() => typeof require), 'undefined');
    const state = await page.evaluate(() => window.studio.snapshot());
    assert.equal(state.paused, true);
    assert.equal(state.models.length, 6);
    assert.equal(state.models.filter(model => model.available).length, 3);
    assert.equal(state.models[0].id, 'ltx2-story-free');
    for (const id of ['ltx2-story-free', 'ltx2-free', 'animatediff-free']) assert.equal(state.models.find(model => model.id === id)?.available, true);
    for (const id of ['wan-free', 'cogvideo-free', 'hunyuan']) {
      const model = state.models.find(entry => entry.id === id);
      assert.equal(model?.available, false);
      assert.ok(model.reason, 'Unavailable models explain their actual restriction.');
    }
    assert.equal(await page.locator('#create-model').inputValue(), 'ltx2-story-free');
    assert.equal(await page.locator('#story-duration-hint').isVisible(), true, 'The packaged renderer includes the new edited-video flow.');
    assert.match(await page.locator('#story-duration-hint').innerText(), /15 seconds.*20 seconds.*separate AI shots/s);
    assert.equal(await page.locator('dialog').count(), 0);
    assert.match(await page.locator('#add-prompt').innerText(), /^Generate/);
    assert.equal(state.freeOnly, true);
    assert.equal(state.ready, true);
    assert.equal(await page.locator('input[type="password"]').count(), 0);
    assert.equal(state.voiceAvailable, true);
    assert.equal(await application.evaluate(() => global.__packagedNetworkCalls), 0);
    assert.ok(fs.existsSync(path.join(info.resources, 'voice', 'bin', 'whisper-cli.exe')));
    assert.ok(fs.existsSync(path.join(info.resources, 'voice', 'ggml-tiny.bin')));
    for (const filename of ['ffmpeg.exe', 'ffmpeg.exe.LICENSE', 'ffmpeg.exe.README']) {
      assert.ok(fs.statSync(path.join(info.resources, 'media', filename)).size > 0, 'Bundled assembly resource is present: ' + filename);
    }
    const mediaTool = await application.evaluate(() => {
      const path = process.getBuiltinModule('path');
      const { spawnSync } = process.getBuiltinModule('child_process');
      const result = spawnSync(path.join(process.resourcesPath, 'media', 'ffmpeg.exe'), ['-hide_banner', '-version'],
        { windowsHide: true, encoding: 'utf8', timeout: 10000 });
      return { status: result.status, version: String(result.stdout || '').split(/\r?\n/)[0], error: result.error?.message || null };
    });
    assert.equal(mediaTool.status, 0, mediaTool.error || 'The bundled assembly executable must run.');
    assert.match(mediaTool.version, /ffmpeg version/i);
    const packagedAssembly = await application.evaluate(async ({ app }, input) => {
      const path = process.getBuiltinModule('path');
      const requirePackaged = process.getBuiltinModule('module').createRequire(path.join(app.getAppPath(), 'package.json'));
      const { createComposer, decodedDuration, mediaExecutable } = requirePackaged(path.join(app.getAppPath(), 'src', 'main', 'compose.js'));
      const compose = createComposer({ directory: input.directory });
      const output = await compose({ jobId: 'packaged-editor-test-15s', durationSeconds: 15,
        segments: [{ videoPath: input.first, durationSeconds: 10 }, { videoPath: input.second, durationSeconds: 5 }] });
      return { output, durationSeconds: await decodedDuration(output), executableUsed: mediaExecutable() };
    }, { directory: assemblyDirectory, first: firstShot, second: secondShot });
    assert.ok(Math.abs(packagedAssembly.durationSeconds - 15) <= 0.1, 'The packaged editor assembles and fully decodes an actual 15s file.');
    assert.equal(path.resolve(packagedAssembly.executableUsed), path.resolve(info.resources, 'media', 'ffmpeg.exe'));
    assert.equal(path.dirname(packagedAssembly.output), assemblyDirectory, 'Assembly fixtures remain outside the user library.');
    assert.ok(fs.statSync(packagedAssembly.output).size > 1000);
    assert.equal(await application.evaluate(() => global.__packagedNetworkCalls), 0, 'Packaged local assembly never contacts a provider.');
    await page.screenshot({ path: path.join(evidence, 'installed-app.png'), fullPage: true });
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(evidence, 'installed-summary.json'), JSON.stringify({ passed: true, ...info,
      models: state.models.map(model => model.name), voiceAvailable: true, paused: true,
      savedJobs: state.jobs.length, providerRequests: 0, newFeatureInstalled: true, defaultModel: state.models[0].id,
      availableModels: state.models.filter(model => model.available).map(model => model.id), mediaTool, packagedAssembly,
      assemblyUsesSyntheticFixtures: true, additionalGpuCalls: 0 }, null, 2));
    console.log(`Installed application verified: ${info.version}, free-only remote provider, no API key needed, offline voice available, paused queue, zero provider requests.`);
    console.log(`Saved data location: ${info.dataPath}`);
  } finally { await application.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
