// Testa a lógica de medtech/js/data.js (horários de hoje, relatório diário,
// conexão) carregando o mesmo arquivo do navegador num contexto isolado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function carregarData() {
  const fonte = await readFile(new URL('../medtech/js/data.js', import.meta.url), 'utf8');
  const contexto = { UI: { TIMEZONE: 'America/Sao_Paulo' }, SupabaseConfig: {}, Auth: {}, Intl, Date, crypto };
  vm.createContext(contexto);
  vm.runInContext(fonte + '\n;globalThis.Data = Data;', contexto);
  return contexto.Data;
}

// Valores criados no contexto do vm têm outro protótipo de Array: normaliza antes de comparar.
const puro = valor => JSON.parse(JSON.stringify(valor));

const TODOS = [0, 1, 2, 3, 4, 5, 6];
// 00:00 sempre no passado e 23:59 sempre no futuro (exceto exatamente à meia-noite).
const remedio = (valores = {}) => ({ id: 'm1', name: 'Losartana', weekdays: TODOS, times: ['00:00'], enabled: true, ...valores });
const CONFIG = { open_seconds: 60, pump_seconds: 5, automation_enabled: true };

test('compartimento do dia: segunda = 1 (servo 0) ... domingo = 7 (servo 6)', async () => {
  const Data = await carregarData();
  assert.deepEqual(puro(Data.DAYS.map(d => Data.compartmentOf(d.weekday))), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(puro(Data.DAYS.map(d => d.short)), ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom']);
});

test('hoje: um item por hora dos medicamentos, passado sem registro e futuro pendente', async () => {
  const Data = await carregarData();
  const slots = Data.todaySlots([
    remedio({ times: ['00:00', '23:59'] }),
    remedio({ id: 'm2', name: 'Vitamina', times: ['23:59', '13:30'] })
  ], [], CONFIG);
  assert.deepEqual(puro(slots.map(s => [s.time, s.period.label, s.names.join('+')])), [
    ['00:00', 'Manhã', 'Losartana'],
    ['13:30', 'Tarde', 'Vitamina'],
    ['23:59', 'Noite', 'Losartana+Vitamina']
  ]);
  assert.equal(slots[0].state, 'unknown');
  assert.equal(slots[2].state, 'pending');
  const hoje = Data.spParts(new Date()).weekday;
  assert.equal(slots[0].compartment, hoje === 0 ? 7 : hoje);
});

test('hoje: registros do aparelho e confirmação do usuário', async () => {
  const Data = await carregarData();
  const hoje = Data.spParts(new Date()).date;
  const quando = new Date(`${hoje}T00:00:00-03:00`).toISOString();
  const dose = (id, nome, extra = {}) => ({ id, medication_id: id, medication_name: nome, period: 'morning', scheduled_for: quando, status: 'actuated', user_confirmed_at: null, ...extra });

  let slots = Data.todaySlots([remedio()], [dose('d1', 'Losartana'), dose('d2', 'Antigo')], CONFIG);
  assert.equal(slots[0].state, 'actuated');
  assert.deepEqual(puro(slots[0].names), ['Losartana', 'Antigo'], 'mostra o que foi registrado, mesmo se a programação mudou');

  const agora = new Date().toISOString();
  slots = Data.todaySlots([remedio()], [dose('d1', 'Losartana', { user_confirmed_at: agora }), dose('d2', 'Antigo', { user_confirmed_at: agora })], CONFIG);
  assert.equal(slots[0].state, 'user_confirmed');

  // Cada nome tem o próprio estado: um confirmado (verde) e outro ainda não.
  slots = Data.todaySlots([remedio()], [dose('d1', 'Losartana', { user_confirmed_at: agora }), dose('d2', 'Antigo')], CONFIG);
  assert.deepEqual(puro(slots[0].items), [{ name: 'Losartana', state: 'user_confirmed' }, { name: 'Antigo', state: 'actuated' }]);
  assert.equal(slots[0].state, 'actuated', 'o horário só fica verde quando todos foram retirados');
});

test('hoje: pausados e dias fora da programação não aparecem', async () => {
  const Data = await carregarData();
  const hoje = Data.spParts(new Date()).weekday;
  assert.equal(Data.todaySlots([remedio({ enabled: false })], [], CONFIG).length, 0);
  assert.equal(Data.todaySlots([remedio({ weekdays: [(hoje + 1) % 7] })], [], CONFIG).length, 0);
  assert.equal(Data.todaySlots([remedio({ times: [] })], [], CONFIG).length, 0);
});

test('horários: rótulo pela hora e lista da semana sem repetir', async () => {
  const Data = await carregarData();
  assert.deepEqual(puro(['00:00', '11:59', '12:00', '17:59', '18:00', '23:59'].map(t => Data.periodOfTime(t).key)),
    ['morning', 'morning', 'afternoon', 'afternoon', 'night', 'night']);
  const meds = [remedio({ times: ['21:00', '08:30'] }), remedio({ id: 'm2', times: ['08:30'], weekdays: [1] }),
    remedio({ id: 'm3', times: ['06:00'], enabled: false })];
  assert.deepEqual(puro(Data.timesOf(meds)), ['08:30', '21:00']);
  assert.deepEqual(puro(Data.medicationsFor(meds, 1, '08:30').map(m => m.id)), ['m1', 'm2']);
  assert.deepEqual(puro(Data.medicationsFor(meds, 2, '08:30').map(m => m.id)), ['m1']);
});

test('relatório diário: agrupa por dia (mais recente primeiro) e por período', async () => {
  const Data = await carregarData();
  const d = (id, quando, period, status) => ({ id, medication_name: id, period, scheduled_for: quando, status, user_confirmed_at: null });
  const relatorio = Data.dailyReport([
    d('A', '2026-10-19T11:00:00Z', 'morning', 'actuated'),   // seg 08:00
    d('B', '2026-10-19T11:00:00Z', 'morning', 'actuated'),
    d('C', '2026-10-19T23:00:00Z', 'night', 'missed'),       // seg 20:00
    d('D', '2026-10-18T16:00:00Z', 'afternoon', 'failed')    // dom 13:00
  ]);
  assert.deepEqual(puro(relatorio.map(r => [r.date, r.weekday, r.slots.map(s => `${s.period.key} ${s.time} ${s.state} ${s.doses.length}`)])), [
    ['2026-10-19', 1, ['morning 08:00 actuated 2', 'night 20:00 missed 1']],
    ['2026-10-18', 0, ['afternoon 13:00 failed 1']]
  ]);
});

test('estado da conexão pelo último contato', async () => {
  const Data = await carregarData();
  assert.equal(Data.connection(null).key, 'none');
  assert.equal(Data.connection({ last_seen_at: null }).key, 'waiting');
  assert.equal(Data.connection({ last_seen_at: new Date(Date.now() - 30000).toISOString() }).key, 'online');
  assert.equal(Data.connection({ last_seen_at: new Date(Date.now() - 120000).toISOString() }).key, 'offline');
});

test('fuso de São Paulo e início do dia', async () => {
  const Data = await carregarData();
  const partes = Data.spParts(new Date('2026-10-18T02:30:00Z'));  // 23:30 do dia 17 em Brasília
  assert.deepEqual({ ...partes }, { date: '2026-10-17', weekday: 6, time: '23:30' });
  const inicio = Data.startOfDay(0);
  assert.equal(Data.spParts(inicio).time, '00:00');
  assert.equal(Data.startOfDay(1) - inicio, 86400000);
});

test('relatório: cada liberação manual é um item próprio, sem período', async () => {
  const Data = await carregarData();
  const d = (id, quando, period) => ({ id, medication_id: id, medication_name: id, period, scheduled_for: quando, status: 'actuated', user_confirmed_at: null });
  const relatorio = Data.dailyReport([
    d('Xarope', '2026-10-19T13:05:10.5Z', null),             // seg 10:05, manual
    d('Losartana', '2026-10-19T13:05:40.1Z', null),          // mesmo minuto, outro pedido
    d('A', '2026-10-19T11:00:00Z', 'morning')
  ]);
  assert.deepEqual(puro(relatorio[0].slots.map(s => `${s.period.key} ${s.period.label} ${s.time} ${s.doses.map(x => x.id)}`)), [
    'morning Manhã 08:00 A',
    'manual Liberação manual 10:05 Xarope',
    'manual Liberação manual 10:05 Losartana'
  ]);
});

test('hoje: liberações manuais não entram nos horários e a última fica por medicamento', async () => {
  const Data = await carregarData();
  const hoje = Data.spParts(new Date()).date;
  const manual = (id, med, hora) => ({ id, medication_id: med, medication_name: med, period: null,
    scheduled_for: new Date(`${hoje}T${hora}:00-03:00`).toISOString(), status: 'actuated', user_confirmed_at: null });
  const doses = [manual('d1', 'm1', '00:01'), manual('d2', 'm1', '00:02'), manual('d3', 'm2', '00:01')];

  const slots = Data.todaySlots([remedio()], doses, CONFIG);
  assert.equal(slots[0].doses.length, 0, 'a manhã continua sem registro');
  const ultimas = Data.latestManual(doses);
  assert.equal(ultimas.m1.id, 'd2');
  assert.equal(ultimas.m2.id, 'd3');
});

test('confirmação do "Liberar agora": bomba para líquido, todos os dias para cápsula', async () => {
  const Data = await carregarData();
  const conf = { ...CONFIG, pump_seconds: 7 };
  assert.match(Data.releaseText(remedio({ form: 'liquid' }), conf).message, /liga a bomba por 7 s/);

  const todos = Data.releaseText(remedio(), conf).message;
  assert.ok(todos.includes('os compartimentos de segunda, terça, quarta, quinta, sexta, sábado e domingo'), todos);
  assert.ok(todos.includes('cerca de 8 min'), 'tempo total com 60 s por dia');

  const um = Data.releaseText(remedio({ weekdays: [2] }), conf).message;
  assert.ok(um.includes('o compartimento de terça. Cada um fica aberto 60 s.'), um);
  assert.equal(Data.formOf('liquid').label, 'Líquido');
  assert.equal(Data.formOf(undefined).key, 'solid');
});
