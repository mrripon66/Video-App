'use strict';

const FREE_SPACE_ORIGIN = 'https://lightricks-ltx-video-distilled.hf.space';
const PROFILES = Object.freeze({
  'ltx2-free': Object.freeze({ origin: 'https://lightricks-ltx-2-3.hf.space', prefix: '/gradio_api', api: 'generate_video', output: 'file',
    parameters: ['input_image', 'prompt', 'duration', 'enhance_prompt', 'seed', 'randomize_seed', 'height', 'width'],
    input: (prompt, duration, preset) => [null, prompt, duration ?? 3, false, 42, false, preset === 'film' ? 512 : 1024, preset === 'film' ? 768 : 1536] }),
  'wan-free': Object.freeze({ origin: 'https://kingnish-wan2-2-fast.hf.space', prefix: '/gradio_api', api: 'generate_video', output: 'video',
    parameters: ['input_image', 'prompt', 'height', 'width', 'negative_prompt', 'duration_seconds', 'guidance_scale', 'steps', 'seed', 'randomize_seed'],
    input: (prompt, duration) => [null, prompt, 896, 896, 'blurry, distorted, low quality, static, watermark', duration ?? 5, 0, 8, 42, false] }),
  'animatediff-free': Object.freeze({ origin: 'https://bytedance-animatediff-lightning.hf.space', prefix: '', api: 'generate_image', output: 'video',
    parameters: ['prompt', 'base', 'motion', 'step'], input: prompt => [prompt, 'epiCRealism', '', 8] }),
  'ltx-free': Object.freeze({ origin: FREE_SPACE_ORIGIN, prefix: '/gradio_api', api: 'text_to_video', output: 'video',
    parameters: ['prompt', 'negative_prompt', 'input_image_filepath', 'input_video_filepath', 'height_ui', 'width_ui',
      'mode', 'duration_ui', 'ui_frames_to_use', 'seed_ui', 'randomize_seed', 'ui_guidance_scale', 'improve_texture_flag'],
    input: prompt => [prompt, 'worst quality, inconsistent motion, blurry, jittery, distorted', null, null, 512, 704, 'text-to-video', 2, 9, 42, true, 1, false] }),
});
const FREE_SPACE_ORIGINS = Object.freeze([...new Set(Object.values(PROFILES).map(profile => profile.origin))]);
const FREE_MODELS = Object.freeze([
  { id: 'ltx2-story-free', name: 'LTX 2.3 — 15–20 second film', provider: 'huggingface', available: true,
    description: '15–20 seconds (default 15) · 768 × 512 native · two newly generated shots joined with a cut · free GPU quota applies to each shot', endpoint: 'Lightricks/LTX-2-3',
    docsUrl: 'https://huggingface.co/spaces/Lightricks/LTX-2-3', limits: { gpuSeconds: 75, quotaMultiplier: 1, minDuration: 15, maxDuration: 20, durationStep: 0.1, defaultDuration: 15, segments: 2, defaultWidth: 768, defaultHeight: 512 } },
  { id: 'ltx2-free', name: 'LTX 2.3 — Free', provider: 'huggingface', available: true,
    description: '1–10 seconds (default 3) · 1536 × 1024 · publisher high-resolution preset', endpoint: 'Lightricks/LTX-2-3',
    docsUrl: 'https://huggingface.co/spaces/Lightricks/LTX-2-3', limits: { gpuSeconds: 75, quotaMultiplier: 1, minDuration: 1, maxDuration: 10, durationStep: 0.1, defaultDuration: 3, defaultWidth: 1536, defaultHeight: 1024 } },
  { id: 'wan-free', name: 'Wan 2.2 Fast 5B — Service unavailable', provider: 'huggingface', available: false,
    description: 'The community service failed its live generation check.', endpoint: 'KingNish/wan2-2-fast',
    reason: 'The free community API accepted the test request but returned an error without details. No working anonymous alternative has been verified; paid fallbacks are disabled.',
    docsUrl: 'https://huggingface.co/spaces/KingNish/wan2-2-fast', limits: { gpuSeconds: 90, quotaMultiplier: 1, minDuration: 1, maxDuration: 8, durationStep: 0.1, defaultDuration: 5, defaultSteps: 8, defaultWidth: 896, defaultHeight: 896 } },
  { id: 'animatediff-free', name: 'AnimateDiff Lightning — Free', provider: 'huggingface', available: true,
    description: '1.6 seconds · 16 frames at 10 fps · epiCRealism · 8 steps', endpoint: 'ByteDance/AnimateDiff-Lightning',
    docsUrl: 'https://huggingface.co/spaces/ByteDance/AnimateDiff-Lightning', limits: { gpuSeconds: 60, quotaMultiplier: 1, defaultSteps: 8, defaultDuration: 1.6 } },
  { id: 'ltx-free', name: 'LTX Video 0.9.8 — Legacy free', provider: 'huggingface', available: true,
    description: 'Legacy · 2 seconds · 704 × 512 · lower detail', endpoint: 'Lightricks/ltx-video-distilled',
    docsUrl: 'https://huggingface.co/spaces/Lightricks/ltx-video-distilled', limits: { gpuSeconds: 60, quotaMultiplier: 2, defaultDuration: 2, defaultWidth: 704, defaultHeight: 512 } },
  { id: 'cogvideo-free', name: 'CogVideoX-5B — Account required', provider: 'huggingface', available: false,
    description: 'Publisher demo exceeds anonymous GPU allocation.', endpoint: 'zai-org/CogVideoX-5B-Space',
    reason: 'The publisher reserves 300 GPU seconds per request; anonymous free access includes 120 seconds. Free-account authentication is not configured.',
    docsUrl: 'https://huggingface.co/spaces/zai-org/CogVideoX-5B-Space', limits: { gpuSeconds: 300, quotaMultiplier: 1 } },
  { id: 'cogvideo2-free', name: 'CogVideoX-2B — Account required', provider: 'huggingface', available: false,
    description: 'Publisher demo exceeds anonymous GPU allocation.', endpoint: 'zai-org/CogVideoX-2B-Space',
    reason: 'The publisher reserves 240 GPU seconds per request; anonymous free access includes 120 seconds. Free-account authentication is not configured.',
    docsUrl: 'https://huggingface.co/spaces/zai-org/CogVideoX-2B-Space', limits: { gpuSeconds: 240, quotaMultiplier: 1 } },
].map(model => Object.freeze({ ...model, limits: Object.freeze(model.limits) })));

