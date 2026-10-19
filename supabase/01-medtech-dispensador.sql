-- ============================================================================
-- MedTech — banco do dispensador (Supabase / PostgreSQL 15+)
--
-- Cria as tabelas, as regras de acesso (RLS) e as funções usadas pelo site e
-- pelo ESP32. Execute no Supabase: SQL Editor → New query → colar → Run.
--
-- Pode ser executado mais de uma vez (corrige funções e políticas) e não
-- apaga dados: só usa "create ... if not exists", "create or replace" e
-- "drop policy if exists" antes de recriar a mesma política.
--
-- Quem acessa o quê:
--   site (usuário logado)  → tabelas, sempre filtradas por RLS (só as próprias linhas)
--   ESP32 (sem login)      → somente medtech_device_sync e medtech_device_report,
--                            autenticado pelo token do aparelho (guardado como hash)
--   visitante (anon)       → nenhuma tabela
-- ============================================================================


-- ---------------------------------------------------------------------------
-- Validações reutilizadas nas restrições (CHECK) das tabelas
-- ---------------------------------------------------------------------------

-- Lista de horários "HH:MM": de 1 a 12 itens, sem repetição.
create or replace function public.medtech_valid_times(p text[])
returns boolean language sql immutable set search_path = '' as $$
  select p is not null
     and cardinality(p) between 1 and 12
     and array_position(p, null) is null
     and (select bool_and(t ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') and count(distinct t) = count(*)
            from unnest(p) as t)
$$;

-- Dias da semana: 0 = domingo ... 6 = sábado, de 1 a 7 itens, sem repetição.
create or replace function public.medtech_valid_weekdays(p smallint[])
returns boolean language sql immutable set search_path = '' as $$
  select p is not null
     and cardinality(p) between 1 and 7
     and array_position(p, null) is null
     and (select bool_and(d between 0 and 6) and count(distinct d) = count(*)
            from unnest(p) as d)
$$;


-- ---------------------------------------------------------------------------
-- Tabelas
-- ---------------------------------------------------------------------------

-- Um dispensador por conta. O token do aparelho nunca é guardado:
-- só o hash SHA-256 e os 4 últimos caracteres (para o usuário reconhecer).
create table if not exists public.devices (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null unique references auth.users (id) on delete cascade,
  token_hash       text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  token_hint       text not null check (token_hint ~ '^[0-9a-f]{4}$'),
  firmware_version text check (char_length(firmware_version) <= 32),
  last_seen_at     timestamptz,
  paired_at        timestamptz not null default now(),
  created_at       timestamptz not null default now()
);

-- Medicamento + programação. Cada compartimento físico guarda um medicamento.
-- O compartimento vai de 1 a 8 (limite do hardware: canais 0..7 do PCA9685);
-- quantos estão realmente montados é definido no site (data.js) e no firmware (config.h).
create table if not exists public.medications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 80),
  compartment smallint not null check (compartment between 1 and 8),
  times       text[] not null check (public.medtech_valid_times(times)),
  weekdays    smallint[] not null default '{0,1,2,3,4,5,6}' check (public.medtech_valid_weekdays(weekdays)),
  enabled     boolean not null default true,
  notes       text check (char_length(notes) <= 300),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint medications_one_per_compartment unique (user_id, compartment)
);

-- Uma linha por horário que o dispositivo tratou (ocorrência).
-- status:
--   attempt   o dispositivo registrou que ia acionar (ainda sem resultado)
--   actuated  o dispositivo informou que abriu e fechou a gaveta
--   failed    o dispositivo informou erro, ou reiniciou durante o acionamento
--   missed    o horário passou da tolerância (ex.: aparelho sem energia); a gaveta NÃO foi aberta
-- user_confirmed_at: o usuário confirmou no site que retirou o medicamento.
-- Não há sensor no hardware atual: nada aqui prova liberação física.
create table if not exists public.doses (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users (id) on delete cascade,
  device_id         uuid references public.devices (id) on delete set null,
  medication_id     uuid references public.medications (id) on delete set null,
  medication_name   text not null,
  compartment       smallint not null,
  scheduled_for     timestamptz not null,
  status            text not null check (status in ('attempt', 'actuated', 'failed', 'missed')),
  detail            text check (char_length(detail) <= 120),
  attempt_at        timestamptz,
  finished_at       timestamptz,
  user_confirmed_at timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint doses_confirm_only_actuated check (user_confirmed_at is null or status = 'actuated')
);

-- Impede duas ocorrências para o mesmo medicamento no mesmo horário.
create unique index if not exists doses_one_per_occurrence
  on public.doses (medication_id, scheduled_for) where medication_id is not null;
create index if not exists doses_user_time on public.doses (user_id, scheduled_for desc);

