'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseProduction } = require('../src/core/production');
const { planStudioVideo } = require('../src/main/production');

test('a one-line batch prompt separates the scene from narration and sound', () => {
  const plan = parseProduction('A rainy kitchen, 15 seconds. | Narration: "Rain keeps falling." | Voice: clear | Sound: rain on the glass and a cup clink | Format: crop');
  assert.equal(plan.visualPrompt, 'A rainy kitchen, 15 seconds.');
  assert.equal(plan.production.narration, 'Rain keeps falling.');
  assert.equal(plan.production.voice, 'clear');
  assert.equal(plan.production.sound, 'prompt');
  assert.equal(plan.production.soundPrompt, 'rain on the glass and a cup clink');
  assert.equal(plan.production.framing, 'crop');
});

test('automatic voice, a preset, and explicit silence preserve the user’s intent', () => {
  const plan = parseProduction('A wide view of the ocean.\nNarration: auto\nSound: ocean surf');
  assert.equal(plan.production.autoNarration, true);
  assert.equal(plan.production.sound, 'ocean');
  assert.equal(plan.production.framing, 'crop');
  assert.equal(parseProduction('A still pond with no narration or sound effects.').production?.autoNarration || false, false);
  const silent = parseProduction('A still pond.\nNarration: none\nSound: none');
  assert.equal(silent.production.narration, '');
  assert.equal(silent.production.sound, 'none');
  assert.throws(() => parseProduction('A pond.\nSound: rain\nSound: ocean'), /one sound/);
});

test('Reel requests plan portrait shots and an explicit fit keeps the whole landscape shot', () => {
  const model = 'ltx2-story-free';
  for (const format of ['reel', 'vertical', '9:16', 'crop']) {
    const plan = planStudioVideo(model, `A lighthouse.\n**Aspect Ratio:** 16:9\nDuration: 20 seconds\nFormat: ${format}`);
    assert.equal(plan.orientation, 'portrait');
    assert.equal(plan.production.framing, 'crop');
    assert.equal(plan.durationSeconds, 20);
    assert.ok(plan.segments.every(shot => shot.prompt.includes('full-screen 9:16 Reel') && !shot.prompt.includes('16:9')));
  }
  assert.equal(planStudioVideo(model, 'A vertical reel of a lighthouse.').orientation, 'portrait');
  assert.equal(planStudioVideo(model, 'A lighthouse.').orientation, undefined);
  const fit = planStudioVideo(model, 'A lighthouse.\nFormat: fit');
  assert.equal(fit.orientation, undefined);
  assert.equal(fit.production.framing, 'fit');
});

test('music instructions plan a local score independently of ambience or speech', () => {
  const plan = planStudioVideo('ltx2-story-free', 'A 20-second walk through a foggy forest. | Sound: quiet room | Music: gentle piano | Format: reel');
  assert.equal(plan.production.music, 'calm');
  assert.equal(plan.production.sound, 'room');
  assert.equal(plan.production.narration, '');
  assert.equal(plan.durationSeconds, 20);
  assert.ok(plan.segments.every(shot => !shot.prompt.includes('Music:')));
  assert.equal(parseProduction('A playful scene with background music.').production.music, 'upbeat');
  assert.equal(parseProduction('An ominous trail.\nMusic: auto').production.music, 'suspense');
  assert.equal(parseProduction('A car drives away without background music.').production, null);
  assert.equal(parseProduction('A cinematic scene.\nSound: ocean\nMusic: none').production.music, 'none');
  assert.throws(() => parseProduction('A boat.\nMusic: a specific song'), /Choose Music/);
});

test('a storyboard audio paragraph preserves sound while honoring an exclusion list', () => {
  const prompt = 'Create an 18-second 9:16 video of an ocean blowhole.\n\nAUDIO:\nPowerful surf and a deep hollow boom. No background music or narrator.\n\nSTRICT REALISM:\nKeep the cliff shape consistent.';
  const { visualPrompt, production } = parseProduction(prompt, { inferPortrait: true, inferStoryboardAudio: true });
  assert.match(visualPrompt, /Keep the cliff shape consistent/);
  assert.doesNotMatch(visualPrompt, /AUDIO:/);
  assert.equal(production.autoNarration, false);
  assert.equal(production.music, 'none');
  assert.equal(production.sound, 'prompt');
  assert.match(production.soundPrompt, /Powerful surf/);
  assert.equal(parseProduction('An ocean video with no background music, subtitles, or scripted voiceover.').production, null);
  assert.equal(parseProduction('An ocean video.\nAUDIO: No music or narrator.', { inferStoryboardAudio: true }).production, null);
  assert.equal(parseProduction('An ocean video without music or a narrator.\nNarration: Read this.').production.narration, 'Read this.');
});
