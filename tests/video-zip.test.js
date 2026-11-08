'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { writeVideoZip } = require('../src/main/video-zip');

test('a 500-video ZIP has unique safe names and leaves a previous export intact if a source disappears', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-zip-'));
  t.after(async () => {
    for (const name of await fs.readdir(directory)) await fs.unlink(path.join(directory, name));
    await fs.rmdir(directory);
  });
  const source = path.join(directory, 'test.mp4');
  const destination = path.join(directory, 'batch.zip');
  const bytes = Buffer.from('Fixture bytes used only to test archival.');
  await fs.writeFile(source, bytes);
  const videos = Array.from({ length: 500 }, () => ({ source, title: '../Channel: same? name' }));
  await writeVideoZip(destination, videos);
  const tar = process.platform === 'win32' ? 'tar.exe' : 'unzip';
  const listArgs = process.platform === 'win32' ? ['-tf', destination] : ['-Z1', destination];
  const names = execFileSync(tar, listArgs, { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/);
  assert.equal(names.length, 500);
  assert.equal(new Set(names).size, 500);
  assert.ok(names.every(name => !/[\\/:?]/.test(name)));
  const readArgs = process.platform === 'win32' ? ['-xOf', destination, names.at(-1)] : ['-p', destination, names.at(-1)];
  assert.deepEqual(execFileSync(tar, readArgs, { windowsHide: true }), bytes);

  const original = await fs.readFile(destination);
  await assert.rejects(writeVideoZip(destination, [{ source: path.join(directory, 'missing.mp4'), title: 'Missing' }]), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(destination), original);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['batch.zip', 'test.mp4']);
});
