// The Set Hotkey window for the main process: opens it, and tests whether a combo can be registered before accepting it.
const { BrowserWindow, app, globalShortcut, ipcMain } = require('electron');
const path = require('node:path');

let hotkeyWindow = null;

function canRegister(accelerator) {
  const registered = globalShortcut.register(accelerator, () => {});
  if (registered) globalShortcut.unregister(accelerator);
  return registered;
}

// `current` is the hotkey now, `onChosen` receives a new one, and `onClosed` runs however the window was closed.
// Why: the live hotkey is switched off first by the caller, or pressing it here would start a break instead of being recorded.
function openHotkeyWindow({ current, defaultValue, onChosen, onClosed }) {
  if (hotkeyWindow) {
    hotkeyWindow.focus();
    return;
  }
  hotkeyWindow = new BrowserWindow({
    width: 420,
    height: 210,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    show: false,
    title: 'Set Hotkey',
    webPreferences: { preload: path.join(__dirname, 'src', 'hotkey-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  ipcMain.on('get-hotkey', (event) => {
    event.returnValue = { hotkey: current, defaultValue, platform: process.platform };
  });
  ipcMain.once('cancel-hotkey', () => hotkeyWindow.close());
  ipcMain.handle('choose-hotkey', (_event, accelerator) => {
    if (accelerator !== current && !canRegister(accelerator)) return false;
    onChosen(accelerator);
    hotkeyWindow.close();
    return true;
  });
  hotkeyWindow.once('closed', () => {
    hotkeyWindow = null;
    ipcMain.removeAllListeners('get-hotkey');
    ipcMain.removeAllListeners('cancel-hotkey');
    ipcMain.removeHandler('choose-hotkey');
    onClosed();
  });
  hotkeyWindow.once('ready-to-show', () => {
    hotkeyWindow.show();
    // Why: a menu bar app isn't the active app, so without this the window opens behind others and never receives the keys.
    app.focus({ steal: true });
  });
  hotkeyWindow.loadFile(path.join(__dirname, 'src', 'hotkey.html'));
}

module.exports = { openHotkeyWindow };
