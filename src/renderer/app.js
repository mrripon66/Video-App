'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const bridge = window.studio;
  const ACTIVE = new Set(['pending', 'submitting', 'queued', 'running', 'needs_attention']);
  const IN_PROGRESS = new Set(['submitting', 'queued', 'running']);
  const BATCH_LIMIT = 500;
  const labels = { pending: 'Waiting', submitting: 'Submitting', queued: 'At provider', running: 'Generating', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', needs_attention: 'Needs attention' };
  const icons = {
    sparkles: ['M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3z', 'M20 2v4', 'M18 4h4'],
    layers: ['M12 3L2 8l10 5 10-5-10-5z', 'M2 12l10 5 10-5', 'M2 16l10 5 10-5'],
    film: ['M4 3h16v18H4z', 'M4 8h16', 'M4 16h16', 'M8 3v18', 'M16 3v18'],
    reel: ['M7 3h10v18H7z', 'M10 17h4'],
    settings: ['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z', 'M9 3h6l.6 3 2.4 1.4 2.9-.8 3 5.2-2.3 2 .1 2.7 2.2 2-3 5.2-2.9-.8-2.4 1.4-.6 3H9l-.6-3L6 21l-2.9.8-3-5.2 2.3-2-.1-2.7-2.2-2 3-5.2 2.9.8L8.4 4 9 3z'],
    cloud: ['M6 18a4 4 0 0 1-.4-8A6.5 6.5 0 0 1 18 8.5 4.8 4.8 0 0 1 18 18H6z'],
    key: ['M14 9a5 5 0 1 0-4 5l3 3h3v3h4v-4l-6-7z'],
    lock: ['M6 10h12v11H6z', 'M8 10V6a4 4 0 0 1 8 0v4'],
    mic: ['M9 4a3 3 0 0 1 6 0v8a3 3 0 0 1-6 0V4z', 'M5 10v2a7 7 0 0 0 14 0v-2', 'M12 19v4', 'M8 23h8'],
    'arrow-right': ['M4 12h15', 'M13 6l6 6-6 6'],
    info: ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z', 'M12 11v6', 'M12 7v.1'],
    pause: ['M8 5v14', 'M16 5v14'],
    play: ['M8 4l13 8-13 8V4z'],
    upload: ['M12 16V3', 'M6 9l6-6 6 6', 'M3 16v5h18v-5'],
    plus: ['M12 4v16', 'M4 12h16'],
    folder: ['M3 5h7l2 3h9v12H3V5z'],
    eye: ['M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'],
    check: ['M5 12l4 4L20 5'],
    shield: ['M12 2l8 3v6c0 5-8 11-8 11S4 16 4 11V5l8-3z', 'M8 11l3 3 5-6'],
    download: ['M12 3v13', 'M6 10l6 6 6-6', 'M3 17v4h18v-4'],
    sun: ['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z', 'M12 2v2', 'M12 20v2', 'M2 12h2', 'M20 12h2', 'M5 5l1.5 1.5', 'M17.5 17.5L19 19', 'M5 19l1.5-1.5', 'M17.5 6.5L19 5'],
    mountain: ['M2 20L9 7l5 8 3-5 6 10H2z', 'M7 11l2 2 2-2'],
    leaf: ['M20 3C7 2 2 9 5 16s15 7 15-13z', 'M4 21L16 8'],
    clock: ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z', 'M12 6v6l4 2']
  };
  let state = { jobs: [], models: [], ready: false, freeOnly: true, paused: true, voiceAvailable: false };
  let view = 'create';
  let toastTimer;
  let refreshTimer;
  let refreshPromise;
  let refreshAgain = false;
  let lastContentSignature = '';
  let lastModelsSignature = '';
  let lastWarning = '';
  let dictating = false;
  let selectingVideos = false;
  let savingLibraryZip = false;
  let batchOutputDirectory = '';
  const selectedVideoIds = new Set();
  const busyControls = new Set();
  const chatCache = new Map();
  const libraryCache = new Map();
  const decodedDurations = new Map();

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', name === 'settings' ? '-1 0 26 27' : '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    for (const data of icons[name] || icons.film) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', data);
      svg.append(path);
    }
    return svg;
  }
  function decorateIcons() {
    document.querySelectorAll('[data-icon]').forEach(node => node.replaceChildren(icon(node.dataset.icon)));
  }
  function button(label, callback, iconName, className = 'text-button') {
    const node = element('button', className);
    node.type = 'button';
    if (iconName) node.append(icon(iconName));
    node.append(document.createTextNode(label));
    node.addEventListener('click', () => action(callback, node));
    return node;
  }
  function modelName(id) { return state.models.find(model => model.id === id)?.name || state.modelAliases?.[id] || (id === 'local-reel' ? 'Reel' : id) || 'Video model'; }
  function isStory(job) { return job.modelId === 'ltx2-story-free' || (job.videoPlan?.segments?.length || 0) > 1; }
  function storyParts(job) { return Array.isArray(job.segments) ? job.segments : Array.isArray(job.videoPlan?.segments) ? job.videoPlan.segments : []; }
  function savedParts(job) { return storyParts(job).filter(part => part.videoPath).length; }
  function secondsLabel(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Number(number.toFixed(1)) + 's' : '';
  }
  function durationText(job) {
    const decoded = decodedDurations.get(job.id);
    const actual = decoded && decoded.videoPath === job.videoPath ? decoded.seconds : null;
    const target = job.videoPlan?.durationSeconds;
    const duration = actual ? secondsLabel(actual) : target ? secondsLabel(target) + ' target' : '';
    return duration + (isStory(job) ? (duration ? ' · ' : '') + (storyParts(job).length ? storyParts(job).length + ' edited shots' : 'edited video') : '');
  }
  function durationBadge(job) {
    const badge = element('span', 'duration-badge', durationText(job));
    badge.dataset.durationJob = job.id;
    badge.hidden = !badge.textContent;
    return badge;
  }
  function recordDuration(job, seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    decodedDurations.set(job.id, { videoPath: job.videoPath, seconds });
    document.querySelectorAll('[data-duration-job]').forEach(node => {
      if (node.dataset.durationJob === job.id) { node.textContent = durationText(job); node.hidden = !node.textContent; }
    });
  }
  function segmentProgress(job) {
    if (!isStory(job)) return null;
    const parts = storyParts(job), saved = savedParts(job);
    if (!parts.length) return element('p', 'segment-progress-note', 'Preparing the two-shot video plan…');
    const container = element('div', 'segment-progress');
    container.dataset.progressJob = job.id;
    const heading = element('div', 'segment-progress-heading');
    heading.append(element('span', '', saved + ' of ' + parts.length + ' shots saved'), durationBadge(job));
    const bar = element('div', 'segment-progress-bar');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', 'Downloaded video shots');
    bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', String(parts.length)); bar.setAttribute('aria-valuenow', String(saved));
    parts.forEach((part, index) => {
      const active = !part.videoPath && ['submitting', 'queued', 'running'].includes(part.status);
      const segment = element('span', part.videoPath ? 'saved' : active ? 'active' : '');
      segment.title = 'Shot ' + (index + 1) + ': ' + secondsLabel(part.durationSeconds) + (part.videoPath ? ' saved' : active ? ' in progress' : ' remaining');
      bar.append(segment);
    });
    let note;
    if (job.phase === 'composing') note = 'Joining the saved shots into one video…';
    else if (job.phase === 'compose_failed' || (saved === parts.length && job.status !== 'completed')) note = 'Both shots are saved. Finish joining them without generating again.';
    else if (job.status === 'completed') note = 'Two separately generated shots joined into one edited video.';
    else if (job.phase === 'downloading') note = 'Downloading shot ' + (Number(job.segmentIndex || 0) + 1) + ' of ' + parts.length + '…';
    else if (job.phase === 'download_failed') note = 'The generated shot needs another download attempt. Saved shots are kept.';
    else if (saved > 0 && ['pending', 'failed', 'needs_attention'].includes(job.status)) note = 'Your saved shot is kept. Continue when free GPU time is available.';
    else note = 'Separate AI shots; their appearance and motion may differ.';
    container.append(heading, bar, element('p', 'segment-progress-note', note));
    return container;
  }
  async function continueJob(job) {
    ensureFreeReady();
    await bridge.startQueue({ approvedJobIds: [job.id] });
    showToast('Continuing your video. Downloaded shots will be kept.');
  }
  function timeLabel(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' · ' + date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  function newestJobs() { return [...state.jobs].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); }
  function showToast(message, isError = false) {
    clearTimeout(toastTimer);
    $('toast').textContent = String(message);
    $('toast').classList.toggle('error', isError);
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, isError ? 14000 : 5000);
  }
  function errorMessage(error) {
    return String(error?.message || error || 'This action could not be completed.').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  }
  async function action(callback, control) {
    if (control?.disabled) return;
    if (control) { busyControls.add(control); control.disabled = true; }
    try { await callback(); await refresh(); }
    catch (error) { showToast(errorMessage(error), true); }
    finally { if (control) { busyControls.delete(control); control.disabled = false; } renderStatus(); }
  }
  function reelButton(job) {
    const trigger = button('Make Reel', () => openReelDialog(job, trigger), 'reel', 'text-button video-reel-button');
    return trigger;
  }
  function openReelDialog(job, trigger) {
    const dialog = $('reel-dialog-template').content.firstElementChild.cloneNode(true);
    const form = dialog.querySelector('form');
    const controls = form.querySelectorAll('button, select, textarea');
    const submit = form.querySelector('[type="submit"]');
    const status = form.querySelector('[role="status"]');
    let exporting = false;
    const soundDescription = form.querySelector('[data-sound-description]');
    const soundSelect = form.elements.sound;
    soundSelect.querySelector('[value="prompt"]').disabled = !state.promptSoundAvailable;
    form.querySelector('[data-narration-fields]').hidden = !state.narrationAvailable;
    soundSelect.addEventListener('change', () => { soundDescription.hidden = soundSelect.value !== 'prompt'; });

    form.querySelector('[data-reel-close]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('cancel', event => { if (exporting) event.preventDefault(); });
    dialog.addEventListener('close', () => {
      dialog.remove();
      if (trigger.isConnected) trigger.focus();
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (exporting) return;
      const { framing, sound, soundPrompt, narration, voice, music } = form.elements;
      exporting = true;
      controls.forEach(control => { control.disabled = true; });
      status.hidden = false;
      status.classList.remove('error');
      status.textContent = 'Saving your Reel on this PC. This can take a moment.';
      submit.textContent = 'Saving…';
      try {
        const result = await bridge.makeReel({ id: job.id, framing: framing.value, sound: sound.value,
          soundPrompt: soundPrompt.value.trim(), narration: narration.value.trim(), voice: voice.value, music: music.value });
        if (result?.saved) {
          dialog.close();
          showToast('Reel saved.');
        } else status.hidden = true;
      } catch (error) {
        status.classList.add('error');
        status.textContent = errorMessage(error);
      } finally {
        exporting = false;
        controls.forEach(control => { control.disabled = false; });
        submit.textContent = 'Save Reel';
        if (dialog.open) submit.focus();
      }
    });
    document.body.append(dialog);
    dialog.showModal();
  }
  function setView(next) {
    if (!['create', 'queue', 'library', 'settings'].includes(next)) return;
    if (next !== view) document.querySelectorAll('.view video').forEach(video => video.pause());
    view = next;
    document.querySelectorAll('.view').forEach(node => { node.hidden = node.id !== 'view-' + next; });
    document.querySelectorAll('.nav-item').forEach(node => {
      node.classList.toggle('active', node.dataset.view === next);
      if (node.dataset.view === next) node.setAttribute('aria-current', 'page');
      else node.removeAttribute('aria-current');
    });
    $('view-label').textContent = { create: 'Create', queue: 'Batch queue', library: 'Video library', settings: 'Settings' }[next];
    document.querySelector('main').scrollTop = 0;
  }
  function statusBadge(job) { return element('span', 'status-badge ' + job.status, labels[job.status] || job.status); }
  function syncChildren(parent, nodes) {
    nodes.forEach((node, index) => {
      if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] || null);
    });
    while (parent.children.length > nodes.length) parent.lastElementChild.remove();
  }
  function emptyState(title, copy, iconName = 'layers') {
    const node = element('div', 'list-empty');
    const mark = element('span');
    mark.setAttribute('data-icon', iconName);
    mark.append(icon(iconName));
    node.append(mark, element('h3', '', title), element('p', '', copy));
    return node;
  }
  function makeVideo(job) {
    const video = element('video');
    video.controls = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.src = 'studio-media://video/' + encodeURIComponent(job.id);
    video.setAttribute('aria-label', job.title || job.prompt);
    video.addEventListener('play', () => {
      document.querySelectorAll('video').forEach(other => { if (other !== video) other.pause(); });
    });
    video.addEventListener('loadedmetadata', () => {
      recordDuration(job, video.duration);
      if (video.nextElementSibling?.classList.contains('video-load-error')) video.nextElementSibling.remove();
    });
    video.addEventListener('error', () => {
      const existing = video.parentElement?.querySelector('.video-load-error');
      if (!existing && video.parentElement) {
        const note = element('p', 'job-error video-load-error', 'This saved video could not be played. Use Show in folder to check the file.');
        video.insertAdjacentElement('afterend', note);
      }
    });
    return video;
  }
  function watchButton(job) {
    const trigger = button('Watch', () => openVideo(job, trigger), 'play', 'text-button video-watch-button');
    return trigger;
  }
  function openVideo(job, trigger) {
    const dialog = element('dialog', 'watch-dialog');
    dialog.setAttribute('aria-labelledby', 'watch-title');
    const title = element('h2', '', job.title || 'Watch video');
    title.id = 'watch-title';
    const header = element('div', 'watch-header');
    const close = element('button', 'secondary-button', 'Close');
    close.type = 'button';
    close.addEventListener('click', () => dialog.close());
    header.append(title, close);
    const video = makeVideo(job);
    const message = element('p', 'watch-status');
    message.setAttribute('role', 'status');
    message.hidden = true;
    const controls = element('div', 'watch-controls');
    const play = element('button', 'primary-button', 'Play');
    const replay = element('button', 'secondary-button', 'Replay');
    const sound = element('button', 'secondary-button watch-sound-button', 'Mute');
    for (const control of [play, replay, sound]) control.type = 'button';
    function updateControls() {
      play.textContent = video.paused ? 'Play' : 'Pause';
      sound.textContent = video.muted || video.volume === 0 ? 'Unmute' : 'Mute';
    }
    async function start(restart = false) {
      message.hidden = true;
      try {
        if (video.error) video.load();
        if (restart || video.ended) video.currentTime = 0;
        await video.play();
      } catch (error) {
        if (!dialog.open || error?.name === 'AbortError') return;
        message.textContent = video.error ? 'The saved video could not be played. Choose Replay to load it again.' : 'Select Play to start the video.';
        message.hidden = false;
      }
    }
    play.addEventListener('click', () => { if (video.paused) void start(); else video.pause(); });
    replay.addEventListener('click', () => { void start(true); });
    sound.addEventListener('click', () => {
      const wasSilent = video.muted || video.volume === 0;
      video.muted = !wasSilent;
      if (wasSilent && video.volume === 0) video.volume = 1;
    });
    for (const event of ['play', 'pause', 'ended', 'volumechange']) video.addEventListener(event, updateControls);
    controls.append(play, replay, sound);
    dialog.append(header, video, controls, message);
    dialog.addEventListener('close', () => {
      video.pause();
      video.removeAttribute('src');
      video.load();
      dialog.remove();
      if (trigger.isConnected) trigger.focus();
    });
    document.body.append(dialog);
    dialog.showModal();
    void start();
  }
  function renderModels() {
    const signature = JSON.stringify(state.models);
    if (signature === lastModelsSignature) return;
    lastModelsSignature = signature;
    for (const select of [$('create-model'), $('batch-model')]) {
      const previous = select.value;
      const options = state.models.map(model => {
        const option = element('option', '', model.name + (model.available ? '' : ' · unavailable'));
        option.value = model.id;
        option.disabled = !model.available;
        if (!model.available) option.title = model.reason || 'No verified provider API is available.';
        return option;
      });
      select.replaceChildren(...options);
      select.value = state.models.some(model => model.id === previous && model.available) ? previous
        : state.models.find(model => model.id === 'ltx2-story-free' && model.available)?.id || state.models.find(model => model.available)?.id || '';
      select.disabled = !state.models.some(model => model.available);
    }
    const cards = state.models.map(model => {
      const card = element('article', 'model-card' + (model.available ? '' : ' unavailable'));
      const top = element('div', 'model-card-top');
      top.append(element('h3', '', model.name), element('span', 'status-badge ' + (model.available ? 'completed' : ''), model.available ? 'Available' : 'Unavailable'));
      card.append(top, element('p', '', model.available ? model.description || 'Free shared-GPU text-to-video model. Daily limits and queues apply.' : model.reason || 'This model is unavailable in free-only mode.'));
      return card;
    });
    $('models-list').replaceChildren(...cards);
  }
  function renderStatus() {
    const pending = state.jobs.filter(job => job.status === 'pending');
    const active = state.jobs.filter(job => IN_PROGRESS.has(job.status));
    const completed = state.jobs.filter(job => job.status === 'completed' && job.videoPath);
    const failed = state.jobs.filter(job => ['failed', 'needs_attention'].includes(job.status));
    const count = state.jobs.filter(job => ACTIVE.has(job.status)).length;
    const availablePending = pending.filter(job => state.models.some(model => model.id === job.modelId && model.available));
    const monitoringOnly = availablePending.length === 0 && active.some(job => job.remote) && state.paused;
    $('nav-queue-count').textContent = String(count);
    $('nav-library-count').textContent = String(completed.length);
    $('stat-pending').textContent = String(pending.length);
    $('stat-active').textContent = String(active.length);
    $('stat-completed').textContent = String(completed.filter(job => job.kind !== 'reel').length);
    $('stat-failed').textContent = String(failed.length);
    $('queue-total').textContent = String(state.jobs.filter(job => job.kind !== 'reel').length);
    const quotaWait = Number.isFinite(state.nextRetryAt) ? `Free allowance retry ${new Date(state.nextRetryAt).toLocaleString()}` : '';
    $('queue-state').textContent = quotaWait || (state.paused ? 'New submissions paused' : state.automaticBatch ? 'Automatic batch running' : 'Generating selected prompts');
    $('library-count').textContent = completed.length + (completed.length === 1 ? ' video' : ' videos');
    const freeReady = state.ready === true && state.freeOnly === true;
    $('connection-banner').hidden = view === 'settings';
    $('free-mode-summary').textContent = freeReady ? 'Free-only mode. Shared GPU quotas and queues apply.' : 'Free provider is unavailable. Your saved prompts are safe.';
    $('provider-name').textContent = state.provider?.name || 'Hugging Face ZeroGPU';
    $('provider-description').textContent = state.provider?.description || 'Free shared GPUs with daily quotas and queues.';
    $('provider-state').textContent = freeReady ? 'Free mode enabled' : 'Unavailable';
    $('provider-state').className = 'status-badge' + (freeReady ? ' completed' : '');
    $('review-queue').disabled = !!state.automaticBatch || (availablePending.length === 0 && !monitoringOnly);
    $('review-queue').replaceChildren(icon('play'), document.createTextNode(monitoringOnly ? 'Resume monitoring' : 'Start queue'));
    $('pause-queue').disabled = Boolean(state.paused && !state.automaticBatch);
    const selected = state.models.find(model => model.id === $('create-model').value);
    $('create-model-details').textContent = selected?.available ? selected.description || '' : selected?.reason || '';
    $('story-duration-hint').hidden = selected?.id !== 'ltx2-story-free';
    $('animatediff-duration-hint').hidden = selected?.id !== 'animatediff-free';
    $('add-prompt').disabled = !selected?.available || count >= BATCH_LIMIT || !!state.automaticBatch;
    const batchSelected = state.models.find(model => model.id === $('batch-model').value);
    const lines = batchPrompts();
    $('add-batch').disabled = !batchSelected?.available || lines.length === 0 || lines.length + count > BATCH_LIMIT ||
      !!state.automaticBatch || busyControls.has($('choose-batch-folder'));
    $('batch-count').textContent = lines.length + (lines.length === 1 ? ' prompt' : ' prompts') + ' · ' + Math.max(0, BATCH_LIMIT - count) + ' spaces available';
    $('batch-count').classList.toggle('over-limit', lines.length + count > BATCH_LIMIT);
    $('narration-state').textContent = state.narrationAvailable ? 'English narration ready' : 'Narration needs the full installer';
    $('prompt-sound-state').textContent = state.promptSoundAvailable ? 'Sound from descriptions is ready' : 'Sound from descriptions needs the local add-on';
    $('voice-button').disabled = dictating || state.voiceAvailable === false;
    $('voice-button').title = state.voiceAvailable === false ? state.voiceReason || 'Local voice input is unavailable. Type your prompt instead.' : 'Record a short voice prompt and transcribe it locally';
    $('voice-description').textContent = state.voiceAvailable === false
      ? state.voiceReason || 'Local voice input is unavailable. You can type or import prompts.'
      : 'Speak a short prompt after clicking Voice prompt. The offline engine records up to 10 seconds, then transcribes it on this PC. Edit the text before clicking Generate.';
    $('footer-state').textContent = state.paused
      ? 'Queue paused · ' + pending.length + ' waiting' + (active.length ? ' · ' + active.length + ' submitted' : '')
      : 'Queue running · ' + active.length + ' in progress · ' + pending.length + ' waiting';
    renderBatchFolder();
    for (const control of busyControls) control.disabled = true;
  }
  function renderBatchFolder() {
    const choosing = busyControls.has($('choose-batch-folder'));
    const adding = busyControls.has($('add-batch'));
    const folderNote = $('batch-save-folder');
    const text = batchOutputDirectory || 'Optional. Save a copy of each finished video to a folder for this batch.';
    if (folderNote.textContent !== text) folderNote.textContent = text;
    $('choose-batch-folder').disabled = choosing || adding;
    $('clear-batch-folder').hidden = !batchOutputDirectory;
    $('clear-batch-folder').disabled = choosing || adding;
  }
  function renderEmptyChat() {
    const node = element('div', 'create-empty');
    const mark = element('div', 'empty-emblem');
    mark.append(icon('sparkles'));
    node.append(mark, element('h2', '', 'Describe it. Make it move.'), element('p', '', 'Create a 15–20-second edited video from two fresh AI shots, or choose a short-clip model. Shared free GPU time may pause a video between shots.'));
    const row = element('div', 'suggestion-row');
    const suggestions = [
      ['A cinematic landscape', 'mountain', 'A cinematic aerial shot drifting over misty mountains at dawn, soft golden light and slow graceful camera movement.'],
      ['A quiet moment', 'leaf', 'A close-up of raindrops rolling down a greenhouse window, lush leaves beyond the glass, gentle natural light.'],
      ['Golden-hour magic', 'sun', 'A warm golden-hour tracking shot through a quiet coastal village, pastel houses, gentle sea breeze, subtle film grain.']
    ];
    for (const [label, symbol, prompt] of suggestions) row.append(button(label, () => { $('prompt-input').value = prompt; updatePromptLength(); $('prompt-input').focus(); }, symbol, 'suggestion'));
    node.append(row);
    return node;
  }
  function jobDescription(job) {
    if (job.phase === 'preparing') return 'Preparing audio on this PC.';
    if (isStory(job)) {
      if (job.status === 'completed') return 'Your edited video is ready and saved on this PC. It joins two separately generated AI shots.';
      if (job.phase === 'composing') return 'Both AI shots are downloaded. Joining them into your final edited video.';
      if (savedParts(job) > 0 && job.status === 'pending') return 'Your first shot is saved. Continue this video to generate its remaining shot.';
    }
    const descriptions = {
      pending: 'Saved in your queue and waiting to generate. Start the queue to continue paused prompts.',
      submitting: 'Sending your prompt to the selected free video provider.',
      queued: 'Your provider has accepted this request and is waiting for a GPU.',
      running: 'Your provider is generating this video. Progress is saved in your queue.',
      completed: 'Your video is ready and saved on this PC.',
      failed: 'This request could not finish. Check the details before retrying.',
      cancelled: job.cancellation === 'confirmed' ? 'Your provider confirmed that this request was cancelled.' : 'This prompt was removed from the active queue before a new submission.',
      needs_attention: 'This request stopped before finishing. Its provider details are saved so it can be recovered where possible.'
    };
    return descriptions[job.status] || 'See the queue for the latest request status.';
  }
  function renderChat(jobs) {
    const feed = $('chat-feed');
    const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 70;
    if (!jobs.length) { feed.replaceChildren(renderEmptyChat()); return; }
    const entries = jobs.slice(0, 20).reverse().map(job => {
      const signature = JSON.stringify(job);
      const cached = chatCache.get(job.id);
      if (cached?.signature === signature) return cached.node;
      const entry = element('article', 'chat-entry');
      entry.append(element('div', 'chat-prompt', job.prompt));
      const result = element('div', 'chat-result');
      const avatar = element('span', 'chat-avatar'); avatar.append(icon('sparkles'));
      const body = element('div', 'chat-result-body');
      const top = element('div', 'chat-result-top'); top.append(element('strong', '', modelName(job.modelId)), statusBadge(job));
      body.append(top, element('p', 'chat-result-description', jobDescription(job)));
      const progress = segmentProgress(job);
      if (progress) body.append(progress);
      else body.append(durationBadge(job));
      if (job.error) body.append(element('p', 'job-error', job.error));
      if (job.cancellationError) body.append(element('p', 'job-error', job.cancellationError));
      if (job.cancellation === 'requested' && !job.cancellationError) body.append(element('p', 'job-error', 'Stop requested. Cancellation is not confirmed; the submitted request may still finish and use free GPU quota.'));
      if (job.status === 'completed' && job.videoPath) {
        const actions = element('div', 'chat-video-actions');
        actions.append(watchButton(job), reelButton(job), button('Export video', async () => {
          const result = await bridge.exportVideo({ id: job.id });
          if (result?.saved) showToast('Video exported.');
        }, 'download'));
        body.append(makeVideo(job), actions);
      } else if (job.status === 'pending') body.append(isStory(job) && savedParts(job) > 0
        ? button('Continue video', () => continueJob(job), 'play')
        : button('Open queue', () => setView('queue'), 'arrow-right'));
      result.append(avatar, body); entry.append(result);
      chatCache.set(job.id, { signature, node: entry }); return entry;
    });
    for (const id of chatCache.keys()) if (!jobs.slice(0, 20).some(job => job.id === id)) chatCache.delete(id);
    syncChildren(feed, entries);
    if (nearBottom) feed.scrollTop = feed.scrollHeight;
  }
  function retryLabel(job) {
    if (isStory(job) && (job.phase === 'compose_failed' || storyParts(job).length > 0 && savedParts(job) === storyParts(job).length)) return 'Finish video';
    return job.status === 'needs_attention' && (job.remote || job.remoteVideoUrl || job.phase === 'download_failed') ? 'Recover' : 'Retry';
  }
  function retryCopy(job) {
    if (isStory(job) && job.phase === 'compose_failed') return 'Joining the saved shots again. No new video generation is needed.';
    if (job.status === 'needs_attention' && job.remoteVideoUrl) return 'Recovering the saved video download. No new video request will be submitted.';
    if (job.status === 'needs_attention' && job.remote) return 'Recovering this provider request. No new video request will be submitted.';
    return isStory(job) && savedParts(job) > 0 ? 'Continuing your video with its saved shots.' : 'Retry started with the selected free provider.';
  }
  async function retryJob(job) {
    const result = await bridge.retryJob({ id: job.id });
    if (result.jobs?.find(item => item.id === job.id)?.status === 'pending') {
      ensureFreeReady();
      await bridge.startQueue({ approvedJobIds: [job.id] });
    }
    showToast(retryCopy(job));
  }
  function autoExportNote(job) {
    const output = job.autoExport;
    if (!output || job.status !== 'completed') return null;
    const note = element('div', 'job-auto-export');
    const status = element('p', output.status === 'failed' ? 'job-error' : '');
    status.title = output.directory;
    if (output.status === 'saved') status.textContent = output.filePath ? 'Folder copy saved to ' + output.filePath : 'Copy saved to your batch folder.';
    else if (output.status === 'pending') status.textContent = 'Waiting to save a copy to your batch folder.';
    else if (output.status === 'failed') status.textContent = 'Could not save the folder copy.' + (output.error ? ' ' + output.error : '');
    note.append(status);
    if (output.status === 'failed') {
      const actions = element('div', 'job-auto-export-actions');
      actions.append(button('Retry folder save', () => bridge.retryAutoExport({ id: job.id })),
        button('Choose a different folder', async () => {
          const chosen = await bridge.chooseBatchFolder();
          if (chosen?.directory) await bridge.retryAutoExport({ id: job.id, autoExportDirectory: chosen.directory });
        }));
      note.append(actions);
    }
    return note;
  }
  function renderQueue(jobs) {
    if (!jobs.length) {
      $('queue-list').replaceChildren(emptyState('A clear queue. A fresh start.', 'Describe a video in Create and click Generate, or enter a batch above. Your prompts and results will appear here.'));
      return;
    }
    const rows = jobs.map(job => {
      const row = element('article', 'queue-row');
      const mark = element('span', 'job-type-icon'); mark.append(icon(job.status === 'completed' ? 'film' : 'clock'));
      const details = element('div', 'job-details');
      const prompt = element('p', 'job-prompt', job.prompt); prompt.title = job.prompt;
      const meta = element('div', 'job-meta'); meta.append(element('span', '', modelName(job.modelId)), element('span', '', timeLabel(job.createdAt)));
      details.append(prompt, meta);
      const progress = segmentProgress(job);
      if (progress) details.append(progress);
      else meta.append(durationBadge(job));
      if (job.error) details.append(element('p', 'job-error', job.error));
      if (job.cancellationError) details.append(element('p', 'job-error', job.cancellationError));
      if (job.cancellation === 'requested' && !job.cancellationError) details.append(element('p', 'job-error', 'Stop requested. Cancellation is not confirmed; the submitted request may still finish and use free GPU quota.'));
      const outputNote = autoExportNote(job);
      if (outputNote) details.append(outputNote);
      const actions = element('div', 'job-actions');
      if (job.status === 'pending' && isStory(job) && savedParts(job) > 0) actions.append(button('Continue', () => continueJob(job), 'play'));
      if (['failed', 'cancelled', 'needs_attention'].includes(job.status)) actions.append(button(retryLabel(job), () => retryJob(job)));
      if (ACTIVE.has(job.status)) actions.append(button(job.status === 'pending' ? 'Remove' : 'Stop', async () => { await bridge.cancelJob({ id: job.id }); showToast(job.status === 'pending' ? 'Prompt removed from the active queue.' : 'Stop requested. Check the provider if this request was already submitted.'); }));
      if (job.status === 'completed' && job.videoPath) actions.append(watchButton(job), reelButton(job), button('Export', async () => {
        const result = await bridge.exportVideo({ id: job.id }); if (result?.saved) showToast('Video exported.');
      }, 'download'));
      row.append(mark, details, statusBadge(job), actions);
      return row;
    });
    $('queue-list').replaceChildren(...rows);
  }
  function renderLibrarySelection() {
    const count = selectedVideoIds.size;
    const hasVideos = libraryCache.size > 0;
    $('library-select').hidden = selectingVideos;
    $('library-select').disabled = !hasVideos;
    $('library-selection').hidden = !selectingVideos;
    for (const id of ['library-select-latest-20', 'library-select-latest-100', 'library-select-all']) {
      $(id).disabled = !hasVideos || savingLibraryZip;
    }
    $('library-save-zip').disabled = $('library-clear-selection').disabled = !count || savingLibraryZip;
    $('library-selection-done').disabled = savingLibraryZip;
    const selectionText = savingLibraryZip ? 'Saving ZIP…' : count + (count === 1 ? ' video selected' : ' videos selected');
    if ($('library-selection-count').textContent !== selectionText) $('library-selection-count').textContent = selectionText;
    for (const [id, { checkbox }] of libraryCache) {
      checkbox.parentElement.hidden = !selectingVideos;
      checkbox.checked = selectedVideoIds.has(id);
      checkbox.disabled = savingLibraryZip;
    }
  }
  function selectLibraryVideos(limit) {
    if (savingLibraryZip) return;
    selectedVideoIds.clear();
    if (limit > 0) {
      const completedTime = job => Date.parse(job.completedAt) || Date.parse(job.createdAt) || 0;
      const newest = state.jobs.filter(job => libraryCache.has(job.id)).sort((a, b) => completedTime(b) - completedTime(a));
      for (const job of newest.slice(0, limit)) selectedVideoIds.add(job.id);
    }
    $('library-zip-error').hidden = true;
    renderLibrarySelection();
  }
  async function saveLibraryZip() {
    if (savingLibraryZip || !selectedVideoIds.size) return;
    const ids = Array.from(selectedVideoIds);
    const errorNote = $('library-zip-error');
    errorNote.hidden = true;
    savingLibraryZip = true;
    renderLibrarySelection();
    try {
      const result = await bridge.exportZip({ ids });
      if (result?.saved) showToast('ZIP saved with ' + result.count + (result.count === 1 ? ' video.' : ' videos.'));
    } catch (error) {
      errorNote.hidden = false;
      errorNote.textContent = errorMessage(error);
    } finally {
      savingLibraryZip = false;
      renderLibrarySelection();
      if (view === 'library' && document.activeElement === document.body) {
        const save = $('library-save-zip');
        (save.disabled ? $('library-selection-done') : save).focus();
      }
    }
  }
  function renderLibrary(jobs) {
    const complete = jobs.filter(job => job.status === 'completed' && job.videoPath);
    const completeIds = new Set(complete.map(job => job.id));
    for (const id of libraryCache.keys()) if (!completeIds.has(id)) libraryCache.delete(id);
    for (const id of selectedVideoIds) if (!completeIds.has(id)) selectedVideoIds.delete(id);
    if (!complete.length) {
      $('library-grid').replaceChildren(emptyState('Your story collection starts here.', 'Completed videos will appear here after they have been downloaded from your provider. Add your first prompt in Create.', 'film'));
      renderLibrarySelection();
      return;
    }
    const cards = complete.map(job => {
      const signature = JSON.stringify(job);
      const cached = libraryCache.get(job.id);
      if (cached?.signature === signature) return cached.node;
      const card = element('article', 'video-card');
      const body = element('div', 'video-card-body');
      const title = job.title || job.prompt;
      const prompt = element('p', 'job-prompt', title); prompt.title = job.prompt;
      const checkbox = element('input');
      checkbox.type = 'checkbox';
      const selectionLabel = title?.length > 120 ? title.slice(0, 117) + '…' : title;
      checkbox.setAttribute('aria-label', 'Select for ZIP: ' + (selectionLabel || 'Video'));
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedVideoIds.add(job.id);
        else selectedVideoIds.delete(job.id);
        $('library-zip-error').hidden = true;
        renderLibrarySelection();
      });
      const selection = element('label', 'video-zip-selection');
      selection.append(checkbox, document.createTextNode('Select for ZIP'));
      const meta = element('div', 'job-meta'); meta.append(element('span', '', modelName(job.modelId)), element('span', '', timeLabel(job.createdAt)));
      meta.append(durationBadge(job));
      const footer = element('div', 'video-card-footer');
      footer.append(watchButton(job), reelButton(job), button('Show in folder', () => bridge.revealVideo({ id: job.id }), 'folder'), button('Export video', async () => {
        const result = await bridge.exportVideo({ id: job.id }); if (result?.saved) showToast('Video exported.');
      }, 'download'));
      body.append(prompt, meta);
      if (isStory(job)) body.append(element('p', 'story-library-note', 'Two separate AI shots joined into one edited video.'));
      body.append(footer); card.append(selection, makeVideo(job), body);
      libraryCache.set(job.id, { signature, node: card, checkbox }); return card;
    });
    syncChildren($('library-grid'), cards);
    renderLibrarySelection();
  }
  function render() {
    renderModels(); renderStatus();
    const signature = JSON.stringify({ jobs: state.jobs, models: state.models.map(model => [model.id, model.name]), modelAliases: state.modelAliases });
    if (signature !== lastContentSignature) {
      lastContentSignature = signature;
      const jobs = newestJobs();
      const generated = jobs.filter(job => job.kind !== 'reel');
      renderChat(generated); renderQueue(generated); renderLibrary(jobs);
    }
    const warning = [state.recoveryWarning, state.queueError, state.credentialWarning].filter(Boolean).join(' ');
    $('system-banner').textContent = warning;
    $('system-banner').hidden = !warning;
    if (warning && warning !== lastWarning) showToast(warning, true);
    lastWarning = warning;
  }
  async function refresh() {
    if (!bridge) throw new Error('The desktop connection is unavailable. Please reopen AI Video Studio.');
    if (refreshPromise) { refreshAgain = true; return refreshPromise; }
    refreshPromise = (async () => {
      do {
        refreshAgain = false;
        const next = await bridge.snapshot();
        state = { ...next, jobs: Array.isArray(next.jobs) ? next.jobs : [], models: Array.isArray(next.models) ? next.models : [] };
        render();
      } while (refreshAgain);
    })();
    try { await refreshPromise; }
    finally { refreshPromise = null; }
  }
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refresh().catch(error => showToast(errorMessage(error), true)), 100);
  }
  function batchPrompts() { return $('batch-input').value.split(/\r?\n/).map(line => line.trim()).filter(Boolean); }
  function updatePromptLength() { $('prompt-length').textContent = $('prompt-input').value.length.toLocaleString() + ' / 10,000'; }
  function ensureFreeReady() {
    if (state.ready !== true || state.freeOnly !== true) {
      setView('settings'); renderStatus();
      throw new Error('The free provider is unavailable. Your saved prompts will stay paused.');
    }
  }
  async function startPendingQueue() {
    await refresh();
    const pending = state.jobs.filter(job => job.status === 'pending' && state.models.some(model => model.id === job.modelId && model.available));
    const monitoringOnly = pending.length === 0 && state.jobs.some(job => IN_PROGRESS.has(job.status) && job.remote) && state.paused;
    if (!pending.length && !monitoringOnly) { showToast('Enter a prompt and click Generate first.'); return; }
    ensureFreeReady();
    await bridge.startQueue({ approvedJobIds: pending.map(job => job.id), automatic: pending.length > 0 });
    showToast(monitoringOnly ? 'Provider progress checks resumed.' : 'Queue started. Free GPU quota and waiting times apply.');
  }
  async function startAddedPrompts(result, automatic = false) {
    if (!Array.isArray(result?.addedJobIds) || !result.addedJobIds.length) {
      throw new Error('Your prompts were saved, but could not be started. Use Start queue to continue.');
    }
    try { await bridge.startQueue({ approvedJobIds: result.addedJobIds, automatic }); }
    catch (error) { throw new Error('Your prompts were saved. Generation could not start: ' + errorMessage(error)); }
  }

  decorateIcons();
  $('open-provider').addEventListener('click', () => action(() => bridge.openProviderSite(), $('open-provider')));
  document.querySelector('.voice-panel .field-help').textContent = 'Voice is transcribed locally with Windows speech or the included offline Whisper model. No provider credits or speech language download is needed.';
  document.querySelectorAll('[data-view]').forEach(node => node.addEventListener('click', () => { setView(node.dataset.view); renderStatus(); }));
  document.querySelector('.brand').addEventListener('click', event => { event.preventDefault(); setView('create'); renderStatus(); });
  $('top-settings').addEventListener('click', () => { setView('settings'); renderStatus(); });
  $('connect-provider').addEventListener('click', () => { setView('settings'); renderStatus(); $('open-provider').focus(); });
  $('footer-queue').addEventListener('click', () => { setView('queue'); renderStatus(); });
  $('library-select').addEventListener('click', () => {
    selectingVideos = true;
    renderLibrarySelection();
    $('library-select-latest-20').focus();
  });
  $('library-select-latest-20').addEventListener('click', () => selectLibraryVideos(20));
  $('library-select-latest-100').addEventListener('click', () => selectLibraryVideos(100));
  $('library-select-all').addEventListener('click', () => selectLibraryVideos(libraryCache.size));
  $('library-clear-selection').addEventListener('click', () => {
    selectLibraryVideos(0);
    $('library-select-latest-20').focus();
  });
  $('library-selection-done').addEventListener('click', () => {
    selectingVideos = false;
    selectLibraryVideos(0);
    $('library-select').focus();
  });
  $('library-save-zip').addEventListener('click', () => { void saveLibraryZip(); });
  $('prompt-input').addEventListener('input', updatePromptLength);
  $('prompt-input').addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); $('prompt-form').requestSubmit(); }
  });
  $('prompt-form').addEventListener('submit', event => {
    event.preventDefault();
    action(async () => {
      const prompt = $('prompt-input').value.trim();
      if (!prompt) throw new Error('Describe the video you want to create.');
      ensureFreeReady();
      const result = await bridge.addPrompts({ prompts: [prompt], modelId: $('create-model').value });
      $('prompt-input').value = ''; updatePromptLength();
      await startAddedPrompts(result);
      showToast('Generation started. Your result will appear here when it is ready.');
      await refresh(); $('chat-feed').scrollTop = $('chat-feed').scrollHeight;
    }, $('add-prompt'));
  });
  $('create-model').addEventListener('change', renderStatus);
  $('batch-model').addEventListener('change', renderStatus);
  $('batch-input').addEventListener('input', renderStatus);
  $('choose-batch-folder').addEventListener('click', () => action(async () => {
    renderStatus();
    const chosen = await bridge.chooseBatchFolder();
    if (chosen?.directory) batchOutputDirectory = chosen.directory;
  }, $('choose-batch-folder')));
  $('clear-batch-folder').addEventListener('click', () => {
    batchOutputDirectory = '';
    renderBatchFolder();
    $('choose-batch-folder').focus();
  });
  $('add-batch').addEventListener('click', () => action(async () => {
    renderBatchFolder();
    const prompts = batchPrompts();
    if (!prompts.length) throw new Error('Enter at least one prompt, one per line.');
    if (prompts.some(prompt => prompt.length > 10000)) throw new Error('Each prompt must be 10,000 characters or fewer.');
    ensureFreeReady();
    const input = { prompts, modelId: $('batch-model').value };
    if (batchOutputDirectory) input.autoExportDirectory = batchOutputDirectory;
    const result = await bridge.addPrompts(input);
    if (result?.addedJobIds?.length) {
      batchOutputDirectory = '';
      renderBatchFolder();
    }
    $('batch-input').value = '';
    await startAddedPrompts(result, true);
    showToast(prompts.length + (prompts.length === 1 ? ' prompt started.' : ' prompts started.') + ' The batch waits for confirmed free GPU allowance resets.');
  }, $('add-batch')));
  $('import-prompts').addEventListener('click', () => action(async () => {
    const imported = await bridge.pickPromptsFile();
    if (!imported) return;
    $('batch-input').value = imported.text;
    renderStatus();
    const count = batchPrompts().length;
    showToast(count + (count === 1 ? ' prompt loaded.' : ' prompts loaded.') + ' Click Generate batch to start.');
  }, $('import-prompts')));
  $('pause-queue').addEventListener('click', () => action(async () => { await bridge.pauseQueue(); showToast('New submissions paused. Already submitted requests may continue at your provider.'); }, $('pause-queue')));
  $('review-queue').addEventListener('click', () => action(startPendingQueue, $('review-queue')));
  $('voice-button').addEventListener('click', () => action(async () => {
    dictating = true; $('voice-button').classList.add('listening'); $('voice-label').textContent = 'Listening / transcribing…';
    showToast('Speak your prompt now. Voice input is processed locally; allow a moment for transcription.');
    try {
      const result = await bridge.dictate();
      const text = String(result?.text || '').trim();
      if (!text) throw new Error('No speech was recognized. Try again or type your prompt.');
      const current = $('prompt-input').value.trim();
      const combined = current ? current + ' ' + text : text;
      if (combined.length > 10000) throw new Error('Your prompt is too long. Shorten it before adding more dictation.');
      $('prompt-input').value = combined; updatePromptLength(); $('prompt-input').focus();
      showToast('Voice prompt added. Edit it or click Generate.');
    } finally {
      dictating = false; $('voice-button').classList.remove('listening'); $('voice-label').textContent = 'Voice prompt';
    }
  }, $('voice-button')));

  if (bridge) {
    bridge.onChange(scheduleRefresh);
    bridge.getVersion().then(version => { $('version').textContent = 'Version ' + version; }).catch(() => {});
    refresh().catch(error => { $('footer-state').textContent = 'Workspace could not be loaded'; showToast(errorMessage(error), true); });
  } else {
    $('footer-state').textContent = 'Desktop connection unavailable';
    $('chat-feed').replaceChildren(emptyState('Open the desktop application', 'AI Video Studio needs its desktop connection to save prompts and connect to providers.', 'info'));
    showToast('Please open AI Video Studio from its installed Windows application.', true);
  }
})();
