'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../src/core/store');
const { Queue } = require('../src/core/queue');
const testRoot = path.resolve(__dirname, '..', '.test-tmp');

const models = [{ id: 'wan', available: true }, { id: 'missing', available: false, reason: 'No verified endpoint.' }];
const remote = { requestId: 'provider-request', statusUrl: 'https://queue.fal.run/test/requests/provider-request/status' };
const ready = { status: 'completed', videoUrl: 'https://v3.fal.media/files/test/video.mp4' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fakeClock() {
  let time = 1_000_000, next = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout(callback, delay) { const id = ++next; timers.set(id, { at: time + delay, callback }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(delay) {
      time += delay;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= time && timers.delete(id)) timer.callback();
      }
    },
  };
}

function fixture(t, overrides = {}) {
  fs.mkdirSync(testRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(testRoot, 'studio-queue-'));
  const store = new Store(dir);
  store.load();
  const calls = { submit: 0, poll: 0, cancel: 0, download: 0 };
  const provider = {
    async submit() { calls.submit++; return remote; },
    async poll() { calls.poll++; return ready; },
    async cancel() { calls.cancel++; return { cancelled: false }; },
    ...overrides.provider,
  };
  const queue = new Queue({
    store, models, providerFactory: () => provider,
    download: async () => { calls.download++; return path.join(dir, 'real-output-contract-test.mp4'); },
    pollIntervalMs: 0,
    ...overrides,
  });
  t.after(async () => { await queue.dispose(); if (path.dirname(path.resolve(dir)) === testRoot) fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, queue, provider, calls };
}

const approve = queue => queue.start({ approvedJobIds: queue.snapshot().jobs.filter(job => job.status === 'pending').map(job => job.id) });

test('500-prompt import is atomic, persistent, paused and capped independently of history', async t => {
  const { queue, calls, store } = fixture(t);
  queue.addPrompts(Array.from({ length: 500 }, (_, i) => `Prompt ${i + 1}`), 'wan');
  assert.equal(queue.snapshot().stats.active, 500);
  assert.equal(queue.snapshot().paused, true);
  assert.throws(() => queue.addPrompts(['Overflow'], 'wan'), /500/);
  assert.equal(store.snapshot().jobs.length, 500);
  const before = store.snapshot().revision;
  assert.throws(() => queue.addPrompts(['Valid', '  '], 'wan'), /Every/);
  assert.equal(store.snapshot().revision, before);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.submit, 0);
  await queue.cancel(queue.snapshot().jobs[0].id);
  queue.addPrompts(['Replacement'], 'wan');
  assert.equal(queue.snapshot().stats.active, 500);
  assert.equal(queue.snapshot().stats.total, 501);
});

test('an export folder is persisted only for prompts added with that folder', t => {
  const { queue, dir } = fixture(t);
  queue.addPrompts(['Existing prompt'], 'wan');
  const directory = path.join(dir, 'chosen-output');
  queue.addPrompts(['First export', 'Second export'], 'wan', { autoExportDirectory: directory });
  queue.addPrompts(['Later prompt'], 'wan');
  assert.throws(() => queue.addPrompts(['Invalid export'], 'wan', { autoExportDirectory: 'relative-folder' }), /export folder/);
  const restored = new Store(dir).load();
  assert.deepEqual(restored.jobs.map(job => job.autoExport), [undefined,
    { directory, status: 'pending' }, { directory, status: 'pending' }, undefined]);
});

test('explicit selected IDs gate network calls and later additions are never included automatically', async t => {
  const gate = deferred();
  let submits = 0;
  const { queue } = fixture(t, { provider: { async submit() { submits++; await gate.promise; return remote; } } });
  const [first] = queue.addPrompts(['First'], 'wan');
  assert.throws(() => queue.start(), /Select pending/);
  assert.throws(() => queue.start({ approvedJobIds: [] }), /no saved provider requests/);
  assert.throws(() => queue.start({ approvedJobIds: [first.id, first.id] }), /once/);
  approve(queue);
  await new Promise(resolve => setImmediate(resolve));
  queue.addPrompts(['Added after approval'], 'wan');
  gate.resolve();
  await queue.waitForIdle();
  assert.equal(submits, 1);
  assert.deepEqual(queue.snapshot().jobs.map(job => job.status), ['completed', 'pending']);
});

test('pause during accepted submission monitors that job but never starts the next', async t => {
  const gate = deferred();
  let submits = 0;
  const { queue } = fixture(t, { provider: { async submit() { submits++; return gate.promise; } } });
  queue.addPrompts(['First', 'Second'], 'wan');
  approve(queue);
  await new Promise(resolve => setImmediate(resolve));
  queue.pause();
  gate.resolve(remote);
  await queue.waitForIdle();
  assert.equal(submits, 1);
  assert.deepEqual(queue.snapshot().jobs.map(job => job.status), ['completed', 'pending']);
});

test('unavailable models and missing local credentials fail before submission', t => {
  const { queue, calls } = fixture(t, { providerFactory() { throw new Error('Add your provider key.'); } });
  assert.throws(() => queue.addPrompts(['Test'], 'missing'), /verified/);
  queue.addPrompts(['Test'], 'wan');
  assert.throws(() => approve(queue), /provider key/);
  assert.equal(calls.submit, 0);
  assert.equal(queue.snapshot().jobs[0].status, 'pending');
});

test('restart never repeats an ambiguous submission; saved remote requests can resume', async t => {
  const { queue, store, calls } = fixture(t);
  const [unknown, accepted] = queue.addPrompts(['Unknown', 'Accepted'], 'wan');
  store.mutate(state => {
    state.jobs[0].status = 'submitting';
    state.jobs[1].status = 'running';
    state.jobs[1].remote = remote;
  });
  queue.recover();
  assert.equal(queue.snapshot().paused, true);
  assert.equal(queue.snapshot().jobs[0].status, 'needs_attention');
  assert.match(queue.snapshot().jobs[0].error, /used your quota/);
  assert.equal(queue.snapshot().jobs[1].status, 'running');
  approve(queue);
  await queue.waitForIdle();
  assert.equal(calls.submit, 0);
  assert.equal(calls.poll, 1);
  assert.equal(queue.snapshot().jobs.find(job => job.id === accepted.id).status, 'completed');
  assert.equal(queue.snapshot().jobs.find(job => job.id === unknown.id).status, 'needs_attention');
});

