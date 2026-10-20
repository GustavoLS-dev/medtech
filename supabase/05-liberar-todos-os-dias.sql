-- ============================================================================
-- MedTech — migração 05: "Liberar agora" abre todos os dias do medicamento
--
-- Execute DEPOIS do 04, no SQL Editor do Supabase. Pode ser executado mais
-- de uma vez. Não apaga dados.
--
-- O que muda:
--   * dispense_requests.weekdays: os dias (compartimentos) que o pedido abre.
--   * medtech_request_medication grava todos os dias do medicamento; a
--     cápsula abre cada um desses compartimentos, um por vez.
--   * medtech_device_agenda envia "weekdays" em cada pedido por medicamento.
--     O firmware 2.3 ignora o campo e continua abrindo só "weekday".
-- ============================================================================

alter table public.dispense_requests add column if not exists weekdays smallint[];


-- Igual à do 04, gravando também todos os dias do medicamento.
-- weekday continua sendo hoje (ou o próximo dia programado): é o
-- compartimento registrado na dose.
create or replace function public.medtech_request_medication(p_medication_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid := auth.uid();
  v_today   int := extract(dow from now() at time zone 'America/Sao_Paulo')::int;
  v_med     public.medications;
  v_weekday int;
  v_req     public.dispense_requests;
begin
  if v_uid is null then
    raise exception 'Entre na sua conta' using errcode = '42501';
  end if;
  select * into v_med from public.medications where id = p_medication_id and user_id = v_uid;
  if not found then
    raise exception 'Medicamento nao encontrado' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.devices where user_id = v_uid) then
    raise exception 'Nenhum dispensador vinculado a esta conta' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('medtech-request-' || v_uid::text));
  if exists (select 1 from public.dispense_requests r
              where r.user_id = v_uid and public.medtech_request_active(r)) then
    raise exception 'Ja existe um pedido aguardando o dispensador' using errcode = 'P0001';
  end if;

  select (v_today + n) % 7 into v_weekday
    from generate_series(0, 6) as n
   where (v_today + n) % 7 = any (v_med.weekdays)
   order by n limit 1;

  insert into public.dispense_requests (user_id, medication_id, weekday, weekdays, scheduled_for)
  values (v_uid, v_med.id, coalesce(v_weekday, v_today), v_med.weekdays, now())
  returning * into v_req;
  return jsonb_build_object('id', v_req.id, 'weekday', v_req.weekday, 'weekdays', to_jsonb(v_req.weekdays),
                            'form', v_med.form);
end;
$$;


-- Agenda do ESP32: igual à do 04, com "weekdays" nos pedidos por medicamento.
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
               'period', s.period,
               'time', s.slot_time,
               'medications', s.total,
               'solids', s.solids,
               'liquids', s.liquids,
               'updated_at', floor(extract(epoch from greatest(s.changed, v_set_at)))::bigint
             ) order by s.weekday, s.slot_time)
        from (
          select d.weekday, p.period, p.slot_time, count(*) as total,
                 count(*) filter (where m.form = 'solid') as solids,
                 count(*) filter (where m.form = 'liquid') as liquids,
                 max(m.updated_at) as changed
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


revoke all on function public.medtech_request_medication(uuid)  from public, anon, authenticated;
revoke all on function public.medtech_device_agenda(text, text) from public, anon, authenticated;
grant execute on function public.medtech_request_medication(uuid)  to authenticated;
grant execute on function public.medtech_device_agenda(text, text) to anon, authenticated;
