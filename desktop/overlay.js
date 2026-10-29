const params = new URLSearchParams(location.search);
const relay = (params.get("relay") || "").replace(/\/$/, "");
const access = params.get("access") || "";
const box = document.getElementById("chat");

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function append(msg) {
  if (box.querySelector(".sub")) box.innerHTML = "";
  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML = `<span class="plat">${escapeHtml(msg.platform)}</span><strong>${escapeHtml(msg.user)}</strong>: ${escapeHtml(msg.text)}`;
  box.appendChild(row);
  while (box.children.length > 80) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
}

if (!relay || !access) {
  box.innerHTML = `<p class="err">Missing relay or token</p>`;
} else {
  const proto = relay.startsWith("https") ? "wss" : "ws";
  const host = relay.replace(/^https?:\/\//, "");
  const ws = new WebSocket(`${proto}://${host}/api/v1/ws`);
  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "auth", token: access }));
    box.innerHTML = `<p class="sub">Live chat overlay</p>`;
  });
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "chat") append(msg);
  });
  ws.addEventListener("close", () => {
    const p = document.createElement("p");
    p.className = "sub";
    p.textContent = "Disconnected — reopen overlay";
    box.appendChild(p);
  });
}
