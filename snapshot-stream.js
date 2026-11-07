// Desktop capture where the native macOS helper isn't available, such as Windows: one snapshot per break, taken before the window shows.
// The distant screen stays still and other apps' sound is left alone; the interface matches desktop-stream.js so the rest of the app doesn't care.
const { desktopCapturer, screen } = require('electron');

function createDesktopStream(onFrame) {
  return {
    prepare: () => {},
    begin: async (displayId) => {
      const display = screen.getAllDisplays().find((candidate) => candidate.id === displayId);
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: Math.round(display.bounds.width * display.scaleFactor),
          height: Math.round(display.bounds.height * display.scaleFactor),
        },
      });
      const { thumbnail } = sources.find((source) => source.display_id === String(displayId)) ?? sources[0];
      const { width, height } = thumbnail.getSize();
      onFrame({ kind: 'snapshot', width, height, pixels: thumbnail.toBitmap() });
    },
    setAudioDistance: () => {},
    requestStill: () => {},
    end: () => {},
  };
}

module.exports = { createDesktopStream };
