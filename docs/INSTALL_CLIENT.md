# Client Install — the Hearth desktop app

Two ways to run it: straight from source (fastest for a technical crew), or
packaged installers built with electron-builder.

## Option A — run from source (all OSes)

Prereq: Node.js 22+.

```bash
cd client
npm install
npm start          # bundles the renderer, launches Electron
```

First launch asks for microphone (and later camera / screen) permission —
that's the OS, not Hearth.

## Option B — build installers

electron-builder builds **for the OS you're on** (cross-building is
unreliable; build on each platform or in CI):

```bash
cd client
npm install
npm run dist:linux    # → release/Hearth-0.1.0.AppImage + .deb
npm run dist:win      # → release/Hearth Setup 0.1.0.exe   (run on Windows)
npm run dist:mac      # → release/Hearth-0.1.0.dmg         (run on macOS)
```

Then just send friends the file for their OS.

Platform notes:

- **Linux:** AppImage needs `chmod +x` then run. The app enables the
  PipeWire portal for screen share, so Wayland (KDE/GNOME) works — the
  system's own picker appears when you start a share.
- **Windows:** unsigned installer, so SmartScreen will interject once —
  "More info → Run anyway."
- **macOS:** unsigned, so first launch is right-click → Open. System audio
  capture isn't available on macOS (OS limitation) — see below.

## Feature availability by platform

| Feature | Linux | Windows | macOS |
|---|---|---|---|
| Voice / camera / screen video | ✅ | ✅ | ✅ |
| Screen share **with system audio** | ➖ (see tip) | ✅ (loopback) | ➖ |
| Global push-to-talk (works while gaming) | ✅ | ✅ | ✅ (grant Accessibility + Input Monitoring when macOS asks) |
| Output-device selection | ✅ | ✅ | ✅ |

Linux system-audio tip: create a PipeWire/PulseAudio loopback (e.g. route
app audio into a virtual source with `pw-loopback` or Helvum) and pick that
virtual source as your **microphone** in Music mode — stereo, no
processing. Native loopback capture is on the roadmap.

## Where settings live

Everything (server address, devices, presets, PTT bind) persists locally in
the app's profile. Nothing is stored server-side except your latest
speed-test report (name + numbers, in memory only).
