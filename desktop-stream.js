// macOS desktop capture: keeps the native helper running for the main process: tells it when breaks begin and end, passes it the viewer's distance,
// and reassembles the frames it writes to stdout. Live frames and the snapshot are raw pixels; the still is a full-resolution JPEG.
const { spawn } = require('node:child_process');
const path = require('node:path');

const HELPER_PATH = path.join(__dirname, 'native', 'desktop-stream');
const HEADER_BYTES = 16;
const FRAME_KINDS = ['live', 'still', 'snapshot'];

function createDesktopStream(onFrame, onExit) {
  let helper = null;

  function launch() {
    const helperProcess = spawn(HELPER_PATH, [String(process.pid)], { stdio: ['pipe', 'pipe', 'inherit'] });
    // Why: the app outlives the helper, so a write landing just as it exits must not take the whole app down.
    helperProcess.stdin.on('error', () => {});
    helperProcess.on('exit', () => {
      if (helper === helperProcess) helper = null;
      onExit();
    });
    const header = Buffer.alloc(HEADER_BYTES);
    // Why: reused between frames, because a fresh 1MB buffer 30 times a second kept the garbage collector busy; sending copies it straight away.
    let pixels = Buffer.alloc(0);
    let headerFilled = 0;
    let pixelsFilled = 0;
    let readingPixels = false;

    helperProcess.stdout.on('data', (chunk) => {
      let offset = 0;
      while (offset < chunk.length) {
        if (!readingPixels) {
          const copied = chunk.copy(header, headerFilled, offset);
          headerFilled += copied;
          offset += copied;
          if (headerFilled < HEADER_BYTES) return;
          const byteCount = header.readUInt32LE(12);
          if (pixels.length !== byteCount) pixels = Buffer.allocUnsafeSlow(byteCount);
          pixelsFilled = 0;
          readingPixels = true;
        }
        const copied = chunk.copy(pixels, pixelsFilled, offset);
        pixelsFilled += copied;
        offset += copied;
        if (pixelsFilled === pixels.length) {
          onFrame({ kind: FRAME_KINDS[header.readUInt32LE(0)], width: header.readUInt32LE(4), height: header.readUInt32LE(8), pixels });
          readingPixels = false;
          headerFilled = 0;
        }
      }
    });
    helper = helperProcess;
  }

  const send = (line) => helper?.stdin.write(`${line}\n`);

  return {
    // Starts the helper if it isn't running, so a break finds it already warm.
    prepare: () => {
      if (!helper) launch();
    },
    begin: (displayId, appProcessIds, { sound, live }) => {
      if (!helper) launch();
      send(`begin ${displayId} ${appProcessIds.join(',')} ${sound ? 'sound' : 'silent'} ${live ? 'live' : 'still'}`);
    },
    setAudioDistance: (distance) => send(`distance ${distance.toFixed(3)}`),
    requestStill: () => send('still'),
    end: () => send('end'),
  };
}

module.exports = { createDesktopStream };
