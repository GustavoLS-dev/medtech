// Testa supabase/02-organizador-semanal.sql (dias × manhã/tarde/noite) aplicado
// depois do 01, num PostgreSQL local (PGlite). Não acessa o projeto real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arquivo, novoBanco, criarUsuario, como, um, novoToken, parear, horario } from './banco-util.mjs';

const SCRIPTS = ['01-medtech-dispensador.sql', '02-organizador-semanal.sql'];
const TODOS_OS_DIAS = [0, 1, 2, 3, 4, 5, 6];

async function criarRemedio(db, uid, valores = {}) {
  const v = { name: 'Losartana', weekdays: TODOS_OS_DIAS, periods: ['morning'], enabled: true, ...valores };
  return como(db, uid, () => um(db,
    `insert into public.medications (name, weekdays, periods, enabled) values ($1, $2, $3, $4) returning *`,
    [v.name, v.weekdays, v.periods, v.enabled]));
}

async function configurar(db, uid, valores = {}) {
  const v = { morning_time: '08:00', afternoon_time: '13:00', night_time: '20:00', open_seconds: 60, automation_enabled: true, ...valores };
  return como(db, uid, () => um(db,
    `insert into public.dispenser_settings (morning_time, afternoon_time, night_time, open_seconds, automation_enabled)
     values ($1, $2, $3, $4, $5)
     on conflict (user_id) do update set morning_time = excluded.morning_time, afternoon_time = excluded.afternoon_time,
       night_time = excluded.night_time, open_seconds = excluded.open_seconds, automation_enabled = excluded.automation_enabled
     returning *`,
    [v.morning_time, v.afternoon_time, v.night_time, v.open_seconds, v.automation_enabled]));
}

async function agenda(db, token) {
  return como(db, null, async () => (await um(db, `select public.medtech_device_agenda($1, 'medtech-auto-2.0.0') as r`, [token])).r);
}

async function relatar(db, token, uid, tipo, periodo, quando, extra = {}) {
  return como(db, null, async () => (await um(db,
    `select public.medtech_device_slot_report($1, $2, $3, $4, $5, $6, $7) as r`,
    [token, uid, tipo, periodo, quando, extra.occurred ?? null, extra.detail ?? null])).r);
}

// Compartimento do dia (segunda = 1 ... domingo = 7) de um instante, em Brasília.
function compartimentoDe(iso) {
  const dia = new Date(new Date(iso).getTime() - 3 * 3600000).getUTCDay();
  return dia === 0 ? 7 : dia;
}

test('configuração: cada conta só vê e altera a própria, com validações', async () => {
  const db = await novoBanco(SCRIPTS);
  const a = await criarUsuario(db);
  const b = await criarUsuario(db);
  const conf = await configurar(db, a, { automation_enabled: false });
  assert.equal(conf.user_id, a);
  assert.equal(conf.open_seconds, 60);

  assert.equal((await como(db, b, () => db.query(`select * from public.dispenser_settings`))).rows.length, 0);
  await assert.rejects(como(db, null, () => db.query(`select * from public.dispenser_settings`)), /permission denied/);
  await assert.rejects(configurar(db, a, { morning_time: '14:00' }), /dispenser_settings_order/);
  await assert.rejects(configurar(db, a, { open_seconds: 1 }), /check/);
  await assert.rejects(configurar(db, a, { night_time: '24:00' }), /check/);
});

test('medicamentos: vários no mesmo dia, períodos validados e em ordem', async () => {
  const db = await novoBanco(SCRIPTS);
  const a = await criarUsuario(db);
  const m1 = await criarRemedio(db, a, { periods: ['night', 'morning'] });
  await criarRemedio(db, a, { name: 'Vitamina D', periods: ['morning'] });
  assert.deepEqual(m1.periods, ['morning', 'night']);
  assert.equal(m1.compartment, null, 'compartimento agora é o dia');
  await assert.rejects(criarRemedio(db, a, { periods: ['madrugada'] }), /check/);
  await assert.rejects(criarRemedio(db, a, { periods: ['morning', 'morning'] }), /check/);
});

