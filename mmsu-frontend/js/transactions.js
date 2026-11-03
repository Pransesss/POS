/* transactions.js — staff (own outlet) and admin (all or one). Transactions are shown per sealed sales period,
   and (admin) the printable / Excel requisition slips. */
document.addEventListener("DOMContentLoaded", async () => {
  const { $, esc, money, num } = UI, admin = UI.session().user.role === "admin", PARTS = ["rice", "pork", "beef", "chicken", "fish", "veg"];
  const slipTemplates = admin ? { meals: $("#slip-meals").outerHTML, snacks: $("#slip-snacks").outerHTML } : null;
  let auxes = [];

  const stamp = (r) => UI.stamp(r.created_at);
  const dots = (r) => `${r.is_budget ? '<span class="dot dot--budget"></span>' : ""}`;
  const mealRow = (r) => `<tr><td>${stamp(r)}</td><td>${esc(r.ref)}</td><td>${esc(r.order)}</td><td>${r.pay}</td><td>${esc(r.ref4 || "—")}</td>${PARTS.map((k) => `<td>${r[k] ? num(r[k]) : ""}</td>`).join("")}<td>${money(r.total)}</td><td>${dots(r)}</td></tr>`;
  const snackRow = (r) => `<tr><td>${stamp(r)}</td><td>${esc(r.ref)}</td><td class="transaction-items"><span>${esc(UI.titleCase(r.items))}</span></td><td>${r.pay}</td><td>${esc(r.ref4 || "—")}</td><td>${money(r.total)}</td></tr>`;
  const empty = (n) => `<tr class="table__empty"><td colspan="${n}">No transactions in this range</td></tr>`;
  const groupedBatchKey = (auxId, day, batchId) => `${auxId}:${day}:${batchId || "open"}`;
  const displayPeriod = (day, first, last) => {
    if (!first || !last) return `${UI.mdy(day)} · No orders`;
    return `${UI.mdy(day)} · ${UI.timeLabel(first)} to ${UI.timeLabel(last)}`;
  };
  let periodsById = new Map();
  const periodLabel = (auxId, day, batchId) => {
    const period = periodsById.get(groupedBatchKey(auxId, day, batchId));
    return displayPeriod(day, period && period.first_order_at, period && period.last_order_at);
  };

  function renderBatchTables(data) {
    const groups = new Map();
    periodsById = new Map(data.order_ranges.map((range) => [groupedBatchKey(range.aux_id, range.business_date, range.batch_id), range]));
    const getGroup = (item) => {
      const key = groupedBatchKey(item.aux_id, item.business_date, item.batch_id);
      if (!groups.has(key)) {
        groups.set(key, {
          aux_id: item.aux_id, aux_name: item.aux_name || "", business_date: item.business_date,
          batch_id: item.batch_id, batch_number: item.batch_number, first_order_at: item.first_order_at,
          last_order_at: item.last_order_at, meals: [], snacks: [],
        });
      }
      const group = groups.get(key);
      if (item.aux_name) group.aux_name = item.aux_name;
      if (item.batch_number) group.batch_number = item.batch_number;
      if (item.first_order_at) group.first_order_at = item.first_order_at;
      if (item.last_order_at) group.last_order_at = item.last_order_at;
      return group;
    };
    data.batches.forEach((batch) => getGroup(batch));
    data.order_ranges.forEach((range) => getGroup(range));
    const addRows = (rows, section) => rows.forEach((row) => {
      const group = getGroup(row);
      group[section].push(row);
    });
    addRows([...data.meals.regular, ...data.meals.carried], "meals");
    addRows([...data.snacks.regular, ...data.snacks.carried], "snacks");

    const ordered = [...groups.values()].sort((a, b) =>
      b.business_date.localeCompare(a.business_date) || a.aux_id - b.aux_id ||
      (a.batch_number || Number.MAX_SAFE_INTEGER) - (b.batch_number || Number.MAX_SAFE_INTEGER));
    const heading = (group) => {
      const range = group.first_order_at && group.last_order_at
        ? `${UI.timeLabel(group.first_order_at)} to ${UI.timeLabel(group.last_order_at)}`
        : "No orders";
      return `${UI.mdy(group.business_date)} · ${range}${admin ? ` · ${esc(group.aux_name)}` : ""}`;
    };
    const mealHead = `<thead><tr><th>Date &amp; time</th><th>Ref</th><th>Order</th><th>Pay</th><th>E-wallet ref #</th>${PARTS.map((p) => `<th>${esc(p === "veg" ? "Vegs" : p[0].toUpperCase() + p.slice(1))}</th>`).join("")}<th>Total</th><th></th></tr></thead>`;
    const snackHead = `<thead><tr><th>Date &amp; time</th><th>Ref</th><th>Items</th><th>Pay</th><th>E-wallet ref #</th><th>Total</th></tr></thead>`;
    const mealColumns = 13, snackColumns = 6;
    $("#meal-batch-tables").innerHTML = ordered.map((group) => {
      const rows = group.meals.slice().sort((a, b) => a.created_at.localeCompare(b.created_at));
      const total = rows.reduce((sum, row) => sum + Number(row.total || 0), 0);
      return `<section class="sales-period"><h3 class="table-title">${heading(group)}</h3><table class="table">${mealHead}<tbody>${rows.map(mealRow).join("") || `<tr class="table__empty"><td colspan="${mealColumns}">No matching meal transactions in this period</td></tr>`}</tbody><tfoot><tr><td colspan="${mealColumns - 2}">Period meal sales</td><td>${money(total)}</td><td></td></tr></tfoot></table></section>`;
    }).join("") || '<p class="muted text-small">No meal sales in this date range.</p>';
    $("#snack-batch-tables").innerHTML = ordered.map((group) => {
      const rows = group.snacks.slice().sort((a, b) => a.created_at.localeCompare(b.created_at));
      const total = rows.reduce((sum, row) => sum + Number(row.total || 0), 0);
      return `<section class="sales-period"><h3 class="table-title">${heading(group)}</h3><table class="table sales-period__snacks">${snackHead}<tbody>${rows.map(snackRow).join("") || `<tr class="table__empty"><td colspan="${snackColumns}">No matching snack transactions in this period</td></tr>`}</tbody><tfoot><tr><td colspan="${snackColumns - 1}">Period snack sales</td><td>${money(total)}</td></tr></tfoot></table></section>`;
    }).join("") || '<p class="muted text-small">No snack sales in this date range.</p>';
  }

  function draw(d) {
    $("#kpi-sales").textContent = money(d.kpi.sales); $("#kpi-cash").textContent = money(d.kpi.cash); $("#kpi-ewallet").textContent = money(d.kpi.ewallet); $("#kpi-remitted").textContent = money(d.kpi.remitted);
    periodsById = new Map(d.order_ranges.map((range) => [groupedBatchKey(range.aux_id, range.business_date, range.batch_id), range]));
    $("#table-remittances tbody").innerHTML = d.remittances.map((r) => `<tr><td>${stamp({ created_at: r.recorded_at })}</td><td>${periodLabel(r.aux_id, r.business_date, r.batch_id)}</td>${admin ? `<td>${esc(r.aux_name)}</td>` : ""}<td>${money(r.amount)}</td><td>${r.expected_amount == null ? "—" : money(r.expected_amount)}</td></tr>`).join("") || empty(admin ? 5 : 4);
    $("#table-batches tbody").innerHTML = d.batches.map((b) => `<tr><td>${stamp({ created_at: b.sealed_at })}</td><td>${periodLabel(b.aux_id, b.business_date, b.batch_id)}</td>${admin ? `<td>${esc(b.aux_name)}</td>` : ""}<td>${num(b.transaction_count)}</td><td>${money(b.total_cash)}</td><td>${money(b.total_ewallet)}</td><td>${money(b.total_sales)}</td></tr>`).join("") || empty(admin ? 7 : 6);
    const m = d.meals;
    $("#table-meals-summary").innerHTML = ["received", "sold", "left"].map((kind) =>
      `<tr><th>${kind === "received" ? "Quantity received" : kind === "sold" ? "Quantity sold" : "Quantity left"}</th>${PARTS.map((part) => `<td>${num(m[kind][part])}</td>`).join("")}</tr>`).join("");
    const s = d.snacks;
    $("#table-snack-summary tbody").innerHTML = s.summary.map((r) => `<tr><td>${esc(UI.titleCase(r.name))}</td><td>${num(r.beg)}</td><td>${num(r.rcvd)}</td><td>${num(r.total)}</td><td>${num(r.sold)}</td><td>${num(r.left)}</td><td>${money(r.avg_price)}</td><td>${money(r.sales)}</td></tr>`).join("") || empty(8);
    renderBatchTables(d);
  }
  const params = () => ({ aux: admin ? $("#filter-aux").value : "", from: $("#filter-from").value, to: $("#filter-to").value, pay: (UI.$("input[name=pay-filter]:checked") || {}).value });
  async function load() {
    try { draw(await api("/api/transactions" + query(params()))); if (admin) buildReport(); }
    catch (e) { UI.toast(isOffline(e) ? "You are offline — this page needs the server." : e.message); }
  }
  // pay filter radios: values for the API
  [["pay-filter-all", ""], ["pay-filter-cash", "cash"], ["pay-filter-ewallet", "ewallet"]].forEach(([id, v]) => { const el = $("#" + id); if (el) { el.value = v; el.addEventListener("change", load); } });
  $("#filter-from").addEventListener("change", load); $("#filter-to").addEventListener("change", load);

  /* staff: record the remittance */
  if (!admin) {
    $("#btn-remit").addEventListener("click", async () => {
      let exp = { expected: 0 }; try { exp = await api("/api/remittances/expected"); } catch (e) { return UI.toast("You are offline — remit when the internet is back."); }
      if (!exp.batch_id) return UI.toast("Seal the current sales before recording its remittance");
      const period = displayPeriod(exp.date, exp.first_order_at, exp.last_order_at);
      const ov = UI.modal(`<h2 class="card__title">Record remittance · ${period}</h2><p class="muted text-small">Cash sales in this period: <strong>${money(exp.expected)}</strong></p><label for="m-amount">Amount handed over (₱)</label><input type="number" id="m-amount" min="0" value="${exp.expected}"><div class="modal__actions"><button class="btn" id="m-save" type="button">Save</button><button class="btn btn--ghost" data-close type="button">Cancel</button></div>`);
      ov.querySelector("#m-save").addEventListener("click", async () => {
        try { await api("/api/remittances", { method: "POST", body: { amount: $("#m-amount").value, batch_id: exp.batch_id } }); ov.remove(); UI.toast("Remittance recorded"); load(); } catch (e) { UI.toast(e.message); }
      });
    });
  }

  /* admin: slips (one Meals + one Snacks slip per outlet per day) */
  async function buildReport() {
    const from = $("#filter-from").value, to = $("#filter-to").value, id = $("#filter-aux").value;
    const list = id && id !== "all" ? auxes.filter((a) => String(a.aux_id) === id) : auxes, days = [];
    for (let d = new Date(from + "T00:00:00"); UI.isoDate(d) <= to && days.length < 31; d.setDate(d.getDate() + 1)) days.push(UI.isoDate(d));
    const box = $(".report"); let html = "";
    for (const a of list) for (const day of days) {
      const d = await api("/api/transactions" + query({ aux: a.aux_id, from: day, to: day }));
      html += slipMeals(a, day, d) + slipSnacks(a, day, d);
    }
    box.innerHTML = html || "<p class='muted'>No slips for this range.</p>";
  }
  const split = (rows) => rows.reduce((o, r) => { o[r.pay === "Cash" ? "cash" : "ew"] += +r.total; return o; }, { cash: 0, ew: 0 });
  function fillSlip(tpl, a, day, set) {
    const w = document.createElement("div"); w.innerHTML = tpl; const art = w.firstElementChild;
    art.querySelector("[id$=-date]").textContent = UI.mdy(day); art.querySelector("[id$=-outlet]").textContent = a.name;
    set(art); art.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
    return art.outerHTML;
  }
  function slipMeals(a, day, d) {
    const rows = [...d.meals.regular, ...d.meals.carried].sort((x, y) => x.created_at.localeCompare(y.created_at)), sp = split(rows);
    return fillSlip(slipTemplates.meals, a, day, (art) => {
      art.querySelector("#slip-meals-rows").innerHTML = rows.map((r) => `<tr><td>${esc(r.ref)} ${UI.timeLabel(r.created_at)}</td>${PARTS.map((k) => `<td>${r[k] ? num(r[k]) : ""}</td>`).join("")}<td></td><td>${money(r.total)}</td></tr>`).join("");
      const tf = art.querySelector("tfoot").rows;
      ["received", "sold", "left"].forEach((k, i) => { tf[i].cells[1].outerHTML = PARTS.map((p) => `<td>${num(d.meals[k][p])}</td>`).join("") + "<td></td><td></td>"; });
      tf[3].cells[1].textContent = money(sp.cash + sp.ew); tf[4].cells[1].textContent = money(sp.cash); tf[5].cells[1].textContent = money(sp.ew);
    });
  }
  function slipSnacks(a, day, d) {
    const rows = [...d.snacks.regular, ...d.snacks.carried], sp = split(rows);
    return fillSlip(slipTemplates.snacks, a, day, (art) => {
      art.querySelector("#slip-snacks-rows").innerHTML = d.snacks.summary.map((r) => `<tr><td>${esc(UI.titleCase(r.name))}</td><td>${num(r.beg)}</td><td>${num(r.rcvd)}</td><td>${num(r.total)}</td><td>${num(r.sold)}</td><td>${num(r.left)}</td><td>${num(r.avg_price)}</td><td>${r.sold ? num(r.sales) : ""}</td></tr>`).join("");
      const tf = art.querySelector("tfoot").rows;
      tf[0].cells[1].textContent = money(sp.cash + sp.ew); tf[1].cells[1].textContent = money(sp.cash); tf[2].cells[1].textContent = money(sp.ew);
    });
  }
  if (admin) {
    auxes = (await api("/api/auxiliaries")).filter((a) => a.is_active);
    UI.options($("#filter-aux"), auxes, "aux_id", "name");
    $("#filter-aux").addEventListener("change", load);
    $("#btn-print").addEventListener("click", () => window.print());
    $("#btn-excel").addEventListener("click", () => {
      const html = `<html><head><meta charset="utf-8"><style>table{border-collapse:collapse}td,th{border:1px solid #000;padding:2px 6px}</style></head><body>${$(".report").innerHTML}</body></html>`;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([html], { type: "application/vnd.ms-excel" })); a.download = `requisition-slips_${$("#filter-from").value}_${$("#filter-to").value}.xls`; a.click();
    });
  }
  load();
});
