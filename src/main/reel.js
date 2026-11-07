'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { mediaExecutable, runMedia } = require('./compose');
const { SOUND_PRESETS, writeSoundtrack } = require('./sound');

const WIDTH = 1080;
const HEIGHT = 1920;
const MAX_SECONDS = 60;
const FRAME_TOLERANCE = 0.12;
const INPUT_VIDEO = ['-threads', '4', '-format_whitelist', 'mov,matroska,webm', '-protocol_whitelist', 'file,pipe'];
const activeExports = new Set();

async function inspectVideo(filename, executable) {
  const result = await runMedia(executable, ['-v', 'info', '-xerror', ...INPUT_VIDEO,
    '-i', filename, '-map', '0:V:0', '-an', '-t', String(MAX_SECONDS + 1), '-f', 'null', '-', '-progress', 'pipe:1', '-nostats']);
  const input = result.diagnostic.split('Stream mapping:')[0];
  const video = [...input.matchAll(/^\s*Stream #0:[^\r\n]*: Video: ([^\r\n]+)/gm)]
    .find(stream => !stream[1].includes('(attached pic)'))?.[1] || '';
  const audio = input.match(/^\s*Stream #0:[^\r\n]*: Audio: ([^\r\n]+)/m)?.[1] || '';
  const size = video.match(/(?:^|[,\s])(\d{2,5})x(\d{2,5})(?=[,\s\[]|$)/);
  const durationSeconds = result.containerDuration > 0 && Math.abs(result.containerDuration - result.durationSeconds) <= FRAME_TOLERANCE
    ? result.containerDuration : result.durationSeconds;
  if (!size || !Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('This video has no decodable pictures.');
  return { durationSeconds, width: Number(size[1]), height: Number(size[2]), video, audio };
}

async function currentDestination(destination, sourceStat, overwrite) {
  const existing = await fs.lstat(destination, { bigint: true }).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (!existing) return null;
  if (!existing.isFile() || (existing.ino !== 0n && existing.ino === sourceStat.ino && existing.dev === sourceStat.dev)) {
    throw new Error('Choose a different filename to keep your original video safe.');
  }
  if (!overwrite) throw new Error('This filename is already in use. Choose another filename.');
  return existing;
}

function videoFilter(framing) {
  const source = '[0:V:0]scale=ceil(iw*sar/2)*2:ih,setsar=1,fps=30';
  if (framing === 'crop') {
    return `${source},scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase:force_divisible_by=2,crop=${WIDTH}:${HEIGHT},setsar=1[v]`;
  }
  return [
    `${source},split=2[foreground][background]`,
    `[foreground]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1[fit]`,
    `[background]scale=270:480:force_original_aspect_ratio=increase:force_divisible_by=2,crop=270:480,gblur=sigma=18:steps=2,eq=brightness=-0.08:saturation=0.7,scale=${WIDTH}:${HEIGHT},setsar=1[fill]`,
    '[fill][fit]overlay=(W-w)/2:(H-h)/2:shortest=1[v]'
  ].join(';');
}

async function createReel({ source, destination, framing = 'fit', sound = 'rain', overwrite = false, executable = mediaExecutable() }) {
  if (typeof source !== 'string' || !/\.(mp4|webm)$/i.test(source) || typeof destination !== 'string' || !/\.mp4$/i.test(destination)) {
    throw new Error('Choose a local video and an MP4 export filename.');
  }
  if (!['fit', 'crop'].includes(framing) || typeof sound !== 'string' ||
    (sound !== 'none' && !Object.hasOwn(SOUND_PRESETS, sound)) || typeof overwrite !== 'boolean') {
    throw new Error('Choose a valid Reel framing and soundtrack.');
  }
  const input = await fs.realpath(source);
  const sourceStat = await fs.stat(input, { bigint: true });
  if (!sourceStat.isFile()) throw new Error('Choose a saved video file.');
  const parent = await fs.realpath(path.dirname(path.resolve(destination)));
  const filename = path.basename(destination);
  if (process.platform === 'win32' && /[<>:"|?*]/.test(filename)) throw new Error('Choose a valid Windows filename for the Reel.');
  const output = path.join(parent, filename);
  const key = filename => process.platform === 'win32' ? filename.toLowerCase() : filename;
  if (key(input) === key(output)) throw new Error('Choose a different filename to keep your original video safe.');
  const exportKey = key(output);
  if (activeExports.has(exportKey)) throw new Error('A Reel is already being saved to this filename.');
  activeExports.add(exportKey);

  let staging;
  try {
    const existing = await currentDestination(output, sourceStat, overwrite);
    const original = await inspectVideo(input, executable);
    if (original.durationSeconds > MAX_SECONDS) throw new Error('Reel export supports videos up to 60 seconds.');
    if (/\b(?:smpte2084|arib-std-b67)\b/.test(original.video)) throw new Error('Reel export supports standard-color library videos.');

    staging = await fs.mkdtemp(path.join(parent, '.studio-reel-'));
    const encoded = path.join(staging, 'reel.mp4');
    const bed = path.join(staging, 'sound.wav');
    const args = ['-v', 'error', '-xerror', '-n', '-filter_complex_threads', '2', ...INPUT_VIDEO, '-i', input];
    let filters = videoFilter(framing);
    let audioMap = '0:a:0?';
    if (sound !== 'none') {
      await writeSoundtrack({ filename: bed, preset: sound, durationSeconds: Math.max(1, original.durationSeconds) });
      args.push('-f', 'wav', '-protocol_whitelist', 'file,pipe', '-i', bed);
      const bedGain = original.audio ? '' : ',volume=5dB,alimiter=limit=0.89:level=0:latency=1';
      filters += `;[1:a:0]atrim=duration=${original.durationSeconds}${bedGain}[bed]`;
      audioMap = '[bed]';
      if (original.audio) {
        filters += ';[0:a:0]aresample=48000:async=1:first_pts=0,aformat=channel_layouts=stereo[original];' +
          "[bed][original]amix=inputs=2:duration=first:normalize=0:weights='0.28 0.9',alimiter=limit=0.89:level=0:latency=1[a]";
        audioMap = '[a]';
      }
    }
    args.push('-filter_complex', filters, '-map', '[v]', '-map', audioMap);
    if (sound === 'none' && original.audio) args.push('-af', `atrim=duration=${original.durationSeconds}`);
    args.push('-map_metadata', '-1', '-map_chapters', '-1', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-profile:v', 'high',
      '-level:v', '4.1', '-pix_fmt', 'yuv420p', '-threads', '4', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '160k',
      '-movflags', '+faststart', encoded, '-progress', 'pipe:1', '-nostats');
    await runMedia(executable, args);

    const result = await inspectVideo(encoded, executable);
    if (result.width !== WIDTH || result.height !== HEIGHT || !/^h264\b/.test(result.video) ||
      Math.abs(result.durationSeconds - original.durationSeconds) > FRAME_TOLERANCE) {
      throw new Error('The exported Reel did not match the expected size or duration.');
    }
    if (sound !== 'none' || original.audio) {
      if (!/^aac\b.*48000 Hz.*stereo/.test(result.audio)) throw new Error('The exported Reel is missing its stereo soundtrack.');
      const decoded = await runMedia(executable, ['-v', 'error', '-xerror', ...INPUT_VIDEO, '-i', encoded,
        '-map', '0:a:0', '-vn', '-f', 'null', '-', '-progress', 'pipe:1', '-nostats']);
      if (!(decoded.durationSeconds > 0) || (sound !== 'none' && decoded.durationSeconds + FRAME_TOLERANCE < result.durationSeconds)) {
        throw new Error('The exported soundtrack did not decode through the end of the Reel.');
      }
    }

    const latest = await currentDestination(output, sourceStat, overwrite);
    if (existing) {
      if (!latest || latest.dev !== existing.dev || latest.ino !== existing.ino || latest.mtimeNs !== existing.mtimeNs || latest.size !== existing.size) {
        throw new Error('The selected file changed during export. Choose a filename again.');
      }
      await fs.rename(encoded, output);
    } else {
      // A same-volume hard link publishes the complete file atomically and fails if another file claims the name.
      if (latest) throw new Error('This filename was taken during export. Choose another filename.');
      try {
        await fs.link(encoded, output);
      } catch (error) {
        // Some export destinations (such as exFAT drives) cannot create hard links.
        if (!['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(error.code)) throw error;
        await fs.copyFile(encoded, output, fs.constants.COPYFILE_EXCL);
      }
    }
    return { durationSeconds: result.durationSeconds, width: result.width, height: result.height };
  } finally {
    if (staging) {
      await fs.unlink(path.join(staging, 'sound.wav')).catch(() => {});
      await fs.unlink(path.join(staging, 'reel.mp4')).catch(() => {});
      await fs.rmdir(staging).catch(() => {});
    }
    activeExports.delete(exportKey);
  }
}

module.exports = { createReel };
