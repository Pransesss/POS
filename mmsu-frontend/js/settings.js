/* settings.js — admin: manage accounts (admin password required) and add auxiliaries. Passwords are never shown. */
document.addEventListener("DOMContentLoaded", () => {
  const { $, esc } = UI;
  const MAX_LOGO_SIZE = 2_000_000;
  let accounts = [], chosen = null, chosenAux = null, predictionProducts = [];

  ["aux-logo", "account-logo"].forEach((id) => {
    const input = $("#" + id), filename = $("#" + id + "-name");
    input.addEventListener("change", () => {
      const file = input.files[0];
      if (file && file.size > MAX_LOGO_SIZE) {
        input.value = "";
        filename.textContent = "No file chosen";
        UI.toast("Logo file must be 2 MB or smaller");
        return;
      }
      filename.textContent = file?.name || "No file chosen";
    });
  });

  UI.$$("[data-settings-tab]").forEach((tab) => tab.addEventListener("click", () => {
    const name = tab.dataset.settingsTab;
    UI.$$("[data-settings-tab]").forEach((t) => t.classList.toggle("is-active", t === tab));
    $("#settings-auxiliary").hidden = name !== "auxiliary";
    $("#settings-accounts").hidden = name !== "accounts";
    $("#settings-prediction").hidden = name !== "prediction";
  }));

  async function loadPredictionProducts() {
    predictionProducts = await api("/api/prediction-products");
    drawPredictionProducts();
  }
  function filteredPredictionProducts() {
    const search = $("#prediction-search").value.trim().toLocaleLowerCase();
    const category = $("#prediction-category").value;
    const status = $("#prediction-status").value;
    return predictionProducts.filter((p) =>
      (!search || p.name.toLocaleLowerCase().includes(search)) &&
      (!category || p.category === category) &&
      (!status || (p.use_for_prediction ? "included" : "excluded") === status));
  }
  function drawPredictionProducts() {
    const rows = filteredPredictionProducts();
    $("#table-prediction-products tbody").innerHTML = rows.map((p) => `<tr><td>${esc(UI.titleCase(p.name))}</td><td>${esc(p.category)}</td><td><label class="chip-toggle"><input type="checkbox" data-prediction-id="${p.product_id}" ${p.use_for_prediction ? "checked" : ""}><span class="chip">${p.use_for_prediction ? "Included" : "Excluded"}</span></label></td></tr>`).join("") || '<tr class="table__empty"><td colspan="3">No matching products</td></tr>';
    const bulkToggle = $("#prediction-include-filtered");
    bulkToggle.checked = rows.length > 0 && rows.every((p) => p.use_for_prediction);
  }
  async function setFilteredPrediction(included) {
    const product_ids = filteredPredictionProducts().map((p) => p.product_id);
    if (!product_ids.length) {
      $("#prediction-include-filtered").checked = false;
      return UI.toast("No matching products to update");
    }
    const bulkToggle = $("#prediction-include-filtered");
    bulkToggle.disabled = true;
    let updated = 0;
    try {
      for (const product_id of product_ids) {
        await api(`/api/products/${product_id}/prediction`, { method: "PATCH", body: { use_for_prediction: included } });
        updated++;
      }
      await loadPredictionProducts();
      UI.toast(`${updated} products ${included ? "included" : "excluded"}`);
    } catch (err) {
      let refreshError = null;
      try { await loadPredictionProducts(); } catch (e) { refreshError = e; }
      const message = updated ? `${updated} products updated before an error: ${err.message}` : err.message;
      UI.toast(refreshError ? `${message}. Could not refresh the list: ${refreshError.message}` : message);
    } finally {
      bulkToggle.disabled = false;
    }
  }
  $("#table-prediction-products").addEventListener("change", async (e) => {
    const box = e.target.closest("[data-prediction-id]"); if (!box) return;
    try {
      await api(`/api/products/${box.dataset.predictionId}/prediction`, { method: "PATCH", body: { use_for_prediction: box.checked } });
      await loadPredictionProducts();
    } catch (err) { box.checked = !box.checked; UI.toast(err.message); }
  });
  $("#prediction-search").addEventListener("input", drawPredictionProducts);
  $("#prediction-category").addEventListener("change", drawPredictionProducts);
  $("#prediction-status").addEventListener("change", drawPredictionProducts);
  $("#prediction-include-filtered").addEventListener("change", (e) => setFilteredPrediction(e.target.checked));

  async function loadAccounts() {
    accounts = await api("/api/accounts");
    $("#table-accounts tbody").innerHTML = accounts.map((a) => `<tr class="is-clickable ${chosen && chosen.account_id === a.account_id ? "is-selected" : ""}" data-id="${a.account_id}"><td>${esc(a.username)}${a.aux_name ? " — " + esc(a.aux_name) : ""}</td><td>${a.role === "admin" ? "Admin" : "Staff"}</td></tr>`).join("");
  }
  $("#table-accounts").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-id]"); if (!tr) return;
    chosen = accounts.find((a) => String(a.account_id) === tr.dataset.id);
    $("#account-name").textContent = chosen.username + (chosen.aux_name ? " — " + chosen.aux_name : "");
    $("#account-logo").value = "";
    $("#account-logo-name").textContent = "No file chosen";
    loadAccounts();
  });
  $("#form-account").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!chosen) return UI.toast("Select an account first");
    try {
      const newUsername = $("#new-username").value.trim();
      const newPassword = $("#new-password").value;
      const confirmPassword = $("#confirm-password").value;
      const adminPassword = $("#admin-password").value;
      const file = $("#account-logo").files[0];

      // Username/password changes require the admin password. A logo-only
      // change should skip the account PATCH, otherwise the backend returns
      // "Nothing to change" before the logo upload can happen.
      if (newUsername || newPassword) {
        if (!adminPassword) return UI.toast("Enter the admin password for username/password changes");
        await api("/api/accounts/" + chosen.account_id, {
          method: "PATCH",
          body: { new_username: newUsername, new_password: newPassword, confirm_password: confirmPassword, admin_password: adminPassword }
        });
      } else if (!file) {
        return UI.toast("Choose a logo or enter an account change");
      }
      if (file) {
        const fd = new FormData(); fd.append("file", file);
        const logo = await api(`/api/accounts/${chosen.account_id}/logo`, { method: "POST", body: fd });
        if (chosen.role === "admin") {
          const session = UI.session();
          if (session && session.user.account_id === chosen.account_id) {
            session.user.logo_path = logo.logo_path;
            localStorage.setItem("session", JSON.stringify(session));
          }
        }
      }
      ["new-username", "new-password", "confirm-password", "admin-password", "account-logo"].forEach((i) => { if ($( "#" + i)) $("#" + i).value = ""; });
      $("#account-logo-name").textContent = "No file chosen";
      UI.toast(file ? "Account and logo updated" : "Account updated"); loadAccounts();
      if (file && chosen.role === "admin") location.reload();
    } catch (err) { UI.toast(err.message); }
  });
  /* auxiliaries: add a new outlet + its staff login (+ optional PNG/JPG logo) */
  async function loadAux() {
    const rows = await api("/api/auxiliaries");
    $("#table-aux tbody").innerHTML = rows.map((a) => `<tr class="is-clickable ${chosenAux && chosenAux.aux_id === a.aux_id ? "is-selected" : ""}" data-aux-id="${a.aux_id}"><td>${esc(a.name)}</td><td>${esc(a.code)}</td><td class="aux-delete-cell"><button class="btn btn--ghost delete-action delete-action--icon" type="button" data-delete-aux aria-label="Delete ${esc(a.name)}" data-delete-tooltip="Delete auxiliary"><svg class="delete-action__icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M9 3h6l1 2h5v2H3V5h5zm-3 6h12l-1 12H7zm3 2v8h2v-8zm4 0v8h2v-8z"/></svg></button></td></tr>`).join("") || '<tr class="table__empty"><td colspan="3">No active auxiliaries</td></tr>';
  }
  function deleteAuxiliary() {
    if (!chosenAux) return UI.toast("Select an auxiliary first");
    UI.modal(`<h2 class="card__title">Delete ${esc(chosenAux.name)}?</h2><p>This will deactivate the auxiliary, its staff account, and its inventory. Historical records will be kept.</p><label for="delete-aux-password">Admin password</label><input type="password" id="delete-aux-password" autocomplete="current-password"><div class="modal__actions"><button class="btn" data-close type="button">Cancel</button><button class="btn btn--danger delete-action" id="confirm-delete-aux" type="button" aria-label="Delete auxiliary" data-delete-tooltip="Delete auxiliary"><svg class="delete-action__icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M9 3h6l1 2h5v2H3V5h5zm-3 6h12l-1 12H7zm3 2v8h2v-8zm4 0v8h2v-8z"/></svg></button></div>`);
    setTimeout(() => $("#confirm-delete-aux")?.addEventListener("click", async () => {
      try {
        const password = $("#delete-aux-password").value;
        if (!password) return UI.toast("Enter the admin password");
        await api(`/api/auxiliaries/${chosenAux.aux_id}/delete`, { method: "POST", body: { admin_password: password } });
        chosenAux = null;
        UI.toast("Auxiliary deleted");
        loadAux(); loadAccounts();
        $("#delete-aux-password").value = "";
        $("[data-close]")?.click();
      } catch (err) { UI.toast(err.message); }
    }), 0);
  }
  $("#table-aux").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-aux-id]"); if (!tr) return;
    chosenAux = { aux_id: Number(tr.dataset.auxId), name: tr.children[0].textContent, code: tr.children[1].textContent };
    if (e.target.closest("[data-delete-aux]")) {
      deleteAuxiliary();
      return;
    }
    loadAux();
  });
  $("#form-aux").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const r = await api("/api/auxiliaries", { method: "POST", body: { name: $("#aux-name").value, code: $("#aux-code").value, username: $("#aux-username").value, password: $("#aux-password").value } });
      const file = $("#aux-logo").files[0];
      if (file) { const fd = new FormData(); fd.append("file", file); await api(`/api/auxiliaries/${r.aux_id}/logo`, { method: "POST", body: fd }); }
      e.target.reset();
      $("#aux-logo-name").textContent = "No file chosen";
      UI.toast("Auxiliary added"); loadAux(); loadAccounts();
    } catch (err) { UI.toast(err.message); }
  });
  loadAccounts(); loadAux(); loadPredictionProducts();
});
