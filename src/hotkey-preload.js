// The Set Hotkey window's bridge to the main process: reads the current hotkey, and offers a new one or cancels.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hotkeyWindow', {
  current: () => ipcRenderer.sendSync('get-hotkey'),
  choose: (accelerator) => ipcRenderer.invoke('choose-hotkey', accelerator),
  cancel: () => ipcRenderer.send('cancel-hotkey'),
});
