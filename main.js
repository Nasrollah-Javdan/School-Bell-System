/*
 * School Bell System - Electron main process
 * ------------------------------------------
 * Responsibilities:
 *   - window + tray lifecycle (single instance, close-to-tray)
 *   - safe file access (settings, sounds) inside the user data directory
 *   - native dialogs (open / save / import / about)
 *   - a custom `bellsound://` protocol so the renderer never touches file://
 *
 * All scheduling logic lives in shared/core.js so it can be unit tested.
 */
"use strict";

const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  Menu,
  Tray,
  shell,
  nativeImage,
  protocol,
  powerSaveBlocker,
} = require("electron");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const core = require("./shared/core.js");

const APP_NAME = "School Bell System";
const MAX_SETTINGS_BYTES = 2 * 1024 * 1024; // 2 MB is plenty for a schedule
const MAX_SOUND_BYTES = 40 * 1024 * 1024; // 40 MB per sound file
const SOUND_PROTOCOL = "bellsound";

const isDev = !app.isPackaged;

// Windows launches the app with these arguments when it was registered as a
// login item, so an autostart lands in the tray instead of showing a window.
const LOGIN_ARGS = ["--hidden"];
const startHidden = process.argv.includes("--hidden");

// Windows 7 (kernel 6.1), 8.0 (6.2) and 8.1 (6.3) only have WDDM 1.x GPU
// drivers and an ancient Direct3D stack. Chromium's GPU process regularly
// fails there and paints a black/blank window, so those systems get software
// rendering. The app only draws a schedule and plays audio, so this costs
// nothing noticeable. This must run before `app.whenReady()`.
const winKernel = process.platform === "win32" ? os.release() : "";
const isLegacyWindows = /^6\.[123]($|\.)/.test(winKernel);
if (isLegacyWindows) {
  app.disableHardwareAcceleration();
}

let mainWindow = null;
let tray = null;
let isQuitting = false;
let rendererDirty = false;
let pendingCloseAfterSave = false;

// Live schedule, kept in sync with the renderer. The bell timer itself lives
// here in the main process: renderer timers are throttled when the window is
// hidden or occluded, which would make bells drift or never fire.
let scheduleDays = core.emptyDays();
let scheduleUi = core.normalizeUi(null);
let nextBell = null;
let bellTimer = null;
let watchdog = null;
let playedKeys = new Set();
let powerBlockerId = null;
const BELL_GRACE_MS = 60 * 1000; // play a bell up to a minute late (sleep/wake)
const WATCHDOG_MS = 20 * 1000;

// ---------------------------------------------------------------- paths

function appRoot() {
  return app.getAppPath();
}

function paths() {
  const userData = app.getPath("userData");
  return {
    userData,
    settings: path.join(userData, "settings.json"),
    legacySettings: path.join(userData, "settings.txt"),
    backup: path.join(userData, "settings.backup.json"),
    sounds: path.join(userData, "sounds"),
    bundledSounds: path.join(appRoot(), "sound"),
    log: path.join(userData, "school-bell.log"),
  };
}

function ensureDirs() {
  const p = paths();
  for (const dir of [p.userData, p.sounds]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      log("mkdir failed", dir, err.message);
    }
  }
}

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(" ")}\n`;
  try {
    fs.appendFileSync(paths().log, line);
  } catch {
    /* logging must never break the app */
  }
  if (isDev) process.stdout.write(line);
}

// ---------------------------------------------------------------- settings io

/** Write a file atomically (temp file + rename) so a crash cannot truncate it. */
async function writeFileAtomic(target, data) {
  const dir = path.dirname(target);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.tmp`);
  const handle = await fsp.open(tmp, "w");
  try {
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmp, target);
}

async function readTextFile(file, maxBytes) {
  const stat = await fsp.stat(file);
  if (!stat.isFile()) throw new Error("not-a-file");
  if (stat.size > maxBytes) throw new Error("file-too-large");
  return fsp.readFile(file, "utf8");
}

