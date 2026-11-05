/*
 * School Bell System - preload bridge
 * -----------------------------------
 * The renderer runs sandboxed with contextIsolation. Only the small, explicit
 * surface below is exposed; no Node.js primitives ever reach the page.
 */
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const listeners = new Map();

function on(channel, callback) {
  if (typeof callback !== "function") return () => {};
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  listeners.set(callback, { channel, handler });
  return () => {
    const entry = listeners.get(callback);
    if (!entry) return;
    ipcRenderer.removeListener(entry.channel, entry.handler);
    listeners.delete(callback);
  };
}

contextBridge.exposeInMainWorld("bellAPI", {
  // metadata + state
  getInfo: () => ipcRenderer.invoke("app:info"),
  loadState: () => ipcRenderer.invoke("state:load"),

  // settings
  saveSettings: (payload) => ipcRenderer.invoke("settings:save", payload),
  openSettingsFile: () => ipcRenderer.invoke("settings:open"),
  saveSettingsAs: (payload) => ipcRenderer.invoke("settings:save-as", payload),

  // sounds
  listSounds: () => ipcRenderer.invoke("sounds:list"),
  importSounds: () => ipcRenderer.invoke("sounds:import"),
  deleteSound: (name) => ipcRenderer.invoke("sounds:delete", name),
  soundUrl: (name) => ipcRenderer.invoke("sounds:url", name),
  revealSound: (name) => ipcRenderer.invoke("sounds:reveal", name),

  // app / window
  setDirty: (value) => ipcRenderer.invoke("app:set-dirty", value),
  setOpenAtLogin: (value) => ipcRenderer.invoke("app:set-open-at-login", value),
  openExternal: (url) => ipcRenderer.invoke("app:open-external", url),
  hideWindow: () => ipcRenderer.invoke("window:hide"),
  quit: () => ipcRenderer.invoke("app:quit"),
  showMessage: (options) => ipcRenderer.invoke("dialog:message", options),

  // main -> renderer events
  onMenuAction: (callback) => on("menu:action", callback),
  onPlayBell: (callback) => on("bell:play", callback),
  onBellPlayed: (callback) => on("bell:played", callback),
  onNextBell: (callback) => on("schedule:next", callback),
});
