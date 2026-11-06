'use strict';

const FREE_SPACE_ORIGIN = 'https://lightricks-ltx-video-distilled.hf.space';
const CALL_PATH = '/gradio_api/call/text_to_video';
const INFO_PATH = '/gradio_api/info';
const PARAMETER_NAMES = Object.freeze(['prompt', 'negative_prompt', 'input_image_filepath', 'input_video_filepath',
  'height_ui', 'width_ui', 'mode', 'duration_ui', 'ui_frames_to_use', 'seed_ui', 'randomize_seed', 'ui_guidance_scale', 'improve_texture_flag']);
const FREE_MODELS = Object.freeze([Object.freeze({ id: 'ltx-free', name: 'LTX Video 0.9.8 — Free', provider: 'huggingface', available: true,
  description: '2 seconds · 512 × 704 · shared free GPU quota',
  endpoint: 'Lightricks/ltx-video-distilled', docsUrl: 'https://huggingface.co/spaces/Lightricks/ltx-video-distilled' })]);

function failure(message, properties = {}) {
  return Object.assign(new Error(message), { name: 'FreeProviderError', pauseQueue: true, retryable: false, ...properties });
}
function quotaMessage(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? 'The free GPU service returned no error details.');
  const shortened = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, 700);
  if (/quota|gpu.*(?:limit|exceed)|too many requests|rate.?limit/i.test(shortened)) {
    return `The free shared GPU quota is unavailable or exhausted. Your queue is paused; wait for the provider's quota reset before resuming. ${shortened}`;
  }
  return `The free community GPU could not finish this video. Your queue is paused. ${shortened}`;
}
function eventUrl(requestId) { return `${FREE_SPACE_ORIGIN}${CALL_PATH}/${requestId}`; }
function validateRemote(remote) {
  if (!remote || remote.provider !== 'hf-zerogpu' || !/^[a-zA-Z0-9_-]{1,128}$/.test(remote.requestId || '') || remote.eventUrl !== eventUrl(remote.requestId)) {
    throw failure('The saved free GPU request is invalid. No request was sent.');
  }
  return remote.eventUrl;
}
function videoUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw failure('The free GPU returned no usable video address.'); }
  if (url.origin !== FREE_SPACE_ORIGIN || url.username || url.password || url.hash || url.search ||
    !url.pathname.startsWith('/gradio_api/file=/tmp/gradio/') || !/\.(mp4|webm)$/i.test(url.pathname)) {
    throw failure('The free GPU returned a video outside the verified Space file endpoint.');
  }
  return url.href;
}

class FreeProvider {
  constructor(options = {}) {
    if (Object.keys(options).some(key => !['fetchImpl', 'timeoutMs'].includes(key))) {
      throw failure('This free provider does not accept credentials, paid tokens or custom request headers.');
    }
    const { fetchImpl = globalThis.fetch, timeoutMs = 10 * 60 * 1000 } = options;
    if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60 * 1000) throw new TypeError('Choose a bounded GPU request timeout.');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async _fetch(address, { method = 'GET', body, stream = false } = {}) {
    const url = new URL(address);
    if (url.origin !== FREE_SPACE_ORIGIN || url.username || url.password || url.search || url.hash ||
      !(url.pathname === INFO_PATH || url.pathname === CALL_PATH || url.pathname.startsWith(CALL_PATH + '/'))) {
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
    if (modelId !== 'ltx-free') throw failure('Only the verified free LTX model is available.', { submissionUncertain: false });
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.trim().length > 10000) throw failure('Enter a prompt between 1 and 10,000 characters.', { submissionUncertain: false });
    try {
      // A schema change must not silently redirect a user's prompt into another
      // function, a paid API, an image workflow or a differently ordered input.
      const info = await this._json(await this._fetch(`${FREE_SPACE_ORIGIN}${INFO_PATH}`));
      const endpoint = info.named_endpoints?.['/text_to_video'];
      if (!endpoint || endpoint.show_api !== true || endpoint.returns?.[0]?.component !== 'Video' ||
        !Array.isArray(endpoint.parameters) || endpoint.parameters.length !== PARAMETER_NAMES.length ||
        endpoint.parameters.some((parameter, index) => parameter.parameter_name !== PARAMETER_NAMES[index])) {
        throw failure('The free Space API changed or is unavailable. Video generation is paused until its schema is reviewed.');
      }
    } catch (error) { error.submissionUncertain = false; throw error; }
    try {
      const response = await this._fetch(`${FREE_SPACE_ORIGIN}${CALL_PATH}`, { method: 'POST',
        body: { data: [prompt.trim(), 'worst quality, inconsistent motion, blurry, jittery, distorted', null, null,
          512, 704, 'text-to-video', 2, 9, 42, true, 1, false] } });
      const result = await this._json(response);
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(result.event_id || '')) throw failure('The free GPU did not acknowledge a usable request ID.');
      return { requestId: result.event_id, provider: 'hf-zerogpu', eventUrl: eventUrl(result.event_id) };
    } catch (error) {
      // No automatic retries: acknowledgement loss can still consume the shared
      // quota or create another video if the original request was accepted.
      error.submissionUncertain = !(error.httpStatus >= 400 && error.httpStatus < 500 && error.httpStatus !== 408);
      throw error;
    }
  }

  async poll(remote) {
    const address = validateRemote(remote);
    const response = await this._fetch(address, { stream: true });
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
          if (!Array.isArray(data) || !data[0]?.video?.url) throw failure('The free GPU reports completion but returned no video.');
          return { status: 'completed', videoUrl: videoUrl(data[0].video.url) };
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

module.exports = { FREE_MODELS, FreeProvider, FREE_SPACE_ORIGIN };
