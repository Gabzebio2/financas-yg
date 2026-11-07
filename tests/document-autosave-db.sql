-- All records are synthetic and all writes are rolled back.
begin;
do $test$
declare u uuid; f text:='receipt_auto_test_'||gen_random_uuid(); j uuid:=gen_random_uuid(); j2 uuid:=gen_random_uuid();
 v timestamptz:=clock_timestamp(); result text; tx jsonb; manifest jsonb; notice jsonb; folder jsonb;
begin
 select id into strict u from auth.users limit 1;
 insert into public.pastas(id,user_id,data,updated_at) values (f,u,jsonb_build_object('id',f,'transactions','[]'::jsonb,'categories','[]'::jsonb,'updatedAt',v),v);
 manifest:=jsonb_build_array(jsonb_build_object('bytes',10,'sha256',repeat('a',64),'mediaType','application/pdf','label','Teste','documentId','doc','context','{"documentAuto":true,"pageStart":1,"pageEnd":1,"totalPages":1}'::jsonb));
 perform public.receipt_create(u,j,f,manifest,'[]','[]','[]');
 update public.receipt_job_pages set uploaded=true where job_id=j;
 perform public.receipt_submit(u,j);
 if not (select document_auto from public.receipt_jobs where id=j) then raise exception 'TEST opted-in PDF not eligible'; end if;
 update public.receipt_jobs set status='ready' where id=j;
 tx:='[{"date":"2026-06-01","desc":"Teste fictício","amount":8,"type":"despesa","currency":"BRL","category":"Outros"}]';
 result:=public.receipt_finish_auto_document(u,j,v-interval '1 second',tx,'{"duplicates":0,"skipped":0,"excluded":0}');
 if result<>'replan' or (select status from public.receipt_jobs where id=j)<>'ready' then raise exception 'TEST stale plan'; end if;
 perform public.receipt_finish_auto_document(u,j,v,tx,'{"duplicates":0,"skipped":0,"excluded":0}');
 perform public.receipt_finish_auto_document(u,j,v,tx,'{"duplicates":0,"skipped":0,"excluded":0}');
 select data into folder from public.pastas where user_id=u and id=f;
 select document_notice into notice from public.receipt_jobs where id=j;
 if jsonb_array_length(folder->'transactions')<>1 or notice->>'included'<>'1' then raise exception 'TEST duplicated or missing'; end if;
 -- Identical plan from a second device: the current worker plans zero insertions.
 perform public.receipt_create(u,j2,f,manifest,'[]','[]','[]');
 update public.receipt_job_pages set uploaded=true where job_id=j2;
 perform public.receipt_submit(u,j2);update public.receipt_jobs set status='ready' where id=j2;
 perform public.receipt_finish_auto_document(u,j2,(select updated_at from public.pastas where user_id=u and id=f),'[]','{"duplicates":1,"skipped":0}');
 if (select document_notice->>'duplicates' from public.receipt_jobs where id=j2)<>'1' or (select data from public.pastas where user_id=u and id=f)<>folder then raise exception 'TEST duplicate-only batch wrote to folder'; end if;
 -- A legacy/manual submission never becomes an automatic job.
 j2:=gen_random_uuid();
 manifest:=jsonb_set(manifest,'{0,context,documentAuto}','false');
 perform public.receipt_create(u,j2,f,manifest,'[]','[]','[]');
 update public.receipt_job_pages set uploaded=true where job_id=j2;
 perform public.receipt_submit(u,j2);
 if (select document_auto from public.receipt_jobs where id=j2) then raise exception 'TEST manual job converted'; end if;
 if has_function_privilege('authenticated','public.receipt_finish_auto_document(uuid,uuid,timestamptz,jsonb,jsonb)','execute') or
 has_function_privilege('anon','public.receipt_claim_auto_document()','execute') then raise exception 'TEST exposed worker'; end if;
end $test$;
rollback;
