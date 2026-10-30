-- Private, durable receipt drafts. All mutations use authenticated Edge handlers.
-- No worker function writes financial transactions. Only receipt_commit does.
create table public.receipt_jobs (
 id uuid primary key, user_id uuid not null references auth.users(id), folder_id text not null,
 status text not null default 'uploading' check(status in ('uploading','queued','processing','ready','error','committed')),
 created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '14 days',
 categories jsonb not null default '[]', cards jsonb not null default '[]', extra_rows jsonb not null default '[]',
 total_pages int not null check(total_pages between 1 and 120), retry_count int not null default 0,
 committed_transactions jsonb, committed_at timestamptz
);
create index receipt_jobs_owner on public.receipt_jobs(user_id,folder_id,created_at desc);
create index receipt_jobs_expiry on public.receipt_jobs(expires_at);
create table public.receipt_job_pages (
 job_id uuid not null references public.receipt_jobs(id) on delete cascade, page_index int not null,
 object_path text not null unique, media_type text not null, byte_size int not null check(byte_size between 1 and 3150000),
 sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'), label text not null, document_id text not null,
 context jsonb not null, quick boolean not null, uploaded boolean not null default false,
 first_result jsonb, result jsonb, attempts int not null default 0, audit_retries int not null default 0,
 lease_token uuid, lease_until timestamptz, next_attempt_at timestamptz not null default now(), error_code text,
 primary key(job_id,page_index)
);
create table public.receipt_worker_config(id boolean primary key default true check(id), token text not null);
alter table public.receipt_jobs enable row level security;
alter table public.receipt_job_pages enable row level security;
alter table public.receipt_worker_config enable row level security;
revoke all on public.receipt_jobs, public.receipt_job_pages, public.receipt_worker_config from anon, authenticated;
grant select on public.receipt_jobs, public.receipt_job_pages to authenticated;
grant all on public.receipt_jobs, public.receipt_job_pages, public.receipt_worker_config to service_role;
create policy receipt_owner_read on public.receipt_jobs for select to authenticated using(user_id=(select auth.uid()) and expires_at>now());
create policy receipt_page_owner_read on public.receipt_job_pages for select to authenticated using(exists(select 1 from public.receipt_jobs j where j.id=job_id and j.user_id=(select auth.uid()) and j.expires_at>now()));
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('receipt-documents','receipt-documents',false,3150000,array['application/pdf','image/jpeg','image/png','image/webp']);
create policy receipt_file_owner_read on storage.objects for select to authenticated using(bucket_id='receipt-documents' and exists(select 1 from public.receipt_jobs j where j.user_id=(select auth.uid()) and j.expires_at>now() and name like j.user_id::text||'/'||j.id::text||'/%'));

create function public.receipt_create(p_user uuid,p_id uuid,p_folder text,p_pages jsonb,p_categories jsonb,p_cards jsonb,p_extra jsonb default '[]') returns uuid
language plpgsql security invoker set search_path='' as $$
declare p jsonb; n int:=0; total_bytes bigint:=0;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,0));
 if not exists(select 1 from public.pastas where id=p_folder and user_id=p_user) then raise exception 'folder_not_linked'; end if;
 if exists(select 1 from public.receipt_jobs where id=p_id and user_id=p_user and folder_id=p_folder and expires_at>now()) then return p_id; end if;
 if (select count(*) from public.receipt_jobs where user_id=p_user and expires_at>now() and status in ('uploading','queued','processing','error'))>=3 or (select count(*) from public.receipt_jobs where user_id=p_user and expires_at>now())>=30 then raise exception 'active_job_limit'; end if;
 if jsonb_typeof(p_pages)<>'array' or jsonb_array_length(p_pages) not between 1 and 120 or octet_length(p_extra::text)>1000000 or jsonb_typeof(p_extra)<>'array' then raise exception 'invalid_job'; end if;
 insert into public.receipt_jobs(id,user_id,folder_id,total_pages,categories,cards,extra_rows) values(p_id,p_user,p_folder,jsonb_array_length(p_pages),p_categories,p_cards,p_extra);
 for p in select value from jsonb_array_elements(p_pages) loop
  total_bytes:=total_bytes+(p->>'bytes')::bigint;
  if p->>'mediaType' not in ('application/pdf','image/jpeg','image/png','image/webp') or (p->'context'->>'pageStart')::int<1 or (p->'context'->>'pageStart')::int<>(p->'context'->>'pageEnd')::int or (p->'context'->>'totalPages')::int not between 1 and 120 or (p->'context'->>'pageStart')::int>(p->'context'->>'totalPages')::int then raise exception 'invalid_page'; end if;
  insert into public.receipt_job_pages(job_id,page_index,object_path,media_type,byte_size,sha256,label,document_id,context,quick)
  values(p_id,n,p_user::text||'/'||p_id::text||'/'||n::text,p->>'mediaType',(p->>'bytes')::int,p->>'sha256',left(p->>'label',300),left(p->>'documentId',80),p->'context',coalesce((p->>'quick')::boolean,false));
  n:=n+1;
 end loop;
 if total_bytes>100000000 then raise exception 'job_too_large'; end if;
 return p_id;
