/* ==========================================================================
   MedTech — pages/redefinir-senha.js  (redefinir-senha.html)
   O formulário só aparece quando:
   - o usuário chegou pelo link de recuperação (evento PASSWORD_RECOVERY), e
   - a sessão criada pelo link é confirmada pelo servidor.
   A nova senha é salva com supabase.auth.updateUser() (via Auth).
   ========================================================================== */

(function () {
  const form = document.getElementById("reset-form");
  const message = document.getElementById("form-message");
  const button = document.getElementById("submit-button");
  const password = document.getElementById("password");
  const strength = document.getElementById("password-strength");

  function show(state) {
    document.getElementById("state-checking").classList.toggle("hidden", state !== "checking");
    document.getElementById("state-invalid").classList.toggle("hidden", state !== "invalid");
    document.getElementById("state-success").classList.toggle("hidden", state !== "success");
    form.classList.toggle("hidden", state !== "form");
  }

  function showInvalid(title, text) {
    UI.showAlert(document.getElementById("invalid-message"), "danger", title, text);
    show("invalid");
  }

  async function start() {
    if (!SupabaseConfig.isConfigured()) {
      showInvalid("Supabase ainda não configurado", "Preencha a chave publicável em js/supabase-config.js.");
      return;
    }

    try {
      const check = await Auth.checkRecoverySession();
      if (check.ok) {
        document.getElementById("account-email").value = check.user.email || "";
        show("form");
        password.focus();
        return;
      }
      if (check.params.error) {
        const info = Auth.describeError({ code: check.params.errorCode, message: check.params.errorDescription });
        showInvalid(info.title, info.message);
        return;
      }
      showInvalid("Link de recuperação necessário",
        "Abra esta página pelo link enviado para o seu e-mail. Se o link expirou, peça um novo.");
    } catch (error) {
      const info = Auth.describeError(error);
      showInvalid(info.title, info.message);
    }
  }

  password.addEventListener("input", function () {
    strength.setAttribute("data-level", String(Validation.passwordStrength(password.value)));
  });

  Validation.bindForm(form, {
    "password": [Validation.rules.password()],
    "password-confirm": [Validation.rules.matches("password")]
  }, async function (values) {
    UI.clearAlert(message);
    UI.setButtonLoading(button, true);

    const result = await Auth.updatePassword(values.password);
    UI.setButtonLoading(button, false);

    if (result.error) {
      const info = Auth.describeError(result.error);
      UI.showAlert(message, "danger", info.title, info.message);
      return;
    }

    // Senha alterada e confirmada pelo Supabase
    Auth.setRecoveryFlag(false);
    form.reset();
    const success = document.getElementById("success-message");
    UI.showAlert(success, "success", "Senha alterada com sucesso",
      "Use a nova senha nos próximos acessos.");
    show("success");
    success.focus();
  });

  start();
})();
