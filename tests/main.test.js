'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Vault } = require('../src/main/vault');
const { downloadVideo, validateMediaUrl, isVideo } = require('../src/main/download');

function temporary(t) {
  const parent = path.resolve(__dirname, '..', '.test-data');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'main-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// Only this injected test implementation uses AES directly. Production uses
// Windows protection via Electron safeStorage, exercised by the desktop smoke.
function protectedStorage() {
  const key = crypto.randomBytes(32);
  return {
    available: true, encryptedCalls: 0, decryptedCalls: 0,
    async isAsyncEncryptionAvailable() { return this.available; },
    async encryptStringAsync(plainText) {
      this.encryptedCalls++;
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    async decryptStringAsync(encrypted) {
      this.decryptedCalls++;
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, 12));
      decipher.setAuthTag(encrypted.subarray(12, 28));
      return { result: Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString('utf8'), shouldReEncrypt: false };
    },
  };
}

function mp4() {
  return Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x32,
    0, 0, 0, 16, 0x6d, 0x64, 0x61, 0x74, 0, 0, 0, 0, 0, 0, 0, 0]);
}
function webm() {
  return Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d,
    0x18, 0x53, 0x80, 0x67, 0xff, 0x15, 0x49, 0xa9, 0x66, 0x8f,
    0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40, 0x4d, 0x80, 0x85, 0x74, 0x65, 0x73, 0x74, 0x21]);
}

test('API key is encrypted on disk and recovered with Electron async return shape', async t => {
  const directory = temporary(t), storage = protectedStorage();
  const value = 'not-a-live-key-test-only';
  const vault = new Vault(directory, storage);
  await vault.load();
  assert.equal(vault.hasKey(), false);
  assert.throws(() => vault.getKey(), /Settings/);
  await vault.save(` ${value} `);
  assert.equal(vault.getKey(), value);
  const disk = fs.readFileSync(path.join(directory, 'credentials.bin'));
  assert.ok(!disk.includes(Buffer.from(value)), 'credential must not be persisted as plaintext');
  assert.deepEqual(fs.readdirSync(directory), ['credentials.bin']);
  const reopened = new Vault(directory, storage);
  await reopened.load();
  assert.equal(reopened.getKey(), value);
  assert.equal(storage.encryptedCalls, 1);
  assert.equal(storage.decryptedCalls, 1);
});

test('unavailable OS protection refuses saving and preserves a previously stored key', async t => {
  const directory = temporary(t), storage = protectedStorage();
  const vault = new Vault(directory, storage);
  await vault.save('original-test-key');
  const before = fs.readFileSync(vault.file);
  storage.available = false;
  await assert.rejects(vault.save('replacement-test-key'), /protection is unavailable/);
  assert.equal(vault.getKey(), 'original-test-key');
  assert.deepEqual(fs.readFileSync(vault.file), before);
  const fresh = new Vault(directory, storage);
  await assert.rejects(fresh.load(), /protection is unavailable/);
  assert.equal(fresh.hasKey(), false);
});

test('removing a saved key clears memory and disk across restarts', async t => {
  const directory = temporary(t), storage = protectedStorage();
  const vault = new Vault(directory, storage);
  await vault.save('removable-test-key');
  vault.clear();
  assert.equal(vault.hasKey(), false);
  assert.equal(fs.existsSync(vault.file), false);
  assert.throws(() => vault.getKey());
  const reopened = new Vault(directory, storage);
  await reopened.load();
  assert.equal(reopened.hasKey(), false);
});

test('invalid keys and corrupted ciphertext cannot become a usable credential', async t => {
  const directory = temporary(t), storage = protectedStorage();
  const vault = new Vault(directory, storage);
  for (const key of [undefined, null, '', '   ', 'a\nb', 'a\rb', 'x'.repeat(2049)]) await assert.rejects(vault.save(key));
  assert.equal(storage.encryptedCalls, 0);
  fs.writeFileSync(vault.file, Buffer.from('corrupted ciphertext'));
  await assert.rejects(vault.load());
  assert.equal(vault.hasKey(), false);
});

test('download rejects local, spoofed, credentialed and untrusted addresses before networking', async t => {
  const directory = temporary(t);
  let calls = 0;
  const network = async () => { calls++; throw new Error('network must not be used'); };
  for (const url of ['file:///C:/secret', 'http://v3.fal.media/output.mp4', 'https://localhost/video.mp4', 'https://127.0.0.1/video.mp4', 'https://[::1]/video.mp4', 'https://fal.media.attacker.example/video.mp4', 'https://user:password@v3.fal.media/video.mp4', 'https://v3.fal.media:8443/video.mp4', 'https://attacker.example/video.mp4']) {
    await assert.rejects(downloadVideo(url, 'test-job', directory, network));
  }
  assert.equal(calls, 0);
  assert.equal(fs.readdirSync(directory).length, 0);
  assert.equal(validateMediaUrl('https://fal-cdn.batuhan-941.workers.dev/video.mp4').hostname, 'fal-cdn.batuhan-941.workers.dev');
});