-- Registro de tudo o que o aparelho enviou. event_uid é único por aparelho:
-- reenviar o mesmo evento (ex.: depois de uma queda de rede) não grava de novo.
create table if not exists public.device_events (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  device_id   uuid not null references public.devices (id) on delete cascade,
  event_uid   text not null check (event_uid ~ '^[A-Za-z0-9_-]{8,64}$'),
  event_type  text not null check (event_type in ('boot', 'error', 'attempt', 'actuated', 'failed', 'missed')),
  dose_id     uuid references public.doses (id) on delete set null,
  detail      text check (char_length(detail) <= 120),
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  constraint device_events_unique_uid unique (device_id, event_uid)
);
create index if not exists device_events_device_time on public.device_events (device_id, received_at desc);


-- ---------------------------------------------------------------------------
-- Normalização dos medicamentos (antes de gravar)
-- ---------------------------------------------------------------------------
create or replace function public.medtech_medications_before_write()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.name := btrim(new.name);
  new.notes := nullif(btrim(new.notes), '');
  -- Horários e dias em ordem; repetições já são recusadas pela restrição CHECK.
  if new.times is not null then
    new.times := array(select t from unnest(new.times) as t order by t);
  end if;
  new.weekdays := array(select d from unnest(new.weekdays) as d order by d);
  if tg_op = 'UPDATE' then
    new.user_id := old.user_id;       -- o dono nunca muda
    new.created_at := old.created_at;
  end if;
  -- O ESP32 usa updated_at para não tratar horários anteriores à última alteração.
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists medications_before_write on public.medications;
create trigger medications_before_write before insert or update on public.medications
  for each row execute function public.medtech_medications_before_write();


-- ---------------------------------------------------------------------------
-- Permissões e RLS
-- ---------------------------------------------------------------------------
alter table public.devices       enable row level security;
alter table public.medications   enable row level security;
alter table public.doses         enable row level security;
alter table public.device_events enable row level security;

-- O Supabase concede tudo por padrão; aqui liberamos só o necessário.
revoke all on table public.devices, public.medications, public.doses, public.device_events
  from public, anon, authenticated;

-- devices: o site lê o estado, mas nunca o hash. Alterações só pelas funções.
grant select (id, user_id, token_hint, firmware_version, last_seen_at, paired_at, created_at)
  on public.devices to authenticated;
-- medications: o site cadastra, edita e exclui; user_id vem de auth.uid().
grant select on public.medications to authenticated;
grant insert (name, compartment, times, weekdays, enabled, notes) on public.medications to authenticated;
grant update (name, compartment, times, weekdays, enabled, notes) on public.medications to authenticated;
grant delete on public.medications to authenticated;
-- doses e eventos: somente leitura no site (confirmação pela função medtech_confirm_dose).
grant select on public.doses, public.device_events to authenticated;

drop policy if exists devices_select_own on public.devices;
create policy devices_select_own on public.devices
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists medications_select_own on public.medications;
create policy medications_select_own on public.medications
  for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists medications_insert_own on public.medications;
create policy medications_insert_own on public.medications
  for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists medications_update_own on public.medications;
create policy medications_update_own on public.medications
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists medications_delete_own on public.medications;
create policy medications_delete_own on public.medications
  for delete to authenticated using (user_id = (select auth.uid()));

drop policy if exists doses_select_own on public.doses;
create policy doses_select_own on public.doses
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists device_events_select_own on public.device_events;
create policy device_events_select_own on public.device_events
  for select to authenticated using (user_id = (select auth.uid()));


-- ---------------------------------------------------------------------------
-- Funções do site (usuário logado)
-- ---------------------------------------------------------------------------

