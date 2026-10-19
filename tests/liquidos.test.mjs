// Testa supabase/04-liquidos-e-liberar-medicamento.sql (bomba para líquidos e
// "Liberar agora" por medicamento) aplicado depois do 01, 02 e 03, num
// PostgreSQL local (PGlite). Não acessa o projeto real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arquivo, novoBanco, criarUsuario, como, um, parear } from './banco-util.mjs';

const SCRIPTS = ['01-medtech-dispensador.sql', '02-organizador-semanal.sql', '03-liberar-agora-e-tempo-real.sql',
  '04-liquidos-e-liberar-medicamento.sql'];
const TODOS = '{0,1,2,3,4,5,6}';
// Dia da semana de hoje em Brasília (0 = domingo).
const hoje = () => new Date(Date.now() - 3 * 3600000).getUTCDay();

async function preparar(db, { automacao = false } = {}) {
  const a = await criarUsuario(db);
  await como(db, a, () => db.query(
    `insert into public.dispenser_settings (morning_time, afternoon_time, night_time, automation_enabled)
     values ('00:00', '12:00', '23:59', $1)`, [automacao]));
  const token = await parear(db, a);
  return { a, token };
}

const remedio = (db, uid, nome, form = 'solid', dias = TODOS, periodos = '{morning}') =>
  como(db, uid, () => um(db,
    `insert into public.medications (name, form, weekdays, periods) values ($1, $2, $3, $4) returning *`,
    [nome, form, dias, periodos]));

const pedir = (db, uid, medId) =>
  como(db, uid, async () => (await um(db, `select public.medtech_request_medication($1) as r`, [medId])).r);

const agenda = (db, token) =>
  como(db, null, async () => (await um(db, `select public.medtech_device_agenda($1) as r`, [token])).r);

const relatar = (db, token, uid, tipo, pedidoId, detalhe = null) =>
  como(db, null, async () => (await um(db,
    `select public.medtech_device_request_report($1, $2, $3, $4, null, $5) as r`,
    [token, uid, tipo, pedidoId, detalhe])).r);

test('forma: sólido por padrão, líquido aceito, outros valores recusados', async () => {
  const db = await novoBanco(SCRIPTS);
  const { a } = await preparar(db);
  const antigo = await como(db, a, () => um(db,
    `insert into public.medications (name, weekdays, periods) values ('Antigo', '{1}', '{morning}') returning form`));
  assert.equal(antigo.form, 'solid');
  assert.equal((await remedio(db, a, 'Xarope', 'liquid')).form, 'liquid');
  await assert.rejects(remedio(db, a, 'Pomada', 'gel'), /medications_form_check/);
});

test('tempo da bomba: padrão 5 s, de 1 a 30 s', async () => {
  const db = await novoBanco(SCRIPTS);
  const { a } = await preparar(db);
  assert.equal((await como(db, a, () => um(db, `select pump_seconds from public.dispenser_settings`))).pump_seconds, 5);
  await como(db, a, () => db.query(`update public.dispenser_settings set pump_seconds = 12`));
  await assert.rejects(como(db, a, () => db.query(`update public.dispenser_settings set pump_seconds = 31`)), /pump_check/);
  await assert.rejects(como(db, a, () => db.query(`update public.dispenser_settings set pump_seconds = 0`)), /pump_check/);
});

test('agenda: separa sólidos e líquidos de cada horário e envia o tempo da bomba', async () => {
  const db = await novoBanco(SCRIPTS);
  const { a, token } = await preparar(db);
  await remedio(db, a, 'Losartana', 'solid', '{1}', '{morning,night}');
  await remedio(db, a, 'Xarope', 'liquid', '{1}', '{night}');
  await remedio(db, a, 'Dipirona gotas', 'liquid', '{2}', '{afternoon}');

  const r = await agenda(db, token);
  assert.equal(r.pump_seconds, 5);
  assert.deepEqual(r.slots.map(s => [s.weekday, s.period, s.medications, s.solids, s.liquids]), [
    [1, 'morning', 1, 1, 0],
    [1, 'night', 2, 1, 1],
    [2, 'afternoon', 1, 0, 1]
  ]);
  assert.deepEqual(r.medication_requests, []);
});

test('pedido por medicamento: compartimento de hoje ou do próximo dia programado', async () => {
  const db = await novoBanco(SCRIPTS);
  const { a, token } = await preparar(db);
  const hojeMed = await remedio(db, a, 'Hoje', 'solid', TODOS);
  const amanha = (hoje() + 1) % 7;
  const depois = await remedio(db, a, 'Amanhã', 'solid', `{${amanha}}`);

  const p1 = await pedir(db, a, hojeMed.id);
  assert.equal(p1.weekday, hoje());
  assert.equal(p1.form, 'solid');
  await db.query(`update public.dispense_requests set status = 'done'`);
  const p2 = await pedir(db, a, depois.id);
  assert.equal(p2.weekday, amanha, 'a cápsula está no compartimento do próximo dia programado');

  const r = await agenda(db, token);
  assert.deepEqual(r.medication_requests, [{ id: p2.id, weekday: amanha, form: 'solid' }]);
  assert.deepEqual(r.requests, [], 'pedidos por medicamento não aparecem na lista do firmware 2.1');
});

