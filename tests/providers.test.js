'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MODELS, FalProvider, validateVideoUrl, validateRemote } = require('../src/core/providers');

const KEY = 'test-key-never-a-real-credential';
const REQUEST = '12345678-abcd-1234-abcd-123456789abc';
function remote(endpoint = 'fal-ai/wan-t2v') {
  const base = `https://queue.fal.run/${endpoint.split('/').slice(0, 2).join('/')}/requests/${REQUEST}`;
  return { requestId: REQUEST, responseUrl: base, statusUrl: `${base}/status`, cancelUrl: `${base}/cancel` };
}
function submitted(endpoint) {
  const r = remote(endpoint);
  return { request_id: r.requestId, response_url: r.responseUrl, status_url: r.statusUrl, cancel_url: r.cancelUrl };
}
function scripted(responses) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const item = responses.shift();
    assert.ok(item, 'unexpected HTTP request');
    if (item.error) throw item.error;
    return new Response(typeof item.body === 'string' ? item.body : JSON.stringify(item.body), { status: item.status || 200 });
  };
  return { calls, fetchImpl };
}

test('each catalog model uses its documented endpoint and prompt-only request schema', async () => {
  assert.deepEqual(MODELS.map(model => model.id), ['wan', 'ltx', 'cogvideo', 'hunyuan', 'animatediff']);
  for (const model of MODELS) {
    assert.equal(model.available, true);
    const network = scripted([{ body: submitted(model.endpoint) }]);
    const provider = new FalProvider({ apiKey: KEY, fetchImpl: network.fetchImpl });
    const result = await provider.submit(model.id, '  A river at sunrise  ');
    assert.deepEqual(result, remote(model.endpoint));
    assert.equal(network.calls[0].url, `https://queue.fal.run/${model.endpoint}`);
    assert.equal(network.calls[0].options.method, 'POST');
    assert.equal(network.calls[0].options.redirect, 'error');
    assert.equal(network.calls[0].options.headers.Authorization, `Key ${KEY}`);
    assert.deepEqual(JSON.parse(network.calls[0].options.body), { ...model.defaults, prompt: 'A river at sunrise' });
    assert.equal(JSON.parse(network.calls[0].options.body).enable_safety_checker, true);
  }
});

test('polls queue lifecycle and fetches the actual result only when complete', async () => {
  const network = scripted([
    { body: { status: 'IN_QUEUE', queue_position: 4 } },
    { body: { status: 'IN_PROGRESS' } },
    { body: { status: 'COMPLETED' } },
    { body: { video: { url: 'https://v3.fal.media/files/verified-video.mp4' } } },
  ]);
  const provider = new FalProvider({ apiKey: KEY, fetchImpl: network.fetchImpl });
  assert.deepEqual(await provider.poll(remote()), { status: 'queued', queuePosition: 4 });
  assert.deepEqual(await provider.poll(remote()), { status: 'running' });
  assert.deepEqual(await provider.poll(remote()), { status: 'completed', videoUrl: 'https://v3.fal.media/files/verified-video.mp4' });
  assert.deepEqual(network.calls.map(call => call.url), [remote().statusUrl, remote().statusUrl, remote().statusUrl, remote().responseUrl]);
  assert.ok(network.calls.every(call => new URL(call.url).hostname === 'queue.fal.run'));
});

test('terminal queue errors do not fabricate a video or fetch a result', async () => {
  const network = scripted([{ body: { status: 'COMPLETED', error: 'Invalid input' } }]);
  const provider = new FalProvider({ apiKey: KEY, fetchImpl: network.fetchImpl });
  assert.deepEqual(await provider.poll(remote()), { status: 'failed', error: 'Invalid input' });
  assert.equal(network.calls.length, 1);
});

test('missing, malformed, private, and unrelated media URLs are rejected', () => {
  for (const value of [undefined, '', 'file:///C:/secret', 'http://v3.fal.media/x.mp4', 'https://localhost/x', 'https://127.0.0.1/x', 'https://fal.media.evil.test/x', 'https://evil.test/x', 'https://key@fal.media/x', 'https://fal.media:8443/x']) {
    assert.throws(() => validateVideoUrl(value));
  }
  assert.equal(validateVideoUrl('https://fal-cdn.batuhan-941.workers.dev/files/video.mp4'), 'https://fal-cdn.batuhan-941.workers.dev/files/video.mp4');
});

