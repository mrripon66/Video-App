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

test('400-prompt import is atomic, persistent, paused and capped independently of history', async t => {
  const { queue, calls, store } = fixture(t);
  queue.addPrompts(Array.from({ length: 400 }, (_, i) => `Prompt ${i + 1}`), 'wan');
  assert.equal(queue.snapshot().stats.active, 400);
  assert.equal(queue.snapshot().paused, true);
  assert.throws(() => queue.addPrompts(['Overflow'], 'wan'), /400/);
  assert.equal(store.snapshot().jobs.length, 400);
  const before = store.snapshot().revision;
  assert.throws(() => queue.addPrompts(['Valid', '  '], 'wan'), /Every/);
  assert.equal(store.snapshot().revision, before);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.submit, 0);
  await queue.cancel(queue.snapshot().jobs[0].id);
  queue.addPrompts(['Replacement'], 'wan');
  assert.equal(queue.snapshot().stats.active, 400);
  assert.equal(queue.snapshot().stats.total, 401);
});

test('exact reviewed IDs gate network calls and later additions are never included automatically', async t => {
  const gate = deferred();
  let submits = 0;
  const { queue } = fixture(t, { provider: { async submit() { submits++; await gate.promise; return remote; } } });
  const [first] = queue.addPrompts(['First'], 'wan');
  assert.throws(() => queue.start(), /Confirm/);
  assert.throws(() => queue.start({ approvedJobIds: [] }), /changed/);
  assert.throws(() => queue.start({ approvedJobIds: [first.id, first.id] }), /exact/);
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
  approve(restoredQueue);
  await restoredQueue.waitForIdle();
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
