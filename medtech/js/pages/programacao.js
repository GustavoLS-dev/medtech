/* ==========================================================================
   MedTech — pages/programacao.js  (programacao.html)
   Configuração do organizador (horários dos períodos, tempo aberto e
   automação) e a grade da semana: dias × manhã/tarde/noite.
   ========================================================================== */

(function () {
  const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

  const pageMessage = document.getElementById("page-message");
  const grid = document.getElementById("week-grid");
  const settingsForm = document.getElementById("settings-form");
  const settingsMessage = document.getElementById("settings-message");
  const saveButton = document.getElementById("save-settings");
  const autoButton = document.getElementById("auto-button");
  const inputs = {
    morning_time: document.getElementById("morning-time"),
    afternoon_time: document.getElementById("afternoon-time"),
    night_time: document.getElementById("night-time"),
    open_seconds: document.getElementById("open-seconds")
  };

  let medications = [];
  let todayDoses = [];
  let settings = Data.DEFAULT_SETTINGS;

  // Na coluna de hoje, o nome fica colorido pelo que aconteceu (verde = retirado).
  function chipFor(med, day, period, today) {
    if (day.weekday !== today.weekday) return '<span class="chip">' + UI.escapeHtml(med.name) + "</span>";
    const dose = todayDoses.find(function (d) { return d.medication_id === med.id && d.period === period; });
    return dose ? UI.medChip(med.name, Data.doseState(dose)) : '<span class="chip">' + UI.escapeHtml(med.name) + "</span>";
  }

  function renderAutomation() {
    const on = settings.automation_enabled;
    document.getElementById("auto-dot").className = "status-dot status-dot--" + (on ? "online" : "offline");
    document.getElementById("auto-label").textContent = on ? "Automação ligada" : "Automação desligada";
    document.getElementById("auto-text").textContent = on
      ? "O dispensador abre o compartimento do dia em cada horário programado, sem nenhum comando manual."
      : "O dispensador recebe a agenda, mas não abre nenhum compartimento. Ligue depois de testar os servos.";
    autoButton.textContent = on ? "Desligar automação" : "Ligar automação";
    autoButton.className = "btn " + (on ? "btn--secondary" : "btn--primary");
    autoButton.disabled = false;
  }

  function renderSettings() {
    Object.keys(inputs).forEach(function (key) { inputs[key].value = settings[key]; });
  }

  function renderGrid() {
    if (medications.length === 0) {
      grid.innerHTML = UI.emptyState("calendar", "Nenhum medicamento cadastrado",
        "Cadastre um medicamento com os dias e os períodos na página Medicamentos.");
      return;
    }
    const today = Data.spParts(new Date());
    const head = "<tr><th scope=\"col\">Período</th>" + Data.DAYS.map(function (d) {
      const isToday = d.weekday === today.weekday;
      return '<th scope="col"' + (isToday ? ' class="is-today"' : "") + ">" + d.short + (isToday ? " (hoje)" : "") +
        '<br><span class="text-xs text-subtle">servo ' + (Data.compartmentOf(d.weekday) - 1) + "</span></th>";
    }).join("") + "</tr>";
    const rows = Data.PERIODS.map(function (p) {
      return '<tr><th scope="row">' + p.label + '<br><span class="text-xs text-subtle">' + UI.escapeHtml(Data.periodTime(settings, p.key)) + "</span></th>" +
        Data.DAYS.map(function (d) {
          const meds = Data.medicationsFor(medications, d.weekday, p.key);
          const cls = (d.weekday === today.weekday ? "is-today" : "") + (meds.length ? "" : " is-empty");
          return '<td class="' + cls.trim() + '">' + (meds.length
            ? meds.map(function (m) { return chipFor(m, d, p.key, today); }).join("")
            : "—") + "</td>";
        }).join("") + "</tr>";
    }).join("");
    grid.innerHTML = '<table class="week-grid"><caption class="sr-only">Medicamentos por dia e período</caption><thead>' +
      head + "</thead><tbody>" + rows + "</tbody></table>";
  }

  settingsForm.addEventListener("submit", async function (event) {
    event.preventDefault();
    const values = {
      morning_time: inputs.morning_time.value,
      afternoon_time: inputs.afternoon_time.value,
      night_time: inputs.night_time.value,
      open_seconds: Number(inputs.open_seconds.value)
    };
    if (![values.morning_time, values.afternoon_time, values.night_time].every(function (t) { return TIME_PATTERN.test(t); })) {
      return UI.showAlert(settingsMessage, "danger", "Horário inválido", "Preencha os três horários.");
    }
    if (!(values.morning_time < values.afternoon_time && values.afternoon_time < values.night_time)) {
      return UI.showAlert(settingsMessage, "danger", "Horários fora de ordem", "A manhã precisa vir antes da tarde, e a tarde antes da noite.");
    }
    if (!Number.isInteger(values.open_seconds) || values.open_seconds < 5 || values.open_seconds > 300) {
      return UI.showAlert(settingsMessage, "danger", "Tempo inválido", "Use de 5 a 300 segundos.");
    }

    UI.setButtonLoading(saveButton, true);
    try {
      settings = await Data.saveSettings(values);
      UI.clearAlert(settingsMessage);
      renderSettings();
      renderGrid();
      UI.toast("Horários salvos. O dispensador recebe a mudança em até 30 segundos.", "success");
    } catch (error) {
      const info = Data.describeError(error);
      UI.showAlert(settingsMessage, "danger", info.title, info.message);
    } finally {
      UI.setButtonLoading(saveButton, false);
    }
  });

  autoButton.addEventListener("click", async function () {
    const turningOn = !settings.automation_enabled;
    if (turningOn) {
      const ok = await UI.confirm({
        title: "Ligar a automação?",
        message: "A partir de agora o dispensador abre o compartimento do dia em cada horário programado. Confirme que os servos foram testados e que a bomba está desconectada.",
        confirmText: "Ligar automação"
      });
      if (!ok) return;
    }
    UI.setButtonLoading(autoButton, true);
    try {
      settings = await Data.saveSettings({ automation_enabled: turningOn });
      UI.toast(turningOn ? "Automação ligada." : "Automação desligada.", "success");
    } catch (error) {
      const info = Data.describeError(error);
      UI.toast(info.title + ". " + info.message, "danger");
    } finally {
      UI.setButtonLoading(autoButton, false);
      renderAutomation();
    }
  });

  async function load() {
    try {
      const results = await Promise.all([
        Data.listMedications(), Data.getSettings(), Data.listDoses(Data.startOfDay(0), Data.startOfDay(1))
      ]);
      medications = results[0];
      settings = results[1];
      todayDoses = results[2];
      UI.clearAlert(pageMessage);
      renderAutomation();
      renderSettings();
      renderGrid();
    } catch (error) {
      const info = Data.describeError(error);
      grid.innerHTML = "";
      UI.showAlert(pageMessage, "danger", info.title, info.message);
    }
  }

  Auth.ready.then(function () {
    load();
    // Atualiza as cores da coluna de hoje sem recarregar a página.
    setInterval(function () { if (!document.hidden && !settingsForm.contains(document.activeElement)) load(); }, 30000);
  });
})();
