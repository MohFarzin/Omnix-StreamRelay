const state = {
  accessToken: localStorage.getItem("omnix_access") || "",
  refreshToken: localStorage.getItem("omnix_refresh") || "",
  ws: null,
  busy: false,
  chatFilter: "all",
};

const $ = (id) => document.getElementById(id);

function toast(msg) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

async function copyText(text) {
  const value = String(text || "");
  if (!value) throw new Error("nothing to copy");

  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {
  }
  const ta = document.createElement("textarea");
  ta.value = value;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  if (!ok) throw new Error("copy failed");
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (state.accessToken) headers.Authorization = `Bearer ${state.accessToken}`;

  const hasBody = opts.body !== undefined && opts.body !== null;
  if (hasBody && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  let res = await fetch(path, { ...opts, headers });
  if (res.status === 401 && state.refreshToken) {
    const ok = await tryRefresh();
    if (ok) {
      headers.Authorization = `Bearer ${state.accessToken}`;
      res = await fetch(path, { ...opts, headers });
    }
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err.error || err.message || res.statusText || `HTTP ${res.status}`;
    throw new Error(typeof msg === "string" && msg !== "{}" ? msg : `Request failed (${res.status})`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function tryRefresh() {
  try {
    const data = await fetch("/api/v1/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: state.refreshToken }),
    }).then((r) => r.json());
    if (!data.accessToken) return false;
    state.accessToken = data.accessToken;
    state.refreshToken = data.refreshToken;
    localStorage.setItem("omnix_access", state.accessToken);
    localStorage.setItem("omnix_refresh", state.refreshToken);
    return true;
  } catch {
    return false;
  }
}

function showApp(on) {
  $("login").hidden = Boolean(on);
  $("app").hidden = !on;
  document.body.dataset.authed = on ? "1" : "0";
}

function connectWs() {
  if (state.ws) {
    try {
      state.ws.close();
    } catch {
    }
  }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/api/v1/ws`);
  state.ws = ws;
  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "auth", token: state.accessToken }));
  });
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "chat") appendChat(msg);
    if (msg.type === "hub") {
      applyIngestMsg(msg.ingest || {});
      if (Array.isArray(msg.targets) && !state.busy) {
        for (const t of msg.targets) upsertTargetRow(t);
      }
      if (msg.session && msg.session.type === "session") {
        window.__lmSession = msg.session.session;
        window.__lmRuntime = msg.session.runtime;
        renderSession(msg.session.session, msg.session.runtime, msg.session.media);
      }
      return;
    }
    if (msg.type === "ingest") applyIngestMsg(msg);
    if (msg.type === "target" && !state.busy) upsertTargetRow(msg);
    if (msg.type === "session") {
      window.__lmSession = msg.session;
      window.__lmRuntime = msg.runtime;
      renderSession(msg.session, msg.runtime, msg.media);
    }
  });
}

function applyIngestMsg(msg) {
  const b = $("ingestBadge");
  if (!b || !msg) return;
  const chats = Array.isArray(msg.chatPlatforms) && msg.chatPlatforms.length
    ? ` · chat:${msg.chatPlatforms.join("+")}`
    : " · chat:off";
  const main = msg.live ? `LIVE · ${msg.path}` : `idle · ${msg.path || ""}`;
  const vert = msg.vertical
    ? msg.vertical.live
      ? ` · V:LIVE`
      : ` · V:idle`
    : "";
  b.textContent = main + vert + chats;
  b.classList.toggle("live", Boolean(msg.live || msg.vertical?.live));
  if (msg.chat) renderChatStatus(msg.chat);
}

function appendChat(msg) {
  const el = $("chat");
  if (!el) return;
  const empty = el.querySelector(".empty");
  if (empty) empty.remove();
  const row = document.createElement("div");
  row.className = "row";
  row.dataset.platform = msg.platform || "";
  row.innerHTML = `<span class="plat">${escapeHtml(msg.platform)}</span> <strong>${escapeHtml(msg.user)}</strong>: ${escapeHtml(msg.text)}`;
  const filter = state.chatFilter || "all";
  if (filter !== "all" && msg.platform !== filter) row.hidden = true;
  el.appendChild(row);
  while (el.children.length > 400) el.firstChild.remove();
  el.scrollTop = el.scrollHeight;
}

function applyChatFilter(filter) {
  state.chatFilter = filter || "all";
  document.querySelectorAll("[data-chat-filter]").forEach((btn) => {
    btn.classList.toggle("on", btn.getAttribute("data-chat-filter") === state.chatFilter);
  });
  document.querySelectorAll("#chat .row").forEach((row) => {
    const plat = row.dataset.platform || "";
    row.hidden = state.chatFilter !== "all" && plat !== state.chatFilter;
  });
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function toggleTarget(id, currentlyEnabled) {
  state.busy = true;
  try {
    const path = currentlyEnabled ? "disable" : "enable";

    await api(`/api/v1/targets/${encodeURIComponent(id)}/${path}`, {
      method: "POST",
      body: "{}",
    });
    toast(currentlyEnabled ? "Target off" : "Target on");
    await loadTargets();
  } catch (e) {
    toast(`Toggle failed: ${e.message}`);
  } finally {
    state.busy = false;
  }
}

function displayDestName(label, lane) {
  const base = label || "dest";
  if (/shorts encoder/i.test(base)) return base;
  return lane === "vertical" ? `${base} · vertical` : `${base} · main`;
}

function setCreateBusy(on) {
  const overlay = $("lmBusyOverlay");
  if (overlay) overlay.hidden = !on;
  const createBtn = $("lmCreateBtn");
  const startBtn = $("lmStartBtn");
  if (on) {
    if (createBtn) createBtn.disabled = true;
    if (startBtn) startBtn.disabled = true;
  }
}

function youtubeStudioUrl(broadcastId) {
  if (!broadcastId) return "";
  return `https://studio.youtube.com/video/${encodeURIComponent(broadcastId)}/livestreaming`;
}

function closeYtEncoderModal() {
  const modal = $("ytEncoderModal");
  if (modal) modal.hidden = true;
  const inp = $("ytEncoderKeyInput");
  if (inp) inp.value = "";
  window.__ytEncoderNeedKey = false;
}

function openYtEncoderModal(opts = {}) {
  const session = opts.session || window.__lmSession || {};
  const id = session?.youtubeMainId || session?.youtubeVerticalId;
  const studio =
    String(opts.studioUrl || "").trim() ||
    youtubeStudioUrl(id) ||
    "https://studio.youtube.com/livestreaming";
  const needKey = Boolean(opts.verticalKeyMissing || opts.requireKey);
  window.__ytEncoderNeedKey = needKey;

  const modal = $("ytEncoderModal");
  if (!modal) return;
  const title = $("ytEncoderTitle");
  const lead = $("ytEncoderLead");
  if (title) title.textContent = needKey ? "Paste vertical stream key" : "YouTube Shorts encoder";
  if (lead) {
    lead.innerHTML = needKey
      ? "Main is ready. Omnix still needs the <strong>vertical / Shorts Encoder</strong> stream key from YouTube Studio."
      : "One YouTube video — main is automatic. For Shorts, open Studio → Dual stream → Encoder.";
  }
  const link = $("ytEncoderStudioBtn");
  if (link) {
    link.href = studio;
    link.textContent = id ? "Open your live in Studio" : "Open YouTube Studio";
  }
  const inp = $("ytEncoderKeyInput");
  if (inp) {
    inp.value = "";
    inp.placeholder = needKey
      ? "paste vertical / Encoder stream key here"
      : "optional — paste only if Studio key differs";
    inp.required = needKey;
  }
  const skip = $("ytEncoderDone");
  if (skip) skip.textContent = needKey ? "Skip for now" : "Done";
  const confirmBtn = $("ytEncoderSaveKey");
  if (confirmBtn) confirmBtn.textContent = "Confirm";
  modal.hidden = false;
  if (needKey && inp) setTimeout(() => inp.focus(), 50);
}

async function saveYtEncoderKeyFromModal() {
  const key = String($("ytEncoderKeyInput")?.value || "").trim();
  if (!key) {
    toast("Paste the vertical stream key from YouTube Studio, then Confirm");
    $("ytEncoderKeyInput")?.focus();
    return;
  }

  let streamKey = key;
  let rtmpUrl = "rtmp://a.rtmp.youtube.com/live2";
  if (/^rtmps?:\/\//i.test(key)) {
    try {
      const u = new URL(key.replace(/^rtmps:/i, "https:").replace(/^rtmp:/i, "http:"));
      const parts = u.pathname.replace(/^\//, "").split("/").filter(Boolean);
      streamKey = parts.pop() || key;
      rtmpUrl = key.replace(/\/[^/]+\/?$/, "").replace(/\/$/, "");
      if (!/^rtmps?:\/\//i.test(rtmpUrl)) rtmpUrl = "rtmp://a.rtmp.youtube.com/live2";
    } catch {
    }
  }
  try {
    const list = await api("/api/v1/targets");
    const existing = (list || []).find((t) => t.id === "youtube-v") || {};
    await api("/api/v1/targets/youtube-v", {
      method: "PUT",
      body: JSON.stringify({
        label: existing.label || "YouTube · Shorts encoder",
        platform: "youtube",
        lane: "vertical",
        rtmpUrl: existing.rtmpUrl || rtmpUrl,
        streamKey,
        enabled: true,
      }),
    });
    toast("Vertical key saved — you can Start stream now");
    closeYtEncoderModal();
    await loadTargets();
    await loadLiveSession();
  } catch (e) {
    toast(`Confirm failed: ${e.message}`);
  }
}

function renderYtDualHint(session) {
  const el = $("lmYtDualHint");
  if (!el) return;
  const id = session?.youtubeMainId || session?.youtubeVerticalId;
  if (!id || (session?.status !== "prepared" && session?.status !== "live")) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  const studio = youtubeStudioUrl(id);
  el.hidden = false;
  el.innerHTML = `Same YouTube video for main + Shorts. Open <a href="${escapeHtml(studio)}" target="_blank" rel="noopener">Studio Control Room</a> → Stream → Dual stream <strong>On</strong> → vertical <strong>Encoder</strong> → select <strong>Omnix vertical encoder</strong> → then Start here.`;
}

function upsertTargetRow(t) {
  const box = $("targets");
  const empty = box.querySelector(".empty");
  if (empty) empty.remove();
  let row = box.querySelector(`[data-target="${CSS.escape(t.id)}"]`);
  if (!row) {
    row = document.createElement("div");
    row.className = "target";
    row.dataset.target = t.id;
    box.appendChild(row);
  }
  const enabled = Boolean(t.enabled);
  row.dataset.enabled = enabled ? "1" : "0";
  row.dataset.label = t.label || t.id;
  const up = t.uptimeSec ? `${t.uptimeSec}s` : "";
  const lane = t.lane === "vertical" ? "vertical" : "main";
  const statePill = t.error
    ? `<span class="pill err">error</span>`
    : t.state === "forwarding"
      ? `<span class="pill ok">live</span>`
      : enabled
        ? `<span class="pill">on</span>`
        : `<span class="pill">off</span>`;
  const err = t.error ? `<div class="meta">${escapeHtml(t.error)}</div>` : "";
  row.innerHTML = `
    <div>
      <div class="title">
        ${escapeHtml(displayDestName(t.label || t.id, lane))}
        <span class="pill ${lane === "vertical" ? "vert" : ""}">${lane === "vertical" ? "9:16" : "16:9"}</span>
        ${statePill}
      </div>
      <div class="meta">key ${escapeHtml(t.keyMasked || "")}${up ? ` · ${up}` : ""}</div>
      ${err}
    </div>
    <div class="target-actions">
      <div class="toggle ${enabled ? "on" : ""}" role="group" aria-label="Enable ${escapeHtml(t.id)}">
        <button type="button" class="tog tog-off" data-want="0">Off</button>
        <button type="button" class="tog tog-on" data-want="1">On</button>
      </div>
      <button type="button" class="ghost tiny" data-edit-dest="${escapeHtml(t.id)}">Edit</button>
      <button type="button" class="ghost tiny" data-del-dest="${escapeHtml(t.id)}">Delete</button>
    </div>
  `;
  row.querySelectorAll("[data-want]").forEach((btn) => {
    btn.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const wantOn = btn.getAttribute("data-want") === "1";
      const isOn = row.dataset.enabled === "1";
      if (wantOn === isOn) return;
      void toggleTarget(t.id, isOn);
    };
  });
  const edit = row.querySelector("[data-edit-dest]");
  if (edit) {
    edit.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openEditDestination(t);
    };
  }
  const del = row.querySelector("[data-del-dest]");
  if (del) {
    del.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openDeleteModal(t.id, t.label || t.id);
    };
  }
}

async function loadTargets() {
  const list = await api("/api/v1/targets");
  $("targets").innerHTML = "";
  if (!list.length) {
    $("targets").innerHTML = `<p class="empty">No destinations yet — Connect on Omnix Link, then Add automatically.</p>`;
    void updateDestStrip();
    return;
  }
  for (const t of list) {
    upsertTargetRow({
      ...t,
      state: t.enabled ? "enabled" : "idle",
      error: t.lastError,
      keyMasked: t.keyMasked,
      enabled: t.enabled,
    });
  }
  void updateDestStrip();
}

async function deleteCommand(name) {
  try {
    await api(`/api/v1/commands/${encodeURIComponent(name)}`, { method: "DELETE" });
    toast("Command deleted");
    await loadCommands();
  } catch (e) {
    toast(`Delete failed: ${e.message}`);
  }
}

async function loadCommands() {
  const list = await api("/api/v1/commands");
  const box = $("commands");
  box.innerHTML = "";
  if (!list.length) {
    box.innerHTML = `<p class="empty">No commands yet — add one below.</p>`;
  } else {
    for (const c of list) {
      const row = document.createElement("div");
      row.className = "cmd";
      row.innerHTML = `
        <div>
          <div class="cmd-trigger">!${escapeHtml(c.name)}</div>
          <div class="cmd-body">${escapeHtml(c.response)}</div>
        </div>
        <button type="button" class="ghost" data-del="${escapeHtml(c.name)}">Delete</button>`;
      box.appendChild(row);
    }
    box.querySelectorAll("[data-del]").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        void deleteCommand(btn.getAttribute("data-del") || "");
      });
    });
  }
  const w = await api("/api/v1/settings/welcome");
  const welcome = $("welcome");
  if (welcome) welcome.value = w.template || "";
}

