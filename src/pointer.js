// Brings the cursor back while the mouse moves during a break, and hides it again almost as soon as the mouse stops.
// It stays hidden through the dashes, so the release of the menu bar press can't flash it up.
'use strict';

const POINTER_IDLE_MS = 300;

let pointerAvailable = false;
let pointerIdleTimer = 0;
let lastPointerX = 0;
let lastPointerY = 0;

function hidePointer() {
  document.body.classList.remove('pointer-active');
}

// Why: Chromium sends a mousemove with no movement after layout changes, and hiding the cursor is one, so it would never stay hidden.
function showPointer({ clientX, clientY }) {
  if (clientX === lastPointerX && clientY === lastPointerY) return;
  lastPointerX = clientX;
  lastPointerY = clientY;
  if (!pointerAvailable) return;
  document.body.classList.add('pointer-active');
  clearTimeout(pointerIdleTimer);
  pointerIdleTimer = setTimeout(hidePointer, POINTER_IDLE_MS);
}

function enablePointer() {
  pointerAvailable = true;
}

function disablePointer() {
  pointerAvailable = false;
  clearTimeout(pointerIdleTimer);
  hidePointer();
}

window.addEventListener('mousemove', showPointer);
