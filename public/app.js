/* Voice Engine — studio frontend. Vanilla JS, no build step. */
"use strict";

const HEADER = "X-Access-Key";
const KEY_STORAGE = "voice_engine_access_key";
const SAMPLE_SCRIPT =
  "Some stories only work out loud.\n\n" +
  "Take a breath, slow the first line down, and let the last word land before you move on. " +
  "That is the whole trick — the listener needs a moment to follow you.";

const $ = (id) => document.getElementById(id);

const store = {
  get() {
    try { return sessionStorage.getItem(KEY_STORAGE) || ""; } catch (e) { return ""; }
  },
  set(value) {
    try { sessionStorage.setItem(KEY_STORAGE, value); } catch (e) { /* private mode */ }
  },
  clear() {
    try { sessionStorage.removeItem(KEY_STORAGE); } catch (e) { /* private mode */ }
  },
};

const state = {
  key: "",
  maxChars: 4000,
  format: "mp3",
  items: [],
  view: "studio",
  query: "",
  filter: "all",
  current: null,
  currentBlob: null,
  objectUrl: null,
  busy: false,
  startedAt: 0,
  timer: null,
  pendingDelete: null,
  volume: 1,
  lastVolume: 1,
  seeking: false,
  loadedOnce: false,
};

/* ------------------------------------------------------------------ helpers */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function icon(name, className) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon" + (className ? " " + className : ""));
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#i-" + name);
  svg.appendChild(use);
  return svg;
}

function snippet(text, max) {
  const clean = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1).trimEnd() + "…" : clean;
}

function formatBytes(bytes) {
  if (bytes == null) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1048576).toFixed(2) + " MB";
}

function formatClock(seconds) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return minutes + ":" + String(rest).padStart(2, "0");
}

function formatDate(iso) {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return String(iso || "");
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay) return "Today · " + time;
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday · " + time;
  return date.toLocaleDateString([], { month: "short", day: "numeric" }) + " · " + time;
}

function toast(message, kind) {
  const wrap = $("toasts");
  const node = el("div", "toast " + (kind || "info"));
  node.appendChild(icon(kind === "error" ? "alert" : kind === "ok" ? "check" : "wave"));
  node.appendChild(el("span", "", message));
  wrap.appendChild(node);
  while (wrap.children.length > 3) wrap.removeChild(wrap.firstElementChild);
  setTimeout(() => {
    node.classList.add("is-leaving");
    setTimeout(() => node.remove(), 220);
  }, 4200);
}

async function api(path, options) {
  const opts = options || {};
  const headers = Object.assign({}, opts.headers, { [HEADER]: state.key });
  if (opts.body) headers["Content-Type"] = "application/json";
  const response = await fetch(path, Object.assign({}, opts, { headers }));

  let data = null;
  const raw = await response.text();
  if (raw) {
    try { data = JSON.parse(raw); } catch (e) { data = null; }
  }

  if (response.status === 401) {
    lock("Access key rejected. Enter it again.");
    throw new Error("Wrong access key.");
  }
  if (!response.ok) {
    const detail = data && data.detail ? data.detail : "HTTP " + response.status;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return data;
}

/* --------------------------------------------------------------- lock screen */

function lock(message) {
  state.key = "";
  store.clear();
  resetPlayer();
  $("lockError").textContent = message || "";
  $("lock").classList.remove("hidden");
  $("accessKey").value = "";
  $("accessKey").focus();
}

async function unlock(rawKey) {
  const key = (rawKey || "").trim();
  if (!key) {
    $("lockError").textContent = "Enter the access key.";
    return false;
  }

  const button = $("unlockBtn");
  state.key = key;
  button.disabled = true;
  button.textContent = "Checking…";

  try {
    const config = await api("/api/config");
    state.maxChars = Number(config.max_chars) || 4000;
    state.format = (config.format || "mp3").toUpperCase();
  } catch (error) {
    $("lockError").textContent = error.message;
    state.key = "";
    return false;
  } finally {
    button.disabled = false;
    button.textContent = "Unlock studio";
  }

  store.set(key);
  $("lockError").textContent = "";
  $("lock").classList.add("hidden");

  $("formatValue").textContent = state.format;
  $("limitValue").textContent = state.maxChars.toLocaleString() + " chars";

  updateScriptMeta();
  await loadHistory();
  return true;
}

/* -------------------------------------------------------------------- views */

const VIEW_META = {
  studio: { doc: "Voice Engine — Studio" },
  library: { doc: "Library — Voice Engine" },
};

function setView(name, options) {
  const next = VIEW_META[name] ? name : "studio";
  state.view = next;
  $("viewStudio").classList.toggle("hidden", next !== "studio");
  $("viewLibrary").classList.toggle("hidden", next !== "library");

  document.querySelectorAll(".tab").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === next);
  });

  document.title = VIEW_META[next].doc;

  if (!options || options.hash !== false) {
    history.replaceState(null, "", "#" + next);
  }
  if (options && options.focus) $("main").scrollTop = 0;
}

