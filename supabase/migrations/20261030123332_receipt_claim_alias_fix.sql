create or replace function public.receipt_claim() returns jsonb language plpgsql security invoker set search_path='' as $$
declare p public.receipt_job_pages; j public.receipt_jobs; token uuid:=gen_random_uuid();
begin
 -- Expired leases are retryable, including workers terminated by a platform limit.
 update public.receipt_job_pages set error_code='tempo_ia',lease_token=null,lease_until=null where result is null and attempts>=3 and lease_until<now();
 update public.receipt_jobs jobrow set status='error' where status in ('queued','processing') and exists(select 1 from public.receipt_job_pages pagerow where pagerow.job_id=jobrow.id and pagerow.result is null and pagerow.attempts>=3 and pagerow.lease_token is null);
 select j0.* into j from public.receipt_jobs j0 where j0.status in ('queued','processing') and j0.expires_at>now() and exists(
 select 1 from public.receipt_job_pages p0 where p0.job_id=j0.id and p0.uploaded and p0.result is null and p0.attempts<3 and p0.next_attempt_at<=now() and (p0.lease_until is null or p0.lease_until<now())
 and (p0.first_result is null or not exists(select 1 from public.receipt_job_pages q where q.job_id=p0.job_id and q.first_result is null))) order by j0.created_at for update skip locked limit 1;
 if not found then return null; end if;
 select p0.* into p from public.receipt_job_pages p0 where p0.job_id=j.id and p0.uploaded and p0.result is null and p0.attempts<3 and p0.next_attempt_at<=now() and (p0.lease_until is null or p0.lease_until<now()) and (p0.first_result is null or not exists(select 1 from public.receipt_job_pages q where q.job_id=p0.job_id and q.first_result is null)) order by p0.page_index for update skip locked limit 1;
 if not found then return null; end if;
 update public.receipt_job_pages set lease_token=token,lease_until=now()+interval '3 minutes',attempts=attempts+1 where job_id=p.job_id and page_index=p.page_index;
 update public.receipt_jobs set status='processing' where id=p.job_id returning * into j;
 return jsonb_build_object('page',to_jsonb(p)||jsonb_build_object('lease_token',token),'categories',j.categories,'cards',j.cards);
end $$;
