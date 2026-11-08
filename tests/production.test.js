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
