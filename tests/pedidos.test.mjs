// Testa supabase/03-liberar-agora-e-tempo-real.sql ("Liberar agora") aplicado
// depois do 01 e do 02, num PostgreSQL local (PGlite). Não acessa o projeto real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arquivo, novoBanco, criarUsuario, como, um, parear } from './banco-util.mjs';

const SCRIPTS = ['01-medtech-dispensador.sql', '02-organizador-semanal.sql', '03-liberar-agora-e-tempo-real.sql'];

// Manhã sempre no passado e noite sempre no futuro (exceto exatamente às 23:59).
async function preparar(db, { automacao = false } = {}) {
  const a = await criarUsuario(db);
  await como(db, a, () => db.query(
    `insert into public.dispenser_settings (morning_time, afternoon_time, night_time, automation_enabled)
     values ('00:00', '12:00', '23:59', $1)`, [automacao]));
  await como(db, a, () => db.query(
    `insert into public.medications (name, weekdays, periods) values ('Omeprazol', '{0,1,2,3,4,5,6}', '{morning,night}')`));
  const token = await parear(db, a);
  return { a, token };
}

const pedir = (db, uid, periodo) =>
  como(db, uid, async () => (await um(db, `select public.medtech_request_dispense($1) as r`, [periodo])).r);

const agenda = (db, token) =>
  como(db, null, async () => (await um(db, `select public.medtech_device_agenda($1) as r`, [token])).r);

const relatar = (db, token, uid, tipo, periodo, quando) =>
  como(db, null, async () => (await um(db,
    `select public.medtech_device_slot_report($1, $2, $3, $4, $5) as r`, [token, uid, tipo, periodo, quando])).r);

test('pedido: o servidor calcula o horário de hoje e a agenda envia o pedido', async () => {
  const db = await novoBanco(SCRIPTS);
  const { a, token } = await preparar(db);
  const pedido = await pedir(db, a, 'night');

  const hoje = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
  assert.equal(new Date(pedido.scheduled_for).toISOString(), new Date(`${hoje}T23:59:00-03:00`).toISOString());

  const r = await agenda(db, token);
  assert.equal(r.requests.length, 1);
  assert.equal(r.requests[0].period, 'night');
  assert.equal(r.requests[0].scheduled_for, Date.parse(pedido.scheduled_for) / 1000);

  await assert.rejects(pedir(db, a, 'night'), /Ja existe um pedido/);
  await assert.rejects(pedir(db, a, 'afternoon'), /Nenhum medicamento/);
});

test('pedido: libera antes da hora e com a automação desligada, uma única vez', async () => {
  const db = await novoBanco(SCRIPTS);
  const { a, token } = await preparar(db, { automacao: false });
  const { scheduled_for: quando } = await pedir(db, a, 'night');

  const r1 = await relatar(db, token, 'slot-req-0001-a', 'attempt', 'night', quando);
  assert.equal(r1.proceed, true, 'pedido ativo autoriza mesmo sem automação');
  assert.equal((await agenda(db, token)).requests.length, 0, 'pedido em andamento sai da agenda');

  await relatar(db, token, 'slot-req-0001-x', 'actuated', 'night', quando);
  const pedido = await como(db, a, () => um(db, `select status from public.dispense_requests`));
  assert.equal(pedido.status, 'done');
  const dose = await como(db, a, () => um(db, `select status, period from public.doses`));
  assert.deepEqual({ ...dose }, { status: 'actuated', period: 'night' });

  // No horário normal, o período já consta como tratado.
  const r2 = await relatar(db, token, 'slot-req-0002-a', 'attempt', 'night', quando);
  assert.equal(r2.proceed, false);
  await assert.rejects(pedir(db, a, 'night'), /ja foi tratado/);
});

test('sem pedido: horário futuro e automação desligada continuam recusados', async () => {
  const db = await novoBanco(SCRIPTS);
  const { token } = await preparar(db, { automacao: false });
  const futuro = new Date(Date.now() + 3600000);
  futuro.setUTCSeconds(0, 0);
  await assert.rejects(relatar(db, token, 'slot-fut-0001-a', 'attempt', 'night', futuro.toISOString()), /Horario programado/);
  const passado = new Date(Date.now() - 120000);
  passado.setUTCSeconds(0, 0);
  await assert.rejects(relatar(db, token, 'slot-pas-0001-a', 'attempt', 'morning', passado.toISOString()), /Automacao desligada/);
});

test('pedido expirado (mais de 2 min) não sai na agenda nem autoriza abertura', async () => {
  const db = await novoBanco(SCRIPTS);
  const { a, token } = await preparar(db, { automacao: false });
  const { scheduled_for: quando } = await pedir(db, a, 'night');
  await db.query(`update public.dispense_requests set created_at = now() - interval '3 minutes'`);
  assert.equal((await agenda(db, token)).requests.length, 0);
  await assert.rejects(relatar(db, token, 'slot-exp-0001-a', 'attempt', 'night', quando), /Automacao desligada/);
});

test('pedidos: cada conta só vê os próprios; visitante não vê nenhum', async () => {
  const db = await novoBanco(SCRIPTS);
  const { a } = await preparar(db);
  const { a: b } = await preparar(db);
  await pedir(db, a, 'night');
  assert.equal((await como(db, b, () => db.query(`select id from public.dispense_requests`))).rows.length, 0);
  await assert.rejects(como(db, null, () => db.query(`select id from public.dispense_requests`)), /permission denied/);
  await assert.rejects(como(db, null, () => db.query(`select public.medtech_request_dispense('night')`)), /permission denied/);
  await assert.rejects(como(db, a, () => db.query(
    `insert into public.dispense_requests (user_id, period, scheduled_for) values ($1, 'night', now())`, [a])), /permission denied/);
});

test('pedido exige dispensador vinculado', async () => {
  const db = await novoBanco(SCRIPTS);
  const a = await criarUsuario(db);
  await como(db, a, () => db.query(
    `insert into public.medications (name, weekdays, periods) values ('X', '{0,1,2,3,4,5,6}', '{night}')`));
  await assert.rejects(pedir(db, a, 'night'), /Nenhum dispensador/);
});

test('o 03 pode ser executado de novo', async () => {
  const db = await novoBanco(SCRIPTS);
  const { a } = await preparar(db);
  await pedir(db, a, 'night');
  await db.exec(await arquivo('supabase/03-liberar-agora-e-tempo-real.sql'));
  assert.equal((await como(db, a, () => um(db, `select count(*)::int as n from public.dispense_requests`))).n, 1);
});