/* ------------------------------------------------------------------- editor */

function updateScriptMeta() {
  const text = $("script").value;
  const length = text.length;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const estimate = Math.max(1, Math.round((words / 150) * 60));

  const counter = $("counter");
  counter.textContent = length.toLocaleString() + " / " + state.maxChars.toLocaleString();
  counter.classList.toggle("is-over", length > state.maxChars);
  $("wordCount").textContent = words + (words === 1 ? " word" : " words");
  $("estimate").textContent = words ? "≈ " + estimate + "s audio" : "≈ 0s audio";

  const fill = $("meterFill");
  const ratio = Math.min(1, length / state.maxChars);
  fill.style.width = (ratio * 100).toFixed(2) + "%";
  fill.classList.toggle("is-over", length > state.maxChars);
}

function insertTag(tag) {
  const area = $("script");
  const start = area.selectionStart ?? area.value.length;
  const end = area.selectionEnd ?? area.value.length;
  area.value = area.value.slice(0, start) + tag + area.value.slice(end);
  const caret = start + tag.length;
  area.focus();
  area.setSelectionRange(caret, caret);
  updateScriptMeta();
}

function setStatus(message, kind) {
  const node = $("status");
  node.textContent = message || "";
  node.className = "status" + (kind ? " " + kind : "");
}

/* ---------------------------------------------------------------- generation */

function startTimer() {
  state.startedAt = Date.now();
  clearInterval(state.timer);
  const tick = () => {
    const seconds = Math.floor((Date.now() - state.startedAt) / 1000);
    setStatus("Rendering audio · " + seconds + "s elapsed");
  };
  tick();
  state.timer = setInterval(tick, 500);
}

async function generate() {
  if (state.busy || !state.key) return;

  const text = $("script").value.trim();
  if (!text) {
    setStatus("Write a script before generating.", "error");
    $("script").focus();
    return;
  }
  if (text.length > state.maxChars) {
    setStatus("Script is over the " + state.maxChars.toLocaleString() + " character limit.", "error");
    return;
  }

  const voice = $("voiceInput").value.trim();
  const instructions = $("instructions").value.trim();
  const body = { text: text };
  if (voice) body.voice = voice;
  if (instructions) body.instructions = instructions;

  state.busy = true;
  $("generateBtn").disabled = true;
  $("generateLabel").textContent = "Rendering…";
  $("genProgress").hidden = false;
  setStatus("");
  startTimer();

  try {
    const item = await api("/api/generate", { method: "POST", body: JSON.stringify(body) });
    setStatus("Ready · " + formatBytes(item.byte_size) + " · rendered in " + ((item.duration_ms || 0) / 1000).toFixed(1) + "s", "ok");
    toast("Audio rendered. Loading the take…", "ok");
    await loadHistory();
    await loadAudio(item, true);
  } catch (error) {
    setStatus(error.message, "error");
    toast(error.message, "error");
    loadHistory().catch(() => { /* status already shown */ });
  } finally {
    clearInterval(state.timer);
    state.timer = null;
    state.busy = false;
    $("generateBtn").disabled = false;
    $("generateLabel").textContent = "Generate audio";
    $("genProgress").hidden = true;
  }
}

/* ---------------------------------------------------------------- playback */

function resetPlayer() {
  const audio = $("audio");
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = null;
  state.current = null;
  state.currentBlob = null;
  $("playerTitle").textContent = "No take loaded";
  $("playerSub").textContent = "Generate audio to start playback";
  $("nowState").textContent = "Playback";
  $("playBtn").disabled = true;
  $("downloadBtn").disabled = true;
  $("player").classList.remove("is-playing");
  $("player").classList.add("is-empty");
  $("timeNow").textContent = "0:00";
  $("timeTotal").textContent = "0:00";
  setSeekProgress(0);
  updateRowIndicators();
}

