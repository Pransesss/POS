/* Prediction page — staff/admin choose a date and items to predict. */
document.addEventListener("DOMContentLoaded", () => {
  const { $, $$, esc, num } = UI;
  let kind = "snacks", items = [], picked = new Set(), last = null;
  const COLS = ["item", "prediction_for", "predicted_qty", "last_3school_day_avg", "exam_day", "event_day", "method"];   // = Section 7 of the notebook

  const dateInput = $("#fc-date");
  const auxSelect = $("#fc-aux");
  const isWeekend = (iso) => { const d = new Date(iso + "T00:00:00").getDay(); return d === 0 || d === 6; };
  const displayItem = (item) => item === "Chicken @99" ? "Chicken" : item;
  const err = (msg) => { const b = $("#fc-error"); b.hidden = !msg; b.textContent = msg || ""; };

  function checkDate() {
    const v = dateInput.value;
    $("#fc-date-hint").textContent = v && isWeekend(v) ? "That is a weekend. Pick a Monday to Friday." : "";
    return !!v && !isWeekend(v);
  }

  function drawItems() {
    const term = $("#fc-search").value.trim().toLowerCase();
    const list = items.filter((i) => i.item.toLowerCase().includes(term));
    $("#fc-items").innerHTML = list.map((i) => {
      const tip = `${i.days_recorded} days recorded, usually ${num(i.avg_qty)} sold, last on the menu ${UI.mdy(i.last_date)}${i.modeled ? "" : " (too few records for the LSTM: average used)"}`;
      return `<label class="chip-toggle" title="${esc(tip)}"><input type="checkbox" value="${esc(i.item)}" ${picked.has(i.item) ? "checked" : ""}><span class="chip">${esc(UI.titleCase(displayItem(i.item)))}</span></label>`;
    }).join("") || `<p class="muted text-small">${items.length ? "No item matches your search." : "No history for this canteen yet."}</p>`;
  }

  async function loadItems() {
    err(""); picked = new Set(); $("#fc-result").hidden = true;
    if (auxSelect && !auxSelect.value) {
      items = [];
      $("#fc-items").innerHTML = "";
      return;
    }
    $("#fc-items").innerHTML = '<div class="loading-dots" role="status" aria-label="Loading items"><span></span><span></span><span></span></div>';
    try {
      const d = await api("/api/prediction/items" + query({ kind, aux: auxSelect ? auxSelect.value : undefined }));
      items = d.items;
      if (!dateInput.dataset.touched) dateInput.value = d.default_date;
      checkDate();
      drawItems();
    } catch (e) {
      $("#fc-items").innerHTML = "";
      err(isOffline(e) ? "No connection to the server. Predictions need an internet connection." : e.message);
    }
  }

  const noteHtml = (cls, text) => `<div class="banner ${cls}">${esc(text)}</div>`;

  function drawResult(res, date) {
    last = res;
    const info = res.info, rows = res.rows, withActual = res.has_actual;
    $("#fc-title").textContent = `${auxSelect ? `${res.aux} · ` : ""}Prediction for ${new Date(date + "T00:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}`;
    let notes = "";
    if (info.no_classes) notes += noteHtml("banner--info", `No classes that day (${info.event.filter((e) => e.event_type === "no_classes").map((e) => e.name).join(", ")}). Demand forecast is still shown.`);
    else info.event.forEach((e) => { notes += noteHtml("banner--info", `${e.event_type === "exam" ? "Exam day" : "Event"}: ${e.name} — the model accounts for it.`); });
    $("#fc-notes").innerHTML = notes;
    $("#fc-total").textContent = num(res.total_predicted);
    $("#fc-unit").textContent = kind === "meals" ? "servings in total" : "pieces in total";
    const head = ["Item", "Predicted qty", "Last 3 on-menu days avg", "Exam day", "Event day", "Method"].concat(withActual ? ["Actual sold"] : []);
    $("#fc-table thead").innerHTML = `<tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr>`;
    $("#fc-table tbody").innerHTML = res.rows.map((r) => `<tr><td>${esc(UI.titleCase(displayItem(r.item)))}</td><td><strong>${num(r.predicted_qty)}</strong></td><td>${r.last_3school_day_avg ?? "—"}</td><td>${r.exam_day ? "Yes" : "—"}</td><td>${r.event_day ? "Yes" : "—"}</td><td class="${r.method === "LSTM" || r.method.startsWith("no classes") ? "" : "muted"}">${esc(r.method)}</td>${withActual ? `<td>${r.actual_qty == null ? "not on menu" : num(r.actual_qty)}</td>` : ""}</tr>`).join("");
    $("#fc-result").hidden = false;
    $("#fc-result").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function run() {
    err("");
    if (!checkDate()) { err("Choose a weekday (Monday to Friday) for the prediction."); return; }
    if (auxSelect && !auxSelect.value) { err("Choose an auxiliary first."); return; }
    if (!picked.size) { err("Tick at least one item first."); return; }
    const btn = $("#fc-run"); btn.disabled = true; btn.textContent = "Predicting…";
    const date = dateInput.value;
    try {
      const res = await api("/api/prediction/run", { method: "POST", body: { kind, date, items: [...picked], ...(auxSelect ? { aux: auxSelect.value } : {}) } });
      drawResult(res, date);
    } catch (e) {
      err(isOffline(e) ? "No connection to the server. Predictions need an internet connection." : e.message);
    } finally { btn.disabled = false; btn.textContent = "Predict"; }
  }

  function csv() {
    if (!last) return;
    const cols = COLS.concat(last.has_actual ? ["actual_qty"] : []);
    const cell = (v) => { v = v == null ? "" : String(v); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
    const text = [cols.join(",")].concat(last.rows.map((r) => cols.map((c) => cell(c === "item" ? displayItem(r[c]) : r[c])).join(","))).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
    a.download = `${kind}_prediction_${last.aux}_${last.rows[0] ? last.rows[0].prediction_for : ""}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
  }

  // events
  dateInput.addEventListener("change", () => { dateInput.dataset.touched = "1"; checkDate(); });
  if (auxSelect) auxSelect.addEventListener("change", loadItems);
  $$("input[name=fc-kind]").forEach((r) => r.addEventListener("change", () => { kind = r.value; loadItems(); }));
  $("#fc-search").addEventListener("input", drawItems);
  $("#fc-items").addEventListener("change", (e) => { const b = e.target.closest("input[type=checkbox]"); if (!b) return; b.checked ? picked.add(b.value) : picked.delete(b.value); });
  $("#fc-all").addEventListener("click", () => { const t = $("#fc-search").value.trim().toLowerCase(); items.filter((i) => i.item.toLowerCase().includes(t)).forEach((i) => picked.add(i.item)); drawItems(); });
  $("#fc-none").addEventListener("click", () => { picked.clear(); drawItems(); });
  $("#fc-recent").addEventListener("click", () => { picked = new Set(items.filter((i) => i.recent).map((i) => i.item)); drawItems(); });
  $("#fc-run").addEventListener("click", run);
  $("#fc-csv").addEventListener("click", csv);

  async function initialize() {
    if (auxSelect) {
      try {
        const auxiliaries = (await api("/api/auxiliaries")).filter((a) => a.is_active);
        UI.options(auxSelect, auxiliaries, "aux_id", "name");
        if (!auxiliaries.length) {
          err("No active auxiliaries are available.");
          $("#fc-items").innerHTML = "";
          return;
        }
        auxSelect.value = String(auxiliaries[0].aux_id);
      } catch (e) {
        err(isOffline(e) ? "No connection to the server. Predictions need an internet connection." : e.message);
        $("#fc-items").innerHTML = "";
        return;
      }
    }
    loadItems();
  }
  initialize();
});