test('submission timeouts preserve uncertainty and need a fresh approval to retry', async t => {
  const { queue, provider, calls } = fixture(t, { provider: { async submit() { calls.submit++; throw new Error('connection lost'); } } });
  const [job] = queue.addPrompts(['Test'], 'wan');
  approve(queue);
  await queue.waitForIdle();
  assert.equal(queue.snapshot().jobs[0].status, 'needs_attention');
  assert.match(queue.snapshot().jobs[0].error, /unknown/);
  queue.retry(job.id);
  assert.equal(calls.submit, 1);
  assert.equal(queue.snapshot().jobs[0].attempts.length, 1);
  provider.submit = async () => { calls.submit++; return remote; };
  approve(queue);
  await queue.waitForIdle();
  assert.equal(calls.submit, 2);
  assert.equal(queue.snapshot().jobs[0].status, 'completed');
});

test('poll failure keeps the request and Resume monitors without resubmitting', async t => {
  const { queue, provider, calls } = fixture(t, { provider: { async poll() { calls.poll++; throw new Error('offline'); } } });
  const [job] = queue.addPrompts(['Test'], 'wan');
  approve(queue);
  await queue.waitForIdle();
  assert.equal(calls.submit, 1);
  assert.equal(calls.poll, 3);
  assert.equal(queue.snapshot().jobs[0].remote.requestId, remote.requestId);
  assert.throws(() => queue.retry(job.id), /Resume monitoring/);
  provider.poll = async () => { calls.poll++; return ready; };
  queue.resume(job.id);
  await queue.waitForIdle();
  assert.equal(calls.submit, 1);
  assert.equal(queue.snapshot().jobs[0].status, 'completed');
});

test('failed downloads retry the output without another generation request', async t => {
  let downloads = 0;
  const { queue, calls } = fixture(t, { download: async () => { downloads++; if (downloads === 1) throw new Error('disk full'); return 'C:\\videos\\output.mp4'; } });
  const [job] = queue.addPrompts(['Test'], 'wan');
  approve(queue);
  await queue.waitForIdle();
  assert.equal(queue.snapshot().jobs[0].phase, 'download_failed');
  assert.throws(() => queue.retry(job.id), /already generated/);
  await queue.retryDownload(job.id);
  assert.equal(queue.snapshot().jobs[0].status, 'completed');
  assert.equal(calls.submit, 1);
  assert.equal(calls.poll, 1);
  assert.equal(downloads, 2);
});

test('cancellation during submission sends cancellation only after obtaining the request handle', async t => {
  const gate = deferred();
  let cancels = 0;
  const { queue, calls } = fixture(t, { provider: {
    async submit() { calls.submit++; return gate.promise; },
    async cancel(saved) { cancels++; assert.equal(saved.requestId, remote.requestId); return { cancelled: true }; },
  } });
  const [job] = queue.addPrompts(['Test'], 'wan');
  approve(queue);
  await new Promise(resolve => setImmediate(resolve));
  await queue.cancel(job.id);
  assert.equal(cancels, 0);
  assert.equal(queue.snapshot().jobs[0].cancellation, 'requested');
  gate.resolve(remote);
  await queue.waitForIdle();
  assert.equal(cancels, 1);
  assert.equal(calls.poll, 0);
  assert.equal(calls.download, 0);
  assert.equal(queue.snapshot().jobs[0].status, 'cancelled');
  assert.equal(queue.snapshot().jobs[0].cancellation, 'confirmed');
});

test('unconfirmed remote cancellation preserves the paid output when generation completes', async t => {
  const gate = deferred();
  const { queue, calls } = fixture(t, { provider: { async poll() { calls.poll++; return gate.promise; } } });
  const [job] = queue.addPrompts(['Test'], 'wan');
  approve(queue);
  await new Promise(resolve => setImmediate(resolve));
  await queue.cancel(job.id);
  assert.equal(queue.snapshot().jobs[0].status, 'queued');
  assert.equal(queue.snapshot().jobs[0].cancellation, 'requested');
  gate.resolve(ready);
  await queue.waitForIdle();
  assert.equal(queue.snapshot().jobs[0].status, 'completed');
  assert.equal(calls.download, 1);
});

test('confirmed cancellation racing an in-flight poll never downloads its stale completion', async t => {
  const gate = deferred();
  const { queue, calls } = fixture(t, { provider: { async poll() { return gate.promise; }, async cancel() { return { cancelled: true }; } } });
  const [job] = queue.addPrompts(['Test'], 'wan');
  approve(queue);
  await new Promise(resolve => setImmediate(resolve));
  await queue.cancel(job.id);
  gate.resolve(ready);
  await queue.waitForIdle();
  assert.equal(queue.snapshot().jobs[0].status, 'cancelled');
  assert.equal(calls.download, 0);
});

test('backup recovery quarantines pending jobs because the backup may predate acceptance', async t => {
  const { queue, store, dir, calls, provider } = fixture(t);
  const [job] = queue.addPrompts(['Possibly accepted'], 'wan');
  store.mutate(state => { state.jobs[0].status = 'submitting'; });
  fs.writeFileSync(path.join(dir, 'studio.json'), '{crash damage');
  const restoredStore = new Store(dir);
  restoredStore.load();
  const restoredQueue = new Queue({ store: restoredStore, models, providerFactory: () => provider, download: async () => 'C:\\saved-video.mp4', pollIntervalMs: 0 });
  t.after(() => restoredQueue.dispose());
  restoredQueue.recover();
  assert.equal(restoredQueue.snapshot().jobs[0].status, 'needs_attention');
  assert.match(restoredQueue.snapshot().jobs[0].error, /backup.*accepted/);
  assert.throws(() => approve(restoredQueue), /no saved provider requests/);
  assert.equal(calls.submit, 0);
  restoredQueue.retry(job.id);
  assert.equal(calls.submit, 0);
  approve(restoredQueue);
  await restoredQueue.waitForIdle();
  assert.equal(calls.submit, 1);
  assert.equal(queue.snapshot().jobs[0].id, job.id);
});

test('download retry is single-flight and resume cannot start duplicate monitoring', async t => {
  const gate = deferred();
  let downloads = 0;
  const { queue } = fixture(t, { download: async () => { downloads++; if (downloads === 1) throw new Error('offline'); await gate.promise; return 'C:\\saved-video.mp4'; } });
  const [job] = queue.addPrompts(['Test'], 'wan');
  approve(queue);
  await queue.waitForIdle();
  const retry = queue.retryDownload(job.id);
  await assert.rejects(queue.retryDownload(job.id), /already being downloaded/);
  gate.resolve();
  await retry;
  assert.equal(downloads, 2);
  assert.throws(() => queue.resume(job.id), /No saved/);
});

