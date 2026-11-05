'use strict';

// Endpoint IDs and schemas were checked against the linked official API pages.
// Catalog availability is documentation-based; it is not a promise of account access.
const MODELS = Object.freeze([
  { id: 'wan', name: 'Wan 2.1', provider: 'fal', endpoint: 'fal-ai/wan-t2v', available: true,
    description: 'Text to video · 720p · about 5 seconds',
    docsUrl: 'https://fal.ai/models/fal-ai/wan-t2v/api', defaults: { enable_safety_checker: true } },
  { id: 'ltx', name: 'LTX 2.3 Fast', provider: 'fal', endpoint: 'fal-ai/ltx-2.3/text-to-video/fast', available: true,
    description: 'Text to video · 1080p · 6 seconds · audio off',
    docsUrl: 'https://fal.ai/models/fal-ai/ltx-2.3/text-to-video/fast/api',
    defaults: { duration: 6, resolution: '1080p', fps: 25, generate_audio: false, enable_safety_checker: true } },
  { id: 'cogvideo', name: 'CogVideoX-5B', provider: 'fal', endpoint: 'fal-ai/cogvideox-5b', available: true,
    description: 'Text to video · model defaults',
    docsUrl: 'https://fal.ai/models/fal-ai/cogvideox-5b/api', defaults: { enable_safety_checker: true } },
  { id: 'hunyuan', name: 'Hunyuan Video', provider: 'fal', endpoint: 'fal-ai/hunyuan-video', available: true,
    description: 'Text to video · 720p · standard mode',
    docsUrl: 'https://fal.ai/models/fal-ai/hunyuan-video/api',
    defaults: { pro_mode: false, enable_safety_checker: true } },
  { id: 'animatediff', name: 'AnimateDiff', provider: 'fal', endpoint: 'fal-ai/fast-animatediff/text-to-video', available: true,
    description: 'Text to video · short animation · 16 frames',
    docsUrl: 'https://fal.ai/models/fal-ai/fast-animatediff/text-to-video/api', defaults: { enable_safety_checker: true } },
].map(model => Object.freeze({ ...model, defaults: Object.freeze(model.defaults) })));

function providerError(message, properties = {}) {
  return Object.assign(new Error(message), { name: 'ProviderError', retryable: false, ...properties });
}

function queueUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw providerError('The provider returned an invalid queue address.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'queue.fal.run' || url.port || url.username || url.password || url.hash) {
    throw providerError('The provider queue address is not trusted.');
  }
  return url;
}

function validateRemote(remote) {
  if (!remote || !/^[a-zA-Z0-9_-]{1,160}$/.test(remote.requestId || '')) {
    throw providerError('The saved provider request ID is invalid.');
  }
  let base;
  for (const [field, suffix] of [['responseUrl', ''], ['statusUrl', '/status'], ['cancelUrl', '/cancel']]) {
    const url = queueUrl(remote[field]);
    if (url.search || !url.pathname.endsWith(`/requests/${remote.requestId}${suffix}`)) {
      throw providerError('The provider queue address does not match its request ID.');
    }
    const expected = url.pathname.slice(0, url.pathname.length - suffix.length);
    if (base && base !== expected) throw providerError('The provider returned inconsistent queue addresses.');
    base = expected;
    if (!MODELS.some(model => expected === `/${model.endpoint.split('/').slice(0, 2).join('/')}/requests/${remote.requestId}`)) {
      throw providerError('The provider queue address does not match a supported model.');
    }
  }
  return remote;
}

function validateVideoUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw providerError('The provider did not return a usable video URL.'); }
  // Output addresses are never fetched with the provider credential. Restrict to
  // documented fal CDNs rather than allowing an API response to reach the LAN.
  const isFalMedia = url.hostname === 'fal.media' || url.hostname.endsWith('.fal.media');
  const isLegacyFalCdn = url.hostname === 'fal-cdn.batuhan-941.workers.dev';
  if (url.protocol !== 'https:' || url.port || url.username || url.password || (!isFalMedia && !isLegacyFalCdn)) {
    throw providerError('The provider returned a video address outside its documented media CDN.');
  }
  return url.href;
}

