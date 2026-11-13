/*
 * School Bell System - shared core logic
 * --------------------------------------
 * Pure, dependency-free functions used by BOTH the Electron main process
 * (CommonJS `require`) and the renderer (classic <script>, global `BellCore`).
 *
 * Keeping this logic in one place is what makes the weekday mapping, the
 * settings format and the "next bell" calculation testable (see test/core.test.js).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BellCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SCHEMA_VERSION = 2;
  const NUM_DAYS = 7;

  // Index 1 = Saturday (شنبه) ... index 7 = Friday (جمعه).
  // This is the Persian week; it is NOT the JavaScript getDay() order.
  const DAY_NAMES_FA = ["", "شنبه", "یک‌شنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنج‌شنبه", "جمعه"];
  const DAY_NAMES_EN = ["", "Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

  // Thursday + Friday are the weekend in Iran. They stay fully editable and
  // schedulable (schools do hold exams), they are only flagged in the UI.
  const WEEKEND_DAYS = [6, 7];

  const SOUND_EXT_RE = /\.(mp3|wav|ogg|oga|opus|m4a|aac|flac|weba|webm)$/i;
  const MAX_SLOTS_PER_DAY = 200;

  const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
  const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";

  /** Convert Persian/Arabic-Indic digits to ASCII digits. */
  function toAsciiDigits(value) {
    return String(value).replace(/[۰-۹٠-٩]/g, (ch) => {
      const fa = FA_DIGITS.indexOf(ch);
      if (fa >= 0) return String(fa);
      const ar = AR_DIGITS.indexOf(ch);
      return ar >= 0 ? String(ar) : ch;
    });
  }

  /**
   * Map a JavaScript `Date#getDay()` value (0 = Sunday ... 6 = Saturday)
   * to our Persian week index (1 = Saturday ... 7 = Friday).
   *
   * Saturday (6) -> 1, Sunday (0) -> 2, Monday (1) -> 3 ...
   */
  function dayIndexFromDow(dow) {
    const n = Number(dow);
    if (!Number.isInteger(n) || n < 0 || n > 6) return null;
    return ((n + 1) % 7) + 1;
  }

  function dayIndexFromDate(date) {
    return dayIndexFromDow(date.getDay());
  }

  function dayName(dayIndex, lang) {
    return (lang === "en" ? DAY_NAMES_EN : DAY_NAMES_FA)[dayIndex] || "";
  }

  function isWeekend(dayIndex) {
    return WEEKEND_DAYS.indexOf(dayIndex) !== -1;
  }

  /** Parse "HH:MM" (also "H:M", Persian digits, stray spaces) -> {hour, minute} | null */
  function parseTime(text) {
    if (text == null) return null;
    const raw = toAsciiDigits(text).trim();
    if (!raw) return null;
    const m = /^(\d{1,2})\s*[:.]\s*(\d{1,2})$/.exec(raw);
    if (!m) return null;
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return { hour, minute };
  }

  function formatTime(hour, minute) {
    return String(hour).padStart(2, "0") + ":" + String(minute).padStart(2, "0");
  }

  function slotTime(slot) {
    return formatTime(slot.hour, slot.minute);
  }

  function minutesOfDay(slot) {
    return slot.hour * 60 + slot.minute;
  }

  function emptyDays() {
    const days = {};
    for (let i = 1; i <= NUM_DAYS; i++) days[i] = { type: "custom", slots: [] };
    return days;
  }

  /** A safe, single-segment sound file name (no directories, no traversal). */
  function isSafeSoundName(name) {
    if (typeof name !== "string") return false;
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 255) return false;
    if (trimmed !== name) return false;
    if (/[\\/\u0000-\u001f]/.test(trimmed)) return false;
    if (trimmed === "." || trimmed === "..") return false;
    return SOUND_EXT_RE.test(trimmed);
  }

  function normalizeSlot(raw) {
    if (!raw || typeof raw !== "object") return null;
    let hour = Number(raw.hour);
    let minute = Number(raw.minute);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
      const parsed = parseTime(raw.time);
      if (!parsed) return null;
      hour = parsed.hour;
      minute = parsed.minute;
    }
    hour = Math.trunc(hour);
    minute = Math.trunc(minute);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    const soundfile = typeof raw.soundfile === "string" ? raw.soundfile.trim() : "";
    const out = { hour, minute, soundfile: isSafeSoundName(soundfile) ? soundfile : "" };
    if (raw.music === true) out.music = true;
    return out;
  }

  function normalizeDayType(type, selfIndex) {
    if (type == null) return "custom";
    const t = toAsciiDigits(type).trim().toLowerCase();
    if (t === "" || t === "custom" || t === "0") return "custom";
    const n = Number(t);
    if (!Number.isInteger(n) || n < 1 || n > NUM_DAYS) return "custom";
    if (selfIndex != null && n === selfIndex) return "custom";
    return String(n);
  }

  /**
   * Coerce anything (JSON, IPC payload, legacy parse result) into a valid
   * 7-day model. Never throws; invalid input becomes an empty schedule.
   */
  function normalizeDays(input) {
    const out = emptyDays();
    if (!input || typeof input !== "object") return out;

    for (let i = 1; i <= NUM_DAYS; i++) {
      const src = Array.isArray(input) ? input[i - 1] : input[i] != null ? input[i] : input[String(i)];
      if (!src || typeof src !== "object") continue;
      out[i].type = normalizeDayType(src.type, i);
      const slots = Array.isArray(src.slots) ? src.slots : [];
      out[i].slots = slots
        .slice(0, MAX_SLOTS_PER_DAY)
        .map(normalizeSlot)
        .filter(Boolean);
    }
    return out;
  }

  /** Stable sort by time of day (does not mutate the input). */
  function sortSlots(slots) {
    return slots
      .map((slot, index) => ({ slot, index }))
      .sort((a, b) => minutesOfDay(a.slot) - minutesOfDay(b.slot) || a.index - b.index)
      .map((entry) => entry.slot);
  }

  function sortDays(days) {
    const out = normalizeDays(days);
    for (let i = 1; i <= NUM_DAYS; i++) out[i].slots = sortSlots(out[i].slots);
    return out;
  }

  /** Duplicate time slots for a single (custom) day. */
  function findDuplicateTimes(slots) {
    const seen = new Map();
    const duplicates = [];
    for (const slot of slots) {
      const key = slotTime(slot);
      if (seen.has(key)) duplicates.push(key);
      else seen.set(key, true);
    }
    return duplicates;
  }

  /**
   * Follow `type` references ("use the Monday schedule") until a custom day is
   * reached. Cycles are broken safely.
   */
  function resolveDay(days, dayIndex) {
    const visited = new Set();
    let current = dayIndex;
    while (current >= 1 && current <= NUM_DAYS) {
      if (visited.has(current)) break;
      visited.add(current);
      const day = days[current];
      if (!day || day.type === "custom") break;
      const next = Number(day.type);
      if (!Number.isInteger(next) || next < 1 || next > NUM_DAYS) break;
      current = next;
    }
    const source = days[current] || { type: "custom", slots: [] };
    return {
      dayIndex: current,
      inherited: current !== dayIndex,
      slots: source.slots || [],
      type: source.type || "custom",
    };
  }

  function slotDate(dayDate, slot) {
    const d = new Date(dayDate);
    d.setHours(slot.hour, slot.minute, 0, 0);
    return d;
  }

  /**
   * Find the next bell strictly after `from`.
   * Returns { at: Date, dayIndex, slotIndex, soundfile, inherited } or null.
   */
  function findNextBell(days, from) {
    const now = from instanceof Date ? from : new Date(from || Date.now());
    const model = normalizeDays(days);
    let best = null;

    for (let offset = 0; offset < 8; offset++) {
      const probe = new Date(now);
      probe.setDate(now.getDate() + offset);
      probe.setHours(0, 0, 0, 0);
      const dayIndex = dayIndexFromDate(probe);
      const resolved = resolveDay(model, dayIndex);

      for (let i = 0; i < resolved.slots.length; i++) {
        const slot = resolved.slots[i];
        if (!slot.soundfile) continue;
        const at = slotDate(probe, slot);
        if (at.getTime() <= now.getTime()) continue;
        if (!best || at.getTime() < best.at.getTime()) {
          best = { at, dayIndex, slotIndex: i, soundfile: slot.soundfile, inherited: resolved.inherited };
        }
      }
      // A hit on an earlier day always wins; later days can only be later.
      if (best) break;
    }
    return best;
  }

  /** Bells that would have fired between `from` (exclusive) and `to` (inclusive). */
  function findBellsBetween(days, from, to) {
    const model = normalizeDays(days);
    const start = new Date(from);
    const end = new Date(to);
    const found = [];
    const cursor = new Date(start.getTime() + 1000);
    cursor.setSeconds(0, 0);
    // Walk day by day instead of minute by minute.
    const day = new Date(start);
    day.setHours(0, 0, 0, 0);
    while (day.getTime() <= end.getTime()) {
      const dayIndex = dayIndexFromDate(day);
      const resolved = resolveDay(model, dayIndex);
      resolved.slots.forEach((slot, slotIndex) => {
        if (!slot.soundfile) return;
        const at = slotDate(day, slot);
        if (at.getTime() > start.getTime() && at.getTime() <= end.getTime()) {
          found.push({ at, dayIndex, slotIndex, soundfile: slot.soundfile, inherited: resolved.inherited });
        }
      });
      day.setDate(day.getDate() + 1);
    }
    found.sort((a, b) => a.at - b.at);
    return found;
  }

  // ---------------------------------------------------------------- legacy text
  // v2.1 and older stored the schedule in a plain text file:
  //   Day=1 / Type=custom / 07:30|bell 1.mp3 / ---- / Day=2 ...
  // We keep reading (and writing) it so existing installations keep working.

  function parseLegacyText(text) {
    const days = emptyDays();
    if (typeof text !== "string") return days;

    let currentDay = -1;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = toAsciiDigits(rawLine).trim();
      if (!line) continue;
      if (/^-{3,}$/.test(line)) {
        currentDay = -1;
        continue;
      }
      const dayMatch = /^day\s*=\s*(\d{1,2})$/i.exec(line);
      if (dayMatch) {
        const n = Number(dayMatch[1]);
        currentDay = n >= 1 && n <= NUM_DAYS ? n : -1;
        continue;
      }
      if (currentDay < 1) continue;

      const typeMatch = /^type\s*=\s*(.+)$/i.exec(line);
      if (typeMatch) {
        days[currentDay].type = normalizeDayType(typeMatch[1], currentDay);
        continue;
      }
      const bar = line.indexOf("|");
      if (bar === -1) continue;
      // Our own serializer writes a bare "HH:MM|file"; accept an optional
      // "Slot=" prefix as well so hand-edited files keep working.
      const time = parseTime(line.slice(0, bar).replace(/^slot\s*=\s*/i, ""));
      if (!time) continue;
      const soundfile = line.slice(bar + 1).trim();
      if (days[currentDay].slots.length >= MAX_SLOTS_PER_DAY) continue;
      days[currentDay].slots.push({
        hour: time.hour,
        minute: time.minute,
        soundfile: isSafeSoundName(soundfile) ? soundfile : "",
      });
    }
    return sortDays(days);
  }

  /**
   * Read the optional `Volume=` / `Theme=` / `LastDay=` lines that our own
   * serializer appends. The original C# writer never emitted them, so they are
   * purely additive: old files simply fall back to the defaults.
   */
  function parseLegacyUi(text) {
    const ui = {};
    if (typeof text !== "string") return normalizeUi(null);
    for (const rawLine of text.split(/\r?\n/)) {
      const line = toAsciiDigits(rawLine).trim();
      if (!line) continue;
      let match = /^volume\s*=\s*(.+)$/i.exec(line);
      if (match) {
        ui.volume = Number(match[1].replace(",", "."));
        continue;
      }
      match = /^theme\s*=\s*(.+)$/i.exec(line);
      if (match) {
        ui.theme = match[1].trim().toLowerCase();
        continue;
      }
      match = /^lastday\s*=\s*(\d{1,2})$/i.exec(line);
      if (match) {
        ui.lastDay = Number(match[1]);
        continue;
      }
    }
    return normalizeUi(ui);
  }

  function serializeLegacyText(days, ui) {
    const model = sortDays(days);
    const lines = [];
    for (let i = 1; i <= NUM_DAYS; i++) {
      if (i > 1) lines.push("----");
      lines.push("Day=" + i);
      lines.push("Type=" + model[i].type);
      for (const slot of model[i].slots) {
        lines.push(slotTime(slot) + "|" + slot.soundfile);
      }
    }
    if (ui && typeof ui === "object") {
      const safeUi = normalizeUi(ui);
      lines.push("Volume=" + safeUi.volume);
      lines.push("Theme=" + safeUi.theme);
      lines.push("LastDay=" + safeUi.lastDay);
    }
    return lines.join("\n");
  }

  // ------------------------------------------------------------------- settings

  const THEMES = ["system", "light", "dark"];

  function normalizeUi(raw) {
    const ui = raw && typeof raw === "object" ? raw : {};
    const theme = THEMES.indexOf(ui.theme) !== -1 ? ui.theme : "system";
    let volume = Number(ui.volume);
    if (!Number.isFinite(volume)) volume = 0.9;
    volume = Math.min(1, Math.max(0, volume));
    const lastDay = Number(ui.lastDay);
    const m = ui.music && typeof ui.music === "object" ? ui.music : {};
    const music = {
      enabled: m.enabled === true,
      shuffle: m.shuffle !== false,
      files: (Array.isArray(m.files) ? m.files : []).filter((f) => typeof f === "string" && isSafeSoundName(f)),
    };
    return {
      theme,
      volume,
      music,
      lastDay: Number.isInteger(lastDay) && lastDay >= 1 && lastDay <= NUM_DAYS ? lastDay : 1,
    };
  }

  /** Build the on-disk settings object. */
  function buildSettings(days, ui) {
    return {
      schemaVersion: SCHEMA_VERSION,
      app: "school-bell-system",
      days: sortDays(days),
      ui: normalizeUi(ui),
    };
  }

  /**
   * Accept a settings file of any known shape (JSON v2, JSON with a bare
   * `days` object, or legacy text) and return { days, ui, legacy }.
   */
  function parseSettingsPayload(payload) {
    if (typeof payload === "string") {
      const trimmed = payload.trim();
      if (trimmed === "") {
        return { days: emptyDays(), ui: normalizeUi(null), legacy: false, error: "empty" };
      }
      if (trimmed.startsWith("{")) {
        try {
          return parseSettingsPayload(JSON.parse(trimmed));
        } catch (err) {
          return { days: emptyDays(), ui: normalizeUi(null), legacy: false, error: "invalid-json" };
        }
      }
      return { days: parseLegacyText(payload), ui: parseLegacyUi(payload), legacy: true };
    }
    if (!payload || typeof payload !== "object") {
      return { days: emptyDays(), ui: normalizeUi(null), legacy: false, error: "empty" };
    }
    return {
      days: normalizeDays(payload.days),
      ui: normalizeUi(payload.ui),
      legacy: false,
    };
  }

  return {
    SCHEMA_VERSION,
    NUM_DAYS,
    DAY_NAMES_FA,
    DAY_NAMES_EN,
    WEEKEND_DAYS,
    MAX_SLOTS_PER_DAY,
    THEMES,
    SOUND_EXT_RE,
    toAsciiDigits,
    dayIndexFromDow,
    dayIndexFromDate,
    dayName,
    isWeekend,
    parseTime,
    formatTime,
    slotTime,
    minutesOfDay,
    emptyDays,
    isSafeSoundName,
    normalizeDays,
    normalizeDayType,
    sortSlots,
    sortDays,
    findDuplicateTimes,
    resolveDay,
    findNextBell,
    findBellsBetween,
    parseLegacyText,
    parseLegacyUi,
    serializeLegacyText,
    normalizeUi,
    buildSettings,
    parseSettingsPayload,
  };
});
