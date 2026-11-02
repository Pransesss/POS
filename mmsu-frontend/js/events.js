/* events.js — admin: no classes, exams, campus events. */
document.addEventListener("DOMContentLoaded", () => {
  const { $, esc } = UI, label = { no_classes: "No classes / ADM", exam: "Exam", event: "Campus event", other: "Other" };
  async function load() {
    try {
      const rows = await api("/api/events");
      $("#table-events tbody").innerHTML = rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${label[r.event_type]}</td><td>${UI.mdy(r.event_date)}</td><td>${esc(r.notes || "")}</td><td><button class="link-button delete-action" data-del="${r.event_id}" type="button" aria-label="Delete event" data-delete-tooltip="Delete event"><svg class="delete-action__icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M9 3h6l1 2h5v2H3V5h5zm-3 6h12l-1 12H7zm3 2v8h2v-8zm4 0v8h2v-8z"/></svg></button></td></tr>`).join("") || '<tr class="table__empty"><td colspan="5">No events yet</td></tr>';
    } catch (e) { UI.toast(e.message); }
  }
  $("#form-event").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/events", { method: "POST", body: { date: $("#event-date").value, type: $("#event-type").value, name: $("#event-name").value, notes: $("#event-notes").value } });
      $("#event-name").value = ""; $("#event-notes").value = ""; UI.toast("Event added"); load();
    } catch (err) { UI.toast(err.message); }
  });
  $("#table-events").addEventListener("click", async (e) => {
    const button = e.target.closest("[data-del]");
    if (!button) return;
    try { await api("/api/events/" + button.dataset.del, { method: "DELETE" }); load(); }
    catch (err) { UI.toast(err.message); }
  });
  load();
});
