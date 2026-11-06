-- Match a legacy installment only by its purchase attributes, never by price alone.
-- Strip the printed installment suffix only when it agrees with the stored slot.
create function public.receipt_c6_signature(t jsonb) returns jsonb
language sql immutable strict security invoker set search_path = '' as $$
  with normalized as (
    select trim(regexp_replace(regexp_replace(normalize(lower(t->>'desc'), NFD), U&'[\0300-\036f]', '', 'g'), '[[:space:]]+', ' ', 'g')) as description,
           trim(regexp_replace(regexp_replace(normalize(lower(t->>'account'), NFD), U&'[\0300-\036f]', '', 'g'), '[[:space:]]+', ' ', 'g')) as account,
           t->>'installment' as slot
  )
  select jsonb_build_array(
    split_part(slot,'/',2)::int,
    regexp_replace(description,'[[:space:]]*[-–—][[:space:]]*parcela[[:space:]]+' ||
      split_part(slot,'/',1)||'[[:space:]]*/[[:space:]]*'||split_part(slot,'/',2)||'$',''),
    t->>'currency', t->>'type',
    case when account in ('c6','c6 bank','banco c6') then 'c6' else account end,
    t->'amount')
  from normalized where slot ~ '^[1-9][0-9]{0,2}/[1-9][0-9]{0,2}$'
$$;

-- Resolve a purchase once under the folder lock. The slots returned here are
-- already occupied; their original transactions are kept byte-for-byte.
create function public.receipt_c6_group(t jsonb, legacy jsonb, keyed jsonb, claims jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  k text := t->>'seriesKey'; chosen text := nullif(t->>'groupId','');
  purchase_day date := (t->>'purchaseDate')::date;
  parts jsonb;
  row_data jsonb; gid text; match_group text; inferred_group text; slots jsonb := '{}';
  old_date date; monthly_date date; explicit_day text;
begin
  parts:=substr(k,7)::jsonb;
  if chosen=k then chosen:=null; end if;

  for row_data in select value from jsonb_array_elements(keyed) loop
    gid := nullif(row_data->>'groupId','');
    if gid is null or (match_group is not null and match_group<>gid) then raise exception 'c6_series_changed'; end if;
    match_group:=gid;
    slots:=slots||jsonb_build_object(row_data->>'installment',true);
  end loop;
  for row_data in select value from jsonb_array_elements(legacy) loop
    gid:=nullif(row_data->>'groupId',''); explicit_day:=nullif(row_data->>'purchaseDate','');
    -- An established mapping to another purchase disambiguates identical buys.
    if gid is not null and claims ? gid and claims->>gid<>k then
      if claims->>gid='conflict' or gid=chosen then raise exception 'c6_series_changed'; end if;
      continue;
    end if;
    if explicit_day is not null then
      if explicit_day<>purchase_day::text then continue; end if;
    else
      old_date:=coalesce(nullif(row_data->'advance'->>'scheduledDate',''),row_data->>'date')::date;
      monthly_date:=(purchase_day+make_interval(months=>split_part(row_data->>'installment','/',1)::int-1))::date;
      if old_date<>purchase_day and old_date<>monthly_date then
        if abs(old_date-monthly_date)<=35 then raise exception 'c6_series_changed'; end if;
        continue;
      end if;
    end if;
    -- Two otherwise identical purchases require separate occurrence ordinals.
    -- Without a proven association a legacy row cannot be assigned to the second purchase.
    if (parts->>7)::int>1 and (gid is null or claims->>gid is distinct from k) then raise exception 'c6_series_changed'; end if;
    if gid is not null and match_group is not null and gid<>match_group then raise exception 'c6_series_changed'; end if;
    if gid is not null and inferred_group is not null and inferred_group<>gid then raise exception 'c6_series_changed'; end if;
    if gid is not null then inferred_group:=gid; end if;
    if slots ? (row_data->>'installment') then raise exception 'c6_series_changed'; end if;
    slots := slots || jsonb_build_object(row_data->>'installment',true);
  end loop;
  match_group:=coalesce(match_group,inferred_group);
  if chosen is not null and chosen is distinct from match_group and chosen is distinct from ('c6_'||md5(k)) then
    raise exception 'c6_series_changed';
  end if;
  match_group:=coalesce(match_group,'c6_'||md5(k));
  if claims ? match_group and claims->>match_group<>k then raise exception 'c6_series_changed'; end if;
  return jsonb_build_object('groupId',match_group,'slots',slots);
end $$;

revoke all on function public.receipt_c6_signature(jsonb), public.receipt_c6_group(jsonb,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.receipt_c6_signature(jsonb), public.receipt_c6_group(jsonb,jsonb,jsonb,jsonb) to service_role;

create or replace function public.receipt_commit(p_user uuid,p_id uuid,p_txs jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare
  j public.receipt_jobs; d jsonb; t jsonb; cleaned jsonb:='[]'; cats jsonb; cat text;
  n int:=0; rev bigint; stamp timestamptz;
  original jsonb; keyed jsonb; legacy jsonb; claims jsonb; legacy_groups jsonb; resolved jsonb:='{}';
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
      if exists(select 1 from jsonb_array_elements(keyed->k) x where x->>'installment'=slot) then continue; end if;
      if not resolved ? k then
        plan:=public.receipt_c6_group(t,coalesce(legacy->(signature::text),'[]'),coalesce(keyed->k,'[]'),claims);
        gid:=plan->>'groupId';
        -- A matching slot does not prove that unrelated members of an old
        -- group belong to the purchase being continued.
        if exists(select 1 from jsonb_array_elements(legacy_groups->gid) x where
            public.receipt_c6_signature(x) is distinct from signature or
            case when nullif(x->>'purchaseDate','') is not null then x->>'purchaseDate'<>t->>'purchaseDate'
            else coalesce(nullif(x->'advance'->>'scheduledDate',''),x->>'date') is distinct from t->>'purchaseDate' and
              coalesce(nullif(x->'advance'->>'scheduledDate',''),x->>'date') is distinct from
              (((t->>'purchaseDate')::date+make_interval(months=>split_part(x->>'installment','/',1)::int-1))::date)::text end)
          then raise exception 'c6_series_changed'; end if;
        claims:=claims||jsonb_build_object(gid,k);
        resolved:=resolved||jsonb_build_object(k,plan);
      end if;
      plan:=resolved->k; gid:=plan->>'groupId';
      if group_input is not null and group_input<>k and group_input<>gid then raise exception 'c6_series_changed'; end if;
      if (plan->'slots') ? slot then continue; end if;
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
  return jsonb_build_object('transactions',cleaned,'alreadyCommitted',false);
end $$;
