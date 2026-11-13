"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../shared/core.js");

// ---------------------------------------------------------------- weekdays

test("dayIndexFromDow maps the Persian week (Saturday = 1 … Friday = 7)", () => {
  // JS getDay(): Sunday 0 … Saturday 6
  assert.equal(core.dayIndexFromDow(6), 1, "Saturday");
  assert.equal(core.dayIndexFromDow(0), 2, "Sunday");
  assert.equal(core.dayIndexFromDow(1), 3, "Monday");
  assert.equal(core.dayIndexFromDow(2), 4, "Tuesday");
  assert.equal(core.dayIndexFromDow(3), 5, "Wednesday");
  assert.equal(core.dayIndexFromDow(4), 6, "Thursday");
  assert.equal(core.dayIndexFromDow(5), 7, "Friday");
});

test("dayIndexFromDate agrees with dayIndexFromDow", () => {
  for (let d = 0; d < 7; d++) {
    const date = new Date(2024, 0, 7 + d); // 2024-01-07 is a Sunday
    assert.equal(core.dayIndexFromDate(date), core.dayIndexFromDow(date.getDay()));
  }
});

test("day names and weekend flags", () => {
  assert.equal(core.dayName(1), "شنبه");
  assert.equal(core.dayName(7), "جمعه");
  assert.equal(core.isWeekend(6), true);
  assert.equal(core.isWeekend(7), true);
  assert.equal(core.isWeekend(1), false);
});

// ---------------------------------------------------------------- time

test("parseTime accepts many shapes and rejects nonsense", () => {
  assert.deepEqual(core.parseTime("07:30"), { hour: 7, minute: 30 });
  assert.deepEqual(core.parseTime("7:5"), { hour: 7, minute: 5 });
  assert.deepEqual(core.parseTime(" 08.15 "), { hour: 8, minute: 15 });
  assert.deepEqual(core.parseTime("۱۴:۴۵"), { hour: 14, minute: 45 }); // Persian digits
  assert.equal(core.parseTime("24:00"), null);
  assert.equal(core.parseTime("12:60"), null);
  assert.equal(core.parseTime(""), null);
  assert.equal(core.parseTime(null), null);
  assert.equal(core.parseTime("abc"), null);
});

test("formatTime zero-pads", () => {
  assert.equal(core.formatTime(7, 5), "07:05");
  assert.equal(core.formatTime(0, 0), "00:00");
  assert.equal(core.slotTime({ hour: 13, minute: 0 }), "13:00");
});

// ---------------------------------------------------------------- slots

test("sortSlots is stable and ordered by time", () => {
  const slots = [
    { hour: 9, minute: 0, soundfile: "b.mp3" },
    { hour: 7, minute: 30, soundfile: "a.mp3" },
    { hour: 9, minute: 0, soundfile: "c.mp3" },
  ];
  const sorted = core.sortSlots(slots);
  assert.deepEqual(
    sorted.map((s) => s.soundfile),
    ["a.mp3", "b.mp3", "c.mp3"]
  );
  assert.equal(slots[0].soundfile, "b.mp3", "input must not be mutated");
});

test("findDuplicateTimes reports repeated clock times", () => {
  const slots = [
    { hour: 8, minute: 0, soundfile: "a.mp3" },
    { hour: 8, minute: 0, soundfile: "b.mp3" },
    { hour: 9, minute: 0, soundfile: "c.mp3" },
  ];
  assert.deepEqual(core.findDuplicateTimes(slots), ["08:00"]);
  assert.deepEqual(core.findDuplicateTimes([]), []);
});

// ---------------------------------------------------------------- day types

test("normalizeDayType only allows custom or another day 1..7", () => {
  assert.equal(core.normalizeDayType("custom", 3), "custom");
  assert.equal(core.normalizeDayType(null, 3), "custom");
  assert.equal(core.normalizeDayType("4", 3), "4");
  assert.equal(core.normalizeDayType(4, 3), "4");
  assert.equal(core.normalizeDayType("3", 3), "custom", "a day cannot copy itself");
  assert.equal(core.normalizeDayType("9", 3), "custom");
  assert.equal(core.normalizeDayType("x", 3), "custom");
});

