// Testa supabase/01-medtech-dispensador.sql (versão 1: um medicamento por
// compartimento) num PostgreSQL local (PGlite). Não acessa o projeto real.  Rodar: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arquivo, novoBanco, criarUsuario, como, um, novoToken, criarMedicamento, parear, horario, relatar } from './banco-util.mjs';

test('visitante (anon) não lê nenhuma tabela', async () => {
  const db = await novoBanco();
  for (const tabela of ['devices', 'medications', 'doses', 'device_events']) {
    await assert.rejects(como(db, null, () => db.query(`select * from public.${tabela}`)), /permission denied/);
  }
});

test('cada usuário só vê e altera os próprios medicamentos', async () => {
  const db = await novoBanco();
  const a = await criarUsuario(db);
  const b = await criarUsuario(db);
  const med = await criarMedicamento(db, a);

  assert.equal(med.user_id, a);
  assert.deepEqual(med.times, ['08:00', '14:00'], 'horários ficam em ordem');

  const vistosPorB = await como(db, b, () => db.query(`select id from public.medications`));
  assert.equal(vistosPorB.rows.length, 0);

  const alterados = await como(db, b, () => db.query(
    `update public.medications set enabled = false where id = $1 returning id`, [med.id]));
  assert.equal(alterados.rows.length, 0, 'B não altera o medicamento de A');

  await assert.rejects(como(db, b, () => db.query(
    `insert into public.medications (user_id, name, compartment, times) values ($1, 'X', 2, '{08:00}')`, [a])),
  /permission denied/, 'B não escolhe o dono');
});

test('validações do medicamento', async () => {
  const db = await novoBanco();
  const a = await criarUsuario(db);
  await criarMedicamento(db, a);

  await assert.rejects(criarMedicamento(db, a, { compartment: 1, name: 'Outro' }), /medications_one_per_compartment/);
  await assert.rejects(criarMedicamento(db, a, { compartment: 2, times: ['25:00'] }), /check/);
  await assert.rejects(criarMedicamento(db, a, { compartment: 2, times: ['08:00', '08:00'] }), /check/);
  await assert.rejects(criarMedicamento(db, a, { compartment: 2, times: [] }), /check/);
  await assert.rejects(criarMedicamento(db, a, { compartment: 9 }), /check/);
  await assert.rejects(criarMedicamento(db, a, { compartment: 2, name: '   ' }), /check/);
});

test('o site nunca lê o hash do token', async () => {
  const db = await novoBanco();
  const a = await criarUsuario(db);
  const token = await parear(db, a);

  const visto = await como(db, a, () => um(db, `select token_hint, last_seen_at from public.devices`));
  assert.equal(visto.token_hint, token.slice(-4));
  assert.equal(visto.last_seen_at, null);
  await assert.rejects(como(db, a, () => db.query(`select token_hash from public.devices`)), /permission denied/);
  await assert.rejects(como(db, a, () => db.query(`update public.devices set last_seen_at = now()`)), /permission denied/);
});

test('ESP32: sincronização com token válido, inválido e trocado', async () => {
  const db = await novoBanco();
  const a = await criarUsuario(db);
  const b = await criarUsuario(db);
  const med = await criarMedicamento(db, a);
  await criarMedicamento(db, b, { name: 'De B' });
  const token = await parear(db, a);

  const sync = await como(db, null, async () =>
    (await um(db, `select public.medtech_device_sync($1, 'medtech-1.0.0') as r`, [token])).r);
  assert.equal(sync.timezone, 'America/Sao_Paulo');
  assert.equal(sync.medications.length, 1, 'só os medicamentos do dono do aparelho');
  assert.equal(sync.medications[0].id, med.id);
  assert.deepEqual(sync.medications[0].times, ['08:00', '14:00']);
  assert.equal(sync.medications[0].name, undefined, 'o nome não vai para o aparelho');
  assert.equal(typeof sync.server_time, 'number');

  const visto = await como(db, a, () => um(db, `select firmware_version, last_seen_at from public.devices`));
  assert.equal(visto.firmware_version, 'medtech-1.0.0');
  assert.ok(visto.last_seen_at);

  await assert.rejects(como(db, null, () => db.query(`select public.medtech_device_sync($1)`, [novoToken()])),
    /Aparelho nao autorizado/);
  await assert.rejects(como(db, null, () => db.query(`select public.medtech_device_sync($1)`, ['abc'])),
    /Aparelho nao autorizado/);

  // Trocar a chave invalida a anterior e limpa o último contato.
  const novo = await parear(db, a);
  await assert.rejects(como(db, null, () => db.query(`select public.medtech_device_sync($1)`, [token])),
    /Aparelho nao autorizado/);
  const depois = await como(db, a, () => um(db, `select last_seen_at from public.devices`));
  assert.equal(depois.last_seen_at, null);
  await como(db, null, () => db.query(`select public.medtech_device_sync($1)`, [novo]));

  // Desvincular bloqueia o aparelho.
  await como(db, a, () => db.query(`select public.medtech_unpair_device()`));
  await assert.rejects(como(db, null, () => db.query(`select public.medtech_device_sync($1)`, [novo])),
    /Aparelho nao autorizado/);
});

