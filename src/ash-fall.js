// Ash breaking off the cigarette: snaps the rendered ash along a jagged line, leans it over its break, crumbles it into clumps and dust.
// Pieces fall under air drag, because ash is nearly weightless: slow terminal speeds, flutter and tumbling rather than a dropped weight.
'use strict';

// All speeds are stage pixels per second; the stage is 360 tall.
const ASH_GRAVITY = 240;
// Why: gravity over drag sets the terminal speed; these give shards about a fifth of the screen per second, and dust far less, so it hangs.
const SHARD_DRAG = [2.6, 4.2];
const DUST_GRAVITY = 110;
const DUST_DRAG = [6, 9];
const SHARD_COUNT = [7, 11];
// In source pixels: how coarse and how far the clump borders wander, and how wide a band along them crumbles away.
const CLUMP_NOISE_CELL = 5;
const CLUMP_NOISE_REACH = 6;
const CLUMP_BORDER_WIDTH = 5;
const CLUMP_BORDER_LOSS = 0.7;
// A flake never turns fully edge-on, or clumps would flatten into slivers.
const THINNEST_TUMBLE = 0.6;
const DUST_BURST = [26, 40];
// Why: the clump leans over its break as one piece before it comes apart; shards let go at different moments so it crumbles rather than bursts.
const HINGE_ACCELERATION = [14, 24];
const SHARD_RELEASE_SECONDS = [0.1, 0.28];
const SHARD_SHED_PER_SECOND = 12;
const SHARD_LIFETIME = [2, 3];
const DUST_LIFETIME = [1.2, 2.8];
const MAX_ASH_PIECES = 170;
// How far the break line wanders along the cigarette, in source pixels.
const BREAK_DEPTH = 9;
const BREAK_POINTS = 13;

const fallingShards = [];
const fallingDust = [];

function randomInRange([minimum, maximum]) {
  return randomBetween(minimum, maximum);
}

function ashFalling() {
  return fallingShards.length > 0 || fallingDust.length > 0;
}

// A torn profile for the break: mostly shallow with the odd deep bite, and pulled in at the ends where the ash meets the edge.
function jaggedBreakEdge() {
  return Array.from({ length: BREAK_POINTS }, (_, index) => {
    const taper = Math.sin((Math.PI * index) / (BREAK_POINTS - 1));
    return (Math.random() ** 2 * BREAK_DEPTH - BREAK_DEPTH * 0.25) * (0.35 + 0.65 * taper);
  });
}

// Copies the rendered ash above the break line, with everything below the line erased, so the piece carries the same torn edge as the stub.
function copyBrokenAsh(geometry, breakLine) {
  const reach = geometry.halfWidth * 1.15;
  const centre = geometry.centreAt(geometry.burnY);
  const left = Math.max(0, Math.floor(centre - reach));
  const top = Math.max(0, Math.floor(geometry.crownY - RING_DEPTH * geometry.halfWidth - 6));
  const width = Math.min(cutCanvas.width - left, Math.ceil(reach * 2));
  const bottom = Math.ceil(Math.max(...breakLine.map(([, y]) => y)));
  const height = bottom - top;
  if (width <= 0 || height <= 0) return null;
  const image = document.createElement('canvas');
  image.width = width;
  image.height = height;
  const target = image.getContext('2d');
  target.drawImage(cutCanvas, left, top, width, height, 0, 0, width, height);
  target.globalCompositeOperation = 'destination-out';
  target.beginPath();
  target.moveTo(0, height + 1);
  target.lineTo(0, breakLine[0][1] - top);
  for (const [x, y] of breakLine) target.lineTo(x - left, y - top);
  target.lineTo(width, breakLine[breakLine.length - 1][1] - top);
  target.lineTo(width, height + 1);
  target.closePath();
  target.fill();
  return { image, left, top, width, height };
}

