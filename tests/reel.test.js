'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createReel } = require('../src/main/reel');
const { mediaExecutable } = require('../src/main/compose');

test('Reels render vertical video with audible ambience or preserved source sound', { timeout: 60000 }, async t => {
  const root = path.resolve('.test-data');
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'reel-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const silent = path.join(directory, 'silent.mp4');
  const tone = path.join(directory, 'original-tone.mp4');
  const output = path.join(directory, 'vertical.mp4');
  const executable = mediaExecutable();
  const ffmpeg = args => execFileSync(executable, ['-hide_banner', '-nostdin', ...args], { windowsHide: true, timeout: 30000 });
  const fixture = ['-v', 'error', '-f', 'lavfi', '-i',
    'color=c=black:s=160x96:r=24,drawbox=x=76:y=0:w=8:h=ih:color=white:t=fill'];
  ffmpeg([...fixture, '-t', '2', '-c:v', 'libx264', '-an', silent]);
  ffmpeg([...fixture, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '2', '-c:v', 'libx264', '-c:a', 'aac', tone]);
  const hash = filename => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
  const silentHash = hash(silent);
  const toneHash = hash(tone);

  const withRain = await createReel({ source: silent, destination: output, sound: 'rain', executable });
  assert.deepEqual(withRain, { durationSeconds: 2, width: 1080, height: 1920 });
  function topPixels() {
    const pixels = ffmpeg(['-v', 'error', '-i', output, '-vf', 'crop=2:2:540:0,format=gray',
      '-frames:v', '1', '-f', 'rawvideo', '-']);
    assert.equal(pixels.length, 4);
    return pixels;
  }
  assert.ok(topPixels().every(pixel => pixel > 230), 'the default fills the top of the screen with the source shot');
  const audioSamples = () => ffmpeg(['-v', 'error', '-i', output, '-map', '0:a:0', '-f', 's16le', '-']);
  function assertAudio(samples) {
    assert.ok(Math.abs(samples.length / (48000 * 2 * 2) - 2) < 0.05, 'audio covers the original two seconds');
    let peak = 0;
    for (let index = 0; index < samples.length; index += 2) peak = Math.max(peak, Math.abs(samples.readInt16LE(index)));
    assert.ok(peak > 0 && peak < 32767, 'audio contains sound and does not clip');
  }
  assertAudio(audioSamples());
  const rainHash = hash(output);
  await assert.rejects(createReel({ source: tone, destination: output, sound: 'none', executable }), /filename is already in use/);
  assert.equal(hash(output), rainHash);

  const alias = path.join(directory, 'source-hardlink.mp4');
  try { fs.linkSync(silent, alias); } catch (error) {
    if (!['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(error.code)) throw error;
  }
  if (fs.existsSync(alias)) {
    await assert.rejects(createReel({ source: silent, destination: alias, overwrite: true, executable }), /keep your original video safe/);
  }
  await assert.rejects(createReel({ source: silent, destination: silent, overwrite: true, executable }), /keep your original video safe/);

  const withOriginal = await createReel({ source: tone, destination: output, framing: 'fit', sound: 'none', overwrite: true, executable });
  assert.deepEqual(withOriginal, { durationSeconds: 2, width: 1080, height: 1920 });
  assert.ok(topPixels().every(pixel => pixel < 192), 'explicit Fit keeps the blurred background above the source shot');
  assert.ok(audioSamples().some(byte => byte !== 0), 'original sound remains present after export');
  assert.notEqual(hash(output), rainHash);
  const originalOnly = audioSamples();
  const mixed = await createReel({ source: tone, destination: output, framing: 'fit', sound: 'ocean', overwrite: true, executable });
  assert.deepEqual(mixed, { durationSeconds: 2, width: 1080, height: 1920 });
  const mixedAudio = audioSamples();
  assertAudio(mixedAudio);
  assert.notDeepEqual(mixedAudio, originalOnly, 'the mixed soundtrack contains the added ambience');
  assert.equal(hash(silent), silentHash);
  assert.equal(hash(tone), toneHash);
  assert.ok(fs.readdirSync(directory).every(filename => !filename.startsWith('.studio-reel-')));
});
