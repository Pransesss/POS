/* dashboard.js — staff dashboard (own outlet) and admin dashboard (all outlets or one). */
document.addEventListener("DOMContentLoaded", async () => {
  const { $, esc, money, num } = UI, admin = UI.session().user.role === "admin";
  let data = null, openPred = false, openTop = false, openLow = false;

  /* Compact SVG charts styled with the dashboard's green theme. */
  const bars = (rows, id) => {
    const el = $(id), max = Math.max(1, ...rows.map((r) => +r.qty));
    if (!rows.length) { el.textContent = "No sales yet"; return; }
    const w = 300 / rows.length, gradientId = `${id.slice(1)}-bar-gradient`;
    const gradient = id.includes("low") ? ["#d9a64a", "#8c6330"] : ["#a2efaf", "#478a56"];
    el.innerHTML = `<svg class="chart__svg" viewBox="0 0 300 150" role="img" aria-label="${esc(el.getAttribute("aria-label") || "Sales chart")}">
      <defs><linearGradient id="${gradientId}" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="${gradient[0]}"/><stop offset="100%" stop-color="${gradient[1]}"/></linearGradient></defs>
      ${[25, 50, 75, 100].map((y) => `<line class="chart__grid" x1="4" y1="${y}" x2="296" y2="${y}"/>`).join("")}
      ${rows.map((r, i) => {
        const h = Math.max(3, Math.round((r.qty / max) * 78)), x = i * w + 4, barW = Math.max(8, w - 8), cx = x + barW / 2;
        const name = UI.titleCase(r.name), label = name.length > 12 ? name.slice(0, 11) + "…" : name;
        return `<g><title>${esc(name)}: ${num(r.qty)}</title><rect class="chart__bar" x="${x}" y="${105 - h}" width="${barW}" height="${h}" rx="4" fill="url(#${gradientId})"/><text class="chart__value" x="${cx}" y="${99 - h}" text-anchor="middle">${num(r.qty)}</text><text class="chart__label" x="${cx}" y="126" text-anchor="middle">${esc(label)}</text></g>`;
      }).join("")}</svg>`;
  };
  const line = (rows) => {
    const el = $("#chart-weekly");
    if (!rows.length) { el.textContent = "No sales yet"; return; }
    const max = Math.max(1, ...rows.map((r) => +r.total));
    const pts = rows.map((r, i) => [20 + i * (260 / Math.max(1, rows.length - 1)), 18 + (1 - r.total / max) * 76]);
    const curve = pts.reduce((path, point, i) => {
      if (!i) return `M ${point[0]} ${point[1]}`;
      const prev = pts[i - 1], midX = (prev[0] + point[0]) / 2, midY = (prev[1] + point[1]) / 2;
      return `${path} Q ${prev[0]} ${prev[1]} ${midX} ${midY}`;
    }, "") + ` T ${pts[pts.length - 1][0]} ${pts[pts.length - 1][1]}`;
    const area = `${curve} L ${pts[pts.length - 1][0]} 108 L ${pts[0][0]} 108 Z`;
    el.innerHTML = `<svg class="chart__svg chart__svg--weekly" viewBox="0 0 300 130" role="img" aria-label="Sales by day this week">
      <defs><linearGradient id="weekly-sales-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#8fe3a0" stop-opacity=".24"/><stop offset="100%" stop-color="#8fe3a0" stop-opacity="0"/></linearGradient></defs>
      ${[25, 50, 75, 100].map((y) => `<line class="chart__grid" x1="8" y1="${y}" x2="292" y2="${y}"/>`).join("")}
      <path d="${area}" fill="url(#weekly-sales-fill)"/><path class="chart__line" d="${curve}"/>
      ${pts.map((p, i) => `<g><title>${new Date(rows[i].date + "T00:00:00").toLocaleDateString("en-US", { weekday: "long" })}: ${money(rows[i].total)}</title><circle class="chart__point-halo" cx="${p[0]}" cy="${p[1]}" r="6"/><circle class="chart__point" cx="${p[0]}" cy="${p[1]}" r="3.5"/><text class="chart__label" x="${p[0]}" y="122" text-anchor="middle">${new Date(rows[i].date + "T00:00:00").toLocaleDateString("en-US", { weekday: "short" })}</text></g>`).join("")}</svg>`;
  };

  function draw() {
    const prediction = data.prediction, c = data.cash;
    $("#kpi-predicted").textContent = num(prediction.total_predicted);
    $("#kpi-lowout").textContent = data.lowout.total;
    const ev = data.event_tomorrow, be = $("#banner-event");
    be.hidden = !ev;
    if (ev) { const t = { no_classes: "No classes / ADM", exam: "Exam", event: "Event", other: "Other" }[ev.event_type]; be.textContent = `Tomorrow: ${ev.name} (${t})${ev.event_type === "no_classes" ? " — demand forecast still shown" : " — prediction adjusted"}`; }
    const bd = $("#banner-delivery");
    if (bd) { bd.hidden = !data.pending_deliveries; bd.textContent = `${data.pending_deliveries} delivery waiting for you to check and accept →`; }
    const rows = openPred ? prediction.items : prediction.items.slice(0, 5);
    $("#table-predicted tbody").innerHTML = rows.map((r) => `<tr><td>${esc(UI.titleCase(r.name))}</td><td>${num(r.last_sold)}</td><td>${num(r.predicted)}</td></tr>`).join("") || '<tr class="table__empty"><td colspan="3">No sales yet to predict from</td></tr>';
    $("#cash-total").textContent = money(c.total); $("#cash-initial").textContent = num2(c.initial); $("#cash-sales").textContent = num2(c.cash_sales);
    $("#cash-ewallet").textContent = num2(c.ewallet_sales); $("#cash-remitted").textContent = num2(c.remitted); $("#cash-total-row").innerHTML = `<strong>${num2(c.total)}</strong>`;
    const s = data.sellers, nTop = openTop ? 10 : 5, nLow = openLow ? 10 : 5;
    bars(s.top_snacks.slice(0, nTop), "#chart-top-snacks"); bars(s.top_meals.slice(0, nTop), "#chart-top-meals");
    bars(s.low_snacks.slice(0, nLow), "#chart-low-snacks"); bars(s.low_meals.slice(0, nLow), "#chart-low-meals");
    line(data.weekly);
    const sba = $("#sales-by-aux");
    if (sba && data.sales_by_aux) {
      const max = Math.max(1, ...data.sales_by_aux.map((a) => +a.total));
      sba.innerHTML = data.sales_by_aux.map((a) => {
        const total = Math.max(0, +a.total);
        const percent = Math.min(100, (total / max) * 100);
        return `<div class="sales-aux__item">
          <div class="sales-aux__heading"><span>${esc(a.name)}</span><strong>${money(total)}</strong></div>
          <div class="sales-aux__track" role="meter" aria-label="Sales for ${esc(a.name)}" aria-valuemin="0" aria-valuemax="${max}" aria-valuenow="${total}">
            <span class="sales-aux__fill" style="width:${percent}%"></span>
          </div>
        </div>`;
      }).join("");
    }
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
  const setLinkState = (link, expanded) => {
    link.querySelector("span").textContent = expanded ? "Show less" : "See all";
    link.classList.toggle("is-expanded", expanded);
  };
  if (links[0]) links[0].addEventListener("click", () => { openPred = !openPred; setLinkState(links[0], openPred); draw(); });
  if (links[1]) links[1].addEventListener("click", () => { openTop = !openTop; setLinkState(links[1], openTop); draw(); });
  if (links[2]) links[2].addEventListener("click", () => { openLow = !openLow; setLinkState(links[2], openLow); draw(); });
  load();
});
