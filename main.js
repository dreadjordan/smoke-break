// Smoke Break's Electron main process: a menu bar icon that starts a break when pressed, or on a timer, with its settings on right click.
// Each break covers the display under the cursor with a window prepared in advance, which starts as a copy of the desktop and is fed the live desktop.
const { app, BrowserWindow, Menu, Tray, desktopCapturer, dialog, globalShortcut, ipcMain, powerMonitor, screen, shell, systemPreferences } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createDesktopStream } = require(process.platform === 'darwin' ? './desktop-stream' : './snapshot-stream');
const { findNewerVersion, offerUpdate } = require('./update-check');

// Why: however exact the snapshot, the real screen can differ (colour handling, a clock that ticked), so revealing or
// covering it in one frame flashes; fading the whole window over a few frames turns any difference into a soft blend.
const FADE_IN_MS = 120;
const FADE_OUT_MS = 260;
// Why: macOS tells apps under a fully opaque window that they are hidden, and browsers then stop drawing their video.
// A hair below opaque keeps them running live behind us, and is too faint to show on screen.
const BREAK_OPACITY = 0.999;
// Why: the first frame normally arrives in about 300ms, so this long without one means the helper is stuck, and every press would be ignored until it was replaced.
const BREAK_START_TIMEOUT_MS = 5000;
// Why: a break covers everything, even the Force Quit window, so nothing here may depend on the page being able to end it.
const BREAK_WATCH_INTERVAL_MS = 500;
const PAGE_SILENCE_LIMIT_MS = 2000;
// Longer than the slowest dash back and fade.
const LEAVE_LIMIT_MS = 2500;
const BREAK_OVERRUN_LIMIT_MS = 15000;

function fadeWindow(window, from, to, durationMs) {
  const startTime = Date.now();
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      // Why: the helper exiting destroys the window, which can happen during a fade.
      if (window.isDestroyed()) {
        clearInterval(timer);
        resolve();
        return;
      }
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
  if (breakRunning) abandonBreak();
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
const VOLUMES = [100, 75, 50, 25, 0];
const BACKGROUND_FILLS = [{ label: 'Mountain Village', fill: 1 }, { label: 'Dark Shanty', fill: 2 }, { label: 'None (Default)', fill: 0 }];
const UPDATE_CHECK_DELAY_MS = 15 * 1000;
// Why: a menu bar app can stay open for weeks, so checking only at launch would miss most releases.
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_RETRY_MS = 60 * 1000;
const DEFAULT_SETTINGS = { breakSeconds: 30, automaticMinutes: 0, backgroundFill: 0, ambientNoise: true, volume: 100, checkForUpdates: true, skippedVersion: null };

let settings = null;
let automaticBreakTimer = null;
let updateOfferOpen = false;
let breakRunning = false;
let breakVisible = false;
let quitting = false;
// Why: asking macOS costs about 25ms on every press; losing the permission makes the helper exit, which clears this.
let screenPermissionGranted = false;
let preparedBreak = null;
let breakWatch = null;
let lastPageHeartbeat = 0;
let tray = null;
let menu = null;

// Closing the window is all a break needs to stop, release the sound and prepare the next one.
function abandonBreak() {
  if (!preparedBreak.window.isDestroyed()) preparedBreak.window.destroy();
}

// Why: left to Electron, any error here is a raw dialog, and a repeating timer brings it back the moment it's dismissed. A break is
// never worth that: put the user back on their desktop with the app still ready.
process.on('uncaughtException', (error) => {
  console.error(error);
  if (breakRunning) abandonBreak();
});

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

ipcMain.on('page-alive', () => {
  lastPageHeartbeat = Date.now();
});

ipcMain.on('get-settings', (event) => {
  event.returnValue = settings;
});

// Why: a screen zoom in another app, such as DreadDraw's, redraws a capture of the display over it. With both apps capturing, each
// films the other and the view goes black, so it needs to know when to step aside and when it may zoom again.
function announceBreak(state) {
  if (process.platform === 'darwin') systemPreferences.postNotification(`com.dreadjordan.smokebreak.${state}`, {}, true);
}

// Why: without this permission the capture comes back empty and the break could never appear, so send the user to grant it instead.
// Keeps the helper's own watchdog fed, and ends a break whose page has gone quiet or has run far past its length.
function watchBreak() {
  const deadline = Date.now() + settings.breakSeconds * 1000 + BREAK_OVERRUN_LIMIT_MS;
  breakWatch = setInterval(() => {
    desktopStream.keepAlive();
    const now = Date.now();
    if ((breakVisible && now - lastPageHeartbeat > PAGE_SILENCE_LIMIT_MS) || now > deadline) abandonBreak();
  }, BREAK_WATCH_INTERVAL_MS);
}

// Asks the page for its usual dash back, and closes the window if that doesn't happen.
function leaveBreak() {
  const { window } = preparedBreak;
  window.webContents.send('escape');
  setTimeout(() => {
    if (!window.isDestroyed()) window.destroy();
  }, LEAVE_LIMIT_MS);
}

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
    clearInterval(breakWatch);
    breakVisible = false;
    desktopStream.end();
    breakRunning = false;
    announceBreak('ended');
    // Why: quitting closes this window too, and preparing a new one here would cancel the quit.
    if (quitting) return;
    prepareBreak();
    scheduleAutomaticBreak();
  });
  // Why: a dead page can't end its own break, and its window would sit over the whole screen with no way out.
  const replaceDeadPage = () => {
    if (!window.isDestroyed()) window.destroy();
  };
  window.webContents.once('render-process-gone', replaceDeadPage);
  window.once('unresponsive', replaceDeadPage);
  const pageLoaded = new Promise((resolve) => window.webContents.once('did-finish-load', resolve));
  window.loadFile(path.join(__dirname, 'src', 'index.html'));
  preparedBreak = { window, pageLoaded };
  desktopStream.prepare();
}

