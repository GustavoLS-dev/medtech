/* ==========================================================================
   MedTech — data.js
   Acesso às tabelas e funções do Supabase (supabase/01 a 04).
   Todas as consultas usam a sessão do usuário: o RLS do banco garante que
   cada conta só lê e altera as próprias linhas.

   Organizador: um compartimento por DIA (servo 0 = segunda ... 6 = domingo)
   e três períodos por dia (manhã, tarde, noite). O horário de cada período
   fica na configuração do dispensador. Cápsulas saem pela gaveta do dia;
   líquidos saem pela bomba (relé).
   Depende de: supabase-config.js, auth.js
   ========================================================================== */

const Data = (function () {
  // O ESP32 consulta a cada 15 s; sem contato por 90 s, mostramos "sem comunicação".
  const ONLINE_SECONDS = 90;

  // weekday segue o JavaScript e o banco: 0 = domingo ... 6 = sábado.
  // A ordem abaixo é a do organizador físico (servo 0 = segunda).
  const DAYS = [
    { weekday: 1, short: "Seg", name: "Segunda" },
    { weekday: 2, short: "Ter", name: "Terça" },
    { weekday: 3, short: "Qua", name: "Quarta" },
    { weekday: 4, short: "Qui", name: "Quinta" },
    { weekday: 5, short: "Sex", name: "Sexta" },
    { weekday: 6, short: "Sáb", name: "Sábado" },
    { weekday: 0, short: "Dom", name: "Domingo" }
  ];

  const PERIODS = [
    { key: "morning",   label: "Manhã", setting: "morning_time" },
    { key: "afternoon", label: "Tarde", setting: "afternoon_time" },
    { key: "night",     label: "Noite", setting: "night_time" }
  ];

  // Forma do medicamento: por onde ele sai do dispensador.
  const FORMS = {
    solid:  { key: "solid",  label: "Cápsula", icon: "pill",    exit: "gaveta do dia" },
    liquid: { key: "liquid", label: "Líquido", icon: "droplet", exit: "bomba" }
  };

  // Liberação pedida pelo botão "Liberar agora" de um medicamento (dose sem período).
  const MANUAL_PERIOD = { key: "manual", label: "Liberação manual", setting: null };

  const DEFAULT_SETTINGS = {
    morning_time: "08:00", afternoon_time: "13:00", night_time: "20:00",
    open_seconds: 60, pump_seconds: 5, automation_enabled: false, updated_at: null
  };

  const MEDICATION_FIELDS = "id,name,form,weekdays,periods,enabled,notes,updated_at";
  const SETTINGS_FIELDS = "morning_time,afternoon_time,night_time,open_seconds,pump_seconds,automation_enabled,updated_at";
  const DEVICE_FIELDS = "id,token_hint,firmware_version,last_seen_at,paired_at";
  const DOSE_FIELDS = "id,medication_id,medication_name,compartment,period,scheduled_for,status,detail,attempt_at,finished_at,user_confirmed_at";
  const EVENT_FIELDS = "id,event_type,period,scheduled_for,detail,occurred_at,received_at";
  const REQUEST_FIELDS = "id,period,medication_id,scheduled_for,status,created_at";

  // Um pedido "Liberar agora" vale por 2 minutos (mesma regra do banco).
  const REQUEST_SECONDS = 120;

  function client() {
    const c = SupabaseConfig.getClient();
    if (!c) {
      const error = new Error("Preencha a chave publicável em js/supabase-config.js.");
      error.name = "MedTechConfigError";
      throw error;
    }
    return c;
  }

  /** Lança o erro do Supabase ou devolve os dados. */
  function check(result) {
    if (result.error) throw result.error;
    return result.data;
  }

  /* ------------------------------------------------------------------ */
  /* Mensagens de erro do banco                                          */
  /* ------------------------------------------------------------------ */
  function describeError(error) {
    const code = error && error.code;
    const text = String((error && error.message) || "");

    if (code === "23514" && text.indexOf("dispenser_settings_order") !== -1) {
      return { title: "Horários fora de ordem", message: "O horário da manhã precisa ser antes do da tarde, e o da tarde antes do da noite." };
    }
    if (code === "23514") {
      return { title: "Dados recusados pelo servidor", message: "Confira o nome, os dias, os períodos e os horários." };
    }
    if (code === "42P01" || code === "42703" || code === "PGRST202" || code === "PGRST204" || code === "PGRST205") {
      return { title: "Banco desatualizado", message: "Execute no SQL Editor do Supabase os scripts de supabase/ que faltam (até o 04-liquidos-e-liberar-medicamento.sql)." };
    }
    if (code === "42501") {
      return { title: "Acesso negado", message: "Sua sessão não tem permissão para esta operação. Entre novamente." };
    }
    if (code === "P0001" || code === "22023") {
      return { title: "Operação recusada", message: text };
    }
    return Auth.describeError(error);
  }

  /* ------------------------------------------------------------------ */
  /* Organizador                                                        */
  /* ------------------------------------------------------------------ */
  /** Compartimento físico do dia: segunda = 1 ... domingo = 7 (servo = compartimento − 1). */
  function compartmentOf(weekday) {
    return weekday === 0 ? 7 : weekday;
  }

  function dayOf(weekday) {
    return DAYS.find(function (d) { return d.weekday === weekday; });
  }

  function periodOf(key) {
    return PERIODS.find(function (p) { return p.key === key; }) || { key: key, label: key, setting: null };
  }

  function formOf(key) {
    return FORMS[key] || FORMS.solid;
  }

  function periodTime(settings, key) {
    const period = periodOf(key);
    return period.setting ? settings[period.setting] : "";
  }

  /** Medicamentos ativos de um dia e período. */
  function medicationsFor(medications, weekday, period) {
    return medications.filter(function (m) {
      return m.enabled && m.weekdays.indexOf(weekday) !== -1 && (m.periods || []).indexOf(period) !== -1;
    });
  }

  /* ------------------------------------------------------------------ */
  /* Medicamentos                                                       */
  /* ------------------------------------------------------------------ */
  async function listMedications() {
    return check(await client().from("medications").select(MEDICATION_FIELDS).order("name"));
  }

  /** Cria (sem id) ou atualiza um medicamento. values: name, weekdays, periods, enabled, notes. */
  async function saveMedication(values, id) {
    const query = id
      ? client().from("medications").update(values).eq("id", id)
      : client().from("medications").insert(values);
    return check(await query.select(MEDICATION_FIELDS).single());
  }

  async function setMedicationEnabled(id, enabled) {
    return check(await client().from("medications").update({ enabled: enabled }).eq("id", id)
      .select(MEDICATION_FIELDS).single());
  }

  async function deleteMedication(id) {
    check(await client().from("medications").delete().eq("id", id));
  }

  /* ------------------------------------------------------------------ */
  /* Configuração do dispensador                                        */
  /* ------------------------------------------------------------------ */
  async function getSettings() {
    const row = check(await client().from("dispenser_settings").select(SETTINGS_FIELDS).maybeSingle());
    return Object.assign({}, DEFAULT_SETTINGS, row || {});
  }

  /** Grava a configuração (cria a linha da conta na primeira vez). */
  async function saveSettings(values) {
    const updated = check(await client().from("dispenser_settings").update(values)
      .not("user_id", "is", null).select(SETTINGS_FIELDS));
    if (updated.length) return Object.assign({}, DEFAULT_SETTINGS, updated[0]);
    const inserted = check(await client().from("dispenser_settings")
      .insert(Object.assign({}, pick(DEFAULT_SETTINGS), values)).select(SETTINGS_FIELDS).single());
    return Object.assign({}, DEFAULT_SETTINGS, inserted);
  }

  function pick(settings) {
    return {
      morning_time: settings.morning_time, afternoon_time: settings.afternoon_time, night_time: settings.night_time,
      open_seconds: settings.open_seconds, pump_seconds: settings.pump_seconds,
      automation_enabled: settings.automation_enabled
    };
  }

  /* ------------------------------------------------------------------ */
  /* Dispositivo                                                        */
  /* ------------------------------------------------------------------ */
  async function getDevice() {
    return check(await client().from("devices").select(DEVICE_FIELDS).maybeSingle());
  }

  /**
   * Gera a chave do ESP32 no navegador (32 bytes aleatórios → 64 hexadecimais)
   * e grava só o hash no servidor. A chave é devolvida para ser mostrada UMA vez.
   */
  async function pairDevice() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const token = Array.from(bytes, function (b) { return b.toString(16).padStart(2, "0"); }).join("");
    check(await client().rpc("medtech_pair_device", { p_token: token }));
    return token;
  }

  async function unpairDevice() {
    check(await client().rpc("medtech_unpair_device"));
  }

  /** Estado da comunicação a partir do último contato. */
  function connection(device) {
    if (!device) return { key: "none", dot: "unknown", label: "Nenhum dispositivo vinculado" };
    if (!device.last_seen_at) return { key: "waiting", dot: "unknown", label: "Aguardando a primeira conexão" };
    const age = (Date.now() - new Date(device.last_seen_at).getTime()) / 1000;
    if (age <= ONLINE_SECONDS) return { key: "online", dot: "online", label: "Comunicação recente" };
    return { key: "offline", dot: "offline", label: "Sem comunicação recente" };
  }

  async function listDeviceEvents(limit) {
    return check(await client().from("device_events").select(EVENT_FIELDS)
      .order("received_at", { ascending: false }).limit(limit || 20));
  }

  /* ------------------------------------------------------------------ */
  /* Doses                                                              */
  /* ------------------------------------------------------------------ */
  async function listDoses(since, until) {
    let query = client().from("doses").select(DOSE_FIELDS).gte("scheduled_for", since.toISOString());
    if (until) query = query.lt("scheduled_for", until.toISOString());
    return check(await query.order("scheduled_for", { ascending: false }).limit(500));
  }

  /** Confirma a retirada de uma dose acionada (liberação manual). */
  async function confirmDose(id) {
    return check(await client().rpc("medtech_confirm_dose", { p_dose_id: id }));
  }

  /** Confirma a retirada de todas as doses acionadas de um horário. */
  async function confirmSlot(scheduledFor, period) {
    return check(await client().rpc("medtech_confirm_slot", { p_scheduled_for: scheduledFor, p_period: period }));
  }

  /* ------------------------------------------------------------------ */
  /* "Liberar agora"                                                    */
  /* ------------------------------------------------------------------ */
  /** Pede ao dispensador para liberar agora o período de hoje (o servidor calcula o horário). */
  async function requestDispense(period) {
    return check(await client().rpc("medtech_request_dispense", { p_period: period }));
  }

  /**
   * Pede ao dispensador para liberar agora um medicamento, a qualquer hora.
   * Cápsula: abre o compartimento do dia. Líquido: liga a bomba.
   * Não marca o horário programado como tratado.
   */
  async function requestMedication(medicationId) {
    return check(await client().rpc("medtech_request_medication", { p_medication_id: medicationId }));
  }

  /**
   * Texto da confirmação do "Liberar agora" de um medicamento.
   * Cápsula: abre, um por vez, o compartimento de cada dia dele (supabase/05).
   */
  function releaseText(med, settings) {
    if (med.form === "liquid") {
      return {
        title: "Liberar " + med.name + " agora?",
        message: "Em até 15 segundos o dispensador liga a bomba por " + settings.pump_seconds +
          " s. Isso não conta como o horário programado."
      };
    }
    const days = DAYS.filter(function (d) { return med.weekdays.indexOf(d.weekday) !== -1; });
    const names = days.map(function (d) { return d.name.toLowerCase(); });
    const list = names.length > 1 ? names.slice(0, -1).join(", ") + " e " + names[names.length - 1] : names[0];
    return {
      title: "Liberar " + med.name + " agora?",
      message: "Em até 15 segundos o dispensador abre, um por vez, " +
        (days.length > 1 ? "os compartimentos de " : "o compartimento de ") + list +
        ". Cada um fica aberto " + settings.open_seconds + " s" +
        (days.length > 1 ? " (cerca de " + Math.ceil(days.length * (settings.open_seconds + 3) / 60) + " min no total)" : "") +
        ". Isso não conta como o horário programado."
    };
  }

  /** Pedidos ainda válidos (pendentes ou em andamento). */
  async function listActiveRequests() {
    const since = new Date(Date.now() - REQUEST_SECONDS * 1000).toISOString();
    return check(await client().from("dispense_requests").select(REQUEST_FIELDS)
      .gte("created_at", since).in("status", ["pending", "taken"]).order("created_at", { ascending: false }));
  }

  /* ------------------------------------------------------------------ */
  /* Tempo real (Supabase Realtime)                                     */
  /* O RLS vale também aqui: cada conta só recebe as próprias linhas.    */
  /* ------------------------------------------------------------------ */
  /**
   * Chama onChange (no máximo uma vez a cada 400 ms) quando alguma das
   * tabelas muda. Devolve uma função para cancelar.
   */
  function subscribe(tables, onChange) {
    let timer = null;
    const notify = function () {
      clearTimeout(timer);
      timer = setTimeout(onChange, 400);
    };
    let channel;
    try {
      channel = client().channel("medtech-" + Math.random().toString(36).slice(2));
      tables.forEach(function (table) {
        channel.on("postgres_changes", { event: "*", schema: "public", table: table }, notify);
      });
      channel.subscribe();
    } catch (e) {
      // Sem Realtime, as páginas continuam se atualizando pelo intervalo.
      return function () {};
    }
    return function () { client().removeChannel(channel); };
  }

  /** Chave de UI.DOSE_STATES para uma dose registrada. */
  function doseState(dose) {
    if (!dose) return "unknown";
    if (dose.user_confirmed_at) return "user_confirmed";
    return dose.status;
  }

  /** Estado de um horário (todas as doses dele mudam juntas). */
  function slotState(doses) {
    if (!doses.length) return "unknown";
    if (doses.every(function (d) { return d.user_confirmed_at; })) return "user_confirmed";
    const open = doses.find(function (d) { return !d.user_confirmed_at; });
    return open.status;
  }

  /* ------------------------------------------------------------------ */
  /* Datas em America/Sao_Paulo                                          */
  /* O Brasil não tem horário de verão desde 2019: o fuso é sempre -03:00 */
  /* (o firmware usa a mesma regra).                                     */
  /* ------------------------------------------------------------------ */
  const SP_OFFSET = "-03:00";

  /** { date: "2026-10-18", weekday: 0..6, time: "14:05" } do instante informado. */
  function spParts(date) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: UI.TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short"
    }).formatToParts(date);
    const get = function (type) { return parts.find(function (p) { return p.type === type; }).value; };
    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
    return { date: get("year") + "-" + get("month") + "-" + get("day"), weekday: weekday, time: get("hour") + ":" + get("minute") };
  }

  function spDate(isoDate, time) {
    return new Date(isoDate + "T" + (time || "00:00") + ":00" + SP_OFFSET);
  }

  /** Início do dia de hoje em São Paulo, deslocado em "days" dias. */
  function startOfDay(days) {
    const start = spDate(spParts(new Date()).date);
    start.setTime(start.getTime() + (days || 0) * 86400000);
    return start;
  }

  /**
   * Horários de hoje: cada período com medicamento programado (ou com
   * registro do aparelho), ligado às doses que o dispositivo enviou.
   */
  function todaySlots(medications, doses, settings) {
    const today = spParts(new Date());
    const now = Date.now();
    return PERIODS.map(function (period) {
      const meds = medicationsFor(medications, today.weekday, period.key);
      const slotDoses = doses.filter(function (d) {
        return d.period === period.key && spParts(new Date(d.scheduled_for)).date === today.date;
      });
      if (!meds.length && !slotDoses.length) return null;
      const time = slotDoses.length ? spParts(new Date(slotDoses[0].scheduled_for)).time : periodTime(settings, period.key);
      const when = spDate(today.date, time);
      const state = slotDoses.length ? slotState(slotDoses) : (when.getTime() > now ? "pending" : "unknown");
      // Cada medicamento com o próprio estado (para colorir o nome na tela).
      const items = slotDoses.length
        ? slotDoses.map(function (d) { return { name: d.medication_name, state: doseState(d) }; })
        : meds.map(function (m) { return { name: m.name, state: state }; });
      return {
        period: period, time: time, when: when, compartment: compartmentOf(today.weekday),
        names: items.map(function (i) { return i.name; }), items: items,
        doses: slotDoses, state: state
      };
    }).filter(Boolean);
  }

  /** Última liberação manual (dose sem período) de cada medicamento, por id. */
  function latestManual(doses) {
    const latest = {};
    doses.forEach(function (d) {
      if (d.period || !d.medication_id) return;
      const current = latest[d.medication_id];
      if (!current || d.scheduled_for > current.scheduled_for) latest[d.medication_id] = d;
    });
    return latest;
  }

  /** Relatório: doses agrupadas por dia (mais recente primeiro) e por período. */
  function dailyReport(doses) {
    const days = {};
    doses.forEach(function (d) {
      const parts = spParts(new Date(d.scheduled_for));
      const day = days[parts.date] || (days[parts.date] = { date: parts.date, weekday: parts.weekday, slots: {} });
      // Cada liberação manual é um item próprio, mesmo no mesmo minuto.
      const key = d.period ? d.period + "|" + parts.time : "manual|" + d.scheduled_for;
      const period = d.period ? periodOf(d.period) : MANUAL_PERIOD;
      const slot = day.slots[key] || (day.slots[key] = { period: period, time: parts.time, scheduledFor: d.scheduled_for, doses: [] });
      slot.doses.push(d);
    });
    return Object.keys(days).sort().reverse().map(function (date) {
      const day = days[date];
      const slots = Object.keys(day.slots).map(function (k) {
        const s = day.slots[k];
        s.state = slotState(s.doses);
        return s;
      }).sort(function (a, b) { return a.time.localeCompare(b.time) || a.scheduledFor.localeCompare(b.scheduledFor); });
      return { date: date, weekday: day.weekday, slots: slots };
    });
  }

  return {
    DAYS: DAYS,
    PERIODS: PERIODS,
    FORMS: FORMS,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    describeError: describeError,
    compartmentOf: compartmentOf,
    dayOf: dayOf,
    periodOf: periodOf,
    formOf: formOf,
    periodTime: periodTime,
    medicationsFor: medicationsFor,
    listMedications: listMedications,
    saveMedication: saveMedication,
    setMedicationEnabled: setMedicationEnabled,
    deleteMedication: deleteMedication,
    getSettings: getSettings,
    saveSettings: saveSettings,
    getDevice: getDevice,
    pairDevice: pairDevice,
    unpairDevice: unpairDevice,
    connection: connection,
    listDeviceEvents: listDeviceEvents,
    listDoses: listDoses,
    confirmDose: confirmDose,
    confirmSlot: confirmSlot,
    requestDispense: requestDispense,
    requestMedication: requestMedication,
    releaseText: releaseText,
    listActiveRequests: listActiveRequests,
    subscribe: subscribe,
    doseState: doseState,
    slotState: slotState,
    spParts: spParts,
    spDate: spDate,
    startOfDay: startOfDay,
    todaySlots: todaySlots,
    latestManual: latestManual,
    dailyReport: dailyReport
  };
})();
