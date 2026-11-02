/* login.js — sign-in page */
document.addEventListener("DOMContentLoaded", () => {
  const form = UI.$("#form-login"), error = UI.$("#login-error");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.textContent = "";
    try {
      const data = await api("/api/auth/login", { method: "POST", body: { username: UI.$("#username").value, password: UI.$("#password").value } });
      saveSession(data);
      location.href = data.user.role === "admin" ? "admin/dashboard.html" : "staff/dashboard.html";
    } catch (err) {
      error.textContent = isOffline(err) ? "Cannot reach the server. Sign in once while online." : err.message;
    }
  });
});
