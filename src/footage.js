// Smoke Break's live-action cigarette: plays the keyed green-screen clips (the hand bringing it up, then it sitting in the mouth; takedown.js plays it leaving).
// The in-mouth cigarette burns by cutting the footage back along its tracked axis; ash grows behind the burn line, and ash-fall.js breaks it off when long.
'use strict';

// The footage is 1920x1080, three times the 640x360 stage, and shares its bottom-pinned framing.
const SOURCE_PER_STAGE = 3;
// Why: the click belongs as the hand leaves and the cigarette starts rising to the lips; cueing it once the cigarette had settled sounded late.
const LIGHTER_CUE_SECONDS = 1;
// Why: filmed at arm's length the hand fills too much of the view; shrinking it reads as the hand held lower and further out.
const HAND_SCALE = 0.6;
// The cigarette in the mouth is shown smaller than filmed, scaled about where it meets the lips at the bottom edge.
const MOUTH_SCALE = 0.7;
// Why: shrunk, the filmed frame's top edge sits mid-screen and cuts off a cigarette held above it in a straight line;
// fading the footage out over its top rows reads as the cigarette passing out of the light instead of a video edge.
const ENTRY_TOP_FADE = 110;
const MOUTH_PIVOT = (() => {
  const [left, top, , bottom] = FOOTAGE_TRACK.loopCrop;
  const cropHeight = bottom - top;
  const meanBaseX = FOOTAGE_TRACK.loop.reduce((sum, [, intercept, slope]) => sum + intercept + slope * cropHeight, 0) / FOOTAGE_TRACK.loop.length;
  return [(left + meanBaseX) / SOURCE_PER_STAGE, bottom / SOURCE_PER_STAGE];
})();
// Cigarette geometry in source pixels. The ring depth is how far a ring around the cigarette bows toward the viewer,
// as a fraction of its half width, because the camera looks slightly down onto it.
const RING_DEPTH = 0.22;
// The tip chars this far when it is lit; after that the ash grows by however far the burn line has moved.
const ASH_CHAR = 18;
// How much of the cigarette is left above the lips when it reaches the filter.
const BUTT_LENGTH = 70;
// Why: the ash breaks off early and often, after about a quarter of a cigarette width, before a grey column can build up;
// varying it keeps drops from landing on a visible schedule. A short stub stays on the ember after each drop.
const ASH_HOLD_WIDTHS = [0.2, 0.325];
const ASH_STUB = [8, 16];
const BURN_TRAVEL = (() => {
  const cropHeight = FOOTAGE_TRACK.loopCrop[3] - FOOTAGE_TRACK.loopCrop[1];
  const meanTop = FOOTAGE_TRACK.loop.reduce((sum, [top]) => sum + top, 0) / FOOTAGE_TRACK.loop.length;
  return cropHeight - meanTop - ASH_CHAR - BUTT_LENGTH;
})();
// How far (in source pixels) the hand sinks out of frame when put away mid-entry.
const ENTRY_LOWER_DROP = 1300;
// The burn line wanders around the cigarette rather than cutting it square (source pixels along the axis).
const BURN_EDGE = [1.5, -1, 2.5, 0.8, -1.8, 1, 3.6, 2, -0.5, 1.5, 3.2, 0.3, 2];
// How brightly each stretch of the burn line glows, so the seam smoulders unevenly instead of reading as a drawn stroke.
const BURN_GLOW = [0.9, 0.5, 1, 0.35, 0.8, 1, 0.6, 0.25, 0.9, 0.7, 1, 0.45];
const ASH_CROWN_EDGE = [0, 1.5, 0.5, 2.5, 3, 1.2, 2.8, 1, 2.2, 0.6, 1.8, 0.4, 0];
const ASH_COLOURS = { light: '#c9c4bd', base: '#9d9893', shadow: '#5f5b57', face: '#b3aea8' };
const CHAR = '40, 28, 20';
const BURN_BAND_WIDTHS = 1.6;
const BURN_BAND_HEIGHT = 2000;

