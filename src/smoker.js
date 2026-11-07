// Smoke Break's first-person smoking overlay: draws the live-action cigarette footage (footage.js), its ember and the smoke above the desktop scene.
// smokeCigarette() plays the hand bringing a cigarette to the mouth, smokes it down to the filter, then the hand takes it away; stopSmoking() ends it early.
'use strict';

const canvas = document.getElementById('overlay');
const context = canvas.getContext('2d');

// The overlay draws in a virtual space 1080 units tall; width follows the window's aspect ratio.
const VIRTUAL_HEIGHT = 1080;
let viewWidth = 1920;
let pixelScale = 1;

// The footage is framed on a 640x360 stage that covers the window like the video but stays pinned to its bottom edge.
const STAGE_WIDTH = 640;
const STAGE_HEIGHT = 360;

const ROOM_SHADE_DARK = 0.58;
// Why: in the daylight of the background, the dark room's shade would turn the hand into a silhouette pasted over a bright scene.
const ROOM_SHADE_DAYLIGHT = 0.12;
const DRAG_BURN_MULTIPLIER = 2.5;
// Why: drags take about 1.4s of every 10s and burn faster, so the average rate runs above the base rate by this much; the base rate
// is set from it so the cigarette lasts the chosen break length.
const DRAG_BURN_AVERAGE = 1 + (DRAG_BURN_MULTIPLIER - 1) * 0.14;
const DRAG_RISE_MS = 450;
const DRAG_HOLD_MS = 900;

// seat is 1 until a hand still bringing the cigarette up is put away, when it eases to 0; ashFormed grows the ash as it lights.
const seat = { value: 0 };
const ashFormed = { value: 0 };
const ember = { glow: 0 };
let burnPerSecond = 1 / (DRAG_BURN_AVERAGE * 30);
let lit = false;
// How far the cigarette has burned toward the filter (0 fresh, 1 at the filter); once spent it has gone out.
let burn = 0;
let spent = false;
let dragging = false;
let phase = 'hidden';
let entry = null;
let lighterStruck = false;


function stage() {
  const scale = Math.max(viewWidth / STAGE_WIDTH, VIRTUAL_HEIGHT / STAGE_HEIGHT);
  return { x: (viewWidth - STAGE_WIDTH * scale) / 2, y: VIRTUAL_HEIGHT - STAGE_HEIGHT * scale, scale };
}

function stageToWorld([x, y]) {
  const view = stage();
  return { x: view.x + x * view.scale, y: view.y + y * view.scale, scale: view.scale };
}

function drawFootage() {
  const view = stage();
  context.save();
  context.translate(view.x, view.y);
  context.scale(view.scale, view.scale);
  if (phase === 'entering') drawEntryFootage();
  else if (phase === 'leaving') drawTakedownFootage();
  else if (phase !== 'hidden') drawMouthFootage();
  drawFallingAsh();
  context.restore();
}

function drawEmberGlow(time) {
  if (seat.value <= 0 || !lit || spent) return;
  // A faint breathing glow keeps the tip alive between drags; ember.glow adds the flare of an inhale on top.
  const intensity = seat.value * (0.2 + Math.sin(time * 0.0021) * 0.05 + ember.glow * 0.8);
  const tip = stageToWorld(emberStagePoint());
  const radius = (14 + ember.glow * 16) * tip.scale;
  context.save();
  context.globalCompositeOperation = 'lighter';
  const gradient = context.createRadialGradient(tip.x, tip.y, 0, tip.x, tip.y, radius);
  gradient.addColorStop(0, `rgba(255, 150, 70, ${0.55 * intensity})`);
  gradient.addColorStop(0.25, `rgba(255, 80, 30, ${0.22 * intensity})`);
  gradient.addColorStop(1, 'rgba(255, 60, 20, 0)');
  context.fillStyle = gradient;
  context.fillRect(tip.x - radius, tip.y - radius, radius * 2, radius * 2);
  context.restore();
}

// ---------------------------------------------------------------------------
// Tweens and the frame loop. The loop only runs while something is on screen, so a hidden overlay costs nothing.

const tweens = new Map();
let frameRunning = false;
let lastFrameTime = 0;

const easeOut = (progress) => 1 - (1 - progress) ** 3;
const easeIn = (progress) => progress ** 3;
const easeInOut = (progress) => (progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2);

function animate(target, destination, durationMs, easing = easeInOut) {
  const previous = tweens.get(target);
  if (previous) previous.resolve();
  return new Promise((resolve) => {
    const origin = {};
    for (const key in destination) origin[key] = target[key];
    tweens.set(target, { origin, destination, startTime: performance.now(), durationMs, easing, resolve });
    startFrameLoop();
  });
}

