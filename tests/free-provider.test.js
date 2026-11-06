'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FreeProvider, FREE_MODELS, FREE_SPACE_ORIGIN: ORIGIN } = require('../src/core/free-provider');

const names = ['prompt', 'negative_prompt', 'input_image_filepath', 'input_video_filepath', 'height_ui', 'width_ui', 'mode',
  'duration_ui', 'ui_frames_to_use', 'seed_ui', 'randomize_seed', 'ui_guidance_scale', 'improve_texture_flag'];
function schema() { return { named_endpoints: { '/text_to_video': { show_api: true,
  parameters: names.map(parameter_name => ({ parameter_name })), returns: [{ component: 'Video' }, { component: 'Number' }] } } }; }
function remote(id = 'event-123') { return { requestId: id, provider: 'hf-zerogpu', eventUrl: `${ORIGIN}/gradio_api/call/text_to_video/${id}` }; }
function json(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }); }
function events(text) { return new Response(text, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } }); }
function complete(url = `${ORIGIN}/gradio_api/file=/tmp/gradio/a7b9/video.mp4`) {
  return `event: complete\ndata: ${JSON.stringify([{ video: { path: '/tmp/gradio/a7b9/video.mp4', url, meta: { _type: 'gradio.FileData' } }, subtitles: null }, 42])}\n\n`;
}

test('free model catalog identifies the actual shared-GPU LTX version', () => {
  assert.equal(FREE_MODELS.length, 1);
  assert.equal(FREE_MODELS[0].id, 'ltx-free');
  assert.equal(FREE_MODELS[0].provider, 'huggingface');
  assert.match(FREE_MODELS[0].name, /0\.9\.8/);
  assert.equal(FREE_MODELS[0].available, true);
});

test('preflight verifies API schema before a single anonymous prompt submission', async () => {
  const calls = [];
  const provider = new FreeProvider({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? json(schema()) : json({ event_id: 'event-123' });
  } });
  assert.deepEqual(await provider.submit('ltx-free', '  A small sailing boat on a calm lake  '), remote());
  assert.deepEqual(calls.map(call => [call.url, call.options.method]), [[`${ORIGIN}/gradio_api/info`, 'GET'], [`${ORIGIN}/gradio_api/call/text_to_video`, 'POST']]);
  const input = JSON.parse(calls[1].options.body).data;
  assert.equal(input.length, 13);
  assert.equal(input[0], 'A small sailing boat on a calm lake');
  assert.deepEqual(input.slice(2), [null, null, 512, 704, 'text-to-video', 2, 9, 42, true, 1, false]);
  for (const { options } of calls) {
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.ok(Object.keys(options.headers).every(header => !/authorization|cookie|token|key/i.test(header)));
  }
});

test('credential or custom-address options cannot turn this into an authenticated or paid provider', () => {
  for (const option of ['apiKey', 'hfToken', 'token', 'Authorization', 'Cookie', 'headers', 'origin', 'url']) {
    assert.throws(() => new FreeProvider({ [option]: 'must-not-be-used' }), /does not accept/);
  }
});

test('a changed schema blocks generation before any POST', async () => {
  const changed = schema(); changed.named_endpoints['/text_to_video'].parameters.reverse();
  let calls = 0;
  const provider = new FreeProvider({ fetchImpl: async () => { calls++; return json(changed); } });
  await assert.rejects(provider.submit('ltx-free', 'A lake'), error => error.pauseQueue === true && error.submissionUncertain === false && /schema/.test(error.message));
  assert.equal(calls, 1);
});

test('invalid model IDs and empty prompts never reach a network endpoint', async () => {
  let calls = 0;
  const provider = new FreeProvider({ fetchImpl: async () => { calls++; } });
  await assert.rejects(provider.submit('wan', 'A lake'));
  await assert.rejects(provider.submit('ltx-free', '   '));
  await assert.rejects(provider.submit('ltx-free', 'x'.repeat(10001)));
  assert.equal(calls, 0);
});

test('SSE heartbeats and generating events lead to the actual returned VideoData URL', async () => {
  const text = 'event: heartbeat\ndata: null\n\nevent: generating\ndata: null\n\n' + complete();
  const provider = new FreeProvider({ fetchImpl: async (url, options) => {
    assert.equal(url, remote().eventUrl); assert.equal(options.headers.Accept, 'text/event-stream');
    return events(text);
  } });
  assert.deepEqual(await provider.poll(remote()), { status: 'completed', videoUrl: `${ORIGIN}/gradio_api/file=/tmp/gradio/a7b9/video.mp4` });
});

