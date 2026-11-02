/* pos.js — the cashier screen. Used by pos.html, pos-meal.html and pos-meat.html (they share ONE cart, kept in this device).
   Prices are only a PREVIEW here. The server recomputes every meal from the meal_prices table when the sale is saved. */
document.addEventListener("DOMContentLoaded", async () => {
  const $ = UI.$, load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, save = (k, v) => localStorage.setItem(k, JSON.stringify(v));
  let boot = null, mp = {}, cart = load("pos_cart", []), held = load("pos_held", []);
  const MEATS = ["beef", "chicken", "fish", "pork"], cap = (s) => s[0].toUpperCase() + s.slice(1);

  /* ---------- price preview (same rules as backend/pricing.py) ---------- */
  function priced(spec) {
    const t = spec.type;
    if (t === "takeout_box") return { name: "Takeout box", unit: mp.take_out_box || 5, section: "Meals", parts: {} };
    if (t === "product") { const p = boot.products.find((x) => x.product_id === spec.product_id) || { name: "(item no longer sold)", price: 0, product_id: spec.product_id }; return { name: p.name, unit: p.price, section: "Snacks", parts: {}, product: p.product_id }; }
    if (t === "meat") return { name: cap(spec.meat), unit: mp[spec.meat], section: "Meals", parts: { [spec.meat]: 1 } };
    if (t === "veg") return { name: "Veggy", unit: mp.veg, section: "Meals", parts: { veg: 1 } };
    if (t === "rice") return { name: "Plain Rice", unit: mp.rice, section: "Meals", parts: { rice: 1 } };
    if (t === "fried_rice") return { name: "Fried Rice", unit: mp.fried_rice, section: "Meals", parts: { rice: 1 } };
    const { meat, meat_qty: mq, veg_qty: veg, rice_type: rt, rice_qty: rq } = spec;
    const budget = !!meat && mq === 1 && veg === 1 && rt === "plain" && rq === 1;
    const unit = budget ? mp["budget_" + meat] : (meat ? mp[meat] * mq : 0) + mp.veg * veg + (rt === "fried" ? mp.fried_rice : mp.rice) * rq;
    const riceTxt = (rq === 0.5 ? "½ " : rq === 2 ? "Double " : "") + (rt === "fried" ? "Fried rice" : "Rice");
    const name = budget ? `Budget Meal (Rice, ${cap(meat)} & Vegetable)` : [riceTxt, meat && (mq === 2 ? "Double " : "") + cap(meat), veg && (veg === 2 ? "Double " : "") + "Vegetable"].filter(Boolean).join(" + ");
    const parts = { rice: rq }; if (meat) parts[meat] = mq; if (veg) parts.veg = veg;
    return { name, unit, section: "Meals", parts, budget };
  }
  const keyOf = (s) => JSON.stringify({ ...s, qty: 0 });
  const total = () => cart.reduce((n, l) => n + priced(l).unit * l.qty, 0);
  const grand = () => total();
  const needOf = (lines) => { const n = {}; lines.forEach((l) => { const p = priced(l); Object.entries(p.parts).forEach(([k, v]) => (n["meal:" + k] = (n["meal:" + k] || 0) + v * l.qty)); if (p.product) n[p.product] = (n[p.product] || 0) + l.qty; }); return n; };
  function shortItem(lines) {          // returns the name of something we do not have enough of, or ""
    for (const [k, v] of Object.entries(needOf(lines))) {
      const have = k.startsWith("meal:") ? boot.meal_stock[k.slice(5)] : (boot.products.find((p) => String(p.product_id) === k) || {}).qty;
      if (v > (have ?? 0)) return k.startsWith("meal:") ? cap(k.slice(5)) + " servings" : boot.products.find((p) => String(p.product_id) === k).name;
    }
    return "";
  }

  /* ---------- cart ---------- */
  function addSpec(spec) {
    const next = cart.map((l) => ({ ...l })), found = next.find((l) => keyOf(l) === keyOf(spec));
    found ? (found.qty += spec.qty) : next.push({ ...spec });
    const lack = shortItem(next);
    if (lack) { UI.toast("Not enough stock: " + lack); return false; }
    cart = next; save("pos_cart", cart); render(); refreshProductDisplays(); return true;
  }
  function render() {
    const ul = $("#order-lines");
    ul.innerHTML = cart.length ? cart.map((l, i) => { const p = priced(l);
      return `<li class="order__line"><span>${UI.esc(p.name)}</span><span class="stepper"><button class="stepper__btn" type="button" data-dec="${i}">−</button><span>${l.qty}</span><button class="stepper__btn" type="button" data-inc="${i}">+</button></span><span class="order__line-amount">${UI.money(p.unit * l.qty)}</span></li>`; }).join("")
      : '<li class="order__empty">No items yet</li>';
    const boxLine = cart.find((l) => l.type === "takeout_box");
    $("#order-box-count").textContent = `Takeout boxes: ${boxLine ? boxLine.qty : 0}`;
    $("#order-total").textContent = UI.money(grand());
    const given = parseFloat($("#cash-tendered").value || 0);
    $("#order-change").textContent = UI.money(Math.max(0, given - grand()));
    $("#btn-resume").hidden = !held.length;
    $("#btn-hold").textContent = held.length ? `HOLD SALE (${held.length} held)` : "HOLD SALE";
  }
  $("#order-lines").addEventListener("click", (e) => {
    const inc = e.target.dataset.inc, dec = e.target.dataset.dec;
    if (inc !== undefined) addSpec({ ...cart[inc], qty: 1 });
    if (dec !== undefined) { cart[dec].qty--; if (cart[dec].qty <= 0) cart.splice(dec, 1); save("pos_cart", cart); render(); refreshProductDisplays(); }
  });
  $("#btn-add-box").addEventListener("click", () => addSpec({ type: "takeout_box", qty: 1 }));
  $$all("input[name=pay]").forEach((r) => r.addEventListener("change", () => localStorage.setItem("pos_pay", $("#pay-1").checked ? "ewallet" : "cash")));
  $("#cash-tendered").addEventListener("input", render);
  $("#ewallet-ref4").addEventListener("input", (e) => (e.target.value = e.target.value.replace(/\D/g, "").slice(0, 4)));
  function $$all(s) { return UI.$$(s); }

  $("#btn-hold").addEventListener("click", () => { if (!cart.length) return; held.push(cart); cart = []; save("pos_held", held); save("pos_cart", cart); render(); refreshProductDisplays(); UI.toast("Sale put on hold"); });
  $("#btn-resume").addEventListener("click", () => { if (!held.length || cart.length) return UI.toast(cart.length ? "Finish or hold the current sale first" : "");   cart = held.pop(); save("pos_held", held); save("pos_cart", cart); render(); refreshProductDisplays(); });
  $("#btn-cancel").addEventListener("click", () => { if (cart.length && !confirm("Cancel this sale?")) return; cart = []; save("pos_cart", cart); $("#cash-tendered").value = ""; $("#ewallet-ref4").value = ""; render(); refreshProductDisplays(); });

  /* ---------- complete sale: save on the device first, then sync ---------- */
  $("#btn-complete").addEventListener("click", async () => {
    if (!cart.length) return UI.toast("Add an item first");
    const ewallet = $("#pay-1").checked, tendered = parseFloat($("#cash-tendered").value || 0), ref4 = $("#ewallet-ref4").value, t = grand();
    if (ewallet && !/^\d{4}$/.test(ref4)) return UI.toast("Enter the last 4 digits of the e-wallet reference number");
    if (!ewallet && tendered < t) return UI.toast("Amount tendered is less than the total");
    const lack = shortItem(cart); if (lack) return UI.toast("Not enough stock: " + lack);
    const now = UI.isoNow(), code = UI.session().user.aux_code;
    const txn = { id: UI.uuid(), receipt_no: `${code}-${now.slice(0, 10).replace(/-/g, "")}-${UI.uuid().slice(0, 4).toUpperCase()}`, created_at: now,
      payment_method: ewallet ? "E-Wallet" : "Cash", amount_tendered: ewallet ? null : tendered, ewallet_ref4: ewallet ? ref4 : null,
      dine: "in", lines: cart.map((l) => ({ ...l })) };
    await Store.put("outbox", { id: txn.id, payload: txn, status: "pending" });       // 1. safe on the device
    await Sync.useStock(needOf(cart));                                                // lower the saved stock
    Object.entries(needOf(cart)).forEach(([k, v]) => { if (k.startsWith("meal:")) boot.meal_stock[k.slice(5)] -= v; else boot.products.find((p) => String(p.product_id) === k).qty -= v; });
    cart = []; save("pos_cart", cart); $("#cash-tendered").value = ""; $("#ewallet-ref4").value = ""; render(); refreshProductDisplays();
    Sync.badge(); Sync.flush();                                                       // 2. send when online
  });

  /* ---------- data: online = fresh from the server, offline = the copy saved on this device ---------- */
  await Sync.flush();
  boot = await Sync.bootstrap();
  if (!boot) { UI.toast("Connect to the internet once to download the products and prices."); return; }
  mp = boot.meal_prices;
  UI.$$("[data-price]").forEach((el) => (el.textContent = UI.money(mp[el.dataset.price.replace("_only", "")])));
  const doneBtn = $("#btn-done-day");
  const closeKey = `sales-day-closed:${UI.session().user.aux_id}:${boot.sales_day}`;
  if (localStorage.getItem(closeKey)) { doneBtn.disabled = true; doneBtn.textContent = "Sales day closed"; }
  doneBtn.addEventListener("click", async () => {
    if (doneBtn.disabled) return;
    if (cart.length) return UI.toast("Finish or cancel the current sale first");
    const ov = UI.modal(`<h2 class="card__title">Close sales day?</h2><p class="muted text-small">This finalizes the current sales day for remittance. You can keep using the POS; new sales will be recorded under the next sales day.</p><label for="close-day-password">Confirm with your password</label><input type="password" id="close-day-password" autocomplete="current-password" placeholder="Password"><div class="modal__actions"><button class="btn" id="close-day-confirm" type="button">Confirm</button><button class="btn btn--ghost" data-close type="button">Cancel</button></div>`);
    ov.querySelector("#close-day-confirm").addEventListener("click", async () => {
      const password = ov.querySelector("#close-day-password").value;
      if (!password) return UI.toast("Enter your password");
      try {
        const result = await api("/api/sales-day/close", { method: "POST", body: { password } });
        localStorage.setItem(closeKey, "1"); doneBtn.disabled = true; doneBtn.textContent = "Sales day closed";
        ov.remove(); UI.toast(`Sales day closed. New sales are recorded for ${result.sales_day}.`);
      } catch (e) { UI.toast(e.message); }
    });
  });
  if (localStorage.getItem("pos_pay") === "ewallet") $("#pay-1").checked = true;

  /* POS category filters: meal shortcuts plus stock-backed snack and drink products. */
  const posProducts = $("#pos-products");
  const search = $("#pos-search"), results = $("#pos-results");
  const posFilters = UI.$$("[data-pos-filter]");
  let activeCategory = "All";
  function cartQuantity(matches, quantity = (line) => line.qty) {
    return cart.reduce((total, line) => total + (matches(line) ? quantity(line) : 0), 0);
  }
  function mealPunchBadge(count) {
    return count > 0 ? `<span class="pos-product__punch" aria-label="${count} in current sale">${count}</span>` : "";
  }
  function productCard(p) {
    const punchCount = cart.reduce((count, line) => (
      line.type === "product" && String(line.product_id) === String(p.product_id) ? count + line.qty : count
    ), 0);
    const qty = Number(p.qty);
    const punchBadge = mealPunchBadge(punchCount);
    const stock = Number.isFinite(qty) && qty <= 4
      ? `<span class="pos-product__stock">${qty > 0 ? `${qty} left` : "Out of stock"}</span>`
      : "";
    return `<button class="tile pos-product" type="button" data-product="${p.product_id}"><b class="pos-product__name">${UI.esc(p.name)}</b>${punchBadge}<span class="tile__price pos-product__price">${UI.money(p.price)}</span>${stock}</button>`;
  }
  function drawCatalog() {
    if (!posProducts) return;
    const mealTiles = activeCategory === "All" || activeCategory === "Meals" ? `
      <a class="tile pos-category-tile" href="pos-meal.html">${mealPunchBadge(cartQuantity((line) => line.type === "meal"))}<b>Meal</b></a>
      <a class="tile pos-category-tile" href="pos-meat.html">${mealPunchBadge(cartQuantity(
        (line) => line.type === "meat" || (line.type === "meal" && !!line.meat),
        (line) => line.type === "meal" ? line.meat_qty * line.qty : line.qty
      ))}<b>Meat</b></a>
      <button class="tile" type="button" data-add="veggy">${mealPunchBadge(cartQuantity(
        (line) => line.type === "veg" || (line.type === "meal" && line.veg_qty > 0),
        (line) => line.type === "meal" ? line.veg_qty * line.qty : line.qty
      ))}<b>Veggy</b><span class="tile__price">${UI.money(mp.veg)}</span></button>
      <button class="tile" type="button" data-add="rice">${mealPunchBadge(cartQuantity(
        (line) => line.type === "rice" || (line.type === "meal" && line.rice_type !== "fried"),
        (line) => line.type === "meal" ? line.rice_qty * line.qty : line.qty
      ))}<b>Rice</b><span class="tile__price">${UI.money(mp.rice)}</span></button>
      <button class="tile" type="button" data-add="fried-rice">${mealPunchBadge(cartQuantity(
        (line) => line.type === "fried_rice" || (line.type === "meal" && line.rice_type === "fried"),
        (line) => line.type === "meal" ? line.rice_qty * line.qty : line.qty
      ))}<b>Fried Rice</b><span class="tile__price">${UI.money(mp.fried_rice)}</span></button>` : "";
    const products = boot.products
      .filter((p) => (activeCategory === "All" && (p.category === "Snacks" || p.category === "Drinks")) || p.category === activeCategory)
      .sort((a, b) => {
        const categoryOrder = { Snacks: 0, Drinks: 1 };
        return categoryOrder[a.category] - categoryOrder[b.category]
          || (a.category === "Snacks" ? (b.sold7 || 0) - (a.sold7 || 0) : 0)
          || a.name.localeCompare(b.name);
      });
    const productTiles = products.map(productCard).join("");
    posProducts.innerHTML = mealTiles + productTiles || '<p class="muted">No products in this category.</p>';
  }
  function drawSearchResults(query) {
    const q = query.trim().toLowerCase();
    if (!q) { results.innerHTML = ""; return; }
    const hits = boot.products.filter((p) => p.name.toLowerCase().includes(q) || (p.barcode || "").includes(q)).slice(0, 24);
    results.innerHTML = hits.map(productCard).join("") || '<p class="muted">No match</p>';
  }
  function refreshProductDisplays() {
    drawCatalog();
    if (!results.hidden) drawSearchResults(search.value);
  }
  posFilters.forEach((button) => button.addEventListener("click", () => {
    activeCategory = button.dataset.posFilter;
    posFilters.forEach((filter) => {
      const selected = filter === button;
      filter.classList.toggle("is-active", selected);
      filter.setAttribute("aria-pressed", String(selected));
    });
    drawCatalog();
  }));
  drawCatalog();
  document.addEventListener("click", (e) => {
    const tile = e.target.closest("[data-product]"), add = e.target.closest("[data-add]");
    if (tile) addSpec({ type: "product", product_id: +tile.dataset.product, qty: 1 });
    if (add) { const k = add.dataset.add; addSpec(MEATS.includes(k) ? { type: "meat", meat: k, qty: 1 } : { type: { veggy: "veg", rice: "rice", "fried-rice": "fried_rice" }[k], qty: 1 }); }
  });

  /* search / scan: chips, drinks and anything else with a barcode */
  const others = ["#pos-home", "#meal-builder", "#meat-picker"].map((s) => $(s)).filter(Boolean);
  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    results.hidden = !q; others.forEach((o) => (o.hidden = !!q));
    if (!q) return;
    drawSearchResults(q);
  });
  search.addEventListener("keydown", (e) => {            // a barcode scanner "types" the number and presses Enter
    if (e.key !== "Enter") return;
    const p = boot.products.find((x) => x.barcode && x.barcode === search.value.trim());
    if (!p) return UI.toast("Barcode not found");
    addSpec({ type: "product", product_id: p.product_id, qty: 1 }); search.value = ""; search.dispatchEvent(new Event("input"));
  });

  /* meal builder (pos-meal.html) */
  if ($("#meal-builder")) {
    let q = 1;
    UI.$$("input[name=meat], input[name=veg]").forEach((inp) => {       // tap a selected tile again to remove it
      inp.closest("label").addEventListener("pointerdown", () => (inp.dataset.was = inp.checked ? "1" : ""));
      inp.addEventListener("click", () => { if (inp.dataset.was === "1") inp.checked = false; inp.dataset.was = ""; update(); });
    });
    UI.$$("input[name=meat-qty], input[name=rice-qty], input[name=rice-type]").forEach((i) => i.addEventListener("change", update));
    const val = (n) => (UI.$(`input[name=${n}]:checked`) || {}).value;
    const spec = () => ({ type: "meal", meat: val("meat") || null, meat_qty: +(val("meat-qty") || 1), veg_qty: +(val("veg") || 0), rice_type: val("rice-type") || "plain", rice_qty: +(val("rice-qty") || 1), qty: q });
    function update() {
      const s = spec(), none = !s.meat && !s.veg_qty, p = none ? null : priced(s);
      $("#meal-qty").textContent = q;
      $("#meal-price").textContent = p ? UI.money(p.unit * q) : "₱00.00";
      $("#meal-summary").children[0].hidden = !(p && p.budget);
      $("#meal-summary").children[1].textContent = p ? p.name + (p.budget ? " — Budget meal" : "") : "";
    }
    $("#qty-minus").addEventListener("click", () => { q = Math.max(1, q - 1); update(); });
    $("#qty-plus").addEventListener("click", () => { q++; update(); });
    $("#btn-add-meal").addEventListener("click", () => { const s = spec(); if (!s.meat && !s.veg_qty) return UI.toast("Select an item before adding this meal"); if (addSpec(s)) location.href = "pos.html"; });
    update();
  }
  render(); refreshProductDisplays();
  window.addEventListener("outbox-changed", () => Sync.badge());
});
