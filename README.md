# School Bell System · نظام زنگ مدرسه

**Freeware** — for schools and classrooms.

A desktop program that plays your school bell automatically, at the exact times
you schedule. Set it up once, leave it running in the system tray, and it
handles the rest — offline, with no account and no telemetry.

> **Screenshot:** the image below is the **v2.1 legacy** interface, kept for
> historical reference. The v2.2 UI is a new RTL design (sidebar day list, board
> toolbar, status bar with a live next-bell countdown) and is not pictured here
> yet.

![School Bell System v2.1 (legacy UI)](wiki/main.png)

---

## Features

- **Per-day schedules** — Saturday through Friday, each day with its own list of
  time slots and as many slots as you need (up to 200 per day).
- **Inherit a day** — point a day at another day ("like Monday") so holidays and
  exam weeks can share one schedule without duplicating it.
- **11 sounds included** — Westminster chimes, classic bells and intercom tones.
- **Your own sounds** — import MP3, WAV, OGG/Opus, M4A/AAC, FLAC or WebM files.
- **Reliable timing** — the bell timer runs in the Electron main process, not in
  the page, so it keeps firing when the window is minimised, hidden in the tray
  or covered by another app. A watchdog catches sleep/wake and clock changes.
- **Next-bell readout** — always shows the next bell time, its sound and a live
  countdown, both in the window and in the tray tooltip.
- **Single instance** — launching the app twice can never produce double bells.
- **Safe saving** — settings are written atomically, with one automatic backup,
  into your user-data folder (never into the installation directory).
- **Light / dark / system theme**, adjustable preview volume, optional
  "start with Windows" — which launches minimised into the system tray, so bells
  work from the moment the PC boots without a window popping up.
- **Fully offline** — no CDN, no fonts or scripts loaded from the internet.
  A strict Content-Security-Policy is enforced in the renderer.
- **Persian (RTL) interface**, with Persian digits and keyboard shortcuts.

---

## Requirements

| | |
|---|---|
| OS | **Windows 7 SP1, 8, 8.1, 10 or 11** (64-bit; 32-bit Windows 7 SP1 also works, see below). |
| Audio | Any output device; connect the line-out to your PA / amplifier. |
| Disk | ~250 MB installed. |
| Internet | Not required at runtime. Only needed once to download the installer. |

The app is built on **Electron 22.3.27** (Chromium 108). Electron 22 is the last
release that still runs on Windows 7 / 8 / 8.1, which is why the version is
pinned there.

### Windows 7 SP1 checklist

A stock Windows 7 SP1 that has been updated through Windows Update already
satisfies all of these. On a fresh or offline install, apply them first — each
link is a Microsoft KB:

| Requirement | Why |
|---|---|
| **Service Pack 1** (KB976932) | Electron 22 requires SP1; plain Windows 7 RTM will not start. |
| **KB4474419** — SHA-2 code signing support | Without it Windows cannot verify the installer's signature and setup fails to start. |
| **KB2999226** — Universal C Runtime (UCRT) | Provides `api-ms-win-crt-*` DLLs that Chromium 108 links against. |
| **KB2533623** (or SP1 + KB3063858) | `LoadLibraryEx` / `SetDefaultDllDirectories`, used by the Electron loader. |

> 32-bit Windows 7 SP1 is supported as well: `npm run build:win` produces an
> installer containing both the 64-bit and 32-bit payloads, and the right one is
> chosen at install time. Windows XP is **not** supported by any Electron
> release — for XP, use the legacy C# build in
> [`docs/LEGACY-CSHARP.md`](docs/LEGACY-CSHARP.md).

On Windows 7 / 8 / 8.1 the app disables GPU hardware acceleration on startup
(`os.release()` is `6.1`, `6.2` or `6.3`). Those systems only ship WDDM 1.x
drivers, where Chromium's GPU process frequently fails and leaves a black or
blank window. Software rendering avoids that and costs nothing for a schedule UI.

---

## Install (end users)

