'use strict';
const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, protocol, Menu, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Readable } = require('node:stream');
const { Store } = require('../core/store');
const { Queue } = require('../core/queue');
const { MODELS, FalProvider } = require('../core/providers');
const { Vault } = require('./vault');
const { downloadVideo } = require('./download');
const { dictate } = require('./voice');

protocol.registerSchemesAsPrivileged([{ scheme: 'studio-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }]);
if (process.env.STUDIO_DATA_DIR && !app.isPackaged) app.setPath('userData', path.resolve(process.env.STUDIO_DATA_DIR));
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) { app.quit(); } else { boot(); }

function boot() {
  let window, queue, store, vault, mediaDir;
  let voiceAvailable = process.platform === 'win32';
  let voiceReason = '';
  let dictating = false;
  let quitting = false;
  let credentialWarning = '';
  let credentialsBusy = false;
  const rendererPath = path.join(__dirname, '..', 'renderer', 'index.html');
  const rendererUrl = pathToFileURL(rendererPath).href;
  function changed() {
    if (window && !window.isDestroyed()) window.webContents.send('studio:changed');
  }
  function snapshot() {
    return { ...queue.snapshot(), models: MODELS, settings: store.snapshot().settings,
      credentials: { fal: vault.hasKey() }, voiceAvailable, voiceReason, credentialWarning };
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
    return target;
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
    window.on('close', event => {
      if (!quitting && queue && !queue.snapshot().paused) {
        const choice = dialog.showMessageBoxSync(window, { type: 'question', buttons: ['Keep studio open', 'Pause and close'], defaultId: 0, cancelId: 0,
          title: 'Close AI Video Studio?', message: 'Pause this queue and close?', detail: 'An already submitted video may continue on the provider. Your queue and request IDs are saved. Reopen the studio to resume checking its progress.' });
        if (choice === 0) { event.preventDefault(); return; }
      }
      queue?.pause();
    });
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
    vault = new Vault(dataDir, safeStorage);
    try { await vault.load(); } catch { credentialWarning = 'Your saved API key could not be unlocked. Please save it again in Settings.'; }
    queue = new Queue({ store, models: MODELS, providerFactory: () => new FalProvider({ apiKey: vault.getKey() }),
      download: (url, id) => downloadVideo(url, id, mediaDir), onChange: changed, pollIntervalMs: 4000 });
    queue.recover();
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    protocol.handle('studio-media', async request => {
      try {
        const url = new URL(request.url);
        if (url.hostname !== 'video' || request.method !== 'GET') return new Response(null, { status: 403 });
        const id = decodeURIComponent(url.pathname.slice(1));
        const target = localVideo(getJob(id));
        const size = fs.statSync(target).size;
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
        const headers = { 'Content-Type': target.endsWith('.webm') ? 'video/webm' : 'video/mp4', 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes' };
        if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
        return new Response(Readable.toWeb(fs.createReadStream(target, { start, end })), { status, headers });
      } catch { return new Response('Video unavailable', { status: 404 }); }
    });
    handle('snapshot', snapshot);
    handle('getVersion', () => app.getVersion());
    handle('openProviderSite', () => shell.openExternal('https://fal.ai'));
    handle('addPrompts', input => { queue.addPrompts(input?.prompts, input?.modelId); return snapshot(); });
    handle('startQueue', input => {
      if (credentialsBusy) throw new Error('Wait for the provider settings to finish saving, then review the queue again.');
      vault.getKey(); queue.start(input); return snapshot();
    });
    handle('pauseQueue', () => { queue.pause(); return snapshot(); });
    handle('cancelJob', async input => { await queue.cancel(input?.id); return snapshot(); });
    handle('retryJob', async input => {
      const job = getJob(input?.id);
      if (job.remoteVideoUrl && job.status === 'needs_attention') await queue.retryDownload(job.id);
      else if (job.remote && job.status === 'needs_attention') queue.resume(job.id);
      else queue.retry(job.id);
      return snapshot();
    });
    handle('saveSettings', async input => {
      if (!input || typeof input !== 'object') throw new Error('Settings are missing.');
      if (credentialsBusy) throw new Error('A provider settings update is already in progress. Please wait a moment.');
      credentialsBusy = true;
      try {
        if (input.clearFalKey === true) { queue.pause(); vault.clear(); }
        else if (typeof input.falKey === 'string') { queue.pause(); await vault.save(input.falKey); credentialWarning = ''; }
        changed(); return snapshot();
      } finally { credentialsBusy = false; }
    });
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
  app.on('window-all-closed', () => { quitting = true; queue?.dispose(); app.quit(); });
  app.on('before-quit', () => { quitting = true; queue?.pause(); });
}
