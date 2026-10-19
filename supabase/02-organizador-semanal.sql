-- ============================================================================
-- MedTech — migração 02: organizador semanal (dias × manhã/tarde/noite)
--
-- Execute DEPOIS do 01-medtech-dispensador.sql, no SQL Editor do Supabase.
-- Pode ser executado mais de uma vez. Não apaga dados nem funções antigas.
--
-- O que muda:
--   * cada compartimento físico é um DIA da semana (servo 0 = segunda ... 6 = domingo);
--   * cada medicamento recebe dias e períodos (manhã, tarde, noite);
--   * os horários de cada período, o tempo aberto e a automação ficam em
--     dispenser_settings, editados no site (sem comandos no terminal);
--   * novas funções do ESP32: medtech_device_agenda e medtech_device_slot_report.
--     As do 01 (medtech_device_sync / medtech_device_report) continuam
--     existindo, mas o firmware novo não as usa.
--
-- Alterações em medications (sem perda de dados):
--   * nova coluna periods;
--   * compartment e times deixam de ser obrigatórios (ficam como legado);
--   * sai a regra "um medicamento por compartimento", porque agora o
--     compartimento é o dia e vários medicamentos dividem o mesmo dia.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- Validações
-- ---------------------------------------------------------------------------

-- Períodos: subconjunto sem repetição de morning, afternoon, night.
create or replace function public.medtech_valid_periods(p text[])
returns boolean language sql immutable set search_path = '' as $$
  select p is not null
     and cardinality(p) <= 3
     and array_position(p, null) is null
     and (select coalesce(bool_and(x in ('morning', 'afternoon', 'night')), true) and count(distinct x) = count(*)
            from unnest(p) as x)
$$;

create or replace function public.medtech_valid_time(p text)
returns boolean language sql immutable set search_path = '' as $$
  select p ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
$$;


-- ---------------------------------------------------------------------------
-- Configuração do dispensador (uma linha por conta)
-- ---------------------------------------------------------------------------
create table if not exists public.dispenser_settings (
  user_id            uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  morning_time       text not null default '08:00' check (public.medtech_valid_time(morning_time)),
  afternoon_time     text not null default '13:00' check (public.medtech_valid_time(afternoon_time)),
  night_time         text not null default '20:00' check (public.medtech_valid_time(night_time)),
  open_seconds       smallint not null default 60 check (open_seconds between 5 and 300),
  automation_enabled boolean not null default false,
  updated_at         timestamptz not null default now(),
  constraint dispenser_settings_order check (morning_time < afternoon_time and afternoon_time < night_time)
);

create or replace function public.medtech_settings_before_write()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    new.user_id := old.user_id;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists dispenser_settings_before_write on public.dispenser_settings;
create trigger dispenser_settings_before_write before insert or update on public.dispenser_settings
  for each row execute function public.medtech_settings_before_write();


-- ---------------------------------------------------------------------------
-- Medicamentos: dias + períodos
-- ---------------------------------------------------------------------------
alter table public.medications add column if not exists periods text[] not null default '{}';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'medications_periods_check') then
    alter table public.medications add constraint medications_periods_check check (public.medtech_valid_periods(periods));
  end if;
end;
$$;

alter table public.medications alter column compartment drop not null;
alter table public.medications alter column times drop not null;
alter table public.medications drop constraint if exists medications_one_per_compartment;
-- A regra de horários passa a aceitar vazio (campo legado).
alter table public.medications drop constraint if exists medications_times_check;
alter table public.medications add constraint medications_times_check
  check (times is null or public.medtech_valid_times(times));

