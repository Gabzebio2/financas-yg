-- Synthetic folders/jobs only. The complete transaction rolls back.
begin;
do $$
declare u uuid; f text:=substr(md5(random()::text),1,20); j uuid; job_no int; p jsonb; tx jsonb; plan jsonb; saved jsonb; result jsonb; lease uuid; count_before int;
begin
 select id into strict u from auth.users limit 1;
 insert into public.pastas(id,user_id,data) values(f,u,jsonb_build_object('id',f,'name','Synthetic QA','transactions','[]'::jsonb,'categories','[]'::jsonb));
 tx:='{"date":"2026-10-24","desc":"Synthetic coffee","amount":8.78,"currency":"USD","type":"despesa","category":"Outros","account":"Ether.fi","referenceId":"","cashback":{"amount":0.08,"currency":"USD"}}';
 for job_no in 1..3 loop
   j:=gen_random_uuid();lease:=gen_random_uuid();
   p:=jsonb_build_object('mediaType','image/png','bytes',1,'sha256',repeat(case when job_no=3 then 'b' else 'a' end,64),'label','Synthetic','documentId','one','quick',true,
      'context','{"pageStart":1,"pageEnd":1,"totalPages":1,"photoAuto":true}'::jsonb);
   perform public.receipt_create(u,j,f,jsonb_build_array(p),'[]','[]');
   update public.receipt_job_pages set uploaded=true,lease_token=lease,lease_until=now()+interval '1 minute' where job_id=j;
   update public.receipt_jobs set status='processing' where id=j;
   plan:=jsonb_build_array(jsonb_build_object('tx',tx),jsonb_build_object('tx',case when job_no=3 then tx||'{"desc":"Another store","amount":2}' else tx end));
   result:=jsonb_build_object('itens','[{"descricao":"a"},{"descricao":"b"}]'::jsonb,'ledger','{"missing":[]}'::jsonb,'partial',false,'verified',true,'reviewMode','automatic','photoPlan',jsonb_build_object('entries',plan,'excluded',0));
   if not public.receipt_finish(j,0,lease,result) then raise exception 'finish failed'; end if;
   select photo_notice into saved from public.receipt_jobs where id=j;
   select jsonb_array_length(data->'transactions') into count_before from public.pastas where id=f;
   if job_no=1 and (count_before<>2 or jsonb_array_length(saved->'items')<>2) then raise exception 'two equal genuine purchases lost'; end if;
   if job_no=2 and (count_before<>2 or (saved->>'duplicates')::int<>2) then raise exception 'replay duplicated'; end if;
   if job_no=3 then
     if count_before<>3 or (select status from public.receipt_jobs where id=j)<>'ready' or jsonb_array_length((select pg.result->'itens' from public.receipt_job_pages as pg where pg.job_id=j))<>1 then raise exception 'partial commit failed';end if;
     perform public.receipt_commit(u,j,jsonb_build_array(tx));
     perform public.receipt_commit(u,j,jsonb_build_array(tx));
     if (select count(distinct t->>'id') from public.pastas, jsonb_array_elements(data->'transactions') t where id=f)<>4 then raise exception 'manual correction collided or repeated';end if;
   end if;
 end loop;
end $$;
rollback;