test('provider credential cannot be redirected or sent to an untrusted saved queue URL', async () => {
  const network = scripted([]);
  const provider = new FalProvider({ apiKey: KEY, fetchImpl: network.fetchImpl });
  for (const url of ['https://evil.test/status', 'http://queue.fal.run/x', 'https://queue.fal.run.evil.test/x', `https://queue.fal.run/fal-ai/wan-t2v/requests/other/status`, `${remote().statusUrl}?redirect=evil`, `https://queue.fal.run/unknown/model/requests/${REQUEST}/status`]) {
    await assert.rejects(provider.poll({ ...remote(), statusUrl: url }));
  }
  assert.equal(network.calls.length, 0);
  assert.throws(() => validateRemote({ ...remote(), requestId: '../secret' }));
});

test('submit acknowledgement loss is explicitly uncertain, never silently retried', async () => {
  for (const response of [{ error: new Error('connection dropped') }, { body: '{broken' }, { body: {}, status: 503 }, { body: { request_id: REQUEST, ...submitted('fal-ai/wan-t2v'), response_url: 'https://evil.test/result' } }]) {
    const network = scripted([response]);
    const provider = new FalProvider({ apiKey: KEY, fetchImpl: network.fetchImpl });
    await assert.rejects(provider.submit('wan', 'A river'), error => error.submissionUncertain === true);
    assert.equal(network.calls.length, 1);
  }
});

test('rejected credentials are actionable and do not imply a successful submission', async () => {
  const network = scripted([{ status: 401, body: { detail: `Bad credential ${KEY}` } }]);
  const provider = new FalProvider({ apiKey: KEY, fetchImpl: network.fetchImpl });
  await assert.rejects(provider.submit('wan', 'A river'), error => {
    assert.equal(error.httpStatus, 401);
    assert.equal(error.submissionUncertain, undefined);
    assert.equal(error.retryable, false);
    assert.ok(!error.message.includes(KEY));
    return /API key/.test(error.message);
  });
});

test('HTTP429 and transport polling failures can be resumed without a new submission', async () => {
  const network = scripted([{ status: 429, body: { detail: 'Rate limit exceeded' } }, { error: new Error('timeout') }]);
  const provider = new FalProvider({ apiKey: KEY, fetchImpl: network.fetchImpl });
  await assert.rejects(provider.poll(remote()), error => error.retryable && error.httpStatus === 429);
  await assert.rejects(provider.poll(remote()), error => error.retryable && !error.submissionUncertain);
  assert.ok(network.calls.every(call => call.options.method === 'GET'));
});

test('cancellation distinguishes confirmed removal, requested stop, and an already finished job', async () => {
  const network = scripted([
    { status: 200, body: { status: 'OK' } },
    { status: 202, body: { status: 'CANCELLATION_REQUESTED' } },
    { status: 400, body: { status: 'ALREADY_COMPLETED' } },
  ]);
  const provider = new FalProvider({ apiKey: KEY, fetchImpl: network.fetchImpl });
  assert.deepEqual(await provider.cancel(remote()), { cancelled: true, status: 'cancelled' });
  assert.deepEqual(await provider.cancel(remote()), { cancelled: false, status: 'requested' });
  assert.deepEqual(await provider.cancel(remote()), { cancelled: false, status: 'completed' });
  assert.ok(network.calls.every(call => call.options.method === 'PUT'));
});

test('unknown models and blank prompts never reach the network', async () => {
  const network = scripted([]);
  const provider = new FalProvider({ apiKey: KEY, fetchImpl: network.fetchImpl });
  await assert.rejects(provider.submit('imaginary', 'test'));
  await assert.rejects(provider.submit('wan', '  '));
  await assert.rejects(provider.submit('wan', 'x'.repeat(10001)));
  assert.equal(network.calls.length, 0);
});
