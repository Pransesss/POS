/* common.js — loaded on EVERY page. Today's date/time (always the real "now"), sign-in guard, sidebar, toast + modal helpers.
   No backend calls here. */
const UI = {
  $: (s, r = document) => r.querySelector(s),
  $$: (s, r = document) => [...r.querySelectorAll(s)],
  esc: (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
  titleCase: (s) => String(s ?? "").toLocaleLowerCase().replace(/(^|[^\p{L}\p{N}'])(\p{L})/gu, (_, separator, letter) => separator + letter.toLocaleUpperCase()),
  money: (n) => "₱" + Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  num: (n) => (Number.isInteger(+n) ? String(+n) : String(Math.round(+n * 10) / 10)),
  pad: (n) => String(n).padStart(2, "0"),

  /* date & time (the device clock, local time) */
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

  /* session */
  session: () => { try { return JSON.parse(localStorage.getItem("session") || "null"); } catch { return null; } },
  inFolder: () => /\/(staff|admin)\//.test(location.pathname),
  root: () => (UI.inFolder() ? "../" : ""),

  /* small widgets */
  /* type: "warn" (default, yellow) for warnings / errors, "ok" (green) for a finished action */
  toast(msg, type = "warn") {
    if (!msg) return;
    const t = document.createElement("div");
    t.className = "toast toast--" + (type === "ok" ? "ok" : "warn"); t.textContent = msg;
    t.setAttribute("role", type === "ok" ? "status" : "alert");
    document.body.appendChild(t);
    setTimeout(() => t.remove(), type === "ok" ? 2600 : 4000);   // warnings stay a bit longer so they can be read
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

const THEME_STORAGE_KEY = "pos_theme";
try {
  document.documentElement.dataset.theme = localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark";
} catch {
  document.documentElement.dataset.theme = "dark";
}

/* run on every page */
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
  const sidebarFooter = UI.$(".sidebar__footer");
  if (sidebarFooter) {
    const college = UI.$(".sidebar__college", sidebarFooter);
    const logout = UI.$(".nav-item--logout", sidebarFooter);
    const themeControl = document.createElement("label");
    themeControl.className = "sidebar-theme ui-switch";
    themeControl.innerHTML = `<input class="ui-switch__input" type="checkbox" aria-label="Light mode">
      <span class="slider" aria-hidden="true">
        <span class="circle">
          <svg class="ui-switch__sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"></path></svg>
          <svg class="ui-switch__moon" viewBox="0 0 24 24"><path d="M20.5 15.5A8.5 8.5 0 0 1 8.5 3.5 8.5 8.5 0 1 0 20.5 15.5Z"></path></svg>
        </span>
      </span>`;
    const themeInput = UI.$(".ui-switch__input", themeControl);
    themeInput.addEventListener("change", () => {
      const theme = themeInput.checked ? "light" : "dark";
      document.documentElement.dataset.theme = theme;
      try {
        localStorage.setItem(THEME_STORAGE_KEY, theme);
      } catch {
        UI.toast("Theme changed for this page, but the preference could not be saved.");
      }
      updateThemeSwitch(themeInput, theme);
    });

    if (college && logout) {
      const account = document.createElement("div");
      account.className = "sidebar__account";
      const actions = document.createElement("div");
      actions.className = "sidebar__account-actions";
      sidebarFooter.insertBefore(account, college);
      account.append(college, actions);
      actions.append(themeControl, logout);
    } else {
      sidebarFooter.prepend(themeControl);
    }
    updateThemeSwitch(themeInput, document.documentElement.dataset.theme);
  }

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

function updateThemeSwitch(input, theme) {
  input.checked = theme === "light";
  input.setAttribute("aria-label", `Switch to ${theme === "light" ? "dark" : "light"} mode`);
}
