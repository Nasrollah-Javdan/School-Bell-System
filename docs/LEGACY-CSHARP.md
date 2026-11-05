# Legacy C# version (v2.1 and earlier)

`src/SchoolBell/` is the original implementation of School Bell System: a C#
Windows Forms application targeting **.NET Framework 2.0**, playing audio through
the **Windows Media Player COM control** (`AxWMPLib`).

It is kept in the repository for reference and for anyone who genuinely needs to
run on Windows XP/7. It is **not built, not packaged, and not maintained**.

---

## Status

| | |
|---|---|
| Version | 2.1 (`Program.version = "2.1"`, dated 13/10/2026 in `AssemblyInfo.cs`) |
| Runtime | .NET Framework 2.0, WinForms |
| Audio | Windows Media Player COM (`AxWMPLib.AxWindowsMediaPlayer`) |
| Build | Visual Studio (any version that still supports .NET 2.0 tooling) |
| Maintained | **No** |
| Shipped in the installer | **No** — `package.json` `build.files` excludes `src/` |

---

## Why it was replaced

The v2.1 code had defects that could not be fixed without restructuring it. The
rewrite in v2.2 addresses each of these:

| # | Problem in v2.1 | Where it was | Fixed in v2.2 by |
|---|---|---|---|
| 1 | `el.dgv` was undefined, so every render threw a `TypeError` and left `suppressGridEvents = true`, freezing the grid. | `frmMain2.cs` | `renderer/app.js` renders from `state` with no such flag. |
| 2 | Weekday mapping was off by two: the C# `dayNames` array is Monday-first but the UI labels start at شنبه, so schedules played on the wrong day. | `Program.cs`, `frmMain2.cs` | `core.dayIndexFromDow()` — one tested mapping, `1 = شنبه`. |
| 3 | The sound dialog crashed on double-click: `bt-select.onclick = null` was assigned, then `btn.onclick()` was invoked. | `frmSoundList.cs` | Promise-based `pickSound()`; every close path settles the promise. |
| 4 | Settings were written next to the executable (`__dirname`), causing `EPERM` under `Program Files` and inside an asar archive. | `frmMain2.cs` | All state moved to `app.getPath("userData")`. |
| 5 | Sound playback built `"file://" + dir + name` without encoding, so any file name with a space or non-ASCII character failed silently. | `frmMain2.cs` | `bellsound://` protocol + `net.fetch(pathToFileURL(...))`. |
| 6 | `ScheduleNextBell()` re-ran every second when `seconds === 0`, cancelling an imminent timer; there was no catch-up after sleep and `targetSlotIndex` could go stale. | `frmMain2.cs` | Main-process scheduler with a single armed timer, `playedKeys` dedupe, 60 s grace and a 20 s watchdog. |
| 7 | `NON_WORKING_DAYS = {6, 7}` hid Thursday/Friday in the UI while the scheduler still played their bells. | `frmMain2.cs` | All seven days are shown and scheduled; weekend days are flagged, not hidden. |
| 8 | `SelectDay` used `selectedIndex = t` while options 6 and 7 were skipped, producing an out-of-range selection. | `frmMain2.cs` | Explicit option values (`"custom"`, `"1"`…`"7"`), never index arithmetic. |
| 9 | Invalid time input silently became `00:00`; no duplicate detection, no sorting. | `frmMain2.cs` | `parseTime()` returns `null` and the slot is dropped; `findDuplicateTimes()` warns; `sortSlots()` sorts stably. |
| 10 | No single-instance lock — running the app twice played every bell twice. | `Program.cs` | `app.requestSingleInstanceLock()`. |
| 11 | No tray icon, no minimise-to-tray, no autostart; closing the window quit the app and killed all bells. | `frmMain2.cs` | Tray icon with next-bell tooltip, close-to-tray, optional start-at-login. |
| 12 | Dead code: `loadSettingsFile`, `saveSettingsAs` and `BuildSettingsText` were never wired up; `pathJoin`, `folder` and the `dialog` import were unused; `aboutDialog` was never shown. | multiple | Removed; every menu item and button in v2.2 is wired. |
| 13 | The renderer loaded Bootstrap 5.3.2 and Bootstrap Icons from jsDelivr, so the UI broke without internet and had no CSP. | `index.html` | Hand-written CSS, inline SVG sprite, strict CSP, zero network requests. |
| 14 | No input validation on IPC, no path sanitisation on sound import/delete, no CSP. | `main.js`, `preload.js` | `isSafeSoundName()`, size caps, explicit `contextBridge` surface, `sandbox: true`. |
| 15 | Build config referenced a non-existent icon (`src/ico_32x32.ico`), excluded `src/` from `files`, and used the invalid semver `"2.1"`. | `package.json` | `build/icon.ico` (multi-size), version `2.2.0`, correct `files` list. |
| 16 | README claimed Windows XP support, had no development/build/architecture/settings documentation, and contained the typo "دندlion". | `README.md` | Rewritten: accurate requirements, full docs set, corrected branding. |
| 17 | UI/UX: `.btn-danger` used the same purple as the primary button; `body { overflow: hidden }` clipped content; no focus trap or Esc handling; no `aria-*` attributes; theme was not persisted; native `confirm()`/`alert()`; no volume control or stop button; `beforeunload` does nothing in Electron. | `index.html`, `frmMain2.cs` | RTL design system, focus-trapped modals, 17+ ARIA attributes, persisted theme/volume, in-app confirm dialog, stop button, close-to-tray instead of `beforeunload`. |

---

## Building the legacy version (if you must)

1. Open `src/SchoolBell/SchoolBell.csproj` in Visual Studio.
2. Ensure the **.NET Framework 2.0** targeting pack is installed (it is not
   included with modern Visual Studio; you may need an older VS or the standalone
   targeting pack).
3. Build. The Windows Media Player COM reference must resolve — on 64-bit Windows
   you may need to set the platform target to **x86**.
4. Copy the `sound/` folder next to the produced `.exe`.

This is unsupported. Expect to fight the toolchain.

---

## File map

| File | Purpose |
|---|---|
| `Program.cs` | Entry point, version constants, `dayNames` (Monday-first — the source of bug #2). |
| `frmMain2.cs` | Main window: schedule grid, scheduler loop, load/save, `BuildSettingsText()`. |
| `frmSoundList.cs` | Sound picker dialog (bug #3). |
| `frmAbout.cs` | About box (never shown — bug #12). |
| `AssemblyInfo.cs` | Assembly metadata, version `2.1`. |
| `ico_32x32.ico` | 32×32 icon, used as a fallback app icon by v2.2 on Windows. |
| `sound/` | A duplicate copy of the 11 bundled sounds. |

The canonical sounds live in the repository-root `sound/` folder; `src/SchoolBell/sound/`
is a leftover copy from the original project layout.

---

## Interoperability

The legacy **text** settings format is still fully supported — see
[`SETTINGS-FORMAT.md`](SETTINGS-FORMAT.md). v2.2 can open a v2.1 `.txt` schedule
and can export one via **ذخیره به نام**, so data is not trapped in either
version.
