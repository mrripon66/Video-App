'use strict';

const fs = require('node:fs/promises');
const { setImmediate: yieldToApp } = require('node:timers/promises');
const { createHash } = require('node:crypto');
const { MUSIC_PRESETS } = require('../core/music-styles');

const SAMPLE_RATE = 48000;
const TABLE_SIZE = 2048;
const BLOCK = 8192;

const ARRANGEMENTS = {
  calm: { tempo: 76, key: 50, chords: [[0, 7, 16, 21], [5, 12, 16, 23], [-3, 4, 12, 16], [7, 14, 17, 24]] },
  cinematic: { tempo: 83, key: 50, chords: [[0, 7, 15, 21], [-4, 3, 12, 15], [3, 10, 14, 22], [7, 14, 16, 22]] },
  upbeat: { tempo: 111, key: 53, chords: [[0, 7, 16, 24], [7, 11, 14, 22], [-3, 4, 12, 16], [5, 9, 12, 21]] },
  suspense: { tempo: 67, key: 46, chords: [[0, 7, 13, 15], [-4, 3, 10, 15], [3, 9, 13, 19], [-2, 5, 12, 17]] },
};

function instrument(partials, attack, release, decay, detune) {
  const table = Float32Array.from({ length: TABLE_SIZE }, (_, index) => partials.reduce((sample, strength, i) =>
    sample + strength * Math.sin(index * (i + 1) * 2 * Math.PI / TABLE_SIZE), 0));
  return { table, attack, release, decay, detune };
}

const INSTRUMENTS = {
  piano: instrument([0.77, 0.28, 0.18, 0.09, 0.05, 0.02], 0.01, 0.23, 1.9, 0.002),
  strings: instrument([0.49, 0.26, 0.18, 0.12, 0.09, 0.08, 0.04], 0.37, 0.48, 0.12, 0.006),
  pluck: instrument([0.66, 0.35, 0.24, 0.12, 0.08, 0.05, 0.02], 0.006, 0.16, 3.2, 0.003),
  bass: instrument([0.85, 0.2, 0.06, 0.03], 0.016, 0.19, 1.4, 0.001),
  drum: instrument([1, 0.17, 0.05], 0.005, 0.16, 14, 0),
};

function randomSource(seed) {
  let state = createHash('sha256').update(seed).digest().readUInt32LE() || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function arrange(style, duration, random) {
  const { tempo, key, chords } = ARRANGEMENTS[style];
  const transpose = Math.floor(random() * 5) - 2;
  const notes = [];
  const bars = Math.max(1, Math.round(duration * tempo / 240));
  const leadIn = 0.035;
  const beat = (duration - leadIn - Math.min(0.5, duration * 0.12)) / (bars * 4);
  const isBright = style === 'upbeat';
  const isTense = style === 'suspense';
  const isCinematic = style === 'cinematic';
  const melody = isBright || isTense ? 'pluck' : 'piano';
  for (let bar = 0; bar < bars; bar++) {
    const final = bar === bars - 1;
    const chord = chords[final && bars > 2 ? 0 : bar % chords.length];
    const root = key + transpose;
    const at = leadIn + bar * beat * 4;
    function add(timbre, pitch, count, length, volume, pan = 0) {
      const variation = 0.88 + random() * 0.22;
      notes.push({ timbre, pitch: root + pitch, start: at + beat * count + random() * 0.009,
        seconds: beat * length, volume: volume * variation, pan });
    }
    add('bass', chord[0] - 12, 0, isBright ? 1.2 : 3.5, isBright ? 0.23 : 0.16);
    if (isBright || isCinematic) add('bass', chord[0] - (isCinematic ? 12 : 0), 2, 1.2, 0.17);
    if (!isBright) {
      for (const [i, pitch] of chord.slice(1).entries()) {
        add('strings', pitch, 0.08 + i * 0.08, final ? 3.2 : 3.75, isCinematic ? 0.12 : 0.065, (i - 1) * 0.63);
      }
    }
    const pattern = final ? [[0, 0], [0.46, 1], [0.9, 2], [1.38, 3], [2.2, 2]] :
      isBright ? [[0, 1], [0.5, 2], [1.05, 3], [1.55, 2], [2, 0], [2.5, 2], [3.1, 3], [3.55, 1]] :
      isTense ? [[0.5, 2], [1.25, 1], [2.5, 2], [3.25, 1]] : [[0, 1], [0.72, 2], [1.46, 3], [2.52, 2], [3.25, 1]];
    for (const [count, index] of pattern) {
      add(melody, chord[index], count, isBright || isTense ? 0.84 : 1.35, 0.17, (index - 1.5) * 0.26);
    }
    if (isBright || isCinematic || isTense) {
      add('drum', -18, 0, 0.24, isBright ? 0.13 : 0.11);
      if (isBright && !final) add('drum', -15, 2, 0.23, 0.09);
    }
  }
  return notes;
}

function shape(value) {
  const clipped = Math.max(0, Math.min(value, 1));
  return clipped * clipped * (3 - 2 * clipped);
}

async function renderNote(note, left, right) {
  const { table, attack, release, decay, detune } = INSTRUMENTS[note.timbre];
  const first = Math.round(note.start * SAMPLE_RATE);
  const frames = Math.min(left.length - first, Math.round((note.seconds + release) * SAMPLE_RATE));
  const increment = 440 * 2 ** ((note.pitch - 69) / 12) * TABLE_SIZE / SAMPLE_RATE;
  const pan = (note.pan + 1) * Math.PI / 4;
  const levelLeft = note.volume * Math.cos(pan), levelRight = note.volume * Math.sin(pan);
  let phase = 0, second = 0;
  for (let frame = 0; frame < frames; frame++) {
    const time = frame / SAMPLE_RATE;
    const envelope = shape(time / attack) * shape((note.seconds + release - time) / release) * Math.exp(-time * decay);
    const sample = (table[phase | 0] * 0.76 + table[second | 0] * 0.24) * envelope;
    left[first + frame] += sample * levelLeft;
    right[first + frame] += sample * levelRight;
    phase = (phase + increment) % TABLE_SIZE;
    second = (second + increment * (1 + detune)) % TABLE_SIZE;
    if ((frame + 1) % BLOCK === 0) await yieldToApp();
  }
}

function waveBuffer(frames) {
  const dataBytes = frames * 4;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * 4, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataBytes, 40);
  return wav;
}

