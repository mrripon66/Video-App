'use strict';
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { _electron: electron } = require('@playwright/test');
const executablePath = require('electron');
const ffmpeg = require('ffmpeg-static');
const { Store } = require('../src/core/store');

async function main() {
  const root = path.resolve(__dirname, '..');
  const testRoot = path.join(root, '.test-data');
  fs.mkdirSync(testRoot, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(testRoot, 'desktop-reel-'));
  const videoDir = path.join(dataDir, 'videos');
  fs.mkdirSync(videoDir);
  const jobId = 'reel-desktop-fixture';
  const videoPath = path.join(videoDir, jobId + '.mp4');
  const exportPath = path.join(dataDir, 'vertical-reel.mp4');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi',
    '-i', 'testsrc2=size=320x180:rate=24:duration=1.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '2', videoPath],
  { timeout: 30000, windowsHide: true });
  const original = fs.readFileSync(videoPath);
  const now = new Date().toISOString();
  const store = new Store(dataDir);
  store.load();
  store.mutate(state => state.jobs.push({ id: jobId, modelId: 'ltx2-free', prompt: 'TEST FIXTURE — silent video for local Reel export.',
    status: 'completed', videoPath, createdAt: now, completedAt: now, attempts: [] }));

  const env = { ...process.env, STUDIO_DATA_DIR: dataDir };
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({ executablePath, args: [root], env, timeout: 30000 });
  try {
    await application.evaluate(({ dialog }, filename) => {
      global.__reelNetworkCalls = 0;
      global.fetch = async () => {
        global.__reelNetworkCalls++;
        throw new Error('Provider networking is blocked in the Reel export test.');
      };
      global.__reelSaveDialogs = [];
      dialog.showSaveDialog = async (...args) => {
        const options = args.at(-1);
        global.__reelSaveDialogs.push({ defaultPath: options.defaultPath, filters: options.filters });
        return global.__reelSaveDialogs.length === 1
          ? { canceled: true }
          : { canceled: false, filePath: filename };
      };
    }, exportPath);
    const page = await application.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.locator('#chat-feed').getByRole('button', { name: 'Make Reel', exact: true }).click();
    const reel = page.getByRole('dialog', { name: 'Make Reel' });
    assert.equal(await reel.getByLabel('Framing').inputValue(), 'crop');
    assert.equal(await reel.locator('select[name="sound"]').inputValue(), 'rain');
    await reel.getByRole('button', { name: 'Save Reel' }).click();
    await page.waitForFunction(() => document.querySelector('.reel-dialog [type="submit"]')?.disabled === false);
    assert.equal(await reel.isVisible(), true, 'Cancelling the file picker keeps the Reel options open.');
    assert.equal(fs.existsSync(exportPath), false, 'Cancelling the picker creates no output.');
    assert.equal((await application.evaluate(() => global.__reelSaveDialogs)).length, 1);

    await reel.getByRole('button', { name: 'Cancel', exact: true }).click();
    await reel.waitFor({ state: 'detached' });
    await page.locator('[data-view="library"]').click();
    await page.locator('#library-grid').getByRole('button', { name: 'Make Reel', exact: true }).click();
    await reel.getByRole('button', { name: 'Save Reel' }).click();
    await reel.waitFor({ state: 'detached', timeout: 60000 });
    assert.equal(await page.locator('#toast').innerText(), 'Reel saved.');
    const savedReel = await page.evaluate(async () => (await window.studio.snapshot()).jobs.find(job => job.kind === 'reel'));
    assert.equal(savedReel?.sourceJobId, jobId, 'The exported Reel appears in the app library.');
    assert.ok(fs.readFileSync(savedReel.videoPath).equals(fs.readFileSync(exportPath)), 'The playable library copy matches the export.');

    const dialogs = await application.evaluate(() => global.__reelSaveDialogs);
    assert.equal(dialogs.length, 2);
    assert.ok(dialogs.every(entry => entry.defaultPath.endsWith('.mp4') && entry.filters.some(filter => filter.extensions.includes('mp4'))));
    assert.deepEqual(fs.readFileSync(videoPath), original, 'Reel export leaves the library source intact.');
    const decoded = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-i', exportPath, '-map', '0:v:0', '-map', '0:a:0',
      '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    assert.equal(decoded.status, 0, decoded.error?.message || decoded.stderr);
    assert.match(decoded.stderr, /Video: h264[^\r\n]*1080x1920/, 'Export decodes as full HD vertical video.');
    assert.match(decoded.stderr, /Audio: aac/, 'Export includes an AAC soundtrack.');
    const maxVolume = decoded.stderr.match(/max_volume: (-?[\d.]+) dB/);
    assert.ok(maxVolume && Number(maxVolume[1]) > -45, 'The soundtrack contains audible rain instead of silence.');
    assert.equal(await application.evaluate(() => global.__reelNetworkCalls), 0);
    assert.deepEqual(errors, []);
    console.log('Reel export passed: cancel and save, 1080×1920 video, audible local sound, original preserved, zero provider calls.');
  } finally {
    await application.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
