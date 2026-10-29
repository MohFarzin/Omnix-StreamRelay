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
  // clipboard API needs HTTPS; we are on http:// — always have a fallback
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {
    /* fall through */
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
  // Only set JSON content-type when we actually send a body (Fastify rejects empty JSON body)
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
    throw new Error(err.error || err.message || res.statusText);
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
      /* ignore */
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
    if (msg.type === "ingest") {
      const b = $("ingestBadge");
      const chats = Array.isArray(msg.chatPlatforms) && msg.chatPlatforms.length
        ? ` · chat:${msg.chatPlatforms.join("+")}`
        : " · chat:off";
      const main = msg.live ? `LIVE · ${msg.path}` : `idle · ${msg.path}`;
      const vert = msg.vertical
        ? msg.vertical.live
          ? ` · V:LIVE`
          : ` · V:idle`
        : "";
      b.textContent = main + vert + chats;
      b.classList.toggle("live", Boolean(msg.live || msg.vertical?.live));
      if (msg.chat) renderChatStatus(msg.chat);
    }
    if (msg.type === "target" && !state.busy) upsertTargetRow(msg);
  });
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
    // send {} so Content-Type json is valid for Fastify
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
  return lane === "vertical" ? `${base} · vertical` : `${base} · main`;
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
    $("targets").innerHTML = `<p class="empty">No targets yet — add one below.</p>`;
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
    // Working → keep compact so video controls stay primary
    setChatExpanded(false);
    return;
  }
  box.innerHTML = `<strong>Chat off</strong> — video still works. Tap <em>?</em> for setup.`;
  // Not configured → open so status is obvious
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

async function loadYoutubeStatus() {
  const statusEl = $("ytStatus");
  const connectBtn = $("ytConnectBtn");
  const disconnectBtn = $("ytDisconnectBtn");
  if (!statusEl) return;
  try {
    const s = await api("/api/v1/youtube/status");
    if (!s.oauthConfigured) {
      statusEl.textContent =
        "Set YOUTUBE_CLIENT_ID + YOUTUBE_CLIENT_SECRET on the egg, restart, then connect.";
      if (connectBtn) connectBtn.disabled = true;
      if (disconnectBtn) disconnectBtn.hidden = true;
      return;
    }
    if (connectBtn) connectBtn.disabled = false;
    if (s.connected) {
      statusEl.textContent = `Google connected${s.liveChatId ? " · chat id ready" : ""}. Redirect URI: ${s.redirectUri || ""}`;
      if (disconnectBtn) disconnectBtn.hidden = false;
    } else {
      statusEl.textContent = `Not connected. Add this redirect in Google Cloud: ${s.redirectUri || ""}`;
      if (disconnectBtn) disconnectBtn.hidden = true;
    }
  } catch (e) {
    statusEl.textContent = `YouTube status failed: ${e.message}`;
  }
}

async function enter() {
  showApp(true);
  connectWs();
  await Promise.all([loadSetup(), loadTargets(), loadCommands(), loadYoutubeStatus()]);
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
    /* ignore */
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

// Event delegation for copy buttons (works even after setup reloads)
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
  // Kick ingest host is per-account — leave URL empty
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

function clearDestForm(form) {
  form.label.value = "";
  form.lane.value = "main";
  form.rtmpUrl.value = "";
  form.streamKey.value = "";
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
    if (!streamKey) throw new Error("Stream key is required for new / replace save");
    const platform = guessPlatform(label, rtmpUrl);
    const id = slugId(label, lane);
    await api(`/api/v1/targets/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({ label, platform, lane, rtmpUrl, streamKey }),
    });
    clearDestForm(ev.target);
    toast(`Saved ${displayDestName(label, lane)} — turn On while OBS is live`);
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
  if (ev?.data?.type === "omnix-yt-oauth") {
    void loadYoutubeStatus();
    toast(ev.data.ok ? "Google connected" : "Google connect failed");
  }
});

$("ytConnectBtn") &&
  ($("ytConnectBtn").onclick = async () => {
    try {
      const s = await api("/api/v1/youtube/oauth/start");
      window.open(s.url, "omnix-yt-oauth", "width=520,height=720");
      toast("Finish Google sign-in in the popup");
    } catch (e) {
      toast(`Connect failed: ${e.message}`);
    }
  });

$("ytDisconnectBtn") &&
  ($("ytDisconnectBtn").onclick = async () => {
    try {
      await api("/api/v1/youtube/oauth/disconnect", { method: "POST", body: "{}" });
      await loadYoutubeStatus();
      toast("Google disconnected");
    } catch (e) {
      toast(e.message);
    }
  });

$("ytTokenForm") &&
  ($("ytTokenForm").onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      const token = $("ytRefreshToken")?.value?.trim() || "";
      await api("/api/v1/youtube/oauth/token", {
        method: "POST",
        body: JSON.stringify({ refreshToken: token }),
      });
      $("ytRefreshToken").value = "";
      await loadYoutubeStatus();
      toast("Refresh token saved");
    } catch (e) {
      toast(`Token failed: ${e.message}`);
    }
  });

$("ytLiveForm") &&
  ($("ytLiveForm").onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = $("ytCreateBtn");
    if (btn) btn.disabled = true;
    try {
      let thumbnailBase64 = "";
      let thumbnailMime = "";
      const file = $("ytThumb")?.files?.[0];
      if (file) {
        if (file.size > 2_000_000) throw new Error("thumbnail must be under 2MB");
        thumbnailMime = file.type || "image/jpeg";
        thumbnailBase64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ""));
          reader.onerror = () => reject(new Error("thumbnail read failed"));
          reader.readAsDataURL(file);
        });
      }
      const body = {
        title: $("ytTitle")?.value || "",
        description: $("ytDesc")?.value || "",
        privacy: $("ytPrivacy")?.value || "unlisted",
        lane: $("ytLane")?.value || "main",
        enable: Boolean($("ytEnable")?.checked),
        thumbnailBase64: thumbnailBase64 || undefined,
        thumbnailMime: thumbnailMime || undefined,
      };
      const res = await api("/api/v1/youtube/live/create", {
        method: "POST",
        body: JSON.stringify(body),
      });
      toast(`YouTube live ready · ${res.targetId || "youtube"}`);
      if (res.watchUrl) {
        const hint = $("ytCreateHint");
        if (hint) hint.innerHTML = `Watch: <a href="${escapeHtml(res.watchUrl)}" target="_blank" rel="noopener">${escapeHtml(res.watchUrl)}</a>`;
      }
      await loadTargets();
      await loadYoutubeStatus();
    } catch (e) {
      toast(`Create failed: ${e.message}`);
    } finally {
      if (btn) btn.disabled = false;
    }
  });

if (state.accessToken) {
  api("/api/v1/status")
    .then(() => enter())
    .catch(() => showApp(false));
} else {
  showApp(false);
}
