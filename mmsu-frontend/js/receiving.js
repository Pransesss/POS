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
      $("#table-delivery-check tbody").innerHTML = current
        ? current.items.map((i) => `<tr><td>${esc(i.name)}${i.category === "Meals" ? " (servings)" : ""}</td><td>${num(i.listed_qty)}</td><td><input type="number" min="0" data-pid="${i.product_id}" value="${i.listed_qty}"></td></tr>`).join("")
        : '<tr class="table__empty"><td colspan="3">No pending delivery</td></tr>';
      const all = await api("/api/deliveries");
      const done = all.filter((d) => d.status === "accepted");
      $("#delivery-history").innerHTML = done.map((d) => `<div class="rows__item"><span>${UI.mdy(d.delivery_date)}</span><span class="badge ${d.has_mismatch ? "badge--warn" : "badge--ok"}">${d.has_mismatch ? "mismatch" : "matched"}</span></div>`).join("") || '<p class="muted text-small">Nothing received yet.</p>';
    } catch (e) { UI.toast(isOffline(e) ? "You are offline — receiving needs the server." : e.message); }
  }
  $("#btn-accept").addEventListener("click", async () => {
    if (!current) return;
    const counts = {}; UI.$$("#table-delivery-check input[data-pid]").forEach((i) => (counts[i.dataset.pid] = i.value));
    try {
      const r = await api(`/api/deliveries/${current.delivery_id}/accept`, { method: "POST", body: { cash_counted: $("#delivery-cash").value, counts } });
      UI.toast(r.has_mismatch ? "Accepted — a mismatch was recorded for the admin" : "Delivery accepted, stock updated");
      load();
    } catch (e) { UI.toast(e.message); }
  });
  load();
});
