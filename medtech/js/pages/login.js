/* ==========================================================================
   MedTech — pages/login.js  (index.html)
   Login com supabase.auth.signInWithPassword() (via Auth.signIn).
   ========================================================================== */

(function () {
  const form = document.getElementById("login-form");
  const message = document.getElementById("form-message");
  const button = document.getElementById("submit-button");

  // Mensagens vindas de outras páginas (apenas texto informativo,
  // nunca usadas para decidir se o usuário está logado)
  const REASONS = {
    sessao: ["info", "Entre para continuar", "Sua sessão não foi encontrada ou expirou."],
    saiu: ["success", "Você saiu da sua conta", "Até logo!"],
    confirmacao: ["warning", "E-mail ainda não confirmado", "Confirme seu e-mail antes de acessar o painel."],
    "senha-alterada": ["success", "Senha alterada", "Entre com a sua nova senha."]
  };
  const reason = REASONS[new URLSearchParams(window.location.search).get("motivo")];
  if (reason) UI.showAlert(message, reason[0], reason[1], reason[2]);

  if (!SupabaseConfig.isConfigured()) {
    UI.showAlert(document.getElementById("config-notice"), "warning",
      "Supabase ainda não configurado",
      "Preencha a chave publicável em js/supabase-config.js para ativar o login.");
  } else {
    Auth.redirectIfLoggedIn();
  }

  Validation.bindForm(form, {
    email: [Validation.rules.email()],
    password: [Validation.rules.required("Informe sua senha.")]
  }, async function (values) {
    UI.clearAlert(message);
    UI.setButtonLoading(button, true);

    const result = await Auth.signIn(values.email, values.password);

    if (result.error) {
      UI.setButtonLoading(button, false);
      const info = Auth.describeError(result.error);

      if (result.error.code === "email_not_confirmed" || info.title === "E-mail ainda não confirmado") {
        Auth.setPendingEmail(values.email);
        UI.showAlert(message, "warning", info.title, info.message,
          { href: "confirmacao.html", label: "Reenviar e-mail de confirmação" });
      } else {
        UI.showAlert(message, "danger", info.title, info.message);
      }

      // Por segurança, limpa a senha depois de uma tentativa falha
      document.getElementById("password").value = "";
      return;
    }

    // Sucesso confirmado pelo Supabase: segue para o painel
    UI.showAlert(message, "success", "Login realizado", "Abrindo o painel…");
    window.location.replace(Auth.returnTarget());
  });
})();
