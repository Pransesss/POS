/* receiving.js — staff counts what the admin sent, then accepts. Accepting adds the stock and the initial cash. */
document.addEventListener("DOMContentLoaded", async () => {
  const { $, esc, money, num } = UI;
  let current = null;

  async function load() {
    try {
      const pending = await api("/api/deliveries/pending");
      current = pending[0] || null;
      $("#delivery-date").textContent = current ? UI.mdy(current.delivery_date) : "—";
      $("#delivery-cash-listed").textContent = current ? money(current.initial_cash) : "—";
      $("#delivery-cash").value = current ? current.initial_cash : "";
      $("#btn-accept").disabled = !current;
      $("#btn-cancel-delivery").hidden = !current;
      $("#table-delivery-check tbody").innerHTML = current
        ? current.items.map((i) => `<tr><td>${esc(UI.titleCase(i.name))}${i.category === "Meals" ? " (servings)" : ""}</td><td>${num(i.listed_qty)}</td><td><input type="number" min="0" data-pid="${i.product_id}" value="${i.listed_qty}"></td></tr>`).join("")
        : '<tr class="table__empty"><td colspan="3">No pending delivery</td></tr>';
      const all = await api("/api/deliveries");
      const done = all.filter((d) => d.status !== "pending");
      $("#delivery-history").innerHTML = done.map((d) => {
        const status = d.status === "cancelled" ? "cancelled" : d.has_mismatch ? "mismatch" : "matched";
        const badge = d.status === "cancelled" ? "badge--bad" : d.has_mismatch ? "badge--warn" : "badge--ok";
        return `<details class="delivery-history__entry"><summary>${UI.mdy(d.delivery_date)} · <span class="badge ${badge}">${status}</span></summary>${d.status === "cancelled" ? "" : `<table class="table"><thead><tr><th>Item</th><th>Sent</th><th>Received</th></tr></thead><tbody>${d.items.map((i) => `<tr><td>${esc(UI.titleCase(i.name))}</td><td>${num(i.listed_qty)}</td><td>${i.counted_qty == null ? "—" : num(i.counted_qty)}</td></tr>`).join("")}</tbody></table><p class="muted text-small">Initial cash: ${money(d.initial_cash)} · Counted: ${d.cash_counted == null ? "—" : money(d.cash_counted)}</p>`}</details>`;
      }).join("") || '<p class="muted text-small">Nothing received yet.</p>';
    } catch (e) { UI.toast(isOffline(e) ? "You are offline — receiving needs the server." : e.message); }
  }
  $("#btn-accept").addEventListener("click", async () => {
    if (!current) return;
    const counts = {}; UI.$$("#table-delivery-check input[data-pid]").forEach((i) => (counts[i.dataset.pid] = i.value));
    try {
      const r = await api(`/api/deliveries/${current.delivery_id}/accept`, { method: "POST", body: { cash_counted: $("#delivery-cash").value, counts } });
      UI.toast(r.has_mismatch ? "Accepted — a mismatch was recorded for the admin" : "Delivery accepted, stock updated", r.has_mismatch ? "warn" : "ok");
      load();
    } catch (e) { UI.toast(e.message); }
  });
  $("#btn-cancel-delivery").addEventListener("click", async () => {
    if (!current || !confirm("Cancel this delivery? It will be returned to the admin as cancelled.")) return;
    try {
      await api(`/api/deliveries/${current.delivery_id}/cancel`, { method: "POST" });
      UI.toast("Delivery cancelled", "ok"); await load();
    } catch (e) { UI.toast(e.message); }
  });
  load();
});