test('a stale poll failure cannot overwrite a manually retried cancelled attempt', async t => {
  let rejectPoll;
  const poll = new Promise((resolve, reject) => { rejectPoll = reject; });
  const { queue, provider } = fixture(t, { maxPollErrors: 1, provider: { async poll() { return poll; }, async cancel() { return { cancelled: true }; } } });
  const [job] = queue.addPrompts(['Test'], 'wan');
  approve(queue);
  await new Promise(resolve => setImmediate(resolve));
  await queue.cancel(job.id);
  queue.retry(job.id);
  rejectPoll(new Error('old request disconnected'));
  await queue.waitForIdle();
  assert.equal(queue.snapshot().jobs[0].status, 'pending');
  provider.poll = async () => ready;
  approve(queue);
  await queue.waitForIdle();
  assert.equal(queue.snapshot().jobs[0].status, 'completed');
});

test('a failed download pauses the remaining approved batch before using more quota', async t => {
  const { queue, calls } = fixture(t, { download: async () => { throw new Error('disk full'); } });
  queue.addPrompts(['Generated output cannot be saved', 'Do not submit this prompt yet'], 'wan');
  approve(queue);
  await queue.waitForIdle();
  const snapshot = queue.snapshot();
  assert.equal(calls.submit, 1);
  assert.equal(snapshot.paused, true);
  assert.deepEqual(snapshot.jobs.map(job => job.status), ['needs_attention', 'pending']);
  assert.equal(snapshot.jobs[0].remoteVideoUrl, ready.videoUrl);
  assert.match(snapshot.jobs[0].error, /Retry the download/);
});

test('credential, credit and rate-limit submission errors pause the rest of the approved batch', async t => {
  for (const httpStatus of [401, 402, 403, 429]) {
    let submitted = 0;
    const { queue } = fixture(t, { provider: { async submit() {
      submitted++;
      throw Object.assign(new Error(`HTTP ${httpStatus}`), { httpStatus });
    } } });
    queue.addPrompts(['Fail with account or rate error', 'Keep this prompt pending'], 'wan');
    approve(queue);
    await queue.waitForIdle();
    assert.equal(submitted, 1, `HTTP ${httpStatus} must stop further submissions`);
    assert.equal(queue.snapshot().paused, true);
    assert.deepEqual(queue.snapshot().jobs.map(job => job.status), ['failed', 'pending']);
  }
});

test('a provider stop signal on submission holds the batch without automatic retry', async t => {
  for (const definitive of [true, false]) {
    let submissions = 0;
    const { queue, calls } = fixture(t, { provider: { async submit() {
      submissions++;
      throw Object.assign(new Error('The free allocation is exhausted. Try again later.'), {
        pauseQueue: true, ...(definitive ? { submissionUncertain: false } : {}),
      });
    } } });
    queue.addPrompts(['Free allocation limit', 'Keep this prompt waiting'], 'wan');
    approve(queue);
    await queue.waitForIdle();
    await new Promise(resolve => setImmediate(resolve));
    await queue.waitForIdle();
    assert.equal(submissions, 1);
    assert.equal(calls.poll, 0);
    assert.equal(queue.snapshot().paused, true);
    assert.deepEqual(queue.snapshot().jobs.map(job => job.status), [definitive ? 'failed' : 'needs_attention', 'pending']);
  }
});

test('a provider stop signal during monitoring pauses on the first error and preserves the request', async t => {
  let polls = 0;
  const { queue, provider, calls } = fixture(t, { maxPollErrors: 10, provider: { async poll() {
    polls++;
    throw Object.assign(new Error('The free allocation is unavailable.'), { pauseQueue: true });
  } } });
  const [first] = queue.addPrompts(['Saved request hits a limit', 'Keep this prompt waiting'], 'wan');
  approve(queue);
  await queue.waitForIdle();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(polls, 1, 'A provider stop signal must not enter the ordinary polling retry loop.');
  assert.equal(calls.submit, 1);
  assert.equal(queue.snapshot().paused, true);
  assert.deepEqual(queue.snapshot().jobs.map(job => job.status), ['needs_attention', 'pending']);
  assert.deepEqual(queue.snapshot().jobs[0].remote, remote);
  provider.poll = async () => { polls++; return ready; };
  queue.resume(first.id);
  await queue.waitForIdle();
  assert.equal(polls, 2, 'Only a manual resume restarts monitoring.');
  assert.equal(calls.submit, 1, 'Resuming the saved request cannot submit either prompt again.');
  assert.deepEqual(queue.snapshot().jobs.map(job => job.status), ['completed', 'pending']);
});

test('a terminal provider failure can stop the batch without retrying or consuming another prompt', async t => {
  let polls = 0;
  const { queue, calls } = fixture(t, { provider: { async poll() {
    polls++;
    return { status: 'failed', error: 'The free allocation is exhausted.', pauseQueue: true };
  } } });
  queue.addPrompts(['Terminal allocation failure', 'Keep this prompt waiting'], 'wan');
  approve(queue);
  await queue.waitForIdle();
  await new Promise(resolve => setImmediate(resolve));
  await queue.waitForIdle();
  assert.equal(calls.submit, 1);
  assert.equal(polls, 1);
  assert.equal(queue.snapshot().paused, true);
  assert.deepEqual(queue.snapshot().jobs.map(job => job.status), ['failed', 'pending']);
  assert.deepEqual(queue.snapshot().jobs[0].remote, remote);
});

test('restart recovers an interrupted completed-output download without reopening the provider stream', async t => {
  for (const interruptedStatus of ['queued', 'running']) {
    const { queue, store, dir } = fixture(t);
    const [job] = queue.addPrompts(['Generated video download interrupted by shutdown'], 'wan');
    store.mutate(state => {
      Object.assign(state.jobs[0], { status: interruptedStatus, remote, remoteVideoUrl: ready.videoUrl, phase: 'downloading' });
    });
    const reopenedStore = new Store(dir);
    reopenedStore.load();
    let providerCalls = 0;
    let downloads = 0;
    const recovered = new Queue({
      store: reopenedStore, models,
      providerFactory() { providerCalls++; throw new Error('The provider stream must not be reopened.'); },
      download: async (url, id) => {
        downloads++;
        assert.equal(url, ready.videoUrl);
        assert.equal(id, job.id);
        return path.join(dir, 'recovered-output.mp4');
      },
      pollIntervalMs: 0,
    });
    t.after(() => recovered.dispose());
    recovered.recover();
    assert.equal(recovered.snapshot().paused, true);
    assert.equal(recovered.snapshot().jobs[0].status, 'needs_attention');
    assert.equal(recovered.snapshot().jobs[0].phase, 'download_failed');
    assert.equal(recovered.snapshot().jobs[0].remoteVideoUrl, ready.videoUrl);
    assert.match(recovered.snapshot().jobs[0].error, /Retry the saved download/);
    await recovered.retryDownload(job.id);
    assert.equal(recovered.snapshot().jobs[0].status, 'completed');
    assert.equal(providerCalls, 0);
    assert.equal(downloads, 1);
  }
});

