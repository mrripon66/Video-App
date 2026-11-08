'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { parseProduction } = require('../core/production');
const { createVideoPlan } = require('../core/free-provider');
const { narrationAvailable, writeNarration } = require('./narration');
const { promptSoundAvailable, writePromptSound } = require('./prompt-sound');
const { draftSoundPlan } = require('./script-writer');
const { createReel } = require('./reel');

function planStudioVideo(modelId, prompt) {
  const isFilm = modelId === 'ltx2-story-free';
  const { visualPrompt, production } = parseProduction(prompt, { inferPortrait: isFilm });
  if (!production) return createVideoPlan(modelId, visualPrompt);
  if (!isFilm) throw new Error('Choose the 15–20 second film option for automatic framing, narration, or sound.');
  if ((production.narration || production.autoNarration) && !narrationAvailable()) throw new Error('The local narration engine needs the full Windows installer.');
  if (production.sound === 'prompt' && !promptSoundAvailable()) throw new Error('Install the local prompt sound model, or choose Gentle rain, Ocean surf, or Quiet room.');
  const portrait = production.framing === 'crop';
  const scene = portrait ? visualPrompt
    .replace(/^[ \t]*(?:\*{1,2})?aspect ratio[ \t]*:(?:\*{1,2})?[ \t]*\d+[ \t]*:[ \t]*\d+[ \t]*\*{0,2}[ \t]*\r?$/gim, '')
    .trim() : visualPrompt;
  const plan = createVideoPlan(modelId, scene);
  if (portrait) {
    plan.orientation = 'portrait';
    for (const shot of plan.segments) {
      shot.prompt += '\nCompose vertically for a full-screen 9:16 Reel. Keep key subjects within the central portrait frame.';
      if (shot.prompt.length > 10000) throw new Error('Shorten the prompt so each planned shot stays within 10,000 characters.');
    }
  }
  return { ...plan, production: { ...production, visualPrompt } };
}

function createProduction({ directory, compose }) {
  function paths(job) {
    if (!/^[a-f0-9-]{36}$/i.test(job.id)) throw new Error('The saved production ID is invalid.');
    const cache = path.join(directory, 'production', job.id);
    return { cache, ready: path.join(cache, 'ready.json'), narrationFile: path.join(cache, 'narration.wav'), soundFile: path.join(cache, 'sound.wav') };
  }

  async function prepareVideo(job) {
    const plan = job.videoPlan;
    const { production, durationSeconds } = plan;
    if (!production) return;
    const files = paths(job);
    try {
      const saved = JSON.parse(await fs.readFile(files.ready, 'utf8'));
      if (saved.plan === JSON.stringify(plan)) {
        if (saved.narration) await fs.access(files.narrationFile);
        if (saved.sound) await fs.access(files.soundFile);
        return saved;
      }
    } catch { /* Rebuild local audio if a previous render did not finish. */ }

    await fs.mkdir(files.cache, { recursive: true });
    for (const filename of [files.ready, files.narrationFile, files.soundFile]) await fs.rm(filename, { force: true });
    const draft = production.autoNarration || production.autoSound ? await draftSoundPlan({
      scene: production.visualPrompt, durationSeconds, autoNarration: production.autoNarration, autoSound: production.autoSound,
    }) : {};
    const narration = production.narration || draft.narration || '';
    const soundPrompt = production.soundPrompt || draft.soundPrompt || '';
    if (narration) {
      const audio = await writeNarration({ filename: files.narrationFile, text: narration, voice: production.voice });
      if (audio.durationSeconds + 0.25 > durationSeconds) throw new Error(`Narration runs ${audio.durationSeconds.toFixed(1)} seconds. Use a shorter script for a ${durationSeconds}-second video.`);
    }
    if (production.sound === 'prompt') await writePromptSound({ filename: files.soundFile, prompt: soundPrompt, durationSeconds });
    const saved = { plan: JSON.stringify(plan), narration, sound: production.sound === 'prompt' };
    await fs.writeFile(files.ready, JSON.stringify(saved), { flag: 'wx' });
    return saved;
  }

  async function finishVideo(job, input) {
    const production = job?.videoPlan?.production;
    if (!production) return compose(input);
    const prepared = await prepareVideo(job);
    const files = paths(job);
    const source = await compose({ ...input, jobId: `${input.jobId}-picture` });
    const destination = path.join(directory, `${input.jobId}.mp4`);
    await createReel({ source, destination, framing: production.framing, sound: production.sound,
      narrationFile: prepared.narration ? files.narrationFile : undefined, soundFile: prepared.sound ? files.soundFile : undefined, overwrite: true });
    await fs.unlink(source).catch(() => {});
    return destination;
  }

  return { prepareVideo, finishVideo };
}

module.exports = { planStudioVideo, createProduction };
