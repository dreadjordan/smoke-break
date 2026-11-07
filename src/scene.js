// Smoke Break's desktop scene and break sequence: shows the captured desktop, dashes the viewer back from it in perspective,
// runs one cigarette via smoker.js, then dashes back up to the screen and asks the main process to close the app.
'use strict';

const desktopCanvas = document.getElementById('desktop');
const desktopContext = desktopCanvas.getContext('2d');

// Why: about 2.5ft is a normal distance from a screen; at 15ft it covers 1/6 as much of the view. Apparent size is
// computed from these distances, so the dash shrinks the desktop the way real perspective does.
const SCREEN_DISTANCE_FEET = 2.5;
const BREAK_DISTANCE_FEET = 15;
// Why: the break opens and closes with an anime-style dash (a burst that settles, with speed lines) rather than a walk,
// so the viewer is in place, or back at the desk, almost at once.
const DASH_MS = 800;
const PAGE_HEARTBEAT_MS = 500;
const SPEED_LINE_COUNT = 110;
// The desktop recedes toward eye level, a little above centre, leaving the lower view to the hand and cigarette.
const EYE_LEVEL = { x: 0.5, y: 0.42 };
const ROOM = '#08090d';
// With the background on there is no screen across the room. It cuts away beyond this distance, with no fade, so a dash still starts and ends on the real desktop.
const SCREEN_GONE_FEET = 5;

let viewerFeet = SCREEN_DISTANCE_FEET;
let breakEnding = false;
let returning = false;
let dashId = 0;
let dashing = false;
let sceneDrawPending = false;
// How strongly the dash's speed lines show (0 none, 1 full).
let speedLines = 0;

function screenVisible() {
  return !backgroundEnabled || viewerFeet < SCREEN_GONE_FEET;
}

// Draws on the next frame for a new live frame or a blend; a running dash already draws every frame.
function requestSceneDraw() {
  if (dashing || sceneDrawPending) return;
  sceneDrawPending = true;
  requestAnimationFrame(() => {
    sceneDrawPending = false;
    drawScene();
  });
}

function drawScene() {
  if (advanceDesktopLayers(viewerFeet)) requestSceneDraw();
  if (advanceBackground()) requestSceneDraw();
  const width = desktopCanvas.width;
  const height = desktopCanvas.height;
  const scale = SCREEN_DISTANCE_FEET / viewerFeet;
  const screenWidth = width * scale;
  const screenHeight = height * scale;
  const left = width * EYE_LEVEL.x * (1 - scale);
  const top = height * EYE_LEVEL.y * (1 - scale);
  const context = desktopContext;
  const showScreen = screenVisible();

  if (scale < 1) {
    const ambientColor = desktopAmbient.map(Math.round).join(', ');
    const reflected = topDesktopLayer();
    // The screen's glow and floor reflection belong to the dark room, and go at once with the background on.
    const roomLight = backgroundEnabled ? 0 : 1;
    context.fillStyle = ROOM;
    context.fillRect(0, 0, width, height);
    if (backgroundBlend > 0) drawBackground(context, width, height);
    // The screen is the only light in the room: a soft spill of its colour around it.
    const centerX = left + screenWidth / 2;
    const centerY = top + screenHeight / 2;
    const spillRadius = Math.max(screenWidth, screenHeight) * 2.2;
    const spill = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, spillRadius);
    spill.addColorStop(0, `rgba(${ambientColor}, ${0.22 * roomLight})`);
    spill.addColorStop(1, `rgba(${ambientColor}, 0)`);
    context.fillStyle = spill;
    context.fillRect(centerX - spillRadius, centerY - spillRadius, spillRadius * 2, spillRadius * 2);
    // A faint reflection on the floor grounds the screen in the space.
    // Drawn as mirrored slices that fade with depth, so the spill behind it stays intact.
    const gap = screenHeight * 0.04;
    const sliceCount = 12;
    const sliceHeight = (screenHeight * 0.6) / sliceCount;
    const sourceSliceHeight = (reflected.height * sliceHeight) / screenHeight;
    for (let slice = 0; roomLight > 0 && slice < sliceCount; slice++) {
      context.save();
      context.globalAlpha = 0.12 * roomLight * (1 - (slice + 0.5) / sliceCount) ** 1.5;
      context.translate(left, top + screenHeight + gap + (slice + 1) * sliceHeight);
      context.scale(1, -1);
      context.drawImage(reflected.frame, 0, reflected.height - (slice + 1) * sourceSliceHeight, reflected.width, sourceSliceHeight,
        0, 0, screenWidth, sliceHeight);
      context.restore();
    }
    // A thin bezel, which only shows once the screen no longer fills the view.
    context.fillStyle = '#020203';
    const bezel = Math.max(1, screenWidth * 0.006);
    if (showScreen) context.fillRect(left - bezel, top - bezel, screenWidth + bezel * 2, screenHeight + bezel * 2);
  }
  if (showScreen) drawDesktopLayers(context, left, top, screenWidth, screenHeight);
  if (speedLines > 0) drawSpeedLines(speedLines);
}

