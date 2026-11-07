// The hand taking the cigarette from the mouth: plays the keyed clip with the cigarette's real burn, ash and ember carried along on it.
// The filmed cigarette is fresh and tilts as it moves, so each frame is turned upright, burnt with footage.js's drawing, and turned back.
'use strict';

// Room around the clip for its corners while it is turned upright, in source pixels.
const TAKEDOWN_MARGIN = 500;
// Why: the mouth framing leaves the filmed frame's right edge on screen, which would slice the hand; it eases to the hand framing,
// whose edges are off screen, before the hand gets there.
const TAKEDOWN_FRAMING_SECONDS = [0.02, 0.22];
// The cigarette's filmed start differs a little from wherever the loop was; that gap closes over this long so the handover doesn't jump.
const TAKEDOWN_JOIN_SECONDS = 0.12;

const takedownClip = createClip('assets/takedown.webm', false);
const takedownCanvas = document.createElement('canvas');
const takedownContext = takedownCanvas.getContext('2d');
let takedownFrame = 0;
let takedownJoin = [0, 0];

function followTakedownFrames() {
  takedownClip.requestVideoFrameCallback((_now, metadata) => {
    takedownFrame = Math.min(Math.round(metadata.mediaTime * TAKEDOWN_TRACK.fps), TAKEDOWN_TRACK.frames.length - 1);
    followTakedownFrames();
  });
}

function takedownFraming(seconds) {
  const [start, end] = TAKEDOWN_FRAMING_SECONDS;
  const progress = Math.min(1, Math.max(0, (seconds - start) / (end - start)));
  const eased = progress * progress * (3 - 2 * progress);
  const [mouthX, mouthY] = MOUTH_PIVOT;
  const joinLeft = Math.max(0, 1 - seconds / TAKEDOWN_JOIN_SECONDS);
  return {
    pivotX: mouthX + (STAGE_WIDTH - mouthX) * eased,
    pivotY: mouthY + (STAGE_HEIGHT - mouthY) * eased,
    scale: MOUTH_SCALE + (HAND_SCALE - MOUTH_SCALE) * eased,
    joinX: takedownJoin[0] * joinLeft,
    joinY: takedownJoin[1] * joinLeft,
  };
}

function clipPointToStage(framing, x, y) {
  const [left, top] = TAKEDOWN_TRACK.crop;
  const stageX = (left + x) / SOURCE_PER_STAGE;
  const stageY = (top + y) / SOURCE_PER_STAGE;
  return [
    framing.pivotX + (stageX - framing.pivotX) * framing.scale + framing.joinX,
    framing.pivotY + (stageY - framing.pivotY) * framing.scale + framing.joinY,
  ];
}

// Stage-space point for a point on the upright cigarette.
function takedownPointToStage(x, y) {
  const [tipX, tipY, tilt] = TAKEDOWN_TRACK.frames[takedownFrame];
  const cos = Math.cos(tilt);
  const sin = Math.sin(tilt);
  const acrossX = x - tipX;
  const alongY = y - tipY;
  return clipPointToStage(takedownFraming(takedownClip.currentTime), tipX + acrossX * cos - alongY * sin, tipY + acrossX * sin + alongY * cos);
}

// The burn on the upright cigarette, scaled because it shrinks as it is carried away from the eye.
function takedownGeometry() {
  const [tipX, tipY, , halfWidth] = TAKEDOWN_TRACK.frames[takedownFrame];
  const shrink = halfWidth / FOOTAGE_TRACK.loop[0][3];
  const ash = ashLength * ashFormed.value * shrink;
  const burnY = tipY + (ASH_CHAR * ashFormed.value + burn * BURN_TRAVEL) * shrink;
  return { centreAt: () => tipX, halfWidth, burnY, crownY: burnY - ash, ash };
}

// Plays the clip from wherever the loop has got to; resolves once the cigarette has left the frame.
async function playTakedownClip() {
  const [top, intercept, slope] = FOOTAGE_TRACK.loop[loopFrame];
  const [fromX, fromY] = loopPointToStage(intercept + slope * top, top);
  const [tipX, tipY] = TAKEDOWN_TRACK.frames[0];
  takedownJoin = [0, 0];
  const [toX, toY] = clipPointToStage(takedownFraming(0), tipX, tipY);
  takedownJoin = [fromX - toX, fromY - toY];
  takedownFrame = 0;
  phase = 'leaving';
  await clipReady(takedownClip);
  takedownClip.currentTime = 0;
  await takedownClip.play();
  await new Promise((resolve) => takedownClip.addEventListener('ended', resolve, { once: true }));
}

// Expects the context in stage pixels.
function drawTakedownFootage() {
  const [left, top, right, bottom] = TAKEDOWN_TRACK.crop;
  const [tipX, tipY, tilt] = TAKEDOWN_TRACK.frames[takedownFrame];
  const width = right - left + TAKEDOWN_MARGIN * 2;
  const height = bottom - top + TAKEDOWN_MARGIN * 2;
  if (takedownCanvas.width !== width || takedownCanvas.height !== height) {
    takedownCanvas.width = width;
    takedownCanvas.height = height;
  }
  takedownContext.setTransform(1, 0, 0, 1, 0, 0);
  takedownContext.clearRect(0, 0, width, height);
  takedownContext.setTransform(1, 0, 0, 1, TAKEDOWN_MARGIN, TAKEDOWN_MARGIN);
  takedownContext.translate(tipX, tipY);
  takedownContext.rotate(-tilt);
  takedownContext.translate(-tipX, -tipY);
  takedownContext.drawImage(takedownClip, 0, 0);
  takedownContext.setTransform(1, 0, 0, 1, TAKEDOWN_MARGIN, TAKEDOWN_MARGIN);
  if (lit || spent) burnCut(takedownContext, takedownGeometry());

  const framing = takedownFraming(takedownClip.currentTime);
  context.save();
  context.translate(framing.joinX, framing.joinY);
  context.translate(framing.pivotX, framing.pivotY);
  context.scale(framing.scale, framing.scale);
  context.translate(-framing.pivotX, -framing.pivotY);
  context.translate(left / SOURCE_PER_STAGE, top / SOURCE_PER_STAGE);
  context.scale(1 / SOURCE_PER_STAGE, 1 / SOURCE_PER_STAGE);
  context.translate(tipX, tipY);
  context.rotate(tilt);
  context.translate(-tipX, -tipY);
  context.drawImage(takedownCanvas, -TAKEDOWN_MARGIN, -TAKEDOWN_MARGIN);
  context.restore();
}

followTakedownFrames();
