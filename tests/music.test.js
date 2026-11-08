'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { MUSIC_PRESETS, writeMusic } = require('../src/main/music');

test('offline music renders varied stereo PCM, exactly fits the clip, and fades without clipping', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-music-'));
  t.after(async () => {
    for (const filename of await fs.readdir(directory)) await fs.unlink(path.join(directory, filename));
    await fs.rmdir(directory);
  });
  const waves = [];
  for (const style of Object.keys(MUSIC_PRESETS)) {
    const filename = path.join(directory, style + '.wav');
    const { durationSeconds, sampleRate } = await writeMusic({ filename, style, durationSeconds: 3.125, seed: 'test-track' });
    const wav = await fs.readFile(filename);
    assert.equal(durationSeconds, 3.125);
    assert.equal(sampleRate, 48000);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.readUInt16LE(20), 1);
    assert.equal(wav.readUInt16LE(22), 2);
    assert.equal(wav.readUInt32LE(24), sampleRate);
    assert.equal(wav.readUInt32LE(40), 3.125 * sampleRate * 4);
    assert.equal(wav.length, 44 + wav.readUInt32LE(40));
    assert.equal(wav.readInt16LE(44), 0);
    assert.equal(wav.readInt32LE(wav.length - 4), 0);
    let peak = 0, energy = 0, stereo = false;
    for (let offset = 44; offset < wav.length; offset += 4) {
      const left = wav.readInt16LE(offset), right = wav.readInt16LE(offset + 2);
      peak = Math.max(peak, Math.abs(left), Math.abs(right));
      energy += left * left + right * right;
      stereo ||= left !== right;
    }
    assert.ok(peak > 2500 && peak <= 32767 * 0.75);
    assert.ok(Math.sqrt(energy / (wav.readUInt32LE(40) / 2)) > 900);
    assert.equal(stereo, true);
    assert.ok(waves.every(previous => !wav.equals(previous)));
    waves.push(wav);
  }
  const settings = { style: 'calm', durationSeconds: 3.125, seed: 'test-track' };
  const repeated = path.join(directory, 'repeated.wav');
  await writeMusic({ filename: repeated, ...settings });
  assert.deepEqual(await fs.readFile(repeated), waves[0]);
  await assert.rejects(writeMusic({ filename: repeated, ...settings }), { code: 'EEXIST' });
  await assert.rejects(writeMusic({ filename: repeated, ...settings, style: 'invalid' }), /supported music style/);
});