test("resolveDay follows references and breaks cycles", () => {
  const days = core.emptyDays();
  days[1].slots = [{ hour: 8, minute: 0, soundfile: "a.mp3" }];
  days[2].type = "1";
  days[3].type = "2";

  const resolved = core.resolveDay(days, 3);
  assert.equal(resolved.dayIndex, 1);
  assert.equal(resolved.inherited, true);
  assert.equal(resolved.slots.length, 1);

  // 4 -> 5 -> 4 is a cycle; must terminate.
  days[4].type = "5";
  days[5].type = "4";
  const cyclic = core.resolveDay(days, 4);
  assert.ok(cyclic.dayIndex >= 1 && cyclic.dayIndex <= 7);
});

// ---------------------------------------------------------------- next bell

test("findNextBell returns the soonest upcoming slot", () => {
  const days = core.emptyDays();
  days[1].slots = [
    { hour: 8, minute: 0, soundfile: "a.mp3" },
    { hour: 12, minute: 0, soundfile: "b.mp3" },
  ];
  // 2024-01-06 is a Saturday => dayIndex 1
  const from = new Date(2024, 0, 6, 9, 0, 0);
  const next = core.findNextBell(days, from);
  assert.ok(next);
  assert.equal(next.soundfile, "b.mp3");
  assert.equal(next.at.getHours(), 12);
});

test("findNextBell wraps to the next week", () => {
  const days = core.emptyDays();
  days[1].slots = [{ hour: 8, minute: 0, soundfile: "a.mp3" }];
  const from = new Date(2024, 0, 6, 9, 0, 0); // Saturday after the bell
  const next = core.findNextBell(days, from);
  assert.ok(next);
  assert.equal(next.dayIndex, 1);
  assert.equal(next.at.getDate(), 13);
});

test("findNextBell ignores slots without a sound file", () => {
  const days = core.emptyDays();
  days[1].slots = [{ hour: 10, minute: 0, soundfile: "" }];
  assert.equal(core.findNextBell(days, new Date(2024, 0, 6, 9, 0, 0)), null);
});

test("findBellsBetween enumerates a window in order", () => {
  const days = core.emptyDays();
  days[1].slots = [{ hour: 8, minute: 0, soundfile: "a.mp3" }];
  days[2].slots = [{ hour: 9, minute: 0, soundfile: "b.mp3" }];
  const from = new Date(2024, 0, 6, 0, 0, 0);
  const to = new Date(2024, 0, 8, 0, 0, 0);
  const bells = core.findBellsBetween(days, from, to);
  assert.equal(bells.length, 2);
  assert.deepEqual(
    bells.map((b) => b.soundfile),
    ["a.mp3", "b.mp3"]
  );
});

// ---------------------------------------------------------------- normalize

test("normalizeDays drops malformed slots and clamps the count", () => {
  const days = core.normalizeDays({
    1: {
      type: "custom",
      slots: [
        { hour: 8, minute: 0, soundfile: "a.mp3" },
        { hour: 99, minute: 0, soundfile: "b.mp3" },
        { hour: 9, minute: 0, soundfile: "../../etc/passwd" },
        null,
      ],
    },
  });
  assert.equal(days[1].slots.length, 2);
  assert.equal(days[1].slots[1].soundfile, "", "unsafe sound names are stripped");
  assert.equal(days[2].slots.length, 0);
});

test("normalizeDays accepts the array form and junk input", () => {
  const days = core.normalizeDays([{ slots: [{ hour: 7, minute: 0, soundfile: "a.mp3" }] }]);
  assert.equal(days[1].slots.length, 1);
  assert.equal(core.normalizeDays(null)[1].slots.length, 0);
  assert.equal(core.normalizeDays("nope")[7].slots.length, 0);
});

test("normalizeUi clamps and defaults", () => {
  const music = { enabled: false, shuffle: true, files: [] };
  assert.deepEqual(core.normalizeUi(null), { theme: "system", volume: 0.9, music, lastDay: 1 });
  assert.deepEqual(core.normalizeUi({ theme: "dark", volume: 2, lastDay: 9 }), {
    theme: "dark",
    volume: 1,
    music,
    lastDay: 1,
  });
  assert.equal(core.normalizeUi({ theme: "neon" }).theme, "system");
  assert.equal(core.normalizeUi({ volume: -3 }).volume, 0);
});