-- Vincula (ou troca a chave do) dispensador da conta. O token é gerado no
-- navegador e mostrado uma única vez; aqui só o hash é gravado.
-- Trocar a chave invalida a anterior e limpa o último contato.
create or replace function public.medtech_pair_device(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Entre na sua conta para vincular o dispositivo' using errcode = '42501';
  end if;
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'Chave do dispositivo invalida' using errcode = '22023';
  end if;

  insert into public.devices (user_id, token_hash, token_hint)
  values (v_uid, encode(sha256(convert_to(p_token, 'UTF8')), 'hex'), right(p_token, 4))
  on conflict (user_id) do update
    set token_hash = excluded.token_hash,
        token_hint = excluded.token_hint,
        firmware_version = null,
        last_seen_at = null,
        paired_at = now();

  return jsonb_build_object('token_hint', right(p_token, 4));
end;
$$;

-- Remove o vínculo. O histórico de doses é mantido.
create or replace function public.medtech_unpair_device()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Entre na sua conta' using errcode = '42501';
  end if;
  delete from public.devices where user_id = auth.uid();
end;
$$;

-- O usuário confirma que retirou o medicamento de uma dose acionada.
create or replace function public.medtech_confirm_dose(p_dose_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_dose public.doses;
begin
  if auth.uid() is null then
    raise exception 'Entre na sua conta' using errcode = '42501';
  end if;

  update public.doses
     set user_confirmed_at = now(), updated_at = now()
   where id = p_dose_id and user_id = auth.uid()
     and status = 'actuated' and user_confirmed_at is null
  returning * into v_dose;

  if not found then
    raise exception 'Esta dose nao pode ser confirmada' using errcode = 'P0001',
      hint = 'Somente doses com acionamento realizado e ainda nao confirmadas.';
  end if;
  return jsonb_build_object('id', v_dose.id, 'user_confirmed_at', v_dose.user_confirmed_at);
end;
$$;


-- ---------------------------------------------------------------------------
-- Funções do ESP32 (chamadas com a chave pública + token do aparelho)
-- ---------------------------------------------------------------------------

-- Encontra o aparelho pelo token. Uso interno: não pode ser chamada pela API.
create or replace function public.medtech_device_from_token(p_token text)
returns public.devices language plpgsql stable security definer set search_path = '' as $$
declare
  v_device public.devices;
begin
  if p_token is not null and p_token ~ '^[0-9a-f]{64}$' then
    select * into v_device from public.devices
     where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  end if;
  if v_device.id is null then
    raise exception 'Aparelho nao autorizado' using errcode = '42501';
  end if;
  return v_device;
end;
$$;

-- Consulta periódica do ESP32: registra o contato e devolve a agenda.
-- Não devolve nomes de medicamentos: o aparelho só precisa do compartimento.
create or replace function public.medtech_device_sync(p_token text, p_firmware text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_device public.devices;
begin
  v_device := public.medtech_device_from_token(p_token);
  if p_firmware is not null and p_firmware !~ '^[A-Za-z0-9._-]{1,32}$' then
    raise exception 'Versao de firmware invalida' using errcode = '22023';
  end if;

  update public.devices
     set last_seen_at = now(), firmware_version = coalesce(p_firmware, firmware_version)
   where id = v_device.id;

  return jsonb_build_object(
    'timezone', 'America/Sao_Paulo',
    'server_time', floor(extract(epoch from now()))::bigint,
    'medications', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id,
               'compartment', m.compartment,
               'times', to_jsonb(m.times),
               'weekdays', to_jsonb(m.weekdays),
               'enabled', m.enabled,
               'updated_at', floor(extract(epoch from m.updated_at))::bigint
             ) order by m.compartment)
        from public.medications m
       where m.user_id = v_device.user_id
    ), '[]'::jsonb)
  );
end;
$$;