function wait(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function randomBetween(minimum, maximum) {
  return minimum + Math.random() * (maximum - minimum);
}

function startFrameLoop() {
  if (frameRunning) return;
  frameRunning = true;
  lastFrameTime = performance.now();
  requestAnimationFrame(frame);
}

function needsAnimation() {
  return phase !== 'hidden' || tweens.size > 0 || smokeVisible() || ashFalling();
}

function frame(time) {
  const deltaSeconds = Math.min((time - lastFrameTime) / 1000, 0.05);
  lastFrameTime = time;
  update(time, deltaSeconds);
  render(time);
  if (needsAnimation()) {
    requestAnimationFrame(frame);
  } else {
    frameRunning = false;
  }
}

function update(time, deltaSeconds) {
  if (phase === 'entering' && seat.value === 1 && !lighterStruck && entryClip.currentTime >= LIGHTER_CUE_SECONDS) {
    lighterStruck = true;
    playLighter();
  }

  for (const [target, tween] of tweens) {
    const progress = Math.min(1, (time - tween.startTime) / tween.durationMs);
    const eased = tween.easing(progress);
    for (const key in tween.destination) {
      target[key] = tween.origin[key] + (tween.destination[key] - tween.origin[key]) * eased;
    }
    if (progress >= 1) {
      tweens.delete(target);
      tween.resolve();
    }
  }

  if (lit && !spent && phase === 'smoking') {
    burn = Math.min(1, burn + deltaSeconds * burnPerSecond * (dragging ? DRAG_BURN_MULTIPLIER : 1));
    if (burn >= 1) {
      // Burnt down to the filter: it goes out and the break ends there, even mid-drag.
      spent = true;
      dragging = false;
      stopSmoking();
    }
  }

  updateAsh(deltaSeconds);
  updateSmoke(deltaSeconds, lit && !spent && !dragging && phase === 'smoking' ? smokeSourceStagePoints(SMOKE_SOURCE_POSITIONS).map(stageToWorld) : null);
}

function render(time) {
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.setTransform(pixelScale, 0, 0, pixelScale, 0, 0);
  drawFootage();
  // The smoke is between the viewer and the cigarette, drifting back from its tip.
  drawSmoke(context, pixelScale);
  // Why: the room is lit only by the distant screen, so everything in it is shaded down to match; daylight-bright
  // hands and smoke against the dark room read as pasted on. Only the ember, drawn after, keeps its own light.
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalCompositeOperation = 'source-atop';
  context.fillStyle = `rgba(9, 11, 19, ${ROOM_SHADE_DARK + (ROOM_SHADE_DAYLIGHT - ROOM_SHADE_DARK) * backgroundBlend})`;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.restore();
  const view = stage();
  context.save();
  context.translate(view.x, view.y);
  context.scale(view.scale, view.scale);
  drawBurnRing(view, time);
  context.restore();
  drawEmberGlow(time);
}

function resize() {
  const devicePixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(window.innerWidth * devicePixelRatio);
  canvas.height = Math.round(window.innerHeight * devicePixelRatio);
  pixelScale = canvas.height / VIRTUAL_HEIGHT;
  viewWidth = canvas.width / pixelScale;
  render(performance.now());
}

// ---------------------------------------------------------------------------
// The smoking ritual. stopSmoking() interrupts whatever the ritual is waiting on, and the cigarette is put away.

const CANCELLED = Symbol('cancelled');
let interruptRitual = null;

// Plays the hand bringing the cigarette up; if it is put away first, the unfinished entry never hands over to the loop.
function playEntry() {
  phase = 'entering';
  seat.value = 1;
  startFrameLoop();
  const thisEntry = (async () => {
    await playEntryClip();
    if (entry !== thisEntry) return;
    phase = 'smoking';
    entry = null;
  })();
  entry = thisEntry;
  return thisEntry;
}

async function smokingRitual() {
  const interrupted = new Promise((resolve) => {
    interruptRitual = resolve;
  });
  const step = async (promise) => {
    if ((await Promise.race([promise, interrupted])) === CANCELLED) throw CANCELLED;
  };

  const takeDrag = async (strength) => {
    dragging = true;
    playInhale(strength, (DRAG_RISE_MS + DRAG_HOLD_MS) / 1000);
    await step(animate(ember, { glow: strength }, DRAG_RISE_MS, easeOut));
    await step(wait(DRAG_HOLD_MS));
    dragging = false;
    animate(ember, { glow: 0 }, 1400);
  };

  await step(playEntry());
  // The first drag is what lights it: the tip chars into ash as the ember catches.
  lit = true;
  animate(ashFormed, { value: 1 }, 900, easeOut);
  await takeDrag(1);
  while (true) {
    await step(wait(randomBetween(7000, 11000)));
    await takeDrag(randomBetween(0.6, 0.9));
  }
}

// Puts the cigarette away at once: the hand mid-entry drops out of frame, and a cigarette in the mouth is taken away at its current burn.
async function putAwayCigarette() {
  dragging = false;
  stopInhale();
  const inMouth = phase === 'smoking';
  entry = null;
  animate(ember, { glow: 0 }, 300);
  if (inMouth) await playTakedownClip();
  else await animate(seat, { value: 0 }, 550, easeIn);
  stopClips();
  phase = 'hidden';
  lit = false;
  ashFormed.value = 0;
  burn = 0;
  resetAsh();
  spent = false;
}

// Resolves the moment the cigarette burns out or is stopped, so the dash back starts while it is still being taken away.
async function smokeCigarette() {
  try {
    await smokingRitual();
  } catch (error) {
    if (error !== CANCELLED) throw error;
  }
  putAwayCigarette();
}

function setBreakLength(seconds) {
  burnPerSecond = 1 / (DRAG_BURN_AVERAGE * seconds);
}

function stopSmoking() {
  interruptRitual?.(CANCELLED);
}

window.addEventListener('resize', resize);
resize();