async function loadAudio(item, autoplay) {
  if (!item || !item.audio_url) {
    toast(item && item.error ? item.error : "This take has no audio.", "error");
    return;
  }

  let response;
  try {
    response = await fetch(item.audio_url, { headers: { [HEADER]: state.key } });
  } catch (error) {
    toast("Network error while loading the audio.", "error");
    return;
  }
  if (response.status === 401) {
    lock("Access key rejected. Enter it again.");
    return;
  }
  if (!response.ok) {
    toast("Could not load the audio (HTTP " + response.status + ").", "error");
    return;
  }

  const blob = await response.blob();
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = URL.createObjectURL(blob);
  state.currentBlob = blob;
  state.current = item;

  const audio = $("audio");
  audio.src = state.objectUrl;
  audio.volume = state.volume;

  $("playerTitle").textContent = snippet(item.text, 90) || "Untitled take";
  $("nowState").textContent = "Ready";
  const meta = [
    item.voice ? item.voice : "default voice",
    formatBytes(item.byte_size),
    formatDate(item.created_at),
  ];
  $("playerSub").textContent = meta.filter(Boolean).join(" · ");
  $("playBtn").disabled = false;
  $("downloadBtn").disabled = false;
  $("player").classList.remove("is-empty");
  $("timeNow").textContent = "0:00";
  $("timeTotal").textContent = "0:00";
  setSeekProgress(0);
  updateRowIndicators();

  if (autoplay) {
    try { await audio.play(); } catch (error) { /* autoplay may need a gesture */ }
  }
}

async function togglePlay() {
  const audio = $("audio");
  if (!state.current) return;
  if (audio.paused) {
    try { await audio.play(); } catch (error) { toast("Playback was blocked by the browser.", "error"); }
  } else {
    audio.pause();
  }
}

function setSeekProgress(ratio) {
  const percent = Math.min(100, Math.max(0, ratio * 100));
  $("seekFill").style.width = percent.toFixed(2) + "%";
  $("seekKnob").style.left = percent.toFixed(2) + "%";
  $("seek").setAttribute("aria-valuenow", Math.round(percent));
}

function seekFromEvent(event) {
  const audio = $("audio");
  const rect = $("seek").getBoundingClientRect();
  if (!rect.width) return;
  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  if (isFinite(audio.duration) && audio.duration > 0) {
    audio.currentTime = ratio * audio.duration;
    setSeekProgress(ratio);
  }
}

function updateVolumeUi() {
  const audio = $("audio");
  const muted = audio.muted || state.volume === 0;
  $("player").classList.toggle("is-muted", muted);
  $("muteBtn").setAttribute("aria-label", muted ? "Unmute" : "Mute");
  $("volume").value = String(state.volume);
  $("volume").style.setProperty("--vol", (state.volume * 100).toFixed(0) + "%");
}

/* ------------------------------------------------------------------- history */

async function loadHistory() {
  if (!state.loadedOnce) {
    renderSkeletons();
  }
  const data = await api("/api/history?limit=200");
  state.items = data.items || [];
  state.loadedOnce = true;

  $("libraryCount").textContent = String(state.items.length);
  renderRecent();
  renderLibrary();
  updateRowIndicators();

  const bytes = state.items.reduce((total, item) => total + (item.byte_size || 0), 0);
  $("librarySub").textContent = state.items.length
    ? state.items.length + (state.items.length === 1 ? " take" : " takes") + " · " + formatBytes(bytes) + " stored"
    : "Every take is saved with its script, settings and audio file.";
}

function renderSkeletons() {
  const list = $("libraryList");
  list.textContent = "";
  for (let i = 0; i < 3; i += 1) list.appendChild(el("div", "skeleton"));
  $("libraryEmpty").hidden = true;
  document.querySelector(".take-table").hidden = false;
}

function renderRecent() {
  const section = $("recentSection");
  const list = $("recentList");
  list.textContent = "";

  const ready = state.items.filter((item) => item.status === "ready").slice(0, 3);
  section.hidden = ready.length === 0;

  ready.forEach((item, index) => {
    const card = el("button", "mini-take");
    card.type = "button";
    card.dataset.id = item.id;
    if (state.current && state.current.id === item.id) card.classList.add("is-current");

    const top = el("div", "mini-take-top");
    top.appendChild(el("span", "mini-no", "Take " + String(index + 1).padStart(2, "0")));
    top.appendChild(el("time", "", formatDate(item.created_at)));

    card.appendChild(top);
    card.appendChild(el("p", "", snippet(item.text, 130)));
    card.addEventListener("click", () => {
      setView("studio");
      loadAudio(item, true).catch(() => {});
    });
    list.appendChild(card);
  });
}

