// Testa supabase/06-horarios-por-medicamento.sql (horários próprios de cada
// medicamento e "Tomado" automático) aplicado depois do 01 ao 05, num
// PostgreSQL local (PGlite). Não acessa o projeto real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arquivo, novoBanco, criarUsuario, como, um, parear } from './banco-util.mjs';

const ATE_05 = ['01-medtech-dispensador.sql', '02-organizador-semanal.sql', '03-liberar-agora-e-tempo-real.sql',
  '04-liquidos-e-liberar-medicamento.sql', '05-liberar-todos-os-dias.sql'];
const SCRIPTS = [...ATE_05, '06-horarios-por-medicamento.sql'];
const TODOS = '{0,1,2,3,4,5,6}';

// Minuto cheio, alguns minutos atrás, e a hora "HH:MM" dele em Brasília.
function horarioPassado(minutos = 2) {
  const d = new Date(Date.now() - minutos * 60000);
  d.setUTCSeconds(0, 0);
  const local = new Date(d.getTime() - 3 * 3600000);
  const hhmm = local.toISOString().slice(11, 16);
  return { iso: d.toISOString(), hhmm };
}

async function preparar(db, { automacao = true } = {}) {
  const a = await criarUsuario(db);
  await como(db, a, () => db.query(`insert into public.dispenser_settings (automation_enabled) values ($1)`, [automacao]));
  const token = await parear(db, a);
  return { a, token };
}

const remedio = (db, uid, nome, horarios, form = 'solid', dias = TODOS) =>
  como(db, uid, () => um(db,
    `insert into public.medications (name, form, weekdays, times) values ($1, $2, $3, $4) returning *`,
    [nome, form, dias, horarios]));

const agenda = (db, token) =>
  como(db, null, async () => (await um(db, `select public.medtech_device_agenda($1) as r`, [token])).r);

const relatar = (db, token, uid, tipo, periodo, quando, detalhe = null) =>
  como(db, null, async () => (await um(db,
    `select public.medtech_device_slot_report($1, $2, $3, $4, $5, null, $6) as r`,
    [token, uid, tipo, periodo, quando, detalhe])).r);

test('agenda: um item por dia + hora, com o rótulo do período pela hora', async () => {
  const db = await novoBanco(SCRIPTS);
  const { a, token } = await preparar(db);
  await remedio(db, a, 'Losartana', '{08:30,21:00}', 'solid', '{1}');
  await remedio(db, a, 'Vitamina', '{08:30}', 'solid', '{1}');
  await remedio(db, a, 'Xarope', '{11:59,12:00}', 'liquid', '{1}');

  const r = await agenda(db, token);
  assert.deepEqual(r.slots.map(s => [s.weekday, s.time, s.period, s.medications, s.solids, s.liquids]), [
    [1, '08:30', 'morning', 2, 2, 0],
    [1, '11:59', 'morning', 1, 0, 1],
    [1, '12:00', 'afternoon', 1, 0, 1],
    [1, '21:00', 'night', 1, 1, 0]
  ]);
});

test('migração: medicamentos antigos recebem os horários dos períodos que tinham', async () => {
  const db = await novoBanco(ATE_05);
  const a = await criarUsuario(db);
  await como(db, a, () => db.query(
    `insert into public.dispenser_settings (morning_time, afternoon_time, night_time) values ('07:15', '13:00', '22:00')`));
  await como(db, a, () => db.query(
    `insert into public.medications (name, weekdays, periods) values ('Antigo', '{1}', '{morning,night}')`));
  const b = await criarUsuario(db);
  await como(db, b, () => db.query(
    `insert into public.medications (name, weekdays, periods) values ('Sem config', '{1}', '{afternoon}')`));

  await db.exec(await arquivo('supabase/06-horarios-por-medicamento.sql'));
  assert.deepEqual((await como(db, a, () => um(db, `select times from public.medications`))).times, ['07:15', '22:00']);
  assert.deepEqual((await como(db, b, () => um(db, `select times from public.medications`))).times, ['13:00']);

  // Rodar de novo não muda horários já definidos.
  await como(db, a, () => db.query(`update public.medications set times = '{09:00}'`));
  await db.exec(await arquivo('supabase/06-horarios-por-medicamento.sql'));
  assert.deepEqual((await como(db, a, () => um(db, `select times from public.medications`))).times, ['09:00']);
});

test('horário programado: libera os medicamentos daquela hora e marca como tomado', async () => {
  const db = await novoBanco(SCRIPTS);
  const { a, token } = await preparar(db);
  const h = horarioPassado();
  await remedio(db, a, 'Losartana', `{${h.hhmm}}`);
  await remedio(db, a, 'Xarope', `{${h.hhmm}}`, 'liquid');
  await remedio(db, a, 'Outra hora', '{03:00}');

  const periodo = (await agenda(db, token)).slots.find(s => s.time === h.hhmm).period;
  const r1 = await relatar(db, token, 'slot-hora-0001-a', 'attempt', periodo, h.iso);
  assert.equal(r1.proceed, true);
  assert.equal(r1.medications, 2, 'só os medicamentos daquela hora');

  await relatar(db, token, 'slot-hora-0001-x', 'actuated', periodo, h.iso);
  const doses = await como(db, a, () => db.query(
    `select medication_name, status, period, user_confirmed_at is not null as tomado from public.doses order by medication_name`));
  assert.deepEqual(doses.rows.map(d => ({ ...d })), [
    { medication_name: 'Losartana', status: 'actuated', period: periodo, tomado: true },
    { medication_name: 'Xarope', status: 'actuated', period: periodo, tomado: true }
  ]);

  const r2 = await relatar(db, token, 'slot-hora-0002-a', 'attempt', periodo, h.iso);
  assert.equal(r2.proceed, false, 'o mesmo horário não abre duas vezes');
});

