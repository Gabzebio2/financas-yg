-- Use only isolated synthetic rows. All test writes are rolled back.
begin;
do $test$
declare
  u uuid; f text:='c6_series_test_'||gen_random_uuid(); j1 uuid:=gen_random_uuid();
  j2 uuid:=gen_random_uuid(); j3 uuid:=gen_random_uuid(); j4 uuid:=gen_random_uuid();
  j5 uuid:=gen_random_uuid(); j6 uuid:=gen_random_uuid(); j7 uuid:=gen_random_uuid();
  k1 text:='c6:v1:["2026-01-31",3,"loja","BRL","despesa","c6",100,1]';
  k2 text:='c6:v1:["2026-01-31",3,"loja","BRL","despesa","c6",100,2]';
  sep text:='c6:v1:["2026-04-30",3,"loja","BRL","despesa","c6",100,1]';
  tx jsonb; second_tx jsonb; third_tx jsonb; stale jsonb; calls jsonb; result jsonb; again jsonb; initial jsonb; rev int;
begin
  select id into strict u from auth.users limit 1;
  insert into public.pastas(id,user_id,data) values(f,u,jsonb_build_object('id',f,'name','C6 synthetic test','transactions','[]'::jsonb,'categories','[]'::jsonb));
  insert into public.receipt_jobs(id,user_id,folder_id,status,total_pages)
    select j,u,f,'ready',1 from unnest(array[j1,j2,j3,j4,j5,j6,j7]) j;
  tx:=jsonb_build_object('seriesKey',k1,'purchaseDate','2026-01-31','date','2026-01-31','desc','LOJA','type','despesa','currency','BRL','account','C6','amount',100,'installment','1/3');
  second_tx:=tx||'{"date":"2026-02-28","installment":"2/3"}';
  third_tx:=tx||'{"date":"2026-03-31","installment":"3/3"}';

  -- February clamps to its last day, and March returns to the ORIGINAL day.
  begin
    perform public.receipt_commit(u,j1,jsonb_build_array(tx,second_tx||'{"date":"2026-03-03"}'));
    raise exception 'TEST wrong scheduled date accepted';
  exception when others then if sqlerrm<>'invalid_transaction' then raise; end if; end;
  result:=public.receipt_commit(u,j1,jsonb_build_array(tx,second_tx));
  again:=public.receipt_commit(u,j1,jsonb_build_array(tx));
  if jsonb_array_length(result->'transactions')<>2 or result->'transactions'<>again->'transactions'
     or again->>'alreadyCommitted'<>'true' or result->'transactions'->0->>'groupId'<>'c6_'||md5(k1)
    then raise exception 'TEST same-job retry/group'; end if;

  -- Second device prepared its invoice before the first device committed.
  result:=public.receipt_commit(u,j2,jsonb_build_array(tx,second_tx,third_tx));
  if jsonb_array_length(result->'transactions')<>1 or result->'transactions'->0->>'installment'<>'3/3'
     or result->'transactions'->0->>'groupId'<>'c6_'||md5(k1) then raise exception 'TEST cross-job missing-slot append'; end if;
  select (data->>'whatsappRevision')::int into rev from public.pastas where id=f and user_id=u;
  result:=public.receipt_commit(u,j3,jsonb_build_array(tx,second_tx,third_tx));
  if result->'transactions'<>'[]'::jsonb or (select (data->>'whatsappRevision')::int from public.pastas where id=f and user_id=u)<>rev
     then raise exception 'TEST duplicate-only job mutated folder'; end if;
  result:=public.receipt_commit(u,j4,jsonb_build_array(tx||jsonb_build_object('seriesKey',k2),tx||jsonb_build_object('seriesKey',k2)));
  if jsonb_array_length(result->'transactions')<>1 or result->'transactions'->0->>'groupId'='c6_'||md5(k1) then raise exception 'TEST genuine equal buys collapsed'; end if;

  -- A legacy group at the same price and date is reused only with compatible evidence.
  initial:=(tx-'seriesKey'-'purchaseDate')||'{"groupId":"legacy123","id":"legacy-slot","date":"2026-04-30"}';
  update public.pastas set data=jsonb_set(data,'{transactions}',(data->'transactions')||jsonb_build_array(initial)) where id=f and user_id=u;
  calls:=jsonb_build_array(tx||jsonb_build_object('date','2026-04-30','purchaseDate','2026-04-30','seriesKey',sep,'groupId','legacy123'),
      second_tx||jsonb_build_object('date','2026-05-30','purchaseDate','2026-04-30','seriesKey',sep,'groupId','legacy123'));
  result:=public.receipt_commit(u,j5,calls);
  if jsonb_array_length(result->'transactions')<>1 or result->'transactions'->0->>'groupId'<>'legacy123'
     or not exists(select 1 from public.pastas p cross join jsonb_array_elements(p.data->'transactions') x where p.id=f and p.user_id=u and x=initial)
     then raise exception 'TEST legacy linkage changed original'; end if;

  -- A concurrently added near-date legacy row is ambiguous. Reject the entire
  -- confirmation rather than silently skipping/inserting the wrong purchase.
  stale:=(tx-'seriesKey'-'purchaseDate')||'{"id":"stale-slot","groupId":"other-group","date":"2026-05-03"}';
  update public.pastas set data=jsonb_set(data,'{transactions}',(data->'transactions')||jsonb_build_array(stale)) where id=f and user_id=u;
  begin
    perform public.receipt_commit(u,j6,jsonb_build_array(third_tx||jsonb_build_object('date','2026-06-30','purchaseDate','2026-04-30','seriesKey',sep)));
    raise exception 'TEST stale preview accepted';
  exception when others then if sqlerrm<>'c6_series_changed' then raise; end if; end;
  if (select status from public.receipt_jobs where id=j6)<>'ready' then raise exception 'TEST partial job commit'; end if;

  -- Other imports retain the original group behavior and row multiplicity.
  tx:=jsonb_build_object('date','2026-01-31','desc','NORMAL','type','despesa','currency','PYG','account','Ueno','amount',100,'groupId','abc');
  result:=public.receipt_commit(u,j7,jsonb_build_array(tx,tx));
  if jsonb_array_length(result->'transactions')<>2 or result->'transactions'->0->>'groupId'<>'receipt_'||j7::text||'_'||md5('abc')
    then raise exception 'TEST other imports changed'; end if;
  if has_function_privilege('authenticated','public.receipt_c6_group(jsonb,jsonb,jsonb,jsonb)','execute') or
     has_function_privilege('anon','public.receipt_commit(uuid,uuid,jsonb)','execute') then raise exception 'TEST exposed procedure'; end if;
end $test$;
rollback;