test('ESP32 não acessa tabelas nem funções internas', async () => {
  const db = await novoBanco();
  const a = await criarUsuario(db);
  const token = await parear(db, a);
  await assert.rejects(como(db, null, () => db.query(`select public.medtech_device_from_token($1)`, [token])),
    /permission denied/);
  await assert.rejects(como(db, null, () => db.query(`select public.medtech_pair_device($1)`, [novoToken()])),
    /permission denied/);
});

test('ESP32: tentativa, duplicidade e resultado de uma ocorrência', async () => {
  const db = await novoBanco();
  const a = await criarUsuario(db);
  const med = await criarMedicamento(db, a);
  const token = await parear(db, a);
  const quando = horario();

  const r1 = await relatar(db, token, 'occ-0001-a', 'attempt', med.id, quando);
  assert.deepEqual(r1, { status: 'recorded', proceed: true, dose_status: 'attempt' });

  // Reenvio do mesmo evento (ex.: resposta perdida): não grava de novo.
  const r2 = await relatar(db, token, 'occ-0001-a', 'attempt', med.id, quando);
  assert.equal(r2.status, 'duplicate');
  assert.equal(r2.proceed, false);

  // Outra tentativa para o mesmo horário (ex.: memória apagada): não pode acionar.
  const r3 = await relatar(db, token, 'occ-0001-b', 'attempt', med.id, quando);
  assert.deepEqual(r3, { status: 'recorded', proceed: false, dose_status: 'attempt' });

  const r4 = await relatar(db, token, 'occ-0001-x', 'actuated', med.id, quando);
  assert.equal(r4.dose_status, 'actuated');

  // Uma ocorrência finalizada não muda mais.
  const r5 = await relatar(db, token, 'occ-0001-f', 'failed', med.id, quando);
  assert.equal(r5.dose_status, 'actuated');

  const doses = await como(db, a, () => db.query(`select status, medication_name, compartment from public.doses`));
  assert.deepEqual(doses.rows, [{ status: 'actuated', medication_name: 'Losartana', compartment: 1 }]);
  const eventos = await como(db, a, () => db.query(`select event_type from public.device_events order by id`));
  assert.deepEqual(eventos.rows.map(e => e.event_type), ['attempt', 'attempt', 'actuated', 'failed']);
});

test('ESP32: resultado sem tentativa anterior e horário perdido', async () => {
  const db = await novoBanco();
  const a = await criarUsuario(db);
  const med = await criarMedicamento(db, a);
  const token = await parear(db, a);

  // Fila offline: o "attempt" pode chegar depois, ou se perder.
  const r1 = await relatar(db, token, 'offl-0001-x', 'actuated', med.id, horario(30));
  assert.equal(r1.dose_status, 'actuated');

  const r2 = await relatar(db, token, 'miss-0001-m', 'missed', med.id, horario(90), { detail: 'atraso_maior_que_tolerancia' });
  assert.deepEqual(r2, { status: 'recorded', proceed: false, dose_status: 'missed' });

  // Uma tentativa para um horário já perdido não aciona.
  const r3 = await relatar(db, token, 'miss-0001-a', 'attempt', med.id, horario(90));
  assert.equal(r3.proceed, false);
});