test('falha e "não aberta" não marcam como tomado; registro sem tentativa (offline) marca', async () => {
  const db = await novoBanco(SCRIPTS);
  const { a, token } = await preparar(db);
  const h1 = horarioPassado(2), h2 = horarioPassado(3), h3 = horarioPassado(4);
  await remedio(db, a, 'Losartana', `{${h1.hhmm},${h2.hhmm},${h3.hhmm}}`);
  const per = hhmm => (hhmm < '12:00' ? 'morning' : hhmm < '18:00' ? 'afternoon' : 'night');

  await relatar(db, token, 'slot-falha-01-a', 'attempt', per(h1.hhmm), h1.iso);
  await relatar(db, token, 'slot-falha-01-f', 'failed', per(h1.hhmm), h1.iso, 'falha_i2c');
  await relatar(db, token, 'slot-perd-001-m', 'missed', per(h2.hhmm), h2.iso);
  await relatar(db, token, 'slot-offl-001-x', 'actuated', per(h3.hhmm), h3.iso);

  const doses = await como(db, a, () => db.query(
    `select status, user_confirmed_at is not null as tomado from public.doses order by scheduled_for desc`));
  assert.deepEqual(doses.rows.map(d => [d.status, d.tomado]), [['failed', false], ['missed', false], ['actuated', true]]);
});

test('"Liberar agora" continua pedindo a confirmação do usuário', async () => {
  const db = await novoBanco(SCRIPTS);
  const { a, token } = await preparar(db);
  const med = await remedio(db, a, 'Losartana', '{03:00}');
  const pedido = await como(db, a, async () => (await um(db, `select public.medtech_request_medication($1) as r`, [med.id])).r);
  const rel = (uid, tipo) => como(db, null, async () => (await um(db,
    `select public.medtech_device_request_report($1, $2, $3, $4) as r`, [token, uid, tipo, pedido.id])).r);
  await rel('req-manual-01-a', 'attempt');
  await rel('req-manual-01-x', 'actuated');
  const dose = await como(db, a, () => um(db, `select status, user_confirmed_at from public.doses`));
  assert.equal(dose.status, 'actuated');
  assert.equal(dose.user_confirmed_at, null);
});

test('automação desligada e medicamento sem aquela hora continuam recusados', async () => {
  const db = await novoBanco(SCRIPTS);
  const { a, token } = await preparar(db, { automacao: false });
  const h = horarioPassado();
  await remedio(db, a, 'Losartana', `{${h.hhmm}}`);
  await assert.rejects(relatar(db, token, 'slot-auto-001-a', 'attempt', 'morning', h.iso), /Automacao desligada/);

  await como(db, a, () => db.query(`update public.dispenser_settings set automation_enabled = true`));
  const outra = horarioPassado(5);
  await assert.rejects(relatar(db, token, 'slot-nada-001-a', 'attempt', 'morning', outra.iso), /Nenhum medicamento/);
});

test('o site grava os horários do medicamento, com validação', async () => {
  const db = await novoBanco(SCRIPTS);
  const { a } = await preparar(db);
  const med = await remedio(db, a, 'Losartana', '{21:00,08:30}');
  assert.deepEqual(med.times, ['08:30', '21:00'], 'ficam em ordem');
  await como(db, a, () => db.query(`update public.medications set times = '{10:00}' where id = $1`, [med.id]));
  await assert.rejects(remedio(db, a, 'Inválido', '{25:00}'), /check/);
  await assert.rejects(remedio(db, a, 'Repetido', '{08:00,08:00}'), /check/);
});

test('o 06 pode ser executado de novo', async () => {
  const db = await novoBanco(SCRIPTS);
  const { a, token } = await preparar(db);
  await remedio(db, a, 'Losartana', '{08:30}');
  await db.exec(await arquivo('supabase/06-horarios-por-medicamento.sql'));
  assert.equal((await agenda(db, token)).slots.length, 7);
});

// supabase/07: o "Liberar agora" também marca como tomado.
test('07: "Liberar agora" que abriu e fechou fica como tomado; falha não', async () => {
  const db = await novoBanco([...SCRIPTS, '07-liberar-agora-tomado.sql']);
  const { a, token } = await preparar(db);
  const med = await remedio(db, a, 'Losartana', '{03:00}');
  const pedir = async () => (await como(db, a, async () => (await um(db, `select public.medtech_request_medication($1) as r`, [med.id])).r)).id;
  const rel = (pedido, uid, tipo) => como(db, null, async () => (await um(db,
    `select public.medtech_device_request_report($1, $2, $3, $4) as r`, [token, uid, tipo, pedido])).r);

  const p1 = await pedir();
  await rel(p1, 'req-tomado-01-a', 'attempt');
  await rel(p1, 'req-tomado-01-x', 'actuated');
  const p2 = await pedir();
  await rel(p2, 'req-falha-001-a', 'attempt');
  await rel(p2, 'req-falha-001-f', 'failed');

  const doses = await como(db, a, () => db.query(
    `select status, user_confirmed_at is not null as tomado from public.doses order by scheduled_for`));
  assert.deepEqual(doses.rows.map(d => [d.status, d.tomado]), [['actuated', true], ['failed', false]]);

  await db.exec(await arquivo('supabase/07-liberar-agora-tomado.sql'));  // pode ser executado de novo
});
