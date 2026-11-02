/* api.js — the ONLY file that knows where data comes from.
   USE_MOCK = true  -> reads the JSON files in /mock (no backend)
   USE_MOCK = false -> calls the Flask + PostgreSQL API (backend/app.py) */
const USE_MOCK = false;
// Deployed with the pages on another host (e.g. Vercel)? Put the Flask address here, e.g. "https://yourname-mamasu.hf.space".
// Leave "" when Flask serves the pages itself (local run or Hugging Face Space).
const REMOTE_API = "";
// same address as the page when Flask serves it; if you open the pages with Live Server (another port) we call Flask on :5000
const API_BASE = REMOTE_API || (location.protocol === "file:" || (location.port && location.port !== "5000") ? "http://localhost:5000" : "");

function saveSession(data) { localStorage.setItem("session", JSON.stringify({ token: data.token, user: data.user })); }
function token() { const s = UI.session(); return s ? s.token : ""; }

async function api(path, options = {}) {
  const url = USE_MOCK ? `${UI.root()}mock/${path.split("?")[0].replace(/^\/api\//, "").replace(/\//g, "-")}.json` : `${API_BASE}${path}`;
  const headers = { "Content-Type": "application/json", ...(token() ? { Authorization: "Bearer " + token() } : {}) };
  const init = { method: options.method || "GET", headers };
  if (options.body instanceof FormData) { delete headers["Content-Type"]; init.body = options.body; }
  else if (options.body !== undefined) init.body = JSON.stringify(options.body);

  const response = await fetch(url, init);                 // throws TypeError when there is no connection (= offline)
  let data = null;
  try { data = await response.json(); } catch { /* no body */ }
  if (response.status === 401 && !path.includes("/auth/login")) {          // signed out / token expired
    localStorage.removeItem("session");
    location.replace(UI.root() + "login.html");
  }
  if (!response.ok) { const e = new Error((data && data.error) || `Error ${response.status}`); e.status = response.status; throw e; }
  return data;
}
const isOffline = (e) => !!e && e.name === "TypeError";   // fetch could not reach the server (= offline)

function query(obj) {
  const p = new URLSearchParams();
  Object.entries(obj).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== "") p.set(k, v); });
  const s = p.toString();
  return s ? "?" + s : "";
}
