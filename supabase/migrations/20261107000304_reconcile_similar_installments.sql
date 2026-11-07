-- Rank an entire old purchase from immutable commercial fields and numbered
-- installments. An explicit purchase date never matches a different purchase.
create function public.receipt_c6_affinity(signature jsonb, purchase_day date, items jsonb)
returns integer language sql immutable strict security invoker set search_path='' as $$
  with evidence as (
    select x->>'installment' as slot, public.receipt_c6_signature(x) as sig,
      coalesce(nullif(x->'advance'->>'scheduledDate',''),x->>'date')=purchase_day::text as original_date,
      case when nullif(x->>'purchaseDate','') is not null then
        case when x->>'purchaseDate'=purchase_day::text then 0 end
      when public.receipt_c6_signature(x) = $1 then
        coalesce(nullif(x->'advance'->>'scheduledDate',''),x->>'date')::date -
        (purchase_day + make_interval(months=>split_part(x->>'installment','/',1)::int-1))::date end as delta
    from jsonb_array_elements(items) x
  )
  select case when count(*) filter(where delta is not null and (abs(delta)<=35 or original_date))=0 then 0
    when bool_or(sig is distinct from $1) or count(delta)<>count(*) then 1
    when bool_and(delta=0 or original_date) then 4 when max(abs(delta))>35 then 1 when max(abs(delta))<=7 then 3
    when count(distinct slot)>1 and max(delta)-min(delta)<=7 then 2 else 1 end
  from evidence
$$;
revoke all on function public.receipt_c6_affinity(jsonb,date,jsonb) from public,anon,authenticated;
grant execute on function public.receipt_c6_affinity(jsonb,date,jsonb) to service_role;