async function startBreak() {
  if (breakRunning || !(await hasScreenPermission())) return;
  breakRunning = true;
  announceBreak('began');
  const { window, pageLoaded } = preparedBreak;
  setTimeout(() => {
    if (breakVisible || window !== preparedBreak.window) return;
    desktopStream.restart();
    abandonBreak();
  }, BREAK_START_TIMEOUT_MS);
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  window.setBounds(display.bounds);
  await pageLoaded;
  watchBreak();
  // Every process is listed because Chromium plays our sound from a separate audio process.
  // Why: at volume 0 other apps are left alone too, so it also turns off the distant effect and the tap behind it.
  desktopStream.begin(display.id, app.getAppMetrics().map((metric) => metric.pid), { sound: settings.volume > 0, live: settings.backgroundFill === 0 });

  ipcMain.once('request-desktop-still', () => desktopStream.requestStill());
  ipcMain.on('audio-distance', (_event, distance) => desktopStream.setAudioDistance(distance));
  ipcMain.once('show-window', () => {
    window.setOpacity(0);
    window.show();
    window.focus();
    lastPageHeartbeat = Date.now();
    breakVisible = true;
    fadeWindow(window, 0, BREAK_OPACITY, FADE_IN_MS);
    // Why: if keyboard focus ends up elsewhere, a global shortcut still lets Escape end the break.
    globalShortcut.register('Escape', leaveBreak);
  });
  ipcMain.once('finish', async () => {
    ipcMain.removeAllListeners('audio-distance');
    desktopStream.end();
    await fadeWindow(window, BREAK_OPACITY, 0, FADE_OUT_MS);
    if (!window.isDestroyed()) window.destroy();
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

async function checkForUpdates() {
  if (!settings.checkForUpdates || updateOfferOpen) return;
  const version = await findNewerVersion(app.getVersion());
  if (!version || version === settings.skippedVersion) return;
  // Why: a dialog would open underneath the break, and taking focus would stop keys from ending it.
  if (breakRunning) {
    setTimeout(checkForUpdates, UPDATE_RETRY_MS);
    return;
  }
  updateOfferOpen = true;
  app.focus({ steal: true });
  await offerUpdate(version, app.getVersion(), {
    onSkip: () => changeSetting('skippedVersion', version),
    onNever: () => changeSetting('checkForUpdates', false),
  });
  updateOfferOpen = false;
}

function showInfo() {
  app.focus({ steal: true });
  dialog.showMessageBox({
    message: 'Smoke Break',
    detail: 'Created by DreadJordan',
    icon: path.join(__dirname, 'assets', 'app-icon.png'),
    buttons: ['Close'],
  });
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
        { type: 'separator' },
        {
          label: 'Fill Background (Experimental)',
          submenu: BACKGROUND_FILLS.map(({ label, fill }) => ({
            label,
            type: 'radio',
            checked: settings.backgroundFill === fill,
            click: () => changeSetting('backgroundFill', fill),
          })),
        },
        { label: 'Ambient Noise', type: 'checkbox', checked: settings.ambientNoise, click: () => changeSetting('ambientNoise', !settings.ambientNoise) },
        {
          label: 'Volume',
          submenu: VOLUMES.map((volume) => ({
            label: `${volume}%`,
            type: 'radio',
            checked: settings.volume === volume,
            click: () => changeSetting('volume', volume),
          })),
        },
        { type: 'separator' },
        {
          label: 'Check for Updates',
          type: 'checkbox',
          checked: settings.checkForUpdates,
          click: () => changeSetting('checkForUpdates', !settings.checkForUpdates),
        },
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
    // Why: the default menu's shortcuts, such as Command+Q, would act on keys meant to end a break.
    Menu.setApplicationMenu(null);
    settings = readSettings();
    createTray();
    screenPermissionGranted = systemPreferences.getMediaAccessStatus('screen') === 'granted';
    prepareBreak();
    scheduleAutomaticBreak();
    setTimeout(checkForUpdates, UPDATE_CHECK_DELAY_MS);
    setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL_MS);
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