const entryClip = createClip('assets/entry.webm', false);
const loopClip = createClip('assets/loop.webm', true);
const cutCanvas = document.createElement('canvas');
const cutContext = cutCanvas.getContext('2d');
const entryCanvas = document.createElement('canvas');
const entryContext = entryCanvas.getContext('2d');
const ashTexture = createAshTexture();
let loopFrame = 0;
let ashLength = ASH_CHAR;
let ashLimit = nextAshLimit();
let burnTravelled = 0;
// The end of the ash column; each break leaves its own torn edge here.
let ashCrownEdge = ASH_CROWN_EDGE;

function nextAshLimit() {
  const halfWidth = FOOTAGE_TRACK.loop[0][3];
  return 2 * halfWidth * (ASH_HOLD_WIDTHS[0] + Math.random() * (ASH_HOLD_WIDTHS[1] - ASH_HOLD_WIDTHS[0]));
}

// Grows the ash by however far the burn line has moved, and moves any that has fallen.
function updateAsh(deltaSeconds) {
  const travelled = burn * BURN_TRAVEL;
  ashLength += travelled - burnTravelled;
  burnTravelled = travelled;
  updateFallingAsh(deltaSeconds);
}

function resetAsh() {
  ashLength = ASH_CHAR;
  burnTravelled = 0;
  ashLimit = nextAshLimit();
  ashCrownEdge = ASH_CROWN_EDGE;
}

function createClip(source, loop) {
  const video = document.createElement('video');
  video.src = source;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.loop = loop;
  return video;
}

function clipReady(video) {
  return video.readyState >= 2 ? Promise.resolve() : new Promise((resolve) => video.addEventListener('loadeddata', resolve, { once: true }));
}

// Keeps loopFrame on the frame actually being shown, so the burn cut follows the cigarette as the head moves.
function followLoopFrames() {
  loopClip.requestVideoFrameCallback((_now, metadata) => {
    loopFrame = Math.round(metadata.mediaTime * FOOTAGE_TRACK.fps) % FOOTAGE_TRACK.loop.length;
    followLoopFrames();
  });
}

// Plays the hand bringing the cigarette up; resolves on its last frame, with the loop (which starts on the next source frame) already running.
async function playEntryClip() {
  await Promise.all([clipReady(entryClip), clipReady(loopClip)]);
  entryClip.currentTime = FOOTAGE_TRACK.entryStart;
  loopClip.currentTime = 0;
  await entryClip.play();
  await new Promise((resolve) => entryClip.addEventListener('ended', resolve, { once: true }));
  loopFrame = 0;
  await loopClip.play();
}

function stopClips() {
  entryClip.pause();
  loopClip.pause();
  takedownClip.pause();
}

function createAshTexture() {
  const size = 96;
  const texture = document.createElement('canvas');
  texture.width = size;
  texture.height = size;
  const textureContext = texture.getContext('2d');
  const pixels = textureContext.createImageData(size, size);
  for (let index = 0; index < pixels.data.length; index += 4) {
    const shade = 90 + Math.random() * 120;
    pixels.data[index] = shade;
    pixels.data[index + 1] = shade * 0.98;
    pixels.data[index + 2] = shade * 0.95;
    pixels.data[index + 3] = 255;
  }
  textureContext.putImageData(pixels, 0, 0);
  return texture;
}

// ---------------------------------------------------------------------------
// Geometry of the cigarette in the current loop frame (loop-crop source pixels).

function cigaretteFrame() {
  if (phase === 'leaving') return takedownGeometry();
  const [top, intercept, slope, halfWidth] = FOOTAGE_TRACK.loop[loopFrame];
  const ash = ashLength * ashFormed.value;
  const burnY = top + ASH_CHAR * ashFormed.value + burn * BURN_TRAVEL;
  return { centreAt: (y) => intercept + slope * y, halfWidth, burnY, crownY: burnY - ash, ash };
}

// Points across the front (visible) half of a ring at y, left to right; offsets nudge each point along the cigarette.
function ringPoints(geometry, y, offsets = null) {
  const count = offsets ? offsets.length : 13;
  return Array.from({ length: count }, (_, index) => {
    const across = -1 + (2 * index) / (count - 1);
    const ringY = y + (offsets ? offsets[index] : 0);
    return [geometry.centreAt(ringY) + across * geometry.halfWidth, ringY + RING_DEPTH * geometry.halfWidth * Math.sqrt(1 - across * across)];
  });
}

