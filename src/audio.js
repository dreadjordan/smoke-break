// Smoke Break's sound: the room ambience under the whole break, the whoosh of the dash out and its reverse on the way back, the lighter as the cigarette reaches the mouth, and each drag's inhale.
// The ambience, dash and lighter are recordings; the inhale is synthesised here.
'use strict';

// Why: the Volume setting's 100% is this much of full level; at 1 the whole break played too loud.
const MAXIMUM_VOLUME = 0.7;
const AMBIENCE_FADE_IN_SECONDS = 4;
const AMBIENCE_VOLUME = 0.56;
// Why: most of the recording's energy is rumble below 60Hz; two stacked filters clear it without thinning the room above.
const AMBIENCE_RUMBLE_CUT_HERTZ = 100;
// Why: level with the room recording or above, the inhale read as loud and harsh; it sits under the room as a soft breath.
const INHALE_VOLUME = 0.1;
const CRACKLE_LEVEL = 0.12;
const DASH_VOLUME = 0.133;
// Why: the whoosh peaks 0.65s into its recording but a dash is fastest at its very start, so playback skips the slow
// build-up to land the peak on the burst.
const DASH_START_SECONDS = 0.4;
const DASH_PEAK_SECONDS = 0.65;
const DASH_IN_VOLUME = 0.0875;
// Why: the dash back covers most of its distance early, so the reversed whoosh peaks a little under halfway through, as the screen fills the view.
const DASH_IN_LANDING = 0.45;
// Starts muffled and opens up on arrival, in step with the distance effect clearing from other apps' sound.
const DASH_IN_FAR_HERTZ = 600;
const DASH_IN_NEAR_HERTZ = 9000;
// Why: the recording peaks at full scale and played unscaled, about 11 dB louder than the room and the dash; 0.2 sits it just under them, since a click's sharp attack reads louder than its measured level.
const LIGHTER_VOLUME = 0.2;
// Burning tobacco keeps ticking briefly after the draw stops.
const CRACKLE_TAIL_SECONDS = 0.45;
const CRACKLES_PER_SECOND = 45;
const NOISE_SECONDS = 4;

const ambience = createSound('assets/sounds/ambience.webm');
const dash = createSound('assets/sounds/dash.webm');
// Why: the recording runs 101 seconds, and the longest breaks outlast it.
ambience.loop = true;
const audioContext = new AudioContext();
const airNoise = createNoiseBuffer(audioContext);
const crackleNoise = createCrackleBuffer(audioContext);
// Everything played through the context goes through this, so the Volume setting scales it all at once.
const masterVolume = audioContext.createGain();
masterVolume.connect(audioContext.destination);
const ambienceLevel = routeAmbience();
// Why: the page waits hidden between breaks, and a running context would hold the audio device awake the whole time.
audioContext.suspend();
let soundEnabled = true;
let soundVolume = 1;
let lighterBuffer = null;
let dashInBuffer = null;
let inhaleOutput = null;

// Why: the click is the one timing-critical sound; a decoded buffer starts within milliseconds, a media element makes no such promise.
decodeSound('assets/sounds/light.webm').then((buffer) => {
  lighterBuffer = buffer;
});
decodeSound('assets/sounds/dash.webm').then((buffer) => {
  dashInBuffer = reversedBuffer(buffer);
});

async function decodeSound(source) {
  const response = await fetch(source);
  return audioContext.decodeAudioData(await response.arrayBuffer());
}

// Why: the dash back is the dash out undone; played backwards, the whoosh rushes toward the viewer and lands instead of trailing away.
function reversedBuffer(buffer) {
  const reversed = audioContext.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    reversed.getChannelData(channel).set(buffer.getChannelData(channel).toReversed());
  }
  return reversed;
}

function createSound(source) {
  const sound = new Audio(source);
  sound.preload = 'auto';
  return sound;
}

function routeAmbience() {
  const level = audioContext.createGain();
  level.gain.value = 0;
  let previous = audioContext.createMediaElementSource(ambience);
  for (let stage = 0; stage < 2; stage++) {
    const rumbleCut = audioContext.createBiquadFilter();
    rumbleCut.type = 'highpass';
    rumbleCut.frequency.value = AMBIENCE_RUMBLE_CUT_HERTZ;
    previous.connect(rumbleCut);
    previous = rumbleCut;
  }
  previous.connect(level);
  level.connect(masterVolume);
  return level;
}

function createNoiseBuffer(target) {
  const buffer = target.createBuffer(1, NOISE_SECONDS * target.sampleRate, target.sampleRate);
  const samples = buffer.getChannelData(0);
  for (let index = 0; index < samples.length; index++) samples[index] = Math.random() * 2 - 1;
  return buffer;
}

// Tiny decaying bursts at random times; cubing the loudness leaves mostly faint ticks with the odd sharper pop.
function createCrackleBuffer(target) {
  const buffer = target.createBuffer(1, NOISE_SECONDS * target.sampleRate, target.sampleRate);
  const samples = buffer.getChannelData(0);
  for (let crackle = 0; crackle < NOISE_SECONDS * CRACKLES_PER_SECOND; crackle++) {
    const start = Math.floor(Math.random() * samples.length);
    const length = Math.floor(target.sampleRate * (0.001 + Math.random() * 0.003));
    const loudness = Math.random() ** 3;
    for (let index = 0; index < length && start + index < samples.length; index++) {
      samples[start + index] += (Math.random() * 2 - 1) * loudness * (1 - index / length) ** 2;
    }
  }
  return buffer;
}