test('agenda do ESP32: um item por dia e período, com horários da configuração', async () => {
  const db = await novoBanco(SCRIPTS);
  const a = await criarUsuario(db);
  const b = await criarUsuario(db);
  await configurar(db, a, { morning_time: '07:30', open_seconds: 45 });
  await criarRemedio(db, a, { weekdays: [1, 2, 3, 4, 5], periods: ['morning', 'night'] });
  await criarRemedio(db, a, { name: 'Outro', weekdays: [1], periods: ['morning', 'afternoon'] });
  await criarRemedio(db, a, { name: 'Pausado', weekdays: [0], periods: ['morning'], enabled: false });
  await criarRemedio(db, b, { name: 'De B', weekdays: [0], periods: ['night'] });
  const token = await parear(db, a);

  const r = await agenda(db, token);
  assert.equal(r.timezone, 'America/Sao_Paulo');
  assert.equal(r.automation_enabled, true);
  assert.equal(r.open_seconds, 45);
  // seg: manhã (2 remédios), tarde, noite; ter-sex: manhã e noite → 3 + 4*2 = 11
  assert.equal(r.slots.length, 11);
  const segManha = r.slots.find(s => s.weekday === 1 && s.period === 'morning');
  assert.deepEqual({ ...segManha, updated_at: 0 }, { weekday: 1, period: 'morning', time: '07:30', medications: 2, updated_at: 0 });
  assert.ok(!r.slots.some(s => s.weekday === 0), 'pausado e de outra conta não entram');
  assert.ok(!JSON.stringify(r).includes('Losartana'), 'nomes não vão para o aparelho');

  // Sem configuração gravada: horários padrão e automação desligada.
  const c = await criarUsuario(db);
  await criarRemedio(db, c);
  const r2 = await agenda(db, await parear(db, c));
  assert.equal(r2.automation_enabled, false);
  assert.equal(r2.open_seconds, 60);
  assert.equal(r2.slots[0].time, '08:00');
});

test('horário: automação desligada no site impede o acionamento', async () => {
  const db = await novoBanco(SCRIPTS);
  const a = await criarUsuario(db);
  await configurar(db, a, { automation_enabled: false });
  await criarRemedio(db, a);
  const token = await parear(db, a);
  await assert.rejects(relatar(db, token, 'slot-0001-a', 'attempt', 'morning', horario()), /Automacao desligada/);
});

test('horário: tentativa cria uma dose por medicamento, sem duplicar', async () => {
  const db = await novoBanco(SCRIPTS);
  const a = await criarUsuario(db);
  await configurar(db, a);
  await criarRemedio(db, a, { name: 'A' });
  await criarRemedio(db, a, { name: 'B' });
  await criarRemedio(db, a, { name: 'Só à noite', periods: ['night'] });
  const token = await parear(db, a);
  const quando = horario();

  const r1 = await relatar(db, token, 'slot-0001-a', 'attempt', 'morning', quando);
  assert.deepEqual(r1, { status: 'recorded', proceed: true, dose_status: 'attempt', medications: 2 });

  const r2 = await relatar(db, token, 'slot-0001-a', 'attempt', 'morning', quando);
  assert.equal(r2.status, 'duplicate');
  assert.equal(r2.proceed, false);

  const r3 = await relatar(db, token, 'slot-0001-b', 'attempt', 'morning', quando);
  assert.equal(r3.proceed, false, 'horário já tratado não abre de novo');

  const r4 = await relatar(db, token, 'slot-0001-x', 'actuated', 'morning', quando);
  assert.equal(r4.dose_status, 'actuated');

  const doses = await como(db, a, () => db.query(
    `select medication_name, status, compartment, period from public.doses order by medication_name`));
  assert.deepEqual(doses.rows, [
    { medication_name: 'A', status: 'actuated', compartment: compartimentoDe(quando), period: 'morning' },
    { medication_name: 'B', status: 'actuated', compartment: compartimentoDe(quando), period: 'morning' }
  ]);

  // O usuário confirma a retirada do horário inteiro.
  const conf = await como(db, a, async () =>
    (await um(db, `select public.medtech_confirm_slot($1, 'morning') as r`, [quando])).r);
  assert.equal(conf.confirmed, 2);
  await assert.rejects(como(db, a, () => db.query(`select public.medtech_confirm_slot($1, 'morning')`, [quando])),
    /nao pode ser confirmado/);
});

