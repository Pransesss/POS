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
    $("#table-delivery-log tbody").innerHTML = rows.map((r) => {
      const status = r.status === "pending" ? "Waiting for staff" : r.status === "cancelled" ? "Cancelled" : r.has_mismatch ? "Accepted — mismatch" : "Accepted";
      // status = a dot only: green when accepted cleanly, yellow for everything that needs attention (hover / screen reader gives the words)
      const dot = r.status !== "pending" && r.status !== "cancelled" && !r.has_mismatch ? "ok" : "warn";
      const cash = `Initial cash ${UI.money(r.initial_cash)} · Counted ${r.cash_counted == null ? "—" : UI.money(r.cash_counted)}`;
      const items = r.items.length
        ? `<details class="delivery-review"><summary>Review <span class="delivery-review__count">${r.items.length}</span></summary>
            <div class="delivery-review__card"><ul class="delivery-review__list">
              <li class="delivery-review__head"><span>Item</span><span>Sent</span><span>Rcvd</span></li>
              ${r.items.map((i) => { const off = i.counted_qty != null && Number(i.counted_qty) !== Number(i.listed_qty);
                return `<li${off ? ' class="is-off"' : ""}><span>${esc(UI.titleCase(i.name))}</span><span>${num(i.listed_qty)}</span><span>${i.counted_qty == null ? "—" : num(i.counted_qty)}</span></li>`; }).join("")}
            </ul><p class="delivery-review__cash">${cash}</p></div></details>`
        : `<span class="muted text-small">No items · ${UI.money(r.initial_cash)}</span>`;
      const actions = r.status === "pending" ? `<button class="link-button" type="button" data-edit-delivery="${r.delivery_id}">Edit</button><button class="link-button delete-action" type="button" data-cancel-delivery="${r.delivery_id}">Cancel</button>` : "—";
      return `<tr><td>${UI.mdy(r.delivery_date)}</td><td class="delivery-log__aux">${esc(r.aux_name)}</td><td><span class="status-dot status-dot--${dot}" role="img" title="${status}" aria-label="${status}"></span></td><td>${items}</td><td class="delivery-log__actions">${actions}</td></tr>`;
    }).join("") || '<tr class="table__empty"><td colspan="5">No deliveries yet</td></tr>';
  }

  async function editDelivery(id) {
    const delivery = (await api("/api/deliveries")).find((row) => row.delivery_id === id);
    if (!delivery || delivery.status !== "pending") return UI.toast("Only pending deliveries can be edited");
    const rows = delivery.items.map((item) => `<label for="edit-delivery-${item.product_id}">${esc(UI.titleCase(item.name))}</label><input id="edit-delivery-${item.product_id}" type="number" min="0" step="1" data-edit-pid="${item.product_id}" value="${item.listed_qty}">`).join("");
    const modal = UI.modal(`<h2 class="card__title">Edit pending delivery · ${esc(delivery.aux_name)}</h2>
      <label for="edit-delivery-date">Delivery date</label><input type="date" id="edit-delivery-date" value="${String(delivery.delivery_date).slice(0, 10)}">
      <label for="edit-delivery-cash">Initial cash (₱)</label><input type="number" min="0" step="0.01" id="edit-delivery-cash" value="${delivery.initial_cash}">
      <h3 class="table-title">Listed quantities (set 0 to remove)</h3>${rows}
      <div class="modal__actions"><button class="btn" type="button" id="save-delivery-edit">Save changes</button><button class="btn btn--ghost" type="button" data-close>Cancel</button></div>`);
    modal.querySelector("#save-delivery-edit").addEventListener("click", async () => {
      const items = [...modal.querySelectorAll("[data-edit-pid]")].map((input) => ({ product_id: +input.dataset.editPid, qty: input.value }));
      try {
        await api(`/api/deliveries/${id}`, { method: "PATCH", body: { date: modal.querySelector("#edit-delivery-date").value, initial_cash: modal.querySelector("#edit-delivery-cash").value, items } });
        modal.remove(); UI.toast("Pending delivery updated", "ok"); await loadLog();
      } catch (e) { UI.toast(e.message); }
    });
  }

  $("#table-delivery-log").addEventListener("click", async (e) => {
    const edit = e.target.closest("[data-edit-delivery]");
    const cancel = e.target.closest("[data-cancel-delivery]");
    try {
      if (edit) await editDelivery(+edit.dataset.editDelivery);
      if (cancel && confirm("Cancel this pending delivery? The auxiliary will no longer be able to receive it.")) {
        await api(`/api/deliveries/${cancel.dataset.cancelDelivery}/cancel`, { method: "POST" });
        UI.toast("Delivery cancelled", "ok"); await loadLog();
      }
    } catch (error) { UI.toast(error.message); }
  });

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
      UI.toast("Delivery sent — waiting for the staff to accept", "ok");
      ["initial-cash", "meal-rice", "meal-pork", "meal-beef", "meal-chicken", "meal-fish", "meal-veg"].forEach((i) => ($("#" + i).value = ""));
      selected.clear(); drawSelected(); loadLog();
    } catch (e) { UI.toast(e.message); }
  });

  $("#delivery-date-input").value = new Date().toISOString().slice(0,10);
  drawSelected();
  await loadProducts();
  await loadLog();
});