end $$;

create function public.receipt_submit(p_user uuid,p_id uuid) returns text language plpgsql security invoker set search_path='' as $$
declare j public.receipt_jobs;
begin
 select * into j from public.receipt_jobs where id=p_id and user_id=p_user and expires_at>now() for update;
 if not found then raise exception 'job_not_found'; end if;
 if j.status<>'uploading' then return j.status; end if;
 if exists(select 1 from public.receipt_job_pages where job_id=p_id and not uploaded) then raise exception 'upload_incomplete'; end if;
 update public.receipt_jobs set status='queued' where id=p_id; return 'queued';
end $$;

create function public.receipt_claim() returns jsonb language plpgsql security invoker set search_path='' as $$
declare p public.receipt_job_pages; j public.receipt_jobs; token uuid:=gen_random_uuid();
begin
 -- Expired leases are retryable, including workers terminated by a platform limit.
 update public.receipt_job_pages set error_code='tempo_ia',lease_token=null,lease_until=null where result is null and attempts>=3 and lease_until<now();
 update public.receipt_jobs j set status='error' where status in ('queued','processing') and exists(select 1 from public.receipt_job_pages p where p.job_id=j.id and p.result is null and p.attempts>=3 and p.lease_token is null);
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

create function public.receipt_list(p_user uuid,p_folder text) returns jsonb language sql security invoker set search_path='' as $$
 select coalesce(jsonb_agg(x order by x.created_at desc),'[]') from (
 select j.id,j.status,j.created_at,j.expires_at,j.total_pages,j.retry_count,
 (select label from public.receipt_job_pages where job_id=j.id order by page_index limit 1) as label,
 (select count(*) from public.receipt_job_pages where job_id=j.id and uploaded) as uploaded,
 (select count(*) from public.receipt_job_pages where job_id=j.id and first_result is not null) as first,
 (select count(*) from public.receipt_job_pages where job_id=j.id and result is not null) as second,
 (select error_code from public.receipt_job_pages where job_id=j.id and error_code is not null limit 1) as error
 from public.receipt_jobs j where j.user_id=p_user and j.folder_id=p_folder and j.expires_at>now() order by j.created_at desc limit 30) x;
$$;

create function public.receipt_finish(p_job uuid,p_index int,p_lease uuid,p_result jsonb default null,p_error text default null) returns boolean language plpgsql security invoker set search_path='' as $$
declare p public.receipt_job_pages; done boolean;
begin
 -- Serialize finalization with cleanup and with other pages completing simultaneously.
 perform 1 from public.receipt_jobs where id=p_job and expires_at>now() and status in ('queued','processing','error') for update;
 if not found then return false; end if;
 select * into p from public.receipt_job_pages where job_id=p_job and page_index=p_index and lease_token=p_lease and lease_until>now() for update;
 if not found then return false; end if;
 if p_error is not null then
  update public.receipt_job_pages set lease_token=null,lease_until=null,error_code=left(p_error,80),next_attempt_at=now()+interval '30 seconds',quick=case when p_error='resposta_incompleta' then false else quick end where job_id=p_job and page_index=p_index;
  if p.attempts>=3 then update public.receipt_jobs set status='error' where id=p_job; end if;
  return true;
 end if;
 if jsonb_typeof(p_result->'itens') is distinct from 'array' or jsonb_typeof(p_result->'ledger') is distinct from 'object' or octet_length(p_result::text)>1000000 then raise exception 'invalid_result'; end if;
 done:=p.first_result is not null or (p.quick and p_result->>'reviewMode'='automatic' and p_result->>'verified'='true' and p_result->>'partial'='false');
 if p.first_result is not null and jsonb_array_length(coalesce(p_result->'ledger'->'missing','[]'))>0 and p.audit_retries=0 then
  update public.receipt_job_pages set first_result=p_result,audit_retries=1,attempts=0,lease_token=null,lease_until=null,error_code=null where job_id=p_job and page_index=p_index;
 else
  update public.receipt_job_pages set first_result=coalesce(first_result,p_result),result=case when done then p_result else null end,attempts=0,lease_token=null,lease_until=null,error_code=null where job_id=p_job and page_index=p_index;
 end if;
 if not exists(select 1 from public.receipt_job_pages where job_id=p_job and result is null) then update public.receipt_jobs set status='ready' where id=p_job; end if;
 return true;