async function loadInitialState() {
  const p = paths();
  const warnings = [];

  // 1) current JSON settings
  try {
    const text = await readTextFile(p.settings, MAX_SETTINGS_BYTES);
    const parsed = core.parseSettingsPayload(text);
    if (parsed.error) warnings.push("settings-unreadable");
    return { days: parsed.days, ui: parsed.ui, path: p.settings, migrated: false, warnings };
  } catch (err) {
    if (err.code !== "ENOENT") {
      log("settings read failed:", err.message);
      warnings.push("settings-unreadable");
    }
  }

  // 2) legacy plain-text settings from v2.1 and older
  try {
    const text = await readTextFile(p.legacySettings, MAX_SETTINGS_BYTES);
    const parsed = core.parseSettingsPayload(text);
    await saveSettings(parsed.days, parsed.ui, p.settings);
    warnings.push("migrated-legacy-settings");
    log("migrated legacy settings.txt -> settings.json");
    return { days: parsed.days, ui: parsed.ui, path: p.settings, migrated: true, warnings };
  } catch (err) {
    if (err.code !== "ENOENT") log("legacy settings read failed:", err.message);
  }

  // 3) first run
  return { days: core.emptyDays(), ui: core.normalizeUi(null), path: p.settings, migrated: false, warnings };
}

async function saveSettings(days, ui, target) {
  const p = paths();
  const file = target || p.settings;
  const payload = core.buildSettings(days, ui);
  const text = JSON.stringify(payload, null, 2) + "\n";

  // keep one backup of the previous good file
  try {
    await fsp.copyFile(p.settings, p.backup);
  } catch (err) {
    if (err.code !== "ENOENT") log("backup failed:", err.message);
  }
  await writeFileAtomic(file, text);
  return { file, savedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------- sounds

function listSoundEntries() {
  const p = paths();
  const entries = new Map();

  const scan = (dir, builtin) => {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!core.SOUND_EXT_RE.test(name)) continue;
      if (entries.has(name)) continue; // user sound overrides bundled one
      let size = 0;
      try {
        const stat = fs.statSync(path.join(dir, name));
        if (!stat.isFile()) continue;
        size = stat.size;
      } catch {
        continue;
      }
      entries.set(name, { name, builtin, size });
    }
  };

  scan(p.sounds, false);
  scan(p.bundledSounds, true);

  return Array.from(entries.values()).sort((a, b) =>
    a.name.localeCompare(b.name, "fa", { numeric: true, sensitivity: "base" })
  );
}

function resolveSoundPath(name) {
  if (!core.isSafeSoundName(name)) return null;
  const p = paths();
  const candidates = [path.join(p.sounds, name), path.join(p.bundledSounds, name)];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* try next */
    }
  }
  return null;
}

