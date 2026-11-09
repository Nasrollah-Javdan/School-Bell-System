# Changelog

All notable changes to School Bell System.
This project follows [Semantic Versioning](https://semver.org/).

---

## [2.2.0] — 2026

A full rewrite of the Electron application. The v2.1 C#/WinForms code is retired
to `src/` (see [`docs/LEGACY-CSHARP.md`](docs/LEGACY-CSHARP.md)).

### Windows 7 / 8 / 8.1 support

- **Electron pinned to `22.3.27`.** Electron 22 is the last release line that
  runs on Windows 7 SP1 / 8 / 8.1 (Chromium 108, Node 16). Electron 23+ requires
  Windows 10.
- **Replaced `protocol.handle()` + `net.fetch()` with
  `protocol.registerFileProtocol()`.** The former only exist in Electron 25+.
  The `bellsound://` scheme is still registered as privileged (`standard`,
  `secure`, `supportFetchAPI`, `stream`), so `<audio>` seeking and the CSP
  `media-src bellsound:` rule keep working.
- **Software rendering on legacy Windows.** On kernel `6.1` / `6.2` / `6.3`
  (Windows 7 / 8 / 8.1) the app calls `app.disableHardwareAcceleration()` before
  `ready`, because those systems ship WDDM 1.x drivers where Chromium's GPU
  process often fails and leaves a black window.
- **No post-Chromium-108 JavaScript or CSS.** Audited `main.js`, `preload.js`,
  `shared/core.js`, `renderer/app.js` and `renderer/styles.css`; no
  `structuredClone`, `Array.prototype.at`, `Object.hasOwn`,
  logical-assignment operators, `color-mix()`, `:has()` or `@container`.
- **32-bit installer.** `npm run build:win` now builds the `nsis` target for
  both `x64` and `ia32`, producing a **single** installer
  (`SchoolBellSystem-Setup-<version>.exe`) whose payload is chosen at install
  time — 32-bit Windows 7 SP1 machines are covered without a separate download.
  `build:win64` / `build:win32` build one architecture only.
- **README requirements rewritten**: Windows 7 SP1 + KB4474419 (SHA-2),
  KB2999226 (UCRT) and KB2533623 are listed explicitly, and the XP note points
  at the legacy C# build.

### Added

- **Per-day inheritance.** Any day can be set to "like day *n*", so holidays and
  exam weeks share one schedule instead of duplicating it. Cycle-safe.
- **System tray.** Closing the window hides to the tray instead of quitting, so
  bells keep firing. Tray tooltip shows the next bell; the tray menu offers
  show / open / settings / quit.
- **Main-process scheduler** with a single armed timer, a `playedKeys` dedupe set,
  a 60-second grace window (bells survive a short sleep) and a 20-second watchdog
  that recovers from sleep/wake and wall-clock changes.
- **Next-bell readout** with a live countdown in the status bar and in the tray.
- **Single-instance lock** — a second launch focuses the existing window.
- **Start with Windows** (optional, off by default).
- **Custom `bellsound://` protocol** for audio, fixing playback of file names
  containing spaces or non-ASCII characters.
- **Sound management UI**: import (multi-select), delete user sounds, reveal the
  sounds folder, search box, and per-row browse button.
- **More audio formats**: `mp3`, `wav`, `ogg`, `oga`, `opus`, `m4a`, `aac`,
  `flac`, `weba`, `webm` (was: mp3/wav only).
- **Duplicate-time detection** with a warning chip and highlighted rows.
- **Automatic sorting** of slots by time after every edit.
- **Volume control** (0–100 %) applied to both preview and bells, with a live
  percentage readout.
- **Light / dark / system theme**, persisted across restarts.
- **In-app modal dialogs** (confirm, message) replacing native `alert`/`confirm`.
- **Focus-trapped modals** with Esc-to-close and `role="alertdialog"` for confirms.
- **Keyboard shortcuts**: `Ctrl+S` save, `Ctrl+Shift+S` save-as, `Ctrl+O` open,
  `Ctrl+N` add slot, `Ctrl+F` sound picker, `Ctrl+W` hide to tray, `Ctrl+Q` quit,
  `Esc` close modal.
- **Persian UI throughout**, RTL layout, Persian digits, Vazirmatn/Segoe UI font
  stack.
- **Accessibility**: ARIA roles/labels, `aria-live` status messages, visible focus
  rings, `prefers-reduced-motion` support, print stylesheet.
- **Unit tests** (`node --test`, 24 cases) for all pure scheduling and
  serialisation logic.
- **Documentation**: rewritten README, Persian user guide, architecture notes,
  settings-format reference, legacy-C# notes, this changelog.
- **Proper application icon** (`build/icon.ico`, multi-size 16→256 px, plus PNG).
- **Diagnostics log** at `userData/school-bell.log`.

### Changed

- **Settings storage moved** from the installation directory to
  `app.getPath("userData")`, with **atomic writes** and an automatic
  `settings.backup.json`. Writing next to the executable caused `EPERM` under
  `Program Files`.
- **Settings format is now JSON v2** (`{schemaVersion, app, days, ui}`), with
  automatic one-way migration from the legacy `settings.txt`. The old file is
  never deleted.
- **All seven days are editable and schedulable.** Thursday and Friday are flagged
  as weekend but no longer hidden (v2.1 hid them in the UI while still playing
  their bells).
- **Weekday mapping corrected.** The Persian week now starts on Saturday
  (`1 = شنبه` … `7 = جمعه`); v2.1 was off by two days.
- **Bootstrap removed.** The UI is hand-written CSS with inline SVG icons — no
  CDN, no network access, no build step for the renderer.
- **Strict Content-Security-Policy** in the renderer:
  `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:;
  media-src bellsound:; font-src 'self'; connect-src 'self'; form-action 'none';
  base-uri 'none'`.
- **Renderer hardened**: `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`, no popups, external links restricted to `http(s)`.
- **IPC surface is explicit** — 20 named methods on `window.bellAPI` instead of a
  generic `invoke(channel, …)`, with argument validation on every handler.
- **Version is now valid semver** (`2.2.0`; `"2.1"` was not).
- **Build config fixed**: correct icon path, `src/` excluded from the package,
  NSIS installer with directory selection and desktop/start-menu shortcuts.
- **README corrected**: the false Windows XP claim is gone, and the real OS
  floor (Windows 7 SP1 with the SHA-2 and UCRT updates) plus development/build
  instructions are documented.

### Fixed

- `el.dgv` was undefined, throwing a `TypeError` on every render.
- The sound picker crashed on double-click (`bt-select.onclick = null` followed by
  `btn.onclick()`).
- Audio failed for file names containing spaces (`"file://" + dir` was unencoded).
- The scheduler re-armed itself every second at `seconds === 0`, cancelling
  imminent timers; it also had no sleep/wake catch-up and a stale
  `targetSlotIndex`.
- `SelectDay` used `selectedIndex = t` with options 6 and 7 skipped, producing an
  out-of-range selection.
- Invalid time input silently became `00:00`; such slots are now rejected.
- Running the app twice played every bell twice.
- Closing the window quit the app and stopped all bells.
- "Start with Windows" registered a login item **without** the `--hidden`
  argument, so Windows opened the full window on every boot instead of starting
  minimised in the tray. The login item is now written with `--hidden` (packaged
  builds only), `process.argv` is checked at startup, and existing entries are
  re-applied once so older installations heal themselves.
- Theme and volume were not persisted.
- Modal promises were left pending when closed with Esc or the backdrop.
- `.btn-danger` was styled identically to the primary button.
- `body { overflow: hidden }` clipped content with no way to scroll.
- Removed dead code: `loadSettingsFile`, `saveSettingsAs`, `BuildSettingsText`,
  `pathJoin`, `folder`, the unused `dialog` import, and the never-shown
  `aboutDialog`.

### Removed

- Bootstrap 5.3.2 and Bootstrap Icons 1.11.1 CDN dependencies.
- The `NON_WORKING_DAYS` day-hiding behaviour.
- The legacy C# project from the build (`src/` is reference-only).
- The `beforeunload` unsaved-changes handler, which does nothing in Electron.

### Known limitations

- Bells are not played if the computer is **off** at the scheduled time.
- If the computer is **asleep**, a bell is played up to 60 seconds late; later
  than that it is skipped.
- The Windows installer is not code-signed, so SmartScreen may warn on first run.
- Visual/runtime verification of the UI was not possible in the build environment
  (no npm/Electron available); logic is covered by unit tests and static
  cross-checks between `index.html`, `app.js` and `preload.js`.

---

## [2.1] — legacy

Final C#/WinForms release. See [`docs/LEGACY-CSHARP.md`](docs/LEGACY-CSHARP.md)
for its known defects. Superseded by 2.2.0.