function failure(message, properties = {}) {
  return Object.assign(new Error(message), { name: 'FreeProviderError', pauseQueue: true, retryable: false, ...properties });
}
function durationTokens(prompt) {
  if (typeof prompt !== 'string') return [];
  const tokens = [];
  const matches = prompt.matchAll(/(?:^|[^\w.])(-?\d+(?:\.\d+)?)(\s*(?:[-\u2010-\u2015]\s*)?)(seconds?|secs?|s)\b/gi);
  for (const match of matches) {
    // A bare historical decade (1930s, 1960s, 2010s) describes the scene;
    // explicit "1930 seconds", "1930 s" or "1930-second" remains a duration.
    if (/^[12]\d{2}0$/.test(match[1]) && match[2] === '' && match[3].toLowerCase() === 's') continue;
    const start = match.index + match[0].indexOf(match[1]);
    tokens.push({ seconds: Number(match[1]), start, end: match.index + match[0].length });
  }
  return tokens;
}
function parsePromptDuration(prompt) {
  return durationTokens(prompt)[0]?.seconds ?? null;
}
function createVideoPlan(modelId, prompt) {
  if (modelId !== 'ltx2-story-free') return null;
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.trim().length > 10000) {
    throw failure('Enter a prompt between 1 and 10,000 characters.', { submissionUncertain: false });
  }
  const tokens = durationTokens(prompt);
  const durationSeconds = tokens[0]?.seconds ?? 15;
  if (!Number.isFinite(durationSeconds) || durationSeconds < 15 || durationSeconds > 20 ||
    Math.abs(durationSeconds * 10 - Math.round(durationSeconds * 10)) > 1e-7) {
    throw failure(`The two-shot LTX film supports 15–20 seconds in 0.1-second increments; requested ${durationSeconds} seconds. No GPU request was sent.`, { submissionUncertain: false });
  }
  // Remove the total-length wording from the individual shot prompts. Keep
  // other timing details, such as an action lasting two seconds, intact.
  let scene = prompt;
  for (const token of tokens.filter(token => token.seconds === durationSeconds).reverse()) {
    scene = scene.slice(0, token.start) + scene.slice(token.end);
  }
  scene = scene.replace(/[ \t]{2,}/g, ' ').trim();
  if (!scene) throw failure('Describe the subject and action for the two-shot film.', { submissionUncertain: false });
  const durations = [10, Math.round((durationSeconds - 10) * 10) / 10];
  const segments = durations.map((duration, index) => ({
    durationSeconds: duration,
    prompt: `Create a ${duration}-second shot. Shot ${index + 1} of 2 in a two-shot film. ${scene}\n${index === 0 ? 'Establish the scene and begin the main action.' : 'Use a distinct camera angle for the second shot, continuing the scene subject and action. A cut between shots is expected.'}`,
  }));
  if (segments.some(segment => segment.prompt.length > 10000)) {
    throw failure('Shorten the prompt so each planned shot stays within 10,000 characters.', { submissionUncertain: false });
  }
  return { durationSeconds, segments };
}
function requestedDuration(modelId, prompt) {
  const seconds = parsePromptDuration(prompt);
  if (seconds === null) return null;
  if (modelId === 'ltx2-free' || modelId === 'wan-free') {
    const max = modelId === 'wan-free' ? 8 : 10;
    const name = modelId === 'wan-free' ? 'This Wan 2.2 demo' : 'LTX 2.3';
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > max || Math.abs(seconds * 10 - Math.round(seconds * 10)) > 1e-7) {
      throw failure(`${name} supports 1–${max} seconds per clip in 0.1-second increments; requested ${seconds} seconds. No GPU request was sent.`, { submissionUncertain: false });
    }
  } else {
    const fixed = modelId === 'animatediff-free' ? 1.6 : 2;
    if (Math.abs(seconds - fixed) > 1e-7) {
      const name = modelId === 'animatediff-free' ? 'This AnimateDiff demo' : 'This legacy LTX preset';
      throw failure(`${name} produces fixed ${fixed}-second clips; requested ${seconds} seconds. Choose LTX 2.3 for 1–10 seconds. No GPU request was sent.`, { submissionUncertain: false });
    }
  }
  return seconds;
}
function quotaMessage(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? 'The free GPU service returned no error details.');
  const shortened = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, 700);
  if (/quota|gpu.*(?:limit|exceed)|too many requests|rate.?limit/i.test(shortened)) {
    return `The free shared GPU quota is unavailable or exhausted. Your queue is paused; wait for the provider's quota reset before resuming. ${shortened}`;
  }
  return `The free community GPU could not finish this video. Your queue is paused. ${shortened}`;
}
function eventUrl(profile, requestId) { return `${profile.origin}${profile.prefix}/call/${profile.api}/${requestId}`; }
function validateRemote(remote) {
  // Version 1.1 handles had no modelId and always referred to the legacy Space.
  const id = remote?.modelId === undefined ? 'ltx-free' : remote.modelId;
  const profile = Object.hasOwn(PROFILES, id) ? PROFILES[id] : null;
  if (!profile || !remote || remote.provider !== 'hf-zerogpu' || !/^[a-zA-Z0-9_-]{1,128}$/.test(remote.requestId || '') || remote.eventUrl !== eventUrl(profile, remote.requestId)) {
    throw failure('The saved free GPU request is invalid. No request was sent.');
  }
  return profile;
}
function videoUrl(value, profile, filePath) {
  let url;
  try { url = new URL(value); } catch { throw failure('The free GPU returned no usable video address.'); }
  // Gradio 4's simplified-call response can prepend /call/gen to FileData.url.
  // Resolve only this observed publisher response from its actual FileData.path
  // using the documented root file route; never accept another host or path.
  if (profile.api === 'generate_image' && url.origin === profile.origin && !url.username && !url.password && !url.hash && !url.search &&
    typeof filePath === 'string' && /^\/tmp\/gradio\/[a-f0-9]+\/[a-f0-9]+\.mp4$/i.test(filePath) &&
    url.pathname === '/call/gen/file=' + filePath) {
    url = new URL('/file=' + filePath, profile.origin);
  }
  const cachedFile = url.pathname.startsWith(`${profile.prefix}/file=/tmp/gradio/`);
  const animateExport = profile.api === 'generate_image' && /^\/file=\/tmp\/[a-f0-9]{32}\.mp4$/i.test(url.pathname);
  if (url.origin !== profile.origin || url.username || url.password || url.hash || url.search ||
    !(cachedFile || animateExport) || !/\.(mp4|webm)$/i.test(url.pathname)) {
    throw failure('The free GPU returned a video outside the verified Space file endpoint.');
  }
  return url.href;
}