async function encodeWave(left, right) {
  const wav = waveBuffer(left.length);
  function room(dry, other, frame) {
    // Sparse reflections add width without pulling the music in front of the narration.
    return dry[frame] + 0.18 * (other[frame - 1584] || 0) + 0.12 * (dry[frame - 3552] || 0) +
      0.08 * (other[frame - 6384] || 0) + 0.05 * (dry[frame - 9936] || 0);
  }
  let peak = 0, energy = 0;
  for (let frame = 0; frame < left.length; frame++) {
    const l = room(left, right, frame), r = room(right, left, frame);
    peak = Math.max(peak, Math.abs(l), Math.abs(r));
    energy += l * l + r * r;
    if ((frame + 1) % BLOCK === 0) await yieldToApp();
  }
  const rms = Math.sqrt(energy / (left.length * 2));
  const gain = Math.min(0.74 / peak, 0.105 / rms, 6) * 32767;
  for (let frame = 0; frame < left.length; frame++) {
    const remaining = (left.length - frame - 1) / SAMPLE_RATE;
    const level = gain * shape(frame / (0.075 * SAMPLE_RATE)) * shape(remaining / 0.52);
    const offset = 44 + frame * 4;
    wav.writeInt16LE(Math.round(room(left, right, frame) * level), offset);
    wav.writeInt16LE(Math.round(room(right, left, frame) * level), offset + 2);
    if ((frame + 1) % BLOCK === 0) await yieldToApp();
  }
  return wav;
}

async function writeMusic({ filename, style, durationSeconds, seed = 'studio' }) {
  if (typeof filename !== 'string' || !/\.wav$/i.test(filename)) throw new Error('Choose a WAV filename for background music.');
  if (!Object.hasOwn(MUSIC_PRESETS, style)) throw new Error('Choose a supported music style.');
  if (!Number.isFinite(durationSeconds) || durationSeconds < 1 || durationSeconds > 60) {
    throw new Error('Background music supports videos from 1 to 60 seconds.');
  }
  const frames = Math.round(durationSeconds * SAMPLE_RATE);
  const left = new Float32Array(frames), right = new Float32Array(frames);
  for (const note of arrange(style, frames / SAMPLE_RATE, randomSource(String(seed)))) {
    await renderNote(note, left, right);
  }
  await fs.writeFile(filename, await encodeWave(left, right), { flag: 'wx' });
  return { durationSeconds: frames / SAMPLE_RATE, sampleRate: SAMPLE_RATE };
}

module.exports = { MUSIC_PRESETS, writeMusic };
