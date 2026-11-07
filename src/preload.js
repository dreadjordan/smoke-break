// Smoke Break's preload bridge: the only channel between the sandboxed scene and the main process.
// It relays the start of a break, desktop frames, Escape and the settings, and lets the scene reveal the window and close the app when the break ends.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('smokeBreak', {
  settings: () => ipcRenderer.sendSync('get-settings'),
  onSettingsChanged: (callback) => ipcRenderer.on('settings-changed', (_event, settings) => callback(settings)),
  onBeginBreak: (callback) => ipcRenderer.on('begin-break', () => callback()),
  onDesktopFrame: (callback) => ipcRenderer.on('desktop-frame', (_event, frame) => callback(frame)),
  requestDesktopStill: () => ipcRenderer.send('request-desktop-still'),
  setAudioDistance: (distance) => ipcRenderer.send('audio-distance', distance),
  showWindow: () => ipcRenderer.send('show-window'),
  pageAlive: () => ipcRenderer.send('page-alive'),
  finish: () => ipcRenderer.send('finish'),
  onEscape: (callback) => ipcRenderer.on('escape', () => callback()),
});