// ---------------------------------------------------------------- settings

test("buildSettings produces a versioned, sorted payload", () => {
  const days = core.emptyDays();
  days[1].slots = [
    { hour: 10, minute: 0, soundfile: "b.mp3" },
    { hour: 8, minute: 0, soundfile: "a.mp3" },
  ];
  const payload = core.buildSettings(days, { theme: "light", volume: 0.5, lastDay: 2 });
  assert.equal(payload.schemaVersion, core.SCHEMA_VERSION);
  assert.equal(payload.app, "school-bell-system");
  assert.deepEqual(
    payload.days[1].slots.map((s) => s.soundfile),
    ["a.mp3", "b.mp3"]
  );
  assert.equal(payload.ui.theme, "light");
});

test("parseSettingsPayload round-trips JSON", () => {
  const days = core.emptyDays();
  days[3].slots = [{ hour: 8, minute: 15, soundfile: "z.mp3" }];
  const text = JSON.stringify(core.buildSettings(days, { theme: "dark" }));
  const parsed = core.parseSettingsPayload(text);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.legacy, false);
  assert.equal(parsed.days[3].slots[0].soundfile, "z.mp3");
  assert.equal(parsed.ui.theme, "dark");
});

test("parseSettingsPayload rejects bad input", () => {
  assert.equal(core.parseSettingsPayload("").error, "empty");
  assert.equal(core.parseSettingsPayload("   ").error, "empty");
  assert.equal(core.parseSettingsPayload("{not json").error, "invalid-json");
});

test("parseSettingsPayload reads the legacy text format", () => {
  const legacy = [
    "Day=1",
    "Type=custom",
    "Slot=08:00|a.mp3",
    "Slot=12:30|b.mp3",
    "Day=2",
    "Type=1",
    "Volume=0.75",
    "Theme=dark",
    "LastDay=2",
  ].join("\n");
  const parsed = core.parseSettingsPayload(legacy);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.legacy, true);
  assert.equal(parsed.days[1].slots.length, 2);
  assert.equal(parsed.days[1].slots[1].soundfile, "b.mp3");
  assert.equal(parsed.days[2].type, "1");
  assert.equal(parsed.ui.volume, 0.75);
  assert.equal(parsed.ui.theme, "dark");
  assert.equal(parsed.ui.lastDay, 2);
});

test("legacy text survives a serialize/parse round-trip", () => {
  const days = core.emptyDays();
  days[1].slots = [{ hour: 8, minute: 0, soundfile: "a.mp3" }];
  days[1].type = "custom";
  const text = core.serializeLegacyText(days, { volume: 0.4, theme: "light", lastDay: 1 });
  const parsed = core.parseSettingsPayload(text);
  assert.equal(parsed.days[1].slots[0].soundfile, "a.mp3");
  assert.equal(parsed.ui.volume, 0.4);
});

// ---------------------------------------------------------------- safety

test("isSafeSoundName blocks traversal and absolute paths", () => {
  assert.equal(core.isSafeSoundName("bell.mp3"), true);
  assert.equal(core.isSafeSoundName("زنگ صبح.mp3"), true);
  assert.equal(core.isSafeSoundName("../secret.mp3"), false);
  assert.equal(core.isSafeSoundName("..\\secret.mp3"), false);
  assert.equal(core.isSafeSoundName("/etc/passwd"), false);
  assert.equal(core.isSafeSoundName("C:\\x.mp3"), false);
  assert.equal(core.isSafeSoundName(""), false);
  assert.equal(core.isSafeSoundName(null), false);
});

test("SOUND_EXT_RE accepts the supported formats", () => {
  for (const ext of ["mp3", "wav", "ogg", "m4a", "aac", "flac", "opus", "weba"]) {
    assert.ok(core.SOUND_EXT_RE.test("x." + ext), ext);
  }
  assert.equal(core.SOUND_EXT_RE.test("x.exe"), false);
});

test("emptyDays returns seven independent days", () => {
  const days = core.emptyDays();
  assert.equal(Object.keys(days).length, 7);
  days[1].slots.push({ hour: 1, minute: 0, soundfile: "a.mp3" });
  assert.equal(days[2].slots.length, 0);
  assert.equal(days[1].type, "custom");
});
