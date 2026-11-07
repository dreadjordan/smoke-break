// The optional background: a looping video, chosen in Settings, that fills the view in place of the dark room and distant screen.
// Two copies of the clip crossfade at the loop point, because the camera moves and the end doesn't match the start.
'use strict';

// The fills that are dark scenes, for smoker.js to shade the hand to match.
const NIGHT_FILLS = [2];
const BACKGROUND_BLEND_MS = 500;
const BACKGROUND_SEAM_SECONDS = 1;
const MAX_BACKGROUND_STEP_MS = 50;

const backgroundClips = [document.createElement('video'), document.createElement('video')];
let backgroundEnabled = false;
let backgroundRunning = false;
let backgroundSource = null;
let backgroundIsNight = false;
// How much the background shows (0 the dark room, 1 the full video); smoker.js lifts the room shade by this too.
let backgroundBlend = 0;
let frontClip = 0;
let seamBlend = 0;
let lastBackgroundTime = 0;

for (const clip of backgroundClips) {
  clip.muted = true;
  clip.preload = 'auto';
  redrawOnBackgroundFrames(clip);
}

// Why: only the chosen clip is loaded, and nothing while the setting is off, so a hidden page waiting for a break doesn't hold a large video in memory.
// Loaded as soon as it is chosen, so it is ready before the next break begins.
function loadBackgroundClips(fill) {
  const source = `assets/background_fill_${fill}.mp4`;
  if (source === backgroundSource) return;
  backgroundSource = source;
  for (const clip of backgroundClips) clip.src = source;
}

function redrawOnBackgroundFrames(clip) {
  clip.requestVideoFrameCallback(() => {
    if (backgroundRunning) requestSceneDraw();
    redrawOnBackgroundFrames(clip);
  });
}

// Called as a break begins, so an enabled background is already there on the first frame if it has loaded.
function startBackground() {
  if (!backgroundEnabled) return;
  backgroundRunning = true;
  backgroundClips[frontClip].play();
  if (backgroundClips[frontClip].readyState >= 2) backgroundBlend = 1;
}

// Fill 0 is no background.
function setBackground(fill) {
  backgroundEnabled = fill > 0;
  backgroundIsNight = NIGHT_FILLS.includes(fill);
  if (backgroundEnabled) loadBackgroundClips(fill);
}

function advanceBackgroundSeam() {
  const front = backgroundClips[frontClip];
  const back = backgroundClips[1 - frontClip];
  const remaining = front.duration - front.currentTime;
  if (remaining > BACKGROUND_SEAM_SECONDS) return;
  if (back.paused) {
    back.currentTime = 0;
    back.play();
  }
  seamBlend = 1 - remaining / BACKGROUND_SEAM_SECONDS;
  if (front.ended || remaining <= 0) {
    front.pause();
    frontClip = 1 - frontClip;
    seamBlend = 0;
  }
}

// Moves the blend along; reports whether it is still changing, so the scene knows to draw again.
function advanceBackground() {
  const now = performance.now();
  const elapsedMs = Math.min(now - lastBackgroundTime, MAX_BACKGROUND_STEP_MS);
  lastBackgroundTime = now;
  if (!backgroundRunning) return false;
  advanceBackgroundSeam();
  if (backgroundBlend >= 1 || backgroundClips[frontClip].readyState < 2) return false;
  backgroundBlend = Math.min(1, backgroundBlend + elapsedMs / BACKGROUND_BLEND_MS);
  return true;
}

function drawBackgroundClip(context, clip, canvasWidth, canvasHeight) {
  const scale = Math.max(canvasWidth / clip.videoWidth, canvasHeight / clip.videoHeight);
  const width = clip.videoWidth * scale;
  const height = clip.videoHeight * scale;
  context.drawImage(clip, (canvasWidth - width) / 2, (canvasHeight - height) / 2, width, height);
}

function drawBackground(context, canvasWidth, canvasHeight) {
  context.save();
  context.globalAlpha = backgroundBlend;
  drawBackgroundClip(context, backgroundClips[frontClip], canvasWidth, canvasHeight);
  if (seamBlend > 0) {
    context.globalAlpha = backgroundBlend * seamBlend;
    drawBackgroundClip(context, backgroundClips[1 - frontClip], canvasWidth, canvasHeight);
  }
  context.restore();
}
