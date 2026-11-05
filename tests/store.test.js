'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../src/core/store');
const testRoot = path.resolve(__dirname, '..', '.test-tmp');

function fixture(t) {
  fs.mkdirSync(testRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(testRoot, 'studio-store-'));
  t.after(() => { if (path.dirname(path.resolve(dir)) === testRoot) fs.rmSync(dir, { recursive: true, force: true }); });
  const store = new Store(dir);
  store.load();
  return { dir, store };
}

test('persists updates and returns isolated snapshots', t => {
  const { dir, store } = fixture(t);
  store.mutate(state => { state.settings.defaultModel = 'wan'; });
  const snapshot = store.snapshot();
  snapshot.settings.defaultModel = 'bad';
  const reopened = new Store(dir);
  assert.equal(reopened.load().settings.defaultModel, 'wan');
  assert.equal(reopened.snapshot().revision, 1);
  assert.equal(fs.existsSync(path.join(dir, 'studio.json.tmp')), false);
});

test('a rejected mutation changes neither disk nor in-memory state', t => {
  const { dir, store } = fixture(t);
  const before = fs.readFileSync(path.join(dir, 'studio.json'), 'utf8');
  assert.throws(() => store.mutate(state => { state.settings.defaultModel = 'changed'; throw new Error('reject'); }), /reject/);
  assert.equal(fs.readFileSync(path.join(dir, 'studio.json'), 'utf8'), before);
  assert.deepEqual(store.snapshot().settings, {});
  assert.throws(() => store.mutate(state => { state.settings.apiKey = 'never plaintext'; }), /encrypted/);
  assert.equal(fs.readFileSync(path.join(dir, 'studio.json'), 'utf8'), before);
});

test('restores known-good backup after a corrupt write and preserves damaged evidence', t => {
  const { dir, store } = fixture(t);
  store.mutate(state => { state.settings.theme = 'dark'; });
  store.mutate(state => { state.settings.theme = 'light'; });
  fs.writeFileSync(path.join(dir, 'studio.json'), '{broken');
  const restored = new Store(dir);
  assert.equal(restored.load().settings.theme, 'dark');
  assert.match(restored.recoveryWarning, /backup/);
  assert.equal(fs.readdirSync(dir).filter(name => name.includes('damaged')).length, 1);
  restored.mutate(state => { state.settings.theme = 'recovered'; });
  assert.equal(new Store(dir).load().settings.theme, 'recovered');
});

test('never silently erases invalid data when neither copy is valid', t => {
  const { dir } = fixture(t);
  fs.writeFileSync(path.join(dir, 'studio.json'), '{broken');
  fs.writeFileSync(path.join(dir, 'studio.json.bak'), '{also broken');
  assert.throws(() => new Store(dir).load(), /preserved/);
  assert.equal(fs.readFileSync(path.join(dir, 'studio.json'), 'utf8'), '{broken');
});

test('rejects a future schema even when JSON syntax is valid', t => {
  const { dir } = fixture(t);
  fs.writeFileSync(path.join(dir, 'studio.json'), JSON.stringify({ schemaVersion: 9, revision: 0, jobs: [], settings: {} }));
  assert.throws(() => new Store(dir).load(), /preserved/);
});
