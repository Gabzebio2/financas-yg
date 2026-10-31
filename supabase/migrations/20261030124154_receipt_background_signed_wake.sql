select cron.alter_job((select jobid from cron.job where jobname='receipt-background-minute'),command := $schedule$
with wake as (select extract(epoch from now())::bigint::text as stamp,gen_random_uuid()::text as nonce)
select net.http_post(url := 'https://mhgagjhwsjjjwwvopjgu.supabase.co/functions/v1/receipt-jobs',
headers := jsonb_build_object('Content-Type','application/json','X-Receipt-Wake',wake.stamp||'.'||wake.nonce||'.'||encode(extensions.hmac('receipt-wake.'||wake.stamp||'.'||wake.nonce,(select token from public.receipt_worker_config where id=true),'sha256'),'hex')),
body := '{"action":"work"}'::jsonb,timeout_milliseconds :=10000) from wake where exists(select 1 from public.receipt_jobs where expires_at<=now() or status in ('queued','processing'));$schedule$);
