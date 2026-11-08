'use strict';

const { MUSIC_PRESETS, matchMusicStyle } = require('./music-styles');

const DIRECTIVE = /(?:^|\n[ \t]*|[ \t]+\|[ \t]*)(narration|voiceover|voice|sound|music|format)[ \t]*:[ \t]*/gi;
const PRESETS = new Map([
  ['none', 'none'], ['silence', 'none'], ['original sound only', 'none'],
  ['rain', 'rain'], ['gentle rain', 'rain'], ['ocean', 'ocean'], ['ocean surf', 'ocean'],
  ['quiet room', 'room'], ['room tone', 'room'],
]);
const FRAMINGS = new Map([
  ['reel', 'crop'], ['vertical', 'crop'], ['9:16', 'crop'], ['fit', 'fit'],
  ['crop', 'crop'], ['vertical crop', 'crop'], ['original', 'source'], ['landscape', 'source'],
]);
const NARRATION = '(?:narration|narrator|voice[ -]?over)';
const AMBIENCE = '(?:sound(?: effects?)?|audio|ambience)';
const MUSIC = '(?:music|soundtrack)';

function excludes(prompt, subject) {
  const item = new RegExp(`^(?:(?:any|a|an|background|instrumental|scripted)\\s+)*${subject}\\b`, 'i');
  for (const [, clause] of prompt.matchAll(/\b(?:no|without|avoid)[ \t]+([^.;!?\r\n]+)/gi)) {
    if (clause.split(/\s*,\s*|\s+\b(?:or|and)\s+/i).some(part => item.test(part.replace(/^(?:or|and)\s+/i, '')))) return true;
  }
  return false;
}

function unquote(text) {
  const pairs = [['"', '"'], ['“', '”']];
  return pairs.some(([left, right]) => text.startsWith(left) && text.endsWith(right)) ? text.slice(1, -1).trim() : text;
}

function parseProduction(prompt, { inferPortrait = false, inferStoryboardAudio = false } = {}) {
  const matches = [...prompt.matchAll(DIRECTIVE)];
  let visualPrompt = prompt.slice(0, matches[0]?.index ?? prompt.length).trim();
  // Storyboards often put an AUDIO heading between picture instructions.
  const audio = inferStoryboardAudio ? visualPrompt.match(/(?:^|\r?\n)[ \t]*audio:[ \t]*(?:\r?\n[ \t]*)?([^\r\n]+)/i) : null;
  const audioDescription = audio?.[1].trim();
  const describedSound = audioDescription?.split(/(?<=[.!?])\s+/).some(sentence => !/^(?:no|without|avoid)\b/i.test(sentence)) ? audioDescription : '';
  const sceneWithAudio = visualPrompt;
  if (audioDescription) visualPrompt = (visualPrompt.slice(0, audio.index) + visualPrompt.slice(audio.index + audio[0].length)).trim();
  const values = {};
  for (const [index, marker] of matches.entries()) {
    const rawKey = marker[1].toLowerCase();
    const key = rawKey === 'voiceover' ? 'narration' : rawKey;
    if (Object.hasOwn(values, key)) throw new Error(`Use one ${key} instruction per prompt.`);
    values[key] = unquote(prompt.slice(marker.index + marker[0].length, matches[index + 1]?.index ?? prompt.length).trim());
    if (!values[key]) throw new Error(`Add text after ${key}.`);
  }
  if (!visualPrompt) throw new Error('Describe the video scene before the sound and narration instructions.');

  const voice = (values.voice || 'warm').toLowerCase();
  if (!['warm', 'clear'].includes(voice)) throw new Error('Choose Voice: warm or Voice: clear.');
  const narrationCue = /\b(?:narration|narrator|voice[ -]?over|voice storytelling)\b/i;
  const noNarration = excludes(sceneWithAudio, NARRATION);
  const narrationRequest = values.narration || (!noNarration && (values.voice || narrationCue.test(visualPrompt)) ? 'auto' : '');
  const autoNarration = narrationRequest.toLowerCase() === 'auto';
  const narration = autoNarration || /^none$/i.test(narrationRequest) ? '' : narrationRequest;
  if (narration.length > 700) throw new Error('Keep narration to 700 characters or fewer. A 15-second clip usually fits about 25–30 words.');

  const noSound = excludes(sceneWithAudio, AMBIENCE);
  const soundCue = /\b(?:natural sounds?|sound effects?|sound of|ambience|ambient audio)\b/i.test(visualPrompt);
  const soundRequest = values.sound || (noSound ? '' : describedSound || (soundCue ? 'auto' : ''));
  const soundKey = soundRequest.toLowerCase();
  const sound = PRESETS.get(soundKey) || (soundRequest ? 'prompt' : 'none');
  const autoSound = soundKey === 'auto';
  const soundPrompt = sound === 'prompt' && !autoSound ? soundRequest : '';
  if (soundPrompt.length > 500) throw new Error('Keep the sound description to 500 characters or fewer.');

  const musicCue = /\b(?:background music|instrumental (?:music|score)|soundtrack|with music|add music|(?:soft|gentle|cinematic|upbeat|suspenseful) music)\b/i.test(visualPrompt);
  const noMusic = excludes(prompt, MUSIC);
  const musicRequest = (values.music || (musicCue && !noMusic ? 'auto' : 'none')).toLowerCase();
  const music = musicRequest === 'auto' ? matchMusicStyle(visualPrompt) || 'calm' :
    /^(?:none|off|no music)$/.test(musicRequest) ? 'none' :
      Object.hasOwn(MUSIC_PRESETS, musicRequest) ? musicRequest : matchMusicStyle(musicRequest);
  if (!music) throw new Error('Choose Music: calm, cinematic, upbeat, suspense, auto, or none.');

  const framing = FRAMINGS.get((values.format || 'reel').toLowerCase());
  if (!framing) throw new Error('Choose Format: reel, Format: fit, or Format: original.');
  const portraitCue = inferPortrait && /\b(?:vertical (?:reel|video|clip|film|short)|9\s*:\s*16)\b/i.test(visualPrompt);
  if (!matches.length && !autoNarration && sound === 'none' && !portraitCue && music === 'none') return { visualPrompt, production: null };
  return { visualPrompt, production: { framing, voice, narration, autoNarration, sound, soundPrompt, autoSound, music } };
}

module.exports = { parseProduction };