class FreeProvider {
  constructor(options = {}) {
    if (Object.keys(options).some(key => !['fetchImpl', 'timeoutMs', 'videoPreset'].includes(key))) {
      throw failure('This free provider does not accept credentials, paid tokens or custom request headers.');
    }
    const { fetchImpl = globalThis.fetch, timeoutMs = 10 * 60 * 1000, videoPreset = 'detail' } = options;
    if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60 * 1000) throw new TypeError('Choose a bounded GPU request timeout.');
    if (!['detail', 'film'].includes(videoPreset)) throw new TypeError('Choose the reviewed detail or film video preset.');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.videoPreset = videoPreset;
  }

  async _fetch(address, { method = 'GET', body, stream = false } = {}) {
    const url = new URL(address);
    if (url.username || url.password || url.search || url.hash || !Object.values(PROFILES).some(profile => url.origin === profile.origin &&
      (url.pathname === `${profile.prefix}/info` || url.pathname === `${profile.prefix}/call/${profile.api}` ||
        new RegExp(`^${profile.prefix}/call/${profile.api}/[a-zA-Z0-9_-]{1,128}$`).test(url.pathname)))) {
      throw failure('Only the verified public free GPU endpoint can be used.');
    }
    let response;
    try {
      response = await this.fetchImpl(url.href, { method, redirect: 'error', credentials: 'omit',
        headers: { Accept: stream ? 'text/event-stream' : 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(stream ? this.timeoutMs : Math.min(this.timeoutMs, 30000)) });
    } catch {
      throw failure('The free GPU service could not be reached. The saved request must be checked before retrying.', { transportFailure: true });
    }
    if (!response.ok) {
      let detail = '';
      try { detail = (await response.text()).slice(0, 700); } catch { /* The status remains actionable. */ }
      throw failure(quotaMessage(`HTTP ${response.status}. ${detail}`), { httpStatus: response.status });
    }
    return response;
  }

  async _json(response) {
    let text;
    try { text = await response.text(); } catch { throw failure('The free GPU response was interrupted.'); }
    if (text.length > 1024 * 1024) throw failure('The free GPU returned an oversized API response.');
    try { return JSON.parse(text); } catch { throw failure('The free GPU returned an unreadable API response.'); }
  }

  async submit(modelId, prompt) {
    const model = FREE_MODELS.find(entry => entry.id === modelId);
    if (model?.available === false) throw failure(model.reason || 'This free model is unavailable.', { submissionUncertain: false });
    const profile = Object.hasOwn(PROFILES, modelId) ? PROFILES[modelId] : null;
    if (!profile) throw failure(FREE_MODELS.find(model => model.id === modelId)?.reason || 'Choose a verified available free model.', { submissionUncertain: false });
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.trim().length > 10000) throw failure('Enter a prompt between 1 and 10,000 characters.', { submissionUncertain: false });
    const duration = requestedDuration(modelId, prompt);
    try {
      // A schema change must not silently redirect a user's prompt into another
      // function, a paid API, an image workflow or a differently ordered input.
      const info = await this._json(await this._fetch(`${profile.origin}${profile.prefix}/info`));
      const endpoint = info.named_endpoints?.[`/${profile.api}`];
      if (!endpoint || endpoint.show_api === false || endpoint.returns?.[0]?.component !== 'Video' ||
        !Array.isArray(endpoint.parameters) || endpoint.parameters.length !== profile.parameters.length ||
        endpoint.parameters.some((parameter, index) => parameter.parameter_name !== profile.parameters[index])) {
        throw failure('The free Space API changed or is unavailable. Video generation is paused until its schema is reviewed.');
      }
    } catch (error) { error.submissionUncertain = false; throw error; }
    try {
      const response = await this._fetch(`${profile.origin}${profile.prefix}/call/${profile.api}`, { method: 'POST',
        body: { data: profile.input(prompt.trim(), duration, this.videoPreset) } });
      const result = await this._json(response);
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(result.event_id || '')) throw failure('The free GPU did not acknowledge a usable request ID.');
      return { requestId: result.event_id, provider: 'hf-zerogpu', eventUrl: eventUrl(profile, result.event_id), ...(modelId === 'ltx-free' ? {} : { modelId }) };
    } catch (error) {
      // No automatic retries: acknowledgement loss can still consume the shared
      // quota or create another video if the original request was accepted.
      error.submissionUncertain = !(error.httpStatus >= 400 && error.httpStatus < 500 && error.httpStatus !== 408);
      throw error;
    }
  }

  async poll(remote) {
    const profile = validateRemote(remote);
    const response = await this._fetch(remote.eventUrl, { stream: true });
    if (!response.body) throw failure('The free GPU returned no event stream.');
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('text/event-stream')) {
      await response.body.cancel();
      throw failure('The free GPU returned an unsupported queue response.');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '', received = 0;
    const deadline = Date.now() + this.timeoutMs;
    try {
      while (true) {
        let timer, packet;
        try {
          packet = await Promise.race([reader.read(), new Promise((_, reject) => {
            timer = setTimeout(() => reject(failure('The free GPU queue timed out. Your saved request must be checked before submitting again.')), Math.max(1, deadline - Date.now()));
          })]);
        } finally { clearTimeout(timer); }
        const { done, value } = packet;
        if (done) throw failure('The free GPU event stream ended before a video was returned. Resume this saved request before submitting again.');
        received += value.byteLength;
        if (received > 2 * 1024 * 1024) throw failure('The free GPU event stream exceeded its response limit.');
        pending = (pending + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
        let separator;
        while ((separator = pending.indexOf('\n\n')) >= 0) {
          const event = pending.slice(0, separator); pending = pending.slice(separator + 2);
          const kind = event.split('\n').find(line => line.startsWith('event:'))?.slice(6).trim();
          const payload = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (!kind || kind === 'heartbeat' || kind === 'generating') continue;
          let data;
          try { data = JSON.parse(payload); } catch { throw failure('The free GPU returned malformed event data.'); }
          if (kind === 'error') return { status: 'failed', error: quotaMessage(data), pauseQueue: true };
          if (kind !== 'complete') throw failure('The free GPU returned an unknown queue event.');
          const file = profile.output === 'file' ? data?.[0] : data?.[0]?.video;
          if (!Array.isArray(data) || !file?.url) throw failure('The free GPU reports completion but returned no video.');
          return { status: 'completed', videoUrl: videoUrl(file.url, profile, file.path) };
        }
        if (pending.length > 256 * 1024) throw failure('The free GPU event exceeded its message limit.');
      }
    } catch (error) {
      if (error?.name === 'FreeProviderError') throw error;
      throw failure('Monitoring the free GPU was interrupted. Your request ID is saved; do not submit it again automatically.');
    } finally {
      try { await reader.cancel(); } catch { /* The underlying request may already have ended. */ }
      reader.releaseLock();
    }
  }

  async cancel(remote) {
    validateRemote(remote);
    throw failure('This public free GPU API has no verified cancellation endpoint. The video may still finish and consume free quota; cancellation cannot be confirmed.');
  }
}

module.exports = { FREE_MODELS, FreeProvider, FREE_SPACE_ORIGIN, FREE_SPACE_ORIGINS, parsePromptDuration, createVideoPlan };
