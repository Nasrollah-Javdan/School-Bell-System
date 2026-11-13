# Settings file format

Two formats exist. The app **reads both**, and writes the modern JSON format.

| Format | Written by | Read by |
|---|---|---|
| JSON v2 (`settings.json`) | v2.2 and later | v2.2+ |
| Legacy text (`settings.txt`, `.txt` exports) | v2.1 and earlier (C#) | v2.1+ and v2.2+ |

---

## 1. JSON v2 — `settings.json`

Stored at `%APPDATA%\School Bell System\settings.json`.

```json
{
  "schemaVersion": 2,
  "app": "school-bell-system",
  "days": {
    "1": {
      "type": "custom",
      "slots": [
        { "hour": 7, "minute": 30, "soundfile": "westminster-1.mp3" },
        { "hour": 12, "minute": 0, "soundfile": "music-meander.mp3" }
      ]
    },
    "2": { "type": "1", "slots": [] },
    "3": { "type": "custom", "slots": [] },
    "4": { "type": "custom", "slots": [] },
    "5": { "type": "custom", "slots": [] },
    "6": { "type": "custom", "slots": [] },
    "7": { "type": "custom", "slots": [] }
  },
  "ui": {
    "theme": "system",
    "volume": 0.9,
    "lastDay": 1,
    "music": { "enabled": false, "shuffle": true, "files": [] }
  }
}
```

### Top level

| Key | Type | Notes |
|---|---|---|
| `schemaVersion` | number | `2`. Anything else is treated as unknown and normalised. |
| `app` | string | `"school-bell-system"`. Informational. |
| `days` | object | Keys `"1"`…`"7"`. Missing keys become empty days. |
| `ui` | object | Optional; missing values fall back to defaults. |

### `days[n]`

| Key | Type | Notes |
|---|---|---|
| `type` | `"custom"` \| `"1"`…`"7"` | `"custom"` = this day has its own slots. A numeric string means *"this day is like day n"*; its own `slots` array is then ignored. |
| `slots` | array | Max **200** entries. Sorted by time on load and on save. |

Day index mapping (**Persian week, Saturday first**):

| Index | Day | |
|---|---|---|
| 1 | شنبه | Saturday |
| 2 | یک‌شنبه | Sunday |
| 3 | دوشنبه | Monday |
| 4 | سه‌شنبه | Tuesday |
| 5 | چهارشنبه | Wednesday |
| 6 | پنج‌شنبه | Thursday (weekend) |
| 7 | جمعه | Friday (weekend) |

Index 6 and 7 are flagged as weekend in the UI but remain fully schedulable.

### `days[n].slots[m]`

| Key | Type | Notes |
|---|---|---|
| `hour` | number | `0`–`23`. |
| `minute` | number | `0`–`59`. |
| `soundfile` | string | A bare file name (`"bell-1.mp3"`). **Not** a path. An empty string means "no sound" and the slot is skipped by the scheduler. |

Validation on read:

- `hour`/`minute` are clamped; out-of-range or non-numeric slots are dropped.
- `soundfile` must satisfy `isSafeSoundName()`: no `/`, `\`, `..`, control
  characters, or a leading dot. Anything else is replaced with `""`.
- Slots beyond the 200th are discarded.
- Duplicate times are **kept** (the UI warns), because two different sounds at the
  same minute is a legitimate, if unusual, configuration.

### `ui`

| Key | Type | Default | Notes |
|---|---|---|---|
| `theme` | `"system"` \| `"light"` \| `"dark"` | `"system"` | Unknown values fall back to `"system"`. |
| `volume` | number | `0.9` | Clamped to `0`…`1`. |
| `lastDay` | number | `1` | Clamped to `1`…`7`; the day selected on next launch. |

### Guarantees

- **Atomic writes.** The file is written to a temp file, `fsync`ed, then renamed
  over the target. A crash cannot leave a half-written schedule.
- **Automatic backup.** Before overwriting, the previous file is copied to
  `settings.backup.json`.
- **Size limit.** Files larger than 2 MB are rejected on read.
- **Round-trip stability.** `buildSettings()` always emits all seven days, sorted
  slots, and a normalised `ui` block, so saving twice produces byte-identical
  output.

---

## 2. Legacy text format

Produced by v2.1 and earlier (`BuildSettingsText()` in
`src/SchoolBell/frmMain2.cs`). Still readable and still writable via
**ذخیره به نام → فایل متنی**.

```
Day=1
Type=custom
07:30|westminster-1.mp3
12:00|music-meander.mp3
----
Day=2
Type=1
----
Day=3
Type=custom
----
...
```

### Grammar

```
file      := day ( "----" day )*
day       := "Day=" n NEWLINE "Type=" type NEWLINE slot*
slot      := "HH:MM" "|" soundfile NEWLINE
n         := 1..7
type      := "custom" | 1..7
```

- Lines are matched **case-insensitively** (`day=`, `DAY=`, `Type=` all work).
- `----` separates days and resets the current day.
- A line containing `|` while a day is active is parsed as `time|soundfile`.
- **Every other line is silently ignored.** This is what makes the format
  forward-compatible, and it is why the extra lines below are safe.

### Accepted extensions (v2.2)

The parser is deliberately lenient so that files hand-edited or produced by
other tools still load:

| Extension | Example | Effect |
|---|---|---|
| `Slot=` prefix | `Slot=07:30\|bell-1.mp3` | Prefix is stripped before parsing. |
| Persian digits | `۰۷:۳۰\|bell-1.mp3` | Converted to ASCII. |
| `.` separator | `07.30\|bell-1.mp3` | Accepted as `07:30`. |
| `H:M` | `7:5\|bell-1.mp3` | Accepted as `07:05`. |
| `Volume=` | `Volume=0.75` | Preview/bell volume; comma decimal (`0,75`) accepted. |
| `Theme=` | `Theme=dark` | `light` / `dark` / `system`, case-insensitive. |
| `LastDay=` | `LastDay=3` | Last selected day, `1`–`7`. |

The three `Volume=` / `Theme=` / `LastDay=` lines are written **after** the last
day block and contain no `|`, so the v2.1 C# parser ignores them: old builds can
still open files saved by v2.2 without error (they just lose the UI preferences).

### Migration

On first launch, if `settings.json` is absent but `settings.txt` exists, the app:

1. parses the legacy file,
2. writes `settings.json` in the new format,
3. **leaves `settings.txt` in place** (never deleted),
4. reports the `migrated-legacy-settings` warning, shown as a toast.

The same path is used when a user opens a `.txt` file manually — the in-memory
model is upgraded, and the next save writes JSON.

---

## 3. Manual editing

Both formats are plain text and safe to edit by hand, provided the app is closed
(or the file is re-opened afterwards, since the app holds the model in memory).

Rules of thumb:

- Keep `soundfile` values as **bare file names** that exist in `userData/sounds`
  or in the bundled `sound/` folder.
- Keep times zero-padded (`07:05`, not `7:5`) if you want old builds to read them.
- After editing, validate by opening the file in the app — invalid slots are
  dropped silently, so a typo in a time removes that bell rather than crashing.
- Keep a copy before editing. If the app cannot read the file it falls back to
  `settings.backup.json` and warns.

---

## 4. Quick reference

```js
// shared/core.js — the authoritative implementation
parseSettingsPayload(text) // → { days, ui, legacy, error? }
buildSettings(days, ui)    // → { schemaVersion, app, days, ui }
parseLegacyText(text)      // → days
parseLegacyUi(text)        // → ui
serializeLegacyText(days, ui?) // → string
normalizeDays(input)       // → days (always 7 complete days)
normalizeUi(input)         // → { theme, volume, lastDay }
```


### Music after bells

A slot may carry `"music": true`; after that bell, files from `ui.music.files` play and fade out ~5 s before the next bell.