test('pedido por medicamento: qualquer medicamento, a qualquer hora, um pedido por vez', async () => {
  const db = await novoBanco(SCRIPTS);
  const { a } = await preparar(db);
  // Pausado e sem período: mesmo assim pode ser liberado na demonstração.
  const pausado = await remedio(db, a, 'Pausado', 'liquid', '{3}', '{}');
  await como(db, a, () => db.query(`update public.medications set enabled = false`));
  const outro = await remedio(db, a, 'Outro');

  await pedir(db, a, pausado.id);
  await assert.rejects(pedir(db, a, outro.id), /Ja existe um pedido/);
  await assert.rejects(como(db, a, async () => (await um(db, `select public.medtech_request_dispense('morning') as r`)).r),
    /Ja existe um pedido/, 'também bloqueia o pedido de período');
});

test('pedido por medicamento: libera uma única vez e não marca o horário programado', async () => {
  const db = await novoBanco(SCRIPTS);
  const { a, token } = await preparar(db, { automacao: false });
  const xarope = await remedio(db, a, 'Xarope', 'liquid');
  const { id } = await pedir(db, a, xarope.id);

  const r1 = await relatar(db, token, 'req-test-0001-a', 'attempt', id);
  assert.equal(r1.proceed, true, 'pedido ativo autoriza mesmo sem automação');
  assert.equal(r1.dose_status, 'attempt');
  assert.deepEqual((await agenda(db, token)).medication_requests, [], 'pedido em andamento sai da agenda');

  const r2 = await relatar(db, token, 'req-test-0002-a', 'attempt', id);
  assert.equal(r2.proceed, false, 'segunda tentativa do mesmo pedido não libera de novo');

  const fim = await relatar(db, token, 'req-test-0001-x', 'actuated', id);
  assert.equal(fim.dose_status, 'actuated');
  const dupla = await relatar(db, token, 'req-test-0001-x', 'actuated', id);
  assert.equal(dupla.status, 'duplicate');

  const dose = await como(db, a, () => um(db, `select status, period, detail, medication_name from public.doses`));
  assert.deepEqual({ ...dose }, { status: 'actuated', period: null, detail: 'liberacao_manual', medication_name: 'Xarope' });
  const pedido = await como(db, a, () => um(db, `select status from public.dispense_requests`));
  assert.equal(pedido.status, 'done');

  // A confirmação de retirada usa a função por dose (01).
  const doseId = (await como(db, a, () => um(db, `select id from public.doses`))).id;
  await como(db, a, () => db.query(`select public.medtech_confirm_dose($1)`, [doseId]));

  // O horário da manhã continua livre para a automação.
  const r = await agenda(db, token);
  assert.equal(r.slots.length, 7);
});

test('pedido por medicamento: falha registrada e pedido expirado não libera', async () => {
  const db = await novoBanco(SCRIPTS);
  const { a, token } = await preparar(db);
  const med = await remedio(db, a, 'Losartana');

  const p1 = await pedir(db, a, med.id);
  await relatar(db, token, 'req-fail-0001-a', 'attempt', p1.id);
  const falha = await relatar(db, token, 'req-fail-0001-f', 'failed', p1.id, 'falha_i2c');
  assert.equal(falha.dose_status, 'failed');

  const p2 = await pedir(db, a, med.id);
  await db.query(`update public.dispense_requests set created_at = now() - interval '3 minutes' where id = $1`, [p2.id]);
  assert.deepEqual((await agenda(db, token)).medication_requests, []);
  const r = await relatar(db, token, 'req-exp-0001-a', 'attempt', p2.id);
  assert.equal(r.proceed, false);
  assert.equal((await como(db, a, () => um(db, `select status from public.dispense_requests where id = $1`, [p2.id]))).status, 'failed');
});

test('pedido por medicamento: só do dono, com aparelho vinculado', async () => {
  const db = await novoBanco(SCRIPTS);
  const { a, token } = await preparar(db);
  const { a: b, token: tokenB } = await preparar(db);
  const med = await remedio(db, a, 'Losartana');

  await assert.rejects(pedir(db, b, med.id), /Medicamento nao encontrado/);
  await assert.rejects(como(db, null, () => db.query(`select public.medtech_request_medication($1)`, [med.id])), /permission denied/);

  const { id } = await pedir(db, a, med.id);
  await assert.rejects(relatar(db, tokenB, 'req-alheio-01-a', 'attempt', id), /Pedido nao encontrado/);
  await assert.rejects(relatar(db, '0'.repeat(64), 'req-falso-01-a', 'attempt', id), /nao autorizado/);
  assert.equal((await relatar(db, token, 'req-dono-001-a', 'attempt', id)).proceed, true);

  const c = await criarUsuario(db);
  const medC = await remedio(db, c, 'Sem aparelho');
  await assert.rejects(pedir(db, c, medC.id), /Nenhum dispensador/);
});

test('o 04 pode ser executado de novo', async () => {
  const db = await novoBanco(SCRIPTS);
  const { a } = await preparar(db);
  const med = await remedio(db, a, 'Xarope', 'liquid');
  await pedir(db, a, med.id);
  await db.exec(await arquivo('supabase/04-liquidos-e-liberar-medicamento.sql'));
  assert.equal((await como(db, a, () => um(db, `select form from public.medications`))).form, 'liquid');
  assert.equal((await como(db, a, () => um(db, `select count(*)::int as n from public.dispense_requests`))).n, 1);
});
