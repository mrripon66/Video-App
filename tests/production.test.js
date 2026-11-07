'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseProduction } = require('../src/core/production');

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
  assert.equal(plan.production.framing, 'fit');
  assert.equal(parseProduction('A still pond with no narration or sound effects.').production?.autoNarration || false, false);
  const silent = parseProduction('A still pond.\nNarration: none\nSound: none');
  assert.equal(silent.production.narration, '');
  assert.equal(silent.production.sound, 'none');
  assert.throws(() => parseProduction('A pond.\nSound: rain\nSound: ocean'), /one sound/);
});