test('direct Generate starts only its selected pending subset', async t => {
  const { queue, calls } = fixture(t);
  const [older, selected, unrelated] = queue.addPrompts(['Older saved prompt', 'Generate this prompt', 'Another saved prompt'], 'wan');
  queue.start({ approvedJobIds: [selected.id] });
  await queue.waitForIdle();
  assert.equal(calls.submit, 1);
  assert.deepEqual(queue.snapshot().jobs.map(job => [job.id, job.status]), [
    [older.id, 'pending'], [selected.id, 'completed'], [unrelated.id, 'pending'],
  ]);
  assert.equal(queue.snapshot().paused, true);
});

test('Generate during an active run appends new selections without dropping the previous batch', async t => {
  const gate = deferred();
  const submitted = [];
  const { queue } = fixture(t, { provider: { async submit(_modelId, prompt) {
    submitted.push(prompt);
    if (submitted.length === 1) await gate.promise;
    return remote;
  } } });
  const [first, second] = queue.addPrompts(['First selected', 'Second selected', 'Unrelated pending'], 'wan');
  queue.start({ approvedJobIds: [first.id, second.id] });
  await new Promise(resolve => setImmediate(resolve));
  const [added] = queue.addPrompts(['New Generate click'], 'wan');
  queue.start({ approvedJobIds: [added.id] });
  gate.resolve();
  await queue.waitForIdle();
  assert.deepEqual(submitted, ['First selected', 'Second selected', 'New Generate click']);
  assert.deepEqual(queue.snapshot().jobs.map(job => job.status), ['completed', 'completed', 'pending', 'completed']);
});

test('selection validation rejects unknown and nonpending IDs without starting other work', async t => {
  const { queue, calls } = fixture(t);
  const [finished, pending] = queue.addPrompts(['Finish first', 'Remain pending'], 'wan');
  queue.start({ approvedJobIds: [finished.id] });
  await queue.waitForIdle();
  for (const ids of [[finished.id], ['unknown-id'], [pending.id, finished.id], [pending.id, pending.id]]) {
    assert.throws(() => queue.start({ approvedJobIds: ids }), /pending|once/);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.submit, 1);
  assert.equal(queue.snapshot().jobs[1].status, 'pending');
  assert.equal(queue.snapshot().paused, true);
});

test('pausing clears earlier selections even when a new Generate click follows immediately', async t => {
  const gate = deferred();
  const submitted = [];
  const { queue } = fixture(t, { provider: { async submit(_modelId, prompt) {
    submitted.push(prompt);
    if (submitted.length === 1) await gate.promise;
    return remote;
  } } });
  const [first, paused] = queue.addPrompts(['Already submitted', 'Clear this selection on pause'], 'wan');
  queue.start({ approvedJobIds: [first.id, paused.id] });
  await new Promise(resolve => setImmediate(resolve));
  queue.pause();
  const [newJob] = queue.addPrompts(['Explicit new Generate'], 'wan');
  queue.start({ approvedJobIds: [newJob.id] });
  gate.resolve();
  await queue.waitForIdle();
  assert.deepEqual(submitted, ['Already submitted', 'Explicit new Generate']);
  assert.deepEqual(queue.snapshot().jobs.map(job => job.status), ['completed', 'pending', 'completed']);
});

test('Generate arriving after the runner final scan is handed to a successor without losing its selection', async t => {
  const atExit = deferred();
  const finishExit = deferred();
  const { queue, calls } = fixture(t);
  const run = queue._run.bind(queue);
  let holdFirstExit = true;
  queue._run = async () => {
    await run();
    if (holdFirstExit) {
      holdFirstExit = false;
      atExit.resolve();
      await finishExit.promise;
    }
  };
  const [first] = queue.addPrompts(['Finish first runner'], 'wan');
  queue.start({ approvedJobIds: [first.id] });
  await atExit.promise;
  const [next] = queue.addPrompts(['Generate at the handoff boundary'], 'wan');
  queue.start({ approvedJobIds: [next.id] });
  finishExit.resolve();
  await queue.waitForIdle();
  assert.equal(calls.submit, 2);
  assert.deepEqual(queue.snapshot().jobs.map(job => job.status), ['completed', 'completed']);
  assert.equal(queue.snapshot().running, false);
  assert.equal(queue.snapshot().paused, true);
});

test('an empty selection monitors a saved request while unrelated pending work stays paused', async t => {
  const { queue, store, calls } = fixture(t);
  queue.addPrompts(['Saved provider request', 'Older pending prompt'], 'wan');
  store.mutate(state => { state.jobs[0].status = 'queued'; state.jobs[0].remote = remote; });
  queue.recover();
  queue.start({ approvedJobIds: [] });
  assert.equal(queue.snapshot().paused, true, 'Monitoring alone grants no new submissions.');
  await queue.waitForIdle();
  assert.equal(calls.submit, 0);
  assert.equal(calls.poll, 1);
  assert.deepEqual(queue.snapshot().jobs.map(job => job.status), ['completed', 'pending']);
});

