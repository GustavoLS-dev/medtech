/* ==========================================================================
   MedTech — pages/programacao.js  (programacao.html)
   Configuração do dispensador (tempo da gaveta, tempo da bomba e automação)
   e a grade da semana: dias × horários dos medicamentos.
   ========================================================================== */

(function () {
  const pageMessage = document.getElementById("page-message");
  const grid = document.getElementById("week-grid");
  const settingsForm = document.getElementById("settings-form");
  const settingsMessage = document.getElementById("settings-message");
  const saveButton = document.getElementById("save-settings");
  const autoButton = document.getElementById("auto-button");
  const inputs = {
    open_seconds: document.getElementById("open-seconds"),
    pump_seconds: document.getElementById("pump-seconds")
  };

  let medications = [];
  let todayDoses = [];
  let settings = Data.DEFAULT_SETTINGS;

  // Na coluna de hoje, o nome fica colorido pelo que aconteceu (verde = retirado).
  function chipFor(med, day, time, today) {
    if (day.weekday !== today.weekday) return '<span class="chip">' + UI.escapeHtml(med.name) + "</span>";
    const dose = todayDoses.find(function (d) {
      return d.medication_id === med.id && d.period && Data.spParts(new Date(d.scheduled_for)).time === time;
    });
    return dose ? UI.medChip(med.name, Data.doseState(dose)) : '<span class="chip">' + UI.escapeHtml(med.name) + "</span>";
  }

  function renderAutomation() {
    const on = settings.automation_enabled;
    document.getElementById("auto-dot").className = "status-dot status-dot--" + (on ? "online" : "offline");
    document.getElementById("auto-label").textContent = on ? "Automação ligada" : "Automação desligada";
    document.getElementById("auto-text").textContent = on
      ? "Em cada horário dos medicamentos, o dispensador abre o compartimento do dia (cápsulas) e liga a bomba (líquidos), sem nenhum comando manual."
      : "O dispensador recebe a agenda, mas não abre nenhum compartimento nem liga a bomba. Ligue depois de testar os servos e a bomba.";
    autoButton.textContent = on ? "Desligar automação" : "Ligar automação";
    autoButton.className = "btn " + (on ? "btn--secondary" : "btn--primary");
    autoButton.disabled = false;
  }

  function renderSettings() {
    Object.keys(inputs).forEach(function (key) { inputs[key].value = settings[key]; });
  }

  function renderGrid() {
    const times = Data.timesOf(medications);
    if (times.length === 0) {
      grid.innerHTML = UI.emptyState("calendar", "Nenhum horário programado",
        "Cadastre um medicamento ativo com os dias e os horários na página Medicamentos.");
      return;
    }
    const today = Data.spParts(new Date());
    const head = "<tr><th scope=\"col\">Horário</th>" + Data.DAYS.map(function (d) {
      const isToday = d.weekday === today.weekday;
      return '<th scope="col"' + (isToday ? ' class="is-today"' : "") + ">" + d.short + (isToday ? " (hoje)" : "") +
        '<br><span class="text-xs text-subtle">servo ' + (Data.compartmentOf(d.weekday) - 1) + "</span></th>";
    }).join("") + "</tr>";
    const rows = times.map(function (t) {
      return '<tr><th scope="row">' + UI.escapeHtml(t) + '<br><span class="text-xs text-subtle">' + Data.periodOfTime(t).label + "</span></th>" +
        Data.DAYS.map(function (d) {
          const meds = Data.medicationsFor(medications, d.weekday, t);
          const cls = (d.weekday === today.weekday ? "is-today" : "") + (meds.length ? "" : " is-empty");
          return '<td class="' + cls.trim() + '">' + (meds.length
            ? meds.map(function (m) { return chipFor(m, d, t, today); }).join("")
            : "—") + "</td>";
        }).join("") + "</tr>";
    }).join("");
    // No celular a tabela larga vira uma lista: um dia por linha, com os horários dele.
    const list = '<ul class="week-list">' + Data.DAYS.map(function (d) {
      const isToday = d.weekday === today.weekday;
      const dayTimes = Data.timesOf(medications, d.weekday);
      return '<li class="week-list__day' + (isToday ? " is-today" : "") + '">' +
        '<p class="week-list__name">' + d.name + (isToday ? " (hoje)" : "") +
        ' <span class="text-xs text-subtle">servo ' + (Data.compartmentOf(d.weekday) - 1) + "</span></p>" +
        '<div class="week-list__periods">' + (dayTimes.length ? dayTimes.map(function (t) {
          const meds = Data.medicationsFor(medications, d.weekday, t);
          return '<div class="week-list__period"><span class="week-list__label">' + UI.escapeHtml(t) + "</span>" +
            meds.map(function (m) { return chipFor(m, d, t, today); }).join("") + "</div>";
        }).join("") : '<span class="text-subtle">Nada programado</span>') + "</div></li>";
    }).join("") + "</ul>";

    grid.innerHTML = '<table class="week-grid"><caption class="sr-only">Medicamentos por dia e horário</caption>' +
      '<colgroup><col class="week-grid__period"></colgroup><thead>' +
      head + "</thead><tbody>" + rows + "</tbody></table>" + list;
  }

  settingsForm.addEventListener("submit", async function (event) {
    event.preventDefault();
    const values = {
      open_seconds: Number(inputs.open_seconds.value),
      pump_seconds: Number(inputs.pump_seconds.value)
    };
    if (!Number.isInteger(values.open_seconds) || values.open_seconds < 5 || values.open_seconds > 300) {
      return UI.showAlert(settingsMessage, "danger", "Tempo inválido", "Use de 5 a 300 segundos.");
    }
    if (!Number.isInteger(values.pump_seconds) || values.pump_seconds < 1 || values.pump_seconds > 30) {
      return UI.showAlert(settingsMessage, "danger", "Tempo da bomba inválido", "Use de 1 a 30 segundos.");
    }

    UI.setButtonLoading(saveButton, true);
    try {
      settings = await Data.saveSettings(values);
      UI.clearAlert(settingsMessage);
      renderSettings();
      renderGrid();
      UI.toast("Salvo. O dispensador recebe a mudança em até 15 segundos.", "success");
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
        message: "A partir de agora, em cada horário dos medicamentos, o dispensador abre o compartimento do dia (cápsulas) e liga a bomba pelo relé (líquidos), e marca os medicamentos como tomados. Confirme que os servos e a bomba foram testados.",
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
    // Tempo real (sem atrapalhar quem está editando os horários)
    Data.subscribe(["doses", "medications", "dispenser_settings"], function () {
      if (!settingsForm.contains(document.activeElement)) load();
    });
    // Atualiza as cores da coluna de hoje sem recarregar a página.
    setInterval(function () { if (!document.hidden && !settingsForm.contains(document.activeElement)) load(); }, 30000);
  });
})();