// A coarse grid of random nudges, so the borders between clumps wander instead of running straight.
function clumpNoise(width, height) {
  const columns = Math.ceil(width / CLUMP_NOISE_CELL) + 1;
  const cells = Array.from({ length: columns * (Math.ceil(height / CLUMP_NOISE_CELL) + 1) }, () => randomBetween(-1, 1) * CLUMP_NOISE_REACH);
  return (x, y) => cells[Math.floor(y / CLUMP_NOISE_CELL) * columns + Math.floor(x / CLUMP_NOISE_CELL)];
}

// Why: split pixel by pixel rather than along cut lines, which read as paper or glass. Each pixel joins its nearest seed, and those on a
// border between clumps are often lost, so every clump ends up with the crumbled edge ash really has.
function fracture({ image, width, height }) {
  const source = image.getContext('2d').getImageData(0, 0, width, height).data;
  const seeds = Array.from({ length: Math.round(randomInRange(SHARD_COUNT)) }, () => ({
    x: Math.random() * width,
    y: Math.random() * height,
    pixels: [],
    left: width,
    top: height,
    right: 0,
    bottom: 0,
  }));
  const noise = clumpNoise(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      if (source[index + 3] === 0) continue;
      let nearest = null;
      let nearestDistance = Infinity;
      let secondDistance = Infinity;
      for (const seed of seeds) {
        const distance = Math.hypot(x - seed.x, y - seed.y) + noise(x, y) * (seed.x > x ? 1 : -1);
        if (distance < nearestDistance) {
          secondDistance = nearestDistance;
          nearestDistance = distance;
          nearest = seed;
        } else if (distance < secondDistance) {
          secondDistance = distance;
        }
      }
      const borderCloseness = 1 - Math.min(1, (secondDistance - nearestDistance) / CLUMP_BORDER_WIDTH);
      if (Math.random() < borderCloseness * CLUMP_BORDER_LOSS) continue;
      nearest.pixels.push(x, y, index);
      nearest.left = Math.min(nearest.left, x);
      nearest.top = Math.min(nearest.top, y);
      nearest.right = Math.max(nearest.right, x + 1);
      nearest.bottom = Math.max(nearest.bottom, y + 1);
    }
  }

  return seeds.filter((seed) => seed.pixels.length > 0).map((seed) => {
    const canvas = document.createElement('canvas');
    canvas.width = seed.right - seed.left;
    canvas.height = seed.bottom - seed.top;
    const target = canvas.getContext('2d');
    const clump = target.createImageData(canvas.width, canvas.height);
    for (let pixel = 0; pixel < seed.pixels.length; pixel += 3) {
      const destination = ((seed.pixels[pixel + 1] - seed.top) * canvas.width + seed.pixels[pixel] - seed.left) * 4;
      for (let channel = 0; channel < 4; channel++) clump.data[destination + channel] = source[seed.pixels[pixel + 2] + channel];
    }
    target.putImageData(clump, 0, 0);
    return { canvas, left: seed.left, top: seed.top, width: canvas.width, height: canvas.height };
  });
}

function addDust(x, y, velocityX, velocityY) {
  if (fallingDust.length >= MAX_ASH_PIECES) return;
  const size = randomBetween(0.25, 0.9);
  const corners = 3 + Math.floor(Math.random() * 3);
  fallingDust.push({
    x,
    y,
    velocityX,
    velocityY,
    drag: randomInRange(DUST_DRAG),
    flutter: randomBetween(12, 28),
    flutterRate: randomBetween(2, 5),
    flutterPhase: Math.random() * Math.PI * 2,
    rotation: Math.random() * Math.PI * 2,
    spin: randomBetween(-5, 5),
    outline: Array.from({ length: corners }, (_, corner) => {
      const angle = (corner / corners) * Math.PI * 2;
      const radius = size * randomBetween(0.55, 1.15);
      return [Math.cos(angle) * radius, Math.sin(angle) * radius];
    }),
    colour: [ASH_COLOURS.light, ASH_COLOURS.base, ASH_COLOURS.base, ASH_COLOURS.shadow][Math.floor(Math.random() * 4)],
    opacity: randomBetween(0.35, 0.85),
    age: 0,
    lifetime: randomInRange(DUST_LIFETIME),
  });
}

