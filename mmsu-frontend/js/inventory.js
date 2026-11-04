/* inventory.js — staff (view only) and admin (add / edit products, one outlet or all). */
document.addEventListener("DOMContentLoaded", async () => {
  const { $, esc, money, num } = UI, admin = UI.session().user.role === "admin";
  let rows = [], aux = "all";

  const badge = { in: ["badge--ok", "In stock"], low: ["badge--warn", "Low stock"], out: ["badge--bad", "Out of stock"] };
  function draw() {
    const q = $("#inventory-search").value.trim().toLowerCase(), chosen = UI.$$("input[name=status]:checked").map((i) => i.value);
    const list = rows.filter((r) => (!q || (r.name + (r.barcode || "") + r.category).toLowerCase().includes(q)) && (!chosen.length || chosen.includes(r.status)))
      .sort((a, b) => {
        const rank = { in: 1, low: 2, out: 3 };
        const sr = (rank[a.status] || 4) - (rank[b.status] || 4);
        return sr || String(a.name).localeCompare(String(b.name));
      });
    $("#table-inventory tbody").innerHTML = list.map((r) => `<tr><td>${esc(UI.titleCase(r.name))}</td><td>${esc(r.barcode || "—")}</td><td>${esc(r.category)}</td><td>${money(r.price)}</td><td>${num(r.qty)}</td>
      <td><span class="badge ${badge[r.status][0]}">${badge[r.status][1]}</span></td><td>${r.is_active ? '<span class="badge badge--ok">Active</span>' : '<span class="badge badge--bad">Inactive</span>'}</td>
      ${admin ? `<td>${esc(r.aux_name)}</td><td><button class="link-button" data-edit="${rows.indexOf(r)}">Edit</button></td>` : ""}</tr>`).join("")
      || `<tr class="table__empty"><td colspan="${admin ? 9 : 7}">No items match</td></tr>`;
  }
  async function load() {
    try {
      const d = await api("/api/inventory" + query({ aux: admin ? aux : "" }));
      rows = d.products;
      $("#kpi-total").textContent = d.kpi.total; $("#kpi-low").textContent = d.kpi.low; $("#kpi-out").textContent = d.kpi.out;
      Object.entries(d.meals).forEach(([k, v]) => { const el = $("#meal-left-" + k); if (el) el.textContent = num(v); });
      draw();
    } catch (e) { UI.toast(isOffline(e) ? "You are offline — inventory needs the server." : e.message); }
  }

  // preset from the dashboard link:  inventory.html?status=low,out
  (UI.params().get("status") || "").split(",").forEach((s) => { const i = UI.$(`input[name=status][value="${s}"]`); if (i) i.checked = true; });
  $("#inventory-search").addEventListener("input", draw);
  UI.$$("input[name=status]").forEach((i) => i.addEventListener("change", draw));

  if (admin) {
    const auxes = await api("/api/auxiliaries");
    UI.options($("#filter-aux"), auxes, "aux_id", "name");
    $("#filter-aux").addEventListener("change", () => { aux = $("#filter-aux").value; load(); });
    $("#btn-add-product").addEventListener("click", () => productModal(null));
    $("#table-inventory").addEventListener("click", (e) => { if (e.target.dataset.edit !== undefined) productModal(rows[e.target.dataset.edit]); });
  }

  /* add / edit product (modal, same fields as components.html) */
  function productModal(p) {
    const auxId = p ? p.aux_id : aux;
    const ov = UI.modal(`<h2 class="card__title">${p ? "Edit" : "Add"} product</h2>
      <label for="m-name">Name</label><input type="text" id="m-name" value="${esc(UI.titleCase(p ? p.name : ""))}">
      <label for="m-barcode">Barcode</label><input type="text" id="m-barcode" value="${esc(p ? p.barcode || "" : "")}">
      <label for="m-category">Category</label><select id="m-category"><option value="Snacks" ${!p || p.category === "Snacks" ? "selected" : ""}>Snacks</option><option value="Drinks" ${p && p.category === "Drinks" ? "selected" : ""}>Drinks</option></select>
      <label for="m-price">Price (₱) — applies to all auxiliaries</label><input type="number" id="m-price" min="0" step="0.01" value="${p ? p.price : ""}">
      ${p ? `<label for="m-stock">Stock at this auxiliary</label><input type="number" id="m-stock" min="0" value="${p.qty}" ${auxId === "all" ? "disabled" : ""}>` : ""}
      ${p ? "" : `<label for="m-prediction">Prediction</label><select id="m-prediction"><option value="0">Don't include</option><option value="1">Include — its future sales train the model</option></select>
      <p class="muted text-small">New items have no sales yet. Once included, every sale punched in the POS is added to the prediction automatically (retrained every 2 weeks).</p>`}
      <label for="m-status">Status</label><select id="m-status"><option value="1">Active</option><option value="0" ${p && !p.is_active ? "selected" : ""}>Inactive</option></select>
      <div class="modal__actions"><button class="btn" id="m-save" type="button">Save</button><button class="btn btn--ghost" data-close type="button">Cancel</button></div>`);
    ov.querySelector("#m-save").addEventListener("click", async () => {
      const body = { name: UI.titleCase($("#m-name").value), barcode: $("#m-barcode").value, category: $("#m-category").value, price: $("#m-price").value,
        stock: !p || auxId === "all" ? undefined : $("#m-stock").value, aux_id: auxId === "all" ? undefined : auxId, is_active: $("#m-status").value === "1",
        use_for_prediction: p ? undefined : $("#m-prediction").value === "1" };
      try { await api(p ? `/api/products/${p.product_id}` : "/api/products", { method: p ? "PUT" : "POST", body }); ov.remove(); UI.toast("Saved", "ok"); load(); }
      catch (e) { UI.toast(e.message); }
    });
  }
  load();
});
