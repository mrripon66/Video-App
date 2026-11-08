'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FreeProvider, FREE_MODELS, FREE_SPACE_ORIGIN: ORIGIN, FREE_SPACE_ORIGINS, parsePromptDuration, createVideoPlan } = require('../src/core/free-provider');
const { PUBLIC_MODELS, MODELS } = require('../src/core/catalog');

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

test('catalog prioritizes current LTX and keeps quota-incompatible publisher demos disabled', () => {
  assert.deepEqual(FREE_MODELS.filter(model => model.available).map(model => model.id), ['ltx2-story-free', 'ltx2-free', 'animatediff-free', 'ltx-free']);
  assert.equal(FREE_MODELS[0].provider, 'huggingface');
  assert.match(FREE_MODELS[0].name, /2\.3/);
  assert.deepEqual(FREE_MODELS.filter(model => !model.available).map(model => model.limits.gpuSeconds), [90, 300, 240]);
  assert.equal(FREE_SPACE_ORIGINS.length, 4);
  assert.ok(FREE_MODELS.every(model => model.provider === 'huggingface'));
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
  assert.equal(result.quotaBlocked, true);
  assert.equal(result.retryAfterMs, 86_340_000);
  assert.equal(calls, 1);
});

test('only a confirmed terminal GPU quota error is eligible for automatic resubmission', async () => {
  for (const message of [null, 'Failed while checking GPU quota', 'The provider crashed. Try again in 00:02:00']) {
    const provider = new FreeProvider({ fetchImpl: async () => events(`event: error\ndata: ${JSON.stringify(message)}\n\n`) });
    const result = await provider.poll(remote());
    assert.equal(result.status, 'failed');
    assert.notEqual(result.quotaBlocked, true);
    assert.equal(result.retryAfterMs, undefined);
  }
});