function setChatExpanded(open) {
  const panel = $("chatPanel");
  const body = $("chatBody");
  const btn = $("toggleChatBtn");
  if (!panel || !body || !btn) return;
  panel.classList.toggle("chat-expanded", open);
  panel.classList.toggle("chat-collapsed", !open);
  if (open) body.removeAttribute("hidden");
  else body.setAttribute("hidden", "");
  btn.setAttribute("aria-expanded", open ? "true" : "false");
  btn.textContent = open ? "Minimize" : "Expand";
}

function renderChatStatus(chat) {
  const box = $("chatStatus");
  if (!box) return;
  if (!chat) {
    box.textContent = "Chat status unknown.";
    setChatExpanded(true);
    return;
  }
  if (chat.connected?.length) {
    box.innerHTML = `<span class="ok">Connected: ${escapeHtml(chat.connected.join(", "))}</span>`;

    setChatExpanded(false);
    return;
  }
  box.innerHTML = `<strong>Chat off</strong> — video still works. Tap <em>?</em> for setup.`;

  setChatExpanded(true);
}

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value ?? "";
}

async function loadSetup() {
  try {
    const s = await api("/api/v1/setup");
    setText(
      "setupHost",
      `${s.publicHost} · dash :${s.dashboardPort} · RTMP :${s.rtmpPort}`
    );
    setText("obsServer", s.obsServer);
    setText("obsKey", s.streamKey);
    setText("obsKeyV", s.streamKeyVertical || `${s.streamKey}_v`);
    setText("srtUrl", s.srtUrl || "");
    setText("srtUrlV", s.srtUrlVertical || "");
    setText("dashUrl", s.dashboardUrl || "");
    renderChatStatus(s.chat);
  } catch (e) {
    setText("setupHost", `Could not load setup info: ${e.message}`);
  }
}

function setConnectRow(statusId, connectId, disconnectId, available, connected, idleText) {
  const statusEl = $(statusId);
  const connectBtn = $(connectId);
  const disconnectBtn = $(disconnectId);
  if (!statusEl) return;
  if (!available) {
    statusEl.textContent = "Connect unavailable on this build";
    if (connectBtn) connectBtn.disabled = true;
    if (disconnectBtn) disconnectBtn.hidden = true;
    return;
  }
  if (connectBtn) connectBtn.disabled = false;
  if (connected) {
    statusEl.textContent = "Connected";
    if (disconnectBtn) disconnectBtn.hidden = false;
  } else {
    statusEl.textContent = idleText || "Not connected — click Connect";
    if (disconnectBtn) disconnectBtn.hidden = true;
  }
}

async function loadYoutubeStatus() {
  try {
    const [yt, oauth] = await Promise.all([
      api("/api/v1/youtube/status"),
      api("/api/v1/oauth/status").catch(() => null),
    ]);
    const ytAvail = Boolean(yt.connectAvailable ?? yt.oauthConfigured);
    const ytText = yt.connected
      ? `Connected${yt.liveChatId ? " · chat ready" : ""}`
      : "Not connected — use Omnix Link → Connect YouTube";
    setConnectRow("ytStatus", "ytConnectBtn", "ytDisconnectBtn", ytAvail, yt.connected, ytText);
    if (yt.connected && $("ytStatus")) $("ytStatus").textContent = ytText;

    if (oauth) {
      setConnectRow(
        "twitchStatus",
        "twitchConnectBtn",
        "twitchDisconnectBtn",
        Boolean(oauth.twitch?.connectAvailable),
        Boolean(oauth.twitch?.connected),
        oauth.twitch?.hint || "Not connected — use Omnix Link → Connect Twitch"
      );
      if (oauth.twitch?.connected && $("twitchStatus")) {
        const ch = oauth.twitch?.meta?.channel;
        $("twitchStatus").textContent = ch ? `Connected · ${ch}` : "Connected";
      }
      setConnectRow(
        "kickStatus",
        "kickConnectBtn",
        "kickDisconnectBtn",
        Boolean(oauth.kick?.connectAvailable),
        Boolean(oauth.kick?.connected),
        oauth.kick?.hint || "Not connected — use Omnix Link → Connect Kick"
      );
      if (oauth.kick?.connected && $("kickStatus")) {
        const ch = oauth.kick?.meta?.channel;
        $("kickStatus").textContent = ch ? `Connected · ${ch} · paste key in Destinations` : "Connected · paste Kick URL+key once";
      }
    }

    void loadLivePresets();
    void updateDestStrip();
  } catch (e) {
    if ($("ytStatus")) $("ytStatus").textContent = `Status failed: ${e.message}`;
  }
}

