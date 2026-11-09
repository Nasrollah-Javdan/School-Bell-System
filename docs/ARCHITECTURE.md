# Architecture

School Bell System is an Electron 22 application. It was rewritten in v2.2 from
a single-file C#/WinForms prototype into a small, layered Electron app.

Electron 22.3.27 (Chromium 108, Node 16) is pinned deliberately: it is the last
Electron release that still runs on Windows 7 / 8 / 8.1, and the code is written
to that floor. Two consequences are baked in:

- The main process uses the legacy `protocol.registerFileProtocol()` API, not
  `protocol.handle()` / `net.fetch()`, which only exist from Electron 25.
- No JavaScript or CSS newer than Chromium 108 is used (no `color-mix()`,
  no logical-assignment operators, no `structuredClone`).

On Windows 7/8/8.1 (`os.release()` = `6.1`/`6.2`/`6.3`) the app calls
`app.disableHardwareAcceleration()` before `ready` — those systems only have
WDDM 1.x GPU drivers where Chromium's GPU process often fails and paints a blank
window.

```
┌──────────────────────────────────────────────────────────────┐
│ main process (main.js)                                       │
│  • window + tray + menu lifecycle                            │
│  • file I/O: settings.json / backup / sounds / log           │
│  • bell scheduler: one armed timer + watchdog                │
│  • bellsound:// custom protocol                              │
│  • ipcMain.handle(...) — the whole trust boundary            │
└───────────────▲──────────────────────────┬───────────────────┘
                │ ipcRenderer.invoke       │ webContents.send
                │ (request/response)       │ (bell:play, schedule:next, …)
┌───────────────┴──────────────────────────▼───────────────────┐
│ preload.js — contextBridge                                   │
│  window.bellAPI = { getInfo, loadState, …, onPlayBell, … }    │
│  No Node objects ever cross into the page.                   │
└───────────────▲──────────────────────────┬───────────────────┘
                │                          │
┌───────────────┴──────────────────────────▼───────────────────┐
│ renderer (index.html + styles.css + app.js)                  │
│  contextIsolation: true · nodeIntegration: false · sandbox   │
│  CSP: default-src 'none'; script-src 'self'; …               │
│  Plays audio, renders UI, owns no timers that matter         │
└──────────────────────────────────────────────────────────────┘
                 ▲
                 │ require()
        ┌────────┴─────────┐
        │ shared/core.js   │  pure functions, UMD, zero deps
        └────────┬─────────┘
                 │ require()
              test/core.test.js  (node --test)
```

## 1. `shared/core.js` — pure logic, three consumers

A dependency-free UMD module. It is `require`d by `main.js`, loaded as a classic
`<script>` by the renderer (exposing `window.BellCore`), and exercised directly
by the unit tests. Because it is pure, it is the only part of the app that can be
tested without Electron — and it holds every rule that matters:

| Concern | Functions |
|---|---|
| Week / days | `dayIndexFromDow`, `dayIndexFromDate`, `dayName`, `isWeekend`, `emptyDays` |
| Time | `parseTime`, `formatTime`, `slotTime`, `minutesOfDay` |
| Normalisation | `normalizeDays`, `normalizeDayType`, `normalizeUi`, `sortSlots`, `sortDays` |
| Validation | `isSafeSoundName`, `SOUND_EXT_RE`, `findDuplicateTimes` |
| Scheduling | `resolveDay`, `findNextBell`, `findBellsBetween` |
| Persistence | `parseSettingsPayload`, `buildSettings`, `parseLegacyText`, `parseLegacyUi`, `serializeLegacyText` |

Key invariant: **the Persian week starts on Saturday.** `dayIndexFromDow(dow)`
maps JavaScript's `getDay()` (0 = Sunday) onto `1..7` where `1 = شنبه` and
`7 = جمعه`:

```js
dayIndexFromDow(dow) = ((dow + 1) % 7) + 1
```

`resolveDay(days, i)` returns the *effective* slots for a day, following
`type` references ("this day is like day 3") and breaking cycles. Every consumer
— the table, the next-bell readout and the scheduler — goes through it, so
inherited days behave identically everywhere.

## 2. Main process (`main.js`)

### Lifecycle
`app.requestSingleInstanceLock()` runs before anything else; a second launch
focuses the existing window instead of starting a second scheduler (the original
bug that produced double bells). `before-quit` clears the bell timer, the
watchdog and the power-save blocker.

