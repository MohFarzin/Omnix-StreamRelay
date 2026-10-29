const saved = JSON.parse(localStorage.getItem("omnix_desktop") || "{}");
const relayInput = document.getElementById("relayUrl");
const tokenInput = document.getElementById("token");
const err = document.getElementById("err");

relayInput.value = saved.relayUrl || import.meta.env.VITE_OMNIX_RELAY_URL || "http://127.0.0.1:8080";
tokenInput.value = "";

function showErr(msg) {
  err.hidden = !msg;
  err.textContent = msg || "";
}

async function login(relay, bootstrap) {
  const res = await fetch(`${relay.replace(/\/$/, "")}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bootstrapToken: bootstrap }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "login failed");
  return data;
}

document.getElementById("openDash").onclick = async () => {
  showErr("");
  try {
    const relay = relayInput.value.trim().replace(/\/$/, "");
    const data = await login(relay, tokenInput.value.trim());
    localStorage.setItem(
      "omnix_desktop",
      JSON.stringify({ relayUrl: relay, access: data.accessToken, refresh: data.refreshToken })
    );
    // Open relay dashboard in system browser / same webview navigation
    window.location.href = `${relay}/?desktop=1#access=${encodeURIComponent(data.accessToken)}`;
  } catch (e) {
    showErr(e.message);
  }
};

document.getElementById("openOverlay").onclick = async () => {
  showErr("");
  try {
    const relay = relayInput.value.trim().replace(/\/$/, "");
    let access = JSON.parse(localStorage.getItem("omnix_desktop") || "{}").access;
    if (!access) {
      const data = await login(relay, tokenInput.value.trim());
      access = data.accessToken;
      localStorage.setItem(
        "omnix_desktop",
        JSON.stringify({ relayUrl: relay, access: data.accessToken, refresh: data.refreshToken })
      );
    }
    window.location.href = `/overlay.html?relay=${encodeURIComponent(relay)}&access=${encodeURIComponent(access)}`;
  } catch (e) {
    showErr(e.message);
  }
};
