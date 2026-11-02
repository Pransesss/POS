/* dashboard.js — staff dashboard (own outlet) and admin dashboard (all outlets or one). */
document.addEventListener("DOMContentLoaded", async () => {
  const { $, esc, money, num } = UI, admin = UI.session().user.role === "admin";
  let data = null, openPred = false, openTop = false, openLow = false;

  /* tiny charts drawn with SVG (colours come from the page's CSS variables) */
  const bars = (rows, id) => {
    const el = $(id), max = Math.max(1, ...rows.map((r) => +r.qty));
    if (!rows.length) { el.textContent = "No sales yet"; return; }
    const w = 300 / rows.length;
    el.innerHTML = `<svg viewBox="0 0 300 150" width="100%" height="150">${rows.map((r, i) => { const h = Math.round((r.qty / max) * 95) + 2, x = i * w + 4;
      return `<rect x="${x}" y="${110 - h}" width="${Math.max(8, w - 8)}" height="${h}" rx="3" fill="currentColor" opacity=".8"/><text x="${x + (w - 8) / 2}" y="${104 - h}" font-size="9" text-anchor="middle" fill="currentColor">${num(r.qty)}</text><text x="${x + (w - 8) / 2}" y="125" font-size="7" text-anchor="middle" fill="currentColor" opacity=".7">${esc(r.name.length > 12 ? r.name.slice(0, 11) + "…" : r.name)}</text>`; }).join("")}</svg>`;
  };
  const line = (rows) => {
    const el = $("#chart-weekly"), max = Math.max(1, ...rows.map((r) => +r.total)), pts = rows.map((r, i) => [20 + i * 43, 100 - (r.total / max) * 85]);
    el.innerHTML = `<svg viewBox="0 0 300 130" width="100%" height="140"><polyline points="${pts.map((p) => p.join(",")).join(" ")}" fill="none" stroke="currentColor" stroke-width="2"/>${pts.map((p, i) => `<circle cx="${p[0]}" cy="${p[1]}" r="3" fill="currentColor"/><text x="${p[0]}" y="120" font-size="8" text-anchor="middle" fill="currentColor" opacity=".7">${new Date(rows[i].date + "T00:00:00").toLocaleDateString("en-US", { weekday: "short" })}</text>`).join("")}</svg>`;
  };

  function draw() {
    const f = data.forecast, c = data.cash;
    $("#kpi-predicted").textContent = num(f.total_predicted);
    $("#kpi-lowout").textContent = data.lowout.total;
    const ev = data.event_tomorrow, be = $("#banner-event");
    be.hidden = !ev;
    if (ev) { const t = { no_classes: "No classes / ADM", exam: "Exam", event: "Event", other: "Other" }[ev.event_type]; be.textContent = `Tomorrow: ${ev.name} (${t})${ev.event_type === "no_classes" ? " — no production planned" : " — prediction adjusted"}`; }
    const bd = $("#banner-delivery");
    if (bd) { bd.hidden = !data.pending_deliveries; bd.textContent = `${data.pending_deliveries} delivery waiting for you to check and accept →`; }
    const rows = openPred ? f.items : f.items.slice(0, 5);
    $("#table-predicted tbody").innerHTML = rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${num(r.last_sold)}</td><td>${num(r.predicted)}</td></tr>`).join("") || '<tr class="table__empty"><td colspan="3">No sales yet to predict from</td></tr>';
    $("#cash-total").textContent = money(c.total); $("#cash-initial").textContent = num2(c.initial); $("#cash-sales").textContent = num2(c.cash_sales);
    $("#cash-ewallet").textContent = num2(c.ewallet_sales); $("#cash-remitted").textContent = num2(c.remitted); $("#cash-total-row").innerHTML = `<strong>${num2(c.total)}</strong>`;
    const s = data.sellers, nTop = openTop ? 10 : 5, nLow = openLow ? 10 : 5;
    bars(s.top_snacks.slice(0, nTop), "#chart-top-snacks"); bars(s.top_meals.slice(0, nTop), "#chart-top-meals");
    bars(s.low_snacks.slice(0, nLow), "#chart-low-snacks"); bars(s.low_meals.slice(0, nLow), "#chart-low-meals");
    line(data.weekly);
    const sba = $("#sales-by-aux");
    if (sba && data.sales_by_aux) { const max = Math.max(1, ...data.sales_by_aux.map((a) => +a.total)); sba.innerHTML = data.sales_by_aux.map((a) => `<div class="rows__item"><dt>${esc(a.name)}</dt><dd>${money(a.total)}</dd></div><meter min="0" max="${max}" value="${a.total}" style="width:100%"></meter>`).join(""); }
  }
  const num2 = (n) => Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  async function load() {
    try {
      data = await api("/api/dashboard" + query({ aux: admin ? $("#filter-aux").value : "", date: $("#filter-date").value }));
      draw();
    } catch (e) { UI.toast(isOffline(e) ? "You are offline — the dashboard needs the server." : e.message); }
  }

  if (admin) {
    const auxes = await api("/api/auxiliaries");
    UI.options($("#filter-aux"), auxes, "aux_id", "name");
    $("#filter-aux").addEventListener("change", load);
  }
  $("#filter-date").addEventListener("change", load);
  const links = UI.$$(".link-button");                      // See all → : predicted table, top sellers, low sellers
  if (links[0]) links[0].addEventListener("click", () => { openPred = !openPred; links[0].textContent = openPred ? "Show less" : "See all →"; draw(); });
  if (links[1]) links[1].addEventListener("click", () => { openTop = !openTop; links[1].textContent = openTop ? "Show less" : "See all →"; draw(); });
  if (links[2]) links[2].addEventListener("click", () => { openLow = !openLow; links[2].textContent = openLow ? "Show less" : "See all →"; draw(); });
  load();
});
