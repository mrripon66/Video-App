'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createComposer, decodedDuration, runMedia } = require('../src/main/compose');

test('real local assembly produces 15 and 20 seconds and refuses short or outside clips', { timeout: 180000 }, async t => {
  const executable = require('ffmpeg-static');
  const parent = path.resolve('.test-data');
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'compose-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const library = path.join(directory, 'videos');
  fs.mkdirSync(library);
  // These synthetic fixtures exercise the local editor only. They are never
  // included in the installer, a user library, or evidence of AI generation.
  const makeFixture = (filename, source, seconds) => execFileSync(executable, ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi',
    '-i', source + (source.includes('=') ? ':' : '=') + 'size=160x96:rate=24', '-t', String(seconds), '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '2', filename],
  { windowsHide: true, timeout: 30000 });
  const first = path.join(library, 'first.mp4'), second = path.join(library, 'second.mp4');
  makeFixture(first, 'testsrc2', 10);
  makeFixture(second, 'color=c=blue', 10);
  const compose = createComposer({ directory: library, executable });
  for (const [seconds, orientation, resolution] of [[15, undefined, /768x512/], [20, 'portrait', /512x768/]]) {
    const output = await compose({ jobId: 'test-' + seconds, durationSeconds: seconds, orientation,
      segments: [{ videoPath: first, durationSeconds: 10 }, { videoPath: second, durationSeconds: seconds - 10 }] });
    assert.ok(fs.statSync(output).size > 1000);
    assert.ok(Math.abs(await decodedDuration(output, executable) - seconds) < 0.1);
    const { diagnostic } = await runMedia(executable, ['-i', output, '-map', '0:v:0', '-frames:v', '1', '-f', 'null', '-']);
    assert.match(diagnostic, resolution);
  }
  const short = path.join(library, 'short.mp4');
  makeFixture(short, 'testsrc2', 1);
  await assert.rejects(compose({ jobId: 'short-refused', durationSeconds: 15,
    segments: [{ videoPath: short, durationSeconds: 10 }, { videoPath: second, durationSeconds: 5 }] }), /shorter than requested/);
  assert.equal(fs.existsSync(path.join(library, 'short-refused.mp4')), false);
  const outside = path.join(directory, 'outside.mp4');
  fs.copyFileSync(first, outside);
  await assert.rejects(compose({ jobId: 'outside-refused', durationSeconds: 15,
    segments: [{ videoPath: outside, durationSeconds: 10 }, { videoPath: second, durationSeconds: 5 }] }), /outside the video library/);
  await assert.rejects(compose({ jobId: '../escape', durationSeconds: 15,
    segments: [{ videoPath: first, durationSeconds: 10 }, { videoPath: second, durationSeconds: 5 }] }), /invalid/);
  assert.ok(!fs.readdirSync(library).some(filename => filename.endsWith('.assembling.mp4')));
});
