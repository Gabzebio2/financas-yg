-- Only PDF jobs explicitly submitted for automatic inclusion are eligible.
alter table public.receipt_jobs
 add column document_auto boolean not null default false,
 add column document_notice jsonb,
 add column document_retry_at timestamptz;

create or replace function public.receipt_submit(p_user uuid,p_id uuid) returns text language plpgsql security invoker set search_path='' as $$
declare j public.receipt_jobs; automatic boolean;
begin
 select * into j from public.receipt_jobs where id=p_id and user_id=p_user and expires_at>now() for update;
 if not found then raise exception 'job_not_found'; end if;
 if j.status<>'uploading' then return j.status; end if;
 if exists(select 1 from public.receipt_job_pages where job_id=p_id and not uploaded) then raise exception 'upload_incomplete'; end if;
 select count(*)=j.total_pages and bool_and(media_type='application/pdf' and (context->'documentAuto') is not distinct from 'true'::jsonb)
   into automatic from public.receipt_job_pages where job_id=p_id;
 update public.receipt_jobs set status='queued',document_auto=automatic and jsonb_array_length(j.extra_rows)=0 where id=p_id;
 return 'queued';
end $$;

create function public.receipt_claim_auto_document() returns jsonb language plpgsql security invoker set search_path='' as $$
declare j public.receipt_jobs;
begin
 select * into j from public.receipt_jobs where document_auto and status='ready' and expires_at>now()
   and (document_retry_at is null or document_retry_at<=now()) order by created_at for update skip locked limit 1;
 if not found then return null; end if;
 update public.receipt_jobs set document_retry_at=now()+interval '90 seconds' where id=j.id;
 return jsonb_build_object('id',j.id,'user_id',j.user_id,'folder_id',j.folder_id,'categories',j.categories);
end $$;

-- Compute the plan against one version of the folder, then validate that version
-- under the same lock used by manual commits. Competing uploads must replan.
create function public.receipt_finish_auto_document(p_user uuid,p_job uuid,p_version timestamptz,p_txs jsonb,p_notice jsonb)
returns text language plpgsql security invoker set search_path='' as $$
declare j public.receipt_jobs; folder_version timestamptz; result jsonb; saved jsonb:='[]'; n int;
begin
 select * into j from public.receipt_jobs where id=p_job and user_id=p_user and document_auto and expires_at>now() for update;
 if not found then raise exception 'job_not_found'; end if;
 if j.status='committed' then return 'committed'; end if;
 if j.status<>'ready' then raise exception 'job_not_ready'; end if;
 if jsonb_typeof(p_txs) is distinct from 'array' or jsonb_typeof(p_notice) is distinct from 'object' or
    octet_length(p_notice::text)>100000 then raise exception 'invalid_transactions'; end if;
 select updated_at into folder_version from public.pastas where user_id=p_user and id=j.folder_id for update;
 if not found then raise exception 'folder_not_linked'; end if;
 if folder_version is distinct from p_version then
   update public.receipt_jobs set document_retry_at=clock_timestamp()+interval '2 seconds' where id=p_job;
   return 'replan';
 end if;
 n:=jsonb_array_length(p_txs);
 if n>0 then
   result:=public.receipt_commit(p_user,p_job,p_txs);
   saved:=result->'transactions';
 end if;
 -- Even a duplicate-only batch has a durable, final notification.
 update public.receipt_jobs set status='committed',committed_transactions=saved,committed_at=coalesce(committed_at,clock_timestamp()),
   document_retry_at=null,document_notice=p_notice || jsonb_build_object('included',jsonb_array_length(saved),
   'skipped',coalesce((p_notice->>'skipped')::int,0)+coalesce((result->>'seriesSkipped')::int,0),
   'duplicates',coalesce((p_notice->>'duplicates')::int,0)+greatest(0,n-jsonb_array_length(saved)-coalesce((result->>'seriesSkipped')::int,0)))
 where id=p_job;
 return 'committed';
end $$;

revoke all on function public.receipt_claim_auto_document(),public.receipt_finish_auto_document(uuid,uuid,timestamptz,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.receipt_claim_auto_document(),public.receipt_finish_auto_document(uuid,uuid,timestamptz,jsonb,jsonb) to service_role;

create or replace function public.receipt_list(p_user uuid,p_folder text) returns jsonb language sql security invoker set search_path='' as $$
 select coalesce(jsonb_agg(x order by x.created_at desc),'[]') from (
 select j.id,j.status,j.created_at,j.expires_at,j.total_pages,j.retry_count,j.photo_notice,j.document_auto,j.document_notice,
 case when j.status='committed' and jsonb_array_length(j.photo_notice->'pending')>0 then jsonb_array_length(j.committed_transactions) end as photo_corrected_count,
 (select label from public.receipt_job_pages where job_id=j.id order by page_index limit 1) as label,
 (select count(*) from public.receipt_job_pages where job_id=j.id and uploaded) as uploaded,
 (select count(*) from public.receipt_job_pages where job_id=j.id and first_result is not null) as first,
 (select count(*) from public.receipt_job_pages where job_id=j.id and result is not null) as second,
 (select error_code from public.receipt_job_pages where job_id=j.id and error_code is not null limit 1) as error
 from public.receipt_jobs j where j.user_id=p_user and j.folder_id=p_folder and j.expires_at>now() order by j.created_at desc limit 30) x;
$$;

select cron.alter_job((select jobid from cron.job where jobname='receipt-background-minute'),command := $schedule$
with wake as (select extract(epoch from now())::bigint::text as stamp,gen_random_uuid()::text as nonce)
select net.http_post(url := 'https://mhgagjhwsjjjwwvopjgu.supabase.co/functions/v1/receipt-jobs',
headers := jsonb_build_object('Content-Type','application/json','X-Receipt-Wake',wake.stamp||'.'||wake.nonce||'.'||encode(extensions.hmac('receipt-wake.'||wake.stamp||'.'||wake.nonce,(select token from public.receipt_worker_config where id=true),'sha256'),'hex')),
body := '{"action":"work"}'::jsonb,timeout_milliseconds :=10000) from wake where exists(select 1 from public.receipt_jobs where expires_at<=now() or status in ('queued','processing') or (document_auto and status='ready' and (document_retry_at is null or document_retry_at<=now())));$schedule$);
