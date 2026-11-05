'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { _electron: electron } = require('@playwright/test');

async function main() {
  const executablePath = path.resolve(process.argv[2] || 'dist/win-unpacked/AI Video Studio.exe');
  assert.ok(fs.existsSync(executablePath), 'The packaged executable must exist.');
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.STUDIO_DATA_DIR;
  const application = await electron.launch({ executablePath, env: environment, timeout: 30000 });
  const evidence = path.resolve('test-results');
  fs.mkdirSync(evidence, { recursive: true });
  try {
    await application.evaluate(() => {
      global.__packagedNetworkCalls = 0;
      global.fetch = async () => { global.__packagedNetworkCalls++; throw new Error('Paid requests are disabled during installed-app verification.'); };
    });
    const page = await application.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(async () => Boolean(window.studio && (await window.studio.snapshot()).models.length === 5));
    await page.waitForFunction(async () => (await window.studio.snapshot()).voiceAvailable === true, { timeout: 20000 });
    const info = await application.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion(), dataPath: app.getPath('userData'), resources: process.resourcesPath }));
    assert.equal(info.packaged, true);
    assert.equal(info.version, '1.0.0');
    assert.equal(await page.evaluate(() => typeof require), 'undefined');
    const state = await page.evaluate(() => window.studio.snapshot());
    assert.equal(state.paused, true);
    assert.equal(state.models.length, 5);
    assert.equal(state.models.every(model => model.available), true);
    assert.equal(state.voiceAvailable, true);
    assert.equal(await application.evaluate(() => global.__packagedNetworkCalls), 0);
    assert.ok(fs.existsSync(path.join(info.resources, 'voice', 'bin', 'whisper-cli.exe')));
    assert.ok(fs.existsSync(path.join(info.resources, 'voice', 'ggml-tiny.bin')));
    await page.screenshot({ path: path.join(evidence, 'installed-app.png'), fullPage: true });
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(evidence, 'installed-summary.json'), JSON.stringify({ passed: true, ...info,
      models: state.models.map(model => model.name), voiceAvailable: true, paused: true,
      savedJobs: state.jobs.length, providerRequests: 0 }, null, 2));
    console.log(`Installed application verified: ${info.version}, five remote models, offline voice available, paused queue, zero provider requests.`);
    console.log(`Saved data location: ${info.dataPath}`);
  } finally { await application.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