-- Mesma normalização do 01, aceitando horários vazios.
create or replace function public.medtech_medications_before_write()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.name := btrim(new.name);
  new.notes := nullif(btrim(new.notes), '');
  if new.times is not null then
    new.times := array(select t from unnest(new.times) as t order by t);
  end if;
  new.weekdays := array(select d from unnest(new.weekdays) as d order by d);
  -- Períodos sempre na ordem do dia.
  new.periods := array(select x from unnest(new.periods) as x
                        order by array_position(array['morning', 'afternoon', 'night'], x));
  if tg_op = 'UPDATE' then
    new.user_id := old.user_id;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;


-- ---------------------------------------------------------------------------
-- Doses e eventos: período do horário
-- ---------------------------------------------------------------------------
alter table public.doses add column if not exists period text
  check (period is null or period in ('morning', 'afternoon', 'night'));
alter table public.device_events add column if not exists period text
  check (period is null or period in ('morning', 'afternoon', 'night'));
alter table public.device_events add column if not exists scheduled_for timestamptz;
create index if not exists doses_user_slot on public.doses (user_id, scheduled_for, period);


-- ---------------------------------------------------------------------------
-- Permissões e RLS
-- ---------------------------------------------------------------------------
alter table public.dispenser_settings enable row level security;
revoke all on table public.dispenser_settings from public, anon, authenticated;
grant select on public.dispenser_settings to authenticated;
grant insert (morning_time, afternoon_time, night_time, open_seconds, automation_enabled)
  on public.dispenser_settings to authenticated;
grant update (morning_time, afternoon_time, night_time, open_seconds, automation_enabled)
  on public.dispenser_settings to authenticated;

drop policy if exists settings_select_own on public.dispenser_settings;
create policy settings_select_own on public.dispenser_settings
  for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists settings_insert_own on public.dispenser_settings;
create policy settings_insert_own on public.dispenser_settings
  for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists settings_update_own on public.dispenser_settings;
create policy settings_update_own on public.dispenser_settings
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- O site grava os períodos do medicamento.
grant insert (periods), update (periods) on public.medications to authenticated;


-- ---------------------------------------------------------------------------
-- Funções do ESP32
-- ---------------------------------------------------------------------------

-- Compartimento físico do dia: segunda = 1 ... domingo = 7 (servo = compartimento - 1).
create or replace function public.medtech_day_compartment(p_weekday int)
returns smallint language sql immutable set search_path = '' as $$
  select (case when p_weekday = 0 then 7 else p_weekday end)::smallint
$$;

