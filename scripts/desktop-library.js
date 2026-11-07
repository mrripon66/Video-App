'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { _electron: electron } = require('@playwright/test');
// Resolve before Playwright evaluates Electron code: the resolver is a Node module.
const executablePath = require('electron');
const { Store } = require('../src/core/store');
const { FIXTURE, fixtureBytes } = require('./test-media');

async function main() {
  const root = path.resolve(__dirname, '..');
  const evidence = path.join(root, 'test-results');
  fs.mkdirSync(evidence, { recursive: true });
  const fixture = await fixtureBytes(evidence);
  const dataDir = fs.mkdtempSync(path.join(evidence, 'library-data-'));
  const videoDir = path.join(dataDir, 'videos');
  fs.mkdirSync(videoDir);
  const jobId = 'library-fixture-real-chromium';
  const videoPath = path.join(videoDir, jobId + '.webm');
  fs.writeFileSync(videoPath, fixture);
  const mediaUrl = 'studio-media://video/' + jobId;
  const reelId = 'library-fixture-with-sound';
  const reelPath = path.join(videoDir, reelId + '.mp4');
  const reelPrompt = 'TEST FIXTURE — vertical MP4 playback with audio';
  const userReel = process.env.STUDIO_TEST_REEL;
  if (userReel) fs.copyFileSync(userReel, reelPath, fs.constants.COPYFILE_EXCL);
  else execFileSync(require('ffmpeg-static'), ['-hide_banner', '-v', 'error', '-nostdin', '-f', 'lavfi',
    '-i', 'testsrc2=size=180x320:rate=30:duration=2.4', '-f', 'lavfi', '-i', 'sine=frequency=360:duration=2.4',
    '-af', 'volume=0.25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-threads', '2', reelPath],
  { windowsHide: true, timeout: 30000 });
  const store = new Store(dataDir);
  store.load();
  store.mutate(state => {
    state.jobs.push({ id: jobId, modelId: 'ltx-free',
      prompt: 'TEST FIXTURE — official Chromium bear.webm. Playback verification only; this was not AI-generated.',
      status: 'completed', videoPath, createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), attempts: [] });
    state.jobs.push({ id: reelId, modelId: 'ltx-free', prompt: reelPrompt, status: 'completed', videoPath: reelPath,
      createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), attempts: [] });
  });
  const environment = { ...process.env, STUDIO_DATA_DIR: dataDir };
  delete environment.ELECTRON_RUN_AS_NODE;
  const pageErrors = [];
  let application;
  try {
    application = await electron.launch({ executablePath, args: [root], env: environment, timeout: 30000 });
    application.process().stderr.on('data', chunk => fs.appendFileSync(path.join(evidence, 'library-electron.log'), chunk));
    await application.evaluate(() => {
      global.__libraryProviderCalls = 0;
      global.fetch = async () => { global.__libraryProviderCalls++; throw new Error('Provider network disabled for the library regression.'); };
    });
    const page = await application.firstWindow();
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.waitForFunction(async () => window.studio && (await window.studio.snapshot()).jobs.length === 2);
    assert.equal(await page.evaluate(async () => (await window.studio.snapshot()).paused), true);
    await page.locator('[data-view="library"]').click();
    const video = page.locator('#library-grid video[src="' + mediaUrl + '"]');
    await video.waitFor({ state: 'visible' });
    const metadata = await video.evaluate(async node => {
      if (node.readyState < HTMLMediaElement.HAVE_METADATA) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Local video metadata did not load.')), 15000);
          node.addEventListener('loadedmetadata', () => { clearTimeout(timer); resolve(); }, { once: true });
          node.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Local video playback error: ' + (node.error?.message || node.error?.code))); }, { once: true });
        });
      }
      return { duration: node.duration, width: node.videoWidth, height: node.videoHeight, source: node.currentSrc };
    });
    assert.ok(Number.isFinite(metadata.duration) && metadata.duration > 1, 'A real finite video duration is decoded.');
    assert.ok(metadata.width > 0 && metadata.height > 0, 'Chromium decodes real video dimensions.');
    assert.equal(metadata.source, 'studio-media://video/' + jobId);
    await page.waitForFunction(id => [...document.querySelectorAll('[data-duration-job]')].some(node => node.dataset.durationJob === id && /s/.test(node.textContent)), jobId);
    assert.match(await page.locator('#library-grid [data-duration-job="' + jobId + '"]').innerText(), new RegExp(String(Number(metadata.duration.toFixed(1))) + 's'), 'Library duration comes from decoded media metadata.');
    await video.evaluate(async node => { node.muted = true; node.currentTime = 0; await node.play(); });
    await page.waitForFunction(url => document.querySelector('#library-grid video[src="' + url + '"]')?.currentTime > 0.15, mediaUrl, { timeout: 10000 });
    const advanced = await video.evaluate(node => { node.pause(); return node.currentTime; });
    assert.ok(advanced > 0.15, 'Playback advances in the real desktop video element.');
    const seekTarget = Math.min(metadata.duration * 0.7, metadata.duration - 0.2);
    const seeked = await video.evaluate(async (node, target) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Local video seeking timed out.')), 10000);
        node.addEventListener('seeked', () => { clearTimeout(timer); resolve(); }, { once: true });
        node.currentTime = target;
      });
      return node.currentTime;
    }, seekTarget);
    assert.ok(Math.abs(seeked - seekTarget) < 0.15, 'Seeking reaches the requested real media position.');

    const reelCard = page.locator('#library-grid article').filter({ hasText: reelPrompt });
    await reelCard.getByRole('button', { name: 'Watch', exact: true }).click();
    const player = page.getByRole('dialog', { name: 'Watch video' });
    const playing = player.locator('video');
    await player.waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const media = document.querySelector('.watch-dialog video');
      return media && media.currentTime > 0.15 && media.webkitAudioDecodedByteCount > 0 && !media.muted;
    }, undefined, { timeout: 15000 });
    const reelMetadata = await playing.evaluate(node => ({ duration: node.duration, width: node.videoWidth,
      height: node.videoHeight, decodedAudioBytes: node.webkitAudioDecodedByteCount, volume: node.volume }));
    assert.equal(reelMetadata.width * 16, reelMetadata.height * 9, 'The Watch dialog plays the real portrait MP4.');
    assert.ok(reelMetadata.decodedAudioBytes > 0 && reelMetadata.volume > 0, 'The AAC track decodes during unmuted playback.');
    const sound = player.locator('.watch-sound-button');
    await sound.click();
    await page.waitForFunction(() => document.querySelector('.watch-dialog video')?.muted === true);
    await sound.click();
    await page.waitForFunction(() => document.querySelector('.watch-dialog video')?.muted === false);
    await playing.evaluate(node => { node.currentTime = node.duration - 0.12; });
    await page.waitForFunction(() => document.querySelector('.watch-dialog video')?.ended === true);
    await player.getByRole('button', { name: 'Replay', exact: true }).click();
    await page.waitForFunction(() => {
      const media = document.querySelector('.watch-dialog video');
      return media && !media.paused && media.currentTime > 0.1 && media.currentTime < 0.8;
    });
    await player.getByRole('button', { name: 'Close', exact: true }).click();
    await player.waitFor({ state: 'detached' });

    // net.fetch exercises the registered protocol directly; renderer connect-src
    // intentionally prohibits arbitrary fetch. Only local custom-scheme requests
    // are used here. The provider's global fetch remains blocked above.
    const localRequest = async (url, headers = {}) => application.evaluate(async ({ net }, input) => {
      const response = await net.fetch(input.url, { headers: input.headers });
      return { status: response.status, range: response.headers.get('content-range'),
        acceptRanges: response.headers.get('accept-ranges'), type: response.headers.get('content-type'),
        bytes: Array.from(new Uint8Array(await response.arrayBuffer())) };
    }, { url, headers });
    const first = await localRequest(mediaUrl, { Range: 'bytes=0-63' });
    assert.equal(first.status, 206);
    assert.equal(first.range, `bytes 0-63/${fixture.length}`);
    assert.equal(first.acceptRanges, 'bytes');
    assert.equal(first.type, 'video/webm');
    assert.deepEqual(Buffer.from(first.bytes), fixture.subarray(0, 64), 'Range response contains exactly the requested real media bytes.');
    const suffix = await localRequest(mediaUrl, { Range: 'bytes=-128' });
    assert.equal(suffix.status, 206);
    assert.deepEqual(Buffer.from(suffix.bytes), fixture.subarray(-128));
    const impossible = await localRequest(mediaUrl, { Range: `bytes=${fixture.length}-` });
    assert.equal(impossible.status, 416);
    assert.equal(impossible.range, `bytes */${fixture.length}`);
    assert.equal((await localRequest(mediaUrl, { Range: 'bytes=invalid' })).status, 416);
    assert.equal((await localRequest('studio-media://video/does-not-exist')).status, 404);
    assert.equal((await localRequest('studio-media://video/%2e%2e%2foutside-test.webm')).status, 404, 'Encoded path traversal cannot access arbitrary files.');
    assert.equal((await localRequest('studio-media://other/' + jobId)).status, 403);
    assert.equal(await application.evaluate(() => global.__libraryProviderCalls), 0, 'Playback makes zero provider requests.');
    assert.deepEqual(pageErrors, [], 'Library playback has no uncaught renderer errors.');
    await page.screenshot({ path: path.join(evidence, 'library-playback.png'), fullPage: true });
    fs.writeFileSync(path.join(evidence, 'library-summary.json'), JSON.stringify({ passed: true,
      fixture: FIXTURE, fixtureIsAiGenerated: false, metadata, playbackAdvancedTo: advanced, seekTarget, seeked, reelMetadata,
      providerRequests: 0, checked: ['real WebM metadata', 'real video playback advances', 'seeking', 'exact byte ranges',
        'Watch opens portrait H.264 MP4', 'AAC decodes unmuted', 'mute and unmute', 'Replay after reaching the end',
        'suffix byte range', 'unsatisfiable and malformed ranges', 'unknown ID rejection', 'path traversal rejection',
        'unknown protocol host rejection', 'zero paid/provider network requests', 'isolated test data'],
      limitations: ['No paid generation', 'Native export and reveal dialogs are not exercised by this test'] }, null, 2));
    console.log('Library verification passed: WebM plays and seeks, Watch opens a vertical MP4 with sound, Replay restarts it, and local byte ranges are exact. Zero provider requests.');
  } finally {
    if (application) await application.close().catch(() => {});
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
