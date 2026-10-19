/* ==========================================================================
   MedTech — pages/dispositivo.js  (dispositivo.html)
   Vincula o ESP32 à conta, mostra o último contato e os eventos enviados.
   A chave do aparelho é gerada no navegador, exibida uma única vez e só o
   hash fica no banco.
   ========================================================================== */

(function () {
  const REFRESH_MS = 30000;

  const pageMessage = document.getElementById("page-message");
  const pairButton = document.getElementById("pair-button");
  const unpairButton = document.getElementById("unpair-button");
  const tokenResult = document.getElementById("token-result");
  const tokenField = document.getElementById("device-token");

  const EVENT_LABELS = {
    boot: "Aparelho iniciado",
    error: "Erro informado",
    attempt: "Tentativa de acionamento",
    actuated: "Acionamento realizado",
    failed: "Falha no acionamento",
    missed: "Horário não aberto (atraso)"
  };
  const EVENT_TONES = { boot: "neutral", error: "danger", attempt: "info", actuated: "violet", failed: "danger", missed: "warning" };

  const CONNECTION_TEXT = {
    none: "Gere uma chave para vincular o dispensador a esta conta.",
    waiting: "A chave foi criada, mas o aparelho ainda não fez nenhuma consulta com ela.",
    online: "O servidor recebeu uma consulta autenticada do aparelho há menos de 90 segundos. Isso não prova que algum medicamento foi liberado.",
    offline: "O aparelho não consulta o servidor há mais de 90 segundos. Verifique energia e Wi-Fi."
  };
  const CONNECTION_ICONS = { none: "cpu", waiting: "clock", online: "checkCircle", offline: "wifiOff" };

  let device = null;
  let refreshTimer = null;

  function text(id, value) {
    document.getElementById(id).textContent = value;
  }

  function renderDevice() {
    const conn = Data.connection(device);
    const title = document.getElementById("conn-title");
    title.querySelector(".status-dot").className = "status-dot status-dot--" + conn.dot;
    text("conn-label", conn.label);
    text("conn-text", CONNECTION_TEXT[conn.key]);
    document.getElementById("conn-icon").innerHTML = Icons.get(CONNECTION_ICONS[conn.key]);

    text("info-state", conn.label);
    text("info-seen", device && device.last_seen_at ? UI.formatDateTime(new Date(device.last_seen_at)) : "Sem registro");
    text("info-hint", device ? "termina em …" + device.token_hint : "—");
    text("info-paired", device ? UI.formatDateTime(new Date(device.paired_at)) : "—");
    text("info-firmware", device && device.firmware_version ? device.firmware_version : "Não informada");

    text("pair-text", device
      ? "Este dispensador está vinculado à sua conta. Gerar uma nova chave invalida a atual: o aparelho só volta a funcionar depois de gravado com a chave nova."
      : "Nenhum dispensador vinculado. A chave gerada aqui identifica o seu ESP32 e só dá acesso à agenda desta conta.");
    pairButton.lastChild.textContent = device ? "Gerar nova chave" : "Gerar chave do ESP32";
    pairButton.disabled = false;
    unpairButton.hidden = !device;
  }

  // Um compartimento por dia: servo 0 = segunda ... servo 6 = domingo.
  function renderSlots(medications, settings) {
    document.getElementById("slot-list").innerHTML = '<ul class="item-list">' + Data.DAYS.map(function (d) {
      const periods = Data.PERIODS.filter(function (p) { return Data.medicationsFor(medications, d.weekday, p.key).length; });
      const compartment = Data.compartmentOf(d.weekday);
      return '<li class="item"><div class="item__main">' +
        '<span class="slot-tag">' + d.short + "</span>" +
        '<div><p class="item__title">' + d.name + ' <span class="text-xs text-subtle">· servo ' + (compartment - 1) + "</span></p>" +
        '<p class="item__meta">' + (periods.length
          ? UI.escapeHtml(periods.map(function (p) {
              return p.label + " " + Data.periodTime(settings, p.key) + " (" + Data.medicationsFor(medications, d.weekday, p.key).length + ")";
            }).join(" · "))
          : '<span class="text-subtle">Nada programado</span>') + "</p>" +
        "</div></div></li>";
    }).join("") + "</ul>";
  }

  function renderEvents(events) {
    const box = document.getElementById("event-list");
    if (events.length === 0) {
      box.innerHTML = UI.emptyState("activity", "Nenhum evento recebido",
        "Isso não significa que o dispositivo esteja funcionando: ele ainda não enviou nenhum evento.");
      return;
    }
    box.innerHTML = '<ul class="item-list">' + events.map(function (e) {
      const when = e.scheduled_for ? UI.formatDate(new Date(e.scheduled_for), { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "";
      const slot = !when ? "" : e.period ? Data.periodOf(e.period).label + " de " + when : "Liberação manual de " + when;
      return '<li class="item"><div>' +
        '<span class="badge badge--' + (EVENT_TONES[e.event_type] || "neutral") + '">' + UI.escapeHtml(EVENT_LABELS[e.event_type] || e.event_type) + "</span>" +
        (slot ? ' <span class="text-xs text-muted">' + UI.escapeHtml(slot) + "</span>" : "") +
        (e.detail ? ' <span class="text-xs text-muted">' + UI.escapeHtml(e.detail) + "</span>" : "") +
        "</div>" +
        '<span class="item__meta">' + UI.formatDateTime(new Date(e.occurred_at)) + "</span></li>";
    }).join("") + "</ul>";
  }

  async function load() {
    try {
      const results = await Promise.all([Data.getDevice(), Data.listMedications(), Data.listDeviceEvents(15), Data.getSettings()]);
      device = results[0];
      UI.clearAlert(pageMessage);
      renderDevice();
      text("info-auto", results[3].automation_enabled ? "Ligada (altere em Programação)" : "Desligada (ligue em Programação)");
      renderSlots(results[1], results[3]);
      renderEvents(results[2]);
    } catch (error) {
      const info = Data.describeError(error);
      UI.showAlert(pageMessage, "danger", info.title, info.message);
    }
  }

  function hideToken() {
    tokenField.value = "";
    tokenResult.hidden = true;
  }

  pairButton.addEventListener("click", async function () {
    if (device) {
      const ok = await UI.confirm({
        title: "Gerar uma nova chave?",
        message: "A chave atual deixa de funcionar imediatamente. O ESP32 só volta a receber a agenda depois de gravado com a nova chave.",
        confirmText: "Gerar nova chave",
        danger: true
      });
      if (!ok) return;
    }
    UI.setButtonLoading(pairButton, true);
    try {
      tokenField.value = await Data.pairDevice();
      tokenResult.hidden = false;
      tokenField.focus();
      tokenField.select();
      await load();
    } catch (error) {
      const info = Data.describeError(error);
      UI.showAlert(pageMessage, "danger", info.title, info.message);
    } finally {
      UI.setButtonLoading(pairButton, false);
    }
  });

  unpairButton.addEventListener("click", async function () {
    const ok = await UI.confirm({
      title: "Desvincular o dispensador?",
      message: "O aparelho deixa de receber a agenda desta conta e para de abrir as gavetas depois da próxima consulta. Medicamentos e histórico são mantidos.",
      confirmText: "Desvincular",
      danger: true
    });
    if (!ok) return;
    UI.setButtonLoading(unpairButton, true);
    try {
      await Data.unpairDevice();
      hideToken();
      UI.toast("Dispensador desvinculado.", "success");
      await load();
    } catch (error) {
      const info = Data.describeError(error);
      UI.toast(info.title + ". " + info.message, "danger");
    } finally {
      UI.setButtonLoading(unpairButton, false);
    }
  });

  document.getElementById("copy-token").addEventListener("click", async function () {
    try {
      await navigator.clipboard.writeText(tokenField.value);
      UI.toast("Chave copiada.", "success");
    } catch (e) {
      tokenField.focus();
      tokenField.select();
      UI.toast("Selecione a chave e copie com Ctrl+C.", "info");
    }
  });
  document.getElementById("hide-token").addEventListener("click", hideToken);
  document.getElementById("refresh-button").addEventListener("click", load);

  // A chave não fica na página se o usuário sair dela
  window.addEventListener("pagehide", function () {
    hideToken();
    clearInterval(refreshTimer);
  });

  Auth.ready.then(function () {
    load();
    Data.subscribe(["device_events", "medications", "dispenser_settings"], load);  // tempo real
    refreshTimer = setInterval(function () { if (!document.hidden) load(); }, REFRESH_MS);
  });
})();