test('ESP32: validações do relatório', async () => {
  const db = await novoBanco();
  const a = await criarUsuario(db);
  const b = await criarUsuario(db);
  const med = await criarMedicamento(db, a);
  const medB = await criarMedicamento(db, b);
  const token = await parear(db, a);

  await assert.rejects(relatar(db, token, 'x', 'attempt', med.id, horario()), /Identificador/);
  await assert.rejects(relatar(db, token, 'evt-00001', 'dispense', med.id, horario()), /Tipo/);
  await assert.rejects(relatar(db, token, 'evt-00002', 'attempt', medB.id, horario()), /Medicamento nao encontrado/);
  await assert.rejects(relatar(db, token, 'evt-00003', 'attempt', med.id, '2026-01-01T10:00:30Z'), /Horario programado/);
  await assert.rejects(relatar(db, token, 'evt-00004', 'attempt', med.id, null), /sem medicamento/);
  await assert.rejects(relatar(db, token, 'evt-00005', 'boot', med.id, horario()), /nao aceita medicamento/);
  await assert.rejects(relatar(db, token, 'evt-00006', 'attempt', med.id, horario(), { occurred: '2099-01-01T00:00:00Z' }), /fora do limite/);
  await assert.rejects(relatar(db, token, 'evt-00007', 'error', null, null, { detail: '<script>' }), /Detalhe/);
  await assert.rejects(relatar(db, novoToken(), 'evt-00008', 'boot', null, null), /Aparelho nao autorizado/);

  const boot = await relatar(db, token, 'boot-00001', 'boot', null, null, { detail: 'medtech-1.0.0' });
  assert.equal(boot.status, 'recorded');
});

test('ESP32: limite de eventos por minuto', async () => {
  const db = await novoBanco();
  const a = await criarUsuario(db);
  const token = await parear(db, a);
  for (let i = 0; i < 30; i++) await relatar(db, token, `boot-lim-${String(i).padStart(3, '0')}`, 'boot', null, null);
  await assert.rejects(relatar(db, token, 'boot-lim-999', 'boot', null, null), /Limite/);
});

test('usuário confirma a retirada só de dose acionada e própria', async () => {
  const db = await novoBanco();
  const a = await criarUsuario(db);
  const b = await criarUsuario(db);
  const med = await criarMedicamento(db, a);
  const med2 = await criarMedicamento(db, a, { name: 'Outro', compartment: 2 });
  const token = await parear(db, a);

  await relatar(db, token, 'conf-0001-a', 'attempt', med.id, horario());
  const tentativa = await como(db, a, () => um(db, `select id from public.doses where medication_id = $1`, [med.id]));
  await assert.rejects(como(db, a, () => db.query(`select public.medtech_confirm_dose($1)`, [tentativa.id])),
    /nao pode ser confirmada/, 'tentativa sem resultado não é confirmada');

  await relatar(db, token, 'conf-0001-x', 'actuated', med.id, horario());
  await assert.rejects(como(db, b, () => db.query(`select public.medtech_confirm_dose($1)`, [tentativa.id])),
    /nao pode ser confirmada/, 'B não confirma dose de A');
  await como(db, a, () => db.query(`select public.medtech_confirm_dose($1)`, [tentativa.id]));
  await assert.rejects(como(db, a, () => db.query(`select public.medtech_confirm_dose($1)`, [tentativa.id])),
    /nao pode ser confirmada/, 'não confirma duas vezes');

  await relatar(db, token, 'conf-0002-f', 'failed', med2.id, horario());
  const falha = await como(db, a, () => um(db, `select id from public.doses where medication_id = $1`, [med2.id]));
  await assert.rejects(como(db, a, () => db.query(`select public.medtech_confirm_dose($1)`, [falha.id])),
    /nao pode ser confirmada/, 'falha não é confirmada');

  await assert.rejects(como(db, a, () => db.query(`update public.doses set user_confirmed_at = now()`)),
    /permission denied/);
});

test('excluir medicamento mantém o histórico', async () => {
  const db = await novoBanco();
  const a = await criarUsuario(db);
  const med = await criarMedicamento(db, a);
  const token = await parear(db, a);
  await relatar(db, token, 'hist-0001-x', 'actuated', med.id, horario());

  await como(db, a, () => db.query(`delete from public.medications where id = $1`, [med.id]));
  const doses = await como(db, a, () => db.query(`select medication_id, medication_name from public.doses`));
  assert.deepEqual(doses.rows, [{ medication_id: null, medication_name: 'Losartana' }]);
});

test('o script pode ser executado de novo sem perder dados', async () => {
  const db = await novoBanco();
  const a = await criarUsuario(db);
  await criarMedicamento(db, a);
  await db.exec(await arquivo('supabase/01-medtech-dispensador.sql'));
  const total = await como(db, a, () => um(db, `select count(*)::int as n from public.medications`));
  assert.equal(total.n, 1);
});

