/* deliveries.js — admin lists what is sent to an auxiliary. */
document.addEventListener("DOMContentLoaded", async () => {
  const { $, esc, num } = UI;
  const auxes = (await api("/api/auxiliaries")).filter((a) => a.is_active);
  UI.options($("#delivery-aux"), auxes, "aux_id", "name", false);
  let products = [], selected = new Map();

  function drawSelected() {
    const rows = [...selected.values()];
    $("#delivery-selected").innerHTML = rows.length ? rows.map((p) => `
      <div class="delivery-selected__row" data-pid="${p.product_id}">
        <div class="delivery-selected__item"><strong>${esc(UI.titleCase(p.name))}</strong></div>
        <div class="delivery-selected__now">${num(p.qty)}</div>
        <input type="number" min="1" step="1" data-deliver-pid="${p.product_id}" value="${p.deliver_qty || ""}" placeholder="Qty">
        <button class="btn btn--ghost delete-action delete-action--icon delivery-selected__remove" type="button" data-remove-pid="${p.product_id}" aria-label="Remove product" data-delete-tooltip="Remove product"><svg class="delete-action__icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M9 3h6l1 2h5v2H3V5h5zm-3 6h12l-1 12H7zm3 2v8h2v-8zm4 0v8h2v-8z"/></svg></button>
      </div>`).join("") : `<p class="muted text-small">No products selected yet.</p>`;
  }

  function drawMenu() {
    const q = $("#delivery-product-search").value.trim().toLowerCase();
    const chosen = new Set(selected.keys());
    const list = products.filter((p) => p.is_active && !chosen.has(p.product_id) && (!q || p.name.toLowerCase().includes(q)))
      .sort((a,b) => a.name.localeCompare(b.name));
    const menu = $("#delivery-product-menu");
    menu.innerHTML = list.slice(0, 30).map((p) => `<button type="button" class="delivery-picker__option" data-pick-pid="${p.product_id}"><span class="delivery-picker__name">${esc(UI.titleCase(p.name))}</span><span class="delivery-picker__stock"><span class="delivery-picker__stock-value">${num(p.qty)}</span><span>in stock</span></span></button>`).join("")
      || `<div class="delivery-picker__empty">${q ? "No matching products." : "Type to search for a product."}</div>`;
    menu.classList.add("is-open");
  }

  async function loadProducts() {
    const id = $("#delivery-aux").value;
    $("#delivery-aux-name").textContent = (auxes.find((a) => String(a.aux_id) === id) || {}).name || "";
    selected.clear();
    if (!id) { products = []; drawSelected(); return; }
    const d = await api("/api/inventory?aux=" + id);
    products = d.products || [];
    drawSelected();
    $("#delivery-product-search").value = "";
    $("#delivery-product-menu").classList.remove("is-open");
  }

  async function loadLog() {
    const rows = await api("/api/deliveries");
    $("#table-delivery-log tbody").innerHTML = rows.map((r) => `<tr><td>${UI.mdy(r.delivery_date)}</td><td>${esc(r.aux_name)}</td><td><span class="badge ${r.status === "pending" ? "badge--warn" : r.has_mismatch ? "badge--bad" : "badge--ok"}">${r.status === "pending" ? "Waiting for staff" : r.has_mismatch ? "Accepted — mismatch" : "Accepted"}</span></td></tr>`).join("") || '<tr class="table__empty"><td colspan="3">No deliveries yet</td></tr>';
  }

  $("#delivery-aux").addEventListener("change", loadProducts);
  $("#delivery-product-search").addEventListener("input", drawMenu);
  $("#delivery-product-search").addEventListener("focus", drawMenu);
  $("#delivery-product-menu").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-pick-pid]"); if (!btn) return;
    const p = products.find((x) => String(x.product_id) === btn.dataset.pickPid); if (!p) return;
    selected.set(p.product_id, { ...p, deliver_qty: "" });
    $("#delivery-product-search").value = "";
    drawSelected();
    drawMenu();
  });
  $("#delivery-selected").addEventListener("input", (e) => {
    const input = e.target.closest("[data-deliver-pid]"); if (!input) return;
    const p = selected.get(+input.dataset.deliverPid); if (p) p.deliver_qty = input.value;
  });
  $("#delivery-selected").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-remove-pid]"); if (!btn) return;
    selected.delete(+btn.dataset.removePid); drawSelected(); drawMenu();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".delivery-picker")) $("#delivery-product-menu").classList.remove("is-open");
  });

  $("#btn-send-delivery").addEventListener("click", async () => {
    const meals = {}; ["rice", "pork", "beef", "chicken", "fish", "veg"].forEach((k) => (meals[k] = $("#meal-" + k).value));
    const items = [...selected.values()].filter((p) => +p.deliver_qty > 0).map((p) => ({ product_id: +p.product_id, qty: p.deliver_qty }));
    if (!$("#delivery-aux").value) return UI.toast("Select an auxiliary first");
    if (!items.length && !Object.values(meals).some((v) => +v > 0)) return UI.toast("Add at least one delivery quantity");
    try {
      await api("/api/deliveries", { method: "POST", body: { aux_id: $("#delivery-aux").value, date: $("#delivery-date-input").value, initial_cash: $("#initial-cash").value, meals, items } });
      UI.toast("Delivery sent — waiting for the staff to accept");
      ["initial-cash", "meal-rice", "meal-pork", "meal-beef", "meal-chicken", "meal-fish", "meal-veg"].forEach((i) => ($("#" + i).value = ""));
      selected.clear(); drawSelected(); loadLog();
    } catch (e) { UI.toast(e.message); }
  });

  $("#delivery-date-input").value = new Date().toISOString().slice(0,10);
  drawSelected();
  await loadProducts();
  await loadLog();
});