class FalProvider {
  constructor({ apiKey, fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
    if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 4096 || /[\r\n]/.test(apiKey)) {
      throw providerError('Add your fal API key in Settings before starting the queue.');
    }
    if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
    this.apiKey = apiKey.trim();
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  _message(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value || 'Unknown provider error');
    return text.split(this.apiKey).join('[redacted]').slice(0, 600);
  }

  async _request(address, { method = 'GET', body, allowCancelResponse = false } = {}) {
    const url = queueUrl(address);
    let response;
    try {
      response = await this.fetchImpl(url.href, {
        method, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { Authorization: `Key ${this.apiKey}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw providerError(`Could not reach fal: ${this._message(error.message)}. Check your connection before resuming.`, { retryable: true, transportFailure: true });
    }
    let data;
    try {
      const raw = await response.text();
      if (raw.length > 1024 * 1024) throw new Error('response too large');
      data = raw ? JSON.parse(raw) : {};
    } catch {
      throw providerError(`fal returned an unreadable response (HTTP ${response.status}).`, { httpStatus: response.status, responseInvalid: true });
    }
    if (!response.ok && !(allowCancelResponse && response.status === 400 && data.status === 'ALREADY_COMPLETED')) {
      let message = this._message(data.detail || data.error || data.message || `HTTP ${response.status}`);
      if (response.status === 401 || response.status === 403) message = 'Your fal API key was rejected or does not have access. Check Settings and your fal account.';
      if (response.status === 402) message = 'Your fal account needs credits. Check your account before resuming.';
      if (response.status === 404) message = 'The fal endpoint or saved request is unavailable. Check the provider dashboard.';
      throw providerError(`fal: ${message}`, { httpStatus: response.status, retryable: response.status === 429 || response.status >= 500 });
    }
    return { data, status: response.status };
  }

  async submit(modelId, prompt) {
    const model = MODELS.find(entry => entry.id === modelId);
    if (!model || !model.available) throw providerError(model?.reason || 'Choose a supported video model.');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 10000) throw providerError('Enter a prompt between 1 and 10,000 characters.');
    try {
      const { data } = await this._request(`https://queue.fal.run/${model.endpoint}`, {
        method: 'POST', body: { ...model.defaults, prompt: prompt.trim() },
      });
      return validateRemote({ requestId: data.request_id, statusUrl: data.status_url, responseUrl: data.response_url, cancelUrl: data.cancel_url });
    } catch (error) {
      // A lost submit acknowledgement may already have incurred a charge. The
      // queue must require manual reconciliation instead of submitting again.
      if (error.transportFailure || error.responseInvalid || !error.httpStatus || error.httpStatus >= 500) error.submissionUncertain = true;
      throw error;
    }
  }

  async poll(remote) {
    validateRemote(remote);
    const { data } = await this._request(remote.statusUrl);
    if (data.status === 'IN_QUEUE') return { status: 'queued', queuePosition: data.queue_position };
    if (data.status === 'IN_PROGRESS') return { status: 'running' };
    if (data.status === 'CANCELLED') return { status: 'cancelled' };
    if (data.status !== 'COMPLETED') throw providerError('fal returned an unrecognized queue status. Check the provider dashboard.');
    if (data.error) return { status: 'failed', error: this._message(data.error) };
    const { data: output } = await this._request(remote.responseUrl);
    if (output.error) return { status: 'failed', error: this._message(output.error) };
    return { status: 'completed', videoUrl: validateVideoUrl(output.video?.url) };
  }

  async cancel(remote) {
    validateRemote(remote);
    const { data, status } = await this._request(remote.cancelUrl, { method: 'PUT', allowCancelResponse: true });
    if (status === 200 && data.status === 'OK') return { cancelled: true, status: 'cancelled' };
    if (status === 202 && data.status === 'CANCELLATION_REQUESTED') return { cancelled: false, status: 'requested' };
    if (status === 400 && data.status === 'ALREADY_COMPLETED') return { cancelled: false, status: 'completed' };
    throw providerError('The provider did not confirm cancellation. The request may still finish and incur charges.');
  }
}

module.exports = { MODELS, FalProvider, validateVideoUrl, validateRemote };