test('a rejected POST preserves Retry-After without treating an accepted poll as a rejection', async () => {
  let calls = 0;
  const limited = () => new Response('Too many requests', { status: 429, headers: { 'Retry-After': '120' } });
  const provider = new FreeProvider({ fetchImpl: async () => ++calls === 1 ? json(schema()) : limited() });
  await assert.rejects(provider.submit('ltx-free', 'A lake'), error => error.httpStatus === 429 && error.submissionUncertain === false && error.retryAfterMs === 120_000);
  await assert.rejects(provider.poll(remote()), error => error.httpStatus === 429 && error.submissionUncertain === undefined && error.retryAfterMs === 120_000);
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

const newProfiles = [
  { id: 'ltx2-free', origin: 'https://lightricks-ltx-2-3.hf.space', prefix: '/gradio_api', api: 'generate_video',
    parameters: ['input_image', 'prompt', 'duration', 'enhance_prompt', 'seed', 'randomize_seed', 'height', 'width'],
    input: [null, 'A lake at dawn', 3, false, 42, false, 1024, 1536], directFile: true },
  { id: 'wan-free', origin: 'https://kingnish-wan2-2-fast.hf.space', prefix: '/gradio_api', api: 'generate_video',
    parameters: ['input_image', 'prompt', 'height', 'width', 'negative_prompt', 'duration_seconds', 'guidance_scale', 'steps', 'seed', 'randomize_seed'],
    input: [null, 'A lake at dawn', 896, 896, 'blurry, distorted, low quality, static, watermark', 5, 0, 8, 42, false], directFile: false },
  { id: 'animatediff-free', origin: 'https://bytedance-animatediff-lightning.hf.space', prefix: '', api: 'generate_image',
    parameters: ['prompt', 'base', 'motion', 'step'], input: ['A lake at dawn', 'epiCRealism', '', 8], directFile: false },
];

test('new publisher profiles use exact schema, quality preset and Gradio version-specific routes', async () => {
  for (const profile of newProfiles.filter(profile => profile.id !== 'wan-free')) {
    const calls = [];
    const liveSchemaShape = { named_endpoints: { [`/${profile.api}`]: { parameters: profile.parameters.map(parameter_name => ({ parameter_name })), returns: [{ component: 'Video' }] } } };
    const provider = new FreeProvider({ fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return calls.length === 1 ? json(liveSchemaShape) : json({ event_id: 'new-event' });
    } });
    const saved = await provider.submit(profile.id, 'A lake at dawn');
    assert.deepEqual(calls.map(call => call.url), [`${profile.origin}${profile.prefix}/info`, `${profile.origin}${profile.prefix}/call/${profile.api}`]);
    assert.deepEqual(JSON.parse(calls[1].options.body).data, profile.input);
    assert.deepEqual(saved, { requestId: 'new-event', provider: 'hf-zerogpu', modelId: profile.id,
      eventUrl: `${profile.origin}${profile.prefix}/call/${profile.api}/new-event` });
    for (const { options } of calls) {
      assert.equal(options.credentials, 'omit');
      assert.ok(Object.keys(options.headers).every(header => !/authorization|cookie|token|key/i.test(header)));
    }
  }
});

test('LTX2 direct FileData and AnimateDiff nested VideoData both produce only their own actual media URL', async () => {
  for (const profile of newProfiles) {
    const url = `${profile.origin}${profile.prefix}/file=/tmp/gradio/abcd/output.mp4`;
    const file = { path: '/tmp/gradio/abcd/output.mp4', url, meta: { _type: 'gradio.FileData' } };
    const data = profile.directFile ? [file, 42] : [{ video: file, subtitles: null }];
    const provider = new FreeProvider({ fetchImpl: async () => events(`event: complete\ndata: ${JSON.stringify(data)}\n\n`) });
    const saved = { requestId: 'new-event', provider: 'hf-zerogpu', modelId: profile.id, eventUrl: `${profile.origin}${profile.prefix}/call/${profile.api}/new-event` };
    assert.deepEqual(await provider.poll(saved), { status: 'completed', videoUrl: url });
    const hostile = new FreeProvider({ fetchImpl: async () => events(complete()) });
    await assert.rejects(hostile.poll(saved), /outside|no video/);
  }
});

test('old saved handles remain readable while missing or mismatched new model identifiers fail safely', async () => {
  const legacy = new FreeProvider({ fetchImpl: async () => events(complete()) });
  assert.equal((await legacy.poll(remote())).status, 'completed');
  assert.equal((await legacy.poll({ ...remote(), modelId: 'ltx-free' })).status, 'completed');
  let calls = 0;
  const blocked = new FreeProvider({ fetchImpl: async () => { calls++; } });
  for (const profile of newProfiles) {
    await assert.rejects(blocked.poll({ requestId: 'new-event', provider: 'hf-zerogpu', eventUrl: `${profile.origin}${profile.prefix}/call/${profile.api}/new-event` }));
    await assert.rejects(blocked.poll({ ...remote(), modelId: profile.id }));
  }
  for (const modelId of ['cogvideo-free', 'cogvideo2-free', '__proto__', 'constructor']) await assert.rejects(blocked.submit(modelId, 'A lake'));
  assert.equal(calls, 0);
});

test('a hidden or reordered new publisher endpoint is blocked before inference', async () => {
  for (const profile of newProfiles.filter(profile => profile.id !== 'wan-free')) {
    for (const hidden of [true, false]) {
      const parameters = profile.parameters.map(parameter_name => ({ parameter_name }));
      if (!hidden) parameters.reverse();
      let calls = 0;
      const provider = new FreeProvider({ fetchImpl: async () => { calls++; return json({ named_endpoints: { [`/${profile.api}`]: {
        parameters, returns: [{ component: 'Video' }], ...(hidden ? { show_api: false } : {}) } } }); } });
      await assert.rejects(provider.submit(profile.id, 'A lake'), error => error.submissionUncertain === false && error.pauseQueue);
      assert.equal(calls, 1);
    }
  }
});

test('explicit prompt durations parse numeric seconds without matching unrelated words', () => {
  for (const [prompt, expected] of [['A 15-second film', 15], ['Create 5 seconds of ocean waves', 5], ['A 3.5 sec clip', 3.5],
    ['A 1.6s animation', 1.6], ['A 10–second shot', 10], ['A -5-second clip', -5], ['A cosine wave and seconds of silence', null],
    ['An ISO 1536x1024 image with 50fps motion', null]]) assert.equal(parsePromptDuration(prompt), expected);
});

test('decade notation is ignored in favor of a real clip duration', async () => {
  for (const prompt of ['A 1930s city scene.', 'A 1960s documentary style.', 'A 2010s music video.', 'An era spanning the 1930s-1960s.']) {
    assert.equal(parsePromptDuration(prompt), null);
  }
  assert.equal(parsePromptDuration('A 1930s noir scene, 1960s film grain, lasting 3 seconds.'), 3);
  assert.equal(parsePromptDuration('1930s-inspired 2010s cinema: a 3-second shot.'), 3);
  assert.equal(parsePromptDuration('A 3s shot set in the 1960s.'), 3);
  for (const prompt of ['A 1930-second clip.', 'A 1930 seconds film.', 'A 1930 s shot.']) assert.equal(parsePromptDuration(prompt), 1930);
  const profile = newProfiles[0], calls = [], prompt = 'A 1930s noir film with 1960s grain and 2010s color, a 3-second shot.';
  const provider = new FreeProvider({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? json({ named_endpoints: { '/generate_video': { parameters: profile.parameters.map(parameter_name => ({ parameter_name })), returns: [{ component: 'Video' }] } } }) : json({ event_id: 'decades-three-sec' });
  } });
  await provider.submit('ltx2-free', prompt);
  const data = JSON.parse(calls[1].options.body).data;
  assert.equal(data[1], prompt); assert.equal(data[2], 3);
});

