// Funções compartilhadas pelos testes do banco (PGlite imitando o Supabase).
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

export const root = new URL('../', import.meta.url);
export const arquivo = name => readFile(new URL(name, root), 'utf8');

// scripts: arquivos de supabase/ aplicados em ordem.
export async function novoBanco(scripts = ['01-medtech-dispensador.sql']) {
  const db = new PGlite();
  await db.exec(await arquivo('tests/supabase-simulado.sql'));
  for (const nome of scripts) await db.exec(await arquivo('supabase/' + nome));
  return db;
}

export async function criarUsuario(db) {
  const { rows } = await db.query(`insert into auth.users (email) values ($1) returning id`,
    [`${crypto.randomUUID()}@exemplo.com`]);
  return rows[0].id;
}

// Executa fn como o usuário uid (papel authenticated) ou como o ESP32/visitante (anon).
export async function como(db, uid, fn) {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid ?? '']);
  await db.exec(`set role ${uid ? 'authenticated' : 'anon'}`);
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
  }
}

export const um = async (db, sql, params) => (await db.query(sql, params)).rows[0];
export const novoToken = () => randomBytes(32).toString('hex');

export async function criarMedicamento(db, uid, valores = {}) {
  const v = { name: 'Losartana', compartment: 1, times: ['14:00', '08:00'], ...valores };
  return como(db, uid, () => um(db,
    `insert into public.medications (name, compartment, times) values ($1, $2, $3) returning *`,
    [v.name, v.compartment, v.times]));
}

export async function parear(db, uid) {
  const token = novoToken();
  await como(db, uid, () => db.query(`select public.medtech_pair_device($1)`, [token]));
  return token;
}

// Minuto cheio, alguns minutos no passado (horário programado válido).
export function horario(minutosAtras = 2) {
  const d = new Date(Date.now() - minutosAtras * 60000);
  d.setUTCSeconds(0, 0);
  return d.toISOString();
}

export async function relatar(db, token, uid, tipo, medId, quando, extra = {}) {
  return como(db, null, async () => (await um(db,
    `select public.medtech_device_report($1, $2, $3, $4, $5, $6, $7) as r`,
    [token, uid, tipo, medId, quando, extra.occurred ?? null, extra.detail ?? null])).r);
}

