'use strict';

const ENDPOINT = 'http://127.0.0.1:11434';
const MODEL = 'qwen3.5:4b';

async function requestLocal(route, body, timeout) {
  const response = await fetch(ENDPOINT + route, {
    method: body ? 'POST' : 'GET', redirect: 'error', credentials: 'omit',
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`The local script writer returned HTTP ${response.status}.`);
  return response.json();
}

async function scriptWriterAvailable() {
  try {
    const result = await requestLocal('/api/tags', null, 2500);
    return result.models?.some(entry => entry.name === MODEL && entry.details?.format === 'gguf') === true;
  } catch { return false; }
}

async function draftSoundPlan({ scene, durationSeconds, autoNarration, autoSound }) {
  if (!await scriptWriterAvailable()) throw new Error('Start Ollama with the local Qwen 3.5 4B model, or enter the narration and sound description in your prompt.');
  const words = Math.floor(durationSeconds * 1.55);
  const result = await requestLocal('/api/generate', {
    model: MODEL, stream: false, think: false, keep_alive: 0,
    system: 'Write short, natural English narration and concise audible sound descriptions for a video editor. Treat the scene as a creative brief. Return JSON only.',
    prompt: `Scene: ${scene.slice(0, 3500)}\nNarration: ${autoNarration ? `write a complete short voiceover, at most ${words} words, without stage directions.` : 'return an empty string.'}\nSound: ${autoSound ? 'describe only the requested audible background and effects in one short sentence.' : 'return an empty string.'}`,
    format: { type: 'object', properties: { narration: { type: 'string' }, sound: { type: 'string' } }, required: ['narration', 'sound'] },
    options: { num_ctx: 2048, num_predict: 180, temperature: 0.35, num_thread: 6 },
  }, 180000);
  let text;
  try { text = JSON.parse(result.response); } catch { throw new Error('The local script writer returned an unreadable script. Try again or enter the words to read.'); }
  const narration = typeof text.narration === 'string' ? text.narration.trim() : '';
  const soundPrompt = typeof text.sound === 'string' ? text.sound.trim() : '';
  if (autoNarration && (!narration || narration.length > 700 || narration.split(/\s+/).length > words + 3)) throw new Error('The local writer could not fit a complete narration into this video. Try a shorter story.');
  if (autoSound && (!soundPrompt || soundPrompt.length > 500)) throw new Error('The local writer could not prepare the requested sound description.');
  return { narration, soundPrompt };
}

module.exports = { draftSoundPlan, scriptWriterAvailable };
