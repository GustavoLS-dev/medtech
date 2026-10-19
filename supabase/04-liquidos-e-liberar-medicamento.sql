-- ============================================================================
-- MedTech — migração 04: medicamentos líquidos (bomba) e "Liberar agora" por medicamento
--
-- Execute DEPOIS do 03, no SQL Editor do Supabase. Pode ser executado mais
-- de uma vez. Não apaga dados.
--
-- O que muda:
--   * medications.form: 'solid' (cápsula/comprimido, sai pela gaveta do dia)
--     ou 'liquid' (sai pela bomba, ligada pelo relé). Os já cadastrados
--     ficam como 'solid'.
--   * dispenser_settings.pump_seconds: quanto tempo o relé deixa a bomba
--     ligada em cada liberação de líquido (1 a 30 s, padrão 5).
--   * A agenda do ESP32 informa, em cada horário, quantos medicamentos são
--     sólidos e quantos são líquidos: a gaveta só abre se houver sólido e a
--     bomba só liga se houver líquido.
--   * "Liberar agora" por medicamento (medtech_request_medication): vale para
--     qualquer medicamento, a qualquer hora, sem marcar o horário programado
--     como tratado. Sólido abre o compartimento do dia (ou do próximo dia em
--     que ele está programado); líquido liga a bomba.
--   * medtech_device_request_report: o ESP32 registra o resultado desse pedido.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- Forma do medicamento
-- ---------------------------------------------------------------------------
alter table public.medications add column if not exists form text not null default 'solid';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'medications_form_check') then
    alter table public.medications add constraint medications_form_check check (form in ('solid', 'liquid'));
  end if;
end;
$$;

grant insert (form), update (form) on public.medications to authenticated;


-- ---------------------------------------------------------------------------
-- Tempo da bomba
-- ---------------------------------------------------------------------------
alter table public.dispenser_settings add column if not exists pump_seconds smallint not null default 5;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'dispenser_settings_pump_check') then
    alter table public.dispenser_settings add constraint dispenser_settings_pump_check check (pump_seconds between 1 and 30);
  end if;
end;
$$;

grant insert (pump_seconds), update (pump_seconds) on public.dispenser_settings to authenticated;


-- ---------------------------------------------------------------------------
-- Pedidos por medicamento
-- Um pedido é de um período (03) OU de um medicamento (04), nunca dos dois.
-- ---------------------------------------------------------------------------
alter table public.dispense_requests add column if not exists medication_id uuid
  references public.medications (id) on delete cascade;
alter table public.dispense_requests add column if not exists weekday smallint
  check (weekday is null or weekday between 0 and 6);
alter table public.dispense_requests alter column period drop not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'dispense_requests_target') then
    alter table public.dispense_requests add constraint dispense_requests_target
      check ((medication_id is null) = (period is not null));
  end if;
end;
$$;


-- O site pede para liberar agora um medicamento.
-- weekday: hoje, se o medicamento está programado para hoje; senão, o próximo
-- dia em que ele está (é nesse compartimento que a cápsula foi colocada).
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

  -- Um pedido por vez: dois cliques ao mesmo tempo não criam dois pedidos.
  perform pg_advisory_xact_lock(hashtext('medtech-request-' || v_uid::text));
  if exists (select 1 from public.dispense_requests r
              where r.user_id = v_uid and public.medtech_request_active(r)) then
    raise exception 'Ja existe um pedido aguardando o dispensador' using errcode = 'P0001';
  end if;

  select (v_today + n) % 7 into v_weekday
    from generate_series(0, 6) as n
   where (v_today + n) % 7 = any (v_med.weekdays)
   order by n limit 1;

  insert into public.dispense_requests (user_id, medication_id, weekday, scheduled_for)
  values (v_uid, v_med.id, coalesce(v_weekday, v_today), now())
  returning * into v_req;
  return jsonb_build_object('id', v_req.id, 'weekday', v_req.weekday, 'form', v_med.form);
end;
$$;


