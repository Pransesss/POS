/* offline.js — keeps the POS working without internet.
   1. Every sale is saved in this device (IndexedDB "outbox") FIRST.
   2. When the internet is back, the outbox is sent to the server (POST /api/sync/transactions). The server ignores duplicates.
   3. Prices / products / stock are copied to the device ("cache") whenever the POS is opened online. */
const Store = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((resolve, reject) => {
      const r = indexedDB.open("mmsu-pos", 1);
      r.onupgradeneeded = () => { r.result.createObjectStore("outbox", { keyPath: "id" }); r.result.createObjectStore("cache", { keyPath: "key" }); };
      r.onsuccess = () => { this.db = r.result; resolve(r.result); };
      r.onerror = () => reject(r.error);
    });
  },
  async run(store, mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const req = fn(db.transaction(store, mode).objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  put: (store, value) => Store.run(store, "readwrite", (s) => s.put(value)),
  get: (store, key) => Store.run(store, "readonly", (s) => s.get(key)),
  all: (store) => Store.run(store, "readonly", (s) => s.getAll()),
  del: (store, key) => Store.run(store, "readwrite", (s) => s.delete(key)),
};

const Sync = {
  busy: false,
  deviceId() { let d = localStorage.getItem("device_id"); if (!d) { d = UI.uuid(); localStorage.setItem("device_id", d); } return d; },

  async pending() { return (await Store.all("outbox")).filter((r) => r.status === "pending"); },
  async rejected() { return (await Store.all("outbox")).filter((r) => r.status === "rejected"); },

  /* send everything waiting; safe to call any time */
  async flush() {
    if (!navigator.onLine || this.busy || !UI.session() || UI.session().user.role !== "staff") return this.badge();
    const rows = await this.pending();
    if (!rows.length) return this.badge();
    this.busy = true;
    try {
      const res = await api("/api/sync/transactions", { method: "POST", body: { device_id: this.deviceId(), transactions: rows.map((r) => r.payload) } });
      for (const r of res.results) {
        if (r.status === "saved" || r.status === "duplicate") await Store.del("outbox", r.id);
        else { const row = await Store.get("outbox", r.id); row.status = "rejected"; row.reason = r.reason; await Store.put("outbox", row); }   // kept, so nothing is lost
      }
    } catch (e) { /* still offline / server down: stays in the outbox and we try again */ }
    this.busy = false;
    window.dispatchEvent(new Event("outbox-changed"));
    return this.badge();
  },

  async badge() {
    const el = UI.$("#online-badge");
    if (!el) return;
    const n = (await this.pending()).length;
    el.className = "badge " + (navigator.onLine ? "badge--online" : "badge--warn");
    el.textContent = (navigator.onLine ? "Online" : "Offline") + (n ? ` · ${n} waiting to sync` : "");
  },

  /* products, prices and stock for the POS. Online = fresh copy from the server (saved on the device). Offline = the saved copy. */
  async bootstrap() {
    try {
      const data = await api("/api/pos/bootstrap");
      await Store.put("cache", { key: "bootstrap", value: data, at: Date.now() });
      return data;
    } catch (e) {
      if (!isOffline(e)) throw e;
      const c = await Store.get("cache", "bootstrap");
      return c ? c.value : null;
    }
  },
  /* after a sale: lower the saved stock too, so the POS cannot oversell while offline */
  async useStock(used) {
    const c = await Store.get("cache", "bootstrap");
    if (!c) return;
    for (const [key, qty] of Object.entries(used)) {
      if (key.startsWith("meal:")) c.value.meal_stock[key.slice(5)] -= qty;
      else { const p = c.value.products.find((x) => String(x.product_id) === key); if (p) p.qty -= qty; }
    }
    await Store.put("cache", c);
  },
};

window.addEventListener("online", () => Sync.flush());
window.addEventListener("offline", () => Sync.badge());
document.addEventListener("DOMContentLoaded", () => { Sync.badge(); Sync.flush(); setInterval(() => Sync.flush(), 30000); });