// Anime speed lines: thin white wedges reaching in from beyond the screen edges toward eye level. They are re-drawn at
// random every frame, so they flicker the way hand-drawn ones do, and reach less far in as the dash settles.
function drawSpeedLines(intensity) {
  const width = desktopCanvas.width;
  const height = desktopCanvas.height;
  const centreX = width * EYE_LEVEL.x;
  const centreY = height * EYE_LEVEL.y;
  const reach = Math.hypot(Math.max(centreX, width - centreX), Math.max(centreY, height - centreY));
  const context = desktopContext;
  context.save();
  context.fillStyle = '#ffffff';
  for (let line = 0; line < SPEED_LINE_COUNT; line++) {
    const angle = Math.random() * Math.PI * 2;
    const inner = reach * (1 - (0.3 + Math.random() * 0.35) * intensity);
    const outer = reach * 1.05;
    const halfWidth = height * (0.001 + Math.random() * 0.004);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    context.globalAlpha = (0.45 + Math.random() * 0.55) * intensity;
    context.beginPath();
    context.moveTo(centreX + cos * inner, centreY + sin * inner);
    context.lineTo(centreX + cos * outer - sin * halfWidth, centreY + sin * outer + cos * halfWidth);
    context.lineTo(centreX + cos * outer + sin * halfWidth, centreY + sin * outer - cos * halfWidth);
    context.closePath();
    context.fill();
  }
  context.restore();
}

// Dashes the viewer back to a distance: a burst that decelerates hard, with speed lines that flash in and fade as it settles.
function dashTo(destinationFeet, durationMs) {
  const id = ++dashId;
  const originFeet = viewerFeet;
  const startTime = performance.now();
  dashing = true;
  return new Promise((resolve) => {
    const step = (time) => {
      if (id !== dashId) {
        speedLines = 0;
        resolve();
        return;
      }
      const progress = Math.min(1, (time - startTime) / durationMs);
      const eased = 1 - (1 - progress) ** 4;
      viewerFeet = originFeet + (destinationFeet - originFeet) * eased;
      window.smokeBreak.setAudioDistance((viewerFeet - SCREEN_DISTANCE_FEET) / (BREAK_DISTANCE_FEET - SCREEN_DISTANCE_FEET));
      speedLines = Math.min(1, progress / 0.06) * (1 - progress) ** 1.3;
      drawScene();
      if (progress < 1) {
        requestAnimationFrame(step);
      } else {
        dashing = false;
        requestSceneDraw();
        resolve();
      }
    };
    requestAnimationFrame(step);
  });
}

function resizeScene() {
  const devicePixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  desktopCanvas.width = Math.round(window.innerWidth * devicePixelRatio);
  desktopCanvas.height = Math.round(window.innerHeight * devicePixelRatio);
  if (snapshotLayer.frame) drawScene();
}

// Dashes back up to the screen from wherever the viewer is, then closes the app. Safe to call more than once.
async function returnToDesktop() {
  if (returning) return;
  returning = true;
  disablePointer();
  window.smokeBreak.requestDesktopStill();
  const remaining = (viewerFeet - SCREEN_DISTANCE_FEET) / (BREAK_DISTANCE_FEET - SCREEN_DISTANCE_FEET);
  const durationMs = DASH_MS * Math.max(0.4, remaining);
  fadeOutSmoke(durationMs * 0.8);
  fadeOutAmbience(durationMs);
  playDashIn(durationMs);
  await dashTo(SCREEN_DISTANCE_FEET, durationMs);
  window.smokeBreak.finish();
}

// Any key ends the break at once: the cigarette drops as the viewer dashes back to the screen.
function endBreakEarly() {
  if (breakEnding) return;
  breakEnding = true;
  stopSmoking();
  returnToDesktop();
}

function applySettings({ breakSeconds, backgroundFill, ambientNoise, volume }) {
  setBreakLength(breakSeconds);
  setBackground(backgroundFill);
  setAmbienceEnabled(ambientNoise);
  setSoundVolume(volume);
}

async function runBreak() {
  // Why: the main process closes a break that stops hearing this, because a frozen page can't end its own break.
  setInterval(window.smokeBreak.pageAlive, PAGE_HEARTBEAT_MS);
  resumeAudio();
  await desktopSnapshotReady;
  startBackground();
  resizeScene();
  // Show the window only once its first frame matches the real desktop exactly, so the takeover is invisible.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  window.smokeBreak.showWindow();
  startAmbience();

  // The hand brings the cigarette up mid-flight, while the dash back is still under way.
  playDashOut();
  dashTo(BREAK_DISTANCE_FEET, DASH_MS).then(() => {
    if (!returning) enablePointer();
  });
  await smokeCigarette();
  breakEnding = true;
  returnToDesktop();
}

window.addEventListener('resize', resizeScene);
// Why: a key already held as an automatic break starts repeats into this window, and must not end it straight away.
window.addEventListener('keydown', (event) => {
  if (!event.repeat) endBreakEarly();
});
window.smokeBreak.onEscape(endBreakEarly);
window.smokeBreak.onBeginBreak(() => runBreak().catch(window.smokeBreak.finish));
// Why: an error in the drawing loop stops the dash too, and the break could never end by itself. Rejected play() calls are routine, so they don't count.
window.addEventListener('error', window.smokeBreak.finish);
applySettings(window.smokeBreak.settings());
window.smokeBreak.onSettingsChanged(applySettings);
