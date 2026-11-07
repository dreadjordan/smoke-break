// The desktop picture as stacked layers: the opening snapshot, the live feed from the native helper, and a full-resolution still for the dash back.
// Each layer blends in over the one below, so the screen never visibly swaps pictures; scene.js draws them and live frames also set the room's light.
'use strict';

// Why: the live feed is small, so it only takes over once the screen has shrunk enough for it to look as sharp as the snapshot.
const LIVE_SHARP_FEET = 12;
const LIVE_BLEND_MS = 200;
// Why: the dash back reaches half size within about 200ms, so the sharp still has to land fast or the screen visibly softens.
const STILL_BLEND_MS = 100;
// How far the room's light moves toward each new frame's colour, so it follows the screen without strobing.
const AMBIENT_FOLLOW = 0.12;
// Sampling every Nth pixel is plenty for an average; a prime stride avoids lining up with the picture's columns.
const AMBIENT_PIXEL_STRIDE = 997;
const MAX_BLEND_STEP_MS = 50;
const SRGB_FRAME = { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'rgb', fullRange: true };

const snapshotLayer = { frame: null, width: 0, height: 0, blend: 1, showing: true, blendMs: 1 };
const liveLayer = { frame: null, width: 0, height: 0, blend: 0, showing: false, blendMs: LIVE_BLEND_MS };
const stillLayer = { frame: null, width: 0, height: 0, blend: 0, showing: false, blendMs: STILL_BLEND_MS };
const desktopLayers = [snapshotLayer, liveLayer, stillLayer];
const desktopAmbient = [128, 128, 128];
let lastBlendTime = 0;
let reportSnapshotReady;
const desktopSnapshotReady = new Promise((resolve) => {
  reportSnapshotReady = resolve;
});

function topDesktopLayer() {
  return desktopLayers.findLast((layer) => layer.blend > 0);
}

function followAmbient(pixels, follow) {
  let red = 0;
  let green = 0;
  let blue = 0;
  let count = 0;
  for (let index = 0; index < pixels.length; index += AMBIENT_PIXEL_STRIDE * 4) {
    blue += pixels[index];
    green += pixels[index + 1];
    red += pixels[index + 2];
    count++;
  }
  [red, green, blue].forEach((total, channel) => {
    desktopAmbient[channel] += (total / count - desktopAmbient[channel]) * follow;
  });
}

// Moves each layer's blend along; reports whether any is still changing, so the scene knows to draw again.
function advanceDesktopLayers(viewerFeet) {
  const now = performance.now();
  const elapsedMs = Math.min(now - lastBlendTime, MAX_BLEND_STEP_MS);
  lastBlendTime = now;
  if (liveLayer.frame && viewerFeet >= LIVE_SHARP_FEET) liveLayer.showing = true;
  let changing = false;
  for (const layer of desktopLayers) {
    if (!layer.showing || layer.blend >= 1) continue;
    layer.blend = Math.min(1, layer.blend + elapsedMs / layer.blendMs);
    changing = true;
  }
  return changing;
}

function drawDesktopLayers(context, left, top, width, height) {
  const lowestVisible = desktopLayers.findLastIndex((layer) => layer.blend >= 1);
  context.save();
  for (const layer of desktopLayers.slice(lowestVisible)) {
    if (layer.blend <= 0) continue;
    context.globalAlpha = layer.blend;
    context.drawImage(layer.frame, left, top, width, height);
  }
  context.restore();
}

function setLayerPixels(layer, width, height, pixels) {
  layer.frame?.close();
  layer.frame = new VideoFrame(pixels, { format: 'BGRX', codedWidth: width, codedHeight: height, timestamp: 0, colorSpace: SRGB_FRAME });
  layer.width = width;
  layer.height = height;
}

function showSnapshot(width, height, pixels) {
  setLayerPixels(snapshotLayer, width, height, pixels);
  followAmbient(pixels, 1);
  reportSnapshotReady();
}

function showLiveFrame(width, height, pixels) {
  setLayerPixels(liveLayer, width, height, pixels);
  followAmbient(pixels, AMBIENT_FOLLOW);
  requestSceneDraw();
}

async function showStill(width, height, jpeg) {
  stillLayer.frame = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
  stillLayer.width = width;
  stillLayer.height = height;
  stillLayer.showing = true;
  requestSceneDraw();
}

window.smokeBreak.onDesktopFrame(({ kind, width, height, pixels }) => {
  if (kind === 'snapshot') showSnapshot(width, height, pixels);
  else if (kind === 'still') showStill(width, height, pixels);
  else showLiveFrame(width, height, pixels);
});