window.__lmMode = "aio";

function setLmMode(mode) {
  window.__lmMode = mode === "custom" ? "custom" : "aio";
  $("lmModeAio")?.classList.toggle("on", window.__lmMode === "aio");
  $("lmModeCustom")?.classList.toggle("on", window.__lmMode === "custom");
  if ($("lmAioFields")) $("lmAioFields").hidden = window.__lmMode !== "aio";
  if ($("lmCustomFields")) $("lmCustomFields").hidden = window.__lmMode !== "custom";
}

function readLmDraft() {
  if (window.__lmMode === "custom") {
    return {
      mode: "custom",
      custom: {
        youtube: {
          title: $("lmYtTitle")?.value || "",
          description: $("lmYtDesc")?.value || "",
          privacy: $("lmYtPrivacy")?.value || "unlisted",
          latency: $("lmYtLatency")?.value || "normal",
          game: $("lmYtGame")?.value || "",
        },
        twitch: {
          title: $("lmTwTitle")?.value || "",
          game: $("lmTwGame")?.value || "",
        },
        kick: {
          title: $("lmKickTitle")?.value || "",
        },
      },
    };
  }
  return {
    mode: "aio",
    aio: {
      title: $("lmTitle")?.value || "",
      description: $("lmDesc")?.value || "",
      game: $("lmGame")?.value || "",
      privacy: $("lmPrivacy")?.value || "unlisted",
      latency: $("lmLatency")?.value || "normal",
      categoryId: $("lmCategory")?.value || "",
    },
  };
}

