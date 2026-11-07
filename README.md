# Smoke Break

A smoke break for your desktop, without the smoke. Click the icon in your menu bar and the camera dashes back from your screen while a first-person cigarette burns down to the filter. When it's done, you dash back to work.

Created by Jordan (aka [DreadJordan](https://x.com/dreadjordan)).

## Features

- Live-action cigarette with a real burn, ash that crumbles and falls, and smoke
- Your desktop stays live on the distant screen, so a playing video keeps playing (macOS)
- Other apps sound far away while you're stepped back (macOS)
- Automatic breaks every 15, 30 or 60 minutes
- A global hotkey: `Control+Option+Command+S` by default (`Ctrl+Alt+Win+S` on Windows)
- Break lengths from 30 seconds to 5 minutes
- An experimental landscape background

Press any key during a break to end it early. Right-click the icon for settings.

## Requirements

| | macOS | Windows |
|---|---|---|
| Version | 14.2 or later, Apple silicon | 10 or later, 64-bit |
| Live desktop | Yes | No, a still snapshot |
| Distant audio | Yes | No |

## Installing

Download the installer from the releases page.

**macOS:** open the `.dmg` and drag Smoke Break to Applications. The app isn't notarized, so macOS blocks the first launch. Try to open it once, then go to System Settings > Privacy & Security and choose Open Anyway.

The first break asks for Screen Recording permission, which the live desktop needs. Audio capture permission makes other apps sound distant. After granting them, quit and reopen the app.

**Windows:** run the installer. It isn't code signed, so SmartScreen may warn you. Choose More info, then Run anyway. The Windows version is new and has had little real-world testing, so please report any problems.

## Building

You need Node.js. Building the macOS helper also needs Xcode's command line tools.

```sh
npm install
npm start          # run from source
npm run dist:mac   # build the .dmg
npm run dist:win   # build the Windows installer
```

## Project layout

- `main.js`: menu bar icon, settings, hotkey and break lifecycle
- `desktop-stream.js`, `native/`: macOS capture and distant audio, through a small Swift helper
- `snapshot-stream.js`: desktop capture on other platforms
- `src/`: the break itself, drawn on canvases
- `tools/`: scripts that made the icons and keyed the footage; the footage tool needs the original camera files, which aren't in this repository

## License

The code is under the [MIT License](LICENSE).