Closing the window hides it to the tray rather than destroying it: the window is
the audio host, so it must survive. `window-all-closed` recreates it hidden if
it ever disappears. Quitting is only possible through the tray menu, the File
menu or `Ctrl+Q` — and if the schedule is dirty, a modal confirmation runs
first.

### Autostart (start with Windows)
`app.setLoginItemSettings()` writes the registry entry. In **packaged** builds it
is written with `args: ["--hidden"]` and `path: process.execPath`; in dev the
argv is `electron.exe <appPath>`, so extra arguments are deliberately omitted.
At startup `process.argv.includes("--hidden")` decides whether the first window
is created with `createWindow({ hidden: true })` — that is what makes a login
launch land in the tray instead of popping a window in the user's face. A tray
icon is created immediately in that case, and `syncLoginItem()` re-applies the
entry once at boot so login items written by earlier builds (which lacked
`--hidden`) start healing themselves. `app:info` exposes both `openAtLogin` and
`startHidden` so the renderer can reflect the real state.

### Paths
All mutable state lives under `app.getPath("userData")` — never in the install
directory, which is read-only inside an asar archive:

```
userData/settings.json          current schedule
userData/settings.backup.json   previous good copy
userData/settings.txt           legacy file, only when migrated
userData/sounds/                imported sounds
<appRoot>/sound/                bundled sounds (read-only)
userData/school-bell.log        diagnostics
```

`writeFileAtomic(target, data)` writes a temp file in the same directory,
`fsync`s it, then `rename`s over the target — a crash mid-write can never leave a
truncated schedule. `readTextFile(file, maxBytes)` refuses non-files and anything
over `MAX_SETTINGS_BYTES` (2 MB).

### Scheduler
The bell timer lives here, not in the renderer, because Chromium throttles timers
in hidden/occluded windows — unacceptable for an app whose whole job is punctual
audio.

- `setSchedule(days, ui)` normalises input, clears the `playedKeys` dedupe set and
  calls `reschedule()`.
- `reschedule()` asks `core.findNextBell()` for the next entry and arms a single
  `setTimeout` for it. One timer, always the soonest bell.
- `fireDueBells()` runs on fire, plays everything due within `BELL_GRACE_MS`
  (60 s, so a bell survives a short sleep), marks each with `bellKey()` in
  `playedKeys` so it can never fire twice, then reschedules.
- `playBell(entry)` sends `bell:play` with `{soundfile, volume, at}` to the
  renderer, recreating a hidden window if it was destroyed, and emits
  `bell:played` for the toast/status line.
- `startWatchdog()` ticks every 20 s and covers what a `setTimeout` cannot: system
  sleep/wake, wall-clock jumps (drift > 25 h forces a reschedule), and timers that
  overflow. It also re-broadcasts `schedule:next` so the countdown stays honest.
- A `powerSaveBlocker` of type `prevent-app-suspension` is held while a bell is
  armed, so the OS does not suspend the app itself.

The renderer's countdown is **display-only**. It re-renders from `schedule:next`
and ticks locally once a second; it never decides that a bell is due.

### `bellsound://` protocol
Sounds are served through a privileged custom scheme rather than `file://`:

```js
// Electron 22: protocol.handle()/net.fetch() do not exist yet (Electron 25+).
protocol.registerFileProtocol("bellsound", (request, callback) => {
  // host must be "sound"; path is the decoded file name
  // core.isSafeSoundName() rejects traversal, separators, control chars
  // resolveSoundPath(): userData/sounds first, then bundled sound/
  callback({ path: file });      // Electron streams it from disk, with ranges
});
```

The scheme is registered as privileged (`standard`, `secure`, `supportFetchAPI`,
`stream`) so `<audio>` can seek and `media-src bellsound:` is honoured by CSP.

This avoids percent-encoding bugs with spaces and non-ASCII file names (a real
bug in v2.1, which did `"file://" + dir + name`), and gives the renderer a single
origin it can whitelist in CSP (`media-src bellsound:`).

### Security model
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- The renderer has no `require`, no `process`, no `fs`. Its entire capability set
  is the explicit `window.bellAPI` object.
- Every IPC handler validates its arguments: sound names pass
  `core.isSafeSoundName()` before touching the filesystem, settings payloads pass
  `core.normalizeDays()` / `normalizeUi()`, and sizes are capped.