function fmtThumbMb(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return "0 MB";
  const mb = n / (1024 * 1024);
  return mb >= 0.1 ? `${mb.toFixed(2)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

function setLmThumbNote(text) {
  if ($("lmYtThumbNote")) $("lmYtThumbNote").textContent = text || "No thumbnail saved yet";
  if ($("lmYtThumbNoteCustom")) $("lmYtThumbNoteCustom").textContent = text || "";
}

async function readYtThumbnailFromFile() {
  const file = $("lmYtThumb")?.files?.[0] || $("lmYtThumbCustom")?.files?.[0];
  if (!file) return {};
  if (file.size > 2_000_000) throw new Error("thumbnail must be under 2MB");
  let thumbnailMime = (file.type || "image/jpeg").toLowerCase();
  if (thumbnailMime === "image/jpg") thumbnailMime = "image/jpeg";
  if (thumbnailMime !== "image/jpeg" && thumbnailMime !== "image/png") {
    throw new Error("thumbnail must be JPEG or PNG (YouTube rejects WebP)");
  }
  const thumbnailBase64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("thumbnail read failed"));
    reader.readAsDataURL(file);
  });
  return {
    thumbnailBase64,
    thumbnailMime,
    thumbnailName: file.name || "thumbnail.jpg",
    thumbnailBytes: file.size,
  };
}

async function readYtThumbnail() {
  const fromFile = await readYtThumbnailFromFile();
  if (fromFile.thumbnailBase64) {
    window.__lmPresetThumb = fromFile;
    showLmThumbPreview(fromFile.thumbnailBase64, {
      name: fromFile.thumbnailName,
      bytes: fromFile.thumbnailBytes,
      pending: true,
    });
    return fromFile;
  }
  if (window.__lmPresetThumb?.thumbnailBase64) return window.__lmPresetThumb;
  return {};
}

function showLmThumbPreview(dataUrl, meta) {
  const img = $("lmYtThumbPreview");
  if (img && dataUrl) {
    img.src = dataUrl;
    img.hidden = false;
  } else if (img && !dataUrl) {
    img.removeAttribute("src");
    img.hidden = true;
  }
  if (!meta?.name && !dataUrl) {
    setLmThumbNote("No thumbnail saved yet");
    return;
  }
  const name = meta?.name || "thumbnail";
  const size = fmtThumbMb(meta?.bytes);
  if (meta?.pending) {
    setLmThumbNote(`New file: ${name} · ${size} — click Save preset to store it`);
  } else {
    setLmThumbNote(`Saved: ${name} · ${size}`);
  }
}

async function loadPresetThumbnail(presetId) {
  if (!presetId) {
    window.__lmPresetThumb = null;
    showLmThumbPreview("", null);
    return;
  }
  try {
    const thumb = await api(`/api/v1/live/presets/${encodeURIComponent(presetId)}/thumbnail`);
    if (thumb?.thumbnailBase64) {
      window.__lmPresetThumb = {
        thumbnailBase64: thumb.thumbnailBase64,
        thumbnailMime: thumb.thumbnailMime || "image/jpeg",
        thumbnailName: thumb.thumbnailName || "thumbnail.jpg",
        thumbnailBytes: thumb.thumbnailBytes || 0,
      };
      showLmThumbPreview(thumb.thumbnailBase64, {
        name: thumb.thumbnailName || "thumbnail.jpg",
        bytes: thumb.thumbnailBytes || 0,
        pending: false,
      });
      return;
    }
  } catch {
  }
  window.__lmPresetThumb = null;
  showLmThumbPreview("", null);
}

function fmtMs(ms) {
  if (ms == null || ms < 0) return "";
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function renderSession(session, runtime, media) {
  const s = session || { status: "idle" };
  const rt = runtime || { phase: s.status || "idle", label: s.status || "Idle", detail: "", remainingMs: null };
  const pill = $("lmSessionPill");
  const hint = $("lmSessionHint");
  const createBtn = $("lmCreateBtn");
  const startBtn = $("lmStartBtn");
  const endBtn = $("lmEndBtn");
  const phase = rt.phase || s.status || "idle";
  const remain = rt.remainingMs != null ? ` · ${fmtMs(rt.remainingMs)}` : "";
  if (pill) {
    pill.textContent = `${rt.label || phase}${remain}`;
    pill.className = `lm-status phase-${phase}`;
  }

  const watches = [...new Set([s.watchMain, s.watchVertical].filter(Boolean))];
  if (hint) {
    const watchHtml = watches.length
      ? ` · ${watches.map((u) => `<a href="${escapeHtml(u)}" target="_blank" rel="noopener">${escapeHtml(u)}</a>`).join(" · ")}`
      : "";
    hint.innerHTML = `${escapeHtml(rt.detail || rt.label || phase)}${watchHtml}`;
  }
  renderYtDualHint(s);
  if (createBtn) createBtn.disabled = phase !== "idle" && phase !== "prepared";
  if (startBtn) startBtn.disabled = phase !== "prepared";
  if (endBtn) endBtn.disabled = phase === "idle";
  if (media) renderMediaManager(media);
  window.__lmPhase = phase;

  if (window.__lmPoll) {
    clearInterval(window.__lmPoll);
    window.__lmPoll = null;
  }
}

function renderMediaManager(media) {
  const files = media?.files || {};
  const timers = media?.timers || {};
  const clearIds = { start: "lmMediaStartClear", idle: "lmMediaIdleClear", end: "lmMediaEndClear" };
  const metaIds = { start: "lmMediaStartMeta", idle: "lmMediaIdleMeta", end: "lmMediaEndMeta" };
  for (const slot of ["start", "idle", "end"]) {
    const el = $(metaIds[slot]);
    const clearBtn = $(clearIds[slot]);
    const f = files[slot];
    if (!el) continue;
    if (f?.present) {
      el.textContent = `Ready · ${Math.round((f.bytes || 0) / 1024)} KB`;
      if (clearBtn) clearBtn.disabled = false;
    } else {
      el.textContent = "Not uploaded";
      if (clearBtn) clearBtn.disabled = true;
    }
  }
  const sum = $("lmTimersSummary");
  if (sum && timers) {
    const ss = Math.round((timers.startWaitMs || 0) / 1000);
    const bs = Math.round((timers.brbWaitMs || 0) / 1000);
    const es = Math.round((timers.endPlayMs || 0) / 1000);
    sum.textContent = `Start wait ${ss}s · BRB ${bs}s · End play ${es}s`;
  }
  window.__lmTimers = timers;
}

function confirmLmAction(title, body) {
  return new Promise((resolve) => {
    const modal = $("lmConfirmModal");
    if (!modal) {
      resolve(window.confirm(`${title}\n\n${body}`));
      return;
    }
    $("lmConfirmTitle").textContent = title;
    $("lmConfirmBody").textContent = body;
    modal.hidden = false;
    const done = (ok) => {
      modal.hidden = true;
      $("lmConfirmOk").onclick = null;
      $("lmConfirmCancel").onclick = null;
      $("lmConfirmClose").onclick = null;
      resolve(ok);
    };
    $("lmConfirmOk").onclick = () => done(true);
    $("lmConfirmCancel").onclick = () => done(false);
    $("lmConfirmClose").onclick = () => done(false);
  });
}

async function loadLiveSession() {
  if (window.__lmSessionInflight) return window.__lmSessionInflight;
  window.__lmSessionInflight = (async () => {
    try {
      const res = await api("/api/v1/live/session");
      window.__lmSession = res.session;
      window.__lmRuntime = res.runtime;
      renderSession(res.session, res.runtime, res.media);
    } catch {
      renderSession({ status: "idle" }, { phase: "idle", label: "Idle", detail: "" });
    } finally {
      window.__lmSessionInflight = null;
    }
  })();
  return window.__lmSessionInflight;
}

async function uploadMediaSlot(slot, fileInputId) {
  const input = $(fileInputId);
  input?.click();
  if (!input) return;
  input.onchange = async () => {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (file.size > 120 * 1024 * 1024) {
      toast("Media must be under 120MB");
      return;
    }
    try {
      toast(`Uploading ${slot} media…`);
      const buf = await file.arrayBuffer();
      const r = await fetch(`/api/v1/live/media/${slot}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${state.accessToken}`,
          "Content-Type": file.type || "video/mp4",
        },
        body: buf,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `upload ${r.status}`);
      toast(`${slot} media saved`);
      renderMediaManager(j.files ? j : { files: j.files, timers: j.timers });
      await loadLiveSession();
    } catch (e) {
      toast(e.message || "upload failed");
    }
  };
}

function applyLmPreset(p) {
  if (!p) return;
  setLmMode(p.mode === "custom" ? "custom" : "aio");
  if (p.mode === "custom") {
    const y = p.custom?.youtube || {};
    const tw = p.custom?.twitch || {};
    const k = p.custom?.kick || {};
    if ($("lmYtTitle")) $("lmYtTitle").value = y.title || "";
    if ($("lmYtDesc")) $("lmYtDesc").value = y.description || "";
    if ($("lmYtPrivacy") && y.privacy) $("lmYtPrivacy").value = y.privacy;
    if ($("lmYtLatency") && y.latency) $("lmYtLatency").value = y.latency;
    if ($("lmYtGame")) $("lmYtGame").value = y.game || "";
    if ($("lmTwTitle")) $("lmTwTitle").value = tw.title || "";
    if ($("lmTwGame")) $("lmTwGame").value = tw.game || "";
    if ($("lmKickTitle")) $("lmKickTitle").value = k.title || "";
  } else {
    const a = p.aio || {};
    if ($("lmTitle")) $("lmTitle").value = a.title || "";
    if ($("lmDesc")) $("lmDesc").value = a.description || "";
    if ($("lmGame")) $("lmGame").value = a.game || "";
    if ($("lmPrivacy") && a.privacy) $("lmPrivacy").value = a.privacy;
    if ($("lmLatency") && a.latency) $("lmLatency").value = a.latency;
    if ($("lmCategory") && a.categoryId != null) $("lmCategory").value = a.categoryId || "";
  }
  void loadPresetThumbnail(p.id);
}

async function loadLiveCategories() {
  const sel = $("lmCategory");
  if (!sel) return;
  try {
    const res = await api("/api/v1/youtube/categories?region=US");
    const cats = res.categories || [];
    const current = sel.value;
    sel.innerHTML = `<option value="">Auto / none</option>`;
    for (const c of cats) {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = c.title;
      sel.appendChild(opt);
    }
    if (current && [...sel.options].some((o) => o.value === current)) sel.value = current;
    else if ([...sel.options].some((o) => o.value === "20")) sel.value = "20";
  } catch {
  }
}

async function loadLivePresets() {
  const box = $("lmPresetsList");
  if (!box) return;
  try {
    const res = await api("/api/v1/live/presets");
    const presets = res.presets || [];
    const defaultId = res.defaultId || "";
    window.__lmPresets = presets;
    window.__lmDefaultId = defaultId;
    if (!presets.length) {
      box.innerHTML = `<p class="empty">No presets yet — fill the form and Save preset.</p>`;
      return;
    }

    const def = defaultId ? presets.find((x) => x.id === defaultId) : null;
    if (def?.hasThumbnail) {
      setLmThumbNote(`Saved: ${def.thumbnailName || "thumbnail"} · ${fmtThumbMb(def.thumbnailBytes)}`);
    } else if (def) {
      setLmThumbNote("No thumbnail saved yet");
    }

    if (def && !window.__lmEditingId && !window.__lmDefaultLoaded) {
      applyLmPreset(def);
      window.__lmDefaultLoaded = true;
      toast(def.hasThumbnail ? "Default preset + thumbnail loaded" : "Default preset loaded");
    } else if (def?.hasThumbnail && !window.__lmEditingId) {
      void loadPresetThumbnail(def.id);
    }
    box.innerHTML = presets
      .map((p) => {
        const isDef = p.id === defaultId;
        const mode = escapeHtml(p.mode || "aio");
        const title =
          p.mode === "custom"
            ? escapeHtml(p.custom?.youtube?.title || p.custom?.twitch?.title || p.custom?.kick?.title || "")
            : escapeHtml(p.aio?.title || "");
        const thumbPill = p.hasThumbnail
          ? `<span class="pill">thumb · ${escapeHtml(p.thumbnailName || "image")} · ${fmtThumbMb(p.thumbnailBytes)}</span>`
          : `<span class="pill">no thumb</span>`;
        return `<div class="yt-preset-card lm-preset-card">
          <div class="title-line">${escapeHtml(p.name || "Preset")} ${isDef ? `<span class="pill default">default</span>` : ""} <span class="pill">${mode}</span> ${thumbPill}</div>
          <div class="meta">${title || "(no title)"}</div>
          <div class="row-actions">
            <button type="button" class="ghost lm-edit" data-id="${escapeHtml(p.id)}">Edit</button>
            <button type="button" class="ghost lm-apply" data-id="${escapeHtml(p.id)}">Apply</button>
            <button type="button" class="ghost lm-default" data-id="${escapeHtml(p.id)}" ${isDef ? "disabled" : ""}>Set default</button>
            <button type="button" class="ghost lm-del" data-id="${escapeHtml(p.id)}">Delete</button>
          </div>
        </div>`;
      })
      .join("");
    box.querySelectorAll(".lm-edit").forEach((btn) => {
      btn.onclick = () => {
        const p = presets.find((x) => x.id === btn.getAttribute("data-id"));
        applyLmPreset(p);
        window.__lmEditingId = p?.id || null;

        if ($("lmYtThumb")) $("lmYtThumb").value = "";
        if ($("lmYtThumbCustom")) $("lmYtThumbCustom").value = "";
        toast(
          p?.hasThumbnail
            ? `Editing — current thumb: ${p.thumbnailName || "image"} (${fmtThumbMb(p.thumbnailBytes)}). Choose a new file, then Save preset.`
            : "Editing — choose a thumbnail file, then Save preset"
        );
      };
    });
    box.querySelectorAll(".lm-apply").forEach((btn) => {
      btn.onclick = async () => {
        try {
          const r = await api("/api/v1/live/apply", {
            method: "POST",
            body: JSON.stringify({ presetId: btn.getAttribute("data-id"), forceAll: true }),
          });
          toast(`Titles · ${summarizeApply(r)}`);
          await loadTargets();
          await loadLiveSession();
        } catch (e) {
          toast(e.message);
        }
      };
    });
    box.querySelectorAll(".lm-default").forEach((btn) => {
      btn.onclick = async () => {
        try {
          await api(`/api/v1/live/presets/${encodeURIComponent(btn.getAttribute("data-id"))}/default`, {
            method: "POST",
            body: "{}",
          });
          toast("Default preset set");
          await loadLivePresets();
        } catch (e) {
          toast(e.message);
        }
      };
    });
    box.querySelectorAll(".lm-del").forEach((btn) => {
      btn.onclick = async () => {
        try {
          await api(`/api/v1/live/presets/${encodeURIComponent(btn.getAttribute("data-id"))}`, {
            method: "DELETE",
          });
          toast("Preset deleted");
          await loadLivePresets();
        } catch (e) {
          toast(e.message);
        }
      };
    });
  } catch (e) {
    box.innerHTML = `<p class="empty">${escapeHtml(e.message || "Could not load presets")}</p>`;
  }
}

function summarizeApply(r) {
  const parts = Object.entries(r.results || {}).map(([k, v]) => `${k}:${v.ok ? "ok" : v.detail || "fail"}`);
  return parts.length ? `Applied · ${parts.join(" · ")}` : "Nothing to apply (need titles + On destinations or force)";
}

async function updateDestStrip() {
  const strip = $("destConnectedStrip");
  if (!strip) return;
  try {
    const [oauth, yt, targets] = await Promise.all([
      api("/api/v1/oauth/status").catch(() => null),
      api("/api/v1/youtube/status").catch(() => null),
      api("/api/v1/targets").catch(() => []),
    ]);
    const on = new Set((targets || []).filter((t) => t.enabled).map((t) => String(t.platform || "")));
    const chips = [];
    if (yt?.connected) chips.push({ id: "youtube", label: "YouTube", connected: true });
    if (oauth?.twitch?.connected) chips.push({ id: "twitch", label: "Twitch", connected: true });
    if (oauth?.kick?.connected) chips.push({ id: "kick", label: "Kick", connected: true });
    if (!chips.length) {
      strip.hidden = true;
      strip.innerHTML = "";
      return;
    }
    strip.hidden = false;
    strip.innerHTML = chips
      .map((c) => {
        const isOn = on.has(c.id);
        return `<span class="dest-chip ${isOn ? "on" : "off"}">${escapeHtml(c.label)} · ${isOn ? "On" : "Off"}</span>`;
      })
      .join("");
  } catch {
    strip.hidden = true;
  }
}

async function loadYoutubeLives() {
  const box = $("ytLivesList");
  if (!box) return;
  try {
    const res = await api("/api/v1/youtube/live/list");
    const lives = res.lives || [];
    if (!lives.length) {
      box.innerHTML = `<p class="empty">No upcoming or active lives — create one below.</p>`;
      return;
    }
    box.innerHTML = lives
      .map((live) => {
        const status = escapeHtml(live.lifeCycleStatus || "unknown");
        const privacy = escapeHtml(live.privacyStatus || live.privacy || "");
        const title = escapeHtml(live.title || "(untitled)");
        const id = escapeHtml(live.broadcastId);
        const watch = escapeHtml(live.watchUrl || "");
        return `<div class="yt-live-card" data-broadcast="${id}">
          <div class="title-line">${title}</div>
          <div class="meta">${status} · ${privacy}${watch ? ` · <a href="${watch}" target="_blank" rel="noopener">watch</a>` : ""}</div>
          <div class="row-actions">
            <button type="button" class="ghost yt-use-live" data-id="${id}">Use this live</button>
            <button type="button" class="ghost yt-load-live" data-id="${id}">Load into form</button>
          </div>
        </div>`;
      })
      .join("");
    box.querySelectorAll(".yt-use-live").forEach((btn) => {
      btn.onclick = async () => {
        try {
          btn.disabled = true;
          const resUse = await api("/api/v1/youtube/live/use", {
            method: "POST",
            body: JSON.stringify({
              broadcastId: btn.getAttribute("data-id"),
              lane: "main",
              enable: true,
            }),
          });
          toast(`Using live · ${resUse.targetId || "youtube"} — click Start stream`);
          if (resUse.session) {
            window.__lmSession = resUse.session;
            renderSession(resUse.session);
          } else {
            await loadLiveSession();
          }
          if (resUse.watchUrl && $("lmHint")) {
            $("lmHint").innerHTML = `Watch: <a href="${escapeHtml(resUse.watchUrl)}" target="_blank" rel="noopener">${escapeHtml(resUse.watchUrl)}</a>`;
          }
          await loadTargets();
        } catch (e) {
          toast(String(e.message || "").replace(/<[^>]+>/g, ""));
        } finally {
          btn.disabled = false;
        }
      };
    });
    box.querySelectorAll(".yt-load-live").forEach((btn) => {
      btn.onclick = () => {
        const card = lives.find((l) => l.broadcastId === btn.getAttribute("data-id"));
        if (!card) return;
        setLmMode("aio");
        if ($("lmTitle")) $("lmTitle").value = card.title || "";
        if ($("lmDesc")) $("lmDesc").value = card.description || "";
        if ($("lmPrivacy") && card.privacyStatus) $("lmPrivacy").value = card.privacyStatus;
        toast("Loaded into Live Manager");
      };
    });
  } catch (e) {
    const msg = String(e.message || "Could not load lives").replace(/<[^>]+>/g, "");
    box.innerHTML = `<p class="empty">${escapeHtml(msg)}</p>`;
  }
}

let devicePollTimer = null;

function closeDeviceModal() {
  const modal = $("deviceModal");
  if (modal) modal.hidden = true;
  if (devicePollTimer) {
    clearTimeout(devicePollTimer);
    devicePollTimer = null;
  }
}

async function startYoutubeDeviceConnect() {
  const started = await api("/api/v1/youtube/oauth/device/start", {
    method: "POST",
    body: "{}",
  });
  const modal = $("deviceModal");
  if (!modal) throw new Error("device UI missing");
  $("deviceCode").textContent = started.userCode || "······";
  const link = $("deviceLink");
  const href = started.verificationUrlComplete || started.verificationUrl || "https://www.google.com/device";
  link.href = href;
  link.textContent = href.replace(/^https?:\/\//, "");
  $("deviceWait").textContent = "Waiting for you to Allow…";
  modal.hidden = false;

  const intervalMs = Math.max(3000, (started.intervalSec || 5) * 1000);
  const sessionId = started.sessionId;

  const tick = async () => {
    try {
      const r = await api("/api/v1/youtube/oauth/device/poll", {
        method: "POST",
        body: JSON.stringify({ sessionId }),
      });
      if (r.status === "connected") {
        closeDeviceModal();
        toast("Google connected — tokens saved on this server only");
        await loadYoutubeStatus();
        return;
      }
      if (r.status === "slow_down") {
        $("deviceWait").textContent = r.message || "Waiting…";
        devicePollTimer = setTimeout(tick, intervalMs + 2000);
        return;
      }
      devicePollTimer = setTimeout(tick, intervalMs);
    } catch (e) {
      $("deviceWait").textContent = e.message || "Connect failed";
      toast(`Connect failed: ${e.message}`);
    }
  };
  devicePollTimer = setTimeout(tick, intervalMs);
}

async function startPlatformConnect(platform) {
  if (platform === "youtube") {
    try {
      await startYoutubeDeviceConnect();
      return;
    } catch (e) {

      toast(`Device Connect unavailable — trying browser… (${e.message})`);
    }
  }
  const path =
    platform === "youtube"
      ? "/api/v1/youtube/oauth/start"
      : `/api/v1/oauth/${platform}/start`;
  const s = await api(path);
  window.open(s.url, "omnix-oauth", "width=520,height=720");
  toast("Finish sign-in in the popup — tokens stay on this server");
}

function setLinkPill(id, connected, needsReconnect) {
  const el = $(id);
  if (!el) return;
  if (needsReconnect) {
    el.textContent = "Reconnect";
    el.classList.remove("ok");
    el.classList.add("off");
    return;
  }
  el.textContent = connected ? "Connected" : "Not connected";
  el.classList.toggle("ok", Boolean(connected));
  el.classList.toggle("off", !connected);
}

function showLinkViews({ linked, changing }) {
  const connectedView = $("linkConnectedView");
  const setupView = $("linkSetupView");
  const cancelBtn = $("linkCancelChangeBtn");
  if (connectedView) connectedView.hidden = !(linked && !changing);
  if (setupView) setupView.hidden = !(!linked || changing);
  if (cancelBtn) cancelBtn.hidden = !changing;
}

async function loadLinkStatus() {
  const statusEl = $("linkStatusLine");
  const setupStatus = $("linkSetupStatus");
  const hint = $("linkHint");
  try {
    const s = await api("/api/v1/oauth/link/status");
    const linked = Boolean(s.linked || s.status === "linked");
    const changing = Boolean(window.__linkChangingToken);
    showLinkViews({ linked, changing });

    const statusText = linked
      ? `Link: ${s.status || "linked"}${s.message ? ` — ${s.message}` : ""}`
      : s.tunnelTokenSet
        ? `Status: ${s.status || "…"} — ${s.message || "waiting for confirm on Omnix Link"}`
        : "Not connected — paste Connect Relay token from Omnix Link";
    if (statusEl) statusEl.textContent = statusText;
    if (setupStatus) setupStatus.textContent = statusText;
    if (hint) {
      if (s.platforms?.youtube?.needsReconnect) {
        hint.textContent =
          "YouTube login expired — on Omnix Link: Disconnect YouTube, then Connect YouTube again. Then retry Create.";
      } else if (linked) {
        hint.textContent = "Relay is linked. Open Omnix Link to Connect / Remove YouTube, Twitch, or Kick.";
      } else {
        hint.textContent =
          "Paste a Connect Relay token once, confirm on Omnix Link, then Connect platforms there.";
      }
    }
    if ($("linkOpenBtn") && s.openUrl) $("linkOpenBtn").href = s.openUrl;

    setLinkPill("linkYtPill", s.platforms?.youtube?.connected, s.platforms?.youtube?.needsReconnect);
    setLinkPill("linkTwitchPill", s.platforms?.twitch?.connected);
    setLinkPill("linkKickPill", s.platforms?.kick?.connected);
  } catch (e) {
    showLinkViews({ linked: false, changing: false });
    if (statusEl) statusEl.textContent = `Status: unavailable (${e.message})`;
    if (setupStatus) setupStatus.textContent = `Status: unavailable (${e.message})`;
  }
}

async function enter() {
  showApp(true);
  connectWs();
  for (const id of ["lmYtThumb", "lmYtThumbCustom"]) {
    const el = $(id);
    if (el && !el.__lmThumbBound) {
      el.__lmThumbBound = true;
      el.addEventListener("change", () => {
        void readYtThumbnailFromFile()
          .then((t) => {
            if (!t.thumbnailBase64) return;
            window.__lmPresetThumb = t;
            showLmThumbPreview(t.thumbnailBase64, {
              name: t.thumbnailName,
              bytes: t.thumbnailBytes,
              pending: true,
            });
            if (window.__lmEditingId) {
              toast("New thumbnail selected — click Save preset to apply");
            } else {
              toast("Click Edit on a preset first, then Save preset to store this thumbnail");
            }
          })
          .catch((e) => toast(e.message || "thumbnail failed"));
      });
    }
  }
  await Promise.all([
    loadSetup(),
    loadTargets(),
    loadCommands(),
    loadYoutubeStatus(),
    loadLinkStatus(),
    loadLiveSession(),
    loadLivePresets(),
  ]);
}

$("loginBtn").onclick = async () => {
  $("loginErr").hidden = true;
  $("loginBtn").disabled = true;
  try {
    const data = await fetch("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bootstrapToken: $("bootstrap").value }),
    }).then(async (r) => {
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "login failed");
      return j;
    });
    state.accessToken = data.accessToken;
    state.refreshToken = data.refreshToken;
    localStorage.setItem("omnix_access", state.accessToken);
    localStorage.setItem("omnix_refresh", state.refreshToken);
    $("bootstrap").value = "";
    await enter();
  } catch (e) {
    $("loginErr").textContent = e.message;
    $("loginErr").hidden = false;
  } finally {
    $("loginBtn").disabled = false;
  }
};

$("logoutBtn").onclick = () => {
  state.accessToken = "";
  state.refreshToken = "";
  localStorage.removeItem("omnix_access");
  localStorage.removeItem("omnix_refresh");
  try {
    state.ws?.close();
  } catch {
  }
  state.ws = null;
  showApp(false);
};

const connBtn = $("toggleConnBtn");
const connDetails = $("connDetails");
if (connBtn && connDetails) {
  connBtn.onclick = () => {
    const open = connDetails.hasAttribute("hidden");
    if (open) connDetails.removeAttribute("hidden");
    else connDetails.setAttribute("hidden", "");
    connBtn.setAttribute("aria-expanded", open ? "true" : "false");
    connBtn.textContent = open ? "Hide details" : "Show details";
  };
}

const chatToggle = $("toggleChatBtn");
if (chatToggle) {
  chatToggle.onclick = () => {
    const body = $("chatBody");
    const open = body?.hasAttribute("hidden");
    setChatExpanded(Boolean(open));
  };
}

const helpBtn = $("helpBtn");
const helpModal = $("helpModal");
const helpClose = $("helpClose");
if (helpBtn && helpModal) {
  helpBtn.onclick = () => helpModal.removeAttribute("hidden");
  helpClose && (helpClose.onclick = () => helpModal.setAttribute("hidden", ""));
  helpModal.addEventListener("click", (ev) => {
    if (ev.target === helpModal) helpModal.setAttribute("hidden", "");
  });
}

document.addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-copy]");
  if (!btn) return;
  ev.preventDefault();
  const id = btn.getAttribute("data-copy");
  const text = $(id)?.textContent || "";
  copyText(text)
    .then(() => toast("Copied"))
    .catch(() => toast("Copy failed"));
});

const PRESETS = {
  custom: { label: "", lane: "main", rtmpUrl: "" },
  youtube: {
    label: "YouTube",
    lane: "main",
    rtmpUrl: "rtmp://a.rtmp.youtube.com/live2",
  },
  twitch: {
    label: "Twitch",
    lane: "main",
    rtmpUrl: "rtmp://live.twitch.tv/app",
  },

  kick: { label: "Kick", lane: "main", rtmpUrl: "" },
};

function guessPlatform(label, rtmpUrl) {
  const hay = `${label} ${rtmpUrl}`.toLowerCase();
  if (/youtu|googlevideo/.test(hay)) return "youtube";
  if (/twitch/.test(hay)) return "twitch";
  if (/kick|live-video\.net/.test(hay)) return "kick";
  return "custom";
}

function slugId(label, lane) {
  let base = String(label || "dest")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
  if (!base) base = "dest";
  if (lane === "vertical" && !/-v$/i.test(base)) base = `${base}-v`.slice(0, 32);
  return base.slice(0, 32);
}

let editingDest = null;

function clearDestForm(form) {
  const f = form || $("targetForm");
  if (!f) return;
  f.label.value = "";
  f.lane.value = "main";
  f.rtmpUrl.value = "";
  f.streamKey.value = "";
  f.streamKey.placeholder = "paste from platform";
  editingDest = null;
  const hint = $("destEditHint");
  if (hint) hint.hidden = true;
  const cancel = $("destEditCancel");
  if (cancel) cancel.hidden = true;
  const saveBtn = $("destSaveBtn");
  if (saveBtn) saveBtn.textContent = "Save";
}

function openEditDestination(t) {
  const form = $("targetForm");
  if (!form || !t?.id) return;
  const details = form.closest("details");
  if (details) details.open = true;
  editingDest = {
    id: t.id,
    platform: t.platform || guessPlatform(t.label || "", t.rtmpUrl || ""),
    label: t.label || t.id,
    lane: t.lane === "vertical" ? "vertical" : "main",
    rtmpUrl: t.rtmpUrl || "",
  };
  form.label.value = editingDest.label;
  form.lane.value = editingDest.lane;
  form.rtmpUrl.value = editingDest.rtmpUrl;
  form.streamKey.value = "";
  form.streamKey.placeholder = "leave empty to keep current key";
  const hint = $("destEditHint");
  if (hint) hint.hidden = false;
  const cancel = $("destEditCancel");
  if (cancel) cancel.hidden = false;
  const saveBtn = $("destSaveBtn");
  if (saveBtn) saveBtn.textContent = "Update";
  form.scrollIntoView({ behavior: "smooth", block: "nearest" });
  form.streamKey.focus();
  toast(`Editing ${displayDestName(editingDest.label, editingDest.lane)}`);
}

let deletePending = null;

function openDeleteModal(id, label) {
  deletePending = { id, label };
  const modal = $("deleteModal");
  const exact = $("deleteNameExact");
  const input = $("deleteConfirmInput");
  const btn = $("deleteConfirmBtn");
  if (exact) exact.textContent = label;
  if (input) {
    input.value = "";
    input.focus();
  }
  if (btn) btn.disabled = true;
  modal?.removeAttribute("hidden");
}

function closeDeleteModal() {
  deletePending = null;
  $("deleteModal")?.setAttribute("hidden", "");
}

async function confirmDeleteDestination() {
  if (!deletePending) return;
  const typed = ($("deleteConfirmInput")?.value || "").trim();
  if (typed !== deletePending.label) {
    toast("Name does not match");
    return;
  }
  try {
    await api(`/api/v1/targets/${encodeURIComponent(deletePending.id)}`, {
      method: "DELETE",
    });
    toast(`Deleted ${deletePending.label}`);
    closeDeleteModal();
    await loadTargets();
  } catch (e) {
    toast(`Delete failed: ${e.message}`);
  }
}

document.querySelectorAll("[data-preset]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const key = btn.getAttribute("data-preset");
    const p = PRESETS[key];
    if (!p) return;
    clearDestForm($("targetForm"));
    const form = $("targetForm");
    form.label.value = p.label;
    form.lane.value = p.lane || "main";
    form.rtmpUrl.value = p.rtmpUrl;
    form.streamKey.value = "";
    form.streamKey.focus();
    if (key === "kick") toast("Kick — paste Server URL + stream key from Kick");
    else if (key === "custom") toast("Custom — fill name, URL, key");
    else toast(`${p.label} — paste stream key (name editable)`);
  });
});

$("destEditCancel") &&
  ($("destEditCancel").onclick = () => {
    clearDestForm($("targetForm"));
    toast("Edit cancelled");
  });

$("targetForm").onsubmit = async (ev) => {
  ev.preventDefault();
  try {
    const fd = new FormData(ev.target);
    const label = String(fd.get("label") || "").trim();
    const lane = String(fd.get("lane") || "main");
    const rtmpUrl = String(fd.get("rtmpUrl") || "").trim();
    const streamKey = String(fd.get("streamKey") || "").trim();
    if (!label) throw new Error("Name is required");
    if (!rtmpUrl) throw new Error("Server URL is required");
    const isEdit = Boolean(editingDest?.id);
    if (!isEdit && !streamKey) throw new Error("Stream key is required for new destinations");
    const platform = isEdit
      ? editingDest.platform || guessPlatform(label, rtmpUrl)
      : guessPlatform(label, rtmpUrl);
    const id = isEdit ? editingDest.id : slugId(label, lane);
    const body = { label, platform, lane, rtmpUrl };
    if (streamKey) body.streamKey = streamKey;
    await api(`/api/v1/targets/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    clearDestForm(ev.target);
    toast(
      isEdit
        ? `Updated ${displayDestName(label, lane)}${streamKey ? "" : " (key unchanged)"}`
        : `Saved ${displayDestName(label, lane)} — turn On while OBS is live`
    );
    await loadTargets();
  } catch (e) {
    toast(`Save failed: ${e.message}`);
  }
};