-- Registro de eventos do ESP32, idempotente pelo event_uid.
--   attempt  → cria a ocorrência; "proceed" = true só se ela ainda não existia
--              (se já existe, o aparelho NÃO deve acionar de novo)
--   actuated / failed → finalizam uma ocorrência em "attempt" (ou a criam)
--   missed   → cria a ocorrência como não aberta, se ainda não existir
--   boot / error → eventos do aparelho, sem medicamento
create or replace function public.medtech_device_report(
  p_token         text,
  p_event_uid     text,
  p_event_type    text,
  p_medication_id uuid default null,
  p_scheduled_for timestamptz default null,
  p_occurred_at   timestamptz default null,
  p_detail        text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_device  public.devices;
  v_med     public.medications;
  v_dose    public.doses;
  v_when    timestamptz := coalesce(p_occurred_at, now());
  v_proceed boolean := false;
begin
  v_device := public.medtech_device_from_token(p_token);

  if p_event_uid is null or p_event_uid !~ '^[A-Za-z0-9_-]{8,64}$' then
    raise exception 'Identificador de evento invalido' using errcode = '22023';
  end if;
  if p_event_type is null or p_event_type not in ('boot', 'error', 'attempt', 'actuated', 'failed', 'missed') then
    raise exception 'Tipo de evento invalido' using errcode = '22023';
  end if;
  if v_when > now() + interval '5 minutes' or v_when < now() - interval '7 days' then
    raise exception 'Horario do evento fora do limite' using errcode = '22023';
  end if;
  if p_detail is not null and p_detail !~ '^[A-Za-z0-9 _.:-]{1,120}$' then
    raise exception 'Detalhe do evento invalido' using errcode = '22023';
  end if;

  -- Reenvio do mesmo evento: nada é gravado de novo.
  select d.* into v_dose
    from public.device_events e left join public.doses d on d.id = e.dose_id
   where e.device_id = v_device.id and e.event_uid = p_event_uid;
  if found then
    return jsonb_build_object('status', 'duplicate', 'proceed', false, 'dose_status', v_dose.status);
  end if;

  -- Limite simples contra laços de repetição no firmware.
  -- PT429 vira HTTP 429 no PostgREST: o aparelho entende como temporário e reenvia depois.
  if (select count(*) from public.device_events
       where device_id = v_device.id and received_at > now() - interval '1 minute') >= 30 then
    raise exception 'Limite de eventos por minuto atingido' using errcode = 'PT429';
  end if;

  if p_event_type in ('attempt', 'actuated', 'failed', 'missed') then
    if p_medication_id is null or p_scheduled_for is null then
      raise exception 'Evento de dose sem medicamento ou horario' using errcode = '22023';
    end if;
    if p_scheduled_for <> date_trunc('minute', p_scheduled_for)
       or p_scheduled_for > now() + interval '5 minutes'
       or p_scheduled_for < now() - interval '7 days' then
      raise exception 'Horario programado invalido' using errcode = '22023';
    end if;

    -- O medicamento precisa ser do dono deste aparelho.
    select * into v_med from public.medications
     where id = p_medication_id and user_id = v_device.user_id;
    if not found then
      raise exception 'Medicamento nao encontrado para este aparelho' using errcode = '22023';
    end if;

    insert into public.doses (user_id, device_id, medication_id, medication_name, compartment,
                              scheduled_for, status, detail, attempt_at, finished_at)
    values (v_device.user_id, v_device.id, v_med.id, v_med.name, v_med.compartment,
            p_scheduled_for, p_event_type, p_detail,
            case when p_event_type = 'attempt' then v_when end,
            case when p_event_type <> 'attempt' then v_when end)
    on conflict (medication_id, scheduled_for) where medication_id is not null do nothing
    returning * into v_dose;

    if found then
      v_proceed := p_event_type = 'attempt';
    else
      select * into v_dose from public.doses
       where medication_id = p_medication_id and scheduled_for = p_scheduled_for
       for update;
      -- Só uma ocorrência em andamento pode ser finalizada; as demais não mudam.
      if p_event_type in ('actuated', 'failed') and v_dose.status = 'attempt' then
        update public.doses
           set status = p_event_type, finished_at = v_when,
               detail = coalesce(p_detail, detail), updated_at = now()
         where id = v_dose.id
        returning * into v_dose;
      end if;
    end if;
  elsif p_medication_id is not null or p_scheduled_for is not null then
    raise exception 'Evento do aparelho nao aceita medicamento' using errcode = '22023';
  end if;

  insert into public.device_events (user_id, device_id, event_uid, event_type, dose_id, detail, occurred_at)
  values (v_device.user_id, v_device.id, p_event_uid, p_event_type, v_dose.id, p_detail, v_when);

  return jsonb_build_object('status', 'recorded', 'proceed', v_proceed, 'dose_status', v_dose.status);
end;
$$;


-- ---------------------------------------------------------------------------
-- Quem pode executar cada função
-- (o Supabase libera funções novas para todos; restringimos aqui)
-- ---------------------------------------------------------------------------
revoke all on function public.medtech_valid_times(text[])                 from public, anon, authenticated;
revoke all on function public.medtech_valid_weekdays(smallint[])          from public, anon, authenticated;
revoke all on function public.medtech_medications_before_write()          from public, anon, authenticated;
revoke all on function public.medtech_device_from_token(text)             from public, anon, authenticated;
revoke all on function public.medtech_pair_device(text)                   from public, anon, authenticated;
revoke all on function public.medtech_unpair_device()                     from public, anon, authenticated;
revoke all on function public.medtech_confirm_dose(uuid)                  from public, anon, authenticated;
revoke all on function public.medtech_device_sync(text, text)             from public, anon, authenticated;
revoke all on function public.medtech_device_report(text, text, text, uuid, timestamptz, timestamptz, text)
  from public, anon, authenticated;

-- As restrições CHECK chamam estas duas como o usuário que grava.
grant execute on function public.medtech_valid_times(text[])        to authenticated;
grant execute on function public.medtech_valid_weekdays(smallint[]) to authenticated;

grant execute on function public.medtech_pair_device(text)  to authenticated;
grant execute on function public.medtech_unpair_device()    to authenticated;
grant execute on function public.medtech_confirm_dose(uuid) to authenticated;

-- O ESP32 não tem login: usa o papel anon e prova a identidade com o token.
grant execute on function public.medtech_device_sync(text, text) to anon, authenticated;
grant execute on function public.medtech_device_report(text, text, text, uuid, timestamptz, timestamptz, text)
  to anon, authenticated;
