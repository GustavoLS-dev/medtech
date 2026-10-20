/* ==========================================================================
   MedTech — ui.js
   Componentes de interface reutilizáveis, sem frameworks:
   - menu lateral (sidebar) e topo para celular
   - painel lateral das páginas de login/cadastro
   - toasts (notificações), modal de confirmação
   - estado de carregamento dos botões, mostrar/ocultar senha
   - badges dos estados de dose e formatação de datas (America/Sao_Paulo)
   Depende de: icons.js
   ========================================================================== */

const UI = (function () {
  const TIMEZONE = "America/Sao_Paulo";

  // Itens do menu. Para adicionar uma página, basta incluir uma linha aqui.
  const NAV_ITEMS = [
    { id: "dashboard",    label: "Hoje",         href: "dashboard.html",    icon: "dashboard" },
    { id: "medicamentos", label: "Medicamentos", href: "medicamentos.html", icon: "pill" },
    { id: "programacao",  label: "Programação",  href: "programacao.html",  icon: "calendar" },
    { id: "historico",    label: "Relatório",    href: "historico.html",    icon: "history" },
    { id: "dispositivo",  label: "Dispositivo",  href: "dispositivo.html",  icon: "cpu" }
  ];

  /*
   * Estados possíveis de uma dose. A diferença entre eles é importante:
   * o ESP32 mover o servo NÃO significa que o medicamento foi retirado.
   * O hardware atual não tem sensor, então "sensor_confirmed" nunca aparece
   * numa dose; ele fica na legenda para deixar a limitação explícita.
   */
  const DOSE_STATES = {
    pending:          { label: "Pendente",               tone: "neutral", help: "O horário ainda não chegou." },
    attempt:          { label: "Tentativa registrada",   tone: "info",    help: "O dispositivo começou o acionamento, mas ainda não informou o resultado." },
    actuated:         { label: "Acionamento realizado",  tone: "violet",  help: "O dispositivo informou que abriu e fechou a gaveta ou ligou a bomba pelo tempo configurado. Isso não prova que o medicamento foi retirado." },
    user_confirmed:   { label: "Tomado",                 tone: "success", help: "O dispensador abriu e fechou o compartimento (ou ligou a bomba), no horário programado ou no “Liberar agora”. Marcado automaticamente; sem sensor, não prova a ingestão." },
    sensor_confirmed: { label: "Liberação por sensor",   tone: "success", help: "Exige sensor no compartimento. O dispensador atual não tem sensor, então este estado ainda não é usado." },
    failed:           { label: "Falha",                  tone: "danger",  help: "O dispositivo informou um erro ou reiniciou durante o acionamento." },
    missed:           { label: "Não aberta (atraso)",    tone: "warning", help: "O dispositivo estava sem energia, sem hora ou sem agenda válida no horário. Passada a tolerância, a gaveta não é aberta." },
    unknown:          { label: "Sem registro",           tone: "warning", help: "O horário passou e o dispositivo não enviou nenhuma informação." }
  };

  // Ações ligadas por outros scripts (o logout é definido em auth.js).
  const handlers = {
    logout: function () {}
  };

  /* ------------------------------------------------------------------ */
  /* Segurança: sempre escape textos vindos do usuário ou do banco       */
  /* antes de colocá-los dentro de innerHTML (evita ataques XSS).        */
  /* ------------------------------------------------------------------ */
  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /* ------------------------------------------------------------------ */
  /* Datas no fuso de São Paulo                                          */
  /* ------------------------------------------------------------------ */
  function formatDate(date, options) {
    return new Intl.DateTimeFormat("pt-BR", Object.assign({ timeZone: TIMEZONE }, options)).format(date);
  }

  function formatToday() {
    const text = formatDate(new Date(), { weekday: "long", day: "numeric", month: "long" });
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function formatDateTime(date) {
    return formatDate(date, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  /* ------------------------------------------------------------------ */
  /* Marca                                                              */
  /* ------------------------------------------------------------------ */
  function logoHtml() {
    return Icons.logoMark() + '<span class="logo__text">Med<span>Tech</span></span>';
  }

  /* ------------------------------------------------------------------ */
  /* Área logada: sidebar + topo (celular)                              */
  /* ------------------------------------------------------------------ */
  function renderShell(currentPage) {
    const sidebar = document.getElementById("sidebar");
    const topbar = document.getElementById("topbar");
    if (!sidebar || !topbar) return;

    const links = NAV_ITEMS.map(function (item) {
      const current = item.id === currentPage ? ' aria-current="page"' : "";
      return '<a class="nav-link" href="' + item.href + '"' + current + ">" +
        Icons.get(item.icon) + "<span>" + item.label + "</span></a>";
    }).join("");

    const profileCurrent = currentPage === "perfil" ? ' aria-current="page"' : "";

    sidebar.innerHTML =
      '<a class="sidebar__brand logo" href="dashboard.html" aria-label="MedTech, ir para Hoje">' + logoHtml() + "</a>" +
      '<nav class="sidebar__nav" aria-label="Principal">' +
        '<p class="sidebar__section-label">Painel</p>' + links +
        '<p class="sidebar__section-label">Conta</p>' +
        '<a class="nav-link" href="perfil.html"' + profileCurrent + ">" + Icons.get("user") + "<span>Perfil</span></a>" +
      "</nav>" +
      '<div class="sidebar__footer">' +
        '<div class="sidebar__user">' +
          '<div class="avatar" id="sidebar-avatar" aria-hidden="true">?</div>' +
          '<div style="min-width:0">' +
            '<p class="sidebar__user-name" id="sidebar-user-name">Usuário</p>' +
            '<p class="sidebar__user-email" id="sidebar-user-email">Sessão não verificada</p>' +
          "</div>" +
        "</div>" +
        '<button type="button" class="nav-link nav-link--logout" id="logout-button">' +
          Icons.get("logout") + "<span>Sair</span></button>" +
      "</div>";

    topbar.innerHTML =
      '<button type="button" class="btn btn--ghost btn--icon" id="menu-button" ' +
        'aria-label="Abrir menu" aria-controls="sidebar" aria-expanded="false">' + Icons.get("menu") + "</button>" +
      '<a class="logo logo--dark" href="dashboard.html" aria-label="MedTech, ir para Hoje">' + logoHtml() + "</a>" +
      '<a class="btn btn--ghost btn--icon" href="perfil.html" aria-label="Perfil">' + Icons.get("user") + "</a>";

    document.getElementById("logout-button").addEventListener("click", function () {
      handlers.logout();
    });

    setupMobileMenu(sidebar);
  }

  /** Atualiza nome/e-mail exibidos na sidebar (usado após o login). */
  function setSidebarUser(name, email) {
    const nameEl = document.getElementById("sidebar-user-name");
    const emailEl = document.getElementById("sidebar-user-email");
    const avatarEl = document.getElementById("sidebar-avatar");
    if (nameEl) nameEl.textContent = name || "Usuário";
    if (emailEl) emailEl.textContent = email || "";
    if (avatarEl) avatarEl.textContent = initials(name || email || "?");
  }

  function initials(text) {
    const parts = String(text).trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "?";
    const first = parts[0].charAt(0);
    const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : "";
    return (first + last).toUpperCase();
  }

  /** No celular, a sidebar vira uma gaveta que abre pelo botão de menu. */
  function setupMobileMenu(sidebar) {
    const button = document.getElementById("menu-button");
    const overlay = document.getElementById("sidebar-overlay");
    const mobileQuery = window.matchMedia("(max-width: 900px)");

    function setOpen(open) {
      sidebar.classList.toggle("is-open", open);
      if (overlay) overlay.classList.toggle("is-visible", open);
      button.setAttribute("aria-expanded", String(open));
      button.setAttribute("aria-label", open ? "Fechar menu" : "Abrir menu");
      // Gaveta fechada no celular: links não podem receber foco pelo teclado
      sidebar.inert = mobileQuery.matches && !open;
      if (open) {
        const first = sidebar.querySelector("a, button");
        if (first) first.focus();
      }
    }

    button.addEventListener("click", function () {
      const isOpen = sidebar.classList.contains("is-open");
      setOpen(!isOpen);
      if (isOpen) button.focus();
    });

    if (overlay) overlay.addEventListener("click", function () { setOpen(false); });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && sidebar.classList.contains("is-open")) {
        setOpen(false);
        button.focus();
      }
    });

    // Ao mudar entre celular e computador, reajusta o estado
    mobileQuery.addEventListener("change", function () {
      sidebar.classList.remove("is-open");
      if (overlay) overlay.classList.remove("is-visible");
      button.setAttribute("aria-expanded", "false");
      sidebar.inert = mobileQuery.matches;
    });

    sidebar.inert = mobileQuery.matches;
  }

  /* ------------------------------------------------------------------ */
  /* Páginas de autenticação: painel lateral com a marca                */
  /* ------------------------------------------------------------------ */
  function renderAuthAside() {
    const aside = document.querySelector("[data-auth-aside]");
    if (!aside) return;

    const features = [
      ["calendar", "Organizador semanal: manhã, tarde e noite"],
      ["activity", "Histórico detalhado de cada liberação"],
      ["cpu", "Integração com o dispensador ESP32"],
      ["shield", "Dados protegidos por conta individual"]
    ];

    aside.innerHTML =
      '<a class="logo" href="entrar.html" style="color:#fff">' + logoHtml() + "</a>" +
      "<div>" +
        "<h2>Cada dose no horário certo, com registro de tudo.</h2>" +
        "<p>O MedTech organiza seus medicamentos, programa a dispensação automática e mostra com clareza o que realmente aconteceu.</p>" +
        '<ul class="auth__features">' +
          features.map(function (f) { return "<li>" + Icons.get(f[0]) + f[1] + "</li>"; }).join("") +
        "</ul>" +
      "</div>" +
      '<p class="auth__aside-note">Projeto acadêmico (TCC). Não substitui a orientação de profissionais de saúde.</p>';
  }

  /* ------------------------------------------------------------------ */
  /* Toasts                                                             */
  /* ------------------------------------------------------------------ */
  const TOAST_ICONS = { success: "checkCircle", danger: "alertCircle", warning: "alertTriangle", info: "info" };

  function toast(message, type, duration) {
    type = type || "info";
    let region = document.getElementById("toast-region");
    if (!region) {
      region = document.createElement("div");
      region.id = "toast-region";
      region.className = "toast-region";
      region.setAttribute("aria-live", "polite");
      region.setAttribute("aria-atomic", "false");
      document.body.appendChild(region);
    }

    const item = document.createElement("div");
    item.className = "toast toast--" + type;
    item.setAttribute("role", type === "danger" ? "alert" : "status");
    item.innerHTML = Icons.get(TOAST_ICONS[type] || "info") + "<span></span>";
    item.querySelector("span").textContent = message; // textContent: nunca interpreta HTML
    region.appendChild(item);

    setTimeout(function () {
      item.classList.add("is-leaving");
      item.addEventListener("animationend", function () { item.remove(); }, { once: true });
    }, duration || 4500);
  }

  /* ------------------------------------------------------------------ */
  /* Modal de confirmação — devolve uma Promise com true/false           */
  /* Ex.: if (await UI.confirm({ title: "Excluir?", danger: true })) ... */
  /* ------------------------------------------------------------------ */
  function confirmDialog(options) {
    const opts = Object.assign({
      title: "Tem certeza?",
      message: "",
      confirmText: "Confirmar",
      cancelText: "Cancelar",
      danger: false
    }, options);

    return new Promise(function (resolve) {
      const previousFocus = document.activeElement;
      const backdrop = document.createElement("div");
      backdrop.className = "modal-backdrop";
      backdrop.innerHTML =
        '<div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="modal-title" aria-describedby="modal-msg">' +
          '<div class="modal__body"><h2 id="modal-title" style="font-size:1.125rem"></h2><p id="modal-msg"></p></div>' +
          '<div class="modal__footer">' +
            '<button type="button" class="btn btn--secondary" data-action="cancel"></button>' +
            '<button type="button" class="btn ' + (opts.danger ? "btn--danger" : "btn--primary") + '" data-action="confirm"></button>' +
          "</div>" +
        "</div>";

      backdrop.querySelector("#modal-title").textContent = opts.title;
      backdrop.querySelector("#modal-msg").textContent = opts.message;
      const cancelBtn = backdrop.querySelector('[data-action="cancel"]');
      const confirmBtn = backdrop.querySelector('[data-action="confirm"]');
      cancelBtn.textContent = opts.cancelText;
      confirmBtn.textContent = opts.confirmText;

      function close(result) {
        document.removeEventListener("keydown", onKey);
        backdrop.remove();
        if (previousFocus && previousFocus.focus) previousFocus.focus();
        resolve(result);
      }

      function onKey(event) {
        if (event.key === "Escape") close(false);
        // Mantém o foco dentro do modal ao usar Tab
        if (event.key === "Tab") {
          const goingBack = event.shiftKey;
          if (goingBack && document.activeElement === cancelBtn) { event.preventDefault(); confirmBtn.focus(); }
          else if (!goingBack && document.activeElement === confirmBtn) { event.preventDefault(); cancelBtn.focus(); }
        }
      }

      cancelBtn.addEventListener("click", function () { close(false); });
      confirmBtn.addEventListener("click", function () { close(true); });
      backdrop.addEventListener("click", function (event) { if (event.target === backdrop) close(false); });
      document.addEventListener("keydown", onKey);

      document.body.appendChild(backdrop);
      cancelBtn.focus(); // ação mais segura recebe o foco primeiro
    });
  }

  /* ------------------------------------------------------------------ */
  /* Botões e formulários                                               */
  /* ------------------------------------------------------------------ */
  function setButtonLoading(button, loading) {
    button.disabled = loading;
    button.classList.toggle("is-loading", loading);
    button.setAttribute("aria-busy", String(loading));
  }

  /** Liga todos os botões <button data-toggle-password="idDoCampo">. */
  function initPasswordToggles() {
    document.querySelectorAll("[data-toggle-password]").forEach(function (button) {
      const input = document.getElementById(button.getAttribute("data-toggle-password"));
      if (!input) return;

      function render() {
        const visible = input.type === "text";
        button.innerHTML = Icons.get(visible ? "eyeOff" : "eye");
        button.setAttribute("aria-label", visible ? "Ocultar senha" : "Mostrar senha");
        button.setAttribute("aria-pressed", String(visible));
      }

      button.addEventListener("click", function () {
        input.type = input.type === "password" ? "text" : "password";
        render();
        input.focus();
      });
      render();
    });
  }

  /**
   * Mostra uma mensagem (alerta) dentro de um container da página.
   * action (opcional): { href, label } para um link logo abaixo do texto.
   */
  function showAlert(container, type, title, message, action) {
    if (!container) return;
    container.innerHTML =
      '<div class="alert alert--' + type + '"' + (type === "danger" ? ' role="alert"' : "") + ">" +
      Icons.get(TOAST_ICONS[type] || "info") +
      "<div><strong></strong><span></span></div></div>";
    container.querySelector("strong").textContent = title;
    container.querySelector("span").textContent = message || "";

    if (action) {
      const link = document.createElement("a");
      link.className = "alert__action";
      link.href = action.href;
      link.textContent = action.label;
      container.querySelector(".alert > div").appendChild(link);
    }
  }

  /**
   * Desabilita um botão por alguns segundos mostrando a contagem
   * (ex.: "Reenviar em 42 s"). O texto fica em <span class="btn__label">.
   */
  function startCountdown(button, seconds, idleLabel) {
    const label = button.querySelector(".btn__label") || button;
    if (button._countdown) clearInterval(button._countdown);

    function tick() {
      if (seconds <= 0) {
        clearInterval(button._countdown);
        button._countdown = null;
        button.disabled = false;
        label.textContent = idleLabel;
        return;
      }
      button.disabled = true;
      label.textContent = idleLabel + " (aguarde " + seconds + " s)";
      seconds--;
    }

    tick();
    button._countdown = setInterval(tick, 1000);
  }

  function clearAlert(container) {
    if (container) container.innerHTML = "";
  }

  /* ------------------------------------------------------------------ */
  /* Badges e estados vazios                                            */
  /* ------------------------------------------------------------------ */
  function doseBadge(stateKey) {
    const state = DOSE_STATES[stateKey] || DOSE_STATES.unknown;
    return '<span class="badge badge--' + state.tone + '">' + state.label + "</span>";
  }

  /**
   * Nome do medicamento colorido pelo estado da dose (retorno visual).
   * Tomado fica verde com ✓; o title explica o estado.
   */
  function medChip(name, stateKey) {
    const state = DOSE_STATES[stateKey] || DOSE_STATES.pending;
    const done = stateKey === "user_confirmed";
    return '<span class="chip chip--' + state.tone + '" title="' + escapeHtml(state.label) + '">' +
      (done ? Icons.get("checkCircle") : "") + escapeHtml(name) +
      '<span class="sr-only"> (' + escapeHtml(state.label) + ")</span></span>";
  }

  /** Preenche <ul data-dose-legend> com todos os estados e suas explicações. */
  function renderDoseLegend() {
    document.querySelectorAll("[data-dose-legend]").forEach(function (list) {
      list.innerHTML = Object.keys(DOSE_STATES).map(function (key) {
        return "<li><span>" + doseBadge(key) + "</span><span>" + escapeHtml(DOSE_STATES[key].help) + "</span></li>";
      }).join("");
    });
  }

  function emptyState(icon, title, text) {
    return '<div class="empty">' +
      '<div class="empty__icon">' + Icons.get(icon) + "</div>" +
      '<p class="empty__title">' + escapeHtml(title) + "</p>" +
      '<p class="empty__text">' + escapeHtml(text) + "</p>" +
      "</div>";
  }

  /* ------------------------------------------------------------------ */
  /* Inicialização automática de toda página                            */
  /* ------------------------------------------------------------------ */
  function init() {
    const body = document.body;
    const page = body.getAttribute("data-page");

    if (page) renderShell(page);
    renderAuthAside();

    document.querySelectorAll("[data-logo]").forEach(function (el) { el.innerHTML = logoHtml(); });
    document.querySelectorAll("[data-today]").forEach(function (el) { el.textContent = formatToday(); });

    renderDoseLegend();
    initPasswordToggles();
    Icons.hydrate();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  return {
    TIMEZONE: TIMEZONE,
    DOSE_STATES: DOSE_STATES,
    handlers: handlers,
    escapeHtml: escapeHtml,
    formatDate: formatDate,
    formatDateTime: formatDateTime,
    formatToday: formatToday,
    setSidebarUser: setSidebarUser,
    toast: toast,
    confirm: confirmDialog,
    setButtonLoading: setButtonLoading,
    showAlert: showAlert,
    clearAlert: clearAlert,
    startCountdown: startCountdown,
    doseBadge: doseBadge,
    medChip: medChip,
    emptyState: emptyState
  };
})();