test('horário: sem medicamento, perdido e resultado offline', async () => {
  const db = await novoBanco(SCRIPTS);
  const a = await criarUsuario(db);
  await configurar(db, a);
  await criarRemedio(db, a, { periods: ['morning'] });
  const token = await parear(db, a);

  await assert.rejects(relatar(db, token, 'slot-0002-a', 'attempt', 'afternoon', horario()), /Nenhum medicamento/);

  const perdido = await relatar(db, token, 'slot-0003-m', 'missed', 'morning', horario(90), { detail: 'atraso_maior_que_tolerancia' });
  assert.equal(perdido.dose_status, 'missed');
  const depois = await relatar(db, token, 'slot-0003-a', 'attempt', 'morning', horario(90));
  assert.equal(depois.proceed, false, 'horário perdido não é executado depois');

  const offline = await relatar(db, token, 'slot-0004-x', 'actuated', 'morning', horario(30));
  assert.equal(offline.dose_status, 'actuated', 'resultado sem tentativa anterior cria a dose');
});

test('horário: validações do relatório', async () => {
  const db = await novoBanco(SCRIPTS);
  const a = await criarUsuario(db);
  await configurar(db, a);
  await criarRemedio(db, a);
  const token = await parear(db, a);
  await assert.rejects(relatar(db, token, 'slot-0005-a', 'attempt', 'madrugada', horario()), /sem periodo/);
  await assert.rejects(relatar(db, token, 'slot-0006-a', 'attempt', 'morning', '2026-01-01T10:00:30Z'), /Horario programado/);
  await assert.rejects(relatar(db, token, 'slot-0007-b', 'boot', 'morning', horario()), /nao aceita periodo/);
  await assert.rejects(relatar(db, novoToken(), 'slot-0008-b', 'boot', null, null), /Aparelho nao autorizado/);
  const boot = await relatar(db, token, 'dev-0001-b', 'boot', null, null, { detail: 'medtech-auto-2.0.0' });
  assert.equal(boot.status, 'recorded');
});

test('migração preserva dados da versão 1 e pode ser executada de novo', async () => {
  const db = await novoBanco(['01-medtech-dispensador.sql']);
  const a = await criarUsuario(db);
  await como(db, a, () => db.query(
    `insert into public.medications (name, compartment, times) values ('Antigo', 1, '{08:00}')`));
  for (const nome of SCRIPTS) await db.exec(await arquivo('supabase/' + nome));
  await db.exec(await arquivo('supabase/02-organizador-semanal.sql'));
  const antigo = await como(db, a, () => um(db, `select name, compartment, times, periods from public.medications`));
  assert.deepEqual({ ...antigo }, { name: 'Antigo', compartment: 1, times: ['08:00'], periods: [] });
});

test('as colunas usadas pelo site (medtech/js/data.js) existem e são legíveis', async () => {
  const db = await novoBanco(SCRIPTS);
  const a = await criarUsuario(db);
  await criarRemedio(db, a);
  await configurar(db, a);
  await parear(db, a);
  const fonte = await arquivo('medtech/js/data.js');
  const campos = nome => fonte.match(new RegExp(`const ${nome} = "([^"]+)"`))[1];
  const consultas = {
    medications: campos('MEDICATION_FIELDS'),
    dispenser_settings: campos('SETTINGS_FIELDS'),
    devices: campos('DEVICE_FIELDS'),
    doses: campos('DOSE_FIELDS'),
    device_events: campos('EVENT_FIELDS')
  };
  for (const [tabela, colunas] of Object.entries(consultas)) {
    await como(db, a, () => db.query(`select ${colunas} from public.${tabela}`));
  }
  await como(db, a, () => db.query(
    `update public.medications set name = 'X', weekdays = '{1,3}', periods = '{night}', enabled = false, notes = 'n'`));
});
