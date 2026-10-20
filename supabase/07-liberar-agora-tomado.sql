-- ============================================================================
-- MedTech — migração 07: "Liberar agora" também marca como tomado
--
-- Execute DEPOIS do 06, no SQL Editor do Supabase. Pode ser executado mais
-- de uma vez. Não apaga dados.
--
-- O que muda: quando o dispensador informa que abriu e fechou (ou ligou a
-- bomba) num pedido "Liberar agora", a dose é marcada como tomada
-- (user_confirmed_at), igual aos horários programados desde o 06. Assim
-- ninguém precisa tocar em "Retirei". Não precisa regravar o ESP32.
-- ============================================================================

-- Igual à do 04, com user_confirmed_at preenchido no "actuated".
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
           detail = coalesce(p_detail, detail), updated_at = now(),
           -- Abriu e fechou (ou a bomba terminou): tomado, sem precisar de "Retirei".
           user_confirmed_at = case when p_event_type = 'actuated' then v_when else user_confirmed_at end
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

revoke all on function public.medtech_device_request_report(text, text, text, uuid, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.medtech_device_request_report(text, text, text, uuid, timestamptz, text)
  to anon, authenticated;
