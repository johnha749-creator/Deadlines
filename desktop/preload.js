'use strict';
// Runs in the sandboxed renderer before the page. Exposes a small, fixed API as
// window.deadlineDesktop; the page never gets Node, IPC, or the Canvas token itself.
const { contextBridge, ipcRenderer } = require('electron');

const versionArg = process.argv.find((a) => a.startsWith('--deadline-version='));
const version = versionArg ? versionArg.slice('--deadline-version='.length) : '';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

contextBridge.exposeInMainWorld('deadlineDesktop', {
  isDesktop: true,
  platform: process.platform,
  version,
  canvas: {
    connect: (opts) => ipcRenderer.invoke('canvas:connect', { baseUrl: str(opts && opts.baseUrl), token: str(opts && opts.token) }),
    status: () => ipcRenderer.invoke('canvas:status'),
    sync: () => ipcRenderer.invoke('canvas:sync'),
    disconnect: () => ipcRenderer.invoke('canvas:disconnect'),
  },
});
