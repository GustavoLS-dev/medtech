-- ============================================================================
-- MedTech — migração 06: horários próprios de cada medicamento e "Tomado"
-- automático nos horários programados
--
-- Execute DEPOIS do 05, no SQL Editor do Supabase. Pode ser executado mais
-- de uma vez. Não apaga dados.
--
-- O que muda:
--   * Cada medicamento tem os PRÓPRIOS horários (medications.times, ex.:
--     {08:30,21:00}), iguais em todos os dias marcados. Os horários gerais de
--     manhã/tarde/noite deixam de ser usados.
--     Medicamentos já cadastrados recebem os horários dos períodos que tinham.
--   * Um horário do organizador passa a ser dia + hora. O "período" (manhã,
--     tarde, noite) vira só um rótulo calculado pela hora:
--     antes das 12:00 = manhã, antes das 18:00 = tarde, depois = noite.
--   * Quando o dispensador informa que abriu e fechou (ou ligou a bomba) num
--     horário programado, cada dose daquele horário é marcada como tomada
--     (user_confirmed_at). O "Liberar agora" continua pedindo "Retirei".
--   * Requer o firmware 2.5.
-- ============================================================================


-- Rótulo do período a partir da hora "HH:MM".
create or replace function public.medtech_period_of_time(p text)
returns text language sql immutable set search_path = '' as $$
  select case when p < '12:00' then 'morning' when p < '18:00' then 'afternoon' else 'night' end
$$;


-- ---------------------------------------------------------------------------
-- Horários dos medicamentos já cadastrados: os dos períodos que eles tinham
-- (configuração da conta, ou o padrão 08:00 / 13:00 / 20:00).
-- ---------------------------------------------------------------------------
update public.medications m
   set times = (
     select array_agg(distinct x.t order by x.t)
       from (select case p.period
                      when 'morning' then coalesce(s.morning_time, '08:00')
                      when 'afternoon' then coalesce(s.afternoon_time, '13:00')
                      else coalesce(s.night_time, '20:00') end as t
               from unnest(m.periods) as p(period)
               left join public.dispenser_settings s on s.user_id = m.user_id) as x)
 where (m.times is null or cardinality(m.times) = 0)
   and cardinality(m.periods) > 0;