-- Agenda do organizador: um item por dia + período que tem medicamento ativo.
-- weekday segue o padrão 0 = domingo ... 6 = sábado. Não envia nomes.
create or replace function public.medtech_device_agenda(p_token text, p_firmware text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_device public.devices;
  v_set    public.dispenser_settings;
  v_set_at timestamptz;
begin
  v_device := public.medtech_device_from_token(p_token);
  if p_firmware is not null and p_firmware !~ '^[A-Za-z0-9._-]{1,32}$' then
    raise exception 'Versao de firmware invalida' using errcode = '22023';
  end if;

  update public.devices
     set last_seen_at = now(), firmware_version = coalesce(p_firmware, firmware_version)
   where id = v_device.id;

  select * into v_set from public.dispenser_settings where user_id = v_device.user_id;
  v_set_at := coalesce(v_set.updated_at, 'epoch'::timestamptz);

  return jsonb_build_object(
    'timezone', 'America/Sao_Paulo',
    'server_time', floor(extract(epoch from now()))::bigint,
    'automation_enabled', coalesce(v_set.automation_enabled, false),
    'open_seconds', coalesce(v_set.open_seconds, 60),
    'slots', coalesce((
      select jsonb_agg(jsonb_build_object(
               'weekday', s.weekday,
               'period', s.period,
               'time', s.slot_time,
               'medications', s.total,
               'updated_at', floor(extract(epoch from greatest(s.changed, v_set_at)))::bigint
             ) order by s.weekday, s.slot_time)
        from (
          select d.weekday, p.period, p.slot_time, count(*) as total, max(m.updated_at) as changed
            from generate_series(0, 6) as d(weekday)
           cross join (values ('morning', coalesce(v_set.morning_time, '08:00')),
                              ('afternoon', coalesce(v_set.afternoon_time, '13:00')),
                              ('night', coalesce(v_set.night_time, '20:00'))) as p(period, slot_time)
            join public.medications m
              on m.user_id = v_device.user_id and m.enabled
             and d.weekday = any (m.weekdays) and p.period = any (m.periods)
           group by d.weekday, p.period, p.slot_time
        ) as s
    ), '[]'::jsonb)
  );
end;
$$;

-- Registro de eventos por horário (dia + período), idempotente pelo event_uid.
--   attempt  → cria uma dose para cada medicamento do horário; "proceed" = true
--              só se o horário ainda não tinha sido tratado. Recusa se a
--              automação estiver desligada no site ou não houver medicamento.
--   actuated / failed → finalizam as doses em "attempt" do horário (ou as criam)
--   missed   → cria as doses como não abertas, se o horário ainda não existir
--   boot / error → eventos do aparelho
create or replace function public.medtech_device_slot_report(
  p_token         text,
  p_event_uid     text,
  p_event_type    text,
  p_period        text default null,
  p_scheduled_for timestamptz default null,
  p_occurred_at   timestamptz default null,
  p_detail        text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_device  public.devices;
  v_when    timestamptz := coalesce(p_occurred_at, now());
  v_weekday int;
  v_exists  boolean;
  v_count   int := 0;
  v_status  text;
  v_proceed boolean := false;
  v_auto    boolean;
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
  if exists (select 1 from public.device_events where device_id = v_device.id and event_uid = p_event_uid) then
    select d.status into v_status from public.doses d
     where d.user_id = v_device.user_id and d.scheduled_for = p_scheduled_for and d.period = p_period
     limit 1;
    return jsonb_build_object('status', 'duplicate', 'proceed', false, 'dose_status', v_status);
  end if;

  if (select count(*) from public.device_events
       where device_id = v_device.id and received_at > now() - interval '1 minute') >= 30 then
    raise exception 'Limite de eventos por minuto atingido' using errcode = 'PT429';
  end if;

  if p_event_type in ('attempt', 'actuated', 'failed', 'missed') then
    if p_period is null or p_period not in ('morning', 'afternoon', 'night') or p_scheduled_for is null then
      raise exception 'Evento de dose sem periodo ou horario' using errcode = '22023';
    end if;
    if p_scheduled_for <> date_trunc('minute', p_scheduled_for)
       or p_scheduled_for > now() + interval '5 minutes'
       or p_scheduled_for < now() - interval '7 days' then
      raise exception 'Horario programado invalido' using errcode = '22023';
    end if;
    v_weekday := extract(dow from p_scheduled_for at time zone 'America/Sao_Paulo')::int;

    -- Trava o horário para duas chamadas simultâneas não criarem doses em dobro.
    perform pg_advisory_xact_lock(hashtext(v_device.user_id::text || p_period || p_scheduled_for::text));
    select exists (select 1 from public.doses
                    where user_id = v_device.user_id and scheduled_for = p_scheduled_for and period = p_period)
      into v_exists;

    if p_event_type = 'attempt' then
      select coalesce(s.automation_enabled, false) into v_auto
        from (select 1) as one left join public.dispenser_settings s on s.user_id = v_device.user_id;
      if not v_auto then
        raise exception 'Automacao desligada no site' using errcode = '22023';
      end if;
    end if;

    if not v_exists then
      -- Uma dose por medicamento programado neste dia e período.
      insert into public.doses (user_id, device_id, medication_id, medication_name, compartment,
                                scheduled_for, period, status, detail, attempt_at, finished_at)
      select v_device.user_id, v_device.id, m.id, m.name, public.medtech_day_compartment(v_weekday),
             p_scheduled_for, p_period, p_event_type, p_detail,
             case when p_event_type = 'attempt' then v_when end,
             case when p_event_type <> 'attempt' then v_when end
        from public.medications m
       where m.user_id = v_device.user_id and m.enabled
         and v_weekday = any (m.weekdays) and p_period = any (m.periods)
      on conflict (medication_id, scheduled_for) where medication_id is not null do nothing;
      get diagnostics v_count = row_count;

      if v_count = 0 and p_event_type = 'attempt' then
        raise exception 'Nenhum medicamento programado neste horario' using errcode = '22023';
      end if;
      v_proceed := p_event_type = 'attempt' and v_count > 0;
    elsif p_event_type in ('actuated', 'failed') then
      -- Só doses em andamento são finalizadas; as demais não mudam.
      update public.doses
         set status = p_event_type, finished_at = v_when,
             detail = coalesce(p_detail, detail), updated_at = now()
       where user_id = v_device.user_id and scheduled_for = p_scheduled_for and period = p_period
         and status = 'attempt';
    end if;

    select d.status into v_status from public.doses d
     where d.user_id = v_device.user_id and d.scheduled_for = p_scheduled_for and d.period = p_period
     order by d.updated_at desc limit 1;
  elsif p_period is not null or p_scheduled_for is not null then
    raise exception 'Evento do aparelho nao aceita periodo' using errcode = '22023';
  end if;

  insert into public.device_events (user_id, device_id, event_uid, event_type, detail, occurred_at, period, scheduled_for)
  values (v_device.user_id, v_device.id, p_event_uid, p_event_type, p_detail, v_when, p_period, p_scheduled_for);

  return jsonb_build_object('status', 'recorded', 'proceed', v_proceed, 'dose_status', v_status,
                            'medications', v_count);
end;
$$;


-- O usuário confirma a retirada de todas as doses acionadas de um horário.
create or replace function public.medtech_confirm_slot(p_scheduled_for timestamptz, p_period text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_count int;
begin
  if auth.uid() is null then
    raise exception 'Entre na sua conta' using errcode = '42501';
  end if;
  update public.doses
     set user_confirmed_at = now(), updated_at = now()
   where user_id = auth.uid() and scheduled_for = p_scheduled_for and period = p_period
     and status = 'actuated' and user_confirmed_at is null;
  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise exception 'Este horario nao pode ser confirmado' using errcode = 'P0001',
      hint = 'Somente horarios com acionamento realizado e ainda nao confirmados.';
  end if;
  return jsonb_build_object('confirmed', v_count);
end;
$$;


-- ---------------------------------------------------------------------------
-- Quem pode executar cada função
-- ---------------------------------------------------------------------------
revoke all on function public.medtech_valid_periods(text[])           from public, anon, authenticated;
revoke all on function public.medtech_valid_time(text)                 from public, anon, authenticated;
revoke all on function public.medtech_settings_before_write()          from public, anon, authenticated;
revoke all on function public.medtech_medications_before_write()       from public, anon, authenticated;
revoke all on function public.medtech_day_compartment(int)             from public, anon, authenticated;
revoke all on function public.medtech_device_agenda(text, text)        from public, anon, authenticated;
revoke all on function public.medtech_device_slot_report(text, text, text, text, timestamptz, timestamptz, text)
  from public, anon, authenticated;
revoke all on function public.medtech_confirm_slot(timestamptz, text) from public, anon, authenticated;

-- Usadas pelas restrições CHECK quando o site grava.
grant execute on function public.medtech_valid_periods(text[]) to authenticated;
grant execute on function public.medtech_valid_time(text)      to authenticated;

grant execute on function public.medtech_confirm_slot(timestamptz, text) to authenticated;
grant execute on function public.medtech_device_agenda(text, text) to anon, authenticated;
grant execute on function public.medtech_device_slot_report(text, text, text, text, timestamptz, timestamptz, text)
  to anon, authenticated;