// Snaps the ash off a little above the ember. Only a short stub stays on the ember, keeping the torn edge the piece broke along.
function breakOffAsh(geometry) {
  const stub = ASH_STUB[0] + Math.random() * (ASH_STUB[1] - ASH_STUB[0]);
  const breakY = geometry.burnY - stub;
  const breakEdge = jaggedBreakEdge();
  const piece = copyBrokenAsh(geometry, ringPoints(geometry, breakY, breakEdge));
  if (!piece) return;

  const [stageLeft, stageTop] = loopPointToStage(piece.left, piece.top);
  const [stageRight, stageBottom] = loopPointToStage(piece.left + piece.width, piece.top + piece.height);
  const stagePerPixel = (stageRight - stageLeft) / piece.width;
  const side = Math.random() < 0.5 ? -1 : 1;
  // It leans over the bottom corner on the side it falls toward.
  const hinge = {
    x: side > 0 ? stageRight : stageLeft,
    y: stageBottom,
    angle: 0,
    angularVelocity: 0,
    angularAcceleration: side * randomInRange(HINGE_ACCELERATION),
  };

  for (const shard of fracture(piece)) {
    const shardWidth = shard.width * stagePerPixel;
    const shardHeight = shard.height * stagePerPixel;
    fallingShards.push({
      image: shard.canvas,
      width: shardWidth,
      height: shardHeight,
      hinge,
      offsetX: stageLeft + shard.left * stagePerPixel + shardWidth / 2 - hinge.x,
      offsetY: stageTop + shard.top * stagePerPixel + shardHeight / 2 - hinge.y,
      releaseAt: randomInRange(SHARD_RELEASE_SECONDS),
      side,
      drag: randomInRange(SHARD_DRAG),
      flutter: randomBetween(30, 60),
      flutterRate: randomBetween(3, 6),
      flutterPhase: Math.random() * Math.PI * 2,
      tumble: Math.random() * Math.PI * 2,
      tumbleRate: randomBetween(2, 6),
      age: 0,
      lifetime: randomInRange(SHARD_LIFETIME),
    });
  }
  const dustCount = randomInRange(DUST_BURST);
  for (let dust = 0; dust < dustCount; dust++) {
    addDust(randomBetween(stageLeft, stageRight), stageBottom - randomBetween(0, 3), randomBetween(-18, 18) + side * 8, randomBetween(-12, 8));
  }

  ashCrownEdge = breakEdge;
  ashLength = stub;
  ashLimit = nextAshLimit();
}

function hingedPosition(shard) {
  const { hinge, offsetX, offsetY } = shard;
  const cos = Math.cos(hinge.angle);
  const sin = Math.sin(hinge.angle);
  return [hinge.x + offsetX * cos - offsetY * sin, hinge.y + offsetX * sin + offsetY * cos];
}

// Lets a shard go, carrying the speed it had swinging on the hinge.
function releaseShard(shard) {
  const { hinge } = shard;
  const [x, y] = hingedPosition(shard);
  shard.x = x;
  shard.y = y;
  shard.velocityX = -(y - hinge.y) * hinge.angularVelocity + shard.side * randomBetween(6, 20);
  shard.velocityY = (x - hinge.x) * hinge.angularVelocity + randomBetween(-4, 8);
  shard.rotation = hinge.angle;
  shard.spin = hinge.angularVelocity * randomBetween(0.4, 0.9) + randomBetween(-2, 2);
  shard.hinge = null;
}