function pathThrough(target, points) {
  target.moveTo(points[0][0], points[0][1]);
  for (let index = 1; index < points.length - 1; index++) {
    const [x, y] = points[index];
    const [nextX, nextY] = points[index + 1];
    target.quadraticCurveTo(x, y, (x + nextX) / 2, (y + nextY) / 2);
  }
  const last = points[points.length - 1];
  target.lineTo(last[0], last[1]);
}

// ---------------------------------------------------------------------------
// Drawing. Both draw functions expect the context in stage pixels.

function drawEntryFootage() {
  const [left, top, right, bottom] = FOOTAGE_TRACK.entryCrop;
  // The hand plays smaller, shrunk toward the bottom-right corner so the frame edges it is cut by stay off screen; the
  // cigarette rising into the mouth uses the mouth framing so it lands exactly where the loop takes over.
  const handPhase = entryClip.currentTime < FOOTAGE_TRACK.entrySwitch;
  const [pivotX, pivotY] = handPhase ? [STAGE_WIDTH, STAGE_HEIGHT] : MOUTH_PIVOT;
  const scale = handPhase ? HAND_SCALE : MOUTH_SCALE;
  context.save();
  context.translate(pivotX, pivotY);
  context.scale(scale, scale);
  context.translate(-pivotX, -pivotY);
  const drop = (1 - seat.value) * ENTRY_LOWER_DROP;
  context.drawImage(fadedEntryFrame(), left / SOURCE_PER_STAGE, (top + drop) / SOURCE_PER_STAGE, (right - left) / SOURCE_PER_STAGE, (bottom - top) / SOURCE_PER_STAGE);
  context.restore();
}

// The current entry frame with its top rows (the filmed frame's top edge) faded out.
function fadedEntryFrame() {
  const [left, top, right, bottom] = FOOTAGE_TRACK.entryCrop;
  if (entryCanvas.width !== right - left || entryCanvas.height !== bottom - top) {
    entryCanvas.width = right - left;
    entryCanvas.height = bottom - top;
  }
  entryContext.globalCompositeOperation = 'copy';
  entryContext.drawImage(entryClip, 0, 0);
  entryContext.globalCompositeOperation = 'destination-in';
  const fadeEnd = ENTRY_TOP_FADE - top;
  const fade = entryContext.createLinearGradient(0, -top, 0, fadeEnd);
  for (let stop = 0; stop <= 8; stop++) {
    const progress = stop / 8;
    fade.addColorStop(progress, `rgba(0, 0, 0, ${progress * progress * (3 - 2 * progress)})`);
  }
  entryContext.fillStyle = fade;
  entryContext.fillRect(0, 0, entryCanvas.width, entryCanvas.height);
  return entryCanvas;
}

function drawMouthFootage() {
  const [left, top, right, bottom] = FOOTAGE_TRACK.loopCrop;
  const width = right - left;
  const height = bottom - top;
  if (cutCanvas.width !== width || cutCanvas.height !== height) {
    cutCanvas.width = width;
    cutCanvas.height = height;
  }
  cutContext.clearRect(0, 0, width, height);
  cutContext.drawImage(loopClip, 0, 0);
  if (lit || spent) {
    if (ashLength > ashLimit && seat.value >= 1) {
      burnCut(cutContext, cigaretteFrame());
      breakOffAsh(cigaretteFrame());
      cutContext.clearRect(0, 0, width, height);
      cutContext.drawImage(loopClip, 0, 0);
    }
    burnCut(cutContext, cigaretteFrame());
  }
  const [pivotX, pivotY] = MOUTH_PIVOT;
  context.save();
  context.translate(pivotX, pivotY);
  context.scale(MOUTH_SCALE, MOUTH_SCALE);
  context.translate(-pivotX, -pivotY);
  context.drawImage(cutCanvas, left / SOURCE_PER_STAGE, top / SOURCE_PER_STAGE, width / SOURCE_PER_STAGE, height / SOURCE_PER_STAGE);
  context.restore();
}

