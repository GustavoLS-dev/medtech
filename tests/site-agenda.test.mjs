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
const remedio = (valores = {}) => ({ id: 'm1', name: 'Losartana', weekdays: TODOS, periods: ['morning'], enabled: true, ...valores });
// Manhã sempre no passado e noite sempre no futuro (exceto exatamente à meia-noite).
const CONFIG = { morning_time: '00:00', afternoon_time: '12:00', night_time: '23:59', open_seconds: 60, automation_enabled: true };

test('compartimento do dia: segunda = 1 (servo 0) ... domingo = 7 (servo 6)', async () => {
  const Data = await carregarData();
  assert.deepEqual(puro(Data.DAYS.map(d => Data.compartmentOf(d.weekday))), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(puro(Data.DAYS.map(d => d.short)), ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom']);
});

test('hoje: períodos com medicamento, passado sem registro e futuro pendente', async () => {
  const Data = await carregarData();
  const slots = Data.todaySlots([
    remedio({ periods: ['morning', 'night'] }),
    remedio({ id: 'm2', name: 'Vitamina', periods: ['night'] })
  ], [], CONFIG);
  assert.deepEqual(puro(slots.map(s => [s.period.key, s.time, s.state, s.names.join('+')])), [
    ['morning', '00:00', 'unknown', 'Losartana'],
    ['night', '23:59', 'pending', 'Losartana+Vitamina']
  ]);
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
  assert.equal(Data.todaySlots([remedio({ periods: [] })], [], CONFIG).length, 0);
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