function uniqueSoundName(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = name;
  let counter = 2;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${base} (${counter})${ext}`;
    counter += 1;
  }
  return candidate;
}

async function importSoundFiles(filePaths) {
  const p = paths();
  await fsp.mkdir(p.sounds, { recursive: true });
  const imported = [];
  const skipped = [];

  for (const source of filePaths) {
    const name = path.basename(source);
    if (!core.SOUND_EXT_RE.test(name)) {
      skipped.push({ name, reason: "unsupported-format" });
      continue;
    }
    try {
      const stat = await fsp.stat(source);
      if (!stat.isFile()) throw new Error("not-a-file");
      if (stat.size > MAX_SOUND_BYTES) throw new Error("file-too-large");
      const target = uniqueSoundName(p.sounds, name);
      await fsp.copyFile(source, path.join(p.sounds, target));
      imported.push(target);
    } catch (err) {
      skipped.push({ name, reason: err.message });
    }
  }
  return { imported, skipped };
}

// ---------------------------------------------------------------- window

function appIcon() {
  const candidates = [
    path.join(appRoot(), "build", "icon.png"),
    path.join(appRoot(), "src", "SchoolBell", "ico_32x32.ico"),
  ];
  for (const candidate of candidates) {
    try {
      const image = nativeImage.createFromPath(candidate);
      if (!image.isEmpty()) return image;
    } catch {
      /* next */
    }
  }
  return undefined;
}

function createWindow(options) {
  const hidden = Boolean(options && options.hidden);
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 880,
    minHeight: 600,
    show: false,
    backgroundColor: "#0f172a",
    title: APP_NAME,
    icon: appIcon(),
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  mainWindow.once("ready-to-show", () => {
    if (hidden) return;
    mainWindow.show();
    if (isDev && process.env.BELL_DEVTOOLS === "1") mainWindow.webContents.openDevTools({ mode: "detach" });
  });

  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    if (rendererDirty) {
      event.preventDefault();
      promptUnsavedChanges();
      return;
    }
    // Bells must keep firing, so closing the window hides it to the tray
    // instead of destroying the audio host. Quit from the tray/menu instead.
    event.preventDefault();
    hideToTray();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Never let the renderer navigate away or open arbitrary windows.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());

  mainWindow.on("focus", () => updateTrayMenu());
}

function promptUnsavedChanges() {
  if (!mainWindow) return;
  const choice = dialog.showMessageBoxSync(mainWindow, {
    type: "warning",
    buttons: ["ذخیره", "بدون ذخیره ببند", "انصراف"],
    defaultId: 0,
    cancelId: 2,
    title: "تغییرات ذخیره‌نشده",
    message: "برنامه‌ریزی تغییر کرده است و ذخیره نشده.",
    detail: "آیا می‌خواهید قبل از بستن، تغییرات را ذخیره کنید؟",
    noLink: true,
  });
  if (choice === 0) {
    pendingCloseAfterSave = true;
    sendToRenderer("menu:action", "save");
  } else if (choice === 1) {
    rendererDirty = false;
    quitApp();
  }
}

function showWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function hideToTray() {
  if (!mainWindow) return;
  mainWindow.hide();
  if (!tray) createTray();
}

function quitApp() {
  isQuitting = true;
  app.quit();
}

// Register/unregister the autostart entry. The `--hidden` argument is what
// makes a Windows login launch start minimised in the tray: `process.argv`
// then contains it and `createWindow({ hidden: true })` keeps the window
// invisible. Arguments are only set for packaged builds - in dev the argv is
// `electron.exe <appPath>`, so extra args would corrupt the registry command.
function applyLoginItem(enabled) {
  const options = { openAtLogin: Boolean(enabled) };
  if (app.isPackaged) {
    options.args = enabled ? LOGIN_ARGS.slice() : [];
    // Windows hides the window for a login launch by itself, but we still pass
    // --hidden so behaviour is identical if it is ever launched by hand.
    options.path = process.execPath;
  }
  app.setLoginItemSettings(options);
}

// Entries created by an older build have no `--hidden` argument, so they would
// open a visible window on login. Re-apply the setting once at startup to heal
// such installations (idempotent and cheap).
function syncLoginItem() {
  try {
    if (!app.getLoginItemSettings().openAtLogin) return;
    applyLoginItem(true);
  } catch (err) {
    log("login item sync failed:", err.message);
  }
}

function createTray() {
  const icon = appIcon();
  if (!icon) return;
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip(APP_NAME);
  tray.on("click", showWindow);
  tray.on("double-click", showWindow);
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  const visible = Boolean(mainWindow && mainWindow.isVisible());
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: visible ? "پنهان کردن پنجره" : "نمایش پنجره", click: () => (visible ? mainWindow.hide() : showWindow()) },
      { label: "باز کردن پوشه صداها", click: () => shell.openPath(paths().sounds) },
      { type: "separator" },
      { label: "خروج", click: quitApp },
    ])
  );
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// ---------------------------------------------------------------- menu

function buildMenu() {
  const template = [
    {
      label: "پرونده",
      submenu: [
        { label: "باز کردن…", accelerator: "CmdOrCtrl+O", click: () => sendToRenderer("menu:action", "open") },
        { label: "ذخیره", accelerator: "CmdOrCtrl+S", click: () => sendToRenderer("menu:action", "save") },
        { label: "ذخیره به نام…", accelerator: "CmdOrCtrl+Shift+S", click: () => sendToRenderer("menu:action", "save-as") },
        { type: "separator" },
        { label: "وارد کردن صدا…", click: () => sendToRenderer("menu:action", "import-sound") },
        { label: "باز کردن پوشه صداها", click: () => shell.openPath(paths().sounds) },
        { type: "separator" },
        { label: "پنهان کردن در سینی", accelerator: "CmdOrCtrl+W", click: hideToTray },
        { label: "خروج", accelerator: "CmdOrCtrl+Q", click: quitApp },
      ],
    },
    {
      label: "نمایش",
      submenu: [
        { label: "بزرگ‌نمایی", role: "zoomIn" },
        { label: "کوچک‌نمایی", role: "zoomOut" },
        { label: "اندازه اصلی", role: "resetZoom" },
        { type: "separator" },
        { label: "تمام‌صفحه", role: "togglefullscreen" },
        { label: "ابزار توسعه‌دهنده", role: "toggleDevTools", visible: isDev },
      ],
    },
    {
      label: "راهنما",
      submenu: [
        { label: "راهنمای کاربر", click: () => sendToRenderer("menu:action", "help") },
        { label: "درباره", click: () => sendToRenderer("menu:action", "about") },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- protocol

function registerSoundProtocol() {
  // `protocol.handle()` (and `net.fetch()`) only exist in Electron 25+. This
  // legacy form works on every supported Electron, including the 22.x line
  // that we pin for Windows 7 / 8 / 8.1 support. It streams straight from
  // disk with byte-range support, which is what <audio> needs for seeking.
  protocol.registerFileProtocol(SOUND_PROTOCOL, (request, callback) => {
    try {
      const url = new URL(request.url);
      const name = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
      const file = resolveSoundPath(name);
      if (!file) {
        log("protocol: sound not found:", name);
        callback({ error: -6 }); // net::ERR_FILE_NOT_FOUND
        return;
      }
      callback({ path: file });
    } catch (err) {
      log("protocol error:", err.message);
      callback({ error: -2 }); // net::ERR_FAILED
    }
  });
}

// ---------------------------------------------------------------- scheduler

function bellKey(entry) {
  return entry.at.getTime() + "|" + entry.soundfile;
}

function describeBell(entry) {
  if (!entry) return null;
  return {
    at: entry.at.toISOString(),
    dayIndex: entry.dayIndex,
    soundfile: entry.soundfile,
    inherited: entry.inherited,
  };
}

function broadcastNextBell() {
  sendToRenderer("schedule:next", describeBell(nextBell));
  if (tray) {
    const label = nextBell
      ? `زنگ بعدی: ${core.formatTime(nextBell.at.getHours(), nextBell.at.getMinutes())}`
      : "زنگی برنامه‌ریزی نشده";
    tray.setToolTip(`${APP_NAME} — ${label}`);
  }
}

/** Recompute the next bell and arm a single timer for it. */
function reschedule() {
  if (bellTimer) {
    clearTimeout(bellTimer);
    bellTimer = null;
  }
  const now = new Date();
  nextBell = core.findNextBell(scheduleDays, now);
  broadcastNextBell();
  if (!nextBell) return;

  // setTimeout overflows above 2^31-1 ms (~24.8 days); the watchdog re-arms.
  const delay = Math.min(Math.max(nextBell.at.getTime() - now.getTime(), 0), 2147483647);
  bellTimer = setTimeout(fireDueBells, delay);
}

/**
 * Play every bell that became due since the last check (normal case: one).
 * Uses a grace window so a bell is not lost when the machine was asleep.
 */
function fireDueBells() {
  bellTimer = null;
  const now = new Date();
  const from = new Date(now.getTime() - BELL_GRACE_MS);
  const due = core.findBellsBetween(scheduleDays, from, now);

  for (const entry of due) {
    const key = bellKey(entry);
    if (playedKeys.has(key)) continue;
    playedKeys.add(key);
    playBell(entry);
  }

  // Keep the dedupe set from growing forever.
  if (playedKeys.size > 500) {
    const cutoff = from.getTime() - 24 * 60 * 60 * 1000;
    for (const key of playedKeys) {
      if (Number(key.split("|")[0]) < cutoff) playedKeys.delete(key);
    }
  }

  reschedule();
}

function playBell(entry) {
  log("bell:", core.formatTime(entry.at.getHours(), entry.at.getMinutes()), entry.soundfile);
  if (!mainWindow || mainWindow.isDestroyed()) {
    // The window is the audio host; recreate it hidden so bells keep working.
    createWindow({ hidden: true });
  }
  const payload = {
    soundfile: entry.soundfile,
    volume: scheduleUi.volume,
    at: entry.at.toISOString(),
  };
  // The renderer may still be loading right after a (re)create.
  if (mainWindow && mainWindow.webContents.isLoading()) {
    mainWindow.webContents.once("did-finish-load", () => sendToRenderer("bell:play", payload));
  } else {
    sendToRenderer("bell:play", payload);
  }
  sendToRenderer("bell:played", describeBell(entry));
}

/** Watchdog: catches sleep/wake, clock changes and long setTimeout overflows. */
function startWatchdog() {
  if (watchdog) clearInterval(watchdog);
  watchdog = setInterval(() => {
    const now = Date.now();
    if (nextBell && nextBell.at.getTime() <= now) {
      fireDueBells();
      return;
    }
    if (!nextBell) {
      reschedule();
      return;
    }
    // Clock jumped (DST / manual change) — recompute if we are far off.
    const drift = nextBell.at.getTime() - now;
    if (drift > 25 * 60 * 60 * 1000) reschedule();
  }, WATCHDOG_MS);
}

function setSchedule(days, ui) {
  scheduleDays = core.normalizeDays(days);
  scheduleUi = core.normalizeUi(ui);
  playedKeys.clear();
  reschedule();
}

// ---------------------------------------------------------------- ipc

function registerIpc() {
  ipcMain.handle("app:info", () => ({
    name: APP_NAME,
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    isDev,
    startHidden,
    paths: paths(),
    openAtLogin: app.getLoginItemSettings().openAtLogin,
  }));

  ipcMain.handle("state:load", async () => {
    const state = await loadInitialState();
    setSchedule(state.days, state.ui);
    return { ...state, sounds: listSoundEntries(), nextBell: describeBell(nextBell) };
  });

  ipcMain.handle("settings:save", async (_event, payload) => {
    try {
      const days = core.normalizeDays(payload && payload.days);
      const ui = core.normalizeUi(payload && payload.ui);
      const result = await saveSettings(days, ui);
      setSchedule(days, ui);
      rendererDirty = false;
      if (pendingCloseAfterSave) {
        pendingCloseAfterSave = false;
        quitApp();
      }
      return { ok: true, ...result };
    } catch (err) {
      log("save failed:", err.message);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("settings:open", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "باز کردن فایل برنامه‌ریزی",
      properties: ["openFile"],
      filters: [
        { name: "برنامه‌ریزی زنگ", extensions: ["json", "txt"] },
        { name: "همه فایل‌ها", extensions: ["*"] },
      ],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
    const file = result.filePaths[0];
    try {
      const text = await readTextFile(file, MAX_SETTINGS_BYTES);
      const parsed = core.parseSettingsPayload(text);
      if (parsed.error) return { ok: false, error: "فایل قابل خواندن نیست." };
      await saveSettings(parsed.days, parsed.ui);
      setSchedule(parsed.days, parsed.ui);
      return {
        ok: true,
        path: file,
        days: parsed.days,
        ui: parsed.ui,
        legacy: parsed.legacy,
        nextBell: describeBell(nextBell),
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("settings:save-as", async (_event, payload) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "ذخیره برنامه‌ریزی به نام",
      defaultPath: path.join(app.getPath("documents"), "school-bell-schedule.json"),
      filters: [
        { name: "برنامه‌ریزی زنگ (JSON)", extensions: ["json"] },
        { name: "متن ساده (سازگار با نسخه قدیمی)", extensions: ["txt"] },
      ],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    const file = result.filePath;
    try {
      const days = core.normalizeDays(payload && payload.days);
      const ui = core.normalizeUi(payload && payload.ui);
      const isText = path.extname(file).toLowerCase() === ".txt";
      const text = isText
        ? core.serializeLegacyText(days)
        : JSON.stringify(core.buildSettings(days, ui), null, 2) + "\n";
      await writeFileAtomic(file, text);
      await saveSettings(days, ui);
      setSchedule(days, ui);
      return { ok: true, path: file };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("sounds:list", () => listSoundEntries());

  ipcMain.handle("sounds:import", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "وارد کردن فایل صدا",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "فایل‌های صوتی", extensions: ["mp3", "wav", "ogg", "oga", "opus", "m4a", "aac", "flac", "weba", "webm"] }],
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
    const outcome = await importSoundFiles(result.filePaths);
    return { ok: true, ...outcome, sounds: listSoundEntries() };
  });

  ipcMain.handle("sounds:delete", async (_event, name) => {
    if (!core.isSafeSoundName(name)) return { ok: false, error: "نام فایل نامعتبر است." };
    const target = path.join(paths().sounds, name);
    try {
      await fsp.unlink(target);
      return { ok: true, sounds: listSoundEntries() };
    } catch (err) {
      if (err.code === "ENOENT") {
        return { ok: false, error: "این صدا جزو صداهای داخلی برنامه است و حذف نمی‌شود." };
      }
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("sounds:url", (_event, name) => {
    if (!resolveSoundPath(name)) return null;
    return `${SOUND_PROTOCOL}://sound/${encodeURIComponent(name)}`;
  });

  ipcMain.handle("sounds:reveal", async (_event, name) => {
    const file = resolveSoundPath(name);
    if (!file) return { ok: false };
    shell.showItemInFolder(file);
    return { ok: true };
  });

  ipcMain.handle("app:set-dirty", (_event, value) => {
    rendererDirty = Boolean(value);
    return true;
  });

  ipcMain.handle("app:set-open-at-login", (_event, value) => {
    try {
      applyLoginItem(Boolean(value));
      return { ok: true, openAtLogin: app.getLoginItemSettings().openAtLogin };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("app:open-external", (_event, url) => {
    if (typeof url === "string" && /^https?:\/\//i.test(url)) shell.openExternal(url);
    return true;
  });

  ipcMain.handle("window:hide", () => {
    hideToTray();
    return true;
  });

  ipcMain.handle("app:quit", () => {
    quitApp();
    return true;
  });

  ipcMain.handle("dialog:message", async (_event, options) => {
    const safe = options && typeof options === "object" ? options : {};
    const result = await dialog.showMessageBox(mainWindow, {
      type: ["none", "info", "error", "question", "warning"].includes(safe.type) ? safe.type : "info",
      title: String(safe.title || APP_NAME).slice(0, 200),
      message: String(safe.message || "").slice(0, 2000),
      detail: safe.detail ? String(safe.detail).slice(0, 4000) : undefined,
      buttons: Array.isArray(safe.buttons) && safe.buttons.length ? safe.buttons.map((b) => String(b).slice(0, 80)) : ["باشه"],
      defaultId: 0,
      cancelId: safe.cancelId,
      noLink: true,
    });
    return result.response;
  });
}

// ---------------------------------------------------------------- lifecycle

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());

  protocol.registerSchemesAsPrivileged([
    { scheme: SOUND_PROTOCOL, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);

  app.setAppUserModelId("com.dandelionsystem.schoolbell");

  app.whenReady().then(() => {
    ensureDirs();
    registerSoundProtocol();
    registerIpc();
    buildMenu();
    syncLoginItem();
    // An autostart launch must not steal focus: open straight into the tray.
    createWindow({ hidden: startHidden });
    if (startHidden) createTray();
    startWatchdog();
    // Keep the machine from suspending the app so timers stay accurate.
    try {
      powerBlockerId = powerSaveBlocker.start("prevent-app-suspension");
    } catch (err) {
      log("powerSaveBlocker failed:", err.message);
    }
    if (app.getLoginItemSettings().openAtLogin && !tray) createTray();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWindow();
    });
  });

  app.on("before-quit", () => {
    isQuitting = true;
    if (bellTimer) clearTimeout(bellTimer);
    if (watchdog) clearInterval(watchdog);
    if (powerBlockerId != null && powerSaveBlocker.isStarted(powerBlockerId)) {
      powerSaveBlocker.stop(powerBlockerId);
    }
  });

  app.on("window-all-closed", () => {
    // This is a tray app: the audio host window must survive so bells keep
    // firing. Recreate it hidden and make sure the tray icon exists.
    if (isQuitting) return;
    if (!tray) createTray();
    if (!mainWindow) createWindow({ hidden: true });
  });
}

process.on("uncaughtException", (err) => log("uncaught:", err && err.stack ? err.stack : String(err)));
process.on("unhandledRejection", (err) => log("unhandled rejection:", err && err.stack ? err.stack : String(err)));
