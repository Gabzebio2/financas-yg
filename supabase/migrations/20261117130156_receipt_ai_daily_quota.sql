-- One unit per direct reading request, or two per queued page (read + review).
-- Four full 120-page documents fit in the daily allowance.
create schema receipt_limits;
revoke all on schema receipt_limits from public, anon, authenticated, service_role;

create table receipt_limits.daily_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_day date not null,
  units integer not null check (units between 1 and 960),
  primary key (user_id, usage_day)
);
alter table receipt_limits.daily_usage enable row level security;
revoke all on table receipt_limits.daily_usage from public, anon, authenticated, service_role;
create index receipt_daily_usage_expiry on receipt_limits.daily_usage (usage_day);

-- A project-wide budget also bounds usage when new accounts are created.
create table receipt_limits.project_usage (
  usage_day date primary key,
  units integer not null check (units between 0 and 1920)
);
alter table receipt_limits.project_usage enable row level security;
revoke all on table receipt_limits.project_usage from public, anon, authenticated, service_role;

create function receipt_limits.reserve_units(p_user uuid, p_units integer, p_scope text)
returns integer language plpgsql security invoker set search_path = '' as $$
declare
  today date := (statement_timestamp() at time zone 'UTC')::date;
  project_units integer;
  retry_after integer := greatest(1, ceil(extract(epoch from
    (((today + 1)::timestamp at time zone 'UTC') - statement_timestamp())
  ))::integer);
begin
  if p_user is null or p_units is null or p_units not between 1 and 240
    or p_scope is null or p_scope not in ('direct', 'create_job', 'enqueue_job') then
    raise exception 'invalid_read_reservation';
  end if;
  if not exists (
    select 1 from auth.users
    where id = p_user and not coalesce(is_anonymous, false)
      and (email_confirmed_at is not null or phone_confirmed_at is not null)
  ) then
    raise insufficient_privilege using message = 'login_required';
  end if;

  -- All reservations take the shared lock first, and fewer than two thousand
  -- updates per day can succeed. A refused request consumes neither budget.
  if p_scope <> 'create_job' then
    insert into receipt_limits.project_usage (usage_day, units) values (today, 0)
    on conflict (usage_day) do nothing;
    select units into project_units from receipt_limits.project_usage
      where usage_day = today for update;
    if project_units + p_units > 1920 then
      return retry_after;
    end if;
  end if;

  -- An upsert locks this user's daily counter across API instances and devices.
  if p_scope <> 'enqueue_job' then
    insert into receipt_limits.daily_usage as usage (user_id, usage_day, units)
    values (p_user, today, p_units)
    on conflict (user_id, usage_day) do update
      set units = usage.units + excluded.units
      where usage.units + excluded.units <= 960;
    if not found then
      return retry_after;
    end if;
  end if;
  if p_scope <> 'create_job' then
    update receipt_limits.project_usage set units = project_units + p_units
      where usage_day = today;
  end if;

  -- Remove old counters in small batches without waiting on other readers.
  delete from receipt_limits.daily_usage
  where (user_id, usage_day) in (
    select user_id, usage_day from receipt_limits.daily_usage
    where usage_day < today
    order by usage_day limit 16 for update skip locked
  );
  delete from receipt_limits.project_usage where usage_day < today;
  return 0;
end;
$$;
revoke all on function receipt_limits.reserve_units(uuid, integer, text) from public, anon, authenticated, service_role;

create function receipt_limits.reserve_my_direct_read(p_stamp bigint, p_proof text)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  backend_key text;
  expected text;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) then
    raise insufficient_privilege using message = 'login_required';
  end if;
  if p_stamp is null or p_stamp not between
    floor(extract(epoch from statement_timestamp()))::bigint - 120
    and floor(extract(epoch from statement_timestamp()))::bigint + 120
    or p_proof is null or length(p_proof) <> 64 then
    raise insufficient_privilege using message = 'invalid_read_reservation';
  end if;
  select token into backend_key from public.receipt_worker_config where id is true;
  if coalesce(length(backend_key), 0) = 0 then raise exception 'quota_unavailable'; end if;
  expected := encode(extensions.hmac(
    'receipt-direct-read:v1.' || auth.uid()::text || '.' || p_stamp::text,
    backend_key, 'sha256'
  ), 'hex');
  if extensions.digest(p_proof, 'sha256') <> extensions.digest(expected, 'sha256') then
    raise insufficient_privilege using message = 'invalid_read_reservation';
  end if;
  return receipt_limits.reserve_units(auth.uid(), 1, 'direct');
end;
$$;
revoke all on function receipt_limits.reserve_my_direct_read(bigint, text) from public, anon, authenticated, service_role;
grant usage on schema receipt_limits to authenticated;
grant execute on function receipt_limits.reserve_my_direct_read(bigint, text) to authenticated;

create function public.receipt_reserve_direct_read(p_stamp bigint, p_proof text)
returns integer language sql security invoker set search_path = '' as $$
  select receipt_limits.reserve_my_direct_read(p_stamp, p_proof);
$$;
revoke all on function public.receipt_reserve_direct_read(bigint, text) from public, anon, authenticated, service_role;
grant execute on function public.receipt_reserve_direct_read(bigint, text) to authenticated;

create function receipt_limits.charge_job()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if receipt_limits.reserve_units(new.user_id, 2 * new.total_pages, tg_argv[0]) > 0 then
    raise exception 'receipt_daily_limit';
  end if;
  return new;
end;
$$;
revoke all on function receipt_limits.charge_job() from public, anon, authenticated, service_role;
create trigger receipt_reserve_job_quota after insert on public.receipt_jobs
for each row execute function receipt_limits.charge_job('create_job');
-- A manifest that has merely been created never consumes the shared budget.
create trigger receipt_reserve_queued_quota after update of status on public.receipt_jobs
for each row when (old.status = 'uploading' and new.status = 'queued')
execute function receipt_limits.charge_job('enqueue_job');
