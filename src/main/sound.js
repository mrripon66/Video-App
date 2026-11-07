'use strict';
const fs = require('node:fs/promises');

const SAMPLE_RATE = 48000;
const SOUND_PRESETS = Object.freeze({ rain: 'Gentle rain', ocean: 'Ocean surf', room: 'Quiet room' });

function randomSource(seed) {
  let state = seed;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function noiseTexture(random) {
  let high = 0, mid = 0, low = 0, floor = 0;
  return () => {
    const noise = random() * 2 - 1;
    high += 0.47 * (noise - high);
    mid += 0.16 * (noise - mid);
    low += 0.048 * (noise - low);
    floor += 0.004 * (noise - floor);
    return { hiss: high - mid, wash: mid - low, rumble: low - floor };
  };
}

function rainDrops(random) {
  let nextDrop = SAMPLE_RATE * 0.04;
  let age = Infinity, phase = 0, step = 0, amplitude = 0, pan = 0, decay = 0;
  return frame => {
    if (frame >= nextDrop) {
      age = 0;
      phase = 0;
      step = 2 * Math.PI * (760 + random() * 2000) / SAMPLE_RATE;
      amplitude = 0.017 + random() * 0.032;
      pan = random() * 1.6 - 0.8;
      decay = SAMPLE_RATE * (0.002 + random() * 0.005);
      nextDrop = frame + Math.round(SAMPLE_RATE * (0.025 + random() * 0.135));
    }
    if (age > decay * 5) return [0, 0];
    const envelope = Math.min(1, age / 24) * Math.exp(-age / decay);
    const sound = amplitude * envelope * (Math.sin(phase) * 0.6 + random() * 0.8 - 0.4);
    phase += step;
    age++;
    return [sound * (1 - pan), sound * (1 + pan)];
  };
}

function createSoundscape(preset) {
  const centerNoise = noiseTexture(randomSource(0x91fb2e69));
  const leftNoise = noiseTexture(randomSource(0x48fc9df3));
  const rightNoise = noiseTexture(randomSource(0xde31af45));
  const drops = rainDrops(randomSource(0x6bd5ae73));
  return (frame, time) => {
    const center = centerNoise(), left = leftNoise(), right = rightNoise();
    if (preset === 'rain') {
      const strength = 0.84 + 0.08 * Math.sin(time * 1.9) + 0.08 * Math.sin(time * 0.66 + 1.4);
      const texture = ({ hiss, wash, rumble }) => 0.23 * hiss + 0.34 * wash + 0.24 * rumble;
      const common = texture(center) * 0.61;
      const [dropLeft, dropRight] = drops(frame);
      return [(common + texture(left) * 0.5) * strength + dropLeft,
        (common + texture(right) * 0.5) * strength + dropRight];
    }
    if (preset === 'ocean') {
      const swell = (0.5 + 0.5 * Math.sin(time * 1.14 + 0.18 * Math.sin(time * 0.47) - 0.6)) ** 2;
      const texture = ({ hiss, wash, rumble }) => 0.2 * hiss + 0.42 * wash + 0.58 * rumble;
      const common = texture(center) * 0.79;
      return [(common + texture(left) * 0.36) * (0.23 + swell * 0.75),
        (common + texture(right) * 0.36) * (0.23 + swell * 0.75)];
    }
    const drift = 0.91 + 0.09 * Math.sin(time * 0.48);
    const common = (center.rumble * 0.2 + center.wash * 0.04) * drift;
    return [common + left.rumble * 0.06, common + right.rumble * 0.06];
  };
}

function waveBuffer(frames) {
  const dataLength = frames * 4;
  const wav = Buffer.alloc(44 + dataLength);
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
  wav.writeUInt32LE(dataLength, 40);
  return wav;
}

async function writeSoundtrack({ filename, preset, durationSeconds }) {
  if (!Object.hasOwn(SOUND_PRESETS, preset)) throw new Error('Choose a supported sound preset.');
  if (!Number.isFinite(durationSeconds) || durationSeconds < 1 || durationSeconds > 60) {
    throw new Error('Soundtracks support videos from 1 to 60 seconds.');
  }
  const frames = Math.round(durationSeconds * SAMPLE_RATE);
  const wav = waveBuffer(frames);
  const sample = createSoundscape(preset);
  const pcm = value => Math.round(Math.max(-1, Math.min(1, value)) * 32767);
  for (let frame = 0; frame < frames; frame++) {
    const time = frame / SAMPLE_RATE;
    const remaining = (frames - 1 - frame) / SAMPLE_RATE;
    const fade = Math.min(1, time / 0.16, remaining / 0.28);
    const gain = fade * fade * (3 - 2 * fade);
    const [left, right] = sample(frame, time);
    const offset = 44 + frame * 4;
    wav.writeInt16LE(pcm(left * gain), offset);
    wav.writeInt16LE(pcm(right * gain), offset + 2);
  }
  await fs.writeFile(filename, wav, { flag: 'wx' });
  return { durationSeconds: frames / SAMPLE_RATE, sampleRate: SAMPLE_RATE };
}

module.exports = { SOUND_PRESETS, writeSoundtrack };
