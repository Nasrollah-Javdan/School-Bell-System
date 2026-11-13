/*
 * School Bell System — renderer
 * -----------------------------
 * Classic script (no ESM: `file://` blocks module scripts). Everything it
 * needs comes from two globals: `BellCore` (pure logic) and `bellAPI`
 * (the preload bridge). No network, no frameworks.
 */
"use strict";

(function () {
  const core = window.BellCore;
  const api = window.bellAPI;

  if (!core || !api) {
    document.body.textContent = "خطای بارگذاری: بخش‌های داخلی برنامه پیدا نشد.";
    return;
  }

  // ------------------------------------------------------------------ helpers

  const $ = (id) => document.getElementById(id);
  const FA_DIGITS = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];

  /** Latin digits -> Persian digits (display only). */
  function fa(value) {
    return String(value).replace(/\d/g, (d) => FA_DIGITS[Number(d)]);
  }

  function icon(name, cls) {
    return '<svg class="' + (cls || "ico") + '"><use href="#i-' + name + '"/></svg>';
  }

  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const key of Object.keys(props)) {
        const value = props[key];
        if (value == null) continue;
        if (key === "class") node.className = value;
        else if (key === "text") node.textContent = value;
        else if (key === "html") node.innerHTML = value;
        else if (key.startsWith("on") && typeof value === "function") {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (key in node && key !== "list") node[key] = value;
        else node.setAttribute(key, value);
      }
    }
    for (const child of children || []) {
      if (child == null) continue;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  }

  function debounce(fn, wait) {
    let timer = null;
    return function debounced(...args) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn.apply(this, args);
      }, wait);
    };
  }

  // ------------------------------------------------------------------ state

  const state = {
    days: core.emptyDays(),
    ui: core.normalizeUi(null),
    sounds: [],
    currentDay: 1,
    dirty: false,
    filePath: "",
    info: null,
    nextBell: null,
    todayIndex: core.dayIndexFromDate(new Date()),
  };

  const soundUrlCache = new Map();
  let currentAudio = null;
  let audioStopTimer = null;

  // ------------------------------------------------------------------ toast

  const toastEl = $("toast");
  let toastTimer = null;

  function toast(message, kind, options) {
    if (!toastEl) return;
    const opts = options || {};
    toastEl.textContent = message;
    toastEl.className = "toast is-visible" + (kind ? " is-" + kind : "") + (opts.clickable ? " is-clickable" : "");
    if (toastTimer) clearTimeout(toastTimer);
    if (opts.clickable) {
      toastEl.onclick = opts.onClick || null;
    } else {
      toastEl.onclick = null;
    }
    toastTimer = setTimeout(
      () => {
        toastEl.className = "toast";
        toastEl.onclick = null;
      },
      opts.duration || 2600
    );
  }

  function statusMessage(message, kind) {
    const node = $("status-msg");
    if (!node) return;
    node.textContent = message || "";
    node.classList.toggle("is-ok", kind === "ok");
    node.classList.toggle("is-dirty", kind === "warn");
  }

  // ------------------------------------------------------------------ modals

  const modalStack = [];

  function focusables(root) {
    return Array.from(
      root.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter((node) => node.offsetParent !== null || node === document.activeElement);
  }

  function openModal(id) {
    const node = $(id);
    if (!node || !node.hidden) return;
    node.hidden = false;
    const entry = { id, node, previous: document.activeElement };
    modalStack.push(entry);
    const list = focusables(node);
    (list[0] || node.querySelector(".modal-card") || node).focus?.();
    node.addEventListener("keydown", onModalKeydown);
  }

  function closeModal(id) {
    const index = modalStack.findIndex((entry) => entry.id === id);
    if (index === -1) return;
    const [entry] = modalStack.splice(index, 1);
    entry.node.hidden = true;
    entry.node.removeEventListener("keydown", onModalKeydown);
    // A modal closed by Esc / backdrop / [data-close] must still settle its
    // pending promise, otherwise the awaiting code hangs forever.
    if (entry.id === "modal-confirm" && confirmResolver) {
      const resolve = confirmResolver;
      confirmResolver = null;
      resolve(false);
    }
    if (entry.id === "modal-sound" && soundPickResolver) {
      const resolve = soundPickResolver;
      soundPickResolver = null;
      resolve(null);
    }
    if (entry.previous && typeof entry.previous.focus === "function") {
      try {
        entry.previous.focus();
      } catch {
        /* element may be gone */
      }
    }
  }

  function closeTopModal() {
    const top = modalStack[modalStack.length - 1];
    if (!top) return false;
    closeModal(top.id);
    return true;
  }

  function onModalKeydown(event) {
    const top = modalStack[modalStack.length - 1];
    if (!top) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeModal(top.id);
      return;
    }
    if (event.key !== "Tab") return;
    const list = focusables(top.node);
    if (list.length === 0) return;
    const first = list[0];
    const last = list[list.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  document.addEventListener("click", (event) => {
    const closer = event.target.closest("[data-close]");
    if (closer) {
      const modal = closer.closest(".modal");
      if (modal) closeModal(modal.id);
      return;
    }
    if (event.target.classList && event.target.classList.contains("modal")) {
      closeModal(event.target.id);
    }
  });

  // ------------------------------------------------------------------ confirm

  let confirmResolver = null;

  function confirmDialog(options) {
    const opts = options || {};
    $("confirm-title").textContent = opts.title || "تأیید";
    $("confirm-text").textContent = opts.text || "آیا مطمئن هستید؟";
    const ok = $("confirm-ok");
    ok.textContent = opts.okLabel || "تأیید";
    ok.className = "btn " + (opts.danger === false ? "btn-primary" : "btn-danger");
    openModal("modal-confirm");
    return new Promise((resolve) => {
      confirmResolver = resolve;
    });
  }

  function settleConfirm(value) {
    // Take the resolver first: closeModal() would otherwise settle it with false.
    const resolve = confirmResolver;
    confirmResolver = null;
    closeModal("modal-confirm");
    if (resolve) resolve(value);
  }

  $("confirm-ok").addEventListener("click", () => settleConfirm(true));
  $("confirm-cancel").addEventListener("click", () => settleConfirm(false));

  // ------------------------------------------------------------------ theme

  const media = window.matchMedia("(prefers-color-scheme: dark)");

  function resolvedTheme() {
    if (state.ui.theme === "light" || state.ui.theme === "dark") return state.ui.theme;
    return media.matches ? "dark" : "light";
  }

  function applyTheme() {
    const theme = resolvedTheme();
    document.body.dataset.theme = theme;
    const btn = $("btn-theme");
    if (btn) {
      btn.innerHTML = icon(theme === "dark" ? "sun" : "moon") + '<span class="sr-only">تغییر تم</span>';
      btn.title = theme === "dark" ? "تم روشن" : "تم تیره";
    }
    const seg = $("theme-seg");
    if (seg) {
      for (const button of seg.querySelectorAll("[data-theme-value]")) {
        button.setAttribute("aria-pressed", String(button.dataset.themeValue === state.ui.theme));
      }
    }
  }

  media.addEventListener("change", () => {
    if (state.ui.theme === "system") applyTheme();
  });

  // ------------------------------------------------------------------ sounds

  function soundNames() {
    return state.sounds.map((entry) => entry.name);
  }

  function soundEntry(name) {
    return state.sounds.find((entry) => entry.name === name) || null;
  }

  async function getSoundUrl(name) {
    if (!name) return null;
    if (soundUrlCache.has(name)) return soundUrlCache.get(name);
    const url = await api.soundUrl(name);
    if (url) soundUrlCache.set(name, url);
    return url;
  }

  function stopAudio() {
    if (audioStopTimer) {
      clearTimeout(audioStopTimer);
      audioStopTimer = null;
    }
    if (currentAudio) {
      try {
        currentAudio.pause();
        currentAudio.currentTime = 0;
      } catch {
        /* ignore */
      }
      currentAudio = null;
    }
  }

  async function playSound(name, volume) {
    const url = await getSoundUrl(name);
    if (!url) {
      toast("فایل صدا پیدا نشد: " + name, "error");
      return;
    }
    stopAudio();
    const audio = new Audio(url);
    const safeVolume = Number.isFinite(Number(volume)) ? Number(volume) : 0.9;
    audio.volume = Math.min(1, Math.max(0, safeVolume));
    currentAudio = audio;
    audio.addEventListener("ended", () => {
      if (currentAudio === audio) {
        currentAudio = null;
        renderTable();
      }
    });
    try {
      await audio.play();
    } catch (err) {
      toast("پخش صدا ممکن نشد: " + (err && err.message ? err.message : "خطای نامشخص"), "error");
    }
  }

  // ------------------------------------------------------------------ rendering

  function resolvedDay(dayIndex) {
    return core.resolveDay(state.days, dayIndex);
  }

  function daySlotCount(dayIndex) {
    return resolvedDay(dayIndex).slots.length;
  }

  function renderDayList() {
    const list = $("day-list");
    list.textContent = "";
    for (let i = 1; i <= core.NUM_DAYS; i++) {
      const day = state.days[i];
      const count = daySlotCount(i);
      const isToday = state.todayIndex === i;
      const button = el("button", {
        type: "button",
        class: "day-btn",
        "aria-current": String(state.currentDay === i),
        "data-day": String(i),
        onclick: () => selectDay(i),
      });
      button.appendChild(el("span", { class: "day-name", text: core.dayName(i) }));
      if (isToday) button.appendChild(el("span", { class: "dot", title: "امروز" }));
      if (day.type !== "custom") {
        button.appendChild(el("span", { class: "link-ico", html: icon("open", "link-ico") }));
        button.title = "از برنامهٔ " + core.dayName(Number(day.type)) + " استفاده می‌کند";
      }
      if (core.isWeekend(i) && day.type === "custom" && count === 0) {
        button.appendChild(el("span", { class: "badge-off", text: "تعطیل" }));
      }
      button.appendChild(el("span", { class: "count", text: fa(count) }));
      list.appendChild(button);
    }
  }

  function renderTypeSelect() {
    const select = $("schedule-type");
    const day = state.days[state.currentDay];
    select.textContent = "";
    select.appendChild(el("option", { value: "custom", text: "برنامهٔ اختصاصی این روز" }));
    for (let i = 1; i <= core.NUM_DAYS; i++) {
      if (i === state.currentDay) continue;
      select.appendChild(el("option", { value: String(i), text: "مثل " + core.dayName(i) }));
    }
    select.value = day.type;
  }

  function soundOptions(select, selected) {
    select.textContent = "";
    select.appendChild(el("option", { value: "", text: "— انتخاب صدا —" }));
    const names = soundNames();
    if (selected && names.indexOf(selected) === -1) {
      select.appendChild(el("option", { value: selected, text: selected + " (پیدا نشد)" }));
    }
    const groups = [
      { label: "صداهای داخلی", items: state.sounds.filter((s) => s.builtin) },
      { label: "صداهای وارد‌شده", items: state.sounds.filter((s) => !s.builtin) },
    ];
    for (const group of groups) {
      if (group.items.length === 0) continue;
      const optgroup = el("optgroup", { label: group.label });
      for (const entry of group.items) {
        optgroup.appendChild(el("option", { value: entry.name, text: entry.name }));
      }
      select.appendChild(optgroup);
    }
    select.value = selected || "";
  }

  function renderTable() {
    const body = $("schedule-body");
    const empty = $("empty-state");
    const table = $("schedule-table");
    const dayIndex = state.currentDay;
    const resolved = resolvedDay(dayIndex);
    const inherited = resolved.inherited;
    const slots = resolved.slots;
    const duplicates = inherited ? [] : core.findDuplicateTimes(slots);

    body.textContent = "";
    const hasRows = slots.length > 0;
    empty.hidden = hasRows;
    table.hidden = !hasRows;

    slots.forEach((slot, index) => {
      const timeText = core.slotTime(slot);
      const isDuplicate = duplicates.indexOf(timeText) !== -1;
      const missing = !slot.soundfile || !soundEntry(slot.soundfile);
      const row = el("tr", { class: isDuplicate ? "is-dup" : null, "data-index": String(index) });

      // --- time
      const timeCell = el("td", { class: "col-time" });
      const timeInput = el("input", {
        type: "text",
        class: "time-input",
        inputmode: "numeric",
        maxlength: "5",
        dir: "ltr",
        placeholder: "HH:MM",
        autocomplete: "off",
        value: timeText,
        disabled: inherited,
        "aria-label": "ساعت زنگ " + fa(index + 1),
      });
      timeInput.addEventListener("focus", () => timeInput.select());
      timeInput.addEventListener("input", () => {
        // 24-hour entry: digits only, colon inserted automatically (1230 -> 12:30)
        const d = timeInput.value
          .replace(/[\u06F0-\u06F9]/g, (c) => String(c.charCodeAt(0) - 0x06F0))
          .replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - 0x0660))
          .replace(/\D/g, "")
          .slice(0, 4);
        timeInput.value = d.length > 2 ? d.slice(0, 2) + ":" + d.slice(2) : d;
      });
      timeInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") timeInput.blur();
      });
      timeInput.addEventListener("change", () => {
        let raw = timeInput.value.trim();
        if (/^\d{3,4}$/.test(raw)) raw = raw.slice(0, -2) + ":" + raw.slice(-2);
        const parsed = core.parseTime(raw);
        if (!parsed) {
          timeInput.value = timeText;
          toast("ساعت نامعتبر است. قالب درست: ۰۷:۳۰", "error");
          return;
        }
        slot.hour = parsed.hour;
        slot.minute = parsed.minute;
        const ownerDay = state.days[state.currentDay];
        if (ownerDay && ownerDay.slots.indexOf(slot) !== -1) {
          ownerDay.slots = core.sortSlots(ownerDay.slots);
        }
        markDirty();
        renderTable();
        renderDayList();
        renderChips();
      });
      timeCell.appendChild(timeInput);
      if (isDuplicate) {
        timeCell.appendChild(
          el("span", { class: "time-warn", title: "این ساعت تکراری است", html: icon("warn") })
        );
      }
      row.appendChild(timeCell);

      // --- sound
      const soundCell = el("td", { class: "col-sound" });
      const wrap = el("div", { class: "sound-cell" });
      const select = el("select", {
        class: "select" + (missing ? " is-missing" : ""),
        disabled: inherited,
        "aria-label": "صدای زنگ " + fa(index + 1),
      });
      soundOptions(select, slot.soundfile);
      select.addEventListener("change", () => {
        slot.soundfile = select.value;
        markDirty();
        renderTable();
        renderDayList();
        renderChips();
      });
      wrap.appendChild(select);

      const preview = el("button", {
        type: "button",
        class: "icon-btn",
        title: "پخش آزمایشی",
        "aria-label": "پخش آزمایشی صدا",
        html: icon(currentAudio && !currentAudio.paused ? "stop" : "play"),
        onclick: async () => {
          if (currentAudio && !currentAudio.paused) {
            stopAudio();
            renderTable();
            return;
          }
          if (!slot.soundfile) {
            toast("اول یک صدا انتخاب کنید.", "warn");
            return;
          }
          await playSound(slot.soundfile, state.ui.volume);
          renderTable();
        },
      });
      wrap.appendChild(preview);
      const musicChk = el("input", { type: "checkbox", disabled: inherited });
      musicChk.checked = !!slot.music;
      musicChk.addEventListener("change", () => {
        if (musicChk.checked) slot.music = true;
        else delete slot.music;
        markDirty();
      });
      wrap.appendChild(
        el("label", { class: "music-chk", title: "پخش موسیقی بعد از این زنگ" }, [musicChk, document.createTextNode("🎵 موسیقی")])
      );
      wrap.appendChild(
        el("button", {
          type: "button",
          class: "icon-btn",
          title: "مرور و مدیریت صداها",
          "aria-label": "مرور صداها",
          disabled: inherited,
          html: icon("folder"),
          onclick: async () => {
            const picked = await pickSound(slot.soundfile);
            if (!picked) return;
            slot.soundfile = picked;
            markDirty();
            renderTable();
            renderDayList();
            renderChips();
          },
        })
      );
      soundCell.appendChild(wrap);
      row.appendChild(soundCell);

      // --- actions
      const actions = el("td", { class: "col-actions" });
      const actionWrap = el("div", { class: "row-actions" });
      actionWrap.appendChild(
        el("button", {
          type: "button",
          class: "icon-btn danger",
          title: "حذف نوبت",
          "aria-label": "حذف نوبت",
          disabled: inherited,
          html: icon("trash"),
          onclick: () => removeSlot(index),
        })
      );
      actions.appendChild(actionWrap);
      row.appendChild(actions);

      body.appendChild(row);
    });

    // header / subtitle
    $("day-title").textContent = core.dayName(dayIndex);
    const subtitle = $("day-subtitle");
    if (inherited) {
      subtitle.textContent = "این روز از برنامهٔ " + core.dayName(resolved.dayIndex) + " استفاده می‌کند — برای ویرایش، آن روز را باز کنید.";
    } else if (slots.length === 0) {
      subtitle.textContent = "برنامهٔ اختصاصی این روز — هنوز خالی است.";
    } else {
      subtitle.textContent = "برنامهٔ اختصاصی این روز — " + fa(slots.length) + " نوبت.";
    }

    const addButtons = [$("btn-add"), $("btn-add-empty")];
    for (const button of addButtons) {
      if (!button) continue;
      button.disabled = inherited;
      button.title = inherited ? "این روز برنامهٔ روز دیگری را دنبال می‌کند." : "";
    }
    renderChips(duplicates);
  }

  function renderChips(duplicates) {
    const dayIndex = state.currentDay;
    const resolved = resolvedDay(dayIndex);
    const slots = resolved.slots;
    const dupes = duplicates || (resolved.inherited ? [] : core.findDuplicateTimes(slots));
    $("chip-count").textContent = fa(slots.length) + " نوبت";
    const chip = $("chip-dupes");
    if (dupes.length > 0) {
      chip.hidden = false;
      $("chip-dupes-text").textContent = fa(dupes.length) + " ساعت تکراری";
    } else {
      chip.hidden = true;
    }
  }

  function renderStatus() {
    const file = $("status-file");
    const name = state.filePath ? state.filePath.split(/[\\/]/).pop() : "ذخیره‌نشده";
    file.innerHTML = icon("save") + "<span></span>";
    file.lastElementChild.textContent = name + (state.dirty ? " •" : "");
    file.classList.toggle("is-dirty", state.dirty);
    file.title = state.filePath || "برنامه‌ریزی هنوز در فایل ذخیره نشده است";
    $("btn-save").disabled = false;
    $("btn-save").classList.toggle("btn-primary", state.dirty);
    $("btn-save").classList.toggle("btn-ghost", !state.dirty);
  }

  function renderAll() {
    renderDayList();
    renderTypeSelect();
    renderTable();
    renderStatus();
    renderNextBell();
  }

  // ------------------------------------------------------------------ next bell

  function renderNextBell() {
    const node = $("status-next");
    if (!node) return;
    const target = state.nextBell && state.nextBell.at ? new Date(state.nextBell.at) : null;
    if (!target || Number.isNaN(target.getTime())) {
      node.innerHTML = icon("clock") + "<span>زنگی برنامه‌ریزی نشده</span>";
      return;
    }
    const now = new Date();
    const diff = target.getTime() - now.getTime();
    const time = core.formatTime(target.getHours(), target.getMinutes());
    let label = "زنگ بعدی: " + fa(time);
    if (diff > 0 && diff < 24 * 60 * 60 * 1000) {
      const totalMinutes = Math.floor(diff / 60000);
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      const parts = [];
      if (hours > 0) parts.push(fa(hours) + " ساعت");
      if (minutes > 0 || hours === 0) parts.push(fa(minutes) + " دقیقه");
      label += " — " + parts.join(" و ") + " دیگر";
    } else if (diff <= 0) {
      label = "زنگ بعدی: " + fa(time);
    }
    const isToday = state.nextBell.dayIndex === state.todayIndex;
    if (!isToday && state.nextBell.dayIndex) {
      label += " (" + core.dayName(state.nextBell.dayIndex) + ")";
    }
    if (state.nextBell.inherited) label += " • از روز دیگر";
    node.innerHTML = icon("clock") + "<span></span>";
    node.lastElementChild.textContent = label;
  }

  setInterval(renderNextBell, 1000);

  // ------------------------------------------------------------------ mutations

  function markDirty() {
    if (state.dirty) return;
    state.dirty = true;
    api.setDirty(true);
    renderStatus();
  }

  function selectDay(dayIndex) {
    if (dayIndex === state.currentDay) return;
    state.currentDay = dayIndex;
    state.ui.lastDay = dayIndex;
    renderAll();
    persistUi();
  }

  function addSlot() {
    const resolved = resolvedDay(state.currentDay);
    if (resolved.inherited) {
      toast("این روز برنامهٔ روز دیگری را دنبال می‌کند.", "warn");
      return;
    }
    const day = state.days[state.currentDay];
    if (day.slots.length >= core.MAX_SLOTS_PER_DAY) {
      toast("حداکثر " + fa(core.MAX_SLOTS_PER_DAY) + " نوبت برای هر روز مجاز است.", "warn");
      return;
    }
    // Suggest a sensible time: one hour after the last slot, or 07:30.
    let hour = 7;
    let minute = 30;
    if (day.slots.length > 0) {
      const last = core.sortSlots(day.slots)[day.slots.length - 1];
      const total = Math.min(last.hour * 60 + last.minute + 60, 23 * 60 + 55);
      hour = Math.floor(total / 60);
      minute = total % 60;
    }
    day.slots.push({ hour, minute, soundfile: soundNames()[0] || "" });
    day.slots = core.sortSlots(day.slots);
    markDirty();
    renderAll();
    // focus the new row's time input
    const rows = $("schedule-body").querySelectorAll("tr");
    const target = rows[rows.length - 1];
    if (target) {
      const input = target.querySelector("input.time-input");
      if (input) input.focus();
    }
  }

  function removeSlot(index) {
    const day = state.days[state.currentDay];
    if (!day || !day.slots[index]) return;
    day.slots.splice(index, 1);
    markDirty();
    renderAll();
    toast("نوبت حذف شد.");
  }

  // ------------------------------------------------------------------ save / open

  function payload() {
    return { days: state.days, ui: state.ui };
  }

  async function save() {
    const result = await api.saveSettings(payload());
    if (!result || !result.ok) {
      toast("ذخیره ناموفق بود: " + ((result && result.error) || "خطای نامشخص"), "error");
      return false;
    }
    state.dirty = false;
    state.filePath = result.file || state.filePath;
    api.setDirty(false);
    renderStatus();
    statusMessage("ذخیره شد.", "ok");
    toast("برنامه‌ریزی ذخیره شد.");
    return true;
  }

  async function saveAs() {
    const result = await api.saveSettingsAs(payload());
    if (!result || !result.ok) {
      if (result && result.canceled) return false;
      toast("ذخیره ناموفق بود: " + ((result && result.error) || "خطای نامشخص"), "error");
      return false;
    }
    state.dirty = false;
    state.filePath = result.path;
    api.setDirty(false);
    renderStatus();
    toast("فایل ذخیره شد: " + result.path.split(/[\\/]/).pop());
    return true;
  }

  async function openFile() {
    if (state.dirty) {
      const ok = await confirmDialog({
        title: "تغییرات ذخیره نشده",
        text: "تغییرات فعلی ذخیره نشده‌اند. با باز کردن فایل جدید از دست می‌روند. ادامه می‌دهید؟",
        okLabel: "ادامه",
      });
      if (!ok) return;
    }
    const result = await api.openSettingsFile();
    if (!result || !result.ok) {
      if (result && result.canceled) return;
      toast("باز کردن فایل ناموفق بود: " + ((result && result.error) || "خطای نامشخص"), "error");
      return;
    }
    state.days = core.normalizeDays(result.days);
    state.ui = core.normalizeUi(result.ui);
    state.filePath = result.path;
    state.dirty = false;
    state.currentDay = state.ui.lastDay;
    state.nextBell = result.nextBell || null;
    api.setDirty(false);
    applyTheme();
    renderAll();
    toast(result.legacy ? "فایل قدیمی با موفقیت تبدیل شد." : "برنامه‌ریزی بارگذاری شد.");
  }

  // ------------------------------------------------------------------ sounds UI

  async function refreshSounds() {
    state.sounds = (await api.listSounds()) || [];
    soundUrlCache.clear();
  }

  async function importSounds() {
    const result = await api.importSounds();
    if (!result || !result.ok) {
      if (result && result.canceled) return;
      toast("وارد کردن صدا ناموفق بود.", "error");
      return;
    }
    await refreshSounds();
    renderTable();
    if (result.imported && result.imported.length) {
      toast(fa(result.imported.length) + " فایل صدا اضافه شد.");
    }
    if (result.skipped && result.skipped.length) {
      toast(fa(result.skipped.length) + " فایل رد شد (قالب پشتیبانی نمی‌شود یا خیلی بزرگ است).", "warn", {
        duration: 4200,
      });
    }
  }

  // ------------------------------------------------------------------ sound picker

  let soundPickResolver = null;
  let soundPickSelected = "";

  function renderSoundList(filter) {
    const list = $("sound-list");
    const query = String(filter || "").trim().toLowerCase();
    const items = state.sounds.filter((entry) => !query || entry.name.toLowerCase().includes(query));
    list.textContent = "";

    if (items.length === 0) {
      list.appendChild(el("li", { class: "s-empty", text: query ? "صدایی با این نام پیدا نشد." : "هنوز صدایی موجود نیست." }));
      $("btn-sound-choose").disabled = true;
      return;
    }

    for (const entry of items) {
      const li = el("li", {
        "aria-selected": String(entry.name === soundPickSelected),
        "data-name": entry.name,
        onclick: () => {
          soundPickSelected = entry.name;
          renderSoundList($("sound-search").value);
        },
        ondblclick: () => {
          soundPickSelected = entry.name;
          settleSoundPick(entry.name);
        },
      });
      li.appendChild(el("span", { class: "s-name", text: entry.name }));
      li.appendChild(el("span", { class: "s-tag", text: entry.builtin ? "داخلی" : "وارد‌شده" }));
      li.appendChild(
        el("button", {
          type: "button",
          class: "icon-btn",
          title: "پخش",
          "aria-label": "پخش " + entry.name,
          html: icon("play"),
          onclick: (event) => {
            event.stopPropagation();
            playSound(entry.name, state.ui.volume);
          },
        })
      );
      if (!entry.builtin) {
        li.appendChild(
          el("button", {
            type: "button",
            class: "icon-btn danger",
            title: "حذف فایل",
            "aria-label": "حذف " + entry.name,
            html: icon("trash"),
            onclick: async (event) => {
              event.stopPropagation();
              const ok = await confirmDialog({
                title: "حذف صدا",
                text: "فایل «" + entry.name + "» حذف شود؟ نوبت‌هایی که از آن استفاده می‌کنند بی‌صدا می‌شوند.",
                okLabel: "حذف",
              });
              if (!ok) return;
              const result = await api.deleteSound(entry.name);
              if (!result || !result.ok) {
                toast((result && result.error) || "حذف ناموفق بود.", "error");
                return;
              }
              await refreshSounds();
              renderSoundList($("sound-search").value);
              renderTable();
              toast("صدا حذف شد.");
            },
          })
        );
      }
      list.appendChild(li);
    }
    $("btn-sound-choose").disabled = !soundPickSelected;
  }

  function settleSoundPick(name) {
    // Take the resolver first: closeModal() would otherwise settle it with null.
    const resolve = soundPickResolver;
    soundPickResolver = null;
    closeModal("modal-sound");
    if (resolve) resolve(name);
  }

  function pickSound(current) {
    soundPickSelected = current || "";
    $("sound-search").value = "";
    renderSoundList("");
    openModal("modal-sound");
    return new Promise((resolve) => {
      soundPickResolver = resolve;
    });
  }

  $("btn-sound-choose").addEventListener("click", () => {
    if (soundPickSelected) settleSoundPick(soundPickSelected);
  });
  $("sound-search").addEventListener("input", (event) => renderSoundList(event.target.value));
  $("btn-sound-import").addEventListener("click", async () => {
    await importSounds();
    renderSoundList($("sound-search").value);
  });
  $("btn-sound-folder").addEventListener("click", async () => {
    const name = soundPickSelected || soundNames()[0];
    if (name) await api.revealSound(name);
    else toast("هنوز صدایی برای نمایش وجود ندارد.", "warn");
  });

  // ------------------------------------------------------------------ settings UI

  function syncSettingsUi() {
    initMusicPanel();
    $("volume").value = String(Math.round(state.ui.volume * 100));
    $("volume-value").textContent = fa(Math.round(state.ui.volume * 100)) + "٪";
    $("open-at-login").checked = Boolean(state.info && state.info.openAtLogin);
    $("data-path").textContent = (state.info && state.info.paths && state.info.paths.data) || "—";
    applyTheme();
  }

  const persistUi = debounce(async () => {
    if (state.dirty) return; // an explicit save will persist it
    const result = await api.saveSettings(payload());
    if (result && result.ok) {
      state.filePath = result.file || state.filePath;
      renderStatus();
    }
  }, 500);

  $("theme-seg").addEventListener("click", (event) => {
    const button = event.target.closest("[data-theme-value]");
    if (!button) return;
    state.ui.theme = button.dataset.themeValue;
    applyTheme();
    persistUi();
  });

  $("btn-theme").addEventListener("click", () => {
    state.ui.theme = resolvedTheme() === "dark" ? "light" : "dark";
    applyTheme();
    persistUi();
  });

  $("volume").addEventListener("input", (event) => {
    const value = Number(event.target.value);
    state.ui.volume = Math.min(1, Math.max(0, value / 100));
    $("volume-value").textContent = fa(value) + "٪";
    if (currentAudio) currentAudio.volume = state.ui.volume;
    persistUi();
  });

  $("volume").addEventListener("change", () => {
    if (currentAudio) return;
    testBell();
  });

  function testBell() {
    if (currentAudio) {
      stopAudio();
      renderTable();
      return;
    }
    const slots = resolvedDay(state.currentDay).slots || [];
    let slot = slots.find((s) => s.soundfile);
    if (!slot) {
      for (let d = 1; d <= 7 && !slot; d++) {
        slot = (resolvedDay(d).slots || []).find((s) => s.soundfile);
      }
    }
    if (!slot) {
      toast("هیچ نوبتی با صدا برای تست وجود ندارد.", "warn");
      return;
    }
    playSound(slot.soundfile, state.ui.volume);
  }
  $("btn-test-bell").addEventListener("click", testBell);

  $("open-at-login").addEventListener("change", async (event) => {
    const result = await api.setOpenAtLogin(event.target.checked);
    if (!result || !result.ok) {
      event.target.checked = !event.target.checked;
      toast("تغییر تنظیم اجرای خودکار ممکن نشد.", "error");
      return;
    }
    if (state.info) state.info.openAtLogin = result.openAtLogin;
    toast(
      result.openAtLogin
        ? "اجرای خودکار فعال شد؛ دفعهٔ بعد برنامه کمینه در سینی سیستم بالا می‌آید."
        : "اجرای خودکار غیرفعال شد."
    );
  });

  $("btn-settings").addEventListener("click", () => {
    syncSettingsUi();
    openModal("modal-settings");
  });

  // ------------------------------------------------------------------ about / help

  $("btn-help").addEventListener("click", () => openModal("modal-help"));

  async function showAbout() {
    if (state.info) {
      $("about-version").textContent = state.info.version || "—";
      $("about-engine").textContent =
        "Electron " + (state.info.electron || "?") + " / Chromium " + (state.info.chrome || "?");
    }
    openModal("modal-about");
  }

  $("btn-open-site").addEventListener("click", () => {
    api.openExternal("https://github.com/dandelion-system/school-bell-system");
  });

  // ------------------------------------------------------------------ toolbar wiring

  $("btn-add").addEventListener("click", addSlot);
  $("btn-add-empty").addEventListener("click", addSlot);
  $("btn-import").addEventListener("click", importSounds);
  $("btn-save").addEventListener("click", save);
  $("btn-open").addEventListener("click", openFile);

  $("schedule-type").addEventListener("change", (event) => {
    const value = event.target.value;
    state.days[state.currentDay].type = core.normalizeDayType(value, state.currentDay);
    markDirty();
    renderAll();
  });

  // ------------------------------------------------------------------ menu + shortcuts

  api.onMenuAction(async (action) => {
    switch (action) {
      case "open":
        await openFile();
        break;
      case "save":
        await save();
        break;
      case "save-as":
        await saveAs();
        break;
      case "import-sound":
        await importSounds();
        break;
      case "help":
        openModal("modal-help");
        break;
      case "about":
        await showAbout();
        break;
      default:
        break;
    }
  });

  document.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    if (event.key === "Escape") {
      if (closeTopModal()) {
        event.preventDefault();
        return;
      }
      if (currentAudio) {
        stopAudio();
        renderTable();
      }
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (modalStack.length > 0) return;
    if (key === "s") {
      event.preventDefault();
      if (event.shiftKey) saveAs();
      else save();
    } else if (key === "o") {
      event.preventDefault();
      openFile();
    } else if (key === "n") {
      event.preventDefault();
      addSlot();
    } else if (key === "f") {
      event.preventDefault();
      openModal("modal-sound");
      renderSoundList("");
      $("sound-search").focus();
    }
  });

  // ------------------------------------------------------------------ bell playback

  // ------------------------------------------------------------------ music after bell

  const FADE_MS = 5000;
  const MAX_MUSIC_MS = 10 * 60 * 1000;
  let musicAudio = null;
  let musicToken = 0;
  let musicTimers = [];

  function stopMusic() {
    musicToken++;
    musicTimers.forEach(clearTimeout);
    musicTimers = [];
    if (musicAudio) {
      try {
        musicAudio.pause();
      } catch {
        /* ignore */
      }
      musicAudio = null;
    }
  }

  function fadeOutMusic(token) {
    const audio = musicAudio;
    if (!audio || token !== musicToken) return;
    const start = audio.volume;
    const steps = 20;
    let n = 0;
    const iv = setInterval(() => {
      n++;
      if (token !== musicToken || n >= steps) {
        clearInterval(iv);
        if (token === musicToken) stopMusic();
        return;
      }
      audio.volume = Math.max(0, start * (1 - n / steps));
    }, FADE_MS / steps);
  }

  async function startMusic(bellAt, bellAudio) {
    const cfg = state.ui.music;
    if (!cfg || !cfg.enabled) return;
    const files = cfg.files.filter((f) => soundNames().indexOf(f) !== -1);
    if (!files.length) return;
    stopMusic();
    const token = musicToken;
    // wait for the bell to finish
    if (bellAudio && !bellAudio.paused && !bellAudio.ended) {
      await new Promise((resolve) => {
        bellAudio.addEventListener("ended", resolve, { once: true });
        bellAudio.addEventListener("pause", resolve, { once: true });
      });
    }
    if (token !== musicToken) return;
    // end time: next scheduled bell minus fade, otherwise a 10 minute cap
    const next = core.findNextBell(state.days, new Date());
    let stopIn = MAX_MUSIC_MS;
    if (next) stopIn = Math.min(stopIn, next.at.getTime() - Date.now() - FADE_MS);
    if (stopIn < 3000) return;
    musicTimers.push(setTimeout(() => fadeOutMusic(token), stopIn));
    let order = [];
    const playNext = async () => {
      if (token !== musicToken) return;
      if (!order.length) {
        order = files.slice();
        if (cfg.shuffle) order.sort(() => Math.random() - 0.5);
      }
      const url = await getSoundUrl(order.shift());
      if (token !== musicToken) return;
      if (!url) return playNext();
      const audio = new Audio(url);
      audio.volume = state.ui.volume;
      musicAudio = audio;
      audio.addEventListener("ended", playNext);
      audio.addEventListener("error", () => setTimeout(playNext, 1000));
      try {
        await audio.play();
      } catch {
        /* ignore */
      }
    };
    playNext();
  }

  function initMusicPanel() {
    const cfg = state.ui.music;
    $("music-enabled").checked = cfg.enabled;
    $("music-shuffle").checked = cfg.shuffle;
    const sel = $("music-files");
    sel.textContent = "";
    soundNames().forEach((name) => {
      const o = el("option", { value: name }, [document.createTextNode(name)]);
      o.selected = cfg.files.indexOf(name) !== -1;
      sel.appendChild(o);
    });
    const save = () => {
      cfg.enabled = $("music-enabled").checked;
      cfg.shuffle = $("music-shuffle").checked;
      cfg.files = Array.from(sel.selectedOptions).map((o) => o.value);
      markDirty();
    };
    $("music-enabled").onchange = save;
    $("music-shuffle").onchange = save;
    sel.onchange = save;
    $("music-stop").onclick = stopMusic;
    $("music-panel").ontoggle = () => { if ($("music-panel").open) initMusicPanel(); };
  }

  api.onPlayBell(async (payload) => {
    if (!payload || !payload.soundfile) return;
    stopMusic();
    await playSound(payload.soundfile, payload.volume != null ? payload.volume : state.ui.volume);
    {
      const when = payload.at ? new Date(payload.at) : new Date();
      const day = core.resolveDay(state.days, core.dayIndexFromDate(when));
      const slot = day.slots.find((x) => x.hour === when.getHours() && x.minute === when.getMinutes());
      if (slot && slot.music) startMusic(when, currentAudio);
    }
    const at = payload.at ? new Date(payload.at) : new Date();
    toast("زنگ " + fa(core.formatTime(at.getHours(), at.getMinutes())) + " در حال پخش — برای توقف کلیک کنید", null, {
      duration: 8000,
      clickable: true,
      onClick: () => {
        stopAudio();
        toast("پخش متوقف شد.");
        renderTable();
      },
    });
    renderTable();
  });

  api.onBellPlayed((payload) => {
    if (!payload) return;
    statusMessage("آخرین زنگ پخش‌شده: " + fa(payload.soundfile || ""), "ok");
  });

  api.onNextBell((payload) => {
    state.nextBell = payload || null;
    renderNextBell();
  });

  // ------------------------------------------------------------------ boot

  async function boot() {
    try {
      state.info = await api.getInfo();
    } catch {
      state.info = null;
    }

    const loaded = await api.loadState();
    state.days = core.normalizeDays(loaded.days);
    state.ui = core.normalizeUi(loaded.ui);
    state.sounds = loaded.sounds || [];
    state.filePath = loaded.path || "";
    state.nextBell = loaded.nextBell || null;
    state.currentDay = state.ui.lastDay;
    state.todayIndex = core.dayIndexFromDate(new Date());

    applyTheme();
    syncSettingsUi();
    renderAll();

    if (state.info && state.info.version) {
      $("brand-sub").textContent = "نسخهٔ " + fa(state.info.version);
    }

    const warnings = loaded.warnings || [];
    if (warnings.indexOf("migrated-legacy-settings") !== -1) {
      toast("تنظیمات نسخهٔ قبلی به قالب جدید تبدیل شد.", null, { duration: 4200 });
    }
    if (warnings.indexOf("settings-unreadable") !== -1) {
      toast("فایل تنظیمات خوانده نشد؛ برنامه با تنظیمات خالی شروع شد.", "warn", { duration: 5000 });
    }

    // Re-check "today" when the app has been open across midnight.
    setInterval(() => {
      const today = core.dayIndexFromDate(new Date());
      if (today !== state.todayIndex) {
        state.todayIndex = today;
        renderDayList();
        renderNextBell();
      }
    }, 60000);
  }

  boot().catch((err) => {
    console.error(err);
    toast("خطا در راه‌اندازی برنامه: " + (err && err.message ? err.message : err), "error", { duration: 8000 });
  });
})();