function startNoise(target, buffer, stopTime) {
  const source = target.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.start(target.currentTime, Math.random() * NOISE_SECONDS);
  source.stop(stopTime);
  return source;
}

// A band of noise whose centre slides from one frequency to another over the draw, as the lips tighten around the filter.
function sweptBand(target, source, fromHertz, toHertz, quality, startTime, endTime) {
  const band = target.createBiquadFilter();
  band.type = 'bandpass';
  band.Q.value = quality;
  band.frequency.setValueAtTime(fromHertz, startTime);
  band.frequency.exponentialRampToValueAtTime(toHertz, endTime);
  source.connect(band);
  return band;
}

// Why: synthesised rather than a recording so every drag follows its own strength and length, and no two sound identical.
// Air is drawn through one low band with its top rolled off, because any upper band reads as hiss, with faint tobacco crackle on top.
function buildInhale(target, destination, strength, durationSeconds) {
  const startTime = target.currentTime;
  const endTime = startTime + durationSeconds;
  const output = target.createGain();
  output.gain.value = INHALE_VOLUME * (0.5 + 0.5 * strength);
  output.connect(destination);

  const air = startNoise(target, airNoise, endTime + 0.1);
  const airLevel = target.createGain();
  airLevel.gain.setValueAtTime(0, startTime);
  airLevel.gain.linearRampToValueAtTime(0.65, startTime + 0.35);
  airLevel.gain.linearRampToValueAtTime(1, endTime - 0.25);
  airLevel.gain.linearRampToValueAtTime(0, endTime);
  const airSoftener = target.createBiquadFilter();
  airSoftener.type = 'lowpass';
  airSoftener.frequency.value = 1000;
  sweptBand(target, air, 300, 520, 0.7, startTime, endTime).connect(airSoftener);
  airSoftener.connect(airLevel);
  airLevel.connect(output);

  const crackle = startNoise(target, crackleNoise, endTime + CRACKLE_TAIL_SECONDS);
  const crackleFilter = target.createBiquadFilter();
  crackleFilter.type = 'bandpass';
  crackleFilter.frequency.value = 1600;
  crackleFilter.Q.value = 0.7;
  const crackleLevel = target.createGain();
  crackleLevel.gain.setValueAtTime(0, startTime);
  crackleLevel.gain.linearRampToValueAtTime(CRACKLE_LEVEL, startTime + 0.35);
  crackleLevel.gain.setValueAtTime(CRACKLE_LEVEL, endTime);
  crackleLevel.gain.linearRampToValueAtTime(0, endTime + CRACKLE_TAIL_SECONDS);
  crackle.connect(crackleFilter);
  crackleFilter.connect(crackleLevel);
  crackleLevel.connect(output);
  return output;
}

function resumeAudio() {
  if (soundEnabled) audioContext.resume();
}

function setSoundEnabled(enabled) {
  soundEnabled = enabled;
}

function setSoundVolume(percent) {
  soundVolume = percent / 100 * MAXIMUM_VOLUME;
  masterVolume.gain.value = soundVolume;
}

function startAmbience() {
  if (!soundEnabled) return;
  ambience.play();
  const now = audioContext.currentTime;
  ambienceLevel.gain.setValueAtTime(0, now);
  ambienceLevel.gain.linearRampToValueAtTime(AMBIENCE_VOLUME, now + AMBIENCE_FADE_IN_SECONDS);
}

function fadeOutAmbience(durationMs) {
  if (!soundEnabled) return;
  const now = audioContext.currentTime;
  ambienceLevel.gain.cancelAndHoldAtTime(now);
  ambienceLevel.gain.linearRampToValueAtTime(0, now + durationMs / 1000);
}

// Starts part way into the reversed whoosh so its peak lands at the right moment of a dash of any length.
function buildDashIn(target, destination, durationMs) {
  const landingSeconds = (durationMs / 1000) * DASH_IN_LANDING;
  const startTime = target.currentTime;
  const source = target.createBufferSource();
  source.buffer = dashInBuffer;
  const opening = target.createBiquadFilter();
  opening.type = 'lowpass';
  opening.frequency.setValueAtTime(DASH_IN_FAR_HERTZ, startTime);
  opening.frequency.exponentialRampToValueAtTime(DASH_IN_NEAR_HERTZ, startTime + landingSeconds);
  const level = target.createGain();
  level.gain.value = DASH_IN_VOLUME;
  source.connect(opening);
  opening.connect(level);
  level.connect(destination);
  source.start(startTime, dashInBuffer.duration - DASH_PEAK_SECONDS - landingSeconds);
}

function playDashIn(durationMs) {
  if (soundEnabled) buildDashIn(audioContext, masterVolume, durationMs);
}

function playDashOut() {
  if (!soundEnabled) return;
  dash.volume = DASH_VOLUME * soundVolume;
  dash.currentTime = DASH_START_SECONDS;
  dash.play();
}

function playLighter() {
  if (!soundEnabled) return;
  const source = audioContext.createBufferSource();
  source.buffer = lighterBuffer;
  const level = audioContext.createGain();
  level.gain.value = LIGHTER_VOLUME;
  source.connect(level);
  level.connect(masterVolume);
  source.start();
}

function playInhale(strength, durationSeconds) {
  if (soundEnabled) inhaleOutput = buildInhale(audioContext, masterVolume, strength, durationSeconds);
}

// Cuts a drag short when the cigarette is taken away mid-inhale.
function stopInhale() {
  inhaleOutput?.gain.setTargetAtTime(0, audioContext.currentTime, 0.03);
}