// Removes the paper above the burn line, scorches its edge and builds the ash column in its place.
function burnCut(target, geometry) {
  const front = ringPoints(geometry, geometry.burnY, BURN_EDGE);
  // Why: limited to a band around the cigarette, so the burn never erases or scorches the hand holding it in the take-down clip.
  const bandLeft = geometry.centreAt(geometry.burnY) - geometry.halfWidth * BURN_BAND_WIDTHS;
  const bandRight = geometry.centreAt(geometry.burnY) + geometry.halfWidth * BURN_BAND_WIDTHS;
  const bandTop = geometry.burnY - BURN_BAND_HEIGHT;

  target.save();
  target.globalCompositeOperation = 'destination-out';
  const above = new Path2D();
  above.moveTo(bandLeft, bandTop);
  above.lineTo(bandRight, bandTop);
  above.lineTo(bandRight, front[front.length - 1][1]);
  for (const [x, y] of front.slice().reverse()) above.lineTo(x, y);
  above.lineTo(bandLeft, front[0][1]);
  above.closePath();
  target.fill(above);
  target.restore();

  // Scorched paper just below the burn, on the paper only.
  target.save();
  target.globalCompositeOperation = 'source-atop';
  const scorch = target.createLinearGradient(0, geometry.burnY, 0, geometry.burnY + RING_DEPTH * geometry.halfWidth + 24);
  scorch.addColorStop(0, `rgba(${CHAR}, 0.97)`);
  scorch.addColorStop(0.5, `rgba(${CHAR}, 0.55)`);
  scorch.addColorStop(1, `rgba(${CHAR}, 0)`);
  target.fillStyle = scorch;
  target.fillRect(bandLeft, geometry.burnY - geometry.halfWidth, bandRight - bandLeft, geometry.halfWidth * 2 + 20);
  target.restore();

  if (geometry.ash < 1) return;
  // Ash: slightly narrower than the paper, with a crumbly end face seen from just above.
  const ashGeometry = { ...geometry, halfWidth: geometry.halfWidth * 0.95 };
  const bottom = ringPoints(ashGeometry, geometry.burnY, BURN_EDGE);
  const crownFront = ringPoints(ashGeometry, geometry.crownY, ashCrownEdge);
  const ash = new Path2D();
  pathThrough(ash, bottom);
  ash.lineTo(crownFront[crownFront.length - 1][0], crownFront[crownFront.length - 1][1]);
  const crownBack = crownFront.map(([x, y]) => [x, 2 * geometry.crownY - y]).reverse();
  for (const [x, y] of crownBack) ash.lineTo(x, y);
  ash.closePath();
  const centre = geometry.centreAt(geometry.burnY);
  const shading = target.createLinearGradient(centre - ashGeometry.halfWidth, 0, centre + ashGeometry.halfWidth, 0);
  shading.addColorStop(0, ASH_COLOURS.base);
  shading.addColorStop(0.25, ASH_COLOURS.light);
  shading.addColorStop(0.6, ASH_COLOURS.base);
  shading.addColorStop(1, ASH_COLOURS.shadow);
  target.fillStyle = shading;
  target.fill(ash);
  target.save();
  target.clip(ash);
  target.globalCompositeOperation = 'multiply';
  target.globalAlpha = 0.45;
  target.fillStyle = target.createPattern(ashTexture, 'repeat');
  target.fill(ash);
  target.globalAlpha = 1;
  target.globalCompositeOperation = 'source-over';
  // The end face: the top of the ash column, seen from just above.
  const face = new Path2D();
  pathThrough(face, crownFront);
  for (const [x, y] of crownBack) face.lineTo(x, y);
  face.closePath();
  target.fillStyle = ASH_COLOURS.face;
  target.fill(face);
  target.globalCompositeOperation = 'multiply';
  target.globalAlpha = 0.5;
  target.fillStyle = target.createPattern(ashTexture, 'repeat');
  target.fill(face);
  target.globalAlpha = 1;
  target.globalCompositeOperation = 'source-over';
  // The coal under the ash: char at rest, glowing through the ash during a drag.
  const heat = spent ? 0 : 0.3 + ember.glow * 0.7;
  const coal = target.createLinearGradient(0, geometry.burnY + RING_DEPTH * geometry.halfWidth, 0, geometry.burnY - Math.min(geometry.ash, 30) * (0.4 + heat * 0.6));
  coal.addColorStop(0, `rgba(255, ${Math.round(80 + 90 * heat)}, 30, ${spent ? 0 : 0.2 + heat * 0.75})`);
  coal.addColorStop(0.3, `rgba(${CHAR}, ${0.7 - heat * 0.4})`);
  coal.addColorStop(1, `rgba(${CHAR}, 0)`);
  target.fillStyle = coal;
  target.fill(ash);
  target.restore();
}