function takeMeta(item) {
  const meta = el("div", "take-sub");
  const add = (text, className) => {
    if (meta.children.length) meta.appendChild(el("span", "dot", "·"));
    meta.appendChild(el("span", className || "", text));
  };

  add(formatDate(item.created_at));
  if (item.status === "failed") {
    add(item.error || "Generation failed", "error");
    return meta;
  }
  if (item.status === "pending") {
    add("Still rendering");
    return meta;
  }
  if (item.duration_ms) add((item.duration_ms / 1000).toFixed(1) + "s render");
  if (item.byte_size) add(formatBytes(item.byte_size));
  if (item.voice) add("voice: " + item.voice);
  return meta;
}

function makeTake(item) {
  const row = el("article", "take");
  row.dataset.id = item.id;
  if (state.current && state.current.id === item.id) row.classList.add("is-current");
  if (item.status === "failed") row.classList.add("is-failed");

  const main = el("div", "take-main");

  const playBtn = el("button", "take-play");
  playBtn.type = "button";
  playBtn.dataset.action = "play";
  playBtn.disabled = !item.audio_url;
  playBtn.setAttribute("aria-label", item.audio_url ? "Play take" : "No audio for this take");
  main.appendChild(playBtn);

  const body = el("div", "take-body");
  body.appendChild(el("p", "take-text", item.text || "Untitled take"));
  body.appendChild(takeMeta(item));
  main.appendChild(body);
  row.appendChild(main);

  const statusClass = item.status === "failed" ? "failed" : item.status === "pending" ? "pending" : "ready";
  const status = el("span", "take-status " + statusClass);
  status.appendChild(el("span", "dot"));
  status.appendChild(el("span", "", statusClass.charAt(0).toUpperCase() + statusClass.slice(1)));
  row.appendChild(status);

  const actions = el("div", "take-actions");
  const action = (name, label, handler, extraClass) => {
    const button = el("button", "icon-btn " + (extraClass || ""));
    button.type = "button";
    button.dataset.action = name;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.appendChild(icon(name));
    button.addEventListener("click", handler);
    actions.appendChild(button);
  };

  if (item.audio_url) {
    action("download", "Download audio", () => downloadItem(item));
  }
  action("copy", "Copy script", () => copyScript(item));
  action("trash", "Delete take", () => askDelete(item), "danger");
  row.appendChild(actions);

  playBtn.addEventListener("click", () => {
    if (state.current && state.current.id === item.id) togglePlay();
    else loadAudio(item, true).catch(() => {});
  });

  return row;
}

function renderLibrary() {
  const list = $("libraryList");
  const empty = $("libraryEmpty");
  list.textContent = "";

  const query = state.query.trim().toLowerCase();
  const filtered = state.items.filter((item) => {
    if (state.filter === "ready" && item.status !== "ready") return false;
    if (state.filter === "failed" && item.status !== "failed") return false;
    if (!query) return true;
    return [item.text, item.voice, item.error, item.status, item.instructions]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
  });

  if (!filtered.length) {
    const filtering = Boolean(query) || state.filter !== "all";
    empty.hidden = false;
    document.querySelector(".take-table").hidden = true;
    $("emptyTitle").textContent = filtering ? "No matching takes" : "No takes yet";
    $("emptyText").textContent = filtering
      ? "Try a different search term or switch the filter back to all."
      : "Generate your first clip and it will show up here.";
    $("emptyAction").textContent = filtering ? "Clear filters" : "Go to studio";
    $("emptyAction").dataset.view = filtering ? "" : "studio";
    $("emptyAction").dataset.action = filtering ? "clear-filters" : "";
    return;
  }

  empty.hidden = true;
  document.querySelector(".take-table").hidden = false;
  const fragment = document.createDocumentFragment();
  filtered.forEach((item) => fragment.appendChild(makeTake(item)));
  list.appendChild(fragment);
}