test('SSE frames can span arbitrary chunks and CRLF boundaries', async () => {
  const encoded = new TextEncoder().encode(complete().replace(/\n/g, '\r\n'));
  const stream = new ReadableStream({ start(controller) { for (const byte of encoded) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
  const provider = new FreeProvider({ fetchImpl: async () => new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }) });
  assert.equal((await provider.poll(remote())).status, 'completed');
});

test('quota errors stop the queue and do not request a paid or alternate endpoint', async () => {
  let calls = 0;
  const provider = new FreeProvider({ fetchImpl: async url => {
    calls++; assert.equal(url, remote().eventUrl);
    return events('event: error\ndata: "You have exceeded your GPU quota. Try again in 23:59:00"\n\n');
  } });
  const result = await provider.poll(remote());
  assert.equal(result.status, 'failed'); assert.equal(result.pauseQueue, true); assert.match(result.error, /quota/);
  assert.equal(calls, 1);
});

test('HTTP quota or service errors pause instead of retrying submissions', async () => {
  for (const status of [429, 503]) {
    let calls = 0;
    const provider = new FreeProvider({ fetchImpl: async () => { calls++; return json({ error: 'unavailable' }, status); } });
    await assert.rejects(provider.submit('ltx-free', 'A lake'), error => error.pauseQueue && error.httpStatus === status && error.submissionUncertain === false);
    assert.equal(calls, 1);
  }
});

test('lost POST acknowledgement is uncertain and is never automatically resubmitted', async () => {
  let calls = 0;
  const provider = new FreeProvider({ fetchImpl: async () => { calls++; if (calls === 1) return json(schema()); throw new Error('connection lost'); } });
  await assert.rejects(provider.submit('ltx-free', 'A lake'), error => error.pauseQueue && error.submissionUncertain === true);
  assert.equal(calls, 2);
});

test('saved requests cannot redirect the provider to other hosts, paths, credentials or IDs', async () => {
  let calls = 0;
  const provider = new FreeProvider({ fetchImpl: async () => { calls++; } });
  for (const record of [remote('../escape'), { ...remote(), provider: 'fal' }, { ...remote(), eventUrl: 'https://fal.ai/paid' },
    { ...remote(), eventUrl: `${remote().eventUrl}?token=secret` }, { ...remote(), eventUrl: `${ORIGIN}/gradio_api/call/another/event-123` }]) {
    await assert.rejects(provider.poll(record));
  }
  assert.equal(calls, 0);
});

test('untrusted or absent video results are rejected without fabricating a media URL', async () => {
  for (const output of [complete('https://localhost/secret.mp4'), complete('https://other.hf.space/gradio_api/file=/tmp/gradio/a/video.mp4'),
    complete(`${ORIGIN}/private.mp4`), 'event: complete\ndata: [null,42]\n\n', 'event: complete\ndata: broken-json\n\n']) {
    const provider = new FreeProvider({ fetchImpl: async () => events(output) });
    await assert.rejects(provider.poll(remote()), error => error.pauseQueue === true);
  }
});

test('SSE timeout, oversized response, premature ending and wrong content type stop safely', async () => {
  const neverEnds = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('event: heartbeat\ndata: null\n\n')); } });
  const timeout = new FreeProvider({ timeoutMs: 20, fetchImpl: async () => new Response(neverEnds, { headers: { 'Content-Type': 'text/event-stream' } }) });
  await assert.rejects(timeout.poll(remote()), /timed out/);
  const oversized = new FreeProvider({ fetchImpl: async () => events('x'.repeat(2 * 1024 * 1024 + 1)) });
  await assert.rejects(oversized.poll(remote()), /response limit/);
  const truncated = new FreeProvider({ fetchImpl: async () => events('event: heartbeat\ndata: null\n\n') });
  await assert.rejects(truncated.poll(remote()), /ended before/);
  const html = new FreeProvider({ fetchImpl: async () => new Response('<html>temporarily unavailable</html>', { headers: { 'Content-Type': 'text/html' } }) });
  await assert.rejects(html.poll(remote()), /unsupported queue response/);
});

test('unsupported cancellation is explicit and never falsely reported as confirmed', async () => {
  let calls = 0;
  const provider = new FreeProvider({ fetchImpl: async () => { calls++; } });
  await assert.rejects(provider.cancel(remote()), /no verified cancellation/);
  assert.equal(calls, 0);
});
