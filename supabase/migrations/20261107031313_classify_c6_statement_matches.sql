-- Record which printed C6 movements belong to the credit card when an import
-- matches an older transaction. Existing IDs and the original amount are preserved.
create or replace function public.receipt_finish_auto_document(p_user uuid,p_job uuid,p_version timestamptz,p_txs jsonb,p_notice jsonb)
returns text language plpgsql security invoker set search_path='' as $$
declare
  j public.receipt_jobs; f public.pastas;
  result jsonb; saved jsonb:='[]'; notice jsonb; strict_coverage boolean; n int;
  matches jsonb; refs jsonb; old_index jsonb; original jsonb; enriched jsonb; proposed jsonb;
  replacements jsonb:='{}'; linked jsonb:='{}'; linked_ids jsonb; printed_ids jsonb:='[]'; records jsonb; legacy_groups jsonb;
  claim jsonb; tx_id text; due text; closing text; purchase text; proven boolean; series jsonb; stamp timestamptz;
begin
  select * into j from public.receipt_jobs where id=p_job and user_id=p_user and document_auto and expires_at>now() for update;
  if not found then raise exception 'job_not_found'; end if;
  if j.status='committed' then return 'committed'; end if;
  if j.status<>'ready' then raise exception 'job_not_ready'; end if;
  select * into f from public.pastas where user_id=p_user and id=j.folder_id for update;
  if not found then raise exception 'folder_not_linked'; end if;
  if f.updated_at is distinct from p_version then
    update public.receipt_jobs set document_retry_at=clock_timestamp()+interval '2 seconds' where id=p_job;
    return 'replan';
  end if;
  if jsonb_typeof(p_txs) is distinct from 'array' or jsonb_typeof(p_notice) is distinct from 'object' then raise exception 'invalid_transactions'; end if;
  n:=jsonb_array_length(p_txs);
  matches:=coalesce(p_notice->'matches','[]'); refs:=coalesce(p_notice->'sourceRefs','[]');
  notice:=p_notice-'matches'-'sourceRefs'-'matchedIds'-'printedIds';
  strict_coverage:=coalesce((notice->>'requireFullCoverage')::boolean,false);
  if jsonb_typeof(matches) is distinct from 'array' or jsonb_typeof(refs) is distinct from 'array'
      or greatest(n,jsonb_array_length(matches),jsonb_array_length(refs))>10000 or octet_length(notice::text)>100000
      or octet_length(matches::text)>8000000 or octet_length(refs::text)>4000000 then raise exception 'invalid_transactions'; end if;
  if strict_coverage and (nullif(notice->'coverageIssue','null') is not null or coalesce((notice->>'skipped')::int,0)>0
      or jsonb_array_length(coalesce(notice->'blockedDocuments','[]'))>0) then raise exception 'c6_coverage_mismatch'; end if;
  if jsonb_array_length(matches)>0 then
    select coalesce(jsonb_object_agg(t->>'id',t),'{}') into old_index
      from jsonb_array_elements(f.data->'transactions') t
      where t->>'id' in (select value->>'id' from jsonb_array_elements(matches));
    select coalesce(jsonb_object_agg(g,items),'{}') into legacy_groups from (
      select t->>'groupId' g,jsonb_agg(t) items from jsonb_array_elements(f.data->'transactions') t
        where nullif(t->>'seriesKey','') is null and t->>'groupId' in (select value->>'groupId' from jsonb_each(old_index))
        group by 1) legacy_sets;
  end if;
  for claim in select value from jsonb_array_elements(matches) loop
    tx_id:=claim->>'id'; original:=old_index->tx_id;
    if original is null or not public.receipt_same_c6_movement(original,claim) then raise exception 'c6_coverage_mismatch'; end if;
    linked:=linked||jsonb_build_object(tx_id,true);
    enriched:=coalesce(replacements->tx_id,original);
    if nullif(claim->>'seriesKey','') is not null then
      purchase:=claim->>'purchaseDate';
      if left(claim->>'seriesKey',6)<>'c6:v1:' or length(claim->>'seriesKey')>2000 or coalesce(purchase,'')!~'^\d{4}-\d{2}-\d{2}$'
        or purchase::date::text<>purchase or nullif(enriched->>'purchaseDate','') is not null and enriched->>'purchaseDate'<>purchase
        or nullif(enriched->>'seriesKey','') is not null and enriched->>'seriesKey'<>claim->>'seriesKey' then raise exception 'c6_coverage_mismatch'; end if;
      series:=substr(claim->>'seriesKey',7)::jsonb;
      if jsonb_typeof(series) is distinct from 'array' or jsonb_array_length(series)<>8 or series->>0 is distinct from purchase
         or (series-7-0) is distinct from public.receipt_c6_signature(claim) then raise exception 'c6_coverage_mismatch'; end if;
      if nullif(original->>'seriesKey','') is null and public.receipt_c6_affinity(public.receipt_c6_signature(claim),purchase::date,
        coalesce(legacy_groups->(original->>'groupId'),jsonb_build_array(original)))<2 then raise exception 'c6_coverage_mismatch'; end if;
      enriched:=enriched||jsonb_build_object('purchaseDate',purchase);
    end if;
    due:=nullif(claim->>'billDueDate',''); closing:=nullif(claim->>'billClosingDate','');
    proven:=coalesce((claim->>'observed')::boolean,false);
    if strict_coverage and proven and claim->>'c6Section' in ('card','transfer','card_payment') then
      enriched:=enriched||jsonb_build_object('c6Section',claim->>'c6Section');
      -- Starting in November, confirmed purchases are tracked on the invoice.
      -- A legacy individual pending flag must not suppress the same purchase.
      if claim->>'c6Section'='card' and claim->>'type'='despesa' and closing>='2026-11-01'
          and enriched->>'paymentStatus'='pending' then
        enriched:=enriched-'paymentStatus'-'paidOn';
      end if;
    end if;
    if due is not null or closing is not null then
      if (due is not null and (due !~ '^\d{4}-\d{2}-\d{2}$' or due::date::text<>due)) or
          (closing is not null and (closing !~ '^\d{4}-\d{2}-\d{2}$' or closing::date::text<>closing or closing>due)) then
        raise exception 'c6_coverage_mismatch'; end if;
      -- The closing month establishes the reporting period even on an invoice
      -- without a printed due date. Preserve previously observed cycles.
      if not coalesce((enriched->>'billDateObserved')::boolean,false) or
        proven and (due is null or due>=coalesce(enriched->>'billDueDate','')) and
          (closing is null or closing>=coalesce(enriched->>'billClosingDate','')) then
        if closing is null and enriched->>'billDueDate' is distinct from due then enriched:=enriched-'billClosingDate'; end if;
        if due is null and enriched->>'billClosingDate' is distinct from closing then enriched:=enriched-'billDueDate'; end if;
        enriched:=enriched||jsonb_build_object('billDateObserved',proven);
        if due is not null then enriched:=enriched||jsonb_build_object('billDueDate',due); end if;
        if closing is not null then enriched:=enriched||jsonb_build_object('billClosingDate',closing); end if;
        if proven and claim->>'cardBestPurchaseDay' ~ '^([1-9]|[12][0-9]|3[01])$' then enriched:=enriched||jsonb_build_object('cardBestPurchaseDay',(claim->>'cardBestPurchaseDay')::int); end if;
      end if;
    end if;
    if nullif(claim->>'creditKind','') is not null and claim->>'type'='receita' then
      enriched:=enriched||jsonb_build_object('creditKind',claim->>'creditKind');
    end if;
    if enriched is distinct from original then replacements:=replacements||jsonb_build_object(tx_id,enriched); end if;
  end loop;
  if n>0 then
    result:=public.receipt_commit(p_user,p_job,p_txs);
    saved:=result->'transactions';
    if strict_coverage and jsonb_array_length(saved)<>n then raise exception 'c6_coverage_mismatch'; end if;
  end if;
  if strict_coverage then
    -- Compare physical page/line occurrences to the persisted second read.
    -- A line may be linked to an old or a just-inserted transaction. Identical
    -- movements in one PDF must resolve to different transaction IDs.
    with targets as (
      select ord,r->>'document' doc,r->>'page' pg,r->>'line' ln,
        case when r ? 'id' and not r ? 'index' then coalesce(replacements->(r->>'id'),old_index->(r->>'id'))
          when r ? 'index' and not r ? 'id' and r->>'index' ~ '^\d{1,5}$' then saved->((r->>'index')::int)
          else null end as tx from jsonb_array_elements(refs) with ordinality x(r,ord)
    ), cycles as (
      select pp.document_id doc,min(pp.result->'statementCheck'->>'closingDate') closing_date
      from public.receipt_job_pages pp where pp.job_id=p_job and pp.result->'statementCheck'->>'source'='c6_invoice'
      group by pp.document_id having count(distinct pp.result->'statementCheck'->>'closingDate')=1
    ), printed as (
      select pp.document_id doc, pp.context->>'pageStart' pg, coalesce(x->'sourceLines'->>0,x->'linhas'->>0) ln,x->>'data' printed_date,
        cycles.closing_date printed_closing, pp.result->'statementCheck'->>'version' proof_version,
        (select m->>'section' from jsonb_array_elements(pp.result->'statementCheck'->'movements') m
         where m->>'line'=coalesce(x->'sourceLines'->>0,x->'linhas'->>0)) printed_section,
        jsonb_build_object('desc',x->>'descricao','amount',x->'valor','currency',x->>'moeda','type',x->>'tipo',
          'installment',nullif(x->>'parcela',''),'account',coalesce(nullif(x->>'instituicao',''),pp.result->>'cartao')) as movement
      from public.receipt_job_pages pp left join cycles on cycles.doc=pp.document_id
      cross join lateral jsonb_array_elements(pp.result->'itens') x
      where pp.job_id=p_job and pp.result->'statementCheck'->>'source'='c6_invoice'
    ), joined as (
      select t.*,p.movement,p.printed_date,p.printed_closing,p.printed_section,p.proof_version from targets t full join printed p using(doc,pg,ln)
    )
    select case when count(*)=jsonb_array_length(refs) and
        coalesce(bool_and(tx is not null and nullif(tx->>'id','') is not null and movement is not null and public.receipt_same_c6_movement(tx,movement)
          and printed_date is not null and coalesce(nullif(tx->>'purchaseDate',''),tx->>'date')=printed_date
          and (not tx ? 'c6Section' or tx->>'c6Section' is not distinct from printed_section)
          and (proof_version is distinct from '2' or
            coalesce(tx->>'billClosingDate'=printed_closing and tx->>'billDateObserved'='true'
              and not (tx->>'type'='despesa' and coalesce(tx->>'paymentStatus','')='pending')
              and left(case
                when tx->'advance' is not null and tx->'advance'<>'null'::jsonb then tx->>'date'
                when tx->>'type'='despesa' and tx->>'paidOn' ~ '^\d{4}-\d{2}-\d{2}$' then tx->>'paidOn'
                else tx->>'billClosingDate' end,7)=left(printed_closing,7),false))),true)
        and count(distinct (doc,pg,ln))=count(*) and count(distinct (doc,tx->>'id'))=count(*)
      then coalesce(jsonb_agg(tx->'id' order by ord),'[]') end into printed_ids from joined;
    if printed_ids is null then raise exception 'c6_coverage_mismatch'; end if;
  end if;
  if replacements<>'{}' then
    select data into proposed from public.pastas where id=j.folder_id and user_id=p_user;
    select jsonb_agg(coalesce(replacements->(t->>'id'),t) order by pos) into records
      from jsonb_array_elements(proposed->'transactions') with ordinality x(t,pos);
    stamp:=clock_timestamp();
    update public.pastas set data=proposed||jsonb_build_object('transactions',records,'updatedAt',stamp,
        'whatsappRevision',coalesce((proposed->>'whatsappRevision')::bigint,0)+case when jsonb_array_length(saved)=0 then 1 else 0 end),
      updated_at=stamp where id=j.folder_id and user_id=p_user;
  end if;
  select coalesce(jsonb_agg(k order by k),'[]') into linked_ids from jsonb_object_keys(linked) k;
  update public.receipt_jobs set status='committed',committed_transactions=saved,committed_at=coalesce(committed_at,clock_timestamp()),
    document_retry_at=null,document_notice=notice||jsonb_build_object('included',jsonb_array_length(saved),'matchedIds',linked_ids,'printedIds',printed_ids,
      'skipped',coalesce((notice->>'skipped')::int,0)+coalesce((result->>'seriesSkipped')::int,0),
      'duplicates',coalesce((notice->>'duplicates')::int,0)+greatest(0,n-jsonb_array_length(saved)-coalesce((result->>'seriesSkipped')::int,0)))
    where id=p_job;
  return 'committed';
end $$;
