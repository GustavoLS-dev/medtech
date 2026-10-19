/* ==========================================================================
   MedTech — pages/cadastro.js  (cadastro.html)
   Cadastro com supabase.auth.signUp() (via Auth.signUp). O link de
   confirmação enviado por e-mail volta para confirmacao.html.
   ========================================================================== */

(function () {
  const form = document.getElementById("signup-form");
  const message = document.getElementById("form-message");
  const button = document.getElementById("submit-button");
  const password = document.getElementById("password");
  const strength = document.getElementById("password-strength");

  if (!SupabaseConfig.isConfigured()) {
    UI.showAlert(document.getElementById("config-notice"), "warning",
      "Supabase ainda não configurado",
      "Preencha a chave publicável em js/supabase-config.js para ativar o cadastro.");
  } else {
    Auth.redirectIfLoggedIn();
  }

  password.addEventListener("input", function () {
    strength.setAttribute("data-level", String(Validation.passwordStrength(password.value)));
  });

  Validation.bindForm(form, {
    "full-name": [Validation.rules.fullName()],
    "email": [Validation.rules.email()],
    "password": [Validation.rules.password()],
    "password-confirm": [Validation.rules.matches("password")]
  }, async function (values) {
    UI.clearAlert(message);
    UI.setButtonLoading(button, true);

    const result = await Auth.signUp(values["full-name"], values.email, values.password);
    UI.setButtonLoading(button, false);

    if (result.error) {
      const info = Auth.describeError(result.error);
      const alreadyExists = result.error.code === "user_already_exists" || result.error.code === "email_exists";
      UI.showAlert(message, "danger", info.title, info.message,
        alreadyExists ? { href: "recuperar-senha.html", label: "Recuperar senha" } : null);
      return;
    }

    if (result.data.session) {
      // O Supabase só devolve sessão no cadastro quando a confirmação de
      // e-mail está DESATIVADA no projeto. Encerramos a sessão e avisamos.
      await SupabaseConfig.getClient().auth.signOut({ scope: "local" });
      UI.showAlert(message, "warning", "Confirmação de e-mail desativada no projeto",
        "A conta foi criada sem verificação de e-mail. Ative \"Confirm email\" no painel do Supabase (Authentication → Sign In / Providers → Email).");
      return;
    }

    // Cadastro aceito pelo Supabase: o e-mail de confirmação foi solicitado
    Auth.setPendingEmail(values.email);
    Auth.cooldown.start("confirmacao");
    form.reset();
    window.location.href = "confirmacao.html";
  });
})();
