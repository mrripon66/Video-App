'use strict';

const DIRECTIVE = /(?:^|\n[ \t]*|[ \t]+\|[ \t]*)(narration|voiceover|voice|sound|format)[ \t]*:[ \t]*/gi;
const PRESETS = new Map([
  ['none', 'none'], ['silence', 'none'], ['original sound only', 'none'],
  ['rain', 'rain'], ['gentle rain', 'rain'], ['ocean', 'ocean'], ['ocean surf', 'ocean'],
  ['quiet room', 'room'], ['room tone', 'room'],
]);
const FRAMINGS = new Map([
  ['reel', 'fit'], ['vertical', 'fit'], ['9:16', 'fit'], ['fit', 'fit'],
  ['crop', 'crop'], ['vertical crop', 'crop'], ['original', 'source'], ['landscape', 'source'],
]);

function unquote(text) {
  const pairs = [['"', '"'], ['“', '”']];
  return pairs.some(([left, right]) => text.startsWith(left) && text.endsWith(right)) ? text.slice(1, -1).trim() : text;
}

function parseProduction(prompt) {
  const matches = [...prompt.matchAll(DIRECTIVE)];
  const visualPrompt = prompt.slice(0, matches[0]?.index ?? prompt.length).trim();
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
  const noNarration = /\b(?:no|without|avoid) (?:any )?(?:narration|narrator|voice[ -]?over)\b/i.test(visualPrompt);
  const narrationRequest = values.narration || (!noNarration && (values.voice || narrationCue.test(visualPrompt)) ? 'auto' : '');
  const autoNarration = narrationRequest.toLowerCase() === 'auto';
  const narration = autoNarration || /^none$/i.test(narrationRequest) ? '' : narrationRequest;
  if (narration.length > 700) throw new Error('Keep narration to 700 characters or fewer. A 15-second clip usually fits about 25–30 words.');

  const noSound = /\b(?:no|without|avoid) (?:any )?(?:sound|sound effects?|audio|ambience)\b/i.test(visualPrompt);
  const soundRequest = values.sound || (!noSound && /\b(?:natural sounds?|sound effects?|sound of|ambience|ambient audio)\b/i.test(visualPrompt) ? 'auto' : '');
  const soundKey = soundRequest.toLowerCase();
  const sound = PRESETS.get(soundKey) || (soundRequest ? 'prompt' : 'none');
  const autoSound = soundKey === 'auto';
  const soundPrompt = sound === 'prompt' && !autoSound ? soundRequest : '';
  if (soundPrompt.length > 500) throw new Error('Keep the sound description to 500 characters or fewer.');

  const framing = FRAMINGS.get((values.format || 'reel').toLowerCase());
  if (!framing) throw new Error('Choose Format: reel, Format: crop, or Format: original.');
  if (!matches.length && !autoNarration && !autoSound) return { visualPrompt, production: null };
  return { visualPrompt, production: { framing, voice, narration, autoNarration, sound, soundPrompt, autoSound } };
}

module.exports = { parseProduction };
