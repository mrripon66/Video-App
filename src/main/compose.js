'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function mediaExecutable() {
  return process.resourcesPath && process.versions.electron && require('electron').app?.isPackaged
    ? path.join(process.resourcesPath, 'media', 'ffmpeg.exe') : require('ffmpeg-static');
}

function runMedia(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-hide_banner', '-nostdin', ...args], {
      windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let progress = '', diagnostic = '', settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error('Local video assembly timed out. Your generated clips are saved; retry assembly.')); }, 15 * 60 * 1000);
    child.stdout.on('data', chunk => { progress = (progress + chunk.toString()).slice(-65536); });
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-8192); });
    child.on('error', () => finish(new Error('The bundled video assembly tool could not start. Reinstall this update; your generated clips are saved.')));
    child.on('close', code => {
      if (code !== 0) return finish(new Error('Local video processing failed. Your generated clips are saved. ' + diagnostic.slice(-900)));
      const times = [...progress.matchAll(/^out_time_us=(\d+)$/gm)];
      const durationSeconds = times.length ? Number(times.at(-1)[1]) / 1000000 : 0;
      const metadata = diagnostic.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      const containerDuration = metadata ? Number(metadata[1]) * 3600 + Number(metadata[2]) * 60 + Number(metadata[3]) : null;
      finish(null, { durationSeconds, containerDuration, diagnostic });
    });
  });
}

async function decodedDuration(filename, executable = mediaExecutable()) {
  const result = await runMedia(executable, ['-v', 'info', '-xerror', '-threads', '4', '-protocol_whitelist', 'file,pipe',
    '-i', filename, '-map', '0:v:0', '-an', '-f', 'null', '-', '-progress', 'pipe:1', '-nostats']);
  if (!Number.isFinite(result.durationSeconds) || result.durationSeconds <= 0) throw new Error('A generated clip has no decodable video frames.');
  // FFmpeg's null-output progress reports the last frame timestamp, which can
  // precede its end by one frame. Use the container duration only after the
  // whole video decoded successfully and reached that end within tolerance.
  return result.containerDuration > 0 && Math.abs(result.containerDuration - result.durationSeconds) <= 0.15
    ? result.containerDuration : result.durationSeconds;
}

function createComposer({ directory, executable = mediaExecutable() }) {
  const root = path.resolve(directory);
  const active = new Set();
  return async function composeVideo({ jobId, segments, durationSeconds, orientation }) {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(jobId || '') || !Array.isArray(segments) || segments.length !== 2 ||
      (orientation !== undefined && orientation !== 'portrait') ||
      !Number.isFinite(durationSeconds) || durationSeconds < 15 || durationSeconds > 20 ||
      segments.some(segment => !Number.isFinite(segment.durationSeconds) || segment.durationSeconds < 1 || segment.durationSeconds > 10) ||
      Math.abs(segments.reduce((sum, segment) => sum + segment.durationSeconds, 0) - durationSeconds) > 0.001) {
      throw new Error('The saved longer-video plan is invalid. No video was assembled.');
    }
    if (active.has(jobId)) throw new Error('This video is already being assembled.');
    active.add(jobId);
    const output = path.join(root, jobId + '.mp4');
    const temporary = path.join(root, jobId + '.assembling.mp4');
    try {
      const canonicalRoot = fs.realpathSync(root);
      const inputs = segments.map(segment => {
        if (typeof segment.videoPath !== 'string') throw new Error('A saved clip is missing.');
        const filename = fs.realpathSync(segment.videoPath);
        const relative = path.relative(canonicalRoot, filename);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !fs.statSync(filename).isFile()) throw new Error('A saved clip is outside the video library.');
        return filename;
      });
      for (let index = 0; index < inputs.length; index++) {
        const actual = await decodedDuration(inputs[index], executable);
        if (actual + 0.08 < segments[index].durationSeconds) {
          throw new Error(`Shot ${index + 1} is shorter than requested (${actual.toFixed(2)} seconds). The app will not loop or stretch it to claim a longer video.`);
        }
      }
      const framing = orientation === 'portrait'
        ? 'scale=512:768:force_original_aspect_ratio=increase,crop=512:768'
        : 'scale=768:512:force_original_aspect_ratio=decrease,pad=768:512:(ow-iw)/2:(oh-ih)/2';
      const filters = segments.map((segment, index) => `[${index}:v:0]${framing},setsar=1,fps=24,trim=duration=${segment.durationSeconds},setpts=PTS-STARTPTS[v${index}]`);
      filters.push('[v0][v1]concat=n=2:v=1:a=0[out]');
      const args = ['-v', 'error', '-xerror', '-y', '-filter_complex_threads', '2'];
      for (const filename of inputs) args.push('-threads', '4', '-protocol_whitelist', 'file,pipe', '-i', filename);
      args.push('-filter_complex', filters.join(';'), '-map', '[out]', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-pix_fmt', 'yuv420p', '-threads', '4', '-movflags', '+faststart', '-t', String(durationSeconds), temporary, '-progress', 'pipe:1', '-nostats');
      await runMedia(executable, args);
      const actual = await decodedDuration(temporary, executable);
      if (Math.abs(actual - durationSeconds) > 0.1) throw new Error('The assembled video duration did not match the requested length. Your original clips are saved.');
      fs.renameSync(temporary, output);
      return output;
    } finally {
      fs.rmSync(temporary, { force: true });
      active.delete(jobId);
    }
  };
}

module.exports = { createComposer, decodedDuration, mediaExecutable, runMedia };
