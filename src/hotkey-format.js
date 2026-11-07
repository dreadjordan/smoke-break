// Shared between the main process and the Set Hotkey window: the default hotkey and how a hotkey is shown to people.
// Hotkeys are stored as Electron accelerators such as Control+Alt+Command+S.
'use strict';

const MAC_HOTKEY_NAMES = {
  Control: '⌃', Alt: '⌥', Shift: '⇧', Command: '⌘',
  Up: '↑', Down: '↓', Left: '←', Right: '→', Return: '↩', Backspace: '⌫', Delete: '⌦', Tab: '⇥', Esc: '⎋',
};
const OTHER_HOTKEY_NAMES = { Control: 'Ctrl', Super: 'Win' };

function defaultHotkey(platform) {
  return platform === 'darwin' ? 'Control+Alt+Command+S' : 'Control+Alt+Super+S';
}

function formatHotkey(accelerator, platform) {
  const parts = accelerator.split('+');
  if (platform === 'darwin') return parts.map((part) => MAC_HOTKEY_NAMES[part] ?? part).join('');
  return parts.map((part) => OTHER_HOTKEY_NAMES[part] ?? part).join('+');
}

if (typeof module !== 'undefined') module.exports = { defaultHotkey, formatHotkey };