test('new Generate skips unrelated recovered remote work until monitoring is explicitly requested', async t => {
  const staleRemote = { ...remote, requestId: 'stale-request', statusUrl: 'https://queue.fal.run/test/requests/stale-request/status' };
  const polled = [];
  const { queue, store, calls } = fixture(t, { provider: { async poll(saved) {
    polled.push(saved.requestId);
    return ready;
  } } });
  const [stale] = queue.addPrompts(['Older accepted request'], 'wan');
  store.mutate(state => { state.jobs[0].status = 'queued'; state.jobs[0].remote = staleRemote; });
  queue.recover();
  const [fresh] = queue.addPrompts(['Generate this fresh prompt now'], 'wan');
  queue.start({ approvedJobIds: [fresh.id] });
  await queue.waitForIdle();
  assert.equal(calls.submit, 1);
  assert.deepEqual(polled, [remote.requestId], 'Generate must not reopen the unrelated stale stream.');
  assert.deepEqual(queue.snapshot().jobs.map(job => job.status), ['queued', 'completed']);
  assert.equal(queue.snapshot().running, false, 'Unselected remote work cannot keep restarting the runner.');
  assert.equal(queue.snapshot().paused, true);
  queue.start({ approvedJobIds: [] });
  await queue.waitForIdle();
  assert.equal(calls.submit, 1, 'Explicit monitoring must not submit a replacement.');
  assert.deepEqual(polled, [remote.requestId, staleRemote.requestId]);
  assert.equal(queue.snapshot().jobs.find(job => job.id === stale.id).status, 'completed');
});

const storyModels = [...models, { id: 'ltx2-free', available: true }, { id: 'ltx2-story-free', available: true }];
const storyPlan = () => ({ durationSeconds: 15, segments: [
  { prompt: 'Create a 10-second wide shot of a whale.', durationSeconds: 10 },
  { prompt: 'Create a 5-second closer shot of the whale.', durationSeconds: 5 },
] });
function storyFixture(t, overrides = {}) {
  return fixture(t, { models: storyModels, planVideo: modelId => modelId === 'ltx2-story-free' ? storyPlan() : null,
    composeVideo: async () => 'C:\\videos\\joined-story.mp4', ...overrides });
}

test('long-video plans are validated atomically before adding or submitting prompts', async t => {
  const { queue, store, calls } = storyFixture(t, { planVideo: () => ({ ...storyPlan(), durationSeconds: 20 }) });
  assert.throws(() => queue.addPrompts(['Whale story'], 'ltx2-story-free'), /plan is invalid/);
  assert.equal(store.snapshot().jobs.length, 0);
  assert.equal(calls.submit, 0);
  const unavailable = storyFixture(t, { composeVideo: undefined });
  assert.throws(() => unavailable.queue.addPrompts(['Whale story'], 'ltx2-story-free'), /assembly is unavailable/);
  assert.equal(unavailable.queue.snapshot().jobs.length, 0);
});

test('long video persists each request and output before proceeding and completes only after assembly', async t => {
  const gate = deferred();
  const submitted = [], downloaded = [];
  let composeOptions;
  const { queue } = storyFixture(t, {
    provider: {
      async submit(modelId, prompt) {
        submitted.push({ modelId, prompt });
        return { requestId: `shot-${submitted.length}` };
      },
      async poll(saved) {
        const job = queue.snapshot().jobs[0];
        assert.deepEqual(job.segments[job.segmentIndex].remote, saved, 'Accepted request must already be persisted.');
        return { status: 'completed', videoUrl: `https://v3.fal.media/${saved.requestId}.mp4` };
      },
    },
    download: async (url, id) => {
      const job = queue.snapshot().jobs[0];
      assert.equal(job.segments[job.segmentIndex].remoteVideoUrl, url, 'Output must already be persisted.');
      downloaded.push(id);
      return `C:\\videos\\${id}.mp4`;
    },
    composeVideo: async options => { composeOptions = options; await gate.promise; return 'C:\\videos\\joined-story.mp4'; },
  });
  const [job] = queue.addPrompts(['15-second whale story'], 'ltx2-story-free');
  approve(queue);
  while (!composeOptions) await new Promise(resolve => setImmediate(resolve));
  assert.equal(queue.snapshot().jobs[0].status, 'running');
  assert.equal(queue.snapshot().jobs[0].phase, 'composing');
  assert.equal(queue.snapshot().jobs[0].videoPath, undefined);
  assert.deepEqual(submitted.map(call => call.modelId), ['ltx2-free', 'ltx2-free']);
  assert.deepEqual(submitted.map(call => call.prompt), storyPlan().segments.map(segment => segment.prompt));
  assert.deepEqual(downloaded, [`${job.id}-part-1`, `${job.id}-part-2`]);
  assert.equal(composeOptions.durationSeconds, 15);
  assert.deepEqual(composeOptions.segments.map(segment => segment.durationSeconds), [10, 5]);
  gate.resolve();
  await queue.waitForIdle();
  assert.equal(queue.snapshot().jobs[0].status, 'completed');
  assert.equal(queue.snapshot().jobs[0].videoPath, 'C:\\videos\\joined-story.mp4');
});

test('quota failure after the first shot pauses and retry preserves that saved shot', async t => {
  let submissions = 0, downloads = 0;
  const { queue } = storyFixture(t, {
    provider: { async submit() {
      submissions++;
      if (submissions === 2) throw Object.assign(new Error('Daily allocation exhausted'), { httpStatus: 429, submissionUncertain: false, pauseQueue: true });
      return { requestId: `shot-${submissions}` };
    } },
    download: async (_url, id) => { downloads++; return `C:\\videos\\${id}.mp4`; },
  });
  const [job] = queue.addPrompts(['Whale story'], 'ltx2-story-free');
  approve(queue); await queue.waitForIdle();
  assert.equal(queue.snapshot().paused, true);
  assert.equal(queue.snapshot().jobs[0].status, 'failed');
  assert.deepEqual(queue.snapshot().jobs[0].segments.map(segment => segment.status), ['completed', 'failed']);
  const saved = queue.snapshot().jobs[0].segments[0].videoPath;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(submissions, 2, 'Quota failure must not cause automatic resubmission.');
  queue.retry(job.id);
  assert.equal(queue.snapshot().jobs[0].segments[0].videoPath, saved);
  approve(queue); await queue.waitForIdle();
  assert.equal(submissions, 3, 'Only the second shot is retried.');
  assert.equal(downloads, 2, 'The first shot is not downloaded again.');
  assert.equal(queue.snapshot().jobs[0].status, 'completed');
});

test('pausing a long video preserves its accepted shot and prevents the next submission', async t => {
  const gate = deferred();
  const { queue, provider, calls } = storyFixture(t, { provider: { async poll() { calls.poll++; return gate.promise; } } });
  const [job] = queue.addPrompts(['Whale story'], 'ltx2-story-free');
  approve(queue);
  await new Promise(resolve => setImmediate(resolve));
  queue.pause(); gate.resolve(ready);
  await queue.waitForIdle();
  assert.equal(calls.submit, 1);
  assert.equal(queue.snapshot().jobs[0].segments[0].status, 'completed');
  assert.equal(queue.snapshot().jobs[0].status, 'pending');
  assert.equal(queue.snapshot().jobs[0].phase, 'story_paused');
  provider.poll = async () => ready;
  queue.start({ approvedJobIds: [job.id] });
  await queue.waitForIdle();
  assert.equal(calls.submit, 2);
  assert.equal(queue.snapshot().jobs[0].status, 'completed');
});