test('LTX2 passes a requested five-second duration while keeping the complete prompt unchanged', async () => {
  const profile = newProfiles[0], calls = [], prompt = 'Create a 5-second cinematic shot of a quiet lake.';
  const provider = new FreeProvider({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? json({ named_endpoints: { '/generate_video': { parameters: profile.parameters.map(parameter_name => ({ parameter_name })), returns: [{ component: 'Video' }] } } }) : json({ event_id: 'five-sec' });
  } });
  await provider.submit('ltx2-free', prompt);
  const data = JSON.parse(calls[1].options.body).data;
  assert.equal(data[1], prompt); assert.equal(data[2], 5);
});

test('unsupported prompt durations fail clearly before metadata or GPU requests', async () => {
  let calls = 0;
  const provider = new FreeProvider({ fetchImpl: async () => { calls++; } });
  for (const prompt of ['A 15-second cinematic film', 'A 0.5-second clip', 'A 5.25-second clip', 'A -5-second clip']) {
    await assert.rejects(provider.submit('ltx2-free', prompt), error => error.submissionUncertain === false && error.pauseQueue && /1–10 seconds/.test(error.message));
  }
  await assert.rejects(provider.submit('animatediff-free', 'Make a 5-second animation'), /fixed 1\.6-second/);
  await assert.rejects(provider.submit('ltx-free', 'A 5-second clip'), /fixed 2-second/);
  await assert.rejects(provider.submit('wan-free', 'A 15-second shot'), /returned an error/);
  await assert.rejects(provider.submit('wan-free', 'A 8\.5-second shot'), /returned an error/);
  assert.equal(calls, 0);
});

test('the known-failing Wan service is disabled in both catalog and backend', async () => {
  let calls = 0;
  const provider = new FreeProvider({ fetchImpl: async () => { calls++; } });
  for (const models of [FREE_MODELS, PUBLIC_MODELS, MODELS]) assert.equal(models.find(model => model.id === 'wan-free').available, false);
  await assert.rejects(provider.submit('wan-free', 'An 8-second view of waves breaking on rocks.'), error =>
    error.submissionUncertain === false && error.pauseQueue && /returned an error/.test(error.message));
  assert.equal(calls, 0);
});

