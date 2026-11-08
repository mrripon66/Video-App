'use strict';

const MUSIC_PRESETS = Object.freeze({ calm: 'Gentle piano', cinematic: 'Cinematic strings', upbeat: 'Upbeat acoustic', suspense: 'Quiet suspense' });

function matchMusicStyle(description) {
  if (/\b(?:suspense(?:ful)?|tense|ominous|eerie|mystery|thriller)\b/i.test(description)) return 'suspense';
  if (/\b(?:upbeat|bright|playful|cheerful|acoustic|bouncy|energetic)\b/i.test(description)) return 'upbeat';
  if (/\b(?:cinematic|orchestral|epic|dramatic|strings)\b/i.test(description)) return 'cinematic';
  if (/\b(?:calm|gentle|quiet|soft|relaxing|piano|peaceful|warm)\b/i.test(description)) return 'calm';
  return null;
}

module.exports = { MUSIC_PRESETS, matchMusicStyle };
