/* pos.js — the cashier screen. Used by pos.html, pos-meal.html and pos-meat.html (they share ONE cart, kept in this device).
   Each cart keeps a signed price snapshot; the server recomputes and validates its lines from that snapshot on sync. */
const MAX_CHANGE = 1000;   // same limit as the server: change can never exceed one ₱1,000 bill
document.addEventListener("DOMContentLoaded", async () => {
  const $ = UI.$, load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, save = (k, v) => localStorage.setItem(k, JSON.stringify(v));
  let boot = null, mp = {}, cart = load("pos_cart", []), held = load("pos_held", []);
  let cartPricing = load("pos_cart_pricing", null), heldPricing = load("pos_held_pricing", []);
  let legacyCartNeedsPriceConfirmation = false;
  if (!Array.isArray(heldPricing)) heldPricing = [];
  let heldAt = load("pos_held_at", []);
  if (!Array.isArray(heldAt)) heldAt = [];
  while (heldAt.length < held.length) heldAt.unshift(null);            // sales held before this list existed have no time
  const MEATS = ["beef", "chicken", "fish", "pork"], cap = (s) => s[0].toUpperCase() + s.slice(1);
  const catalogFor = (data) => ({
    aux_id: data.user.aux_id,
    token: data.pricing_token,
    meal_prices: data.meal_prices,
    products: data.products.map(({ product_id, name, price, qty }) => ({ product_id, name, price, qty })),
  });
  const saveCart = () => { save("pos_cart", cart); save("pos_cart_pricing", cartPricing); };
  const updateMealPrices = () => UI.$$("[data-price]").forEach((el) => {
    el.textContent = UI.money(mp[el.dataset.price.replace("_only", "")]);
  });
  const mealStockTag = (key) => {
    const qty = Number(boot && boot.meal_stock[key] || 0);
    return `<span class="pos-product__stock${qty > 0 ? "" : " pos-product__stock--out"}" data-meal-stock="${key}">${qty > 0 ? `${UI.num(qty)} left` : "Out of stock"}</span>`;
  };
  function updateMealStockHints() {
    if (!boot) return;
    UI.$$("[data-meal-stock]").forEach((el) => {
      const qty = Number(boot.meal_stock[el.dataset.mealStock] || 0);
      el.textContent = qty > 0 ? `${UI.num(qty)} left` : "Out of stock";
      el.classList.toggle("pos-product__stock--out", qty <= 0);
    });
  }

  /* price preview (same rules as backend/pricing.py, using the active cart's signed snapshot) */
  function priced(spec) {
    const t = spec.type;
    const prices = cartPricing ? cartPricing.meal_prices : mp;
    const products = cartPricing ? cartPricing.products : boot.products;
    if (t === "takeout_box") return { name: "Takeout box", unit: prices.take_out_box || 5, section: "Meals", parts: {} };
    if (t === "product") { const p = products.find((x) => x.product_id === spec.product_id) || { name: "(item no longer sold)", price: 0, product_id: spec.product_id }; return { name: p.name, unit: p.price, section: "Snacks", parts: {}, product: p.product_id }; }
    if (t === "meat") return { name: cap(spec.meat), unit: prices[spec.meat], section: "Meals", parts: { [spec.meat]: 1 } };
    if (t === "veg") return { name: "Veggy", unit: prices.veg, section: "Meals", parts: { veg: 1 } };
    if (t === "rice") return { name: "Plain Rice", unit: prices.rice, section: "Meals", parts: { rice: 1 } };
    if (t === "fried_rice") return { name: "Fried Rice", unit: prices.fried_rice, section: "Meals", parts: { rice: 1 } };
    const { meat, meat_qty: mq, veg_qty: veg, rice_type: rt, rice_qty: rq } = spec;
    const budget = !!meat && mq === 1 && veg === 1 && rq === 1;
    const unit = budget ? prices["budget_" + meat] + (rt === "fried" ? prices.fried_rice - prices.rice : 0) : (meat ? prices[meat] * mq : 0) + prices.veg * veg + (rt === "fried" ? prices.fried_rice : prices.rice) * rq;
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
      const product = boot.products.find((p) => String(p.product_id) === k)
        || (cartPricing && cartPricing.products.find((p) => String(p.product_id) === k));
      const have = k.startsWith("meal:") ? boot.meal_stock[k.slice(5)] : product && product.qty;
      if (v > (have ?? 0)) return k.startsWith("meal:") ? cap(k.slice(5)) + " servings" : product ? product.name : "Item";
    }
    return "";
  }

  /* cart */
  async function addSpec(spec) {
    if (!boot) return false;
    if (cart.length && (!cartPricing || !cartPricing.token)) {
      UI.toast("This saved cart has no locked prices. Cancel it or confirm current prices before continuing.");
      return false;
    }
    if (!cart.length) {
      if (navigator.onLine) {
        try {
          boot = await api("/api/pos/bootstrap", { timeout: 5000 });
          await Store.put("cache", { key: "bootstrap", value: boot, at: Date.now() });
        } catch (e) {
          if (!isOffline(e)) { UI.toast(e.message); return false; }
        }
      }
      if (!boot.pricing_token) {
        UI.toast("Connect to refresh the signed price list before starting a sale.");
        return false;
      }
      cartPricing = catalogFor(boot);
      legacyCartNeedsPriceConfirmation = false;
      mp = cartPricing.meal_prices;
      save("pos_cart_pricing", cartPricing);
      updateMealPrices();
      refreshProductDisplays();
    } else if (spec.type === "product" && !cartPricing.products.some((p) => p.product_id === spec.product_id)) {
      UI.toast("Finish this sale before adding an item from the updated price list");
      return false;
    }
    const next = cart.map((l) => ({ ...l })), found = next.find((l) => keyOf(l) === keyOf(spec));
    found ? (found.qty += spec.qty) : next.push({ ...spec });
    const lack = shortItem(next);
    if (lack) { UI.toast("Not enough stock: " + UI.titleCase(lack)); return false; }
    cart = next; saveCart(); render(); refreshProductDisplays(); return true;
  }
  function render() {
    const ul = $("#order-lines");
    ul.innerHTML = cart.length ? cart.map((l, i) => { const p = priced(l);
      return `<li class="order__line"><span>${UI.esc(UI.titleCase(p.name))}</span><span class="stepper"><button class="stepper__btn" type="button" data-dec="${i}"><span>−</span></button><span>${l.qty}</span><button class="stepper__btn" type="button" data-inc="${i}"><span>+</span></button></span><span class="order__line-amount">${UI.money(p.unit * l.qty)}</span></li>`; }).join("")
      : '<li class="order__empty">No items yet</li>';
    $("#order-total").textContent = UI.money(grand());
    const given = parseFloat($("#cash-tendered").value || 0);
    // if items were removed after the amount was typed, the change can be over the limit: say so instead of showing it
    $("#order-change").textContent = given - grand() > MAX_CHANGE ? "Too high" : UI.money(Math.max(0, given - grand()));
    $("#btn-resume").hidden = !held.length;
    $("#btn-resume").textContent = `View held sales (${held.length})`;
    $("#btn-hold").textContent = "Hold sale";
  }
  $("#order-lines").addEventListener("click", (e) => {
    const inc = e.target.dataset.inc, dec = e.target.dataset.dec;
    if (inc !== undefined) addSpec({ ...cart[inc], qty: 1 });
    if (dec !== undefined) {
      cart[dec].qty--;
      if (cart[dec].qty <= 0) cart.splice(dec, 1);
      if (!cart.length) { cartPricing = null; mp = boot.meal_prices; legacyCartNeedsPriceConfirmation = false; }
      saveCart(); render(); refreshProductDisplays();
    }
  });
  $("#btn-add-box").addEventListener("click", () => addSpec({ type: "takeout_box", qty: 1 }));
  $$all("input[name=pay]").forEach((r) => r.addEventListener("change", () => localStorage.setItem("pos_pay", $("#pay-1").checked ? "ewallet" : "cash")));
  /* amount tendered: never more than the total + ₱1,000 — so the change can never run away */
  $("#cash-tendered").addEventListener("input", (e) => {
    const el = e.target, max = Math.round((grand() + MAX_CHANGE) * 100) / 100;
    if (parseFloat(el.value) > max) { el.value = String(max); UI.toast(`Amount tendered cannot exceed ${UI.money(max)} (change up to ${UI.money(MAX_CHANGE)})`); }
    render();
  });
  $("#cash-tendered").addEventListener("keydown", (e) => { if (["e", "E", "+", "-"].includes(e.key)) e.preventDefault(); });
  $("#ewallet-ref4").addEventListener("input", (e) => (e.target.value = e.target.value.replace(/\D/g, "").slice(0, 4)));
  function $$all(s) { return UI.$$(s); }

  /* held sales: any number can wait; the cashier picks which one to resume from a list */
  const saveHeld = () => { save("pos_held", held); save("pos_held_pricing", heldPricing); save("pos_held_at", heldAt); };
  function holdCurrent() {
    held.push(cart); heldPricing.push(cartPricing); heldAt.push(new Date().toISOString());
    cart = []; cartPricing = null; legacyCartNeedsPriceConfirmation = false; mp = boot.meal_prices;
    saveHeld(); saveCart();
  }
  function heldSummary(i) {            // items + total of held sale i, priced with ITS OWN saved snapshot
    const active = cartPricing;
    cartPricing = heldPricing[i] && heldPricing[i].meal_prices ? heldPricing[i] : null;
    try {
      const lines = held[i].map((l) => ({ name: UI.titleCase(priced(l).name), qty: l.qty }));
      return { lines, total: held[i].reduce((n, l) => n + priced(l).unit * l.qty, 0) };
    } finally { cartPricing = active; }
  }
  function resumeHeld(i) {
    const savedPricing = heldPricing[i];
    if (savedPricing && savedPricing.aux_id !== boot.user.aux_id) { UI.toast("Sign in to the outlet that owns this held sale"); return false; }
    if (!boot.pricing_token) { UI.toast("Connect to refresh the signed price list before resuming a sale."); return false; }
    if ((!savedPricing || !savedPricing.token) && !confirm("This held sale has no saved price snapshot. Resume it at current prices?")) return false;
    const [next] = held.splice(i, 1), [nextPricing] = heldPricing.splice(i, 1); heldAt.splice(i, 1);
    if (cart.length) holdCurrent();                                     // the sale on screen goes to the list instead of being lost
    cart = next;
    cartPricing = nextPricing && nextPricing.token ? nextPricing : catalogFor(boot);
    legacyCartNeedsPriceConfirmation = false;
    mp = cartPricing.meal_prices;
    saveHeld(); saveCart();
    $("#cash-tendered").value = ""; $("#ewallet-ref4").value = "";
    updateMealPrices(); render(); refreshProductDisplays();
    return true;
  }
  function heldList() {
    if (!held.length) return UI.toast("No held sales");
    const time = (iso) => iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—";
    const ov = UI.modal(`<h2 class="card__title">Held sales (${held.length})</h2>
      ${cart.length ? '<p class="muted text-small">The sale on screen will be held when you resume another one.</p>' : ""}
      <ul class="held-list">${held.map((_, i) => { const s = heldSummary(i);
        return `<li class="held-list__item">
          <div class="held-list__info"><strong>#${i + 1} · ${UI.money(s.total)}</strong><span class="muted text-small">Held ${time(heldAt[i])}</span>
            <span class="text-small">${s.lines.map((l) => `${UI.esc(l.name)} ×${l.qty}`).join(", ")}</span></div>
          <div class="held-list__actions"><button class="btn" type="button" data-resume="${i}">Resume</button>
            <button class="link-button delete-action" type="button" data-discard="${i}">Remove</button></div></li>`; }).join("")}</ul>
      <div class="modal__actions"><button class="btn btn--ghost" data-close type="button">Close</button></div>`);
    ov.addEventListener("click", (e) => {
      const r = e.target.closest("[data-resume]"), d = e.target.closest("[data-discard]");
      if (r && resumeHeld(Number(r.dataset.resume))) ov.remove();
      if (d && confirm("Remove this held sale? It will be cancelled.")) {
        const i = Number(d.dataset.discard); held.splice(i, 1); heldPricing.splice(i, 1); heldAt.splice(i, 1);
        saveHeld(); render(); ov.remove(); if (held.length) heldList();
      }
    });
  }
  $("#btn-hold").addEventListener("click", () => { if (!cart.length) return; holdCurrent(); $("#cash-tendered").value = ""; $("#ewallet-ref4").value = ""; updateMealPrices(); render(); refreshProductDisplays(); UI.toast(`Sale put on hold (${held.length} held)`); });
  $("#btn-resume").addEventListener("click", () => { if (boot) heldList(); });
  $("#btn-cancel").addEventListener("click", () => { if (cart.length && !confirm("Cancel this sale?")) return; cart = []; cartPricing = null; legacyCartNeedsPriceConfirmation = false; mp = boot.meal_prices; saveCart(); $("#cash-tendered").value = ""; $("#ewallet-ref4").value = ""; updateMealPrices(); render(); refreshProductDisplays(); });

  /* complete sale: save on the device first, then sync */
  $("#btn-complete").addEventListener("click", async () => {
    if (!cart.length) return UI.toast("Add an item first");
    if (legacyCartNeedsPriceConfirmation || !cartPricing || !cartPricing.token) return UI.toast("This saved cart has no locked prices. Cancel it or confirm current prices before completing it.");
    if (cartPricing.aux_id !== boot.user.aux_id) return UI.toast("This sale belongs to another outlet. Sign in to that outlet to complete it.");
    const ewallet = $("#pay-1").checked, tendered = parseFloat($("#cash-tendered").value || 0), ref4 = $("#ewallet-ref4").value, t = grand();
    if (ewallet && !/^\d{4}$/.test(ref4)) return UI.toast("Enter the last 4 digits of the e-wallet reference number");
    if (!ewallet && !(tendered >= t)) return UI.toast("Amount tendered is less than the total");
    if (!ewallet && tendered - t > MAX_CHANGE) return UI.toast(`Amount tendered is too high — change cannot exceed ${UI.money(MAX_CHANGE)}`);
    const lack = shortItem(cart); if (lack) return UI.toast("Not enough stock: " + UI.titleCase(lack));
    const now = UI.isoNow(), code = UI.session().user.aux_code;
    const txn = { id: UI.uuid(), receipt_no: `${code}-${now.slice(0, 10).replace(/-/g, "")}-${UI.uuid().slice(0, 4).toUpperCase()}`, created_at: now,
      payment_method: ewallet ? "E-Wallet" : "Cash", amount_tendered: ewallet ? null : tendered, ewallet_ref4: ewallet ? ref4 : null,
      dine: "in", pricing_token: cartPricing.token, lines: cart.map((l) => ({ ...l })) };
    await Store.put("outbox", { id: txn.id, payload: txn, status: "pending" });       // 1. safe on the device
    await Sync.useStock(needOf(cart));                                                // lower the saved stock
    Object.entries(needOf(cart)).forEach(([k, v]) => {
      if (k.startsWith("meal:")) boot.meal_stock[k.slice(5)] -= v;
      else {
        const product = boot.products.find((p) => String(p.product_id) === k);
        if (product) product.qty -= v;
      }
    });
    cart = []; cartPricing = null; legacyCartNeedsPriceConfirmation = false; mp = boot.meal_prices; saveCart(); $("#cash-tendered").value = ""; $("#ewallet-ref4").value = ""; updateMealPrices(); render(); refreshProductDisplays();
    Sync.badge(); Sync.flush();                                                       // 2. send when online
  });

  /* data: online = fresh from the server, offline = the copy saved on this device */
  await Sync.flush();
  boot = await Sync.bootstrap();
  if (!boot) { UI.toast("Connect to the internet once to download the products and prices."); return; }
  mp = boot.meal_prices;
  updateMealStockHints();
  if (cart.length && (!cartPricing || !cartPricing.token)) {
    legacyCartNeedsPriceConfirmation = true;
    if (boot.pricing_token && confirm("This saved cart predates price locking. Apply the current prices to it?")) {
      cartPricing = catalogFor(boot);
      legacyCartNeedsPriceConfirmation = false;
      save("pos_cart_pricing", cartPricing);
    } else {
      UI.toast("This saved cart has no locked prices. Cancel it or reload and confirm current prices before completing it.");
    }
  }
  if (cartPricing && cartPricing.aux_id !== boot.user.aux_id) UI.toast("This saved cart belongs to another outlet. Sign in to that outlet to complete it.");
  if (cartPricing) mp = cartPricing.meal_prices;
  updateMealPrices();
  const doneBtn = $("#btn-done-day");
  doneBtn.addEventListener("click", async () => {
    if (doneBtn.disabled) return;
    if (cart.length) return UI.toast("Finish or cancel the current sale first");
    if (!navigator.onLine) return UI.toast("Connect to the internet before sealing sales");
    doneBtn.disabled = true;
    let pending, rejected;
    try {
      await Sync.flush();
      pending = await Sync.pending();
      rejected = await Sync.rejected();
    } catch (e) {
      doneBtn.disabled = false;
      return UI.toast(e.message);
    }
    doneBtn.disabled = false;
    if (pending.length || rejected.length) return UI.toast("Sync or resolve all waiting sales before sealing");
    const ov = UI.modal(`<h2 class="card__title">Seal these sales?</h2><p class="muted text-small">This groups today's synced sales into a separate period without changing the sales date. Sales still waiting on another device will not be included.</p><label for="batch-password">Confirm with your password</label><input type="password" id="batch-password" autocomplete="current-password" placeholder="Password"><div class="modal__actions"><button class="btn" id="batch-confirm" type="button">Seal sales</button><button class="btn btn--ghost" data-close type="button">Cancel</button></div>`);
    ov.querySelector("#batch-confirm").addEventListener("click", async (event) => {
      const confirmBtn = event.currentTarget;
      const password = ov.querySelector("#batch-password").value;
      if (!password) return UI.toast("Enter your password");
      confirmBtn.disabled = true;
      try {
        const result = await api("/api/sales-batches/seal", { method: "POST", body: { password } });
        const batch = result.batch;
        ov.remove();
        UI.toast(`Sales sealed · ${batch.transaction_count} transactions · ${UI.money(batch.total_sales)}`);
      } catch (e) {
        confirmBtn.disabled = false;
        UI.toast(e.message);
      }
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
      ? `<span class="pos-product__stock${qty > 0 ? "" : " pos-product__stock--out"}">${qty > 0 ? `${qty} left` : "Out of stock"}</span>`
      : "";
    const listed = cartPricing && cartPricing.products.find((item) => item.product_id === p.product_id);
    const name = listed ? listed.name : p.name, price = listed ? listed.price : p.price;
    return `<button class="tile pos-product" type="button" data-product="${p.product_id}"><b class="pos-product__name">${UI.esc(UI.titleCase(name))}</b>${punchBadge}<span class="tile__price pos-product__price">${UI.money(price)}</span>${stock}</button>`;
  }
  function drawCatalog() {
    if (!posProducts) return;
    const mealEmpty = ["rice", "pork", "beef", "chicken", "fish", "veg"].every((key) => Number(boot.meal_stock[key] || 0) <= 0);
    const mealTiles = activeCategory === "All" || activeCategory === "Meals" ? `
      <a class="tile pos-category-tile" href="pos-meal.html">${mealPunchBadge(cartQuantity((line) => line.type === "meal"))}<b>Meal</b>${mealEmpty ? '<span class="pos-product__stock pos-product__stock--out">Out of stock</span>' : ""}</a>
      <a class="tile pos-category-tile" href="pos-meat.html">${mealPunchBadge(cartQuantity(
        (line) => line.type === "meat" || (line.type === "meal" && !!line.meat),
        (line) => line.type === "meal" ? line.meat_qty * line.qty : line.qty
      ))}<b>Meat</b></a>
      <button class="tile" type="button" data-add="veggy">${mealPunchBadge(cartQuantity(
        (line) => line.type === "veg" || (line.type === "meal" && line.veg_qty > 0),
        (line) => line.type === "meal" ? line.veg_qty * line.qty : line.qty
      ))}<b>Veggy</b>${mealStockTag("veg")}<span class="tile__price">${UI.money(mp.veg)}</span></button>
      <button class="tile" type="button" data-add="rice">${mealPunchBadge(cartQuantity(
        (line) => line.type === "rice" || (line.type === "meal" && line.rice_type !== "fried"),
        (line) => line.type === "meal" ? line.rice_qty * line.qty : line.qty
      ))}<b>Rice</b>${mealStockTag("rice")}<span class="tile__price">${UI.money(mp.rice)}</span></button>
      <button class="tile" type="button" data-add="fried-rice">${mealPunchBadge(cartQuantity(
        (line) => line.type === "fried_rice" || (line.type === "meal" && line.rice_type === "fried"),
        (line) => line.type === "meal" ? line.rice_qty * line.qty : line.qty
      ))}<b>Fried Rice</b>${mealStockTag("rice")}<span class="tile__price">${UI.money(mp.fried_rice)}</span></button>` : "";
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
    updateMealStockHints();
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
      updateMealStockHints();
      const s = spec(), none = !s.meat && !s.veg_qty, p = none ? null : priced(s);
      $("#meal-qty").textContent = q;
      $("#meal-price").textContent = p ? UI.money(p.unit * q) : "₱00.00";
      $("#meal-summary").children[0].hidden = !(p && p.budget);
      $("#meal-summary").children[1].textContent = p ? p.name : "";
    }
    $("#qty-minus").addEventListener("click", () => { q = Math.max(1, q - 1); update(); });
    $("#qty-plus").addEventListener("click", () => { q++; update(); });
    $("#btn-add-meal").addEventListener("click", async () => { const s = spec(); if (!s.meat && !s.veg_qty) return UI.toast("Select an item before adding this meal"); if (await addSpec(s)) location.href = "pos.html"; });
    update();
  }
  render(); refreshProductDisplays();
  window.addEventListener("outbox-changed", () => Sync.badge());
});