// Stage-space point for a cigarette point: loop-crop source pixels, or the upright cigarette while it is being taken away.
function loopPointToStage(x, y) {
  if (phase === 'leaving') return takedownPointToStage(x, y);
  const [left, top] = FOOTAGE_TRACK.loopCrop;
  const [pivotX, pivotY] = MOUTH_PIVOT;
  const stageX = (left + x) / SOURCE_PER_STAGE;
  const stageY = (top + y) / SOURCE_PER_STAGE;
  return [pivotX + (stageX - pivotX) * MOUTH_SCALE, pivotY + (stageY - pivotY) * MOUTH_SCALE];
}

// The burning seam, drawn after the room shade so the ember keeps its own light: a faint glowing line along the burn with
// brighter specks that flicker independently, the way smouldering paper does. Expects the context in stage pixels.
function drawBurnRing(view, time) {
  if (!(lit || spent) || seat.value <= 0) return;
  const geometry = cigaretteFrame();
  const ring = ringPoints(geometry, geometry.burnY, BURN_EDGE).map(([x, y]) => loopPointToStage(x, y));
  const heat = spent ? 0 : 0.3 + ember.glow * 0.7;
  context.save();
  context.lineCap = 'round';
  context.lineJoin = 'round';
  if (spent) {
    context.strokeStyle = `rgba(${CHAR}, 0.8)`;
    context.lineWidth = 0.8;
    context.beginPath();
    pathThrough(context, ring);
    context.stroke();
    context.restore();
    return;
  }
  context.globalCompositeOperation = 'lighter';
  context.shadowColor = `rgba(255, 100, 30, ${heat})`;
  context.shadowBlur = (2 + heat * 8) * view.scale * pixelScale * 0.5;
  context.strokeStyle = `rgba(255, ${Math.round(90 + 80 * heat)}, 40, ${0.25 + heat * 0.35})`;
  context.lineWidth = 0.5 + heat * 0.6;
  context.beginPath();
  pathThrough(context, ring);
  context.stroke();
  context.shadowBlur = 0;
  for (let index = 0; index < ring.length - 1; index++) {
    for (const along of [0.25, 0.75]) {
      const flicker = 0.55 + 0.45 * Math.sin(time * 0.0027 + index * 1.9 + along * 5.3);
      const strength = BURN_GLOW[index] * flicker * (0.35 + heat * 0.65);
      if (strength < 0.15) continue;
      const x = ring[index][0] + (ring[index + 1][0] - ring[index][0]) * along;
      const y = ring[index][1] + (ring[index + 1][1] - ring[index][1]) * along;
      const radius = 0.6 + strength * (0.8 + heat);
      const speck = context.createRadialGradient(x, y, 0, x, y, radius);
      speck.addColorStop(0, `rgba(255, ${Math.round(170 + 70 * strength)}, ${Math.round(90 + 60 * strength)}, ${strength})`);
      speck.addColorStop(0.5, `rgba(255, 90, 20, ${strength * 0.5})`);
      speck.addColorStop(1, 'rgba(255, 60, 10, 0)');
      context.fillStyle = speck;
      context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }
  }
  context.restore();
}

// Stage-space points the smoke and glow attach to: the burn line and the top of the ash.
function emberStagePoint() {
  const geometry = cigaretteFrame();
  return loopPointToStage(geometry.centreAt(geometry.burnY), geometry.burnY + RING_DEPTH * geometry.halfWidth * 0.5);
}

// Points across the burning end that smoke leaves from: on the ash just above the burn line, around its visible face.
function smokeSourceStagePoints(positions) {
  const geometry = cigaretteFrame();
  const y = geometry.burnY - Math.min(geometry.ash, 10) * 0.5;
  return positions.map((across) => loopPointToStage(
    geometry.centreAt(y) + across * geometry.halfWidth * 0.95,
    y + RING_DEPTH * geometry.halfWidth * Math.sqrt(1 - across * across),
  ));
}

followLoopFrames();
