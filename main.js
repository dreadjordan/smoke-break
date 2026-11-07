// Smoke Break's Electron main process: a menu bar icon that starts a break when pressed, or on a timer, with its settings on right click.
// Each break covers the display under the cursor with a window prepared in advance, which starts as a copy of the desktop and is fed the live desktop.
const { app, BrowserWindow, Menu, Tray, desktopCapturer, dialog, globalShortcut, ipcMain, powerMonitor, screen, shell, systemPreferences } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createDesktopStream } = require(process.platform === 'darwin' ? './desktop-stream' : './snapshot-stream');
const { openHotkeyWindow } = require('./hotkey-window');
const { defaultHotkey, formatHotkey } = require('./src/hotkey-format');

// Why: however exact the snapshot, the real screen can differ (colour handling, a clock that ticked), so revealing or
// covering it in one frame flashes; fading the whole window over a few frames turns any difference into a soft blend.
const FADE_IN_MS = 120;
const FADE_OUT_MS = 260;
// Why: macOS tells apps under a fully opaque window that they are hidden, and browsers then stop drawing their video.
// A hair below opaque keeps them running live behind us, and is too faint to show on screen.
const BREAK_OPACITY = 0.999;

function fadeWindow(window, from, to, durationMs) {
  const startTime = Date.now();
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const progress = Math.min(1, (Date.now() - startTime) / durationMs);
      const eased = progress * progress * (3 - 2 * progress);
      window.setOpacity(from + (to - from) * eased);
      if (progress >= 1) {
        clearInterval(timer);
        resolve();
      }
    }, 8);
  });
}

const desktopStream = createDesktopStream((frame) => {
  if (preparedBreak && !preparedBreak.window.isDestroyed()) preparedBreak.window.webContents.send('desktop-frame', frame);
}, () => {
  // Why: a break can't go on without the helper, and one still waiting for its snapshot would otherwise hang and block every later press.
  screenPermissionGranted = false;
  if (breakRunning) preparedBreak.window.destroy();
});
const BREAK_LENGTHS = [
  { label: '30 Seconds', seconds: 30 },
  { label: '1 Minute', seconds: 60 },
  { label: '2 Minutes', seconds: 120 },
  { label: '3 Minutes', seconds: 180 },
  { label: '5 Minutes', seconds: 300 },
];
const AUTOMATIC_BREAKS = [
  { label: 'Off', minutes: 0 },
  { label: 'Every 15 Minutes', minutes: 15 },
  { label: 'Every 30 Minutes', minutes: 30 },
  { label: 'Every 60 Minutes', minutes: 60 },
];
const CREATOR_LINK = 'https://x.com/dreadjordan';
const DEFAULT_HOTKEY = defaultHotkey(process.platform);
const DEFAULT_SETTINGS = { breakSeconds: 30, automaticMinutes: 0, fillBackground: false, sound: true, hotkey: DEFAULT_HOTKEY };

let settings = null;
let automaticBreakTimer = null;
let hotkeyAvailable = false;
let breakRunning = false;
let breakVisible = false;
let quitting = false;
// Why: asking macOS costs about 25ms on every press; losing the permission makes the helper exit, which clears this.
let screenPermissionGranted = false;
let preparedBreak = null;
let tray = null;
let menu = null;

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function changeSetting(key, value) {
  settings = { ...settings, [key]: value };
  fs.writeFileSync(settingsPath(), JSON.stringify(settings));
  // The next break's page is already loaded, so it needs telling.
  preparedBreak?.window.webContents.send('settings-changed', settings);
  buildMenu();
  scheduleAutomaticBreak();
}

ipcMain.on('get-settings', (event) => {
  event.returnValue = settings;
});

// Why: without this permission the capture comes back empty and the break could never appear, so send the user to grant it instead.
async function hasScreenPermission() {
  if (screenPermissionGranted) return true;
  screenPermissionGranted = systemPreferences.getMediaAccessStatus('screen') === 'granted';
  if (screenPermissionGranted) return true;
  await desktopCapturer.getSources({ types: ['screen'] });
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  return false;
}

// Why: creating a window and loading its page took about 115ms of each click, so the next break's window waits hidden and fully loaded.
function prepareBreak() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const window = new BrowserWindow({
    ...display.bounds,
    frame: false,
    show: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    enableLargerThanScreen: true,
    // Why: the panel never activates, so without this the first click on the Background switch would be swallowed.
    acceptFirstMouse: true,
    backgroundColor: '#000000',
    title: 'Smoke Break',
    // Why: a non-activating panel takes keystrokes without activating Smoke Break, so the menu bar and other windows keep
    // their active look throughout and closing reveals exactly what the snapshot showed; activating caused a flicker.
    type: process.platform === 'darwin' ? 'panel' : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'src', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Why: the page sits hidden until the click, and must draw its first frames before it is shown.
      backgroundThrottling: false,
    },
  });
  // Why: the screen-saver level is what lets a borderless window cover the menu bar and Dock.
  window.setAlwaysOnTop(true, 'screen-saver');
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.once('closed', () => {
    ipcMain.removeAllListeners('show-window');
    ipcMain.removeAllListeners('request-desktop-still');
    ipcMain.removeAllListeners('audio-distance');
    ipcMain.removeAllListeners('finish');
    globalShortcut.unregister('Escape');
    breakVisible = false;
    desktopStream.end();
    breakRunning = false;
    // Why: quitting closes this window too, and preparing a new one here would cancel the quit.
    if (quitting) return;
    prepareBreak();
    scheduleAutomaticBreak();
  });
  const pageLoaded = new Promise((resolve) => window.webContents.once('did-finish-load', resolve));
  window.loadFile(path.join(__dirname, 'src', 'index.html'));
  preparedBreak = { window, pageLoaded };
  desktopStream.prepare();
}

