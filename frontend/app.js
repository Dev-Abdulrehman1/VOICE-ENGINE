/* Fish Audio Studio - vanilla JS, no build step. */
const HEADER = "X-Access-Key";
const KEY_STORAGE = "fish_audio_access_key";

const $ = (id) => document.getElementById(id);

const store = {
  get() {
    try { return sessionStorage.getItem(KEY_STORAGE) || ""; } catch (e) { return ""; }
  },
  set(value) {
    try { sessionStorage.setItem(KEY_STORAGE, value); } catch (e) { /* ignore */ }
  },
  clear() {
    try { sessionStorage.removeItem(KEY_STORAGE); } catch (e) { /* ignore */ }
  },
};

const state = {
  key: store.get(),
  model: "",
  maxChars: 4000,
  items: [],
  currentId: null,
  objectUrl: null,
};

/* ---------------- small helpers ---------------- */

function escapeText(value) {
  return String(value == null ? "" : value);
}

function snippet(text, max) {
  const clean = escapeText(text).replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

function formatDate(iso) {
  const date = new Date(iso);
  return isNaN(date.getTime()) ? escapeText(iso) : date.toLocaleString();
}

function formatBytes(bytes) {
  if (bytes == null) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1048576).toFixed(2) + " MB";
}

function setStatus(message, kind) {
  const node = $("status");
  node.textContent = message || "";
  node.className = "status" + (kind ? " " + kind : "");
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

/* ---------------- lock screen ---------------- */

function lock(message) {
  state.key = "";
  store.clear();
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
  state.key = key;
  try {
    const config = await api("/api/config");
    state.model = config.model;
    state.maxChars = config.max_chars;
    $("playerSub").textContent = config.model;
  } catch (error) {
    $("lockError").textContent = error.message;
    return false;
  }
  store.set(key);
  $("lockError").textContent = "";
  $("lock").classList.add("hidden");
  updateCounter();
  await loadHistory();
  return true;
}

/* ---------------- views ---------------- */

function showView(name) {
  $("viewGenerate").classList.toggle("hidden", name !== "generate");
  $("viewHistory").classList.toggle("hidden", name !== "history");
  $("navGenerate").classList.toggle("is-active", name === "generate");
  $("navHistory").classList.toggle("is-active", name === "history");
}

function updateCounter() {
  const length = $("script").value.length;
  const node = $("counter");
  node.textContent = length + " / " + state.maxChars;
  node.style.color = length > state.maxChars ? "var(--danger)" : "";
}

/* ---------------- generate ---------------- */

async function generate() {
  const text = $("script").value.trim();
  if (!text) {
    setStatus("Type a script first.", "error");
    return;
  }
  if (text.length > state.maxChars) {
    setStatus("Script is longer than " + state.maxChars + " characters.", "error");
    return;
  }

  const button = $("generateBtn");
  button.disabled = true;
  button.textContent = "Generating…";
  setStatus("Sending to " + state.model + " — this can take a few seconds.");

  try {
    const item = await api("/api/generate", {
      method: "POST",
      body: JSON.stringify({ text: text }),
    });
    setStatus("Audio ready.", "ok");
    await loadHistory();
    await play(item, true);
  } catch (error) {
    setStatus(error.message, "error");
    loadHistory().catch(function () { /* status already shown */ });
  } finally {
    button.disabled = false;
    button.textContent = "Generate audio";
  }
}

/* ---------------- playback ---------------- */

async function play(item, autoplay) {
  if (!item) return;
  if (!item.audio_url) {
    setStatus(item.error || "This generation produced no audio.", "error");
    return;
  }

  const response = await fetch(item.audio_url, { headers: { [HEADER]: state.key } });
  if (response.status === 401) {
    lock("Access key rejected. Enter it again.");
    return;
  }
  if (!response.ok) {
    setStatus("Could not load the audio file (HTTP " + response.status + ").", "error");
    return;
  }

  const blob = await response.blob();
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = URL.createObjectURL(blob);

  const audio = $("audio");
  audio.src = state.objectUrl;
  state.currentId = item.id;

  $("playerTitle").textContent = snippet(item.text, 80);
  const meta = [state.model, formatDate(item.created_at)];
  if (item.byte_size) meta.push(formatBytes(item.byte_size));
  $("playerSub").textContent = meta.join(" · ");

  renderHistory();
  if (autoplay) {
    try { await audio.play(); } catch (error) { /* user gesture may be required */ }
  }
}

/* ---------------- history ---------------- */

async function loadHistory() {
  const data = await api("/api/history?limit=100");
  state.items = data.items || [];
  $("historyCount").textContent = data.total ? "(" + data.total + ")" : "";
  renderHistory();
}

function renderHistory() {
  const list = $("historyList");
  list.textContent = "";
  $("historyEmpty").classList.toggle("hidden", state.items.length > 0);

  state.items.forEach(function (item) {
    const row = document.createElement("li");
    row.className = "history-item";
    if (item.id === state.currentId) row.classList.add("is-current");
    if (item.status === "failed") row.classList.add("is-failed");

    const info = document.createElement("div");
    const text = document.createElement("p");
    text.className = "history-text";
    text.textContent = snippet(item.text, 160);
    info.appendChild(text);

    const meta = document.createElement("div");
    meta.className = "history-meta";
    if (item.status === "failed") {
      meta.classList.add("error");
      meta.textContent = item.error || "Generation failed";
    } else if (item.status === "pending") {
      meta.textContent = "Pending…";
    } else {
      const parts = [formatDate(item.created_at), formatBytes(item.byte_size)];
      if (item.duration_ms) parts.push((item.duration_ms / 1000).toFixed(1) + "s");
      meta.textContent = parts.filter(Boolean).join(" · ");
    }
    info.appendChild(meta);
    row.appendChild(info);

    const actions = document.createElement("div");
    actions.className = "history-actions";

    if (item.audio_url) {
      const playBtn = document.createElement("button");
      playBtn.type = "button";
      playBtn.className = "btn ghost small";
      playBtn.textContent = item.id === state.currentId ? "Playing" : "Play";
      playBtn.addEventListener("click", function () {
        play(item, true).catch(function (error) { setStatus(error.message, "error"); });
      });
      actions.appendChild(playBtn);
    }

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "btn ghost small";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", function () { removeItem(item.id); });
    actions.appendChild(deleteBtn);

    row.appendChild(actions);
    list.appendChild(row);
  });
}

async function removeItem(id) {
  if (!window.confirm("Delete this generation and its audio file?")) return;
  try {
    await api("/api/history/" + id, { method: "DELETE" });
  } catch (error) {
    setStatus(error.message, "error");
  }
  if (state.currentId === id) {
    const audio = $("audio");
    audio.removeAttribute("src");
    audio.load();
    state.currentId = null;
    $("playerTitle").textContent = "No audio loaded";
    $("playerSub").textContent = state.model;
  }
  await loadHistory().catch(function () { /* ignore */ });
}

/* ---------------- wiring ---------------- */

$("navGenerate").addEventListener("click", function () { showView("generate"); });
$("navHistory").addEventListener("click", function () { showView("history"); });
$("generateBtn").addEventListener("click", generate);
$("refreshBtn").addEventListener("click", function () {
  loadHistory().catch(function (error) { setStatus(error.message, "error"); });
});
$("script").addEventListener("input", updateCounter);
$("script").addEventListener("keydown", function (event) {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") generate();
});

$("lockForm").addEventListener("submit", function (event) {
  event.preventDefault();
  unlock($("accessKey").value);
});

(async function boot() {
  updateCounter();
  if (state.key) {
    const ok = await unlock(state.key);
    if (!ok) lock("Session key was rejected. Enter it again.");
  } else {
    $("accessKey").focus();
  }
})();
