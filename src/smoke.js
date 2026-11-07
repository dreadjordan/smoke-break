// Smoke Break's cigarette smoke: one emitter spread over the whole burning rim, releasing many small wisps that drift back
// toward the viewer (down the screen, past the cigarette) through a shared, slowly changing flow, merging into one plume.
'use strict';

// Where across the burn ring smoke can leave from (-1 left edge, 0 front, 1 right edge); smoker.js passes the world
// points for these, and each wisp starts at a random spot between them.
const SMOKE_SOURCE_POSITIONS = [-1, -0.5, 0, 0.5, 1];
// Why: many faint wisps from random spots on the rim, all riding one flow, bunch into folds and sheets that weave and
// merge; a few fixed strands could only ever read as separate streams.
const SMOKE_WISPS_PER_SECOND = 90;
const SMOKE_LIFETIME = 3;
const SMOKE_COLOUR = '198, 207, 224';
const EDGE_PUSH = 14;
// Why: real smoke stays laminar for a few centimetres above the tip before turbulence takes over; these ages (seconds)
// bound that transition.
const LAMINAR_AGE = 0.35;
const TURBULENT_AGE = 1.8;

const smokeLayer = document.createElement('canvas');
const smokeLayerContext = smokeLayer.getContext('2d');
const wisps = [];
let smokeAccumulator = 0;
let smokeClock = 0;
// Multiplies all smoke opacity; fadeOutSmoke() takes it to zero so nothing lingers when the break closes.
const smokePresence = { value: 1, fadeStart: 0, fadeMs: 0 };

function smoothStep(edgeStart, edgeEnd, value) {
  const progress = Math.min(1, Math.max(0, (value - edgeStart) / (edgeEnd - edgeStart)));
  return progress * progress * (3 - 2 * progress);
}

// Advances the smoke; sources are the world-space points for SMOKE_SOURCE_POSITIONS (in order), or null while nothing is burning.
function updateSmoke(deltaSeconds, sources) {
  smokeClock += deltaSeconds;
  if (sources) {
    smokeAccumulator += deltaSeconds * SMOKE_WISPS_PER_SECOND;
    while (smokeAccumulator >= 1) {
      smokeAccumulator -= 1;
      const along = Math.random() * (sources.length - 1);
      const index = Math.min(sources.length - 2, Math.floor(along));
      const fraction = along - index;
      const across = SMOKE_SOURCE_POSITIONS[index] + (SMOKE_SOURCE_POSITIONS[index + 1] - SMOKE_SOURCE_POSITIONS[index]) * fraction;
      wisps.push({
        x: sources[index].x + (sources[index + 1].x - sources[index].x) * fraction,
        y: sources[index].y + (sources[index + 1].y - sources[index].y) * fraction,
        velocityX: across * EDGE_PUSH * (0.5 + Math.random()),
        velocityY: 4 + Math.random() * 6,
        age: Math.random() * 0.05,
        // A small personal offset into the shared flow, so neighbouring wisps diverge and cross a little.
        seed: Math.random() * 2 - 1,
      });
    }
  }

  // A slow, wandering draft carries the plume past the side of the cigarette, never the same way twice.
  const draft = 22 + 8 * Math.sin(smokeClock * 0.21) + 4 * Math.sin(smokeClock * 0.53 + 1.1);
  for (let index = wisps.length - 1; index >= 0; index--) {
    const wisp = wisps[index];
    wisp.age += deltaSeconds;
    if (wisp.age >= SMOKE_LIFETIME) {
      wisps[index] = wisps[wisps.length - 1];
      wisps.pop();
      continue;
    }
    // Why: the smoke drifts back toward the viewer; seen from behind the cigarette that reads as moving down the screen,
    // apparently speeding up as it nears the camera.
    const targetDrift = 10 + wisp.age * 70;
    wisp.velocityY += (targetDrift - wisp.velocityY) * Math.min(1, deltaSeconds * 1.6);
    wisp.velocityX *= Math.exp(-2.5 * deltaSeconds);
    const turbulence = smoothStep(LAMINAR_AGE, TURBULENT_AGE, wisp.age);
    const offset = wisp.seed * 0.6;
    const flow = Math.sin(wisp.y * 0.018 + smokeClock * 0.8 + offset)
      + 0.6 * Math.sin(wisp.y * 0.043 - smokeClock * 1.5 + 1.3 + offset * 1.7)
      + 0.35 * Math.sin(wisp.y * 0.097 + wisp.x * 0.03 + smokeClock * 2.6 + 0.4);
    wisp.x += (wisp.velocityX + turbulence * 20 * flow + draft * Math.min(1, wisp.age * 3)) * deltaSeconds;
    wisp.y += wisp.velocityY * deltaSeconds;
  }
}

function fadeOutSmoke(durationMs) {
  smokePresence.fadeStart = performance.now();
  smokePresence.fadeMs = durationMs;
}

function smokeVisible() {
  return wisps.length > 0;
}

// Draws the smoke onto target (world space, scaled by pixelScale). Each wisp is a short soft streak along its motion,
// painted to a half-resolution layer; that layer is composited blurred for the diffuse body and faintly sharp for detail.
function drawSmoke(target, pixelScale) {
  if (!smokeVisible()) return;
  if (smokePresence.fadeMs > 0) {
    smokePresence.value = Math.max(0, 1 - (performance.now() - smokePresence.fadeStart) / smokePresence.fadeMs);
  }
  if (smokePresence.value <= 0) return;
  const width = Math.ceil(target.canvas.width / 2);
  const height = Math.ceil(target.canvas.height / 2);
  if (smokeLayer.width !== width || smokeLayer.height !== height) {
    smokeLayer.width = width;
    smokeLayer.height = height;
  }
  const layer = smokeLayerContext;
  layer.setTransform(1, 0, 0, 1, 0, 0);
  layer.clearRect(0, 0, width, height);
  layer.setTransform(pixelScale / 2, 0, 0, pixelScale / 2, 0, 0);
  layer.lineCap = 'round';
  for (const wisp of wisps) {
    const progress = wisp.age / SMOKE_LIFETIME;
    const alpha = 0.13 * (1 - progress) ** 1.6 * Math.min(1, wisp.age * 5);
    if (alpha <= 0.002) continue;
    const streak = 0.09 + progress * 0.08;
    layer.strokeStyle = `rgba(${SMOKE_COLOUR}, ${alpha})`;
    layer.lineWidth = 1.5 + progress ** 1.4 * 26;
    layer.beginPath();
    layer.moveTo(wisp.x - wisp.velocityX * streak, wisp.y - wisp.velocityY * streak);
    layer.lineTo(wisp.x, wisp.y);
    layer.stroke();
  }
  target.save();
  target.setTransform(1, 0, 0, 1, 0, 0);
  target.globalAlpha = smokePresence.value;
  target.filter = `blur(${Math.max(1, pixelScale * 3)}px)`;
  target.drawImage(smokeLayer, 0, 0, target.canvas.width, target.canvas.height);
  target.filter = 'none';
  target.globalAlpha = 0.35 * smokePresence.value;
  target.drawImage(smokeLayer, 0, 0, target.canvas.width, target.canvas.height);
  target.restore();
}
