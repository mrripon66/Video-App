'use strict';

const { randomUUID } = require('node:crypto');

const ACTIVE = new Set(['pending', 'submitting', 'queued', 'running', 'needs_attention']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const REMOTE_ACTIVE = new Set(['queued', 'running']);
const now = () => new Date().toISOString();
const detail = error => String(error && error.message || error || 'Unknown error').slice(0, 1200);

class Queue {
  constructor({ store, models, providerFactory, download, onChange = () => {}, pollIntervalMs = 5000, maxPollErrors = 3, maxJobDurationMs = 2 * 60 * 60 * 1000 }) {
    if (!store || typeof providerFactory !== 'function' || typeof download !== 'function') throw new Error('Queue storage, provider and downloader are required.');
    this.store = store;
    this.models = new Map(models.map(model => [model.id, model]));
    this.providerFactory = providerFactory;
    this.download = download;
    this.onChange = onChange;
    this.pollIntervalMs = pollIntervalMs;
    this.maxPollErrors = maxPollErrors;
    this.maxJobDurationMs = maxJobDurationMs;
    this.paused = true;
    this._approved = new Set();
    this._runner = null;
    this._activeId = null;
    this._disposed = false;
    this._waitResolve = null;
    this._downloads = new Set();
  }

  snapshot() {
    const state = this.store.snapshot();
    const stats = { total: state.jobs.length, active: 0, pending: 0, submitting: 0, queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0, needs_attention: 0 };
    for (const job of state.jobs) {
      stats[job.status]++;
      if (ACTIVE.has(job.status)) stats.active++;
    }
    return { ...state, paused: this.paused, running: !!this._runner, activeJobId: this._activeId, stats, recoveryWarning: this.store.recoveryWarning || null, queueError: this.queueError || null };
  }

  _emit() {
    try { this.onChange(this.snapshot()); } catch { /* A view cannot interrupt persistence. */ }
  }

  _update(id, fn) {
    this.store.mutate(state => {
      const job = state.jobs.find(item => item.id === id);
      if (!job) throw new Error('That queue item no longer exists.');
      fn(job);
      job.updatedAt = now();
    });
    this._emit();
  }

  _job(id) { return this.store.snapshot().jobs.find(job => job.id === id); }

  _model(id) {
    const model = this.models.get(id);
    if (!model || !model.available) throw new Error(model && model.reason || 'This model is unavailable. Choose an available remote model.');
    return model;
  }

  addPrompts(prompts, modelId) {
    this._model(modelId);
    if (!Array.isArray(prompts) || !prompts.length) throw new Error('Add at least one prompt.');
    const clean = prompts.map(prompt => {
      if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Every queue item needs a prompt.');
      if (prompt.trim().length > 10000) throw new Error('Each prompt must be 10,000 characters or fewer.');
      return prompt.trim();
    });
    const jobs = clean.map(prompt => ({ id: randomUUID(), prompt, modelId, status: 'pending', createdAt: now(), updatedAt: now(), attempts: [] }));
    this.store.mutate(state => {
      if (state.jobs.filter(job => ACTIVE.has(job.status)).length + jobs.length > 400) throw new Error('The queue holds up to 400 active prompts. Finish or cancel some prompts before adding more.');
      state.jobs.push(...jobs);
    });
    this._emit();
    return jobs;
  }

  recover() {
    this.paused = true;
    this._approved.clear();
    if (this._runner) throw new Error('Stop the queue before recovering saved jobs.');
    this.store.mutate(state => {
      for (const job of state.jobs) {
        if (this.store.recoveryWarning && ACTIVE.has(job.status) && !job.remote) {
          job.status = 'needs_attention';
          job.error = 'This queue was restored from a backup which may predate an accepted submission. Check the provider dashboard before manually retrying this prompt.';
          job.updatedAt = now();
        } else if (job.status === 'submitting') {
          if (job.remote && job.remote.requestId) job.status = 'queued';
          else {
            job.status = 'needs_attention';
            job.error = 'The app closed during submission. The provider may have accepted and charged for this request. Check your provider dashboard before retrying.';
          }
          job.updatedAt = now();
        } else if (REMOTE_ACTIVE.has(job.status) && !(job.remote && job.remote.requestId)) {
          job.status = 'needs_attention';
          job.error = 'The saved provider request is missing. Check your provider dashboard before retrying.';
          job.updatedAt = now();
        }
      }
    });
    this._emit();
    return this.snapshot();
  }

  start({ approvedJobIds } = {}) {
    if (this._disposed) throw new Error('The queue has closed. Restart the app to continue.');
    if (!Array.isArray(approvedJobIds) || approvedJobIds.some(id => typeof id !== 'string') || new Set(approvedJobIds).size !== approvedJobIds.length) throw new Error('Confirm the exact pending queue before starting.');
    const pending = this.store.snapshot().jobs.filter(job => job.status === 'pending');
    const approved = new Set(approvedJobIds);
    if (pending.length !== approved.size || pending.some(job => !approved.has(job.id))) throw new Error('The queue changed. Review and confirm the current pending prompts again.');
    for (const job of pending) this._model(job.modelId);
    // Constructing providers only checks local credentials; it must not submit work.
    for (const modelId of new Set(pending.map(job => job.modelId))) this.providerFactory(this._model(modelId));
    this.queueError = null;
    this._approved = approved;
    this.paused = false;
    this._ensureRunner();
    this._emit();
    return this.snapshot();
  }

  pause() {
    this.paused = true;
    this._approved.clear();
    this._emit();
    return this.snapshot();
  }

  _ensureRunner() {
    if (this._runner) return;
    // Defer the first operation so running=true is visible consistently during callbacks.
    this._runner = Promise.resolve().then(() => this._run()).catch(error => {
      this.paused = true;
      this._approved.clear();
      if (this._activeId) {
        try { this._update(this._activeId, job => { job.status = 'needs_attention'; job.error = `The queue stopped safely: ${detail(error)}`; }); } catch { /* Disk failures are reported through queueError. */ }
      }
      this.queueError = detail(error);
    }).finally(() => {
      this._runner = null;
      this._activeId = null;
      this.paused = true;
      this._approved.clear();
      this._emit();
    });
  }

  async _run() {
    while (!this._disposed) {
      const jobs = this.store.snapshot().jobs;
      let job = jobs.find(item => REMOTE_ACTIVE.has(item.status) && item.remote);
      if (!job && !this.paused) job = jobs.find(item => item.status === 'pending' && this._approved.has(item.id));
      if (!job) return;
      this._activeId = job.id;
      await this._process(job);
      this._activeId = null;
    }
  }

  async _process(initial) {
    const executionVersion = initial.executionVersion || 0;
    const stillCurrent = () => {
      const current = this._job(initial.id);
      return current && (current.executionVersion || 0) === executionVersion;
    };
    let provider;
    try { provider = this.providerFactory(this._model(initial.modelId)); }
    catch (error) {
      this._update(initial.id, job => { job.status = job.remote ? 'needs_attention' : 'failed'; job.error = detail(error); });
      return;
    }
    if (initial.status === 'pending') {
      if (this.paused || !this._approved.delete(initial.id)) return;
      this._update(initial.id, job => { job.status = 'submitting'; job.startedAt = now(); delete job.error; });
      let remote;
      try {
        remote = await provider.submit(initial.modelId, initial.prompt);
        if (!remote || typeof remote.requestId !== 'string' || !remote.requestId) throw new Error('The provider accepted no usable request reference.');
      } catch (error) {
        if ([401, 402, 403, 429].includes(error.httpStatus)) {
          this.paused = true;
          this._approved.clear();
        }
        this._update(initial.id, job => {
          const definitive = error.submissionUncertain === false || (Number.isInteger(error.httpStatus) && error.httpStatus >= 400 && error.httpStatus < 500 && error.httpStatus !== 408);
          job.status = definitive ? 'failed' : 'needs_attention';
          job.error = definitive ? detail(error) : `Submission outcome is unknown. The provider may have accepted and charged for this request. Check its dashboard before retrying. ${detail(error)}`;
        });
        return;
      }
      this._update(initial.id, job => { job.remote = remote; job.status = 'queued'; });
      if (this._job(initial.id).cancelRequested) await this._cancelRemote(initial.id, provider);
    }

    let errors = 0;
    const pollStarted = Date.now();
    while (!this._disposed) {
      const current = this._job(initial.id);
      if (!current || !REMOTE_ACTIVE.has(current.status)) return;
      if (Date.now() - pollStarted > this.maxJobDurationMs) {
        this._update(current.id, job => { job.status = 'needs_attention'; job.error = 'Provider monitoring timed out. The saved request can be resumed without submitting again.'; });
        return;
      }
      let result;
      try {
        result = await provider.poll(current.remote);
        if (!result || !['queued', 'running', 'completed', 'failed', 'cancelled'].includes(result.status)) throw new Error('The provider returned an unknown request status.');
        errors = 0;
      } catch (error) {
        if (!stillCurrent() || TERMINAL.has(this._job(current.id).status)) return;
        errors++;
        if (errors >= this.maxPollErrors) {
          this._update(current.id, job => { job.status = 'needs_attention'; job.error = `Could not monitor the provider. The request is saved; resume it without paying for another submission. ${detail(error)}`; });
          return;
        }
        await this._wait();
        continue;
      }
      // A cancel response may have won the race while polling was in flight.
      if (!stillCurrent() || TERMINAL.has(this._job(current.id).status)) return;
      if (result.status === 'completed') {
        if (typeof result.videoUrl !== 'string' || !result.videoUrl) {
          this._update(current.id, job => { job.status = 'needs_attention'; job.error = 'The provider reports completion but returned no video. Check its dashboard; do not resubmit to retrieve this output.'; });
          return;
        }
        this._update(current.id, job => { job.remoteVideoUrl = result.videoUrl; job.phase = 'downloading'; });
        await this._download(current.id);
        return;
      }
      if (result.status === 'failed' || result.status === 'cancelled') {
        this._update(current.id, job => {
          job.status = result.status;
          if (result.status === 'cancelled') job.cancellation = 'confirmed';
          job.error = result.error || (result.status === 'failed' ? 'The provider could not generate this video.' : 'The provider confirmed cancellation.');
          job.completedAt = now();
        });
        return;
      }
      if (current.status !== result.status) this._update(current.id, job => { job.status = result.status; });
      await this._wait();
    }
  }

  async _download(id) {
    if (this._downloads.has(id)) throw new Error('This video is already being downloaded.');
    this._downloads.add(id);
    const job = this._job(id);
    try {
      const videoPath = await this.download(job.remoteVideoUrl, id);
      if (typeof videoPath !== 'string' || !videoPath) throw new Error('The downloaded video file was not saved.');
      this._update(id, item => { item.videoPath = videoPath; item.status = 'completed'; item.completedAt = now(); delete item.error; delete item.phase; });
    } catch (error) {
      // Preserve the paid output and stop before paying for more videos that
      // may also be impossible to save (for example, when the disk is full).
      this.paused = true;
      this._approved.clear();
      this._update(id, item => { item.status = 'needs_attention'; item.phase = 'download_failed'; item.error = `Your provider output is ready, but saving it failed. Retry the download without generating again. ${detail(error)}`; });
    } finally { this._downloads.delete(id); }
  }

  async cancel(id) {
    const job = this._job(id);
    if (!job) throw new Error('That queue item does not exist.');
    if (TERMINAL.has(job.status)) throw new Error('That item has already finished.');
    this._approved.delete(id);
    if (!job.remote && job.status !== 'submitting') {
      this._update(id, item => { item.status = 'cancelled'; item.cancellation = 'local'; item.completedAt = now(); });
    } else {
      this._update(id, item => { item.cancelRequested = true; item.cancellation = 'requested'; });
      if (job.remote) {
        try { await this._cancelRemote(id, this.providerFactory(this._model(job.modelId))); }
        catch (error) { this._update(id, item => { item.cancellationError = `Cancellation could not be confirmed. The provider may continue and charge for the request. ${detail(error)}`; }); }
      }
    }
    return this.snapshot();
  }

  async _cancelRemote(id, provider) {
    const job = this._job(id);
    if (!job || !job.remote || TERMINAL.has(job.status)) return;
    try {
      const result = await provider.cancel(job.remote);
      this._update(id, item => {
        if (TERMINAL.has(item.status)) return;
        if (!item.remote || item.remote.requestId !== job.remote.requestId) return;
        if (result && (result.cancelled === true || result.status === 'cancelled')) {
          item.status = 'cancelled';
          item.cancellation = 'confirmed';
          item.completedAt = now();
        } else item.cancellation = 'requested';
      });
    } catch (error) {
      this._update(id, item => {
        if (!item.remote || item.remote.requestId !== job.remote.requestId) return;
        item.cancellationError = `Cancellation could not be confirmed. The provider may continue and charge for the request. ${detail(error)}`;
      });
    }
  }

  retry(id) {
    const job = this._job(id);
    if (!job || !['failed', 'cancelled', 'needs_attention'].includes(job.status)) throw new Error('Only failed, cancelled or attention-needed prompts can be retried.');
    this._model(job.modelId);
    if (job.remoteVideoUrl) throw new Error('This video is already generated. Retry its download instead.');
    if (job.remote && job.status === 'needs_attention') throw new Error('This request can be resumed without another submission. Use Resume monitoring.');
    if (this.store.snapshot().jobs.filter(item => ACTIVE.has(item.status)).length >= 400 && !ACTIVE.has(job.status)) throw new Error('The active queue is full.');
    this._approved.delete(id);
    this._update(id, item => {
      item.attempts = [...(item.attempts || []), { status: item.status, remote: item.remote || null, error: item.error || null, endedAt: now(), cancellation: item.cancellation || null }];
      item.status = 'pending';
      item.executionVersion = (item.executionVersion || 0) + 1;
      for (const field of ['remote', 'error', 'completedAt', 'startedAt', 'cancelRequested', 'cancellation', 'cancellationError', 'phase']) delete item[field];
    });
    return this.snapshot();
  }

  resume(id) {
    const job = this._job(id);
    if (!job || job.status !== 'needs_attention' || !job.remote) throw new Error('No saved provider request is available to resume.');
    if (job.remoteVideoUrl) throw new Error('Retry the saved video download instead.');
    this._model(job.modelId);
    this._update(id, item => { item.status = 'queued'; delete item.error; });
    this._ensureRunner();
    return this.snapshot();
  }

  async retryDownload(id) {
    if (this._downloads.has(id)) throw new Error('This video is already being downloaded.');
    const job = this._job(id);
    if (!job || job.status !== 'needs_attention' || !job.remoteVideoUrl) throw new Error('There is no saved provider output to download again.');
    this._update(id, item => { item.phase = 'downloading'; });
    await this._download(id);
    return this.snapshot();
  }

  _wait() {
    if (this._disposed || this.pollIntervalMs <= 0) return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimeout(() => { this._waitResolve = null; resolve(); }, this.pollIntervalMs);
      this._waitResolve = () => { clearTimeout(timer); this._waitResolve = null; resolve(); };
    });
  }

  async waitForIdle() { if (this._runner) await this._runner; }

  async dispose() {
    this.pause();
    this._disposed = true;
    if (this._waitResolve) this._waitResolve();
    await this.waitForIdle();
  }
}

module.exports = { Queue, ACTIVE };