function updateRowIndicators() {
  const playingId = state.current && !$("audio").paused ? state.current.id : null;

  document.querySelectorAll(".take, .mini-take").forEach((row) => {
    const isCurrent = state.current && row.dataset.id === state.current.id;
    row.classList.toggle("is-current", Boolean(isCurrent));
  });

  document.querySelectorAll('.take [data-action="play"]').forEach((button) => {
    const row = button.closest(".take");
    if (!row) return;
    button.textContent = "";
    const isPlaying = row.dataset.id === playingId;
    button.appendChild(icon(isPlaying ? "pause" : "play", "play"));
    button.setAttribute("aria-label", isPlaying ? "Pause take" : "Play take");
  });
}

/* ------------------------------------------------------------------ actions */

async function downloadItem(item) {
  try {
    let blob = state.current && state.current.id === item.id ? state.currentBlob : null;
    if (!blob) {
      const response = await fetch(item.audio_url, { headers: { [HEADER]: state.key } });
      if (response.status === 401) { lock("Access key rejected. Enter it again."); return; }
      if (!response.ok) throw new Error("HTTP " + response.status);
      blob = await response.blob();
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "voice-engine-" + item.id.slice(0, 8) + "." + (item.format || "mp3");
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast("Download started.", "ok");
  } catch (error) {
    toast("Download failed: " + error.message, "error");
  }
}

async function copyScript(item) {
  try {
    await navigator.clipboard.writeText(item.text || "");
    toast("Script copied to clipboard.", "ok");
  } catch (error) {
    toast("Clipboard is unavailable in this browser.", "error");
  }
}

function askDelete(item) {
  state.pendingDelete = item;
  $("confirmText").textContent =
    "“" + snippet(item.text, 110) + "” will be removed from the library and its audio file deleted from disk.";
  $("confirmDialog").showModal();
}

async function deletePending() {
  const item = state.pendingDelete;
  state.pendingDelete = null;
  if (!item) return;
  try {
    await api("/api/history/" + item.id, { method: "DELETE" });
    if (state.current && state.current.id === item.id) resetPlayer();
    toast("Take deleted.", "ok");
    await loadHistory();
  } catch (error) {
    toast(error.message, "error");
  }
}

/* -------------------------------------------------------------------- wiring */

function bindEvents() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!button.dataset.view) return;
      setView(button.dataset.view, { focus: true });
    });
  });

  $("generateBtn").addEventListener("click", generate);
  $("sampleBtn").addEventListener("click", () => {
    if ($("script").value.trim() && !window.confirm("Replace the current script with the sample?")) return;
    $("script").value = SAMPLE_SCRIPT;
    updateScriptMeta();
    $("script").focus();
  });
  $("clearBtn").addEventListener("click", () => {
    if (!$("script").value) return;
    $("script").value = "";
    updateScriptMeta();
    $("script").focus();
  });
  $("script").addEventListener("input", updateScriptMeta);

  $("directionChips").addEventListener("click", (event) => {
    const chip = event.target.closest("[data-tag]");
    if (chip) insertTag(chip.dataset.tag);
  });

  $("refreshBtn").addEventListener("click", () => {
    loadHistory().then(() => toast("Library refreshed.", "ok")).catch((error) => toast(error.message, "error"));
  });

  $("searchInput").addEventListener("input", (event) => {
    state.query = event.target.value;
    renderLibrary();
    updateRowIndicators();
  });

  document.querySelectorAll("[data-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.filter = button.dataset.filter;
      document.querySelectorAll("[data-filter]").forEach((other) => {
        other.classList.toggle("is-active", other === button);
      });
      renderLibrary();
      updateRowIndicators();
    });
  });

  $("libraryEmpty").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || button.dataset.action !== "clear-filters") return;
    state.query = "";
    state.filter = "all";
    $("searchInput").value = "";
    document.querySelectorAll("[data-filter]").forEach((other) => {
      other.classList.toggle("is-active", other.dataset.filter === "all");
    });
    renderLibrary();
  });

  $("playBtn").addEventListener("click", togglePlay);
  $("downloadBtn").addEventListener("click", () => {
    if (state.current) downloadItem(state.current);
  });

  $("muteBtn").addEventListener("click", () => {
    const audio = $("audio");
    if (audio.muted || state.volume === 0) {
      state.volume = state.lastVolume || 1;
      audio.muted = false;
    } else {
      state.lastVolume = state.volume;
      state.volume = 0;
      audio.muted = true;
    }
    audio.volume = state.volume;
    updateVolumeUi();
  });

  $("volume").addEventListener("input", (event) => {
    state.volume = Number(event.target.value);
    const audio = $("audio");
    audio.volume = state.volume;
    audio.muted = state.volume === 0;
    if (state.volume > 0) state.lastVolume = state.volume;
    updateVolumeUi();
  });

  const seek = $("seek");
  seek.addEventListener("pointerdown", (event) => {
    state.seeking = true;
    seek.setPointerCapture(event.pointerId);
    seekFromEvent(event);
  });
  seek.addEventListener("pointermove", (event) => {
    if (state.seeking) seekFromEvent(event);
  });
  const stopSeeking = () => { state.seeking = false; };
  seek.addEventListener("pointerup", stopSeeking);
  seek.addEventListener("pointercancel", stopSeeking);
  seek.addEventListener("keydown", (event) => {
    const audio = $("audio");
    if (!isFinite(audio.duration)) return;
    if (event.key === "ArrowRight") {
      event.preventDefault();
      audio.currentTime = Math.min(audio.duration, audio.currentTime + 5);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      audio.currentTime = Math.max(0, audio.currentTime - 5);
    }
  });

  const audio = $("audio");
  audio.addEventListener("loadedmetadata", () => {
    $("timeTotal").textContent = formatClock(audio.duration);
  });
  audio.addEventListener("timeupdate", () => {
    const ratio = isFinite(audio.duration) && audio.duration ? audio.currentTime / audio.duration : 0;
    setSeekProgress(ratio);
    $("timeNow").textContent = formatClock(audio.currentTime);
  });
  audio.addEventListener("play", () => {
    $("player").classList.add("is-playing");
    $("nowState").textContent = "Now playing";
    updateRowIndicators();
  });
  audio.addEventListener("pause", () => {
    $("player").classList.remove("is-playing");
    $("nowState").textContent = audio.ended ? "Ended" : "Paused";
    updateRowIndicators();
  });
  audio.addEventListener("ended", () => {
    $("player").classList.remove("is-playing");
    $("nowState").textContent = "Ended";
    setSeekProgress(1);
    updateRowIndicators();
  });
  audio.addEventListener("error", () => {
    if (state.current) toast("The browser could not decode this audio file.", "error");
  });

  $("lockBtn").addEventListener("click", () => {
    lock("");
    toast("Studio locked.", "info");
  });

  $("lockForm").addEventListener("submit", (event) => {
    event.preventDefault();
    unlock($("accessKey").value);
  });
  $("revealBtn").addEventListener("click", () => {
    const input = $("accessKey");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    $("revealBtn").setAttribute("aria-pressed", String(show));
    $("revealBtn").setAttribute("aria-label", show ? "Hide access key" : "Show access key");
    input.focus();
  });

  $("shortcutsBtn").addEventListener("click", () => $("shortcutsDialog").showModal());

  document.querySelectorAll("dialog").forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
      const closer = event.target.closest("[data-close]");
      if (closer) dialog.close();
    });
  });

  $("confirmDelete").addEventListener("click", () => {
    $("confirmDialog").close();
    deletePending();
  });

  document.addEventListener("keydown", (event) => {
    const tag = (event.target.tagName || "").toLowerCase();
    const typing = tag === "input" || tag === "textarea" || tag === "select" || event.target.isContentEditable;

    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      if (!$("lock").classList.contains("hidden")) return;
      generate();
      return;
    }
    if (typing || event.metaKey || event.ctrlKey || event.altKey) return;

    if (event.key === " ") {
      if (state.current && !$("lock").classList.contains("hidden")) {
        event.preventDefault();
        togglePlay();
      }
    } else if (event.key === "/") {
      event.preventDefault();
      setView("library", { focus: true });
      $("searchInput").focus();
    } else if (event.key === "?") {
      event.preventDefault();
      $("shortcutsDialog").showModal();
    } else if (event.key === "1") {
      setView("studio");
    } else if (event.key === "2") {
      setView("library");
    }
  });

  window.addEventListener("hashchange", () => {
    const name = location.hash.replace("#", "");
    if (VIEW_META[name] && name !== state.view) setView(name, { hash: false });
  });
}

/* ---------------------------------------------------------------------- boot */

(async function boot() {
  updateVolumeUi();
  bindEvents();
  updateScriptMeta();
  setView(location.hash.replace("#", "") || "studio", { hash: false });

  state.key = store.get();
  if (state.key) {
    // unlock() leaves the lock screen visible with the error when the key fails.
    await unlock(state.key);
  } else {
    $("accessKey").focus();
  }
})();
