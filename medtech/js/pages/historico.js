/* ==========================================================================
   MedTech — pages/historico.js  (historico.html)
   Relatório diário: o que o ESP32 registrou em cada dia e período, com
   filtros, e a confirmação de retirada de um horário acionado.
   ========================================================================== */

(function () {
  const REFRESH_MS = 30000;
  const list = document.getElementById("history-list");
  const pageMessage = document.getElementById("page-message");
  const periodFilter = document.getElementById("period-filter");
  const resultFilter = document.getElementById("result-filter");

  // Códigos curtos enviados pelo firmware em "detail"
  const DETAILS = {
    atraso_maior_que_tolerancia: "O horário passou da tolerância de atraso; o compartimento não foi aberto.",
    reinicio_durante_acionamento: "O aparelho reiniciou durante o acionamento.",
    falha_i2c: "Falha de comunicação com o controlador dos servos (PCA9685).",
    recusado_pelo_servidor: "O servidor recusou o acionamento.",
    parado_manualmente: "Acionamento interrompido pelo comando PARAR.",
    modo_offline: "Executado sem internet, com a agenda salva no aparelho.",
    liberacao_manual: "Liberação manual pedida no site (botão “Liberar agora” do medicamento)."
  };

  let doses = [];

  function time(iso) {
    return UI.formatDate(new Date(iso), { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function slotHtml(s) {
    const first = s.doses[0];
    const times = [];
    if (first.attempt_at) times.push("início " + time(first.attempt_at));
    if (first.finished_at) times.push("resultado " + time(first.finished_at));
    const confirmed = s.doses.find(function (d) { return d.user_confirmed_at; });
    if (confirmed) times.push("retirada confirmada " + UI.formatDateTime(new Date(confirmed.user_confirmed_at)));
    const done = s.state === "user_confirmed";
    return '<li class="item' + (done ? " is-done" : "") + '">' +
      '<div class="item__main">' +
        '<span class="slot-tag">' + (done ? Icons.get("checkCircle") : UI.escapeHtml(s.time)) + "</span>" +
        "<div>" +
          '<p class="item__title">' + UI.escapeHtml(s.period.label) + ' <span class="text-xs text-subtle">' + UI.escapeHtml(s.time) + "</span></p>" +
          '<div class="chips">' + s.doses.map(function (d) { return UI.medChip(d.medication_name, Data.doseState(d)); }).join("") + "</div>" +
          (times.length ? '<p class="text-xs text-subtle">' + UI.escapeHtml(times.join(" · ")) + "</p>" : "") +
          (first.detail ? '<p class="text-xs text-subtle">' + UI.escapeHtml(DETAILS[first.detail] || first.detail) + "</p>" : "") +
        "</div>" +
      "</div>" +
      '<div class="item__actions">' + UI.doseBadge(s.state) +
        (s.state !== "actuated" ? ""
          : s.period.key === "manual"
            ? '<button type="button" class="btn btn--primary btn--sm" data-confirm-dose="' + UI.escapeHtml(first.id) + '">Retirei</button>'
            : '<button type="button" class="btn btn--primary btn--sm" data-confirm="' + UI.escapeHtml(s.scheduledFor) +
              '" data-period="' + UI.escapeHtml(s.period.key) + '">Retirei</button>') +
      "</div></li>";
  }

  function render() {
    const wanted = resultFilter.value;
    const days = Data.dailyReport(doses).map(function (day) {
      return { date: day.date, weekday: day.weekday, slots: day.slots.filter(function (s) { return !wanted || s.state === wanted; }) };
    }).filter(function (day) { return day.slots.length; });

    if (days.length === 0) {
      list.innerHTML = UI.emptyState("history", "Nenhum registro no período",
        "Os registros aparecem quando o dispensador trata um horário programado.");
      return;
    }

    list.innerHTML = '<ul class="item-list">' + days.map(function (day) {
      const info = Data.dayOf(day.weekday);
      const date = UI.formatDate(Data.spDate(day.date, "12:00"), { day: "2-digit", month: "2-digit", year: "numeric" });
      const total = day.slots.reduce(function (n, s) { return n + s.doses.length; }, 0);
      return '<li class="item item--day"><strong>' + info.name + ", " + date + "</strong>" +
        '<span class="item__meta">Compartimento ' + Data.compartmentOf(day.weekday) + " · " + total + (total === 1 ? " medicamento" : " medicamentos") + "</span></li>" +
        day.slots.map(slotHtml).join("");
    }).join("") + "</ul>";
  }

  async function load() {
    try {
      doses = await Data.listDoses(Data.startOfDay(-Number(periodFilter.value) + 1));
      UI.clearAlert(pageMessage);
      render();
    } catch (error) {
      const info = Data.describeError(error);
      list.innerHTML = "";
      UI.showAlert(pageMessage, "danger", info.title, info.message);
    }
  }

  list.addEventListener("click", async function (event) {
    const button = event.target.closest("button[data-confirm], button[data-confirm-dose]");
    if (!button) return;
    const doseId = button.getAttribute("data-confirm-dose");
    const ok = await UI.confirm({
      title: "Você retirou os medicamentos?",
      message: doseId
        ? "Confirme somente se você pegou o medicamento desta liberação manual."
        : "Confirme somente se você pegou os medicamentos deste período no dispensador.",
      confirmText: "Sim, retirei"
    });
    if (!ok) return;
    UI.setButtonLoading(button, true);
    try {
      if (doseId) await Data.confirmDose(doseId);
      else await Data.confirmSlot(button.getAttribute("data-confirm"), button.getAttribute("data-period"));
      UI.toast("Retirada confirmada.", "success");
      await load();
    } catch (error) {
      UI.setButtonLoading(button, false);
      const info = Data.describeError(error);
      UI.toast(info.title + ". " + info.message, "danger");
    }
  });

  periodFilter.addEventListener("change", load);
  resultFilter.addEventListener("change", render);

  Auth.ready.then(function () {
    load();
    Data.subscribe(["doses"], load);  // tempo real
    setInterval(function () { if (!document.hidden) load(); }, REFRESH_MS);
  });
})();
