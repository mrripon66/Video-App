'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const invoke = (name) => (payload) => ipcRenderer.invoke(`studio:${name}`, payload);
contextBridge.exposeInMainWorld('studio', Object.freeze({
  snapshot: invoke('snapshot'),
  addPrompts: invoke('addPrompts'),
  startQueue: invoke('startQueue'),
  pauseQueue: invoke('pauseQueue'),
  cancelJob: invoke('cancelJob'),
  retryJob: invoke('retryJob'),
  saveSettings: invoke('saveSettings'),
  pickPromptsFile: invoke('pickPromptsFile'),
  exportVideo: invoke('exportVideo'),
  revealVideo: invoke('revealVideo'),
  dictate: invoke('dictate'),
  getVersion: invoke('getVersion'),
  openProviderSite: invoke('openProviderSite'),
  onChange(callback) {
    if (typeof callback !== 'function') throw new TypeError('A callback is required.');
    const listener = () => callback();
    ipcRenderer.on('studio:changed', listener);
    return () => ipcRenderer.removeListener('studio:changed', listener);
  }
}));
