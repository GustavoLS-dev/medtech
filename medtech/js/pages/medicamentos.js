/* ==========================================================================
   MedTech — pages/medicamentos.js  (medicamentos.html)
   Cadastro, edição, pausa e exclusão dos medicamentos. Cada medicamento
   tem os dias (compartimentos do organizador) e os próprios horários.
   A validação aqui só ajuda o usuário: o banco valida tudo de novo.
   ========================================================================== */

(function () {
  const form = document.getElementById("med-form");
  const formCard = document.getElementById("med-form-card");
  const formTitle = document.getElementById("med-form-title");
  const formMessage = document.getElementById("form-message");
  const pageMessage = document.getElementById("page-message");
  const nameInput = document.getElementById("med-name");
  const daysBox = document.getElementById("med-days");
  const timesBox = document.getElementById("med-times");
  const addTimeButton = document.getElementById("add-time");
  const formBox = document.getElementById("med-form-type");
  const enabledInput = document.getElementById("med-enabled");
  const notesInput = document.getElementById("med-notes");
  const saveButton = document.getElementById("save-med");
  const newButton = document.getElementById("new-med");
  const list = document.getElementById("med-list");

  let medications = [];
  let requests = [];
  let settings = Data.DEFAULT_SETTINGS;
  let editingId = null;

  /* ------------------------------------------------------------------ */
  /* Formulário                                                         */
  /* ------------------------------------------------------------------ */
  function renderChoices(box, items, selected) {
    box.querySelectorAll("label").forEach(function (l) { l.remove(); });
    items.forEach(function (item) {
      const label = document.createElement("label");
      label.innerHTML = '<input type="checkbox"><span></span>';
      const input = label.querySelector("input");
      input.value = String(item.value);
      input.checked = selected.indexOf(item.value) !== -1;
      label.querySelector("span").textContent = item.label;
      box.appendChild(label);
    });
  }

  function renderDays(selected) {
    renderChoices(daysBox, Data.DAYS.map(function (d) { return { value: d.weekday, label: d.short }; }), selected);
  }

  // Horários: uma linha (campo + remover) por horário, até MAX_TIMES (limite do banco).
  const MAX_TIMES = 12;

  function timeInputs() {
    return Array.from(timesBox.querySelectorAll('input[type="time"]'));
  }

  function updateTimeButtons() {
    const rows = timeInputs().length;
    timesBox.querySelectorAll("button[data-remove-time]").forEach(function (b) { b.disabled = rows === 1; });
    addTimeButton.hidden = rows >= MAX_TIMES;
  }

  function addTimeRow(value) {
    const row = document.createElement("div");
    row.className = "time-list__item";
    row.innerHTML = '<input class="input" type="time" step="60" required aria-label="Horário">' +
      '<button type="button" class="btn btn--ghost btn--sm" data-remove-time aria-label="Remover horário">' + Icons.get("x") + "</button>";
    const input = row.querySelector("input");
    input.value = value || "";
    timesBox.insertBefore(row, addTimeButton);
    updateTimeButtons();
    return input;
  }

  function renderTimes(times) {
    timesBox.querySelectorAll(".time-list__item").forEach(function (r) { r.remove(); });
    (times && times.length ? times : ["08:00"]).forEach(addTimeRow);
  }

  addTimeButton.addEventListener("click", function () { addTimeRow("").focus(); });
  timesBox.addEventListener("click", function (event) {
    const remove = event.target.closest("button[data-remove-time]");
    if (!remove || timeInputs().length === 1) return;
    remove.closest(".time-list__item").remove();
    updateTimeButtons();
  });

  function openForm(med) {
    editingId = med ? med.id : null;
    UI.clearAlert(formMessage);
    [nameInput, daysBox, timesBox].forEach(Validation.clearError);

    formTitle.lastChild.textContent = med ? "Editar medicamento" : "Novo medicamento";
    nameInput.value = med ? med.name : "";
    const formValue = med ? med.form : "solid";
    formBox.querySelectorAll("input").forEach(function (i) { i.checked = i.value === formValue; });
    renderDays(med ? med.weekdays : [1, 2, 3, 4, 5, 6, 0]);
    renderTimes(med ? med.times : null);
    enabledInput.checked = med ? med.enabled : true;
    notesInput.value = med && med.notes ? med.notes : "";

    formCard.hidden = false;
    formCard.scrollIntoView({ behavior: "smooth", block: "start" });
    nameInput.focus({ preventScroll: true });
  }

  function closeForm() {
    formCard.hidden = true;
    editingId = null;
  }

  function checkedValues(box) {
    return Array.from(box.querySelectorAll("input:checked")).map(function (i) { return i.value; });
  }

  /** Lê e valida o formulário. Devolve os valores ou null (com erros exibidos). */
  function readForm() {
    let firstInvalid = null;
    function fail(element, message) {
      Validation.showError(element, message);
      if (!firstInvalid) firstInvalid = element.matches("input") ? element : element.querySelector("input");
    }

    const name = nameInput.value.trim();
    if (!name) fail(nameInput, "Informe o nome do medicamento.");
    else if (name.length > 80) fail(nameInput, "Use no máximo 80 caracteres.");
    else Validation.clearError(nameInput);

    const weekdays = checkedValues(daysBox).map(Number);
    if (weekdays.length === 0) fail(daysBox, "Escolha pelo menos um dia.");
    else Validation.clearError(daysBox);

    const times = timeInputs().map(function (i) { return i.value; });
    if (times.some(function (t) { return !/^([01]\d|2[0-3]):[0-5]\d$/.test(t); })) {
      fail(timesBox, "Preencha cada horário (ou remova o que estiver vazio).");
    } else if (new Set(times).size !== times.length) {
      fail(timesBox, "Há horários repetidos.");
    } else Validation.clearError(timesBox);

    if (firstInvalid) {
      firstInvalid.focus();
      return null;
    }
    return {
      name: name,
      form: formBox.querySelector("input:checked").value,
      weekdays: weekdays,
      times: times.sort(),
      enabled: enabledInput.checked,
      notes: notesInput.value.trim() || null
    };
  }

  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    const values = readForm();
    if (!values) return;

    UI.setButtonLoading(saveButton, true);
    try {
      await Data.saveMedication(values, editingId);
      UI.toast(editingId ? "Medicamento atualizado." : "Medicamento cadastrado.", "success");
      closeForm();
      await load();
    } catch (error) {
      const info = Data.describeError(error);
      UI.showAlert(formMessage, "danger", info.title, info.message);
    } finally {
      UI.setButtonLoading(saveButton, false);
    }
  });

  document.getElementById("cancel-med").addEventListener("click", closeForm);
  newButton.addEventListener("click", function () { openForm(null); });

  /* ------------------------------------------------------------------ */
  /* Lista                                                              */
  /* ------------------------------------------------------------------ */
  function daysText(weekdays) {
    if (weekdays.length === 7) return "Todos os dias";
    return Data.DAYS.filter(function (d) { return weekdays.indexOf(d.weekday) !== -1; })
      .map(function (d) { return d.short; }).join(", ");
  }

  function renderList() {
    document.getElementById("med-count").textContent =
      medications.length + (medications.length === 1 ? " medicamento" : " medicamentos");
    newButton.disabled = false;

    if (medications.length === 0) {
      list.innerHTML = UI.emptyState("pill", "Nenhum medicamento cadastrado",
        "Clique em “Novo medicamento” para escolher os dias e os horários.");
      return;
    }

    list.innerHTML = '<ul class="item-list">' + medications.map(function (m) {
      const times = (m.times || []).map(function (t) {
        return '<span class="chip">' + UI.escapeHtml(t) + "</span>";
      }).join("");
      const medForm = Data.formOf(m.form);
      const waiting = requests.some(function (r) { return r.medication_id === m.id; });
      return '<li class="item' + (m.enabled ? "" : " is-paused") + '" data-id="' + UI.escapeHtml(m.id) + '">' +
        '<div class="item__main">' +
          '<span class="slot-tag" aria-hidden="true">' + Icons.get(medForm.icon) + "</span>" +
          "<div>" +
            '<p class="item__title">' + UI.escapeHtml(m.name) + ' <span class="text-xs text-subtle">' + medForm.label + "</span></p>" +
            '<p class="item__meta">' + UI.escapeHtml(daysText(m.weekdays)) + "</p>" +
            '<div class="chips">' + (times || '<span class="chip">Sem horário: não será liberado</span>') + "</div>" +
          "</div>" +
        "</div>" +
        '<div class="item__actions">' +
          (m.enabled ? '<span class="badge badge--success">Ativo</span>' : '<span class="badge badge--neutral">Pausado</span>') +
          (waiting
            ? '<span class="badge badge--info"><span class="spinner spinner--sm" aria-hidden="true"></span>Aguardando o dispensador…</span>'
            : '<button type="button" class="btn btn--primary btn--sm" data-action="dispense">' + Icons.get(medForm.icon) + "Liberar agora</button>") +
          '<button type="button" class="btn btn--secondary btn--sm" data-action="toggle">' + (m.enabled ? "Pausar" : "Retomar") + "</button>" +
          '<button type="button" class="btn btn--ghost btn--sm" data-action="edit">Editar</button>' +
          '<button type="button" class="btn btn--ghost btn--sm" data-action="delete">Excluir</button>' +
        "</div>" +
      "</li>";
    }).join("") + "</ul>";
  }

  list.addEventListener("click", async function (event) {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const id = button.closest(".item").getAttribute("data-id");
    const med = medications.find(function (m) { return m.id === id; });
    if (!med) return;
    const action = button.getAttribute("data-action");

    if (action === "edit") return openForm(med);

    if (action === "dispense") {
      const ok = await UI.confirm(Object.assign({ confirmText: "Liberar agora" }, Data.releaseText(med, settings)));
      if (!ok) return;
    }

    if (action === "delete") {
      const ok = await UI.confirm({
        title: "Excluir " + med.name + "?",
        message: "Ele deixa de fazer parte dos horários do organizador. O histórico de doses é mantido.",
        confirmText: "Excluir",
        danger: true
      });
      if (!ok) return;
    }

    UI.setButtonLoading(button, true);
    try {
      if (action === "dispense") {
        await Data.requestMedication(id);
        UI.toast("Pedido enviado ao dispensador.", "success");
      } else if (action === "delete") {
        await Data.deleteMedication(id);
        UI.toast("Medicamento excluído.", "success");
      } else {
        await Data.setMedicationEnabled(id, !med.enabled);
        UI.toast(med.enabled ? "Medicamento pausado." : "Medicamento retomado.", "success");
      }
      await load();
    } catch (error) {
      UI.setButtonLoading(button, false);
      const info = Data.describeError(error);
      UI.toast(info.title + ". " + info.message, "danger");
    }
  });

  /* ------------------------------------------------------------------ */
  /* Carregamento                                                       */
  /* ------------------------------------------------------------------ */
  async function load() {
    try {
      const results = await Promise.all([Data.listMedications(), Data.getSettings(), Data.listActiveRequests()]);
      medications = results[0];
      settings = results[1];
      requests = results[2];
      UI.clearAlert(pageMessage);
      renderList();
    } catch (error) {
      const info = Data.describeError(error);
      list.innerHTML = "";
      newButton.disabled = true;
      UI.showAlert(pageMessage, "danger", info.title, info.message);
    }
  }

  Auth.ready.then(async function () {
    await load();
    // Atalho vindo de outras páginas: medicamentos.html?editar=<id>
    const editId = new URLSearchParams(window.location.search).get("editar");
    const med = medications.find(function (m) { return m.id === editId; });
    if (med) openForm(med);
    // Tempo real: o botão volta quando o dispensador termina o pedido.
    Data.subscribe(["dispense_requests", "medications", "dispenser_settings"], load);
    // Reserva: um pedido não atendido expira em 2 min sem gerar evento.
    setInterval(function () { if (!document.hidden) load(); }, 15000);
  });
})();
