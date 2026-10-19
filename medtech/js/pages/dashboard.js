/* ==========================================================================
   MedTech — pages/dashboard.js  (dashboard.html)
   Horários de hoje (manhã, tarde, noite) ligados aos registros enviados
   pelo ESP32. Atualiza a cada 15 s enquanto a página está visível.
   ========================================================================== */

(function () {
  const REFRESH_MS = 15000;
  const list = document.getElementById("today-list");
  const releaseList = document.getElementById("release-list");
  const pageMessage = document.getElementById("page-message");

  let medications = [];
  let settings = Data.DEFAULT_SETTINGS;

  function setStat(id, value) {
    const el = document.getElementById(id);
    el.textContent = String(value);
    el.classList.remove("stat__value--empty");
  }

  // Os indicadores contam medicamentos (um horário pode ter vários).
  function renderStats(slots) {
    const count = function (states) {
      return slots.filter(function (s) { return states.indexOf(s.state) !== -1; })
        .reduce(function (total, s) { return total + s.names.length; }, 0);
    };
    setStat("stat-total", slots.reduce(function (total, s) { return total + s.names.length; }, 0));
    setStat("stat-confirmed", count(["user_confirmed"]));
    setStat("stat-pending", count(["pending"]));
    setStat("stat-problems", count(["failed", "missed", "unknown"]));
  }

  // Ação de cada horário: confirmar retirada, aguardar pedido ou liberar agora.
  function actionHtml(s, requests) {
    if (s.state === "actuated") {
      return '<button type="button" class="btn btn--primary btn--sm" data-confirm="' + UI.escapeHtml(s.doses[0].scheduled_for) +
        '" data-period="' + UI.escapeHtml(s.period.key) + '">Retirei</button>';
    }
    if (s.doses.length) return "";
    const waiting = requests.some(function (r) { return r.period === s.period.key; });
    if (waiting) {
      return '<span class="badge badge--info"><span class="spinner spinner--sm" aria-hidden="true"></span>Aguardando o dispensador…</span>';
    }
    return '<button type="button" class="btn btn--secondary btn--sm" data-dispense="' + UI.escapeHtml(s.period.key) + '">' +
      Icons.get("package") + "Liberar período</button>";
  }

  // "Liberar agora" de cada medicamento, com o resultado da última liberação manual de hoje.
  function renderRelease(medications, requests, doses) {
    if (medications.length === 0) {
      releaseList.innerHTML = UI.emptyState("pill", "Nenhum medicamento cadastrado", "Cadastre um medicamento na página Medicamentos.");
      return;
    }
    const manual = Data.latestManual(doses);
    releaseList.innerHTML = '<ul class="item-list">' + medications.map(function (m) {
      const medForm = Data.formOf(m.form);
      const dose = manual[m.id];
      const state = dose ? Data.doseState(dose) : null;
      const waiting = requests.some(function (r) { return r.medication_id === m.id; });
      let action;
      if (waiting) {
        action = '<span class="badge badge--info"><span class="spinner spinner--sm" aria-hidden="true"></span>Aguardando o dispensador…</span>';
      } else {
        action = (state === "actuated" ? '<button type="button" class="btn btn--primary btn--sm" data-confirm-dose="' + UI.escapeHtml(dose.id) + '">Retirei</button>' : "") +
          '<button type="button" class="btn btn--secondary btn--sm" data-release="' + UI.escapeHtml(m.id) + '">' +
          Icons.get(medForm.icon) + "Liberar agora</button>";
      }
      return '<li class="item" data-id="' + UI.escapeHtml(m.id) + '">' +
        '<div class="item__main">' +
          '<span class="slot-tag" aria-hidden="true">' + Icons.get(medForm.icon) + "</span>" +
          '<div><p class="item__title">' + UI.escapeHtml(m.name) + "</p>" +
          '<p class="item__meta">' + UI.escapeHtml(medForm.label + " · sai pela " + medForm.exit) +
          (dose ? " · última liberação manual " + UI.escapeHtml(Data.spParts(new Date(dose.scheduled_for)).time) : "") + "</p></div>" +
        "</div>" +
        '<div class="item__actions">' + (state ? UI.doseBadge(state) : "") + action + "</div></li>";
    }).join("") + "</ul>";
  }

  function renderToday(slots, requests, hasMedications) {
    const today = Data.dayOf(Data.spParts(new Date()).weekday);
    document.getElementById("today-title").lastChild.textContent =
      today.name + " · compartimento " + Data.compartmentOf(today.weekday) + " (servo " + (Data.compartmentOf(today.weekday) - 1) + ")";

    if (slots.length === 0) {
      list.innerHTML = hasMedications
        ? UI.emptyState("calendar", "Nada para hoje", "Nenhum medicamento ativo está programado para " + today.name.toLowerCase() + ".")
        : UI.emptyState("pill", "Nenhum medicamento cadastrado", "Cadastre um medicamento com os dias e os períodos na página Medicamentos.");
      return;
    }
    list.innerHTML = '<ul class="item-list">' + slots.map(function (s) {
      const done = s.state === "user_confirmed";
      return '<li class="item' + (done ? " is-done" : "") + '">' +
        '<div class="item__main">' +
          '<span class="slot-tag">' + (done ? Icons.get("checkCircle") : UI.escapeHtml(s.time)) + "</span>" +
          '<div><p class="item__title">' + UI.escapeHtml(s.period.label) + ' <span class="text-xs text-subtle">' + UI.escapeHtml(s.time) + "</span></p>" +
          '<div class="chips">' + s.items.map(function (i) { return UI.medChip(i.name, i.state); }).join("") + "</div></div>" +
        "</div>" +
        '<div class="item__actions">' + UI.doseBadge(s.state) + actionHtml(s, requests) +
        "</div></li>";
    }).join("") + "</ul>";
  }

  function renderDevice(device, settings) {
    const conn = Data.connection(device);
    document.getElementById("device-dot").className = "status-dot status-dot--" + conn.dot;
    document.getElementById("device-label").textContent = conn.label;
    document.getElementById("device-seen").textContent =
      device && device.last_seen_at ? UI.formatDateTime(new Date(device.last_seen_at)) : "Sem registro";
    document.getElementById("device-auto").textContent = settings.automation_enabled ? "Ligada" : "Desligada";
  }

  async function load() {
    try {
      const results = await Promise.all([
        Data.listMedications(),
        Data.listDoses(Data.startOfDay(0), Data.startOfDay(1)),
        Data.getDevice(),
        Data.getSettings(),
        Data.listActiveRequests()
      ]);
      medications = results[0];
      settings = results[3];
      const slots = Data.todaySlots(medications, results[1], settings);
      UI.clearAlert(pageMessage);
      renderStats(slots);
      renderToday(slots, results[4], medications.length > 0);
      renderRelease(medications, results[4], results[1]);
      renderDevice(results[2], settings);
    } catch (error) {
      const info = Data.describeError(error);
      list.innerHTML = "";
      releaseList.innerHTML = "";
      UI.showAlert(pageMessage, "danger", info.title, info.message);
    }
  }

  async function dispenseNow(button) {
    const period = Data.periodOf(button.getAttribute("data-dispense"));
    const ok = await UI.confirm({
      title: "Liberar a " + period.label.toLowerCase() + " agora?",
      message: "Em até 15 segundos o dispensador libera todos os medicamentos deste período: liga a bomba se houver líquido e abre o compartimento de hoje se houver cápsula. Quando o horário normal chegar, ele não libera de novo.",
      confirmText: "Liberar agora"
    });
    if (!ok) return;
    UI.setButtonLoading(button, true);
    try {
      await Data.requestDispense(period.key);
      UI.toast("Pedido enviado ao dispensador.", "success");
      await load();
    } catch (error) {
      UI.setButtonLoading(button, false);
      const info = Data.describeError(error);
      UI.toast(info.title + ". " + info.message, "danger");
    }
  }

  releaseList.addEventListener("click", async function (event) {
    const release = event.target.closest("button[data-release]");
    const confirmDose = event.target.closest("button[data-confirm-dose]");
    const button = release || confirmDose;
    if (!button) return;
    const med = medications.find(function (m) { return m.id === button.closest(".item").getAttribute("data-id"); });
    if (!med) return;
    const ok = await UI.confirm(release
      ? Object.assign({ confirmText: "Liberar agora" }, Data.releaseText(med, settings))
      : { title: "Você retirou " + med.name + "?", message: "Confirme somente depois de pegar o medicamento no dispensador.", confirmText: "Sim, retirei" });
    if (!ok) return;
    UI.setButtonLoading(button, true);
    try {
      if (release) await Data.requestMedication(med.id);
      else await Data.confirmDose(button.getAttribute("data-confirm-dose"));
      UI.toast(release ? "Pedido enviado ao dispensador." : "Retirada confirmada.", "success");
      await load();
    } catch (error) {
      UI.setButtonLoading(button, false);
      const info = Data.describeError(error);
      UI.toast(info.title + ". " + info.message, "danger");
    }
  });

  list.addEventListener("click", async function (event) {
    const dispense = event.target.closest("button[data-dispense]");
    if (dispense) return dispenseNow(dispense);
    const button = event.target.closest("button[data-confirm]");
    if (!button) return;
    const ok = await UI.confirm({
      title: "Você retirou os medicamentos?",
      message: "Confirme somente depois de pegar os medicamentos deste período no compartimento. A confirmação fica no relatório do dia.",
      confirmText: "Sim, retirei"
    });
    if (!ok) return;
    UI.setButtonLoading(button, true);
    try {
      await Data.confirmSlot(button.getAttribute("data-confirm"), button.getAttribute("data-period"));
      UI.toast("Retirada confirmada.", "success");
      await load();
    } catch (error) {
      UI.setButtonLoading(button, false);
      const info = Data.describeError(error);
      UI.toast(info.title + ". " + info.message, "danger");
    }
  });

  Auth.ready.then(function () {
    load();
    // Tempo real: atualiza na hora quando o aparelho registra algo.
    Data.subscribe(["doses", "dispense_requests", "device_events", "medications", "dispenser_settings"], load);
    // Reserva, se o Realtime cair, e para o "último contato" do aparelho.
    setInterval(function () { if (!document.hidden) load(); }, REFRESH_MS);
  });
})();
