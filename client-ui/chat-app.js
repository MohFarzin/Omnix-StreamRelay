const state = {
  accessToken: localStorage.getItem("omnix_access") || "",
  refreshToken: localStorage.getItem("omnix_refresh") || "",
  ws: null,
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

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (state.accessToken) headers.Authorization = `Bearer ${state.accessToken}`;
  const hasBody = opts.body !== undefined && opts.body !== null;
  if (hasBody && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
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
}

function appendChat(msg) {
  const el = $("chat");
  const empty = el.querySelector(".empty");
  if (empty) empty.remove();
  const row = document.createElement("div");
  row.className = "row";
  row.dataset.platform = msg.platform || "";
  row.innerHTML = `<span class="plat">${escapeHtml(msg.platform)}</span> <strong>${escapeHtml(msg.user)}</strong>: ${escapeHtml(msg.text)}`;
  if (state.chatFilter !== "all" && msg.platform !== state.chatFilter) row.hidden = true;
  el.appendChild(row);
  while (el.children.length > 500) el.firstChild.remove();
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

function renderChatStatus(chat) {
  const box = $("chatStatus");
  if (!box || !chat) return;
  const connected = chat.connected || [];
  if (connected.length) {
    box.innerHTML = `<span class="ok">Connected: ${connected.join(", ")}</span>`;
    return;
  }
  box.textContent = "No chat platforms connected — configure on the egg / dashboard.";
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
      const chats =
        Array.isArray(msg.chatPlatforms) && msg.chatPlatforms.length
          ? msg.chatPlatforms.join("+")
          : "off";
      b.textContent = (msg.live ? "LIVE" : "idle") + ` · chat:${chats}`;
      b.classList.toggle("live", Boolean(msg.live || msg.vertical?.live));
      if (msg.chat) renderChatStatus(msg.chat);
    }
  });
}

async function enter() {
  showApp(true);
  connectWs();
  try {
    const s = await api("/api/v1/setup");
    renderChatStatus(s.chat);
  } catch {
    /* ignore */
  }
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
  showApp(false);
};

$("sendForm").onsubmit = async (ev) => {
  ev.preventDefault();
  try {
    const fd = new FormData(ev.target);
    const text = String(fd.get("text") || "").trim();
    if (!text) return;
    await api("/api/v1/chat/send", { method: "POST", body: JSON.stringify({ text }) });
    ev.target.reset();
  } catch (e) {
    toast(`Send failed: ${e.message}`);
  }
};

document.querySelectorAll("[data-chat-filter]").forEach((btn) => {
  btn.onclick = () => applyChatFilter(btn.getAttribute("data-chat-filter") || "all");
});

if (state.accessToken) {
  api("/api/v1/status")
    .then(() => enter())
    .catch(() => showApp(false));
} else {
  showApp(false);
}