test('the story catalog describes two separately generated shots and has no direct provider submission', async () => {
  const model = PUBLIC_MODELS.find(entry => entry.id === 'ltx2-story-free');
  assert.equal(model.available, true);
  assert.equal(model.limits.defaultDuration, 15);
  assert.equal(model.limits.segments, 2);
  assert.equal(model.limits.defaultWidth, 768);
  assert.equal(model.limits.defaultHeight, 512);
  assert.match(model.description, /two newly generated shots joined with a cut/);
  let calls = 0;
  const provider = new FreeProvider({ fetchImpl: async () => { calls++; } });
  await assert.rejects(provider.submit(model.id, 'A lake at dawn'), error => error.submissionUncertain === false);
  assert.equal(calls, 0);
});

test('a default story plan creates two real shot requests totaling 15 seconds', () => {
  const prompt = 'A 1930s street scene: a cyclist rides through the rain.';
  const plan = createVideoPlan('ltx2-story-free', prompt);
  assert.equal(plan.durationSeconds, 15);
  assert.deepEqual(plan.segments.map(segment => segment.durationSeconds), [10, 5]);
  assert.equal(plan.segments.reduce((sum, segment) => sum + segment.durationSeconds, 0), 15);
  for (const [index, segment] of plan.segments.entries()) {
    assert.ok(segment.prompt.startsWith(`Create a ${segment.durationSeconds}-second shot.`));
    assert.match(segment.prompt, new RegExp(`Shot ${index + 1} of 2`));
    assert.ok(segment.prompt.includes(prompt));
    assert.equal(parsePromptDuration(segment.prompt), segment.durationSeconds);
  }
  assert.match(plan.segments[1].prompt, /cut between shots/);
  for (const id of ['ltx2-free', 'animatediff-free', 'ltx-free', 'wan-free', 'constructor', null]) assert.equal(createVideoPlan(id, null), null);
});

test('explicit story durations become canonical per-shot durations without conflicting total directives', async () => {
  const profile = newProfiles[0];
  for (const [total, durations] of [[15, [10, 5]], [18.5, [10, 8.5]], [20, [10, 10]]]) {
    const prompt = `Create a ${total}-second cinematic film of a lighthouse during a storm, with waves breaking below. The film lasts ${total} seconds.`;
    const plan = createVideoPlan('ltx2-story-free', prompt);
    assert.equal(plan.durationSeconds, total);
    assert.deepEqual(plan.segments.map(segment => segment.durationSeconds), durations);
    for (const segment of plan.segments) {
      assert.ok(segment.prompt.includes('a lighthouse during a storm, with waves breaking below'));
      assert.ok(!segment.prompt.includes(`${total}-second cinematic`));
      assert.ok(!segment.prompt.includes(`lasts ${total} seconds`));
      const calls = [];
      const provider = new FreeProvider({ fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return calls.length === 1 ? json({ named_endpoints: { '/generate_video': {
          parameters: profile.parameters.map(parameter_name => ({ parameter_name })), returns: [{ component: 'Video' }] } } }) : json({ event_id: 'planned-shot' });
      } });
      await provider.submit('ltx2-free', segment.prompt);
      const data = JSON.parse(calls[1].options.body).data;
      assert.equal(data[1], segment.prompt);
      assert.equal(data[2], segment.durationSeconds);
    }
  }
});

test('story plans preserve scene history and shorter action timing while stripping the total duration', () => {
  const plan = createVideoPlan('ltx2-story-free', 'A 16-second film set in the 1960s. A bird pauses for 2 seconds, then flies away.');
  assert.deepEqual(plan.segments.map(segment => segment.durationSeconds), [10, 6]);
  for (const segment of plan.segments) {
    assert.match(segment.prompt, /set in the 1960s/);
    assert.match(segment.prompt, /pauses for 2 seconds/);
    assert.ok(!segment.prompt.includes('16-second'));
  }
});

