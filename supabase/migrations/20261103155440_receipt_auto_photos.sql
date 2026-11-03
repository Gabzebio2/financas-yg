-- New image uploads explicitly request automatic inclusion. Older drafts keep their review workflow.
alter table public.receipt_jobs add column photo_notice jsonb;

create function public.receipt_apply_photo() returns trigger
language plpgsql security invoker set search_path='' as $$
declare
 page record; entry jsonb; candidate jsonb; existing jsonb; original jsonb; rows_to_add jsonb := '[]';
 waiting jsonb := '[]'; page_waiting jsonb; included jsonb := '[]'; entry_no integer;
 repeated integer := 0; excluded integer := 0; exact_match boolean; uncertain boolean;
 receipt_ref text; same_value boolean; same_account boolean; same_desc boolean;
 notice jsonb; reviewed jsonb; retained jsonb := '{}'; fingerprint text; occurrence integer; frequencies jsonb;
begin
 if new.extra_rows <> '[]' or not exists(select 1 from public.receipt_job_pages where job_id=new.id)
    or exists(select 1 from public.receipt_job_pages where job_id=new.id and
      (media_type not like 'image/%' or context->'photoAuto' is distinct from 'true'::jsonb))
 then return new; end if;

 -- All decisions and writes use the same locked version of this owner's folder.
 select data->'transactions' into original from public.pastas
 where user_id=new.user_id and id=new.folder_id for update;
 if not found or jsonb_typeof(original) is distinct from 'array' then
   update public.receipt_jobs set photo_notice='{"problem":"A pasta precisa ser sincronizada."}' where id=new.id;
   return new;
 end if;
 for page in select * from public.receipt_job_pages where job_id=new.id order by page_index loop
   if jsonb_typeof(page.result->'photoPlan'->'entries') is distinct from 'array' then
     update public.receipt_jobs set photo_notice='{"problem":"A leitura precisa de conferência."}' where id=new.id;
     return new;
   end if;
   page_waiting := '[]'; entry_no:=0; frequencies:='{}';
   excluded := excluded + coalesce((page.result->'photoPlan'->>'excluded')::int,0);
   for entry in select value from jsonb_array_elements(page.result->'photoPlan'->'entries') loop
     candidate := entry->'tx'; exact_match := false; uncertain := false;
     if candidate is not null then
       fingerprint := md5(jsonb_build_array(candidate->'date',candidate->'type',candidate->'currency',
                          candidate->'amount',lower(trim(candidate->>'desc')),candidate->>'referenceId')::text);
       occurrence := coalesce((frequencies->>fingerprint)::int,0)+1;
       frequencies:=frequencies||jsonb_build_object(fingerprint,occurrence);
       candidate:=candidate||jsonb_build_object('photoSource',jsonb_build_object(
         'hash',page.sha256,'row',fingerprint,'occurrence',occurrence));
       -- A new reading of an identical page can change wording, order or values.
       uncertain:=exists(select 1 from jsonb_array_elements(original) x where x->'photoSource'->>'hash'=page.sha256);
       receipt_ref:=lower(trim(candidate->>'referenceId'));
       for existing in select value from jsonb_array_elements(original||rows_to_add) loop
         if existing->'photoSource'=candidate->'photoSource' then exact_match:=true; exit; end if;
         if existing->>'type'<>candidate->>'type' or existing->>'currency'<>candidate->>'currency' then continue; end if;
         same_value:=existing->>'date'=candidate->>'date' and existing->'amount'=candidate->'amount';
         same_account:=nullif(lower(trim(existing->>'account')),'')=lower(trim(candidate->>'account'));
         same_desc:=lower(trim(existing->>'desc'))=lower(trim(candidate->>'desc'));
         if receipt_ref<>'' and lower(trim(existing->>'referenceId'))=receipt_ref then
           if same_value and same_account then exact_match:=true; exit; end if;
           uncertain:=true;
         elsif existing->'photoSource'->>'hash'=page.sha256 then
           -- Distinct lines on the same print are allowed, including equal purchases.
           -- On a re-read, a changed recognition of an existing source is ambiguous.
           continue;
         elsif same_value and (same_desc or coalesce(existing->>'account','')='' or coalesce(candidate->>'account','')='')
           and not (receipt_ref<>'' and coalesce(existing->>'referenceId','')<>'' and lower(trim(existing->>'referenceId'))<>receipt_ref)
         then uncertain:=true;
         end if;
       end loop;
     end if;
     if exact_match then repeated:=repeated+1;
     elsif candidate is null or uncertain then
       waiting:=waiting||jsonb_build_array(jsonb_build_object('name',coalesce(candidate->>'desc',entry->>'name','Foto'),
         'reason',case when uncertain then 'Possível repetição' else coalesce(entry->>'reason','Conferir leitura') end));
       if page.result->'itens'->entry_no is not null then
         page_waiting:=page_waiting||jsonb_build_array(page.result->'itens'->entry_no);
       end if;
     else rows_to_add:=rows_to_add||jsonb_build_array(candidate); end if;
     entry_no:=entry_no+1;
   end loop;
   retained:=retained||jsonb_build_object(page.page_index::text,page_waiting);
 end loop;
 if jsonb_array_length(rows_to_add)>0 then
   included := public.receipt_commit(new.user_id,new.id,rows_to_add)->'transactions';
 end if;
 notice:=jsonb_build_object('items',(select coalesce(jsonb_agg(jsonb_build_object('desc',x->'desc','amount',x->'amount','currency',x->'currency','type',x->'type')),'[]') from jsonb_array_elements(included) x),'pending',waiting,'duplicates',repeated,'excluded',excluded);

 if jsonb_array_length(waiting)>0 then
   -- Only exceptions are returned by the ordinary review UI (also on older clients).
   for page in select page_index,result from public.receipt_job_pages where job_id=new.id loop
     reviewed:=retained->page.page_index::text;
     update public.receipt_job_pages set result=page.result||jsonb_build_object(
       'itens',reviewed,'expectedCount',null,'finalCount',jsonb_array_length(reviewed))
       where job_id=new.id and page_index=page.page_index;
   end loop;
   update public.receipt_jobs set photo_notice=notice,status='ready',committed_at=null where id=new.id;
 else
   update public.receipt_jobs set photo_notice=notice,status='committed',
     committed_transactions=included,committed_at=coalesce(committed_at,now()) where id=new.id;
 end if;
 return new;