end $$;

create function public.receipt_retry(p_user uuid,p_id uuid) returns text language plpgsql security invoker set search_path='' as $$
declare j public.receipt_jobs;
begin
 select * into j from public.receipt_jobs where id=p_id and user_id=p_user and expires_at>now() for update;
 if not found or j.status<>'error' or j.retry_count>=3 then raise exception 'retry_unavailable'; end if;
 update public.receipt_job_pages set attempts=0,lease_until=null,lease_token=null,next_attempt_at=now(),error_code=null where job_id=p_id and result is null;
 update public.receipt_jobs set status='queued',retry_count=retry_count+1 where id=p_id; return 'queued';
end $$;

create function public.receipt_commit(p_user uuid,p_id uuid,p_txs jsonb) returns jsonb language plpgsql security invoker set search_path='' as $$
declare j public.receipt_jobs; d jsonb; t jsonb; cleaned jsonb:='[]'; cats jsonb; cat text; n int:=0; rev bigint; stamp timestamptz:=clock_timestamp();
begin
 select * into j from public.receipt_jobs where id=p_id and user_id=p_user and expires_at>now() for update;
 if not found then raise exception 'job_not_found'; end if;
 if j.status='committed' then return jsonb_build_object('transactions',j.committed_transactions,'alreadyCommitted',true); end if;
 if j.status<>'ready' then raise exception 'job_not_ready'; end if;
 if jsonb_typeof(p_txs) is distinct from 'array' or jsonb_array_length(p_txs) not between 1 and 10000 or octet_length(p_txs::text)>8000000 then raise exception 'invalid_transactions'; end if;
 select data into d from public.pastas where id=j.folder_id and user_id=p_user for update;
 if not found then raise exception 'folder_not_linked'; end if;
 cats:=coalesce(d->'categories','[]');
 for t in select value from jsonb_array_elements(p_txs) loop
  if jsonb_typeof(t->'amount') is distinct from 'number' or (t->>'amount')::numeric<=0 or (t->>'amount')::numeric>9007199254740991 or coalesce(t->>'currency','') not in ('BRL','PYG','CLP','USD','EUR','GBP','USDT','USDC') or coalesce(t->>'type','') not in ('receita','despesa') or coalesce(t->>'date','') !~ '^\d{4}-\d{2}-\d{2}$' or to_char((t->>'date')::date,'YYYY-MM-DD')<>t->>'date' or length(trim(coalesce(t->>'desc','')))=0 then raise exception 'invalid_transaction'; end if;
  cat:=left(coalesce(nullif(trim(t->>'category'),''),'Outros'),80);
  if not exists(select 1 from jsonb_array_elements(cats) c where c->>'name'=cat) then cats:=cats||jsonb_build_array(jsonb_build_object('name',cat,'color','#8b5cf6')); end if;
  -- The server assigns stable identities. Repeating confirmation returns this same list.
  t:=t||jsonb_build_object('id','receipt_'||p_id::text||'_'||n::text,'category',cat,'groupId',case when coalesce(t->>'groupId','')<>'' then 'receipt_'||p_id::text||'_'||md5(t->>'groupId') else null end);
  cleaned:=cleaned||jsonb_build_array(t); n:=n+1;
 end loop;
 rev:=coalesce((d->>'whatsappRevision')::bigint,0)+1;
 d:=d||jsonb_build_object('transactions',coalesce(d->'transactions','[]')||cleaned,'categories',cats,'updatedAt',stamp,'whatsappRevision',rev);
 update public.pastas set data=d,updated_at=stamp where id=j.folder_id and user_id=p_user;
 update public.receipt_jobs set status='committed',committed_transactions=cleaned,committed_at=stamp where id=p_id;
 return jsonb_build_object('transactions',cleaned,'alreadyCommitted',false);
end $$;

revoke execute on function public.receipt_create(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb),public.receipt_submit(uuid,uuid),public.receipt_claim(),public.receipt_finish(uuid,int,uuid,jsonb,text),public.receipt_retry(uuid,uuid),public.receipt_commit(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.receipt_create(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb),public.receipt_submit(uuid,uuid),public.receipt_claim(),public.receipt_finish(uuid,int,uuid,jsonb,text),public.receipt_retry(uuid,uuid),public.receipt_commit(uuid,uuid,jsonb) to service_role;
revoke execute on function public.receipt_list(uuid,text) from public,anon,authenticated;
grant execute on function public.receipt_list(uuid,text) to service_role;
