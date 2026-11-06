'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { _electron: electron } = require('@playwright/test');
const executablePath = require('electron');
const { fixtureBytes } = require('./test-media');

async function main() {
  const root = path.resolve(__dirname, '..');
  const evidence = path.join(root, 'test-results');
  fs.mkdirSync(evidence, { recursive: true });
  const bytes = await fixtureBytes(evidence);
  const dataDir = fs.mkdtempSync(path.join(evidence, 'desktop-data-'));
  const environment = { ...process.env, STUDIO_DATA_DIR: dataDir };
  delete environment.ELECTRON_RUN_AS_NODE;
  let application;
  const pageErrors = [];
  const launch = async () => {
    application = await electron.launch({ executablePath, args: [root], env: environment, timeout: 30000 });
    application.process().stderr.on('data', chunk => fs.appendFileSync(path.join(evidence, 'electron.log'), chunk));
    // Production has no fixture provider. This isolated test replaces all main
    // process networking; no request is forwarded to any GPU or paid service.
    await application.evaluate((_electron, media) => {
      const origin = 'https://lightricks-ltx-2-3.hf.space';
      const endpoint = origin + '/gradio_api/call/generate_video';
      const names = ['input_image', 'prompt', 'duration', 'enhance_prompt', 'seed', 'randomize_seed', 'height', 'width'];
      global.__desktopNetwork = { submissions: 0, actualRequests: 0, unexpected: 0 };
      global.fetch = async (address, options = {}) => {
        const url = String(address), method = String(options.method || 'GET').toUpperCase();
        if (method === 'GET' && url === origin + '/gradio_api/info') return new Response(JSON.stringify({ named_endpoints: {
          '/generate_video': { parameters: names.map(parameter_name => ({ parameter_name })), returns: [{ component: 'Video' }] }
        } }), { headers: { 'Content-Type': 'application/json' } });
        if (method === 'POST' && url === endpoint) {
          global.__desktopNetwork.submissions++;
          return new Response(JSON.stringify({ event_id: 'desktop-fixture-' + global.__desktopNetwork.submissions }), { headers: { 'Content-Type': 'application/json' } });
        }
        if (method === 'GET' && url.startsWith(endpoint + '/desktop-fixture-')) {
          const id = url.slice(url.lastIndexOf('/') + 1);
          return new Response('event: complete\ndata: ' + JSON.stringify([{ url: origin + '/gradio_api/file=/tmp/gradio/' + id + '/video.webm' }, 42]) + '\n\n',
            { headers: { 'Content-Type': 'text/event-stream' } });
        }
        if (method === 'GET' && /^https:\/\/lightricks-ltx-2-3\.hf\.space\/gradio_api\/file=\/tmp\/gradio\/desktop-fixture-\d+\/video\.webm$/.test(url)) {
          return new Response(new Uint8Array(media), { headers: { 'Content-Type': 'video/webm' } });
        }
        global.__desktopNetwork.unexpected++;
        throw new Error('All external networking is blocked in this desktop test.');
      };
    }, [...bytes]);
    const page = await application.firstWindow();
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.waitForFunction(async () => Boolean(window.studio && (await window.studio.snapshot()).models.some(model => model.id === 'ltx2-story-free')));
    await page.waitForFunction(() => document.getElementById('footer-state').textContent !== 'Loading workspace…');
    return page;
  };
  try {
    let page = await launch();
    assert.equal(await page.evaluate(() => typeof require), 'undefined');
    assert.equal(await page.evaluate(async () => (await window.studio.snapshot()).paused), true);
    assert.equal(await page.locator('#create-model').inputValue(), 'ltx2-story-free', 'New sessions default to the 15–20s edited-video model.');
    assert.equal(await page.locator('#story-duration-hint').isVisible(), true);
    assert.match(await page.locator('#story-duration-hint').innerText(), /15 seconds.*20 seconds.*separate AI shots/s);
    await page.locator('#create-model').selectOption('animatediff-free');
    assert.equal(await page.locator('#animatediff-duration-hint').isVisible(), true);
    assert.match(await page.locator('#animatediff-duration-hint').innerText(), /1\.6 seconds/);
    // The pinned real test clip is only 2.7 seconds. Use the short model for
    // completion fixtures; never pass it off as an actual 15-second output.
    await page.locator('#create-model').selectOption('ltx2-free');
    const original = await page.evaluate(() => window.studio.addPrompts({ prompts: ['TEST ONLY: unrelated saved prompt stays pending'], modelId: 'ltx2-free' }));
    const unrelatedId = original.addedJobIds[0];
    await page.locator('#prompt-input').fill('TEST FIXTURE: a quiet coast at sunrise. Offline desktop verification.');
    await page.locator('#add-prompt').click();
    await page.waitForFunction(async () => (await window.studio.snapshot()).stats.completed === 1);
    assert.equal(await page.locator('dialog').count(), 0, 'Generate has no review or approval dialog.');
    assert.equal(await page.evaluate(async id => (await window.studio.snapshot()).jobs.find(job => job.id === id).status, unrelatedId), 'pending');
    await page.locator('[data-view="queue"]').click();
    await page.locator('#batch-model').selectOption('ltx2-free');
    await page.locator('#batch-input').fill('TEST FIXTURE: offline batch prompt one\nTEST FIXTURE: offline batch prompt two');
    await page.locator('#add-batch').click();
    await page.waitForFunction(async () => (await window.studio.snapshot()).stats.completed === 3);
    assert.equal(await page.locator('dialog').count(), 0, 'Generate batch starts directly.');
    const network = await application.evaluate(() => global.__desktopNetwork);
    assert.equal(network.submissions, 3);
    assert.equal(network.unexpected, 0);
    assert.equal(network.actualRequests, 0);
    const planned = await page.evaluate(() => window.studio.addPrompts({
      prompts: ['TEST ONLY: a 20-second edited coastal documentary. Planning only; do not generate.'], modelId: 'ltx2-story-free'
    }));
    const plannedJob = planned.jobs.find(job => planned.addedJobIds.includes(job.id));
    assert.equal(plannedJob.videoPlan.durationSeconds, 20);
    assert.deepEqual(plannedJob.videoPlan.segments.map(segment => segment.durationSeconds), [10, 10]);
    assert.equal((await application.evaluate(() => global.__desktopNetwork)).submissions, 3, 'Planning a story never makes a provider request.');
    const tooLong = await page.evaluate(async () => {
      try { await window.studio.addPrompts({ prompts: ['TEST ONLY: a 30-second edited video'], modelId: 'ltx2-story-free' }); return ''; }
      catch (error) { return error.message; }
    });
    assert.match(tooLong, /15|20|duration|length|seconds/i, 'Unsupported duration is rejected before any generation.');
    await page.evaluate(id => window.studio.cancelJob({ id }), plannedJob.id);
    await page.evaluate(() => window.studio.addPrompts({ prompts: Array.from({ length: 399 }, (_, i) => 'TEST ONLY: saved capacity prompt ' + i), modelId: 'ltx2-free' }));
    const saved = await page.evaluate(() => window.studio.snapshot());
    assert.equal(saved.stats.active, 400);
    assert.equal(saved.stats.pending, 400);
    assert.equal(saved.jobs.length, 404, 'Completed and cancelled history does not reduce active capacity.');
    const overflow = await page.evaluate(async () => {
      try { await window.studio.addPrompts({ prompts: ['Overflow'], modelId: 'ltx2-free' }); return ''; }
      catch (error) { return error.message; }
    });
    assert.match(overflow, /400/);
    const invalidSelection = await page.evaluate(async () => {
      try { await window.studio.startQueue({ approvedJobIds: ['unknown-job'] }); return ''; }
      catch (error) { return error.message; }
    });
    assert.match(invalidSelection, /pending|changed|select|queue/i);
    await page.locator('[data-view="settings"]').click();
    assert.equal(await page.locator('input[type="password"]').count(), 0);
    assert.equal(saved.freeOnly, true);
    assert.equal(saved.ready, true);
    for (const id of ['ltx2-story-free', 'ltx2-free', 'animatediff-free']) assert.equal(saved.models.find(model => model.id === id)?.available, true);
    for (const id of ['wan-free', 'cogvideo-free', 'hunyuan']) assert.equal(saved.models.find(model => model.id === id)?.available, false);
    const rejected = await page.evaluate(async () => {
      try { await window.studio.saveSettings({ falKey: 'test-key-must-not-be-used' }); return ''; }
      catch (error) { return error.message; }
    });
    assert.match(rejected, /free.only|paid provider/i);
    await page.locator('[data-view="create"]').click();
    await page.screenshot({ path: path.join(evidence, 'studio.png'), fullPage: true });
    await application.close(); application = null;
    page = await launch();
    const restored = await page.evaluate(() => window.studio.snapshot());
    assert.equal(restored.stats.active, 400);
    assert.equal(restored.stats.completed, 3);
    assert.equal(restored.paused, true);
    assert.equal((await application.evaluate(() => global.__desktopNetwork)).submissions, 0, 'Saved prompts never restart automatically.');
    assert.deepEqual(pageErrors, []);
    fs.writeFileSync(path.join(evidence, 'desktop-summary.json'), JSON.stringify({ passed: true, activePrompts: 400, completedFixtures: 3,
      mockedGenerationRequests: 3, actualNetworkRequests: 0, noApprovalDialogs: true, unrelatedPendingPreserved: true, pausedRestart: true,
      storyDefaultSelected: true, twentySecondPlan: [10, 10], unsupportedDurationRejected: true,
      limitations: ['Short-clip completions use labelled test footage; this test does not represent a generated 15–20s video.'] }, null, 2));
    console.log('Desktop verification passed: direct single/batch generation, no approval dialogs, 400 saved prompts, no external requests.');
  } finally { if (application) await application.close().catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