exception when data_exception then
 -- Preserve the complete review if any candidate fails database validation.
 update public.receipt_jobs set photo_notice='{"problem":"Confira os dados que a foto mostrou."}' where id=new.id;
 return new;
end $$;

revoke all on function public.receipt_apply_photo() from public,anon,authenticated;
grant execute on function public.receipt_apply_photo() to service_role;
create trigger receipt_auto_photo_on_ready after update of status on public.receipt_jobs
 for each row when (old.status in ('queued','processing','error') and new.status='ready')
 execute function public.receipt_apply_photo();

create or replace function public.receipt_commit(p_user uuid,p_id uuid,p_txs jsonb) returns jsonb language plpgsql security invoker set search_path='' as $$
declare j public.receipt_jobs; d jsonb; t jsonb; cleaned jsonb:='[]'; cats jsonb; cat text; n int:=0; rev bigint; stamp timestamptz:=clock_timestamp();
begin
 select * into j from public.receipt_jobs where id=p_id and user_id=p_user and expires_at>now() for update;
 if not found then raise exception 'job_not_found'; end if;
 if j.status='committed' then return jsonb_build_object('transactions',j.committed_transactions,'alreadyCommitted',true); end if;
 if j.status<>'ready' then raise exception 'job_not_ready'; end if;
 if jsonb_typeof(p_txs) is distinct from 'array' or jsonb_array_length(p_txs) not between 1 and 10000 or octet_length(p_txs::text)>8000000 then raise exception 'invalid_transactions'; end if;
 select data into d from public.pastas where id=j.folder_id and user_id=p_user for update;
 if not found then raise exception 'folder_not_linked'; end if;
 n:=coalesce(jsonb_array_length(j.photo_notice->'items'),0);
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

create or replace function public.receipt_list(p_user uuid,p_folder text) returns jsonb language sql security invoker set search_path='' as $$
 select coalesce(jsonb_agg(x order by x.created_at desc),'[]') from (
 select j.id,j.status,j.created_at,j.expires_at,j.total_pages,j.retry_count,j.photo_notice,
 case when j.status='committed' and jsonb_array_length(j.photo_notice->'pending')>0 then jsonb_array_length(j.committed_transactions) end as photo_corrected_count,
 (select label from public.receipt_job_pages where job_id=j.id order by page_index limit 1) as label,
 (select count(*) from public.receipt_job_pages where job_id=j.id and uploaded) as uploaded,
 (select count(*) from public.receipt_job_pages where job_id=j.id and first_result is not null) as first,
 (select count(*) from public.receipt_job_pages where job_id=j.id and result is not null) as second,
 (select error_code from public.receipt_job_pages where job_id=j.id and error_code is not null limit 1) as error
 from public.receipt_jobs j where j.user_id=p_user and j.folder_id=p_folder and j.expires_at>now() order by j.created_at desc limit 30) x;
$$;