- `setWindowOpenHandler` denies all popups; external links go through
  `app:open-external`, which only accepts `http(s)`.
- CSP in `index.html`: `default-src 'none'; script-src 'self'; style-src 'self';
  img-src 'self' data:; media-src bellsound:; font-src 'self'; connect-src 'self';
  form-action 'none'; base-uri 'none'`. No CDN, no inline script, no `eval`.

## 3. `preload.js`

A thin, explicit bridge. It exposes exactly 20 methods and three event
subscriptions; nothing generic like `invoke(channel, …)` is exposed, so the page
cannot reach arbitrary IPC channels.

```js
window.bellAPI = {
  getInfo, loadState, saveSettings, openSettingsFile, saveSettingsAs,
  listSounds, importSounds, deleteSound, soundUrl, revealSound,
  setDirty, setOpenAtLogin, openExternal, hideWindow, quit, showMessage,
  onMenuAction, onPlayBell, onBellPlayed, onNextBell,
};
```

Each `on*` returns an unsubscribe function so listeners cannot leak across
re-renders.

## 4. Renderer (`renderer/`)

- **`index.html`** — app shell, a `<symbol>` sprite of inline SVG icons, five
  modals (`sound`, `settings`, `help`, `about`, `confirm`), and two classic
  `<script>` tags (`../shared/core.js`, then `app.js`). Classic scripts, not ES
  modules: `file://` refuses module scripts, and there is no bundler.
- **`styles.css`** — a hand-written RTL design system built on CSS custom
  properties (`--bg`, `--brand`, `--danger`, …) with a `[data-theme="dark"]`
  override block. No Bootstrap, no CDN, no build step.
- **`app.js`** — an IIFE with `"use strict"`. Responsibilities: render the day
  list/table/chips/status, mutate the schedule, save/open, the sound picker,
  settings, modals with a focus trap, keyboard shortcuts, and audio playback.

### Modal pattern
Modals are `<div class="modal" hidden>` elements. `openModal()` records the
previously focused element, traps Tab inside the card, and `closeModal()` always
settles any pending promise — whether the user pressed OK, Esc, the ✕ button or
the backdrop. (v2.1 left promises dangling on Esc, which hung the sound picker.)

### Audio
`playSound(name)` resolves a URL via `bellAPI.soundUrl(name)`, caches it, sets
`audio.volume` from `ui.volume`, and calls `play()`. `stopAudio()` aborts the
current preview. A single `<audio>` element is reused, so a new bell implicitly
stops the previous one.

## 5. Data flow

**Save**
```
UI mutation → state.days → markDirty() → statusbar "ذخیره‌نشده"
Ctrl+S → payload() → bellAPI.saveSettings({days, ui})
  → main: normalize → writeFileAtomic(settings.json) + backup
  → {ok:true, file, savedAt} → statusbar shows the path
```

**Bell fires**
```
main: bellTimer → fireDueBells() → playBell(entry)
  → webContents.send("bell:play", {soundfile, volume, at})
  → renderer: playSound() + clickable toast
  → webContents.send("bell:played", {dayIndex, time, soundfile})
```

**Open a file**
```
Ctrl+O → dialog.showOpenDialog → parseSettingsPayload()
  → {days, ui, legacy} → setSchedule() in main + full re-render
```

## 6. Testing

`test/core.test.js` uses `node:test` and covers the pure layer: weekday mapping,
time parsing/formatting, stable sorting, duplicate detection, day-type
resolution (including cycles), `findNextBell` wrapping across the week,
`findBellsBetween`, normalisation of malformed input, the JSON and legacy
parsers, and sound-name safety.

```bash
npm test        # node --test  → 24 tests
```

There is no Electron runtime in CI, so UI behaviour is verified by asserting that
every element ID referenced from `app.js` exists in `index.html`, that every
`bellAPI.*` call exists in `preload.js`, and that every `ipcRenderer.invoke`
channel has a matching `ipcMain.handle`.

## 7. Deliberate non-goals

- **No bundler / no TypeScript.** The app must run from source with
  `npm start` and ship without a build step for the renderer.
- **No network.** No auto-update, no telemetry, no remote fonts.
- **No database.** One JSON file is the whole state; it is human-readable and
  diffable.
- **No renderer-side scheduling.** See above — timers belong in the main process.
