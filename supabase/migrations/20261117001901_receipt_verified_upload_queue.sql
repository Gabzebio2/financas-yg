-- Called by the private Edge function after verifying immutable storage bytes.
-- Lock the parent first, so two final pages arriving together cannot strand a job.
create function public.receipt_verify_upload(p_user uuid, p_id uuid, p_index integer)
returns text language plpgsql security invoker set search_path = '' as $$
declare
  job public.receipt_jobs;
begin
  select * into job from public.receipt_jobs
    where id = p_id and user_id = p_user and expires_at > now() for update;
  if not found then raise exception 'job_not_found'; end if;
  if job.status <> 'uploading' then return job.status; end if;
  update public.receipt_job_pages set uploaded = true
    where job_id = p_id and page_index = p_index;
  if not found then raise exception 'invalid_page'; end if;
  if exists(select 1 from public.receipt_job_pages where job_id = p_id and not uploaded) then
    return 'uploading';
  end if;
  return public.receipt_submit(p_user, p_id);
end $$;
revoke all on function public.receipt_verify_upload(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.receipt_verify_upload(uuid, uuid, integer) to service_role;
