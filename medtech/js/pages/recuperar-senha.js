/* ==========================================================================
   MedTech — pages/recuperar-senha.js  (recuperar-senha.html)
   Pede o link com supabase.auth.resetPasswordForEmail() (via Auth).
   O link volta para redefinir-senha.html. A mensagem de sucesso é sempre
   a mesma, para não revelar quais e-mails têm conta.
   ========================================================================== */

(function () {
  const form = document.getElementById("recover-form");
  const message = document.getElementById("form-message");
  const button = document.getElementById("submit-button");
  const LABEL = "Enviar link de recuperação";

  if (!SupabaseConfig.isConfigured()) {
    UI.showAlert(document.getElementById("config-notice"), "warning",
      "Supabase ainda não configurado",
      "Preencha a chave publicável em js/supabase-config.js para ativar a recuperação de senha.");
  }

  const remaining = Auth.cooldown.remaining("recuperacao");
  if (remaining > 0) UI.startCountdown(button, remaining, LABEL);

  Validation.bindForm(form, {
    email: [Validation.rules.email()]
  }, async function (values) {
    UI.clearAlert(message);
    UI.setButtonLoading(button, true);

    const result = await Auth.requestPasswordReset(values.email);
    UI.setButtonLoading(button, false);

    if (result.error) {
      const info = Auth.describeError(result.error);
      UI.showAlert(message, "danger", info.title, info.message);
      if (result.error.status === 429) {
        Auth.cooldown.start("recuperacao");
        UI.startCountdown(button, Auth.cooldown.remaining("recuperacao"), LABEL);
      }
      return;
    }

    Auth.cooldown.start("recuperacao");
    UI.startCountdown(button, Auth.cooldown.remaining("recuperacao"), LABEL);
    UI.showAlert(message, "success", "Verifique seu e-mail",
      "Se houver uma conta com este endereço, você receberá um link para criar uma nova senha. Confira também a pasta de spam.");
  });
})();