function updateShard(shard, deltaSeconds) {
  shard.age += deltaSeconds;
  if (shard.hinge) {
    if (shard.age >= shard.releaseAt) releaseShard(shard);
    return;
  }
  const sway = Math.sin(shard.age * shard.flutterRate + shard.flutterPhase) * shard.flutter;
  shard.velocityX += (sway - shard.drag * shard.velocityX) * deltaSeconds;
  shard.velocityY += (ASH_GRAVITY - shard.drag * shard.velocityY) * deltaSeconds;
  shard.x += shard.velocityX * deltaSeconds;
  shard.y += shard.velocityY * deltaSeconds;
  shard.rotation += shard.spin * deltaSeconds;
  shard.tumble += shard.tumbleRate * deltaSeconds;
  if (Math.random() < SHARD_SHED_PER_SECOND * deltaSeconds) {
    addDust(shard.x, shard.y, shard.velocityX * 0.4 + randomBetween(-8, 8), shard.velocityY * 0.3);
  }
}

function updateDust(dust, deltaSeconds) {
  dust.age += deltaSeconds;
  const sway = Math.sin(dust.age * dust.flutterRate + dust.flutterPhase) * dust.flutter;
  dust.velocityX += (sway - dust.drag * dust.velocityX) * deltaSeconds;
  dust.velocityY += (DUST_GRAVITY - dust.drag * dust.velocityY) * deltaSeconds;
  dust.x += dust.velocityX * deltaSeconds;
  dust.y += dust.velocityY * deltaSeconds;
  dust.rotation += dust.spin * deltaSeconds;
}

function updateFallingAsh(deltaSeconds) {
  if (!ashFalling()) return;
  const hinges = new Set(fallingShards.map((shard) => shard.hinge).filter(Boolean));
  for (const hinge of hinges) {
    hinge.angularVelocity += hinge.angularAcceleration * deltaSeconds;
    hinge.angle += hinge.angularVelocity * deltaSeconds;
  }
  for (let index = fallingShards.length - 1; index >= 0; index--) {
    const shard = fallingShards[index];
    updateShard(shard, deltaSeconds);
    if (shard.age >= shard.lifetime || (!shard.hinge && shard.y > STAGE_HEIGHT + shard.height)) fallingShards.splice(index, 1);
  }
  for (let index = fallingDust.length - 1; index >= 0; index--) {
    updateDust(fallingDust[index], deltaSeconds);
    if (fallingDust[index].age >= fallingDust[index].lifetime) fallingDust.splice(index, 1);
  }
}

// Pieces thin out over the end of their life rather than vanishing.
function ashFade(piece) {
  return 1 - Math.max(0, (piece.age - piece.lifetime * 0.6) / (piece.lifetime * 0.4));
}

// Draws the falling ash. Expects the context in stage pixels.
function drawFallingAsh() {
  for (const dust of fallingDust) {
    context.save();
    context.globalAlpha = dust.opacity * ashFade(dust);
    context.translate(dust.x, dust.y);
    context.rotate(dust.rotation);
    context.fillStyle = dust.colour;
    context.beginPath();
    dust.outline.forEach(([x, y], point) => (point === 0 ? context.moveTo(x, y) : context.lineTo(x, y)));
    context.closePath();
    context.fill();
    context.restore();
  }
  for (const shard of fallingShards) {
    const [x, y] = shard.hinge ? hingedPosition(shard) : [shard.x, shard.y];
    context.save();
    context.globalAlpha = ashFade(shard);
    context.translate(x, y);
    context.rotate(shard.hinge ? shard.hinge.angle : shard.rotation);
    // Tumbling end over end: a flake seen edge-on is thin, so it narrows and widens as it turns.
    if (!shard.hinge) context.scale(1, Math.max(THINNEST_TUMBLE, Math.abs(Math.cos(shard.tumble))));
    context.drawImage(shard.image, -shard.width / 2, -shard.height / 2, shard.width, shard.height);
    context.restore();
  }
}