1. Download the latest `SchoolBellSystem-Setup-x.y.z.exe` from the
   [Releases](https://github.com/dandelionsystem-com/School-Bell-System/releases) page.
2. Run it. Because the installer is not code-signed, Windows SmartScreen may
   warn you the first time — click **More info → Run anyway**.
3. Launch **School Bell System** from the Start menu or desktop shortcut.

Step-by-step usage (in Persian) is in [`docs/USER-GUIDE.fa.md`](docs/USER-GUIDE.fa.md).

---

## How it works

1. Install it on the school-office PC or laptop.
2. Add time slots for each day and pick a sound for each slot, then **Save**.
3. Connect the computer's audio output to the school's PA / speakers and leave
   the program running (it can live in the tray).

The main process keeps exactly one timer armed for the next bell. When it fires,
the renderer plays the audio; the countdown in the UI is display-only.

---

## Where your data lives

Everything is stored under Electron's `userData` directory:

```
%APPDATA%\School Bell System\
├── settings.json          # your schedule (JSON, schema v2)
├── settings.backup.json   # previous good copy, written on every save
├── settings.txt           # only if migrated from v2.1 or older
├── sounds\                # sounds you imported
└── school-bell.log        # diagnostics log
```

The exact path is shown in **Settings → پوشهٔ داده‌ها** and can be copied from
there. Back up that folder and you have backed up everything.

Bundled sounds ship with the app in `sound\` (read-only). If you import a file
with the same name as a bundled one, your file wins.

---

## Development

```bash
# prerequisites: Node.js 18+ and npm (Windows 10/11, Linux or macOS)
npm install          # installs Electron + electron-builder
npm start            # run the app
npm test             # run the unit tests (node --test, no Electron needed)
```

Set `BELL_DEVTOOLS=1` before `npm start` to open DevTools automatically.

### Building the installer

> **Build on Windows 10/11, Linux or macOS — not on Windows 7.** Node.js 18+ and
> electron-builder no longer run on Windows 7, but the *installer they produce*
> runs fine on Windows 7 SP1. On Linux/macOS, building a Windows target also
> needs [Wine](https://www.electron.build/multi-platform-build).

```bash
npm run build:win      # one NSIS installer, both x64 and ia32   -> dist/
npm run build:win64    # 64-bit only                           -> dist/
npm run build:win32    # 32-bit only (old Win7 SP1 machines)   -> dist/
npm run dist           # same as build:win, never publishes
```

The resulting installer is `dist/SchoolBellSystem-Setup-<version>.exe`. When
`--x64 --ia32` are passed together (the `build:win` script), electron-builder
emits **one** installer that carries both payloads and picks the right one on
the target machine, so you hand out a single file. It installs per-user by
default, lets the user pick the directory, and creates desktop and Start-menu
shortcuts. Windows 7/8/8.1 users see a SmartScreen warning because the build is
not code-signed.

The app icon is generated into `build/icon.ico` (multi-size) and
`build/icon.png`. `electron-builder` picks them up from `build/` automatically.

### Project layout

```
main.js              Electron main process: window, tray, IPC, file I/O, bell timer
preload.js           contextBridge surface (window.bellAPI) — the only IPC channel
shared/core.js       pure logic shared by main + renderer (UMD, no dependencies)
renderer/index.html  app shell + inline SVG icon sprite + modals
renderer/styles.css  hand-written RTL design system (no CSS framework)
renderer/app.js      UI logic (classic script, no bundler)
test/core.test.js    node:test unit tests for shared/core.js
build/               generated app icons
sound/               bundled bell sounds
docs/                user guide, architecture, settings format
src/SchoolBell/      legacy C# WinForms version (kept for reference, not built)
```

More detail: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) ·
[`docs/SETTINGS-FORMAT.md`](docs/SETTINGS-FORMAT.md) ·
[`CHANGELOG.md`](CHANGELOG.md)

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| No sound at all | Check the Windows output device and the volume slider in **Settings**. Test with the ▶ button on a row. |
| A row shows a red "پیدا نشد" | The sound file was deleted. Pick another sound, or re-import it. |
| Bells stop when the window is closed | They should not — closing hides to the tray. If the tray icon is missing, the app was quit; reopen it. |
| Bells are late by minutes | The PC was asleep. A bell is still played up to 60 s late; anything longer is skipped. Disable sleep on the school PC. |
| "فایل قابل خواندن نیست" when opening a schedule | The file is not a valid JSON v2 or legacy text schedule. Try `settings.backup.json`. |
| App does not start a second time | That is intentional (single-instance lock); the existing window is brought to the front. |

Logs: `%APPDATA%\School Bell System\school-bell.log`.

---

## License

Freeware. Free to use for any school or organisation.
See [LICENSE](LICENSE).

---

## Legacy version

`src/SchoolBell/` contains the original C# / WinForms 2.1 implementation
(.NET 2.0, Windows Media Player COM). It is kept for reference and for anyone
who needs to run on very old Windows, but it is **no longer maintained** and is
not part of the build. See [`docs/LEGACY-CSHARP.md`](docs/LEGACY-CSHARP.md).

---

*Provided by [Dandelion System](https://dandelionsystem.com)*
*Tawau, Sabah, Malaysia*
