-- ============================================================================
-- MedTech — migração 03: "Liberar agora" e atualização em tempo real
--
-- Execute DEPOIS do 02, no SQL Editor do Supabase. Pode ser executado mais
-- de uma vez. Não apaga dados.
--
-- O que muda:
--   * dispense_requests: pedidos "Liberar agora" feitos no site. O servidor
--     calcula o horário de HOJE do período escolhido; o ESP32 recebe o pedido
--     na agenda, abre o compartimento do dia e registra aquele período. Quando
--     o horário normal chegar, ele já consta como tratado e não abre de novo.
--   * medtech_device_agenda passa a enviar os pedidos pendentes (até 2 min).
--   * medtech_device_slot_report aceita o horário do pedido mesmo antes da
--     hora e mesmo com a automação desligada (é um comando explícito do usuário).
--   * Realtime: o site recebe as mudanças de doses, eventos, pedidos,
--     medicamentos e configuração no mesmo instante.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- Pedidos "Liberar agora"
-- ---------------------------------------------------------------------------
create table if not exists public.dispense_requests (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  period        text not null check (period in ('morning', 'afternoon', 'night')),
  scheduled_for timestamptz not null,
  status        text not null default 'pending' check (status in ('pending', 'taken', 'done', 'failed')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists dispense_requests_user_time on public.dispense_requests (user_id, created_at desc);

-- Um pedido só vale por 2 minutos: se o aparelho estiver desligado, ele não
-- abre a gaveta horas depois por causa de um clique antigo.
create or replace function public.medtech_request_active(p public.dispense_requests)
returns boolean language sql stable set search_path = '' as $$
  select p.status in ('pending', 'taken') and p.created_at > now() - interval '2 minutes'
$$;

alter table public.dispense_requests enable row level security;
revoke all on table public.dispense_requests from public, anon, authenticated;
grant select on public.dispense_requests to authenticated;
drop policy if exists requests_select_own on public.dispense_requests;
create policy requests_select_own on public.dispense_requests
  for select to authenticated using (user_id = (select auth.uid()));


-- O site pede para liberar agora o período de hoje (o servidor calcula o horário).
create or replace function public.medtech_request_dispense(p_period text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid := auth.uid();
  v_local   timestamp := now() at time zone 'America/Sao_Paulo';
  v_weekday int := extract(dow from v_local)::int;
  v_set     public.dispenser_settings;
  v_time    text;
  v_sched   timestamptz;
  v_req     public.dispense_requests;
begin
  if v_uid is null then
    raise exception 'Entre na sua conta' using errcode = '42501';
  end if;
  if p_period is null or p_period not in ('morning', 'afternoon', 'night') then
    raise exception 'Periodo invalido' using errcode = '22023';
  end if;
  if not exists (select 1 from public.devices where user_id = v_uid) then
    raise exception 'Nenhum dispensador vinculado a esta conta' using errcode = 'P0001';
  end if;

  select * into v_set from public.dispenser_settings where user_id = v_uid;
  v_time := case p_period
              when 'morning' then coalesce(v_set.morning_time, '08:00')
              when 'afternoon' then coalesce(v_set.afternoon_time, '13:00')
              else coalesce(v_set.night_time, '20:00') end;
  v_sched := (v_local::date + v_time::time) at time zone 'America/Sao_Paulo';

  if not exists (select 1 from public.medications m
                  where m.user_id = v_uid and m.enabled
                    and v_weekday = any (m.weekdays) and p_period = any (m.periods)) then
    raise exception 'Nenhum medicamento programado para este periodo hoje' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.doses
              where user_id = v_uid and scheduled_for = v_sched and period = p_period) then
    raise exception 'Este periodo ja foi tratado hoje' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.dispense_requests r
              where r.user_id = v_uid and public.medtech_request_active(r)) then
    raise exception 'Ja existe um pedido aguardando o dispensador' using errcode = 'P0001';
  end if;

  insert into public.dispense_requests (user_id, period, scheduled_for)
  values (v_uid, p_period, v_sched)
  returning * into v_req;
  return jsonb_build_object('id', v_req.id, 'scheduled_for', v_req.scheduled_for);
end;
$$;


-- ---------------------------------------------------------------------------
-- Agenda do ESP32: igual à do 02, mais os pedidos ativos
-- ---------------------------------------------------------------------------
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
    ), '[]'::jsonb),
    'requests', coalesce((
      select jsonb_agg(jsonb_build_object(
               'weekday', extract(dow from r.scheduled_for at time zone 'America/Sao_Paulo')::int,
               'period', r.period,
               'scheduled_for', floor(extract(epoch from r.scheduled_for))::bigint
             ) order by r.created_at)
        from public.dispense_requests r
       where r.user_id = v_device.user_id and r.status = 'pending' and public.medtech_request_active(r)
    ), '[]'::jsonb)
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- Registro por horário: igual ao do 02, aceitando pedidos "Liberar agora"
-- ---------------------------------------------------------------------------
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
  v_request public.dispense_requests;
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

    -- Pedido "Liberar agora" para este horário (o mais recente).
    select * into v_request from public.dispense_requests r
     where r.user_id = v_device.user_id and r.period = p_period and r.scheduled_for = p_scheduled_for
     order by r.created_at desc limit 1;

    if p_scheduled_for <> date_trunc('minute', p_scheduled_for)
       or (p_scheduled_for > now() + interval '5 minutes'
           and not (v_request.id is not null and p_scheduled_for < now() + interval '1 day'))
       or p_scheduled_for < now() - interval '7 days' then
      raise exception 'Horario programado invalido' using errcode = '22023';
    end if;
    v_weekday := extract(dow from p_scheduled_for at time zone 'America/Sao_Paulo')::int;

    perform pg_advisory_xact_lock(hashtext(v_device.user_id::text || p_period || p_scheduled_for::text));
    select exists (select 1 from public.doses
                    where user_id = v_device.user_id and scheduled_for = p_scheduled_for and period = p_period)
      into v_exists;

    -- Horário já tratado responde "proceed: false" abaixo; só um horário novo
    -- precisa de autorização.
    if p_event_type = 'attempt' and not v_exists then
      select coalesce(s.automation_enabled, false) into v_auto
        from (select 1) as one left join public.dispenser_settings s on s.user_id = v_device.user_id;
      -- Sem automação, só um pedido ativo do usuário autoriza a abertura.
      if not v_auto and not (v_request.id is not null and public.medtech_request_active(v_request)) then
        raise exception 'Automacao desligada no site' using errcode = '22023';
      end if;
    end if;

    if not v_exists then
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
      update public.doses
         set status = p_event_type, finished_at = v_when,
             detail = coalesce(p_detail, detail), updated_at = now()
       where user_id = v_device.user_id and scheduled_for = p_scheduled_for and period = p_period
         and status = 'attempt';
    end if;

    -- Situação do pedido, para o site acompanhar.
    if v_request.id is not null then
      update public.dispense_requests
         set status = case
                        when p_event_type = 'attempt' and v_proceed then 'taken'
                        when p_event_type = 'attempt' then 'failed'
                        when p_event_type = 'actuated' then 'done'
                        else 'failed' end,
             updated_at = now()
       where id = v_request.id and status in ('pending', 'taken');
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


-- ---------------------------------------------------------------------------
-- Permissões
-- ---------------------------------------------------------------------------
revoke all on function public.medtech_request_active(public.dispense_requests) from public, anon, authenticated;
revoke all on function public.medtech_request_dispense(text)                   from public, anon, authenticated;
revoke all on function public.medtech_device_agenda(text, text)                from public, anon, authenticated;
revoke all on function public.medtech_device_slot_report(text, text, text, text, timestamptz, timestamptz, text)
  from public, anon, authenticated;

grant execute on function public.medtech_request_dispense(text) to authenticated;
grant execute on function public.medtech_device_agenda(text, text) to anon, authenticated;
grant execute on function public.medtech_device_slot_report(text, text, text, text, timestamptz, timestamptz, text)
  to anon, authenticated;


-- ---------------------------------------------------------------------------
-- Realtime: o site é avisado na hora quando estas tabelas mudam.
-- O Realtime respeita o RLS: cada conta só recebe as próprias linhas.
-- (devices fica de fora porque o hash do token não é legível pelo site.)
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['doses', 'device_events', 'dispense_requests', 'medications', 'dispenser_settings'] loop
      if not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end;
$$;
