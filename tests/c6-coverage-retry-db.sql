begin;
do $test$
declare u uuid; f text:='coverage_retry_test_'||gen_random_uuid(); j uuid:=gen_random_uuid(); v timestamptz:=clock_timestamp(); answer text;
begin
 select id into strict u from auth.users limit 1;
 insert into public.pastas(user_id,id,data,updated_at) values(u,f,jsonb_build_object('id',f,'name','Synthetic test','transactions','[]'::jsonb),v);
 insert into public.receipt_jobs(user_id,id,folder_id,status,document_auto,total_pages) values(u,j,f,'ready',true,1);
 insert into public.receipt_job_pages(job_id,page_index,object_path,media_type,byte_size,sha256,label,document_id,context,quick,uploaded,result)
 values(j,0,f,'application/pdf',1,repeat('a',64),'synthetic','doc','{"pageStart":1,"totalPages":1}',false,true,'{"itens":[]}');
 answer:=public.receipt_retry_document_coverage(u,j,v);
 if answer<>'queued' or (select result is not null from public.receipt_job_pages where job_id=j) then raise exception 'TEST did not re-read original'; end if;
 update public.receipt_jobs set status='ready' where id=j;
 answer:=public.receipt_retry_document_coverage(u,j,v);
 if answer<>'error' or not (select (document_notice->>'coverageIssue')::boolean from public.receipt_jobs where id=j) then raise exception 'TEST incomplete document reported as completed'; end if;
 perform public.receipt_retry(u,j);
 if (select status from public.receipt_jobs where id=j)<>'queued' or (select jsonb_array_length(data->'transactions') from public.pastas where id=f)<>0 then raise exception 'TEST partial write or cannot retry'; end if;
 if has_function_privilege('authenticated','public.receipt_retry_document_coverage(uuid,uuid,timestamptz)','execute') then raise exception 'TEST exposed worker';end if;
end $test$;
rollback;
