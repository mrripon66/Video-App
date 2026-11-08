'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, protocol, Menu, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Readable } = require('node:stream');
const { randomUUID } = require('node:crypto');
const { Store } = require('../core/store');
const { Queue } = require('../core/queue');
const { FREE_MODELS, FreeProvider } = require('../core/free-provider');
const { MODELS, PUBLIC_MODELS, MODEL_ALIASES } = require('../core/catalog');
const { MUSIC_PRESETS } = require('../core/music-styles');
const { downloadVideo } = require('./download');
const { createComposer } = require('./compose');
const { createReel } = require('./reel');
const { SOUND_PRESETS } = require('./sound');
const { narrationAvailable, NARRATION_VOICES } = require('./narration');
const { promptSoundAvailable } = require('./prompt-sound');
const { createProduction, planStudioVideo } = require('./production');
const { writeVideoZip } = require('./video-zip');
const { createAutoExporter } = require('./auto-export');
const { dictate } = require('./voice');

protocol.registerSchemesAsPrivileged([{ scheme: 'studio-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }]);
if (process.env.STUDIO_DATA_DIR && !app.isPackaged) app.setPath('userData', path.resolve(process.env.STUDIO_DATA_DIR));
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) { app.quit(); } else { boot(); }

function boot() {
  let window, queue, store, mediaDir, autoExporter, zipTransfer;
  let voiceAvailable = process.platform === 'win32';
  let voiceReason = '';
  let dictating = false;
  let exportingReel = false;
  let exportingZip = false;
  let quitting = false;
  const chosenExportFolders = new Set();
  const rendererPath = path.join(__dirname, '..', 'renderer', 'index.html');
  const rendererUrl = pathToFileURL(rendererPath).href;
  function changed() {
    if (window && !window.isDestroyed()) window.webContents.send('studio:changed');
  }
  function copyFinishedVideos() {
    autoExporter.kick().catch(error => console.error('Automatic export could not update the library:', error));
  }
  function snapshot() {
    return { ...queue.snapshot(), models: PUBLIC_MODELS, modelAliases: { ...MODEL_ALIASES, 'local-reel': 'Reel' }, ready: true, freeOnly: true,
      provider: { name: 'Hugging Face ZeroGPU', description: 'Free shared GPU access with daily quotas and waiting queues.',
        docsUrl: 'https://huggingface.co/docs/hub/spaces-zerogpu' },
      credentials: { fal: false }, voiceAvailable, voiceReason, narrationAvailable: narrationAvailable(), promptSoundAvailable: promptSoundAvailable() };
  }
  function getJob(id) {
    if (typeof id !== 'string') throw new Error('Choose a video first.');
    const job = store.snapshot().jobs.find(j => j.id === id);
    if (!job) throw new Error('This job no longer exists.');
    return job;
  }
  function localVideo(job) {
    if (job.status !== 'completed' || !job.videoPath) throw new Error('This video has not finished downloading.');
    const target = path.resolve(job.videoPath);
    const rel = path.relative(mediaDir, target);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !fs.existsSync(target)) throw new Error('The saved video is missing.');
    const canonical = fs.realpathSync(target);
    const canonicalRelative = path.relative(fs.realpathSync(mediaDir), canonical);
    if (!canonicalRelative || canonicalRelative.startsWith('..') || path.isAbsolute(canonicalRelative) || !fs.statSync(canonical).isFile()) {
      throw new Error('The saved video is outside the library.');
    }
    return canonical;
  }
  async function exportFolder(directory) {
    const canonical = await fs.promises.realpath(directory);
    const relative = path.relative(await fs.promises.realpath(store.dataDir), canonical);
    const insideStudio = !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
    if (insideStudio || !(await fs.promises.stat(canonical)).isDirectory()) {
      throw new Error('Choose a folder outside the studio’s internal storage.');
    }
    return canonical;
  }
  function handle(name, callback) {
    ipcMain.handle('studio:' + name, async (event, input) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== rendererUrl) {
        throw new Error('This action is only available inside AI Video Studio.');
      }
      return callback(input);
    });
  }
  function createWindow() {
    window = new BrowserWindow({ width: 1360, height: 900, minWidth: 940, minHeight: 650,
      title: 'AI Video Studio', backgroundColor: '#f6f7f9', autoHideMenuBar: true, icon: path.join(__dirname, '..', 'assets', 'icon.png'),
      webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false,
        contextIsolation: true, sandbox: true, webSecurity: true, spellcheck: true }
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.on('closed', () => { window = null; });
    window.loadFile(rendererPath);
  }
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    const dataDir = app.getPath('userData');
    fs.mkdirSync(dataDir, { recursive: true });
    mediaDir = path.join(dataDir, 'videos');
    fs.mkdirSync(mediaDir, { recursive: true });
    store = new Store(dataDir);
    store.load();
    autoExporter = createAutoExporter({ store, localVideo, resolveFolder: exportFolder, onChange: changed });
    const production = createProduction({ directory: mediaDir, compose: createComposer({ directory: mediaDir }) });
    queue = new Queue({ store, models: MODELS, providerFactory: (model, context) => {
      if (model.provider !== 'huggingface' || !FREE_MODELS.some(entry => entry.id === model.id)) throw new Error('This application permits only the configured free provider.');
      const videoPreset = context?.purpose === 'story' ? (context.orientation === 'portrait' ? 'film-portrait' : 'film') : 'detail';
      return new FreeProvider({ videoPreset });
    },
      planVideo: planStudioVideo, prepareVideo: production.prepareVideo,
      composeVideo: input => production.finishVideo(getJob(input.jobId), input),
      download: (url, id) => downloadVideo(url, id, mediaDir), onChange: () => {
        changed();
        copyFinishedVideos();
      }, pollIntervalMs: 4000 });
    queue.recover();
    copyFinishedVideos();
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    protocol.handle('studio-media', async request => {
      try {
        const url = new URL(request.url);
        if (url.hostname !== 'video' || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 403 });
        const id = decodeURIComponent(url.pathname.slice(1));
        const target = localVideo(getJob(id));
        const size = fs.statSync(target).size;
        if (!size) return new Response(null, { status: 404 });
        let start = 0, end = size - 1, status = 200;
        const range = request.headers.get('range');
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
          if (!match[1]) { start = Math.max(0, size - Number(match[2])); }
          else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
          if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
          status = 206;
        }
        const headers = { 'Content-Type': /\.webm$/i.test(target) ? 'video/webm' : 'video/mp4', 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes' };
        if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
        if (request.method === 'HEAD') return new Response(null, { status, headers });
        return new Response(Readable.toWeb(fs.createReadStream(target, { start, end })), { status, headers });
      } catch { return new Response('Video unavailable', { status: 404 }); }
    });
    handle('snapshot', snapshot);
    handle('getVersion', () => app.getVersion());
    handle('openProviderSite', () => shell.openExternal('https://huggingface.co/spaces/Lightricks/LTX-2-3'));
    handle('chooseBatchFolder', async () => {
      const result = await dialog.showOpenDialog(window, { title: 'Choose where to save finished videos', properties: ['openDirectory', 'createDirectory'] });
      if (result.canceled || !result.filePaths.length) return null;
      const directory = await exportFolder(result.filePaths[0]);
      chosenExportFolders.add(directory);
      return { directory };
    });
    handle('addPrompts', input => {
      const directory = input?.autoExportDirectory;
      if (directory !== undefined && !chosenExportFolders.has(directory)) throw new Error('Choose a save folder for this batch first.');
      const jobs = queue.addPrompts(input?.prompts, input?.modelId, { autoExportDirectory: directory });
      return { ...snapshot(), addedJobIds: jobs.map(job => job.id) };
    });
    handle('retryAutoExport', input => {
      const job = getJob(input?.id);
      if (job.status !== 'completed' || job.autoExport?.status !== 'failed') throw new Error('Choose a video whose folder copy failed.');
      const directory = input?.autoExportDirectory;
      if (directory !== undefined && !chosenExportFolders.has(directory)) throw new Error('Choose a save folder first.');
      store.mutate(state => {
        const current = state.jobs.find(item => item.id === job.id);
        current.autoExport = { directory: directory ?? job.autoExport.directory, status: 'pending' };
      });
      changed();
      copyFinishedVideos();
      return snapshot();
    });
    handle('startQueue', input => { queue.start(input); return snapshot(); });
    handle('pauseQueue', () => { queue.pause(); return snapshot(); });
    handle('cancelJob', async input => { await queue.cancel(input?.id); return snapshot(); });
    handle('retryJob', async input => {
      const job = getJob(input?.id);
      if (job.status === 'needs_attention' && (job.remoteVideoUrl || (job.videoPlan && job.phase === 'compose_failed'))) await queue.retryDownload(job.id);
      else if (job.remote && job.status === 'needs_attention') queue.resume(job.id);
      else queue.retry(job.id);
      return snapshot();
    });
    handle('saveSettings', () => { throw new Error('Free-only mode needs no API key and does not accept paid provider credentials.'); });
    handle('pickPromptsFile', async () => {
      const result = await dialog.showOpenDialog(window, { title: 'Import prompts — one per line', properties: ['openFile'], filters: [{ name: 'Prompt text', extensions: ['txt'] }] });
      if (result.canceled) return null;
      const file = result.filePaths[0];
      if (fs.statSync(file).size > 5 * 1024 * 1024) throw new Error('Choose a text file smaller than 5 MB.');
      return { text: fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '') };
    });
    handle('exportVideo', async input => {
      const job = getJob(input?.id), target = localVideo(job);
      const result = await dialog.showSaveDialog(window, { title: 'Export video', defaultPath: path.join(app.getPath('videos'), `AI-Video-${job.id.slice(0, 8)}${path.extname(target)}`), filters: [{ name: 'Video', extensions: [path.extname(target).slice(1)] }] });
      if (result.canceled) return { cancelled: true };
      await fs.promises.copyFile(target, result.filePath); return { saved: true };
    });
    handle('exportZip', async input => {
      if (exportingZip) throw new Error('A ZIP is already being saved.');
      const ids = input?.ids;
      const jobs = new Map(store.snapshot().jobs.map(job => [job.id, job]));
      if (!Array.isArray(ids) || !ids.length || ids.length > jobs.size || ids.some(id => typeof id !== 'string' || !jobs.has(id))) {
        throw new Error('Select one or more completed videos from the library.');
      }
      const videos = [...new Set(ids)].map(id => {
        const job = jobs.get(id);
        return { source: localVideo(job), title: job.title || job.prompt };
      });
      exportingZip = true;
      try {
        const result = await dialog.showSaveDialog(window, { title: 'Save selected videos as ZIP',
          defaultPath: path.join(app.getPath('videos'), `AI Video Studio - ${videos.length} videos.zip`),
          filters: [{ name: 'ZIP archive', extensions: ['zip'] }] });
        if (result.canceled || !result.filePath) return { cancelled: true };
        if (path.extname(result.filePath).toLowerCase() !== '.zip') throw new Error('Save the archive with a .zip filename.');
        const parent = await exportFolder(path.dirname(result.filePath));
        zipTransfer = writeVideoZip(path.join(parent, path.basename(result.filePath)), videos);
        try {
          await zipTransfer;
        } catch (error) {
          const message = error.code === 'ENOSPC' ? 'The save folder does not have enough space for this ZIP.' :
            'The ZIP could not be saved. Check that the selected videos and save folder are still available.';
          throw new Error(message, { cause: error });
        }
        return { saved: true, count: videos.length };
      } finally { exportingZip = false; zipTransfer = undefined; }
    });
    handle('makeReel', async input => {
      if (exportingReel) throw new Error('A Reel is already being saved.');
      const { id, framing, sound, soundPrompt = '', narration = '', voice = 'warm', music = 'none' } = input || {};
      if (!['fit', 'crop'].includes(framing) || (sound !== 'none' && sound !== 'prompt' && !Object.hasOwn(SOUND_PRESETS, sound))) {
        throw new Error('Choose a framing and a sound for the Reel.');
      }
      if (music !== 'none' && !Object.hasOwn(MUSIC_PRESETS, music)) throw new Error('Choose a music style for the Reel.');
      if (typeof narration !== 'string' || narration.length > 700 || !Object.hasOwn(NARRATION_VOICES, voice)) throw new Error('Enter a short script and choose a voice.');
      if (narration.trim() && !narrationAvailable()) throw new Error('The offline narration engine is unavailable.');
      if (sound === 'prompt' && (typeof soundPrompt !== 'string' || !soundPrompt.trim() || soundPrompt.length > 500 || !promptSoundAvailable())) throw new Error('Set up the local sound model and enter a short sound description.');
      const job = getJob(id), source = localVideo(job);
      exportingReel = true;
      try {
        const result = await dialog.showSaveDialog(window, { title: 'Save vertical Reel',
          defaultPath: path.join(app.getPath('videos'), `AI-Video-${job.id.slice(0, 8)}-Reel.mp4`),
          filters: [{ name: 'MP4 video', extensions: ['mp4'] }] });
        if (result.canceled || !result.filePath) return { cancelled: true };
        if (path.extname(result.filePath).toLowerCase() !== '.mp4') throw new Error('Save the Reel with an .mp4 filename.');
        const parent = await fs.promises.realpath(path.dirname(result.filePath));
        const relative = path.relative(await fs.promises.realpath(mediaDir), parent);
        if (!relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))) {
          throw new Error('Choose a save folder outside the studio’s video library.');
        }
        const destination = path.join(parent, path.basename(result.filePath));
        await createReel({ source, destination, framing, sound, soundPrompt, narration: narration.trim(), voice, music, musicSeed: job.id, overwrite: true });
        const reelId = randomUUID();
        const videoPath = path.join(mediaDir, reelId + '.mp4');
        const timestamp = new Date().toISOString();
        await fs.promises.copyFile(destination, videoPath, fs.constants.COPYFILE_EXCL);
        try {
          store.mutate(state => state.jobs.push({ id: reelId, modelId: 'local-reel', kind: 'reel', sourceJobId: job.id,
            title: path.basename(destination, '.mp4'), prompt: job.prompt, status: 'completed', videoPath,
            createdAt: timestamp, completedAt: timestamp, attempts: [] }));
        } catch (error) {
          await fs.promises.unlink(videoPath).catch(() => {});
          throw new Error('The Reel file was saved, but the app could not add it to the library.', { cause: error });
        }
        changed();
        return { saved: true };
      } finally { exportingReel = false; }
    });
    handle('revealVideo', input => { shell.showItemInFolder(localVideo(getJob(input?.id))); });
    handle('dictate', async () => {
      if (dictating) throw new Error('Dictation is already listening.');
      dictating = true;
      try { return await dictate(); } finally { dictating = false; }
    });
    createWindow();
    dictate(true).then(() => { voiceAvailable = true; changed(); }).catch(error => { voiceAvailable = false; voiceReason = error.message; changed(); });
  }).catch(error => {
    dialog.showErrorBox('AI Video Studio could not start', error.message + '\nYour saved queue has been preserved.');
    app.quit();
  });
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting) return;
    quitting = true;
    queue?.dispose({ preserveAutomatic: true });
    const pending = [autoExporter?.stop(), zipTransfer].filter(Boolean);
    if (pending.length) {
      event.preventDefault();
      Promise.allSettled(pending).then(() => app.quit());
    }
  });
}
