'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { _electron: electron } = require('@playwright/test');
const executablePath = require('electron');

async function main() {
  const root = path.resolve(__dirname, '..');
  const evidence = path.join(root, 'test-results');
  fs.mkdirSync(evidence, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(evidence, 'desktop-data-'));
  const environment = { ...process.env, STUDIO_DATA_DIR: dataDir };
  delete environment.ELECTRON_RUN_AS_NODE;
  let application;
  const pageErrors = [];
  const launch = async () => {
    application = await electron.launch({ executablePath, args: [root], env: environment, timeout: 30000 });
    application.process().stderr.on('data', chunk => fs.appendFileSync(path.join(evidence, 'electron.log'), chunk));
    // The test deliberately disables the main-process network. No provider
    // request or paid generation can occur, including if an approval regresses.
    await application.evaluate(() => {
      global.__testNetworkCalls = 0;
      global.fetch = async () => { global.__testNetworkCalls++; throw new Error('Network is disabled in desktop verification.'); };
    });
    const page = await application.firstWindow();
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.waitForFunction(async () => Boolean(window.studio && (await window.studio.snapshot()).models.length === 6));
    await page.locator('#footer-state').filter({ hasText: /Loading/ }).waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
    return page;
  };
  try {
    let page = await launch();
    assert.equal(await page.evaluate(() => typeof require), 'undefined', 'Renderer has no Node.js access.');
    assert.equal(await page.evaluate(async () => (await window.studio.snapshot()).paused), true);
    await page.locator('#prompt-input').fill('A quiet coastal village at sunrise, filmed with a slow cinematic camera move.');
    await page.locator('#add-prompt').click();
    await page.waitForFunction(async () => (await window.studio.snapshot()).jobs.length === 1);
    await page.screenshot({ path: path.join(evidence, 'studio.png'), fullPage: true });
    await page.locator('[data-view="settings"]').click();
    assert.equal(await page.locator('input[type="password"]').count(), 0, 'Free mode never asks for paid API credentials.');
    assert.equal(await page.evaluate(async () => (await window.studio.snapshot()).freeOnly), true);
    assert.equal(await page.evaluate(async () => (await window.studio.snapshot()).ready), true, 'Free provider needs no key setup.');
    const credentialRejection = await page.evaluate(async () => {
      try { await window.studio.saveSettings({ falKey: 'test-key-must-not-be-used' }); return ''; }
      catch (error) { return error.message; }
    });
    assert.match(credentialRejection, /free.only|paid provider/i);
    const paidModelRejection = await page.evaluate(async () => {
      try { await window.studio.addPrompts({ prompts: ['Must not use a paid provider'], modelId: 'wan' }); return ''; }
      catch (error) { return error.message; }
    });
    assert.match(paidModelRejection, /free API|paid providers|unavailable/i);
    await page.locator('[data-view="queue"]').click();
    await page.locator('#batch-input').fill(Array.from({ length: 399 }, (_, i) => `Offline queue verification prompt ${i + 2}`).join('\n'));
    await page.locator('#add-batch').click();
    await page.waitForFunction(async () => (await window.studio.snapshot()).jobs.length === 400);
    assert.equal(await page.evaluate(async () => (await window.studio.snapshot()).paused), true);
    const overflow = await page.evaluate(async () => {
      try { await window.studio.addPrompts({ prompts: ['Overflow should be rejected'], modelId: 'ltx-free' }); return ''; }
      catch (error) { return error.message; }
    });
    assert.match(overflow, /400/);
    const invalidApproval = await page.evaluate(async () => {
      try { await window.studio.startQueue({ approvedJobIds: [] }); return ''; }
      catch (error) { return error.message; }
    });
    assert.match(invalidApproval, /queue changed|confirm|review/i);
    await page.locator('#review-queue').click();
    await page.locator('#approval-dialog').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#approval-prompts li').count(), 400);
    await page.screenshot({ path: path.join(evidence, 'batch-approval.png'), fullPage: true });
    await page.locator('#approval-dialog button[value="cancel"]').click();
    assert.equal(await application.evaluate(() => global.__testNetworkCalls), 0, 'Adding and reviewing prompts never sends a generation request.');
    await page.locator('[data-view="library"]').click();
    assert.equal(await page.locator('video').count(), 0, 'No fabricated video is shown.');
    const saved = await page.evaluate(() => window.studio.snapshot());
    assert.equal(saved.jobs.length, 400);
    assert.equal(saved.credentials.fal, false);
    assert.equal(saved.models.filter(model => model.available).length, 1);
    await application.close(); application = null;
    page = await launch();
    const restored = await page.evaluate(() => window.studio.snapshot());
    assert.equal(restored.jobs.length, 400, 'Queue persists across application restarts.');
    assert.equal(restored.paused, true, 'Restart does not grant spending permission.');
    assert.equal(restored.freeOnly, true, 'Restart retains free-only policy.');
    assert.equal(restored.ready, true, 'No API key is needed after restart.');
    assert.equal(await application.evaluate(() => global.__testNetworkCalls), 0);
    assert.deepEqual(pageErrors, [], 'The renderer has no uncaught errors.');
    fs.writeFileSync(path.join(evidence, 'desktop-summary.json'), JSON.stringify({ passed: true, queueItems: 400, networkRequests: 0,
      checked: ['isolated renderer', 'prompt form', 'paid credentials rejected', 'paid models disabled', '400 prompt batch', 'overflow rejection', 'exact approval IDs',
        'review modal', 'no fake library videos', 'restart persistence', 'paused restart', 'free provider ready without a key'],
      limitations: ['No paid generation', 'No spoken microphone test'] }, null, 2));
    console.log('Desktop verification passed: 400 persistent prompts, free-only provider, paid credentials rejected, exact batch review, zero provider requests.');
  } finally {
    if (application) await application.close().catch(() => {});
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
