/* ==========================================================================
   MedTech — auth.js
   Autenticação com o Supabase Auth:
   - cadastro, login, logout
   - reenvio do e-mail de confirmação
   - recuperação e troca de senha
   - proteção das páginas privadas (<body data-private>)
   - tradução das mensagens de erro para o português

   Segurança:
   - Nenhuma senha é guardada pelo nosso código: quem cuida da sessão é a
     biblioteca oficial do Supabase.
   - Parâmetros da URL nunca são tratados como prova de login. A sessão é
     sempre confirmada pelo cliente Supabase (getSession + getUser, que
     consulta o servidor).

   Depende de: supabase-config.js e ui.js
   ========================================================================== */

/*
 * Endereço em que o site está aberto: http://127.0.0.1:5500 no Live Server,
 * https://<projeto>.vercel.app depois de publicado.
 * Os links enviados por e-mail voltam para cá. Estes endereços precisam
 * estar cadastrados em: Supabase → Authentication → URL Configuration.
 */
const SITE_URL = window.location.origin;

const Auth = (function () {
  const REDIRECTS = {
    confirmacao: SITE_URL + "/confirmacao.html",
    redefinirSenha: SITE_URL + "/redefinir-senha.html"
  };

  // Páginas para onde o login pode devolver o usuário (evita redirecionamentos abertos)
  const PRIVATE_PAGES = ["dashboard.html", "medicamentos.html", "programacao.html",
    "historico.html", "dispositivo.html", "perfil.html"];

  // Intervalo mínimo entre envios de e-mail (o Supabase também impõe o seu)
  const EMAIL_COOLDOWN_SECONDS = 60;

  const PENDING_EMAIL_KEY = "medtech:pending-email";
  const RECOVERY_FLAG_KEY = "medtech:password-recovery";

  // localhost e 127.0.0.1 guardam sessões separadas; as URLs cadastradas usam 127.0.0.1
  if (window.location.hostname === "localhost") {
    console.warn("[MedTech] O site está aberto em " + window.location.origin +
      ". Use http://127.0.0.1:5500, o endereço cadastrado no Supabase.");
  }

  /* ------------------------------------------------------------------ */
  /* Cliente                                                            */
  /* ------------------------------------------------------------------ */
  function requireClient() {
    const client = SupabaseConfig.getClient();
    if (!client) {
      const error = new Error(SupabaseConfig.isLibraryLoaded()
        ? "Preencha a chave publicável em js/supabase-config.js."
        : "A biblioteca do Supabase não carregou. Verifique sua conexão com a internet.");
      error.name = "MedTechConfigError";
      throw error;
    }
    return client;
  }

  /* ------------------------------------------------------------------ */
  /* Mensagens de erro em português                                     */
  /* ------------------------------------------------------------------ */
  const ERROR_MESSAGES = {
    invalid_credentials: ["E-mail ou senha incorretos", "Confira os dados e tente novamente."],
    email_not_confirmed: ["E-mail ainda não confirmado", "Abra o link que enviamos para o seu e-mail antes de entrar."],
    user_already_exists: ["E-mail já cadastrado", "Já existe uma conta com este e-mail. Entre ou recupere sua senha."],
    email_exists: ["E-mail já cadastrado", "Já existe uma conta com este e-mail. Entre ou recupere sua senha."],
    weak_password: ["Senha fraca", "O servidor recusou a senha. Use uma senha mais longa, com letras, números e símbolos."],
    same_password: ["Senha repetida", "A nova senha precisa ser diferente da senha atual."],
    over_email_send_rate_limit: ["Limite de envio de e-mails atingido", "Muitos e-mails foram enviados em pouco tempo. Aguarde alguns minutos e tente novamente."],
    over_request_rate_limit: ["Muitas tentativas", "Aguarde alguns minutos antes de tentar novamente."],
    email_address_invalid: ["E-mail não aceito", "O servidor não aceitou este endereço de e-mail. Verifique se ele está correto."],
    email_address_not_authorized: ["Envio de e-mail não autorizado", "O servidor de e-mail padrão do Supabase só envia para membros da equipe do projeto. Configure um SMTP próprio no painel."],
    signup_disabled: ["Cadastro desativado", "Novos cadastros estão desativados neste projeto."],
    email_provider_disabled: ["Login por e-mail desativado", "O login por e-mail e senha está desativado neste projeto."],
    otp_expired: ["Link inválido ou expirado", "O link já foi usado ou expirou. Peça um novo envio."],
    session_not_found: ["Sessão expirada", "Entre novamente para continuar."],
    user_not_found: ["Conta não encontrada", "Entre novamente ou crie uma conta."]
  };

  function isNetworkError(error) {
    return Boolean(error) && (
      error.name === "AuthRetryableFetchError" ||
      error.status === 0 ||
      error instanceof TypeError ||
      navigator.onLine === false
    );
  }

  /** Converte um erro do Supabase em { title, message } para mostrar ao usuário. */
  function describeError(error) {
    if (!error) return { title: "Erro desconhecido", message: "" };

    if (error.name === "MedTechConfigError") {
      return { title: "Supabase não configurado", message: error.message };
    }
    if (isNetworkError(error)) {
      return { title: "Sem conexão com o servidor", message: "Verifique sua internet e tente novamente. Se o problema continuar, o serviço pode estar indisponível." };
    }

    const known = ERROR_MESSAGES[error.code];
    if (known) return { title: known[0], message: known[1] };

    // Servidores sem "code": reconhece pela mensagem original
    const text = String(error.message || "").toLowerCase();
    if (error.status === 429 || text.indexOf("rate limit") !== -1) return describeError({ code: "over_email_send_rate_limit" });
    if (text.indexOf("invalid login credentials") !== -1) return describeError({ code: "invalid_credentials" });
    if (text.indexOf("email not confirmed") !== -1) return describeError({ code: "email_not_confirmed" });
    if (text.indexOf("already registered") !== -1) return describeError({ code: "user_already_exists" });

    return {
      title: "Não foi possível concluir a operação",
      message: error.message ? "Resposta do servidor: " + error.message : "Tente novamente em instantes."
    };
  }

  /* ------------------------------------------------------------------ */
  /* Sessão                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Devolve o usuário logado, CONFERIDO no servidor, ou null se não houver
   * sessão válida. Lança erro apenas em falhas de rede/configuração.
   */
  async function getVerifiedUser() {
    const client = requireClient();

    const sessionResult = await client.auth.getSession(); // lê a sessão salva
    if (sessionResult.error) throw sessionResult.error;
    if (!sessionResult.data.session) return null;

    const userResult = await client.auth.getUser(); // pergunta ao servidor se o token vale
    if (userResult.error) {
      if (isNetworkError(userResult.error)) throw userResult.error;
      // Token inválido ou conta removida: descarta a sessão local
      await client.auth.signOut({ scope: "local" });
      return null;
    }
    return userResult.data.user;
  }

  function isEmailConfirmed(user) {
    return Boolean(user && (user.email_confirmed_at || user.confirmed_at));
  }

  function displayName(user) {
    const meta = (user && user.user_metadata) || {};
    return meta.full_name || (user && user.email) || "Usuário";
  }

  /* ------------------------------------------------------------------ */
  /* Retorno dos links de e-mail                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Lê os parâmetros que o Supabase coloca na URL ao voltar de um link
   * de e-mail. IMPORTANTE: chame ANTES de usar o cliente, porque a
   * biblioteca apaga o "#..." da URL depois de processá-lo.
   * Estes dados servem só para escolher a mensagem; nunca como prova de login.
   */
  function readAuthParams() {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const query = new URLSearchParams(window.location.search);
    function get(name) { return hash.get(name) || query.get(name); }

    return {
      type: get("type"),
      hasTokens: Boolean(hash.get("access_token")),
      error: get("error"),
      errorCode: get("error_code"),
      errorDescription: get("error_description")
    };
  }

  /* ------------------------------------------------------------------ */
  /* Ações                                                              */
  /* Todas devolvem { data, error }, como a própria biblioteca.          */
  /* ------------------------------------------------------------------ */
  async function run(action) {
    try {
      return await action(requireClient());
    } catch (error) {
      return { data: null, error: error };
    }
  }

  function signUp(fullName, email, password) {
    return run(async function (client) {
      const result = await client.auth.signUp({
        email: email.trim(),
        password: password,
        options: {
          emailRedirectTo: REDIRECTS.confirmacao,
          data: { full_name: fullName.trim() }
        }
      });
      if (result.error) return result;

      const user = result.data.user;
      // Com a confirmação ativa, o Supabase não informa erro para e-mail já
      // cadastrado: devolve um usuário sem "identities".
      if (user && Array.isArray(user.identities) && user.identities.length === 0) {
        return { data: null, error: { code: "user_already_exists", message: "User already registered" } };
      }
      return { data: { user: user, session: result.data.session }, error: null };
    });
  }

  function signIn(email, password) {
    return run(async function (client) {
      const result = await client.auth.signInWithPassword({ email: email.trim(), password: password });
      if (result.error) return result;

      if (!isEmailConfirmed(result.data.user)) {
        await client.auth.signOut({ scope: "local" });
        return { data: null, error: { code: "email_not_confirmed", message: "Email not confirmed" } };
      }
      return { data: result.data, error: null };
    });
  }

  function resendConfirmation(email) {
    return run(function (client) {
      return client.auth.resend({
        type: "signup",
        email: email.trim(),
        options: { emailRedirectTo: REDIRECTS.confirmacao }
      });
    });
  }

  function requestPasswordReset(email) {
    return run(function (client) {
      return client.auth.resetPasswordForEmail(email.trim(), { redirectTo: REDIRECTS.redefinirSenha });
    });
  }

  function updatePassword(newPassword) {
    return run(function (client) {
      return client.auth.updateUser({ password: newPassword });
    });
  }

  async function signOut() {
    const result = await run(function (client) { return client.auth.signOut(); });
    if (!result.error) {
      clearPendingEmail();
      setRecoveryFlag(false);
      window.location.replace("entrar.html?motivo=saiu");
    }
    return result;
  }

  /**
   * Página "Criar nova senha": só libera o formulário se o usuário chegou
   * pelo link de recuperação E a sessão for confirmada pelo servidor.
   * Devolve { ok, user, params }.
   */
  async function checkRecoverySession() {
    const params = readAuthParams(); // antes do cliente limpar a URL
    if (params.error) return { ok: false, user: null, params: params };

    const client = requireClient();
    let recovery = params.type === "recovery" || getRecoveryFlag();
    const listener = client.auth.onAuthStateChange(function (event) {
      if (event === "PASSWORD_RECOVERY") recovery = true;
    });

    try {
      const user = await getVerifiedUser();
      // O evento é disparado logo após a leitura da URL; aguarda um instante
      await new Promise(function (resolve) { setTimeout(resolve, 0); });
      if (user && recovery) {
        setRecoveryFlag(true); // permite recarregar a página sem perder o fluxo
        return { ok: true, user: user, params: params };
      }
      return { ok: false, user: null, params: params };
    } finally {
      listener.data.subscription.unsubscribe();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Armazenamento local de apoio (nunca guarda senhas nem tokens)      */
  /* ------------------------------------------------------------------ */
  function storageGet(storage, key) {
    try { return storage.getItem(key); } catch (e) { return null; }
  }

  function storageSet(storage, key, value) {
    try {
      if (value === null) storage.removeItem(key);
      else storage.setItem(key, value);
    } catch (e) { /* armazenamento bloqueado: segue sem ele */ }
  }

  /** E-mail usado no cadastro, para exibir e reenviar a confirmação. */
  function setPendingEmail(email) { storageSet(sessionStorage, PENDING_EMAIL_KEY, email.trim()); }
  function getPendingEmail() { return storageGet(sessionStorage, PENDING_EMAIL_KEY); }
  function clearPendingEmail() { storageSet(sessionStorage, PENDING_EMAIL_KEY, null); }

  function setRecoveryFlag(on) { storageSet(sessionStorage, RECOVERY_FLAG_KEY, on ? "1" : null); }
  function getRecoveryFlag() { return storageGet(sessionStorage, RECOVERY_FLAG_KEY) === "1"; }

  /** Controle de frequência dos envios de e-mail (por tipo de envio). */
  const cooldown = {
    start: function (key, seconds) {
      storageSet(localStorage, "medtech:cooldown:" + key, String(Date.now() + (seconds || EMAIL_COOLDOWN_SECONDS) * 1000));
    },
    remaining: function (key) {
      const until = Number(storageGet(localStorage, "medtech:cooldown:" + key)) || 0;
      return Math.max(0, Math.ceil((until - Date.now()) / 1000));
    }
  };

  /* ------------------------------------------------------------------ */
  /* Navegação                                                          */
  /* ------------------------------------------------------------------ */
  function currentPageFile() {
    const file = window.location.pathname.split("/").pop() || "index.html";
    // Hospedagens com "URLs limpas" (ex.: Vercel) podem abrir /dashboard em vez de /dashboard.html
    return file.indexOf(".") === -1 ? file + ".html" : file;
  }

  /** Página para onde ir depois do login (só aceita páginas da lista). */
  function returnTarget() {
    const wanted = new URLSearchParams(window.location.search).get("voltar");
    return PRIVATE_PAGES.indexOf(wanted) !== -1 ? wanted : "dashboard.html";
  }

  function goToLogin(reason) {
    const page = currentPageFile();
    let url = "entrar.html?motivo=" + encodeURIComponent(reason);
    if (PRIVATE_PAGES.indexOf(page) !== -1) url += "&voltar=" + encodeURIComponent(page);
    window.location.replace(url);
  }

  /** Para login e cadastro: quem já está logado vai direto para o painel. */
  async function redirectIfLoggedIn() {
    try {
      const user = await getVerifiedUser();
      if (user && isEmailConfirmed(user)) window.location.replace(returnTarget());
    } catch (e) {
      // Sem conexão ou sem configuração: a própria página mostra o aviso
    }
  }

  /* ------------------------------------------------------------------ */
  /* Proteção das páginas privadas                                      */
  /* ------------------------------------------------------------------ */
  let resolveReady;
  // Promise com o usuário logado, para os scripts das páginas privadas
  const ready = new Promise(function (resolve) { resolveReady = resolve; });

  const domReady = new Promise(function (resolve) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", resolve);
    else resolve();
  });

  function showSessionError(error) {
    const loader = document.getElementById("session-loader");
    if (!loader) return;
    const info = describeError(error);
    loader.innerHTML =
      '<div class="session-loader__box">' +
        '<div class="alert alert--danger" role="alert">' + Icons.get("alertCircle") +
          "<div><strong></strong><span></span></div></div>" +
        '<button type="button" class="btn btn--primary btn--block">' + Icons.get("refresh") + "Tentar novamente</button>" +
      "</div>";
    loader.querySelector("strong").textContent = "Não foi possível verificar sua sessão. " + info.title;
    loader.querySelector("span").textContent = info.message;
    loader.querySelector("button").addEventListener("click", function () { window.location.reload(); });
  }

  async function protectPage() {
    let user;
    try {
      user = await getVerifiedUser();
    } catch (error) {
      await domReady;
      showSessionError(error);
      return;
    }

    if (!user) return goToLogin("sessao");
    if (!isEmailConfirmed(user)) {
      await requireClient().auth.signOut({ scope: "local" });
      return goToLogin("confirmacao");
    }

    await domReady;
    UI.setSidebarUser(displayName(user), user.email);
    document.body.classList.remove("is-checking-session");
    const loader = document.getElementById("session-loader");
    if (loader) loader.remove();

    // Se a sessão terminar (logout em outra aba, token revogado), volta ao login
    requireClient().auth.onAuthStateChange(function (event) {
      if (event === "SIGNED_OUT") goToLogin("sessao");
    });

    resolveReady(user);
  }

  // O botão "Sair" da sidebar (ui.js) passa a usar o Supabase
  UI.handlers.logout = async function () {
    const button = document.getElementById("logout-button");
    if (button) UI.setButtonLoading(button, true);
    const result = await signOut();
    if (result.error) {
      if (button) UI.setButtonLoading(button, false);
      const info = describeError(result.error);
      UI.toast("Não foi possível sair. " + info.message, "danger");
    }
  };

  if (document.body && document.body.hasAttribute("data-private")) {
    protectPage();
  }

  return {
    REDIRECTS: REDIRECTS,
    ready: ready,
    describeError: describeError,
    readAuthParams: readAuthParams,
    getVerifiedUser: getVerifiedUser,
    isEmailConfirmed: isEmailConfirmed,
    displayName: displayName,
    signUp: signUp,
    signIn: signIn,
    signOut: signOut,
    resendConfirmation: resendConfirmation,
    requestPasswordReset: requestPasswordReset,
    updatePassword: updatePassword,
    checkRecoverySession: checkRecoverySession,
    setPendingEmail: setPendingEmail,
    getPendingEmail: getPendingEmail,
    clearPendingEmail: clearPendingEmail,
    setRecoveryFlag: setRecoveryFlag,
    cooldown: cooldown,
    returnTarget: returnTarget,
    redirectIfLoggedIn: redirectIfLoggedIn
  };
})();
