/* ==========================================================================
   MedTech — pages/perfil.js  (perfil.html)
   Mostra os dados da conta logada. Auth.ready só é resolvida depois que
   auth.js confirma a sessão no servidor.
   ========================================================================== */

(function () {
  function formatOrDash(value) {
    return value ? UI.formatDateTime(new Date(value)) : "—";
  }

  Auth.ready.then(function (user) {
    const name = Auth.displayName(user);

    // textContent: dados do usuário nunca são interpretados como HTML
    document.getElementById("profile-name").textContent = name;
    document.getElementById("profile-email").textContent = user.email || "—";
    document.getElementById("profile-confirmed").textContent = formatOrDash(user.email_confirmed_at);
    document.getElementById("profile-created").textContent = formatOrDash(user.created_at);
    document.getElementById("profile-last-sign-in").textContent = formatOrDash(user.last_sign_in_at);
    document.getElementById("profile-avatar").textContent = document.getElementById("sidebar-avatar").textContent;
  });

  document.getElementById("profile-logout").addEventListener("click", function () {
    UI.handlers.logout();
  });
})();