-- ---------------------------------------------------------------------------
-- Agenda do ESP32: igual à do 03, mais sólidos/líquidos, tempo da bomba e
-- pedidos por medicamento (em "medication_requests", que o firmware 2.1 ignora).
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
    -- Pedidos de período (03). Os por medicamento ficam fora daqui: o
    -- firmware 2.1 recusaria a agenda inteira com um item sem período.
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
-- Resultado de um pedido por medicamento, idempotente pelo event_uid.
--   attempt  → cria a dose (status attempt) se o pedido ainda está pendente e
--              válido; "proceed" = true só nesse caso
--   actuated / failed → finalizam a dose e o pedido
-- A dose fica sem período (period = null): é uma liberação manual e não
-- marca nenhum horário programado como tratado.
-- ---------------------------------------------------------------------------
create or replace function public.medtech_device_request_report(
  p_token       text,
  p_event_uid   text,
  p_event_type  text,
  p_request_id  uuid,
  p_occurred_at timestamptz default null,
  p_detail      text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_device  public.devices;
  v_when    timestamptz := coalesce(p_occurred_at, now());
  v_req     public.dispense_requests;
  v_med     public.medications;
  v_dose    public.doses;
  v_proceed boolean := false;
begin
  v_device := public.medtech_device_from_token(p_token);

  if p_event_uid is null or p_event_uid !~ '^[A-Za-z0-9_-]{8,64}$' then
    raise exception 'Identificador de evento invalido' using errcode = '22023';
  end if;
  if p_event_type is null or p_event_type not in ('attempt', 'actuated', 'failed') then
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

  if (select count(*) from public.device_events
       where device_id = v_device.id and received_at > now() - interval '1 minute') >= 30 then
    raise exception 'Limite de eventos por minuto atingido' using errcode = 'PT429';
  end if;

  -- O pedido precisa ser do dono deste aparelho.
  select * into v_req from public.dispense_requests
   where id = p_request_id and user_id = v_device.user_id and medication_id is not null
   for update;
  if not found then
    raise exception 'Pedido nao encontrado para este aparelho' using errcode = '22023';
  end if;
  select * into v_med from public.medications where id = v_req.medication_id;

  if p_event_type = 'attempt' then
    if v_req.status = 'pending' and public.medtech_request_active(v_req) then
      insert into public.doses (user_id, device_id, medication_id, medication_name, compartment,
                                scheduled_for, period, status, detail, attempt_at)
      values (v_device.user_id, v_device.id, v_med.id, v_med.name,
              public.medtech_day_compartment(coalesce(v_req.weekday, 0)),
              v_req.scheduled_for, null, 'attempt', 'liberacao_manual', v_when)
      on conflict (medication_id, scheduled_for) where medication_id is not null do nothing
      returning * into v_dose;
      v_proceed := found;
    end if;
    update public.dispense_requests
       set status = case when v_proceed then 'taken' when status = 'pending' then 'failed' else status end,
           updated_at = now()
     where id = v_req.id;
  else
    update public.doses
       set status = p_event_type, finished_at = v_when,
           detail = coalesce(p_detail, detail), updated_at = now()
     where user_id = v_device.user_id and medication_id = v_req.medication_id
       and scheduled_for = v_req.scheduled_for and status = 'attempt'
    returning * into v_dose;
    if not found then
      select * into v_dose from public.doses
       where user_id = v_device.user_id and medication_id = v_req.medication_id
         and scheduled_for = v_req.scheduled_for;
    end if;
    update public.dispense_requests
       set status = case when p_event_type = 'actuated' then 'done' else 'failed' end, updated_at = now()
     where id = v_req.id and status in ('pending', 'taken');
  end if;

  insert into public.device_events (user_id, device_id, event_uid, event_type, dose_id, detail, occurred_at, scheduled_for)
  values (v_device.user_id, v_device.id, p_event_uid, p_event_type, v_dose.id, p_detail, v_when, v_req.scheduled_for);

  return jsonb_build_object('status', 'recorded', 'proceed', v_proceed, 'dose_status', v_dose.status);
end;
$$;


-- ---------------------------------------------------------------------------
-- Permissões
-- ---------------------------------------------------------------------------
revoke all on function public.medtech_request_medication(uuid)  from public, anon, authenticated;
revoke all on function public.medtech_device_agenda(text, text) from public, anon, authenticated;
revoke all on function public.medtech_device_request_report(text, text, text, uuid, timestamptz, text)
  from public, anon, authenticated;

grant execute on function public.medtech_request_medication(uuid)  to authenticated;
grant execute on function public.medtech_device_agenda(text, text) to anon, authenticated;
grant execute on function public.medtech_device_request_report(text, text, text, uuid, timestamptz, text)
  to anon, authenticated;
