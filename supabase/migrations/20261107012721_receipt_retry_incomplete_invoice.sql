-- Retry from private source pages once when the C6 source-to-folder proof fails.
alter table public.receipt_jobs add column coverage_retries integer not null default 0;

create function public.receipt_retry_document_coverage(p_user uuid,p_job uuid,p_version timestamptz)
returns text language plpgsql security invoker set search_path='' as $$
declare j public.receipt_jobs; v timestamptz;
begin
 select * into j from public.receipt_jobs where id=p_job and user_id=p_user and document_auto and expires_at>now() for update;
 if not found then raise exception 'job_not_found'; end if;
 if j.status<>'ready' then return j.status; end if;
 select updated_at into v from public.pastas where id=j.folder_id and user_id=p_user for update;
 if not found then raise exception 'folder_not_linked'; end if;
 if v is distinct from p_version then
   update public.receipt_jobs set document_retry_at=now()+interval '2 seconds' where id=p_job;
   return 'replan';
 end if;
 if j.coverage_retries>0 then
   update public.receipt_jobs set status='error',document_notice=jsonb_build_object('coverageIssue',true,
     'reason','A comparação com o original deixou movimentos sem conciliação. O lote não foi gravado.') where id=p_job;
   return 'error';
 end if;
 update public.receipt_job_pages set first_result=null,result=null,attempts=0,audit_retries=0,lease_token=null,lease_until=null,
   error_code=null,next_attempt_at=now() where job_id=p_job;
 update public.receipt_jobs set status='queued',coverage_retries=coverage_retries+1,document_retry_at=null where id=p_job;
 return 'queued';
end $$;
revoke all on function public.receipt_retry_document_coverage(uuid,uuid,timestamptz) from public,anon,authenticated;
grant execute on function public.receipt_retry_document_coverage(uuid,uuid,timestamptz) to service_role;

create or replace function public.receipt_retry(p_user uuid,p_id uuid) returns text language plpgsql security invoker set search_path='' as $$
declare j public.receipt_jobs;
begin
 select * into j from public.receipt_jobs where id=p_id and user_id=p_user and expires_at>now() for update;
 if not found or j.status<>'error' or j.retry_count>=3 then raise exception 'retry_unavailable'; end if;
 if j.document_notice->'coverageIssue'='true'::jsonb then
   update public.receipt_job_pages set first_result=null,result=null,audit_retries=0 where job_id=p_id;
 end if;
 update public.receipt_job_pages set attempts=0,lease_until=null,lease_token=null,next_attempt_at=now(),error_code=null where job_id=p_id and result is null;
 update public.receipt_jobs set status='queued',retry_count=retry_count+1,document_notice=null,document_retry_at=null where id=p_id;
 return 'queued';
end $$;