-- ---------------------------------------------------------------------------
-- Agenda do ESP32: um item por dia + hora que tem medicamento ativo.
-- Igual à do 05 nos demais campos.
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
    'pump_seconds', coalesce(v_set.pump_seconds, 5),
    'slots', coalesce((
      select jsonb_agg(jsonb_build_object(
               'weekday', s.weekday,
               'period', public.medtech_period_of_time(s.slot_time),
               'time', s.slot_time,
               'medications', s.total,
               'solids', s.solids,
               'liquids', s.liquids,
               'updated_at', floor(extract(epoch from greatest(s.changed, v_set_at)))::bigint
             ) order by s.weekday, s.slot_time)
        from (
          select d.weekday, t.slot_time, count(*) as total,
                 count(*) filter (where m.form = 'solid') as solids,
                 count(*) filter (where m.form = 'liquid') as liquids,
                 max(m.updated_at) as changed
            from generate_series(0, 6) as d(weekday)
            join public.medications m
              on m.user_id = v_device.user_id and m.enabled and d.weekday = any (m.weekdays)
           cross join lateral unnest(coalesce(m.times, '{}')) as t(slot_time)
           group by d.weekday, t.slot_time
        ) as s
    ), '[]'::jsonb),
    'requests', coalesce((
      select jsonb_agg(jsonb_build_object(
               'weekday', extract(dow from r.scheduled_for at time zone 'America/Sao_Paulo')::int,
               'period', r.period,
               'scheduled_for', floor(extract(epoch from r.scheduled_for))::bigint
             ) order by r.created_at)
        from public.dispense_requests r
       where r.user_id = v_device.user_id and r.medication_id is null
         and r.status = 'pending' and public.medtech_request_active(r)
    ), '[]'::jsonb),
    'medication_requests', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', r.id,
               'weekday', r.weekday,
               'weekdays', coalesce(to_jsonb(r.weekdays), jsonb_build_array(r.weekday)),
               'form', m.form
             ) order by r.created_at)
        from public.dispense_requests r
        join public.medications m on m.id = r.medication_id
       where r.user_id = v_device.user_id
         and r.status = 'pending' and public.medtech_request_active(r)
    ), '[]'::jsonb)
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- Registro por horário (dia + hora), idempotente pelo event_uid.
-- Igual ao do 03, com duas diferenças:
--   * os medicamentos do horário são os que têm aquela hora em "times";
--   * "actuated" num horário programado marca cada dose como tomada.
-- p_period continua obrigatório (o firmware envia o rótulo), mas a dose
-- recebe o rótulo calculado pela hora.
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
  v_time    text;
  v_period  text;
  v_exists  boolean;
  v_count   int := 0;
  v_status  text;
  v_proceed boolean := false;
  v_auto    boolean;
  v_request public.dispense_requests;
  v_confirm timestamptz;
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
     where d.user_id = v_device.user_id and d.scheduled_for = p_scheduled_for and d.period is not null
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

    -- Pedido "Liberar período" (03) para este horário, se houver.
    select * into v_request from public.dispense_requests r
     where r.user_id = v_device.user_id and r.medication_id is null
       and r.period = p_period and r.scheduled_for = p_scheduled_for
     order by r.created_at desc limit 1;

    if p_scheduled_for <> date_trunc('minute', p_scheduled_for)
       or (p_scheduled_for > now() + interval '5 minutes'
           and not (v_request.id is not null and p_scheduled_for < now() + interval '1 day'))
       or p_scheduled_for < now() - interval '7 days' then
      raise exception 'Horario programado invalido' using errcode = '22023';
    end if;
    v_weekday := extract(dow from p_scheduled_for at time zone 'America/Sao_Paulo')::int;
    v_time := to_char(p_scheduled_for at time zone 'America/Sao_Paulo', 'HH24:MI');
    v_period := public.medtech_period_of_time(v_time);
    -- Horário programado que terminou bem = medicamento tomado.
    v_confirm := case when p_event_type = 'actuated' and v_request.id is null then v_when end;

    perform pg_advisory_xact_lock(hashtext(v_device.user_id::text || p_scheduled_for::text));
    select exists (select 1 from public.doses
                    where user_id = v_device.user_id and scheduled_for = p_scheduled_for and period is not null)
      into v_exists;

    if p_event_type = 'attempt' and not v_exists then
      select coalesce(s.automation_enabled, false) into v_auto
        from (select 1) as one left join public.dispenser_settings s on s.user_id = v_device.user_id;
      if not v_auto and not (v_request.id is not null and public.medtech_request_active(v_request)) then
        raise exception 'Automacao desligada no site' using errcode = '22023';
      end if;
    end if;

    if not v_exists then
      insert into public.doses (user_id, device_id, medication_id, medication_name, compartment,
                                scheduled_for, period, status, detail, attempt_at, finished_at, user_confirmed_at)
      select v_device.user_id, v_device.id, m.id, m.name, public.medtech_day_compartment(v_weekday),
             p_scheduled_for, v_period, p_event_type, p_detail,
             case when p_event_type = 'attempt' then v_when end,
             case when p_event_type <> 'attempt' then v_when end,
             v_confirm
        from public.medications m
       where m.user_id = v_device.user_id and m.enabled
         and v_weekday = any (m.weekdays) and v_time = any (coalesce(m.times, '{}'))
      on conflict (medication_id, scheduled_for) where medication_id is not null do nothing;
      get diagnostics v_count = row_count;

      if v_count = 0 and p_event_type = 'attempt' then
        raise exception 'Nenhum medicamento programado neste horario' using errcode = '22023';
      end if;
      v_proceed := p_event_type = 'attempt' and v_count > 0;
    elsif p_event_type in ('actuated', 'failed') then
      update public.doses
         set status = p_event_type, finished_at = v_when,
             detail = coalesce(p_detail, detail), updated_at = now(),
             user_confirmed_at = coalesce(v_confirm, user_confirmed_at)
       where user_id = v_device.user_id and scheduled_for = p_scheduled_for and period is not null
         and status = 'attempt';
    end if;

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
     where d.user_id = v_device.user_id and d.scheduled_for = p_scheduled_for and d.period is not null
     order by d.updated_at desc limit 1;
  elsif p_period is not null or p_scheduled_for is not null then
    raise exception 'Evento do aparelho nao aceita periodo' using errcode = '22023';
  end if;

  insert into public.device_events (user_id, device_id, event_uid, event_type, detail, occurred_at, period, scheduled_for)
  values (v_device.user_id, v_device.id, p_event_uid, p_event_type, p_detail, v_when, v_period, p_scheduled_for);

  return jsonb_build_object('status', 'recorded', 'proceed', v_proceed, 'dose_status', v_status,
                            'medications', v_count);
end;
$$;


-- ---------------------------------------------------------------------------
-- Permissões
-- ---------------------------------------------------------------------------
revoke all on function public.medtech_period_of_time(text)       from public, anon, authenticated;
revoke all on function public.medtech_device_agenda(text, text)  from public, anon, authenticated;
revoke all on function public.medtech_device_slot_report(text, text, text, text, timestamptz, timestamptz, text)
  from public, anon, authenticated;

grant execute on function public.medtech_device_agenda(text, text) to anon, authenticated;
grant execute on function public.medtech_device_slot_report(text, text, text, text, timestamptz, timestamptz, text)
  to anon, authenticated;
-- O site grava os horários do medicamento (coluna do 01; repetido aqui caso o 01 tenha sido executado de novo).
grant insert (times), update (times) on public.medications to authenticated;