test('invalid story durations or prompts fail locally before any GPU submission', () => {
  for (const prompt of ['A 14-second film of a waterfall', 'A 21-second film of a waterfall', 'A 15.25-second film of a waterfall',
    'A -15-second film of a waterfall', 'A 0-second film of a waterfall', '', ' ', null, 'x'.repeat(10001), '15 seconds']) {
    assert.throws(() => createVideoPlan('ltx2-story-free', prompt), error =>
      error.name === 'FreeProviderError' && error.submissionUncertain === false && error.pauseQueue === true);
  }
  assert.throws(() => createVideoPlan('ltx2-story-free', 'x'.repeat(9999)), /Shorten the prompt/);
});

test('the observed Gradio 4 AnimateDiff FileData prefix is normalized only for its matching verified cache path', async () => {
  const profile = newProfiles.find(entry => entry.id === 'animatediff-free');
  const saved = { requestId: 'animate-event', provider: 'hf-zerogpu', modelId: profile.id,
    eventUrl: `${profile.origin}/call/generate_image/animate-event` };
  const path = '/tmp/gradio/d3a066f3089fcd2ba55e9dab9c67d686e6a2f602/1c299ee7990e486190c70b6a527186e7.mp4';
  const rawUrl = `${profile.origin}/call/gen/file=${path}`;
  const response = (url, filePath) => events(`event: complete\ndata: ${JSON.stringify([{ video: { url, path: filePath, meta: { _type: 'gradio.FileData' } }, subtitles: null }])}\n\n`);
  const provider = new FreeProvider({ fetchImpl: async () => response(rawUrl, path) });
  assert.deepEqual(await provider.poll(saved), { status: 'completed', videoUrl: `${profile.origin}/file=${path}` });
  for (const [url, filePath] of [[rawUrl, path.replace('1c299', '2c299')], [rawUrl, '/tmp/secret.mp4'],
    [rawUrl.replace(profile.origin, 'https://evil.example'), path], [`${rawUrl}?token=secret`, path],
    [rawUrl.replace('/call/gen/', '/call/other/'), path], [rawUrl, undefined]]) {
    const rejected = new FreeProvider({ fetchImpl: async () => response(url, filePath) });
    await assert.rejects(rejected.poll(saved), /outside/);
  }
});

test('the LTX presets send the publisher dimensions in height, width order', async () => {
  const profile = newProfiles[0];
  for (const [preset, dimensions] of [[undefined, [1024, 1536]], ['detail', [1024, 1536]], ['film', [512, 768]], ['film-portrait', [768, 512]]]) {
    const calls = [];
    const provider = new FreeProvider({ ...(preset ? { videoPreset: preset } : {}), fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return calls.length === 1 ? json({ named_endpoints: { '/generate_video': {
        parameters: profile.parameters.map(parameter_name => ({ parameter_name })), returns: [{ component: 'Video' }] } } }) : json({ event_id: 'preset-shot' });
    } });
    const prompt = 'Create a 10-second shot of a lighthouse during a storm.';
    await provider.submit('ltx2-free', prompt);
    assert.deepEqual(JSON.parse(calls[1].options.body).data, [null, prompt, 10, false, 42, false, ...dimensions]);
  }
  for (const videoPreset of ['custom', '768x512', 'https://evil.example', '', null, 1, {}, ['film']]) {
    assert.throws(() => new FreeProvider({ videoPreset }), /supported video preset/);
  }
});

test('the film preset cannot change AnimateDiff or legacy LTX request settings', async () => {
  for (const id of ['animatediff-free', 'ltx-free']) {
    const profile = newProfiles.find(entry => entry.id === id);
    const calls = [];
    const provider = new FreeProvider({ videoPreset: 'film', fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return calls.length === 1 ? json(profile ? { named_endpoints: { [`/${profile.api}`]: {
        parameters: profile.parameters.map(parameter_name => ({ parameter_name })), returns: [{ component: 'Video' }] } } } : schema()) : json({ event_id: 'unchanged-shot' });
    } });
    await provider.submit(id, 'A lake at dawn');
    const input = JSON.parse(calls[1].options.body).data;
    if (profile) assert.deepEqual(input, profile.input);
    else assert.deepEqual(input.slice(2), [null, null, 512, 704, 'text-to-video', 2, 9, 42, true, 1, false]);
  }
});