test('restart between portrait shots stays paused and continues only the unfinished portrait shot', async t => {
  const { queue, store, dir } = storyFixture(t, { planVideo: () => ({ ...storyPlan(), orientation: 'portrait' }) });
  const [job] = queue.addPrompts(['Whale story'], 'ltx2-story-free');
  store.mutate(state => {
    const item = state.jobs[0];
    item.status = 'running'; item.phase = 'generating'; item.segmentIndex = 1;
    Object.assign(item.segments[0], { status: 'completed', videoPath: 'C:\\videos\\saved-shot.mp4' });
  });
  const restoredStore = new Store(dir); restoredStore.load();
  let submissions = 0;
  const restored = new Queue({ store: restoredStore, models: storyModels,
    providerFactory: (_model, context) => {
      assert.deepEqual(context, { purpose: 'story', orientation: 'portrait' });
      return { async submit(_id, prompt) { submissions++; assert.match(prompt, /5-second/); return remote; }, async poll() { return ready; } };
    },
    download: async () => 'C:\\videos\\second-shot.mp4', composeVideo: async ({ orientation }) => {
      assert.equal(orientation, 'portrait');
      return 'C:\\videos\\joined.mp4';
    }, pollIntervalMs: 0,
  });
  t.after(() => restored.dispose());
  restored.recover();
  assert.equal(restored.snapshot().jobs[0].status, 'pending');
  assert.equal(restored.snapshot().paused, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(submissions, 0);
  restored.start({ approvedJobIds: [job.id] }); await restored.waitForIdle();
  assert.equal(submissions, 1);
  assert.equal(restored.snapshot().jobs[0].status, 'completed');
  assert.equal(restored.snapshot().jobs[0].segments[0].videoPath, 'C:\\videos\\saved-shot.mp4');
});

test('restart recovers the second shot download and joins saved shots without provider calls', async t => {
  const { queue, store, dir } = storyFixture(t);
  const [job] = queue.addPrompts(['Whale story'], 'ltx2-story-free');
  store.mutate(state => {
    const item = state.jobs[0];
    Object.assign(item.segments[0], { status: 'completed', videoPath: 'C:\\videos\\first-shot.mp4' });
    Object.assign(item.segments[1], { status: 'queued', remote, remoteVideoUrl: ready.videoUrl });
    Object.assign(item, { status: 'queued', remote, remoteVideoUrl: ready.videoUrl, segmentIndex: 1, phase: 'downloading' });
  });
  const restoredStore = new Store(dir); restoredStore.load();
  let providerCalls = 0, downloads = 0, compositions = 0;
  const restored = new Queue({ store: restoredStore, models: storyModels,
    providerFactory: () => { providerCalls++; throw new Error('Provider must not be called.'); },
    download: async (url, id) => { downloads++; assert.equal(url, ready.videoUrl); assert.equal(id, `${job.id}-part-2`); return 'C:\\videos\\second-shot.mp4'; },
    composeVideo: async options => { compositions++; assert.equal(options.segments.length, 2); return 'C:\\videos\\joined.mp4'; }, pollIntervalMs: 0,
  });
  t.after(() => restored.dispose());
  restored.recover();
  assert.equal(restored.snapshot().jobs[0].phase, 'download_failed');
  await restored.retryDownload(job.id);
  assert.equal(providerCalls, 0); assert.equal(downloads, 1); assert.equal(compositions, 1);
  assert.equal(restored.snapshot().jobs[0].status, 'completed');
});

test('failed long-video assembly can be recovered locally without regenerating either shot', async t => {
  let compositions = 0;
  const { queue, calls } = storyFixture(t, { composeVideo: async () => { compositions++; if (compositions === 1) throw new Error('Encoder interrupted'); return 'C:\\videos\\joined.mp4'; } });
  const [job] = queue.addPrompts(['Whale story'], 'ltx2-story-free');
  approve(queue); await queue.waitForIdle();
  assert.equal(queue.snapshot().jobs[0].phase, 'compose_failed');
  assert.equal(queue.snapshot().jobs[0].status, 'needs_attention');
  assert.equal(queue.snapshot().jobs[0].remoteVideoUrl, undefined);
  assert.equal(queue.snapshot().jobs[0].segments.every(segment => segment.videoPath), true);
  await queue.retryDownload(job.id);
  assert.equal(queue.snapshot().jobs[0].status, 'completed');
  assert.equal(calls.submit, 2); assert.equal(calls.poll, 2); assert.equal(calls.download, 2); assert.equal(compositions, 2);
});

test('an ambiguous second-shot submission is quarantined after restart and good shots remain saved', async t => {
  const { queue, store, dir } = storyFixture(t);
  const [job] = queue.addPrompts(['Whale story'], 'ltx2-story-free');
  store.mutate(state => {
    const item = state.jobs[0];
    Object.assign(item.segments[0], { status: 'completed', videoPath: 'C:\\videos\\first-shot.mp4' });
    item.segments[1].status = 'submitting'; item.status = 'submitting'; item.segmentIndex = 1;
  });
  const restoredStore = new Store(dir); restoredStore.load();
  let submissions = 0;
  const restored = new Queue({ store: restoredStore, models: storyModels,
    providerFactory: () => ({ async submit() { submissions++; return remote; }, async poll() { return ready; } }),
    download: async () => 'C:\\videos\\second-shot.mp4', composeVideo: async () => 'C:\\videos\\joined.mp4', pollIntervalMs: 0,
  });
  t.after(() => restored.dispose()); restored.recover();
  assert.equal(restored.snapshot().jobs[0].status, 'needs_attention');
  assert.equal(restored.snapshot().jobs[0].phase, 'submission_uncertain');
  assert.throws(() => restored.start({ approvedJobIds: [] }), /no saved provider requests/);
  assert.equal(submissions, 0);
  restored.retry(job.id); approve(restored); await restored.waitForIdle();
  assert.equal(submissions, 1);
  assert.equal(restored.snapshot().jobs[0].segments[0].videoPath, 'C:\\videos\\first-shot.mp4');
  assert.equal(restored.snapshot().jobs[0].status, 'completed');
});

test('a terminal failed shot is retried with a fresh request rather than reopening its consumed stream', async t => {
  let submissions = 0;
  const polled = [];
  const { queue, store } = storyFixture(t, { provider: {
    async submit() { return { requestId: `shot-${++submissions}` }; },
    async poll(saved) {
      polled.push(saved.requestId);
      return saved.requestId === 'shot-2'
        ? { status: 'failed', error: 'Terminal generation failure', pauseQueue: true }
        : ready;
    },
  } });
  const [job] = queue.addPrompts(['Whale story'], 'ltx2-story-free');
  approve(queue); await queue.waitForIdle();
  assert.equal(queue.snapshot().jobs[0].status, 'failed');
  assert.equal(queue.snapshot().jobs[0].segments[1].status, 'failed');
  assert.throws(() => queue.resume(job.id), /No saved provider request/);
  // Also recover a legacy/inconsistent top-level monitoring state. The saved
  // terminal segment remains authoritative and must still offer Retry.
  store.mutate(state => { state.jobs[0].status = 'needs_attention'; });
  queue.recover();
  assert.equal(queue.snapshot().jobs[0].status, 'failed');
  const firstPath = queue.snapshot().jobs[0].segments[0].videoPath;
  queue.retry(job.id);
  assert.equal(queue.snapshot().jobs[0].segments[1].remote, undefined);
  approve(queue); await queue.waitForIdle();
  assert.equal(queue.snapshot().jobs[0].status, 'completed');
  assert.equal(queue.snapshot().jobs[0].segments[0].videoPath, firstPath);
  assert.deepEqual(polled, ['shot-1', 'shot-2', 'shot-3']);
});

test('cancelling an unconfirmed long-video request preserves its completed shot but starts no further shot', async t => {
  const gate = deferred();
  const { queue, calls } = storyFixture(t, { provider: { async poll() { calls.poll++; return gate.promise; } } });
  const [job] = queue.addPrompts(['Whale story'], 'ltx2-story-free');
  approve(queue); await new Promise(resolve => setImmediate(resolve));
  await queue.cancel(job.id);
  gate.resolve(ready); await queue.waitForIdle();
  assert.equal(queue.snapshot().jobs[0].status, 'cancelled');
  assert.equal(queue.snapshot().jobs[0].segments[0].status, 'completed');
  assert.equal(queue.snapshot().jobs[0].segments[1].status, 'pending');
  assert.equal(calls.submit, 1); assert.equal(calls.download, 1);
});

test('invalid saved duration grids and segment structures are rejected before any GPU submission', async t => {
  const invalidPlans = [
    { ...storyPlan(), orientation: 'square' },
    { ...storyPlan(), durationSeconds: 14 },
    { ...storyPlan(), durationSeconds: 21 },
    { ...storyPlan(), durationSeconds: 15.05, segments: [{ ...storyPlan().segments[0] }, { ...storyPlan().segments[1], durationSeconds: 5.05 }] },
    { durationSeconds: 15, segments: [{ prompt: 'First', durationSeconds: 0 }, { prompt: 'Second', durationSeconds: 15 }] },
    { durationSeconds: 15, segments: [{ prompt: 'First', durationSeconds: 5 }, { prompt: 'Second', durationSeconds: 5 }, { prompt: 'Third', durationSeconds: 5 }] },
  ];
  for (const plan of invalidPlans) {
    const { queue, calls } = storyFixture(t, { planVideo: () => plan });
    assert.throws(() => queue.addPrompts(['Whale story'], 'ltx2-story-free'), /plan is invalid/);
    assert.equal(queue.snapshot().jobs.length, 0);
    assert.equal(calls.submit, 0);
  }
});

test('provider construction checks each story orientation without changing normal clips', async t => {
  const contexts = [], orientations = [];
  let provider;
  const result = storyFixture(t, {
    planVideo: (modelId, prompt) => {
      if (modelId !== 'ltx2-story-free') return null;
      return prompt === 'Portrait story' ? { ...storyPlan(), orientation: 'portrait' } : storyPlan();
    },
    providerFactory(model, context) {
      contexts.push({ modelId: model.id, context });
      return provider;
    },
    async composeVideo({ orientation }) {
      orientations.push(orientation);
      return 'C:\\videos\\joined.mp4';
    },
  });
  provider = result.provider;
  result.queue.addPrompts(['Normal clip'], 'ltx2-free');
  result.queue.addPrompts(['Whale story', 'Portrait story'], 'ltx2-story-free');
  approve(result.queue); await result.queue.waitForIdle();
  assert.deepEqual(contexts, [
    { modelId: 'ltx2-free', context: undefined },
    { modelId: 'ltx2-free', context: { purpose: 'story' } },
    { modelId: 'ltx2-free', context: { purpose: 'story', orientation: 'portrait' } },
    { modelId: 'ltx2-free', context: undefined },
    { modelId: 'ltx2-free', context: { purpose: 'story' } },
    { modelId: 'ltx2-free', context: { purpose: 'story', orientation: 'portrait' } },
  ]);
  assert.deepEqual(orientations, [undefined, 'portrait']);
  assert.deepEqual(result.queue.snapshot().jobs.map(job => job.status), ['completed', 'completed', 'completed']);
});

test('an authorized automatic batch waits for Retry-After, reopens and finishes only selected prompts', async t => {
  const clock = fakeClock();
  const submitted = [];
  const { queue, dir, provider } = fixture(t, { retryClock: clock, provider: { async submit(_modelId, prompt) {
    submitted.push(prompt);
    if (submitted.length === 1) throw Object.assign(new Error('Rate limited'), { httpStatus: 429, submissionUncertain: false, retryAfterMs: 120_000 });
    return remote;
  } } });
  const [first, second, other] = queue.addPrompts(['First', 'Second', 'Unselected'], 'wan');
  queue.start({ approvedJobIds: [first.id, second.id], automatic: true });
  await queue.waitForIdle();
  const retryAt = clock.now() + 120_000;
  assert.equal(queue.snapshot().nextRetryAt, retryAt);
  assert.equal(queue.snapshot().jobs[0].phase, 'waiting_quota');
  assert.equal(queue.snapshot().paused, true);
  assert.deepEqual(submitted, ['First']);
  await queue.dispose({ preserveAutomatic: true });

  const store = new Store(dir);
  store.load();
  const reopened = new Queue({ store, models, retryClock: clock, providerFactory: () => provider,
    download: async () => 'C:\\videos\\saved.mp4', pollIntervalMs: 0 });
  t.after(() => reopened.dispose());
  assert.equal(reopened.recover().nextRetryAt, retryAt);
  clock.advance(119_999);
  await reopened.waitForIdle();
  assert.deepEqual(submitted, ['First']);
  clock.advance(1);
  await reopened.waitForIdle();
  assert.deepEqual(submitted, ['First', 'First', 'Second']);
  assert.equal(reopened.snapshot().automaticBatch, null);
  assert.deepEqual(reopened.snapshot().jobs.map(job => [job.id, job.status]), [[first.id, 'completed'], [second.id, 'completed'], [other.id, 'pending']]);
});

test('a terminal GPU quota error preserves saved shots and retries only the remaining shot', async t => {
  const clock = fakeClock();
  const submitted = [], polled = [], downloaded = [];
  const { queue } = storyFixture(t, { retryClock: clock, provider: {
    async submit(_modelId, prompt) { submitted.push(prompt); return { requestId: `shot-${submitted.length}` }; },
    async poll(saved) {
      polled.push(saved.requestId);
      return saved.requestId === 'shot-2' ? { status: 'failed', error: 'GPU quota exhausted', quotaBlocked: true } : ready;
    },
  }, download: async (_url, id) => { downloaded.push(id); return `C:\\videos\\${id}.mp4`; } });
  const [job] = queue.addPrompts(['Whale story'], 'ltx2-story-free');
  queue.start({ approvedJobIds: [job.id], automatic: true });
  await queue.waitForIdle();
  assert.equal(queue.snapshot().nextRetryAt, clock.now() + 86_400_000);
  const saved = queue.snapshot().jobs[0];
  assert.equal(saved.segments[0].status, 'completed');
  assert.equal(saved.segments[1].status, 'pending');
  assert.equal(saved.segments[1].remote, undefined);
  clock.advance(86_400_000);
  await queue.waitForIdle();
  assert.deepEqual(submitted, [storyPlan().segments[0].prompt, storyPlan().segments[1].prompt, storyPlan().segments[1].prompt]);
  assert.deepEqual(polled, ['shot-1', 'shot-2', 'shot-3']);
  assert.equal(downloaded.length, 2);
  assert.equal(queue.snapshot().jobs[0].status, 'completed');
  assert.equal(queue.snapshot().automaticBatch, null);
});

test('reopening a batch monitors the accepted shot before generating the remaining shot', async t => {
  const submitted = [], polled = [];
  const { queue, store } = storyFixture(t, { provider: {
    async submit(_modelId, prompt) { submitted.push(prompt); return { requestId: 'new-shot' }; },
    async poll(saved) { polled.push(saved.requestId); return ready; },
  } });
  const [job] = queue.addPrompts(['Whale story'], 'ltx2-story-free');
  store.mutate(state => {
    state.settings.automaticBatch = { jobIds: [job.id], retryAt: null };
    const item = state.jobs[0];
    item.status = 'queued';
    item.remote = { requestId: 'already-accepted' };
    item.segments[0].status = 'queued';
    item.segments[0].remote = item.remote;
  });
  queue.recover();
  await queue.waitForIdle();
  assert.deepEqual(polled, ['already-accepted', 'new-shot']);
  assert.deepEqual(submitted, [storyPlan().segments[1].prompt]);
  assert.equal(queue.snapshot().jobs[0].status, 'completed');
});

test('an ambiguous submission or failed poll clears automatic authorization without resubmission', async t => {
  for (const accepted of [false, true]) {
    const clock = fakeClock();
    let submits = 0;
    const { queue } = fixture(t, { retryClock: clock, provider: {
      async submit() { submits++; if (!accepted) throw new Error('Connection interrupted'); return remote; },
      async poll() { throw Object.assign(new Error('Monitoring was rate limited'), { httpStatus: 429, pauseQueue: true, retryAfterMs: 60_000 }); },
    } });
    const jobs = queue.addPrompts(['First', 'Second'], 'wan');
    queue.start({ approvedJobIds: jobs.map(job => job.id), automatic: true });
    await queue.waitForIdle();
    assert.equal(queue.snapshot().automaticBatch, null);
    assert.equal(queue.snapshot().jobs[0].status, 'needs_attention');
    assert.equal(queue.snapshot().jobs[0].remote?.requestId, accepted ? remote.requestId : undefined);
    clock.advance(86_400_000);
    await queue.waitForIdle();
    assert.equal(submits, 1);
    assert.equal(queue.snapshot().jobs[1].status, 'pending');
  }
});

test('manual pause cancels a pending automatic quota retry', async t => {
  const clock = fakeClock();
  let submits = 0;
  const { queue } = fixture(t, { retryClock: clock, provider: { async submit() {
    submits++;
    throw Object.assign(new Error('Rate limited'), { httpStatus: 429, retryAfterMs: 60_000 });
  } } });
  const [job] = queue.addPrompts(['A lake'], 'wan');
  queue.start({ approvedJobIds: [job.id], automatic: true });
  await queue.waitForIdle();
  assert.ok(queue.snapshot().nextRetryAt);
  queue.pause();
  clock.advance(60_000);
  await queue.waitForIdle();
  assert.equal(submits, 1);
  assert.equal(queue.snapshot().nextRetryAt, null);
  assert.equal(queue.snapshot().automaticBatch, null);
});

test('production audio is prepared before the first submission and saved only after success', async t => {
  const sequence = [];
  const { queue } = storyFixture(t, {
    planVideo: () => ({ ...storyPlan(), production: { narration: 'The rain comes softly.' } }),
    prepareVideo: async () => { sequence.push('prepare'); if (sequence.length === 1) throw new Error('Narration could not fit.'); },
    provider: { async submit() {
      assert.equal(queue.snapshot().jobs[0].prepared, true);
      sequence.push('submit');
      return remote;
    } },
  });
  const [job] = queue.addPrompts(['A rainy story'], 'ltx2-story-free');
  approve(queue);
  await queue.waitForIdle();
  assert.deepEqual(sequence, ['prepare']);
  assert.equal(queue.snapshot().jobs[0].phase, 'prepare_failed');
  assert.equal(queue.snapshot().jobs[0].prepared, undefined);
  queue.retry(job.id);
  approve(queue);
  await queue.waitForIdle();
  assert.deepEqual(sequence, ['prepare', 'prepare', 'submit', 'submit']);
  assert.equal(queue.snapshot().jobs[0].status, 'completed');
});
