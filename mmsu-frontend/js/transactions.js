/* transactions.js — staff (own outlet) and admin (all or one). Meals table + Snacks tables, regular and carried-over sales,
   and (admin) the printable / Excel requisition slips. */
document.addEventListener("DOMContentLoaded", async () => {
  const { $, esc, money, num } = UI, admin = UI.session().user.role === "admin", PARTS = ["rice", "pork", "beef", "chicken", "fish", "veg"];
  const slipTemplates = admin ? { meals: $("#slip-meals").outerHTML, snacks: $("#slip-snacks").outerHTML } : null;
  let auxes = [];

  const stamp = (r) => UI.stamp(r.created_at);
  const dots = (r) => `${r.is_budget ? '<span class="dot dot--budget"></span>' : ""}`;
  const mealRow = (r) => `<tr><td>${stamp(r)}</td><td>${esc(r.ref)}</td>${admin ? `<td>${esc(r.aux_name)}</td>` : ""}<td>${esc(r.order)}</td><td>${r.pay}</td><td>${esc(r.ref4 || "—")}</td>${PARTS.map((k) => `<td>${r[k] ? num(r[k]) : ""}</td>`).join("")}<td>${money(r.total)}</td><td>${dots(r)}</td></tr>`;
  const snackRow = (r) => `<tr><td>${stamp(r)}</td><td>${esc(r.ref)}</td>${admin ? `<td>${esc(r.aux_name)}</td>` : ""}<td>${esc(r.items)}</td><td>${r.pay}</td><td>${esc(r.ref4 || "—")}</td><td>${money(r.total)}</td></tr>`;
  const empty = (n) => `<tr class="table__empty"><td colspan="${n}">No transactions in this range</td></tr>`;
  const foot = (id, i, vals) => { const row = $(`#${id} tfoot`).rows[i]; vals.forEach((v, k) => (row.cells[1 + k].textContent = v)); };

  function draw(d) {
    $("#kpi-sales").textContent = money(d.kpi.sales); $("#kpi-cash").textContent = money(d.kpi.cash); $("#kpi-ewallet").textContent = money(d.kpi.ewallet); $("#kpi-remitted").textContent = money(d.kpi.remitted);
    $("#table-remittances tbody").innerHTML = d.remittances.map((r) => `<tr><td>${stamp({ created_at: r.recorded_at })}</td><td>${esc(r.business_date)}</td>${admin ? `<td>${esc(r.aux_name)}</td>` : ""}<td>${money(r.amount)}</td><td>${r.expected_amount == null ? "—" : money(r.expected_amount)}</td></tr>`).join("") || empty(admin ? 5 : 4);
    const m = d.meals, cols = admin ? 14 : 13;
    $("#table-meals-regular tbody").innerHTML = m.regular.map(mealRow).join("") || empty(cols);
    $("#table-meals-carried tbody").innerHTML = m.carried.map(mealRow).join("") || empty(cols);
    ["received", "sold", "left"].forEach((k, i) => foot("table-meals-regular", i, PARTS.map((p) => num(m[k][p]))));
    foot("table-meals-regular", 3, [money(m.regular_total)]);
    foot("table-meals-carried", 0, PARTS.map((p) => num(m.carried_sold[p]))); foot("table-meals-carried", 1, [money(m.carried_total)]);
    const s = d.snacks;
    $("#table-snack-summary tbody").innerHTML = s.summary.map((r) => `<tr><td>${esc(r.name)}</td><td>${num(r.beg)}</td><td>${num(r.rcvd)}</td><td>${num(r.total)}</td><td>${num(r.sold)}</td><td>${num(r.left)}</td><td>${money(r.price)}</td><td>${money(r.sales)}</td></tr>`).join("") || empty(8);
    $("#table-snack-regular tbody").innerHTML = s.regular.map(snackRow).join("") || empty(admin ? 7 : 6);
    $("#table-snack-carried tbody").innerHTML = s.carried.map(snackRow).join("") || empty(admin ? 7 : 6);
  }
  const params = () => ({ aux: admin ? $("#filter-aux").value : "", from: $("#filter-from").value, to: $("#filter-to").value, pay: (UI.$("input[name=pay-filter]:checked") || {}).value });
  async function load() {
    try { draw(await api("/api/transactions" + query(params()))); if (admin) buildReport(); }
    catch (e) { UI.toast(isOffline(e) ? "You are offline — this page needs the server." : e.message); }
  }
  // pay filter radios: values for the API
  [["pay-filter-all", ""], ["pay-filter-cash", "cash"], ["pay-filter-ewallet", "ewallet"]].forEach(([id, v]) => { const el = $("#" + id); if (el) { el.value = v; el.addEventListener("change", load); } });
  $("#filter-from").addEventListener("change", load); $("#filter-to").addEventListener("change", load);

  /* ---------- staff: record the remittance ---------- */
  if (!admin) {
    $("#btn-remit").addEventListener("click", async () => {
      let exp = { expected: 0 }; try { exp = await api("/api/remittances/expected"); } catch (e) { return UI.toast("You are offline — remit when the internet is back."); }
      const ov = UI.modal(`<h2 class="card__title">Record remittance</h2><p class="muted text-small">Cash sales recorded for today: <strong>${money(exp.expected)}</strong></p><label for="m-amount">Amount handed over (₱)</label><input type="number" id="m-amount" min="0" value="${exp.expected}"><div class="modal__actions"><button class="btn" id="m-save" type="button">Save</button><button class="btn btn--ghost" data-close type="button">Cancel</button></div>`);
      ov.querySelector("#m-save").addEventListener("click", async () => {
        try { await api("/api/remittances", { method: "POST", body: { amount: $("#m-amount").value } }); ov.remove(); UI.toast("Remittance recorded"); load(); } catch (e) { UI.toast(e.message); }
      });
    });
  }

  /* ---------- admin: slips (one Meals + one Snacks slip per outlet per day) ---------- */
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
      art.querySelector("#slip-snacks-rows").innerHTML = d.snacks.summary.map((r) => `<tr><td>${esc(r.name)}</td><td>${num(r.beg)}</td><td>${num(r.rcvd)}</td><td>${num(r.total)}</td><td>${num(r.sold)}</td><td>${num(r.left)}</td><td>${num(r.price)}</td><td>${r.sold ? num(r.sales) : ""}</td></tr>`).join("");
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
