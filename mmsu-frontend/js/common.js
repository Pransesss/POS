/* common.js — loaded on EVERY page. Today's date/time (always the real "now"), sign-in guard, sidebar, toast + modal helpers.
   No backend calls here. */
const UI = {
  $: (s, r = document) => r.querySelector(s),
  $$: (s, r = document) => [...r.querySelectorAll(s)],
  esc: (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
  money: (n) => "₱" + Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  num: (n) => (Number.isInteger(+n) ? String(+n) : String(Math.round(+n * 10) / 10)),
  pad: (n) => String(n).padStart(2, "0"),

  /* ---------- date & time (the device clock, local time) ---------- */
  isoDate(d = new Date()) { return `${d.getFullYear()}-${UI.pad(d.getMonth() + 1)}-${UI.pad(d.getDate())}`; },
  today() { return UI.isoDate(); },
  longDate(d = new Date()) { return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }); },
  mdy(iso) { const [y, m, d] = String(iso).slice(0, 10).split("-"); return `${m}/${d}/${y}`; },
  timeLabel(iso) { return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }); },
  stamp(iso) { return `${UI.mdy(iso.slice(0, 10))} ${UI.timeLabel(iso)}`; },
  nowHHMM() { return `${UI.pad(new Date().getHours())}:${UI.pad(new Date().getMinutes())}`; },
  /* ISO time WITH the time-zone offset. */
  isoNow() {
    const n = new Date(), o = -n.getTimezoneOffset(), sign = o >= 0 ? "+" : "-";
    const time = `${UI.pad(n.getHours())}:${UI.pad(n.getMinutes())}:${UI.pad(n.getSeconds())}`;
    return `${UI.isoDate(n)}T${time}${sign}${UI.pad(Math.floor(Math.abs(o) / 60))}:${UI.pad(Math.abs(o) % 60)}`;
  },

  /* ---------- session ---------- */
  session: () => { try { return JSON.parse(localStorage.getItem("session") || "null"); } catch { return null; } },
  inFolder: () => /\/(staff|admin)\//.test(location.pathname),
  root: () => (UI.inFolder() ? "../" : ""),

  /* ---------- small widgets ---------- */
  toast(msg) {
    const t = document.createElement("div");
    t.className = "toast"; t.textContent = msg; document.body.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  },
  /* modal: .modal-overlay > .card.modal  (same markup as components.html) */
  modal(html) {
    const ov = document.createElement("div");
    ov.className = "modal-overlay";
    ov.innerHTML = `<div class="card modal">${html}</div>`;
    ov.addEventListener("click", (e) => { if (e.target === ov) ov.remove(); });
    ov.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => ov.remove()));
    document.body.appendChild(ov);
    return ov;
  },
  params: () => new URLSearchParams(location.search),
  uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 3) | 8).toString(16); });
  },
  options(select, rows, valueKey, labelKey, keepFirst = true) {
    const first = keepFirst ? select.innerHTML.split("<!--")[0] : "";
    select.innerHTML = first + rows.map((r) => `<option value="${r[valueKey]}">${UI.esc(r[labelKey])}</option>`).join("");
  },
};

/* ---------- run on every page ---------- */
document.addEventListener("DOMContentLoaded", () => {
  const page = location.pathname.split("/").pop();
  const s = UI.session();

  // 1. guard: sign in first; staff pages = staff only, admin pages = admin only
  if (page !== "components.html") {
    if (page === "login.html" || page === "") {
      if (s) location.replace(UI.root() + (s.user.role === "admin" ? "admin/dashboard.html" : "staff/dashboard.html"));
    } else if (!s) {
      location.replace(UI.root() + "login.html");
      return;
    } else if (location.pathname.includes("/admin/") && s.user.role !== "admin") location.replace("../staff/dashboard.html");
    else if (location.pathname.includes("/staff/") && s.user.role !== "staff") location.replace("../admin/dashboard.html");
  }

  // 2. today's date everywhere
  const now = new Date();
  UI.$$("#today-label").forEach((el) => (el.textContent = UI.longDate(now)));
  UI.$$("#filter-date, #filter-from, #filter-to, #delivery-date-input, #event-date").forEach((el) => { if (!el.value) el.value = UI.isoDate(now); });

  // 3. sidebar: college name + logo, log out
  if (s) {
    const name = UI.$("#sidebar-college");
    if (name) name.textContent = s.user.role === "admin" ? "Administrator" : s.user.aux_name;
    const logo = UI.$(".sidebar__college-logo");
    if (logo && s.user.logo_path) {
      const img = document.createElement("img");
      img.className = "sidebar__college-logo"; img.alt = ""; img.src = (typeof API_BASE !== "undefined" ? API_BASE : "") + "/" + s.user.logo_path;
      logo.replaceWith(img);
    }
  }
  UI.$$(".nav-item--logout").forEach((a) => a.addEventListener("click", () => { localStorage.removeItem("session"); }));

  // 4. offline support for the pages (needs http://localhost, not file://)
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register((UI.root() || "./") + "sw.js").catch(() => {});
});
