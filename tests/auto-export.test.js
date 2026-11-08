'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { Store } = require('../src/core/store');
const { createAutoExporter } = require('../src/main/auto-export');

const testRoot = path.resolve('.test-data');
const fixtureBytes = Buffer.from('deterministic bytes for a local copy test');

function fixture(t) {
  fs.mkdirSync(testRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(testRoot, 'auto-export-'));
  t.after(() => {
    if (path.dirname(path.resolve(root)) === testRoot) fs.rmSync(root, { recursive: true, force: true });
  });
  const directory = path.join(root, 'exports');
  fs.mkdirSync(directory);
  const store = new Store(path.join(root, 'store'));
  store.load();
  const defaults = { localVideo: job => job.videoPath, resolveFolder: filename => fs.promises.realpath(filename) };
  const worker = (options = {}) => createAutoExporter({ store, ...defaults, ...options });
  function add(overrides = {}) {
    const id = randomUUID();
    const videoPath = path.join(root, id + '.mp4');
    fs.writeFileSync(videoPath, fixtureBytes);
    const autoExport = { directory, status: 'pending' };
    const job = { id, prompt: 'Local test fixture', modelId: 'ltx2-free', status: 'completed', createdAt: new Date().toISOString(),
      videoPath, autoExport, ...overrides };
    store.mutate(state => { state.jobs.push(job); });
    return { ...job, destination: path.join(directory, `AI-Video-${id}.mp4`) };
  }
  return { directory, store, add, worker };
}

test('automatic export copies completed opted-in jobs exactly once with their stable filename', async t => {
  const { directory, store, add, worker } = fixture(t);
  const completed = add();
  add({ status: 'pending' });
  add({ autoExport: undefined });
  let changes = 0;
  const exporter = worker({ onChange: () => { changes++; } });
  await Promise.all([exporter.kick(), exporter.kick()]);
  await exporter.kick();
  assert.deepEqual(fs.readdirSync(directory), [path.basename(completed.destination)]);
  assert.deepEqual(fs.readFileSync(completed.destination), fixtureBytes);
  assert.deepEqual(fs.readFileSync(completed.videoPath), fixtureBytes);
  assert.deepEqual(store.snapshot().jobs.map(job => job.autoExport), [
    { directory, status: 'saved', filePath: completed.destination }, { directory, status: 'pending' }, undefined,
  ]);
  assert.equal(changes, 1);
});

test('restart cleans tracked partials and reuses a matching export already published before shutdown', async t => {
  const { directory, store, add, worker } = fixture(t);
  const copied = add(), interrupted = add();
  const stages = [copied, interrupted].map(job => `.ai-video-studio-${job.id}-${randomUUID()}.partial`);
  store.mutate(state => { state.jobs.forEach((job, index) => { job.autoExport.stagingName = stages[index]; }); });
  for (const stage of stages) fs.writeFileSync(path.join(directory, stage), Buffer.from('interrupted copy'));
  fs.writeFileSync(copied.destination, fixtureBytes);
  const existingTime = fs.statSync(copied.destination).mtimeMs;
  const restored = new Store(store.dataDir);
  restored.load();
  await worker({ store: restored }).kick();
  assert.equal(fs.statSync(copied.destination).mtimeMs, existingTime);
  assert.deepEqual(fs.readFileSync(interrupted.destination), fixtureBytes);
  assert.deepEqual(fs.readdirSync(directory).sort(), [copied, interrupted].map(job => path.basename(job.destination)).sort());
  assert.ok(restored.snapshot().jobs.every(job => job.autoExport.status === 'saved'));
});

test('an existing file with different bytes is preserved and can be retried to a new folder', async t => {
  const { directory, store, add, worker } = fixture(t);
  const job = add();
  const existing = Buffer.alloc(fixtureBytes.length, 'x');
  fs.writeFileSync(job.destination, existing);
  const exporter = worker();
  await exporter.kick();
  assert.deepEqual(fs.readFileSync(job.destination), existing);
  assert.equal(store.snapshot().jobs[0].autoExport.status, 'failed');
  assert.match(store.snapshot().jobs[0].autoExport.error, /different file/);
  const next = fs.mkdtempSync(path.join(directory, 'new-'));
  store.mutate(state => { state.jobs[0].autoExport = { directory: next, status: 'pending' }; });
  await exporter.kick();
  const final = store.snapshot().jobs[0].autoExport;
  assert.equal(final.status, 'saved');
  assert.equal(path.dirname(final.filePath), next);
  assert.deepEqual(fs.readFileSync(final.filePath), fixtureBytes);
  assert.deepEqual(fs.readFileSync(job.destination), existing);
});

test('a destination resolving to a different directory fails without writing to either location', async t => {
  const { directory, store, add, worker } = fixture(t);
  add();
  const changed = fs.mkdtempSync(path.join(directory, 'changed-'));
  await worker({ resolveFolder: async () => changed }).kick();
  assert.equal(store.snapshot().jobs[0].autoExport.status, 'failed');
  assert.match(store.snapshot().jobs[0].autoExport.error, /folder has moved/);
  assert.deepEqual(fs.readdirSync(directory), [path.basename(changed)]);
  assert.deepEqual(fs.readdirSync(changed), []);
});

test('stopping the worker waits for its current copy and leaves subsequent videos pending', async t => {
  const { directory, store, add, worker } = fixture(t);
  const first = add();
  add();
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const exporter = worker({ resolveFolder: async filename => { entered(); await gate; return filename; } });
  const running = exporter.kick();
  await started;
  const stopping = exporter.stop();
  release();
  await Promise.all([running, stopping]);
  await exporter.kick();
  assert.deepEqual(fs.readdirSync(directory), [path.basename(first.destination)]);
  assert.deepEqual(store.snapshot().jobs.map(job => job.autoExport.status), ['saved', 'pending']);
});
