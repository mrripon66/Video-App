'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { _electron: electron } = require('@playwright/test');
const executablePath = require('electron');
const { Store } = require('../src/core/store');

async function main() {
  const root = path.resolve(__dirname, '..');
  const evidence = path.join(root, 'test-results');
  fs.mkdirSync(evidence, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(evidence, 'recovery-data-'));
  const requestId = 'test-only-recovery-request';
  const eventUrl = `https://lightricks-ltx-video-distilled.hf.space/gradio_api/call/text_to_video/${requestId}`;
  const createdAt = new Date().toISOString();
  const store = new Store(dataDir);
  store.load();
  // These are expressly test-only recovery fixtures, not generated outputs.
  // The production app has no fixture provider and no simulated-video path.
  store.mutate(state => {
    state.jobs = [
      { id: 'recovery-remote-job', prompt: 'TEST ONLY: saved provider request, cancellation pending', modelId: 'ltx-free', status: 'queued', createdAt,
        remote: { requestId, provider: 'hf-zerogpu', eventUrl },
        cancelRequested: true, cancellation: 'requested', attempts: [] },
      { id: 'recovery-attention-job', prompt: 'TEST ONLY: uncertain submission', modelId: 'ltx-free', status: 'needs_attention', createdAt,
        error: 'TEST ONLY: submission outcome is uncertain; check your saved request.', attempts: [] },
      { id: 'recovery-cancel-error', prompt: 'TEST ONLY: failed cancellation warning', modelId: 'ltx-free', status: 'needs_attention', createdAt,
        cancellation: 'requested', cancellationError: 'TEST ONLY: cancellation could not be confirmed; the provider may continue using quota.', attempts: [] },
    ];
  });

  const environment = { ...process.env, STUDIO_DATA_DIR: dataDir };
  delete environment.ELECTRON_RUN_AS_NODE;
  let application;
  let page;
  const pageErrors = [];
  try {
    application = await electron.launch({ executablePath, args: [root], env: environment, timeout: 30000 });
    application.process().stderr.on('data', chunk => fs.appendFileSync(path.join(evidence, 'recovery-electron.log'), chunk));
    // Install the network barrier before any action that can construct a
    // provider. No request is forwarded to the real network under any method.
    await application.evaluate((_electronModule, allowedEventUrl) => {
      global.__recoveryNetwork = { polls: 0, submissions: 0, forbidden: 0 };
      global.fetch = async (address, options = {}) => {
        const method = String(options.method || 'GET').toUpperCase();
        if (method === 'POST') global.__recoveryNetwork.submissions++;
        if (method === 'GET' && String(address) === allowedEventUrl) {
          global.__recoveryNetwork.polls++;
          return new Response(new ReadableStream({ start(controller) {
            controller.enqueue(new TextEncoder().encode('event: heartbeat\ndata: null\n\n'));
            // Gradio sends a long-lived SSE stream while the job waits/runs.
            // Keep this test stream open instead of inventing a completion.
          } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
        global.__recoveryNetwork.forbidden++;
        throw new Error('All real networking is disabled in the recovery regression test.');
      };
    }, eventUrl);
    page = await application.firstWindow();
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.waitForFunction(async () => Boolean(window.studio && (await window.studio.snapshot()).models.length === 6));
    await page.locator('[data-view="queue"]').click();
    await page.waitForFunction(() => document.getElementById('nav-queue-count').textContent === '3');

    const initial = await page.evaluate(() => window.studio.snapshot());
    assert.equal(initial.paused, true, 'Recovered jobs do not gain spending permission on launch.');
    assert.equal(initial.jobs.filter(job => job.status === 'pending').length, 0);
    assert.equal(initial.stats.active, 3);
    assert.equal(await page.locator('#review-queue').isEnabled(), true, 'A saved remote request can be monitored without new pending prompts.');
    assert.match(await page.locator('#review-queue').innerText(), /Resume monitoring/);
    assert.match(await page.locator('#batch-count').innerText(), /397 spaces available/, 'Attention-needed jobs count toward capacity.');
    await page.locator('#batch-input').fill(Array.from({ length: 398 }, (_, i) => `Boundary verification prompt ${i + 1}`).join('\n'));
    assert.equal(await page.locator('#add-batch').isDisabled(), true, 'The renderer prevents a batch that would exceed capacity including attention jobs.');
    await page.locator('#batch-input').fill('');

    const pendingCancel = page.locator('#queue-list .queue-row').filter({ hasText: 'TEST ONLY: saved provider request, cancellation pending' });
    assert.match(await pendingCancel.innerText(), /cancellation.*not confirmed/i);
    const failedCancel = page.locator('#queue-list .queue-row').filter({ hasText: 'TEST ONLY: failed cancellation warning' });
    assert.match(await failedCancel.innerText(), /cancellation could not be confirmed/);
    const attention = page.locator('#queue-list .queue-row').filter({ hasText: 'TEST ONLY: uncertain submission' });
    assert.equal(await attention.getByRole('button', { name: /^(?:Remove|Stop)$/ }).isEnabled(), true, 'Attention items can be removed from active capacity.');

    await page.locator('#review-queue').click();
    await page.locator('#approval-dialog').waitFor({ state: 'visible' });
    assert.match(await page.locator('#approval-title').innerText(), /Resume progress checks/);
    assert.match(await page.locator('#approval-description').innerText(), /no new video generation requests/i);
    assert.equal(await page.locator('#approval-prompts li').count(), 0);
    assert.equal(await page.locator('#approval-prompts-wrap').isHidden(), true);
    assert.match(await page.locator('#approve-start').innerText(), /Resume monitoring/);
    await page.locator('#approve-start').click();
    await page.locator('#approval-dialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(async () => {
      const snapshot = await window.studio.snapshot();
      return snapshot.running && snapshot.activeJobId === 'recovery-remote-job';
    });
    const network = await application.evaluate(() => global.__recoveryNetwork);
    assert.ok(network.polls >= 1, 'The saved handle was polled.');
    assert.equal(network.submissions, 0, 'Monitoring never submits another video request.');
    assert.equal(network.forbidden, 0, 'Only the expected event-stream GET fixture was requested.');
    assert.equal(await page.locator('video').count(), 0, 'A progress fixture never becomes a fabricated video.');
    await attention.getByRole('button', { name: /^(?:Remove|Stop)$/ }).click();
    await page.waitForFunction(async () => (await window.studio.snapshot()).jobs.find(job => job.id === 'recovery-attention-job')?.status === 'cancelled');
    await page.waitForFunction(() => document.getElementById('batch-count').textContent.includes('398 spaces available'));
    const afterRemoval = await application.evaluate(() => global.__recoveryNetwork);
    assert.equal(afterRemoval.submissions, 0);
    assert.equal(afterRemoval.forbidden, 0, 'Removing an attention item without a request handle uses no provider request.');
    await page.screenshot({ path: path.join(evidence, 'recovery-monitoring.png'), fullPage: true });
    await page.evaluate(() => window.studio.pauseQueue());
    assert.equal((await page.evaluate(() => window.studio.snapshot())).paused, true);
    assert.deepEqual(pageErrors, [], 'Recovery has no uncaught renderer errors.');
    fs.writeFileSync(path.join(evidence, 'recovery-summary.json'), JSON.stringify({ passed: true, pendingPrompts: 0,
      savedRemoteRequests: 1, attentionItems: 2, providerSubmissions: network.submissions, fixtureStatusPolls: network.polls,
      actualNetworkRequests: 0, checked: ['paused recovery', 'monitoring-only review', 'empty approval IDs', 'saved-handle SSE monitoring',
        'attention capacity', 'attention removal', 'unconfirmed cancellation copy', 'failed cancellation copy', 'no fabricated videos'],
      limitations: ['Test-only event-stream fixtures, not live provider generation', 'No provider quota used'] }, null, 2));
    console.log('Recovery desktop verification passed: saved-request monitoring with zero pending prompts, correct attention capacity, visible cancellation warnings, zero video submissions.');
  } finally {
    if (application) {
      if (page && !page.isClosed()) await page.evaluate(() => window.studio?.pauseQueue()).catch(() => {});
      await application.close().catch(() => {});
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