async function startBreak() {
  if (breakRunning || !(await hasScreenPermission())) return;
  breakRunning = true;
  const { window, pageLoaded } = preparedBreak;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  window.setBounds(display.bounds);
  await pageLoaded;
  // Every process is listed because Chromium plays our sound from a separate audio process.
  desktopStream.begin(display.id, app.getAppMetrics().map((metric) => metric.pid), { sound: settings.sound, live: !settings.fillBackground });

  ipcMain.once('request-desktop-still', () => desktopStream.requestStill());
  ipcMain.on('audio-distance', (_event, distance) => desktopStream.setAudioDistance(distance));
  ipcMain.once('show-window', () => {
    window.setOpacity(0);
    window.show();
    window.focus();
    breakVisible = true;
    fadeWindow(window, 0, BREAK_OPACITY, FADE_IN_MS);
    // Why: if keyboard focus ends up elsewhere, a global shortcut still lets Escape end the break.
    globalShortcut.register('Escape', () => window.webContents.send('escape'));
  });
  ipcMain.once('finish', async () => {
    ipcMain.removeAllListeners('audio-distance');
    desktopStream.end();
    await fadeWindow(window, BREAK_OPACITY, 0, FADE_OUT_MS);
    window.destroy();
  });
  window.webContents.send('begin-break');
}

// Why: counted from the end of the last break, so the gap between breaks is what was chosen however long each one lasted.
function scheduleAutomaticBreak() {
  clearTimeout(automaticBreakTimer);
  if (settings.automaticMinutes > 0) automaticBreakTimer = setTimeout(takeAutomaticBreak, settings.automaticMinutes * 60 * 1000);
}

// Why: skipped rather than queued while locked or without permission: a break nobody can see is pointless, and only a press should open System Settings.
function takeAutomaticBreak() {
  if (powerMonitor.getSystemIdleState(1) === 'locked' || !screenPermissionGranted) scheduleAutomaticBreak();
  else startBreak();
}

// Starts a break, or ends the one on screen. Ignored during the moment a break is starting, which has nothing yet to end.
function pressHotkey() {
  if (!breakRunning) startBreak();
  else if (breakVisible) preparedBreak.window.webContents.send('escape');
}

function registerHotkey() {
  hotkeyAvailable = globalShortcut.register(settings.hotkey, pressHotkey);
  buildMenu();
}

function setHotkey() {
  globalShortcut.unregister(settings.hotkey);
  openHotkeyWindow({
    current: settings.hotkey,
    defaultValue: DEFAULT_HOTKEY,
    onChosen: (accelerator) => changeSetting('hotkey', accelerator),
    onClosed: registerHotkey,
  });
}

async function showInfo() {
  app.focus({ steal: true });
  const { response } = await dialog.showMessageBox({
    message: 'Smoke Break',
    detail: `Version ${app.getVersion()}\nCreated by Jordan (aka DreadJordan)`,
    icon: path.join(__dirname, 'assets', 'app-icon.png'),
    buttons: ['Close', 'x.com/dreadjordan'],
    defaultId: 0,
    cancelId: 0,
  });
  if (response === 1) shell.openExternal(CREATOR_LINK);
}

function buildMenu() {
  menu = Menu.buildFromTemplate([
    {
      label: 'Settings',
      submenu: [
        {
          label: 'Break Length',
          submenu: BREAK_LENGTHS.map(({ label, seconds }) => ({
            label,
            type: 'radio',
            checked: settings.breakSeconds === seconds,
            click: () => changeSetting('breakSeconds', seconds),
          })),
        },
        {
          label: 'Automatic Breaks',
          submenu: AUTOMATIC_BREAKS.map(({ label, minutes }) => ({
            label,
            type: 'radio',
            checked: settings.automaticMinutes === minutes,
            click: () => changeSetting('automaticMinutes', minutes),
          })),
        },
        {
          label: `Set Hotkey… (${formatHotkey(settings.hotkey, process.platform)}${hotkeyAvailable ? '' : ', In Use'})`,
          click: setHotkey,
        },
        { type: 'separator' },
        {
          label: 'Fill Background (Experimental)',
          type: 'checkbox',
          checked: settings.fillBackground,
          click: () => changeSetting('fillBackground', !settings.fillBackground),
        },
        { label: 'Sound', type: 'checkbox', checked: settings.sound, click: () => changeSetting('sound', !settings.sound) },
        { type: 'separator' },
        { label: 'Info…', click: showInfo },
      ],
    },
    { type: 'separator' },
    { label: 'Quit Smoke Break', click: () => app.quit() },
  ]);
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'assets', process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'));
  tray.setToolTip('Take a Smoke Break');
  tray.setIgnoreDoubleClickEvents(true);
  buildMenu();
  // Why: on press, not release, as native menu bar items do; waiting for the release added a noticeable beat. Windows has no press event.
  tray.on(process.platform === 'darwin' ? 'mouse-down' : 'click', startBreak);
  // Why: not setContextMenu, which would make the left click open the menu instead of starting a break.
  tray.on('right-click', () => tray.popUpContextMenu(menu));
}

if (app.requestSingleInstanceLock()) {
  app.dock?.hide();
  app.whenReady().then(() => {
    // Why: the default menu's shortcuts, such as Command+Q, would act on keys meant to be recorded in the Set Hotkey window.
    Menu.setApplicationMenu(null);
    settings = readSettings();
    createTray();
    registerHotkey();
    screenPermissionGranted = systemPreferences.getMediaAccessStatus('screen') === 'granted';
    prepareBreak();
    scheduleAutomaticBreak();
  });
  // Breaks come and go; the app stays in the menu bar between them.
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
} else {
  app.quit();
}
