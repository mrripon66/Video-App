'use strict';

const { randomUUID } = require('node:crypto');
const path = require('node:path');

const ACTIVE = new Set(['pending', 'submitting', 'queued', 'running', 'needs_attention']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const REMOTE_ACTIVE = new Set(['queued', 'running']);
const ACTIVE_LIMIT = 500;
const MIN_RETRY_MS = 60 * 1000;
const DEFAULT_RETRY_MS = 24 * 60 * 60 * 1000;
const now = () => new Date().toISOString();
const detail = error => String(error && error.message || error || 'Unknown error').slice(0, 1200);

function validateVideoPlan(plan) {
  if (!plan || !Number.isFinite(plan.durationSeconds) || plan.durationSeconds < 15 || plan.durationSeconds > 20 ||
    (plan.orientation !== undefined && plan.orientation !== 'portrait') ||
    Math.abs(plan.durationSeconds * 10 - Math.round(plan.durationSeconds * 10)) > 1e-7 ||
    !Array.isArray(plan.segments) || plan.segments.length !== 2 ||
    plan.segments.some(segment => !segment || typeof segment.prompt !== 'string' || !segment.prompt.trim() || segment.prompt.length > 10000 ||
      !Number.isFinite(segment.durationSeconds) || segment.durationSeconds < 1 || segment.durationSeconds > 10 ||
      Math.abs(segment.durationSeconds * 10 - Math.round(segment.durationSeconds * 10)) > 1e-7) ||
    Math.abs(plan.segments.reduce((sum, segment) => sum + segment.durationSeconds, 0) - plan.durationSeconds) > 1e-6) {
    throw new Error('The saved long-video plan is invalid. No generation request was sent.');
  }
  return plan;
}

function storyContext(plan) {
  return plan.orientation === 'portrait' ? { purpose: 'story', orientation: 'portrait' } : { purpose: 'story' };
}

function automaticBatch(settings) {
  const batch = settings.automaticBatch;
  if (!batch || !Array.isArray(batch.jobIds) || !batch.jobIds.length || batch.jobIds.length > ACTIVE_LIMIT ||
    batch.jobIds.some(id => typeof id !== 'string' || !id) || new Set(batch.jobIds).size !== batch.jobIds.length ||
    (batch.retryAt !== null && (!Number.isSafeInteger(batch.retryAt) || batch.retryAt <= 0))) return null;
  return batch;
}

class Queue {
  constructor({ store, models, providerFactory, download, planVideo = () => null, composeVideo, prepareVideo,
    onChange = () => {}, pollIntervalMs = 5000, maxPollErrors = 3, maxJobDurationMs = 2 * 60 * 60 * 1000,
    retryClock = { now: Date.now, setTimeout, clearTimeout } }) {
    if (!store || typeof providerFactory !== 'function' || typeof download !== 'function') throw new Error('Queue storage, provider and downloader are required.');
    this.store = store;
    this.models = new Map(models.map(model => [model.id, model]));
    this.providerFactory = providerFactory;
    this.download = download;
    this.planVideo = planVideo;
    this.composeVideo = composeVideo;
    this.prepareVideo = prepareVideo;
    this.retryClock = retryClock;
    this._retryTimer = null;
    this.onChange = onChange;
    this.pollIntervalMs = pollIntervalMs;
    this.maxPollErrors = maxPollErrors;
    this.maxJobDurationMs = maxJobDurationMs;
    this.paused = true;
    this._approved = new Set();
    this._monitored = new Set();
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
    const batch = automaticBatch(state.settings);
    return { ...state, paused: this.paused, running: !!this._runner, activeJobId: this._activeId, stats, automaticBatch: batch,
      nextRetryAt: batch?.retryAt ?? null, recoveryWarning: this.store.recoveryWarning || null, queueError: this.queueError || null };
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

  addPrompts(prompts, modelId, { autoExportDirectory } = {}) {
    this._model(modelId);
    if (autoExportDirectory !== undefined && (typeof autoExportDirectory !== 'string' ||
      !path.isAbsolute(autoExportDirectory) || autoExportDirectory.includes('\0'))) {
      throw new Error('Choose an automatic export folder first.');
    }
    if (!Array.isArray(prompts) || !prompts.length) throw new Error('Add at least one prompt.');
    const clean = prompts.map(prompt => {
      if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Every queue item needs a prompt.');
      if (prompt.trim().length > 10000) throw new Error('Each prompt must be 10,000 characters or fewer.');
      return prompt.trim();
    });
    const jobs = clean.map(prompt => {
      const videoPlan = this.planVideo(modelId, prompt);
      if (videoPlan) {
        validateVideoPlan(videoPlan);
        this._model('ltx2-free');
        if (typeof this.composeVideo !== 'function') throw new Error('Long-video assembly is unavailable. No prompts were added.');
        if (videoPlan.production && typeof this.prepareVideo !== 'function') throw new Error('Local sound preparation is unavailable. No prompts were added.');
      }
      return { id: randomUUID(), prompt, modelId, status: 'pending', createdAt: now(), updatedAt: now(), attempts: [],
        ...(autoExportDirectory ? { autoExport: { directory: autoExportDirectory, status: 'pending' } } : {}),
        ...(videoPlan ? { videoPlan, segments: videoPlan.segments.map(segment => ({ ...segment, status: 'pending' })), segmentIndex: 0 } : {}) };
    });
    this.store.mutate(state => {
      if (state.jobs.filter(job => ACTIVE.has(job.status)).length + jobs.length > ACTIVE_LIMIT) throw new Error(`The queue holds up to ${ACTIVE_LIMIT} active prompts. Finish or cancel some prompts before adding more.`);
      state.jobs.push(...jobs);
    });
    this._emit();
    return jobs;
  }

  recover() {
    this._clearRetryTimer();
    this.paused = true;
    this._approved.clear();
    this._monitored.clear();
    if (this._runner) throw new Error('Stop the queue before recovering saved jobs.');
    this.store.mutate(state => {
      for (const job of state.jobs) {
        if (job.videoPlan && ACTIVE.has(job.status)) {
          this._recoverStory(job);
        } else if (ACTIVE.has(job.status) && typeof job.remoteVideoUrl === 'string' && job.remoteVideoUrl) {
          // Completion event streams may not replay after a restart. Once the
          // output address is saved, recover the file directly instead of
          // reopening that stream or creating another generation request.
          job.status = 'needs_attention';
          job.phase = 'download_failed';
          job.error = 'This generated video has a saved output address, but its download was interrupted. Retry the saved download without submitting or monitoring the provider again.';
          job.updatedAt = now();
        } else if (this.store.recoveryWarning && ACTIVE.has(job.status) && !job.remote) {
          job.status = 'needs_attention';
          job.error = 'This queue was restored from a backup which may predate an accepted submission. Check the provider dashboard before manually retrying this prompt.';
          job.updatedAt = now();
        } else if (job.status === 'submitting') {
          if (job.remote && job.remote.requestId) job.status = 'queued';
          else {
            job.status = 'needs_attention';
            job.error = 'The app closed during submission. The provider may have accepted this request and used your quota. Check its saved progress before retrying.';
          }
          job.updatedAt = now();
        } else if (REMOTE_ACTIVE.has(job.status) && !(job.remote && job.remote.requestId)) {
          job.status = 'needs_attention';
          job.error = 'The saved provider request is missing. Check your provider dashboard before retrying.';
          job.updatedAt = now();
        }
      }
      if (this.store.recoveryWarning || !automaticBatch(state.settings)) delete state.settings.automaticBatch;
    });
    this._resumeAutomatic();
    this._emit();
    return this.snapshot();
  }

  start({ approvedJobIds, automatic = false } = {}) {
    if (this._disposed) throw new Error('The queue has closed. Restart the app to continue.');
    if (!Array.isArray(approvedJobIds) || approvedJobIds.some(id => typeof id !== 'string')) throw new Error('Select pending prompt IDs before generating.');
    if (new Set(approvedJobIds).size !== approvedJobIds.length) throw new Error('Select each pending prompt only once.');
    const saved = this.store.snapshot();
    const jobs = saved.jobs;
    const pending = jobs.filter(job => job.status === 'pending');
    const byId = new Map(pending.map(job => [job.id, job]));
    const approved = new Set(approvedJobIds);
    if (approvedJobIds.some(id => !byId.has(id))) throw new Error('A selected prompt is missing or no longer pending. Refresh the queue and try again.');
    if (automatic && !approved.size) throw new Error('Select pending prompts for the automatic batch.');
    const batch = automaticBatch(saved.settings);
    if (approved.size && batch) throw new Error('Pause the current automatic batch before starting other videos.');
    if (automatic && this._runner) throw new Error('Wait for the current video to finish before starting an automatic batch.');
    if (!approved.size && !jobs.some(job => REMOTE_ACTIVE.has(job.status) && job.remote)) throw new Error('There are no saved provider requests to monitor. Select pending prompts to generate.');
    const selected = approvedJobIds.map(id => byId.get(id));
    for (const job of selected) this._model(job.modelId);
    // Constructing providers performs local validation only, never submission.
    const checkedProviders = new Set();
    for (const job of selected) {
      const modelId = job.videoPlan ? 'ltx2-free' : job.modelId;
      const context = job.videoPlan ? storyContext(job.videoPlan) : undefined;
      const key = `${modelId}:${context?.purpose || 'clip'}:${context?.orientation || ''}`;
      if (checkedProviders.has(key)) continue;
      checkedProviders.add(key);
      if (context) this.providerFactory(this._model(modelId), context);
      else this.providerFactory(this._model(modelId));
    }
    if (automatic) this.store.mutate(state => { state.settings.automaticBatch = { jobIds: approvedJobIds, retryAt: null }; });
    this.queueError = null;
    // A new Generate click adds only its selected jobs. Existing unrelated
    // pending work receives no permission. Only an explicitly started automatic
    // batch survives a restart.
    if (this.paused) this._approved.clear();
    for (const id of approved) this._approved.add(id);
    if (approved.size) this.paused = false;
    else {
      for (const job of jobs) {
        if (REMOTE_ACTIVE.has(job.status) && job.remote) this._monitored.add(job.id);
      }
    }
    this._ensureRunner();
    this._emit();
    return this.snapshot();
  }

  pause() {
    this._hold();
    this._emit();
    return this.snapshot();
  }

  _clearRetryTimer() {
    if (this._retryTimer !== null) this.retryClock.clearTimeout(this._retryTimer);
    this._retryTimer = null;
  }

  _hold(preserveAutomatic = false) {
    this.paused = true;
    this._approved.clear();
    this._clearRetryTimer();
    if (!preserveAutomatic && Object.hasOwn(this.store.snapshot().settings, 'automaticBatch')) {
      this.store.mutate(state => { delete state.settings.automaticBatch; });
    }
  }

  _resumeAutomatic() {
    this._clearRetryTimer();
    if (this._disposed) return;
    const state = this.store.snapshot();
    const batch = automaticBatch(state.settings);
    if (!batch) return;
    const selected = state.jobs.filter(job => batch.jobIds.includes(job.id) && !['completed', 'cancelled'].includes(job.status));
    if (!selected.length || selected.some(job => job.status !== 'pending' && !(REMOTE_ACTIVE.has(job.status) && job.remote))) {
      this._hold();
      return;
    }
    const wait = (batch.retryAt ?? 0) - this.retryClock.now();
    if (wait > 0) {
      this._retryTimer = this.retryClock.setTimeout(() => {
        this._retryTimer = null;
        try { this._resumeAutomatic(); }
        catch (error) { this.paused = true; this._approved.clear(); this.queueError = detail(error); }
        this._emit();
      }, Math.min(wait, 2147483647));
      this._retryTimer?.unref?.();
      return;
    }
    if (batch.retryAt !== null) this.store.mutate(value => { value.settings.automaticBatch.retryAt = null; });
    this.paused = false;
    for (const job of selected) {
      if (job.status === 'pending') this._approved.add(job.id);
      else this._monitored.add(job.id);
    }
    this._ensureRunner();
  }

  _deferAutomatic(id, reason, index = null) {
    const batch = automaticBatch(this.store.snapshot().settings);
    if (!batch?.jobIds.includes(id) || this._job(id)?.cancelRequested) return false;
    const delay = Number.isSafeInteger(reason.retryAfterMs) && reason.retryAfterMs >= 0
      ? Math.max(MIN_RETRY_MS, reason.retryAfterMs) : DEFAULT_RETRY_MS;
    const retryAt = this.retryClock.now() + delay;
    if (!Number.isSafeInteger(retryAt)) return false;
    this._hold(true);
    this._monitored.delete(id);
    this.store.mutate(state => {
      const job = state.jobs.find(item => item.id === id);
      const message = 'Free GPU quota is unavailable. This automatic batch will wait before trying again.';
      const reset = item => {
        item.attempts = [...(item.attempts || []), { status: 'failed', remote: item.remote || null, error: detail(reason.error || reason), endedAt: now() }];
        item.status = 'pending';
        for (const field of ['remote', 'remoteVideoUrl', 'error', 'startedAt', 'completedAt']) delete item[field];
      };
      reset(job);
      if (index !== null) reset(job.segments[index]);
      job.phase = 'waiting_quota'; job.error = message; job.updatedAt = now();
      state.settings.automaticBatch.retryAt = retryAt;
    });
    this._emit();
    return true;
  }

  _automaticOwns(id) {
    return automaticBatch(this.store.snapshot().settings)?.jobIds.includes(id) === true;
  }

  _ensureRunner() {
    if (this._runner) return;
    let runnerFailed = false;
    // Defer the first operation so running=true is visible consistently during callbacks.
    this._runner = Promise.resolve().then(() => this._run()).catch(error => {
      runnerFailed = true;
      try { this._hold(); } catch { /* The queue still stops in memory if the disk is unavailable. */ }
      if (this._activeId) {
        try { this._update(this._activeId, job => { job.status = 'needs_attention'; job.error = `The queue stopped safely: ${detail(error)}`; }); } catch { /* Disk failures are reported through queueError. */ }
      }
      this.queueError = detail(error);
    }).finally(() => {
      this._runner = null;
      this._activeId = null;
      const state = this.store.snapshot();
      const jobs = state.jobs;
      const pendingIds = new Set(jobs.filter(job => job.status === 'pending').map(job => job.id));
      this._approved = new Set([...this._approved].filter(id => pendingIds.has(id)));
      const remoteIds = new Set(jobs.filter(job => REMOTE_ACTIVE.has(job.status) && job.remote).map(job => job.id));
      this._monitored = new Set([...this._monitored].filter(id => remoteIds.has(id)));
      // Generate/resume can arrive after _run's final scan but before this
      // finalizer. Start a successor instead of losing that explicit action.
      const hasWork = this._hasRunnable(jobs);
      if (!runnerFailed && !this._disposed && hasWork) this._ensureRunner();
      else {
        const waiting = automaticBatch(state.settings)?.retryAt != null;
        this._hold(this._disposed || (!runnerFailed && waiting));
        if (!this._disposed && waiting && !runnerFailed) this._resumeAutomatic();
      }
      this._emit();
    });
  }

  async _run() {
    while (!this._disposed) {
      const jobs = this.store.snapshot().jobs;
      let job = jobs.find(item => REMOTE_ACTIVE.has(item.status) && item.remote && this._monitored.has(item.id));
      if (!job && !this.paused) job = jobs.find(item => item.status === 'pending' && this._approved.has(item.id));
      if (!job) return;
      this._activeId = job.id;
      await this._process(job);
      const outcome = this._job(job.id);
      if (!this._disposed && this._automaticOwns(job.id) && ['failed', 'needs_attention'].includes(outcome?.status)) this._hold();
      this._activeId = null;
    }
  }

  _hasRunnable(jobs) {
    return jobs.some(job => REMOTE_ACTIVE.has(job.status) && job.remote && this._monitored.has(job.id)) ||
      (!this.paused && jobs.some(job => job.status === 'pending' && this._approved.has(job.id)));
  }

  _storyIndex(job) { return job.segments.findIndex(segment => !segment.videoPath); }

  _validateStory(job) {
    validateVideoPlan(job.videoPlan);
    if (job.modelId !== 'ltx2-story-free' || !Array.isArray(job.segments) || job.segments.length !== job.videoPlan.segments.length ||
      job.segments.some((segment, index) => !segment || segment.prompt !== job.videoPlan.segments[index].prompt ||
        segment.durationSeconds !== job.videoPlan.segments[index].durationSeconds ||
        (!ACTIVE.has(segment.status) && !TERMINAL.has(segment.status)) ||
        (segment.status === 'completed' && (typeof segment.videoPath !== 'string' || !segment.videoPath.trim())) ||
        (segment.videoPath !== undefined && (typeof segment.videoPath !== 'string' || !segment.videoPath.trim() || segment.status !== 'completed')) ||
        (index > 0 && segment.videoPath && !job.segments[index - 1].videoPath))) {
      throw new Error('The saved long-video progress is invalid. No generation request was sent.');
    }
  }

  _recoverStory(job) {
    try { this._validateStory(job); }
    catch (error) { job.status = 'needs_attention'; job.error = detail(error); job.phase = 'invalid_plan'; return; }
    const index = this._storyIndex(job);
    job.updatedAt = now();
    if (index === -1) {
      job.status = 'needs_attention'; job.phase = 'compose_failed';
      job.error = 'Your generated shots are saved. Recover to finish joining them without generating again.';
      delete job.remote; delete job.remoteVideoUrl;
      return;
    }
    job.segmentIndex = index;
    const segment = job.segments[index];
    if (segment.status === 'failed' || segment.status === 'cancelled') {
      job.status = segment.status; job.phase = 'generating';
      job.error = segment.error || 'This shot ended without a video. Retry the unfinished shot; saved shots will be kept.';
      if (segment.remote) job.remote = segment.remote;
      else delete job.remote;
      delete job.remoteVideoUrl;
    } else if (segment.remoteVideoUrl) {
      job.remoteVideoUrl = segment.remoteVideoUrl;
      if (segment.remote) job.remote = segment.remote;
      job.status = 'needs_attention'; job.phase = 'download_failed';
      job.error = 'This generated shot has a saved output address. Recover its download without generating again.';
    } else if (segment.remote?.requestId && REMOTE_ACTIVE.has(segment.status)) {
      job.remote = segment.remote;
      delete job.remoteVideoUrl;
      job.status = 'queued'; job.phase = 'generating';
    } else if (segment.status === 'submitting' || REMOTE_ACTIVE.has(segment.status) ||
      (segment.status === 'needs_attention' && job.phase === 'submission_uncertain')) {
      job.status = 'needs_attention'; job.phase = 'submission_uncertain';
      job.error = 'The app closed while this shot was being submitted. It may have used your free quota. Check before explicitly retrying; saved shots will be kept.';
    } else if (this.store.recoveryWarning) {
      job.status = 'needs_attention'; job.phase = 'submission_uncertain';
      job.error = 'The restored backup may predate an accepted shot. Check before explicitly retrying; saved shots will be kept.';
    } else {
      delete job.remote; delete job.remoteVideoUrl;
      job.status = 'pending';
      if (job.phase !== 'waiting_quota') job.phase = 'story_paused';
    }
  }

  async _processStory(initial) {
    const version = initial.executionVersion || 0;
    const current = () => {
      const job = this._job(initial.id);
      return job && (job.executionVersion || 0) === version && !TERMINAL.has(job.status) ? job : null;
    };
    try { this._validateStory(initial); }
    catch (error) {
      this._update(initial.id, job => { job.status = 'needs_attention'; job.phase = 'invalid_plan'; job.error = detail(error); });
      return;
    }
    let allowSubmission = !this.paused && this._automaticOwns(initial.id);
    if (initial.status === 'pending') {
      if (this.paused || !this._approved.delete(initial.id)) return;
      allowSubmission = true;
    }
    let provider;
    try { provider = this.providerFactory(this._model('ltx2-free'), storyContext(initial.videoPlan)); }
    catch (error) {
      this._update(initial.id, job => { job.status = 'needs_attention'; job.error = detail(error); });
      return;
    }
    while (!this._disposed && current()) {
      const job = current();
      const index = this._storyIndex(job);
      if (index === -1) { await this._composeStory(job.id); return; }
      const segment = job.segments[index];
      if (segment.status === 'failed' || segment.status === 'cancelled') {
        // A provider's terminal stream must never be opened again by a
        // monitoring recovery. Retry explicitly resets this unfinished shot.
        this._update(job.id, item => { item.status = segment.status; item.error = segment.error || 'Retry the unfinished shot; saved shots will be kept.'; });
        return;
      }
      if (segment.remoteVideoUrl) {
        if (!(await this._downloadStoryPart(job.id, index))) return;
        continue;
      }
      if (!segment.remote) {
        if (job.cancelRequested) {
          this._update(job.id, item => { item.status = 'cancelled'; item.cancellation = 'local'; item.completedAt = now(); });
          return;
        }
        if (!allowSubmission || this.paused) {
          this._update(job.id, item => { item.status = 'pending'; item.phase = 'story_paused'; delete item.remote; delete item.remoteVideoUrl; });
          return;
        }
        if (job.videoPlan.production && !job.prepared) {
          this._update(job.id, item => { item.status = 'running'; item.phase = 'preparing'; delete item.error; });
          try {
            if (typeof this.prepareVideo !== 'function') throw new Error('Local sound preparation is unavailable.');
            await this.prepareVideo(job);
          } catch (error) {
            if (current()) this._update(job.id, item => { item.status = 'failed'; item.phase = 'prepare_failed'; item.error = detail(error); });
            return;
          }
          if (!current()) return;
          this._update(job.id, item => { item.prepared = true; });
          continue;
        }
        this._update(job.id, item => {
          item.segmentIndex = index; item.status = 'submitting'; item.phase = 'generating';
          item.startedAt ||= now(); delete item.error;
          item.segments[index].status = 'submitting';
        });
        let remote;
        try {
          remote = await provider.submit('ltx2-free', segment.prompt);
          if (!remote || typeof remote.requestId !== 'string' || !remote.requestId) throw new Error('The provider accepted no usable request reference.');
        } catch (error) {
          if (!current()) return;
          const definitive = error.submissionUncertain === false || (Number.isInteger(error.httpStatus) && error.httpStatus >= 400 && error.httpStatus < 500 && error.httpStatus !== 408);
          if (error.httpStatus === 429 && error.submissionUncertain !== true && this._deferAutomatic(job.id, error, index)) return;
          if (error.pauseQueue || [401, 402, 403, 429].includes(error.httpStatus)) this.pause();
          this._update(job.id, item => {
            item.status = definitive ? 'failed' : 'needs_attention';
            item.phase = definitive ? 'generating' : 'submission_uncertain';
            item.error = definitive ? detail(error) : `Submission outcome is unknown. Check before retrying this shot. Saved shots will be kept. ${detail(error)}`;
            item.segments[index].status = item.status; item.segments[index].error = item.error;
          });
          return;
        }
        if (!current()) return;
        this._monitored.add(job.id);
        this._update(job.id, item => {
          item.remote = remote; item.status = 'queued';
          item.segments[index].remote = remote; item.segments[index].status = 'queued';
        });
        if (current()?.cancelRequested) await this._cancelRemote(job.id, provider);
      }
      let errors = 0;
      const pollStarted = Date.now();
      while (!this._disposed && current()) {
        const accepted = current();
        if (Date.now() - pollStarted > this.maxJobDurationMs) {
          this._update(job.id, item => { item.status = 'needs_attention'; item.error = 'Monitoring timed out. Resume this saved shot without submitting again.'; });
          return;
        }
        let result;
        try {
          result = await provider.poll(accepted.remote);
          if (!result || !['queued', 'running', 'completed', 'failed', 'cancelled'].includes(result.status)) throw new Error('The provider returned an unknown request status.');
          errors = 0;
        } catch (error) {
          if (!current()) return;
          if (error.pauseQueue || ++errors >= this.maxPollErrors) {
            if (error.pauseQueue) this.pause();
            this._update(job.id, item => { item.status = 'needs_attention'; item.error = `Resume monitoring this saved shot without submitting again. ${detail(error)}`; });
            return;
          }
          await this._wait(); continue;
        }
        if (!current()) return;
        if (result.status === 'completed') {
          if (typeof result.videoUrl !== 'string' || !result.videoUrl) {
            this._update(job.id, item => { item.status = 'needs_attention'; item.error = 'The provider returned no video. Check this saved request before retrying.'; });
            return;
          }
          this._update(job.id, item => {
            item.remoteVideoUrl = result.videoUrl; item.phase = 'downloading';
            item.segments[index].remoteVideoUrl = result.videoUrl;
          });
          if (!(await this._downloadStoryPart(job.id, index))) return;
          break;
        }
        if (result.status === 'failed' || result.status === 'cancelled') {
          if (result.status === 'failed' && result.quotaBlocked === true && this._deferAutomatic(job.id, result, index)) return;
          if (result.pauseQueue) this.pause();
          this._update(job.id, item => {
            item.status = result.status; item.segments[index].status = result.status;
            item.error = result.error || 'The provider could not finish this shot. Saved shots will be kept.';
            item.segments[index].error = item.error;
            if (result.status === 'cancelled') item.cancellation = 'confirmed';
          });
          return;
        }
        if (accepted.status !== result.status) this._update(job.id, item => { item.status = result.status; item.segments[index].status = result.status; });
        await this._wait();
      }
      // An unconfirmed cancellation may still return a useful shot, but never
      // authorizes another shot after the current download has been preserved.
      if (current()?.cancelRequested) {
        this._update(job.id, item => { item.status = 'cancelled'; item.cancellation = 'local'; item.completedAt = now(); });
        return;
      }
    }
  }

  async _downloadStoryPart(id, index) {
    if (this._downloads.has(id)) throw new Error('This video is already being downloaded.');
    this._downloads.add(id);
    const job = this._job(id);
    const version = job.executionVersion || 0;
    try {
      const videoPath = await this.download(job.segments[index].remoteVideoUrl, `${id}-part-${index + 1}`);
      if (typeof videoPath !== 'string' || !videoPath) throw new Error('The generated shot was not saved.');
      if ((this._job(id).executionVersion || 0) !== version) return false;
      this._update(id, item => {
        Object.assign(item.segments[index], { videoPath, status: 'completed', completedAt: now() });
        delete item.segments[index].error;
        if (!TERMINAL.has(item.status)) {
          item.status = 'running'; item.phase = 'generating'; item.segmentIndex = index + 1;
          delete item.remote; delete item.remoteVideoUrl; delete item.error;
        }
      });
      return !TERMINAL.has(this._job(id).status);
    } catch (error) {
      if ((this._job(id).executionVersion || 0) !== version || TERMINAL.has(this._job(id).status)) return false;
      this.pause();
      this._update(id, item => {
        item.status = 'needs_attention'; item.phase = 'download_failed';
        item.error = `This shot is generated, but its download failed. Recover the saved download without generating again. ${detail(error)}`;
      });
      return false;
    } finally { this._downloads.delete(id); }
  }

  async _composeStory(id) {
    if (this._downloads.has(id)) throw new Error('This video is already being downloaded.');
    const job = this._job(id);
    this._validateStory(job);
    if (this._storyIndex(job) !== -1) throw new Error('All generated shots must be saved before joining the video.');
    const version = job.executionVersion || 0;
    this._downloads.add(id);
    this._update(id, item => { item.status = 'running'; item.phase = 'composing'; delete item.remote; delete item.remoteVideoUrl; });
    try {
      if (typeof this.composeVideo !== 'function') throw new Error('Long-video assembly is unavailable.');
      const { durationSeconds, orientation } = job.videoPlan;
      const segments = job.segments.map(segment => ({ videoPath: segment.videoPath, durationSeconds: segment.durationSeconds }));
      const videoPath = await this.composeVideo({ jobId: id, segments, durationSeconds, ...(orientation ? { orientation } : {}) });
      if (typeof videoPath !== 'string' || !videoPath) throw new Error('The joined video was not saved.');
      const current = this._job(id);
      if ((current.executionVersion || 0) !== version || TERMINAL.has(current.status)) return;
      this._update(id, item => { item.videoPath = videoPath; item.status = 'completed'; item.completedAt = now(); delete item.error; delete item.phase; });
    } catch (error) {
      const current = this._job(id);
      if ((current.executionVersion || 0) !== version || TERMINAL.has(current.status)) return;
      this.pause();
      this._update(id, item => { item.status = 'needs_attention'; item.phase = 'compose_failed'; item.error = `Your shots are saved, but joining them failed. Recover to retry joining without generating again. ${detail(error)}`; });
    } finally { this._downloads.delete(id); }
  }

  async _process(initial) {
    if (initial.videoPlan) return this._processStory(initial);
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
        if (error.httpStatus === 429 && error.submissionUncertain !== true && this._deferAutomatic(initial.id, error)) return;
        if (error.pauseQueue === true || [401, 402, 403, 429].includes(error.httpStatus)) {
          this._hold();
        }
        this._update(initial.id, job => {
          const definitive = error.submissionUncertain === false || (Number.isInteger(error.httpStatus) && error.httpStatus >= 400 && error.httpStatus < 500 && error.httpStatus !== 408);
          job.status = definitive ? 'failed' : 'needs_attention';
          job.error = definitive ? detail(error) : `Submission outcome is unknown. The provider may have accepted this request and used your quota. Check its saved progress before retrying. ${detail(error)}`;
        });
        return;
      }
      this._monitored.add(initial.id);
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
        if (error.pauseQueue === true) {
          this.paused = true;
          this._approved.clear();
          this._update(current.id, job => { job.status = 'needs_attention'; job.error = `Provider monitoring stopped and the queue is paused. The saved request can be resumed manually. ${detail(error)}`; });
          return;
        }
        errors++;
        if (errors >= this.maxPollErrors) {
          this._update(current.id, job => { job.status = 'needs_attention'; job.error = `Could not monitor the provider. Resume the saved request without submitting again. ${detail(error)}`; });
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
        if (result.status === 'failed' && result.quotaBlocked === true && this._deferAutomatic(current.id, result)) return;
        if (result.pauseQueue === true) {
          this._hold();
        }
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
      // Preserve the generated output and stop before using more quota for
      // videos that may also be impossible to save (for example, a full disk).
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
        try { await this._cancelRemote(id, job.videoPlan
          ? this.providerFactory(this._model('ltx2-free'), storyContext(job.videoPlan))
          : this.providerFactory(this._model(job.modelId))); }
        catch (error) { this._update(id, item => { item.cancellationError = `Cancellation could not be confirmed. The provider may continue using your quota. ${detail(error)}`; }); }
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
          if (item.videoPlan && item.segments[item.segmentIndex]?.remote?.requestId === job.remote.requestId) item.segments[item.segmentIndex].status = 'cancelled';
        } else item.cancellation = 'requested';
      });
    } catch (error) {
      this._update(id, item => {
        if (!item.remote || item.remote.requestId !== job.remote.requestId) return;
        item.cancellationError = `Cancellation could not be confirmed. The provider may continue using your quota. ${detail(error)}`;
      });
    }
  }

  retry(id) {
    const job = this._job(id);
    if (!job || !['failed', 'cancelled', 'needs_attention'].includes(job.status)) throw new Error('Only failed, cancelled or attention-needed prompts can be retried.');
    this._model(job.modelId);
    if (job.videoPlan) this._validateStory(job);
    if (job.remoteVideoUrl) throw new Error('This video is already generated. Retry its download instead.');
    if (job.remote && job.status === 'needs_attention') throw new Error('This request can be resumed without another submission. Use Resume monitoring.');
    if (this.store.snapshot().jobs.filter(item => ACTIVE.has(item.status)).length >= ACTIVE_LIMIT && !ACTIVE.has(job.status)) throw new Error('The active queue is full.');
    // Re-read local production instructions after a preparation failure only
    // if the earlier plan never reached the provider.
    const canReplan = job.phase === 'prepare_failed' && job.videoPlan && !job.startedAt && !job.remote && !job.videoPath &&
      !job.attempts?.some(attempt => attempt.remote) && job.segments.every(segment => segment.status === 'pending' &&
        !segment.remote && !segment.remoteVideoUrl && !segment.videoPath &&
        !segment.attempts?.some(attempt => attempt.remote || attempt.status !== 'pending'));
    const revisedPlan = canReplan ? validateVideoPlan(this.planVideo(job.modelId, job.prompt)) : null;
    if (revisedPlan?.production && typeof this.prepareVideo !== 'function') throw new Error('Local sound preparation is unavailable.');
    this._approved.delete(id);
    this._update(id, item => {
      item.attempts = [...(item.attempts || []), { status: item.status, remote: item.remote || null, error: item.error || null, endedAt: now(), cancellation: item.cancellation || null }];
      item.status = 'pending';
      item.executionVersion = (item.executionVersion || 0) + 1;
      if (revisedPlan) {
        item.videoPlan = revisedPlan;
        item.segments = revisedPlan.segments.map(segment => ({ ...segment, status: 'pending' }));
        item.segmentIndex = 0;
        delete item.prepared;
      } else if (item.videoPlan) {
        const index = this._storyIndex(item);
        if (index !== -1) {
          const segment = item.segments[index];
          segment.attempts = [...(segment.attempts || []), { status: segment.status, remote: segment.remote || null, error: segment.error || null, endedAt: now() }];
          segment.status = 'pending';
          for (const field of ['remote', 'remoteVideoUrl', 'error', 'completedAt']) delete segment[field];
          item.segmentIndex = index;
        }
      }
      for (const field of ['remote', 'error', 'completedAt', 'startedAt', 'cancelRequested', 'cancellation', 'cancellationError', 'phase']) delete item[field];
    });
    return this.snapshot();
  }

  resume(id) {
    const job = this._job(id);
    if (!job || job.status !== 'needs_attention' || !job.remote) throw new Error('No saved provider request is available to resume.');
    if (job.remoteVideoUrl) throw new Error('Retry the saved video download instead.');
    this._model(job.modelId);
    this._monitored.add(id);
    this._update(id, item => { item.status = 'queued'; delete item.error; });
    this._ensureRunner();
    return this.snapshot();
  }

  async retryDownload(id) {
    if (this._downloads.has(id)) throw new Error('This video is already being downloaded.');
    const job = this._job(id);
    if (job?.videoPlan && job.status === 'needs_attention') {
      this._validateStory(job);
      const index = this._storyIndex(job);
      if (index === -1 && job.phase === 'compose_failed') {
        await this._composeStory(id);
        return this.snapshot();
      }
      if (index === -1 || !job.segments[index].remoteVideoUrl) throw new Error('There is no saved provider output to download again.');
      this._update(id, item => { item.phase = 'downloading'; });
      if (await this._downloadStoryPart(id, index)) {
        if (this._storyIndex(this._job(id)) === -1) await this._composeStory(id);
        else this._update(id, item => { item.status = 'pending'; item.phase = 'story_paused'; });
      }
      return this.snapshot();
    }
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

  async waitForIdle() { while (this._runner) await this._runner; }

  async dispose({ preserveAutomatic = false } = {}) {
    if (this._disposed) return this.waitForIdle();
    this._hold(preserveAutomatic);
    this._disposed = true;
    this._emit();
    if (this._waitResolve) this._waitResolve();
    await this.waitForIdle();
  }
}

module.exports = { Queue, ACTIVE, ACTIVE_LIMIT };
