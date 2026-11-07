// The Set Hotkey window's behaviour: turns the keys pressed into a hotkey, insists on a real combo, and offers it to the main process.
// Keys are read by physical position because a held Option changes the character typed: Option+S types ß.
'use strict';

const NAMED_KEYS = {
  Space: 'Space', Enter: 'Return', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Escape: 'Esc',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
};
const combo = document.getElementById('combo');
const message = document.getElementById('message');
const useDefault = document.getElementById('use-default');
const { hotkey, defaultValue, platform } = window.hotkeyWindow.current();
const isMac = platform === 'darwin';
const MODIFIER_NAMES = isMac ? 'Control, Option or Command' : 'Ctrl, Alt or Win';
const GUIDANCE = `Press a key with ${MODIFIER_NAMES}. Esc cancels.`;

function keyName(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F[0-9]{1,2}$/.test(code)) return code;
  return NAMED_KEYS[code] ?? null;
}

function heldModifiers(event) {
  return [event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && (isMac ? 'Command' : 'Super')].filter(Boolean);
}

function show(accelerator, text = GUIDANCE, warning = false) {
  combo.textContent = formatHotkey(accelerator, platform);
  message.textContent = text;
  message.classList.toggle('warning', warning);
}

async function offer(accelerator) {
  const accepted = await window.hotkeyWindow.choose(accelerator);
  if (!accepted) show(accelerator, 'That combo is already in use. Try another.', true);
}

window.addEventListener('keydown', (event) => {
  event.preventDefault();
  if (event.repeat) return;
  const modifiers = heldModifiers(event);
  if (event.code === 'Escape' && modifiers.length === 0) {
    window.hotkeyWindow.cancel();
    return;
  }
  const key = keyName(event.code);
  if (!key) {
    // Only modifiers so far, so show them building up.
    if (modifiers.length > 0) show(modifiers.join('+'));
    return;
  }
  const accelerator = [...modifiers, key].join('+');
  // Why: Shift alone still types ordinary characters, so a hotkey on it would fire during normal typing.
  if (!modifiers.some((modifier) => modifier !== 'Shift')) {
    show(accelerator, `It must be a combo: add ${MODIFIER_NAMES}.`, true);
    return;
  }
  offer(accelerator);
});

// Letting go before finishing a combo goes back to the current hotkey.
window.addEventListener('keyup', (event) => {
  if (heldModifiers(event).length === 0 && !message.classList.contains('warning')) show(hotkey);
});

useDefault.addEventListener('click', () => offer(defaultValue));
useDefault.hidden = hotkey === defaultValue;
show(hotkey);
