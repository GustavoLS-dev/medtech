/* ==========================================================================
   MedTech — pages/confirmacao.js  (confirmacao.html)
   Dois usos:
   1. Depois do cadastro: orienta o usuário e permite reenviar o e-mail.
   2. Ao voltar pelo link do e-mail: confere NO SERVIDOR se a conta foi
      confirmada. Parâmetros da URL não bastam como prova.
   ========================================================================== */

(function () {
  // Lido antes de qualquer uso do cliente (a biblioteca limpa o "#..." da URL)
  const params = Auth.readAuthParams();

  const states = ["checking", "confirmed", "error", "pending"];
  const resendForm = document.getElementById("resend-form");
  const resendButton = document.getElementById("resend-button");
  const resendMessage = document.getElementById("resend-message");
  const emailField = document.getElementById("resend-email-field");
  const emailInput = document.getElementById("resend-email");
  const RESEND_LABEL = "Reenviar e-mail de confirmação";

  function show(state, withResend) {
    states.forEach(function (name) {
      document.getElementById("state-" + name).classList.toggle("hidden", name !== state);
    });
    resendForm.classList.toggle("hidden", !withResend);
    const heading = document.querySelector("#state-" + state + " h1[tabindex]");
    if (heading) heading.focus();
  }

  function showPending() {
    const email = Auth.getPendingEmail();
    if (email) {
      document.getElementById("sent-email").textContent = email;
      document.getElementById("pending-text-known").classList.remove("hidden");
      document.getElementById("pending-text-unknown").classList.add("hidden");
      emailInput.value = email;
      emailField.classList.add("hidden"); // já sabemos o e-mail
    }
    show("pending", true);
  }

  function showError(title, text) {
    document.getElementById("error-title").textContent = title;
    document.getElementById("error-text").textContent = text;
    const email = Auth.getPendingEmail();
    if (email) emailInput.value = email;
    show("error", true);
  }

  async function start() {
    if (!SupabaseConfig.isConfigured()) {
      showPending();
      UI.showAlert(resendMessage, "warning", "Supabase ainda não configurado",
        "Preencha a chave publicável em js/supabase-config.js.");
      return;
    }

    // 1) O link voltou com erro (ex.: expirado ou já usado)
    if (params.error) {
      const info = Auth.describeError({ code: params.errorCode, message: params.errorDescription });
      showError(info.title, info.message);
      return;
    }

    // 2) Voltou do link com tokens, ou já existe sessão: conferir no servidor
    if (params.hasTokens || !Auth.getPendingEmail()) {
      show("checking", false);
      try {
        const user = await Auth.getVerifiedUser();
        if (user && Auth.isEmailConfirmed(user)) {
          Auth.clearPendingEmail();
          document.getElementById("confirmed-email").textContent = user.email;
          show("confirmed", false);
          return;
        }
        if (params.hasTokens) {
          showError("Não foi possível confirmar",
            "O servidor não confirmou a sua conta. Peça um novo e-mail de confirmação.");
          return;
        }
      } catch (error) {
        const info = Auth.describeError(error);
        showError(info.title, info.message);
        return;
      }
    }

    // 3) Ainda aguardando o usuário abrir o e-mail
    showPending();
  }

  /* ---------------- Reenvio com controle de frequência ---------------- */
  const remaining = Auth.cooldown.remaining("confirmacao");
  if (remaining > 0) UI.startCountdown(resendButton, remaining, RESEND_LABEL);

  Validation.bindForm(resendForm, {
    "resend-email": [Validation.rules.email()]
  }, async function (values) {
    UI.clearAlert(resendMessage);
    UI.setButtonLoading(resendButton, true);

    const result = await Auth.resendConfirmation(values["resend-email"]);
    UI.setButtonLoading(resendButton, false);

    if (result.error) {
      const info = Auth.describeError(result.error);
      UI.showAlert(resendMessage, "danger", info.title, info.message);
      if (result.error.status === 429) {
        Auth.cooldown.start("confirmacao");
        UI.startCountdown(resendButton, Auth.cooldown.remaining("confirmacao"), RESEND_LABEL);
      }
      return;
    }

    Auth.setPendingEmail(values["resend-email"]);
    Auth.cooldown.start("confirmacao");
    UI.startCountdown(resendButton, Auth.cooldown.remaining("confirmacao"), RESEND_LABEL);
    UI.showAlert(resendMessage, "success", "Pedido de reenvio aceito",
      "Se o e-mail estiver cadastrado e ainda não confirmado, uma nova mensagem será enviada. Verifique também o spam.");
  });

  start();
})();