test('download refuses a redirect into the LAN and never attaches provider credentials', async t => {
  const directory = temporary(t), calls = [];
  const network = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(null, { status: 302, headers: { Location: 'https://192.168.1.1/private' } });
  };
  await assert.rejects(downloadVideo('https://v3.fal.media/video.mp4', 'redirect-test', directory, network), /unsupported media host/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[0].options.headers, undefined);
  assert.equal(fs.readdirSync(directory).length, 0);
});

test('trusted relative redirects save actual MP4 bytes atomically under the job ID', async t => {
  const directory = temporary(t), calls = [], expected = mp4();
  const network = async (url, options) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1) return new Response(null, { status: 307, headers: { Location: '/resolved.mp4' } });
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(expected.subarray(0, 3)); controller.enqueue(expected.subarray(3)); controller.close(); }
    }), { headers: { 'Content-Type': 'video/mp4' } });
  };
  const saved = await downloadVideo('https://v3.fal.media/original', 'saved-video', directory, network);
  assert.equal(saved, path.join(directory, 'saved-video.mp4'));
  assert.deepEqual(fs.readFileSync(saved), expected);
  assert.deepEqual(fs.readdirSync(directory), ['saved-video.mp4']);
  assert.equal(calls[1].url, 'https://v3.fal.media/resolved.mp4');
  assert.ok(calls.every(call => call.options.headers === undefined));
});

test('WebM response is persisted with the matching extension', async t => {
  const directory = temporary(t), expected = webm();
  const saved = await downloadVideo('https://v3.fal.media/video', 'webm-job', directory, async () => new Response(expected));
  assert.equal(path.extname(saved), '.webm');
  assert.deepEqual(fs.readFileSync(saved), expected);
});

test('HTML, empty responses, and stream failures leave no partial file or completed video', async t => {
  const directory = temporary(t);
  for (const body of ['<!doctype html><p>Provider error</p>', Buffer.alloc(0), Buffer.from('arbitrary bytes')]) {
    await assert.rejects(downloadVideo('https://v3.fal.media/video.mp4', 'bad-output', directory, async () => new Response(body)), /not a supported/);
    assert.deepEqual(fs.readdirSync(directory), []);
  }
  const broken = new ReadableStream({
    start(controller) { controller.enqueue(mp4()); controller.error(new Error('connection lost')); }
  });
  await assert.rejects(downloadVideo('https://v3.fal.media/video.mp4', 'broken-stream', directory, async () => new Response(broken)), /connection lost/);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('oversized declared output, HTTP failure, redirect loops and traversal IDs fail safely', async t => {
  const directory = temporary(t);
  await assert.rejects(downloadVideo('https://v3.fal.media/video.mp4', 'huge', directory, async () => new Response(mp4(), { headers: { 'Content-Length': String(1024 * 1024 * 1024 + 1) } })), /1 GB/);
  await assert.rejects(downloadVideo('https://v3.fal.media/video.mp4', 'failed', directory, async () => new Response('missing', { status: 404 })), /HTTP 404/);
  let redirects = 0;
  await assert.rejects(downloadVideo('https://v3.fal.media/video.mp4', 'loop', directory, async () => { redirects++; return new Response(null, { status: 302, headers: { Location: '/again' } }); }), /Too many/);
  assert.equal(redirects, 6);
  let calls = 0;
  await assert.rejects(downloadVideo('https://v3.fal.media/video.mp4', '../escape', directory, async () => { calls++; }));
  assert.equal(calls, 0);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('video header recognition rejects ordinary files', () => {
  assert.equal(isVideo(mp4()), true);
  assert.equal(isVideo(webm()), true);
  for (const bytes of [Buffer.alloc(0), Buffer.from('not video data'), Buffer.from('%PDF-1.7'), Buffer.from('<html>')]) assert.equal(isVideo(bytes), false);
});

test('container screening rejects image brands, truncated MP4 boxes and EBML stubs', async t => {
  const directory = temporary(t);
  const avif = mp4(); avif.write('avif', 8, 'ascii');
  const heic = mp4(); heic.write('heic', 16, 'ascii');
  const truncatedMp4 = mp4(); truncatedMp4.writeUInt32BE(10000, 24);
  const matroska = webm(); matroska.write('mkv!', 8, 'ascii');
  const noDocType = webm(); noDocType[6] = 0x83;
  const noSegment = webm(); noSegment.writeUInt32BE(0, 12);
  const oversizedSegment = webm(); oversizedSegment[16] = 0xfe;
  const nonAsciiDocType = webm(); nonAsciiDocType[8] |= 0x80;
  const nonAsciiBox = mp4(); nonAsciiBox[4] |= 0x80;
  const segmentOverrun = webm(); segmentOverrun[16] = 0x89;
  for (const bytes of [avif, heic, truncatedMp4, mp4().subarray(0, 24), Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), matroska, noDocType, noSegment, oversizedSegment, nonAsciiDocType, nonAsciiBox, segmentOverrun]) {
    assert.equal(isVideo(bytes), false);
    await assert.rejects(downloadVideo('https://v3.fal.media/video', 'bad-container', directory, async () => new Response(bytes)), /not a supported/);
  }
  assert.deepEqual(fs.readdirSync(directory), []);
});