{
  const delIn = $("deleteConfirmInput");
  const delBtn = $("deleteConfirmBtn");
  if (delIn && delBtn) {
    delIn.oninput = () => {
      delBtn.disabled = !deletePending || delIn.value.trim() !== deletePending.label;
    };
    delBtn.onclick = () => void confirmDeleteDestination();
  }
  $("deleteClose") && ($("deleteClose").onclick = closeDeleteModal);
  $("deleteCancel") && ($("deleteCancel").onclick = closeDeleteModal);
  $("deleteModal")?.addEventListener("click", (ev) => {
    if (ev.target === $("deleteModal")) closeDeleteModal();
  });
}

$("cmdForm").onsubmit = async (ev) => {
  ev.preventDefault();
  try {
    const fd = new FormData(ev.target);
    const name = String(fd.get("name"));
    await api(`/api/v1/commands/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify({ response: fd.get("response") }),
    });
    ev.target.reset();
    await loadCommands();
    toast("Command saved");
  } catch (e) {
    toast(`Save failed: ${e.message}`);
  }
};

$("saveWelcome").onclick = async () => {
  try {
    await api("/api/v1/settings/welcome", {
      method: "PUT",
      body: JSON.stringify({ template: $("welcome").value }),
    });
    toast("Welcome saved");
  } catch (e) {
    toast(`Save failed: ${e.message}`);
  }
};

$("sendForm").onsubmit = async (ev) => {
  ev.preventDefault();
  try {
    const fd = new FormData(ev.target);
    const text = String(fd.get("text") || "").trim();
    if (!text) return;
    await api("/api/v1/chat/send", { method: "POST", body: JSON.stringify({ text }) });
    ev.target.reset();
    toast("Sent");
  } catch (e) {
    toast(`Send failed: ${e.message}`);
  }
};

document.querySelectorAll("[data-chat-filter]").forEach((btn) => {
  btn.onclick = () => applyChatFilter(btn.getAttribute("data-chat-filter") || "all");
});

window.addEventListener("message", (ev) => {
  if (ev?.data?.type === "omnix-yt-oauth" || ev?.data?.type === "omnix-oauth") {
    void loadYoutubeStatus();
    toast(ev.data.ok ? "Account connected" : "Connect failed");
  }
});

async function wireConnect(btnId, platform) {
  const btn = $(btnId);
  if (!btn) return;
  btn.onclick = async () => {
    try {
      await startPlatformConnect(platform);
    } catch (e) {
      toast(`Connect failed: ${e.message}`);
    }
  };
}

async function wireDisconnect(btnId, platform) {
  const btn = $(btnId);
  if (!btn) return;
  btn.onclick = async () => {
    try {
      const path =
        platform === "youtube"
          ? "/api/v1/youtube/oauth/disconnect"
          : `/api/v1/oauth/${platform}/disconnect`;
      await api(path, { method: "POST", body: "{}" });
      await loadYoutubeStatus();
      toast("Disconnected");
    } catch (e) {
      toast(e.message);
    }
  };
}

void wireConnect("ytConnectBtn", "youtube");
void wireConnect("twitchConnectBtn", "twitch");
void wireConnect("kickConnectBtn", "kick");
void wireDisconnect("ytDisconnectBtn", "youtube");
void wireDisconnect("twitchDisconnectBtn", "twitch");
void wireDisconnect("kickDisconnectBtn", "kick");

$("deviceClose") && ($("deviceClose").onclick = () => closeDeviceModal());
$("deviceCancel") && ($("deviceCancel").onclick = () => closeDeviceModal());
$("deviceModal")?.addEventListener("click", (ev) => {
  if (ev.target === $("deviceModal")) closeDeviceModal();
});
$("deviceFallback") &&
  ($("deviceFallback").onclick = async () => {
    closeDeviceModal();
    try {
      const s = await api("/api/v1/youtube/oauth/start");
      window.open(s.url, "omnix-oauth", "width=520,height=720");
      toast("Browser Connect — still saved only on this server");
    } catch (e) {
      toast(e.message);
    }
  });

$("linkShowToken") &&
  ($("linkShowToken").onchange = () => {
    const input = $("linkTunnelToken");
    if (!input) return;
    input.type = $("linkShowToken").checked ? "text" : "password";
  });

$("linkChangeBtn") &&
  ($("linkChangeBtn").onclick = () => {
    const ok = window.confirm(
      "Replace Omnix Link token?\n\nOnly do this if you created a new token on Omnix Link. You will need to confirm the egg again."
    );
    if (!ok) return;
    window.__linkChangingToken = true;
    showLinkViews({ linked: true, changing: true });
    if ($("linkTunnelToken")) {
      $("linkTunnelToken").value = "";
      $("linkTunnelToken").focus();
    }
  });

$("linkUnlinkBtn") &&
  ($("linkUnlinkBtn").onclick = async () => {
    const ok = window.confirm(
      "Unlink Omnix Link from this panel?\n\nYou can pair again anytime with a new Connect Relay token. Platform Connect stays on Omnix Link."
    );
    if (!ok) return;
    try {
      await api("/api/v1/oauth/link/unlink", { method: "POST", body: "{}" });
      window.__linkChangingToken = false;
      if ($("linkTunnelToken")) $("linkTunnelToken").value = "";
      toast("Omnix Link unlinked on this panel");
      await loadLinkStatus();
    } catch (e) {
      toast(e.message);
    }
  });

$("linkCancelChangeBtn") &&
  ($("linkCancelChangeBtn").onclick = async () => {
    window.__linkChangingToken = false;
    await loadLinkStatus();
  });

$("linkOpenBtn") &&
  ($("linkOpenBtn").onclick = (ev) => {

    const href = $("linkOpenBtn").getAttribute("href") || "https://relaylink.omnixstudio.xyz/app";
    window.open(href, "_blank", "noopener,noreferrer");
    ev.preventDefault();
  });

$("linkSaveBtn") &&
  ($("linkSaveBtn").onclick = async () => {
    try {
      const token = ($("linkTunnelToken")?.value || "").trim();
      if (!token) throw new Error("Paste the Connect Relay token first");
      const s = await api("/api/v1/oauth/link/config", {
        method: "POST",
        body: JSON.stringify({ tunnelToken: token }),
      });
      if ($("linkTunnelToken")) $("linkTunnelToken").value = "";
      window.__linkChangingToken = false;
      toast("Connecting — confirm this relay on Omnix Link");
      await loadLinkStatus();
      if (s.status && s.status !== "linked") {
        toast("Waiting for confirm on Omnix Link…");
      }
    } catch (e) {
      toast(e.message);
    }
  });

document.querySelector(".lm-yt-lives")?.addEventListener("toggle", (ev) => {
  const el = ev.currentTarget;
  if (el?.open) {
    void loadYoutubeLives();
    void loadLiveCategories();
  }
});

$("ytRefreshLivesBtn") &&
  ($("ytRefreshLivesBtn").onclick = async () => {
    try {
      await loadYoutubeLives();
      toast("Lives refreshed");
    } catch (e) {
      toast(e.message);
    }
  });

$("lmModeAio") && ($("lmModeAio").onclick = () => setLmMode("aio"));
$("lmModeCustom") && ($("lmModeCustom").onclick = () => setLmMode("custom"));
setLmMode("aio");

$("lmSaveBtn") &&
  ($("lmSaveBtn").onclick = async () => {
    try {
      const draft = readLmDraft();

      const thumb = await readYtThumbnail();
      const suggested =
        draft.mode === "aio"
          ? draft.aio?.title
          : draft.custom?.youtube?.title || draft.custom?.twitch?.title || draft.custom?.kick?.title;
      const existingName =
        (window.__lmEditingId &&
          (window.__lmPresets || []).find((x) => x.id === window.__lmEditingId)?.name) ||
        (window.__lmDefaultId &&
          (window.__lmPresets || []).find((x) => x.id === window.__lmDefaultId)?.name) ||
        suggested ||
        "My stream";
      const name = window.prompt("Preset name (same name updates the existing preset)", String(existingName).slice(0, 40)) || "";
      if (!name.trim()) return;

      const payload = {
        id: window.__lmEditingId || window.__lmDefaultId || undefined,
        name: name.trim(),
        ...draft,
      };
      const saved = await api("/api/v1/live/presets", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const presetId = saved?.preset?.id || window.__lmEditingId || window.__lmDefaultId;
      if (!presetId) throw new Error("Preset save failed — no id returned");
      window.__lmEditingId = null;
      window.__lmDefaultId = presetId;
      window.__lmDefaultLoaded = true;

      let thumbOk = Boolean(saved?.preset?.hasThumbnail);
      if (thumb.thumbnailBase64) {
        const tr = await api(`/api/v1/live/presets/${encodeURIComponent(presetId)}/thumbnail`, {
          method: "PUT",
          body: JSON.stringify({
            thumbnailBase64: thumb.thumbnailBase64,
            thumbnailMime: thumb.thumbnailMime,
            thumbnailName: thumb.thumbnailName,
          }),
        });
        thumbOk = true;
        showLmThumbPreview(thumb.thumbnailBase64, {
          name: tr.thumbnailName || thumb.thumbnailName,
          bytes: tr.thumbnailBytes || thumb.thumbnailBytes,
          pending: false,
        });
        toast(`Preset saved · thumb ${tr.thumbnailName || thumb.thumbnailName} (${fmtThumbMb(tr.thumbnailBytes || thumb.thumbnailBytes)})`);
      } else if (thumbOk) {
        toast(`Preset saved · thumb ${saved.preset.thumbnailName || "image"} (${fmtThumbMb(saved.preset.thumbnailBytes)})`);
      } else {
        toast("Preset saved — no thumbnail yet (choose a file, then Save again)");
      }

      if ($("lmYtThumb")) $("lmYtThumb").value = "";
      if ($("lmYtThumbCustom")) $("lmYtThumbCustom").value = "";
      await loadLivePresets();
      await loadPresetThumbnail(presetId);
    } catch (e) {
      toast(e.message || "Save failed");
    }
  });

$("lmApplyBtn") &&
  ($("lmApplyBtn").onclick = async () => {
    const btn = $("lmApplyBtn");
    if (btn) btn.disabled = true;
    try {
      const draft = { ...readLmDraft(), ...(await readYtThumbnail()) };
      const r = await api("/api/v1/live/apply", {
        method: "POST",
        body: JSON.stringify({ draft, forceAll: true }),
      });
      toast(`Titles · ${summarizeApply(r)}`);
      if ($("lmHint")) $("lmHint").textContent = summarizeApply(r);
      await loadTargets();
      await loadLiveSession();
    } catch (e) {
      toast(`Update failed: ${String(e.message || "").replace(/<[^>]+>/g, "")}`);
    } finally {
      if (btn) btn.disabled = false;
    }
  });

$("lmCreateBtn") &&
  ($("lmCreateBtn").onclick = async () => {
    const ok = await confirmLmAction(
      "Create stream?",
      "Uses your default Live Manager preset and opens one YouTube Control Room live (main + Shorts Encoder keys). API quota applies. Continue?"
    );
    if (!ok) return;
    setCreateBusy(true);
    try {

      if (window.__lmDefaultId && !String($("lmTitle")?.value || $("lmYtTitle")?.value || "").trim()) {
        const def = (window.__lmPresets || []).find((x) => x.id === window.__lmDefaultId);
        if (def) applyLmPreset(def);
        await loadPresetThumbnail(window.__lmDefaultId);
      }
      const draft = { ...readLmDraft(), ...(await readYtThumbnail()) };
      const presetId = window.__lmDefaultId || undefined;
      const r = await api("/api/v1/live/session/create", {
        method: "POST",
        body: JSON.stringify({ draft, presetId }),
      });
      toast(`Created · ${summarizeApply(r)}`);
      const ytDetail = r.results?.youtube?.detail || "";
      if (/thumb:/i.test(ytDetail)) toast(`Thumbnail note: ${ytDetail}`);
      window.__lmSession = r.session;
      renderSession(r.session, r.runtime);
      await loadTargets();
      await loadYoutubeLives();

      const targets = await api("/api/v1/targets").catch(() => []);
      const vert = (targets || []).find((t) => t.id === "youtube-v");
      const vertMissing =
        r.verticalKeyMissing === true ||
        Boolean(vert?.keyPending) ||
        /not set|pending/i.test(String(vert?.keyMasked || ""));
      if (vertMissing || r.session?.youtubeMainId || r.studioUrl) {
        openYtEncoderModal({
          session: r.session,
          studioUrl: r.studioUrl,
          verticalKeyMissing: vertMissing,
          requireKey: vertMissing,
        });
      }
    } catch (e) {
      toast(`Create failed: ${String(e.message || "").replace(/<[^>]+>/g, "")}`);
    } finally {
      setCreateBusy(false);
      await loadLiveSession();
    }
  });

$("ytEncoderClose") && ($("ytEncoderClose").onclick = () => closeYtEncoderModal());
$("ytEncoderDone") && ($("ytEncoderDone").onclick = () => closeYtEncoderModal());
$("ytEncoderSaveKey") && ($("ytEncoderSaveKey").onclick = () => void saveYtEncoderKeyFromModal());
$("ytEncoderModal") &&
  $("ytEncoderModal").addEventListener("click", (ev) => {
    if (ev.target === $("ytEncoderModal")) closeYtEncoderModal();
  });

$("lmStartBtn") &&
  ($("lmStartBtn").onclick = async () => {
    const ok = await confirmLmAction(
      "Start stream?",
      "Platforms go live. Starting-soon media loops until OBS connects. Timers auto-end if OBS never arrives."
    );
    if (!ok) return;
    const btn = $("lmStartBtn");
    if (btn) btn.disabled = true;
    try {
      const r = await api("/api/v1/live/session/start", { method: "POST", body: "{}" });
      toast("Started — waiting for OBS / playing start media");
      renderSession(r.session, r.runtime);
      await loadTargets();
    } catch (e) {
      toast(`Start failed: ${e.message}`);
      await loadLiveSession();
    }
  });

$("lmEndBtn") &&
  ($("lmEndBtn").onclick = async () => {
    const ok = await confirmLmAction(
      "End stream?",
      "End credits video will play for the configured time (default 45s), then YouTube/destinations complete. Continue?"
    );
    if (!ok) return;
    const btn = $("lmEndBtn");
    if (btn) btn.disabled = true;
    try {
      const r = await api("/api/v1/live/session/end", { method: "POST", body: "{}" });
      if (r.endingCredits) {
        toast("Ending — playing end credits…");
      } else {
        toast("Stream ended");
      }
      renderSession(r.session, r.runtime);
      await loadTargets();
    } catch (e) {
      toast(`End failed: ${e.message}`);
      await loadLiveSession();
    } finally {
      await loadLiveSession();
    }
  });

$("lmMediaStartUpload") && ($("lmMediaStartUpload").onclick = () => void uploadMediaSlot("start", "lmMediaStartFile"));
$("lmMediaIdleUpload") && ($("lmMediaIdleUpload").onclick = () => void uploadMediaSlot("idle", "lmMediaIdleFile"));
$("lmMediaEndUpload") && ($("lmMediaEndUpload").onclick = () => void uploadMediaSlot("end", "lmMediaEndFile"));

async function clearMediaSlot(slot) {
  try {
    await api(`/api/v1/live/media/${slot}`, { method: "DELETE" });
    toast(`${slot} media removed`);
    await loadLiveSession();
  } catch (e) {
    toast(e.message);
  }
}
$("lmMediaStartClear") && ($("lmMediaStartClear").onclick = () => void clearMediaSlot("start"));
$("lmMediaIdleClear") && ($("lmMediaIdleClear").onclick = () => void clearMediaSlot("idle"));
$("lmMediaEndClear") && ($("lmMediaEndClear").onclick = () => void clearMediaSlot("end"));

$("lmTimersEditBtn") &&
  ($("lmTimersEditBtn").onclick = () => {
    const t = window.__lmTimers || {};
    if ($("lmTimerStartSec")) $("lmTimerStartSec").value = String(Math.round((t.startWaitMs || 50 * 60000) / 1000));
    if ($("lmTimerBrbSec")) $("lmTimerBrbSec").value = String(Math.round((t.brbWaitMs || 30 * 60000) / 1000));
    if ($("lmTimerEndSec")) $("lmTimerEndSec").value = String(Math.round((t.endPlayMs || 20000) / 1000));
    if ($("lmTimersEdit")) $("lmTimersEdit").hidden = false;
  });
$("lmTimersCancelBtn") &&
  ($("lmTimersCancelBtn").onclick = () => {
    if ($("lmTimersEdit")) $("lmTimersEdit").hidden = true;
  });
$("lmTimersSaveBtn") &&
  ($("lmTimersSaveBtn").onclick = async () => {
    try {
      await api("/api/v1/live/media/timers", {
        method: "PATCH",
        body: JSON.stringify({
          startWaitSec: Number($("lmTimerStartSec")?.value || 3000),
          brbWaitSec: Number($("lmTimerBrbSec")?.value || 1800),
          endPlaySec: Number($("lmTimerEndSec")?.value || 20),
        }),
      });
      toast("Timers saved");
      if ($("lmTimersEdit")) $("lmTimersEdit").hidden = true;
      await loadLiveSession();
    } catch (e) {
      toast(e.message);
    }
  });

$("destAutoAddBtn") &&
  ($("destAutoAddBtn").onclick = async () => {
    try {
      const r = await api("/api/v1/live/destinations/auto-add", { method: "POST", body: "{}" });
      const added = (r.added || []).join(", ") || "none";
      const errs = Object.keys(r.errors || {}).length
        ? ` · ${Object.entries(r.errors)
            .map(([k, v]) => `${k}:${v}`)
            .join("; ")}`
        : "";
      toast(`Auto-add · ${added}${errs}`);
      await loadTargets();
    } catch (e) {
      toast(e.message);
    }
  });

if (state.accessToken) {
  api("/api/v1/status")
    .then(() => enter())
    .catch(() => showApp(false));
} else {
  showApp(false);
}