-- The caller holds the folder row lock. An uncertain association is local to
-- this series: we leave the existing rows intact and still save other purchases.
create or replace function public.receipt_c6_group(t jsonb, legacy jsonb, keyed jsonb, claims jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  k text:=t->>'seriesKey'; purchase_day date:=(t->>'purchaseDate')::date;
  signature jsonb:=public.receipt_c6_signature(t); ordinal int:=(substr(k,7)::jsonb->>7)::int;
  origins jsonb:=claims->'origins'; count_buys int:=(origins->>purchase_day::text)::int;
  bindings jsonb:=claims->'bindings'; stored_groups jsonb:=claims->'groups';
  attached jsonb:='{}'; unbound jsonb:='[]'; singles jsonb:='{}'; occupied jsonb:='{}';
  slots jsonb:='{}'; blocked jsonb:='{"blocked":true}'; gid text; sibling_key text;
  c record; scores record; old jsonb; rows jsonb; available int[]; idx int; assigned int;
  slot text; target text; n int; free int; through int; chosen text:=nullif(t->>'groupId','');
begin
  -- Include already-bound siblings of all otherwise identical purchases when
  -- allocating ungrouped historical rows one-for-one to occurrence ordinals.
  for c in select key,value from jsonb_each(claims->'siblings') loop
    n:=(substr(c.key,7)::jsonb->>7)::int;
    for old in select value from jsonb_array_elements(c.value) loop
      gid:=nullif(old->>'groupId','');
      if gid is null or (attached ? n::text and attached->>n::text<>gid) then return blocked; end if;
      attached:=attached||jsonb_build_object(n::text,gid);
      occupied:=occupied||jsonb_build_object(n||':'||(old->>'installment'),true);
    end loop;
  end loop;

  for c in select * from (select x->>'groupId' as gid,
       case when nullif(x->>'groupId','') is null then x->>'id' end as single_id, jsonb_agg(x) as rows
       from jsonb_array_elements(legacy) x group by 1,2) clusters order by clusters.gid collate "C",clusters.single_id collate "C"
  loop
    gid:=nullif(c.gid,''); rows:=coalesce(stored_groups->gid,c.rows);
    sibling_key:=bindings->>gid;
    if sibling_key is not null and not (claims->'siblings' ? sibling_key) and sibling_key<>'conflict' then continue; end if;
    select max(rank) as best, count(*) filter(where rank=here and rank>0) as ties,
      here as current_rank into scores
      from (select public.receipt_c6_affinity(signature,d.origin_day::date,rows) as rank,
             public.receipt_c6_affinity(signature,purchase_day,rows) as here
            from jsonb_object_keys(origins) as d(origin_day)) ranked group by here;
    if scores.current_rank=0 or scores.current_rank<scores.best then continue; end if;
    if scores.current_rank<2 or scores.ties<>1 or sibling_key='conflict' then return blocked; end if;
    if gid is null then
      slot:=c.rows->0->>'installment';
      singles:=singles||jsonb_build_object(slot,coalesce((singles->>slot)::int,0)+1);
    elsif sibling_key is null then
      unbound:=unbound||jsonb_build_array(gid);
    end if;
  end loop;
  select coalesce(array_agg(i order by i),'{}'::int[]) into available
    from generate_series(1,count_buys) i where not (attached ? i::text);
  if jsonb_array_length(unbound)>cardinality(available) then return blocked; end if;
  for idx in 1..jsonb_array_length(unbound) loop
    assigned:=available[idx]; attached:=attached||jsonb_build_object(assigned::text,unbound->>(idx-1));
  end loop;
  for c in select key,value from jsonb_each_text(attached) loop
    rows:=stored_groups->c.value;
    if rows is not null and public.receipt_c6_affinity(signature,purchase_day,rows)<2 then return blocked; end if;
    for old in select value from jsonb_array_elements(rows) loop
      slot:=c.key||':'||(old->>'installment');
      if occupied ? slot then return blocked; end if;
      occupied:=occupied||jsonb_build_object(slot,true);
    end loop;
  end loop;
  for c in select key,value from jsonb_each_text(occupied) where key like ordinal||':%' loop
    slots:=slots||jsonb_build_object(split_part(c.key,':',2),true);
  end loop;
  for c in select key,value from jsonb_each_text(singles) loop
    select count(*),count(*) filter(where i<=ordinal) into free,through from generate_series(1,count_buys) i
      where not (occupied ? (i||':'||c.key));
    if c.value::int>free then return blocked; end if;
    if not (slots ? c.key) and through<=c.value::int then slots:=slots||jsonb_build_object(c.key,true); end if;
  end loop;
  target:=coalesce(attached->>ordinal::text,'c6_'||md5(k));
  if chosen is not null and chosen<>k and chosen<>target then return blocked; end if;
  return jsonb_build_object('groupId',target,'slots',slots);
end $$;

create or replace function public.receipt_commit(p_user uuid,p_id uuid,p_txs jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare
  j public.receipt_jobs; d jsonb; t jsonb; cleaned jsonb:='[]'; cats jsonb; cat text;
  n int:=0; rev bigint; stamp timestamptz;
  original jsonb; keyed jsonb; legacy jsonb; claims jsonb; legacy_groups jsonb; resolved jsonb:='{}';
  origin_index jsonb; siblings jsonb; duplicate_count int:=0; skipped_count int:=0;
  k text; signature jsonb; parts jsonb; plan jsonb; gid text; slot text; group_input text;
begin
  select * into j from public.receipt_jobs where id=p_id and user_id=p_user and expires_at>now() for update;
  if not found then raise exception 'job_not_found'; end if;
  if j.status='committed' then return jsonb_build_object('transactions',j.committed_transactions,'alreadyCommitted',true); end if;
  if j.status<>'ready' then raise exception 'job_not_ready'; end if;
  if jsonb_typeof(p_txs) is distinct from 'array' or jsonb_array_length(p_txs) not between 1 and 10000 or octet_length(p_txs::text)>8000000 then raise exception 'invalid_transactions'; end if;

  -- Concurrent documents, automatic photos, and folder writes serialize here.
  select data into d from public.pastas where id=j.folder_id and user_id=p_user for update;
  if not found then raise exception 'folder_not_linked'; end if;
  original:=coalesce(d->'transactions','[]');
  n:=coalesce(jsonb_array_length(j.photo_notice->'items'),0);
  cats:=coalesce(d->'categories','[]');
  if exists(select 1 from jsonb_array_elements(p_txs) x where x ? 'seriesKey') then
    -- Index the stored folder once; all incoming installments share these indexes.
    select coalesce(jsonb_object_agg(series,rows),'{}') into keyed from (
      select x->>'seriesKey' as series,jsonb_agg(x) as rows from jsonb_array_elements(original) x
      where nullif(x->>'seriesKey','') is not null group by 1
    ) a;
    select coalesce(jsonb_object_agg(owner_group,rows),'{}') into legacy_groups from (
      select x->>'groupId' as owner_group,jsonb_agg(x) as rows from jsonb_array_elements(original) x
      where nullif(x->>'seriesKey','') is null and nullif(x->>'groupId','') is not null group by 1
    ) a;
    select coalesce(jsonb_object_agg(sig,rows),'{}') into legacy from (
      select public.receipt_c6_signature(x)::text as sig,jsonb_agg(x) as rows
      from jsonb_array_elements(original) x
      where nullif(x->>'seriesKey','') is null and x->>'installment' ~ '^[1-9][0-9]{0,2}/[1-9][0-9]{0,2}$'
      group by 1
    ) a;
    -- Date and occurrence competition across purchases in this batch and
    -- earlier documents. A nearby group never overrides an explicitly dated one.
    select coalesce(jsonb_object_agg(sig,days),'{}') into origin_index from (
      select sig,jsonb_object_agg(origin_day,max_ordinal) as days from (
        select public.receipt_c6_signature(x)::text as sig,x->>'purchaseDate' as origin_day,
          max(substring(x->>'seriesKey' from ',([1-9][0-9]{0,4})\]$')::int) max_ordinal
        from (select value x from jsonb_array_elements(original)
              union all select value from jsonb_array_elements(p_txs)) all_rows
        where x->>'seriesKey' like 'c6:v1:%' and x->>'purchaseDate' ~ '^\d{4}-\d{2}-\d{2}$'
          and public.receipt_c6_signature(x) is not null
        group by 1,2) v group by sig) m;
    select coalesce(jsonb_object_agg(owner_group,series),'{}') into claims from (
      select x->>'groupId' as owner_group,
             case when count(distinct x->>'seriesKey')=1 then min(x->>'seriesKey') else 'conflict' end as series
      from jsonb_array_elements(original) x
      where nullif(x->>'seriesKey','') is not null and nullif(x->>'groupId','') is not null group by 1
    ) a;
  end if;
  for t in select value from jsonb_array_elements(p_txs) loop
    if jsonb_typeof(t->'amount') is distinct from 'number' or (t->>'amount')::numeric<=0 or (t->>'amount')::numeric>9007199254740991 or coalesce(t->>'currency','') not in ('BRL','PYG','CLP','USD','EUR','GBP','USDT','USDC') or coalesce(t->>'type','') not in ('receita','despesa') or coalesce(t->>'date','') !~ '^\d{4}-\d{2}-\d{2}$' or to_char((t->>'date')::date,'YYYY-MM-DD')<>t->>'date' or length(trim(coalesce(t->>'desc','')))=0 then raise exception 'invalid_transaction'; end if;
    group_input:=nullif(t->>'groupId','');
    if t ? 'seriesKey' then
      k:=t->>'seriesKey'; slot:=t->>'installment'; signature:=public.receipt_c6_signature(t);
      if left(coalesce(k,''),6)<>'c6:v1:' or length(k)>2000 or signature is null or split_part(slot,'/',1)::int>split_part(slot,'/',2)::int or
        coalesce(t->>'purchaseDate','') !~ '^\d{4}-\d{2}-\d{2}$' or (t->>'purchaseDate')::date::text<>t->>'purchaseDate' or
        ((t->>'purchaseDate')::date+make_interval(months=>split_part(slot,'/',1)::int-1))::date<>(t->>'date')::date
        then raise exception 'invalid_transaction'; end if;
      begin
        parts:=substr(k,7)::jsonb;
        if jsonb_typeof(parts) is distinct from 'array' or jsonb_array_length(parts)<>8
          or (parts-7-0) is distinct from signature or parts->>0 is distinct from t->>'purchaseDate'
          or jsonb_typeof(parts->7) is distinct from 'number' or (parts->>7) !~ '^[1-9][0-9]{0,4}$' then
          raise exception 'invalid_transaction';
        end if;
      exception when data_exception then raise exception 'invalid_transaction'; end;
      -- A proven slot needs no legacy inference. An unrelated browser edit
      -- must not turn an idempotent re-read into a reconciliation error.
      if exists(select 1 from jsonb_array_elements(keyed->k) x where x->>'installment'=slot) then
        duplicate_count:=duplicate_count+1; continue;
      end if;
      if not resolved ? k then
        select coalesce(jsonb_object_agg(key,value),'{}') into siblings from jsonb_each(keyed)
          where regexp_replace(key,',[1-9][0-9]{0,4}\]$','')=regexp_replace(k,',[1-9][0-9]{0,4}\]$','');
        plan:=public.receipt_c6_group(t,coalesce(legacy->(signature::text),'[]'),coalesce(keyed->k,'[]'),jsonb_build_object(
             'bindings',claims,'groups',legacy_groups,'siblings',siblings,'origins',origin_index->(signature::text)));
        resolved:=resolved||jsonb_build_object(k,plan);
      end if;
      plan:=resolved->k; gid:=plan->>'groupId';
      if coalesce((plan->>'blocked')::boolean,false) or (group_input is not null and group_input<>k and group_input<>gid) then
        skipped_count:=skipped_count+1; continue;
      end if;
      if (plan->'slots') ? slot then duplicate_count:=duplicate_count+1; continue; end if;
      resolved:=jsonb_set(resolved,array[k,'slots',slot],'true');
    else
      gid:=case when group_input is not null then 'receipt_'||p_id::text||'_'||md5(group_input) end;
    end if;
    cat:=left(coalesce(nullif(trim(t->>'category'),''),'Outros'),80);
    if not exists(select 1 from jsonb_array_elements(cats) c where c->>'name'=cat) then cats:=cats||jsonb_build_array(jsonb_build_object('name',cat,'color','#8b5cf6')); end if;
    t:=t||jsonb_build_object('id','receipt_'||p_id::text||'_'||n::text,'category',cat,'groupId',gid);
    cleaned:=cleaned||jsonb_build_array(t); n:=n+1;
  end loop;
  stamp:=clock_timestamp();
  if jsonb_array_length(cleaned)>0 then
    rev:=coalesce((d->>'whatsappRevision')::bigint,0)+1;
    d:=d||jsonb_build_object('transactions',original||cleaned,'categories',cats,'updatedAt',stamp,'whatsappRevision',rev);
    update public.pastas set data=d,updated_at=stamp where id=j.folder_id and user_id=p_user;
  end if;
  update public.receipt_jobs set status='committed',committed_transactions=cleaned,committed_at=stamp where id=p_id;
  return jsonb_build_object('transactions',cleaned,'alreadyCommitted',false,'seriesDuplicates',duplicate_count,'seriesSkipped',skipped_count);
end $$;
