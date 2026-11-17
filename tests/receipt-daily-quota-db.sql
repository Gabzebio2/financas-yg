-- Run only in an isolated database with fictitious accounts.
begin;
do $$
begin
  if current_setting('receipt_test.sandbox', true) is distinct from 'local' then
    raise exception 'This fixture requires an isolated test database';
  end if;
end;
$$;
insert into auth.users(id, email_confirmed_at) values
  ('00000000-0000-4000-8000-000000000001', now()),
  ('00000000-0000-4000-8000-000000000002', now()),
  ('00000000-0000-4000-8000-000000000003', null);
insert into public.receipt_worker_config(id, token) values (true, 'local-fixture-only');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated","is_anonymous":false}', true);
select set_config('receipt_test.stamp', floor(extract(epoch from now()))::bigint::text, true);
select set_config('receipt_test.proof', encode(extensions.hmac(
  'receipt-direct-read:v1.00000000-0000-4000-8000-000000000001.' || current_setting('receipt_test.stamp'),
  'local-fixture-only', 'sha256'), 'hex'), true);
set local role authenticated;
do $$
begin
  if public.receipt_reserve_direct_read(current_setting('receipt_test.stamp')::bigint,
    current_setting('receipt_test.proof')) <> 0 then raise exception 'valid reservation failed'; end if;
end;
$$;
reset role;

do $$
declare
  alice uuid := '00000000-0000-4000-8000-000000000001';
  bob uuid := '00000000-0000-4000-8000-000000000002';
  j uuid := gen_random_uuid();
  stamp bigint := floor(extract(epoch from now()))::bigint;
  retry_after integer;
begin
  if has_function_privilege('anon', 'public.receipt_reserve_direct_read(bigint,text)', 'EXECUTE')
  or not has_function_privilege('authenticated', 'public.receipt_reserve_direct_read(bigint,text)', 'EXECUTE')
  or has_function_privilege('authenticated', 'receipt_limits.reserve_units(uuid,integer,text)', 'EXECUTE')
  or has_table_privilege('authenticated', 'receipt_limits.daily_usage', 'INSERT,SELECT,UPDATE,DELETE')
  then raise exception 'quota privilege regression'; end if;

  begin
    perform public.receipt_reserve_direct_read(stamp, null);
    raise exception 'missing reservation proof accepted';
  exception when insufficient_privilege then null; end;
  begin
    perform receipt_limits.reserve_units('00000000-0000-4000-8000-000000000003', 1, 'direct');
    raise exception 'unconfirmed account accepted';
  exception when insufficient_privilege then null; end;

  insert into public.receipt_jobs(id,user_id,folder_id,total_pages) values (j,alice,'fixture',120);
  if (select units from receipt_limits.project_usage) <> 1 then raise exception 'unsubmitted upload charged project'; end if;
  update public.receipt_jobs set status='queued' where id=j;
  update public.receipt_jobs set status='processing' where id=j;
  update public.receipt_jobs set status='queued' where id=j;
  delete from public.receipt_jobs where id=j;
  if (select units from receipt_limits.project_usage) <> 241 or
     (select units from receipt_limits.daily_usage where user_id=alice) <> 241 then
    raise exception 'retry or deletion changed a reservation';
  end if;

  update receipt_limits.daily_usage set units=959 where user_id=alice;
  if receipt_limits.reserve_units(alice, 1, 'direct') <> 0 then raise exception 'last available unit rejected'; end if;
  retry_after := receipt_limits.reserve_units(alice, 1, 'direct');
  if retry_after not between 1 and 86400 then raise exception 'missing daily reset'; end if;
  if (select units from receipt_limits.project_usage) <> 242 then raise exception 'denied account charged project'; end if;
  if receipt_limits.reserve_units(bob, 1, 'direct') <> 0 then raise exception 'accounts share a personal limit'; end if;

  update receipt_limits.project_usage set units=1920;
  retry_after := receipt_limits.reserve_units(bob, 1, 'direct');
  if retry_after not between 1 and 86400 or (select units from receipt_limits.daily_usage where user_id=bob) <> 1 then
    raise exception 'project gate failed'; end if;
  insert into public.receipt_jobs(id,user_id,folder_id,total_pages) values (j,bob,'fixture',1);
  begin
    update public.receipt_jobs set status='queued' where id=j;
    raise exception 'exhausted project accepted new work';
  exception when raise_exception then if sqlerrm <> 'receipt_daily_limit' then raise; end if; end;
  if (select status from public.receipt_jobs where id=j) <> 'uploading' then raise exception 'upload cannot resume'; end if;
  -- Move the exhausted counters to yesterday to simulate the next UTC day.
  update receipt_limits.daily_usage set usage_day=usage_day-1;
  update receipt_limits.project_usage set usage_day=usage_day-1;
  update public.receipt_jobs set status='queued' where id=j;
  if (select units from receipt_limits.project_usage) <> 2 then raise exception 'daily reset failed'; end if;
end;
$$;
rollback;
