-- Synthetic entries only. Roll back the complete test transaction.
begin;
do $test$
declare
 u uuid; f text:='c6_cycle_'||gen_random_uuid(); j uuid:=gen_random_uuid(); j2 uuid:=gen_random_uuid(); j3 uuid:=gen_random_uuid();
 stamp timestamptz:=clock_timestamp(); observed jsonb; avulso jsonb; original jsonb; manifest jsonb;
 row_a jsonb; row_b jsonb; notice jsonb; proposal jsonb; saved jsonb; updated jsonb; rev text;
begin
 select id into strict u from auth.users limit 1;
 original:='{"id":"old-position","date":"2026-09-30","amount":340,"account":"C6","type":"despesa","currency":"BRL","desc":"Loja","installment":"5/5","custom":"conservar"}';
 insert into public.pastas(id,user_id,data,updated_at) values(f,u,jsonb_build_object('id',f,'transactions',jsonb_build_array(original),'categories','[]'::jsonb,'updatedAt',stamp),stamp);
 manifest:=jsonb_build_array(jsonb_build_object('bytes',1,'sha256',repeat('b',64),'mediaType','application/pdf','label','Fictícia','documentId','d',
     'context','{"documentAuto":true,"pageStart":1,"pageEnd":1,"totalPages":1}'::jsonb));
 foreach j in array array[j,j2,j3] loop
   perform public.receipt_create(u,j,f,manifest,'[]','[]','[]');
   update public.receipt_job_pages set uploaded=true where job_id=j;
   perform public.receipt_submit(u,j);update public.receipt_jobs set status='ready' where id=j;
 end loop;
 j:=(select id from public.receipt_jobs where user_id=u and folder_id=f and id not in (j2,j3));
 observed:=original||'{"seriesKey":"c6:v1:[\"2026-05-30\",5,\"loja\",\"BRL\",\"despesa\",\"c6\",340,1]","purchaseDate":"2026-05-30","observed":true,"billDueDate":"2026-11-05","billClosingDate":"2026-10-29"}';
 avulso:='{"date":"2026-10-05","amount":6145.28,"account":"C6","type":"receita","currency":"BRL","desc":"Inclusão de pagamento","category":"Outros"}';
 row_a:='{"sourceLines":[9],"data":"2026-05-30","descricao":"Loja","valor":340,"instituicao":"C6","tipo":"despesa","moeda":"BRL","parcela":"5/5"}';
 row_b:='{"sourceLines":[10],"data":"2026-10-05","descricao":"Inclusão de pagamento","valor":6145.28,"instituicao":"C6","tipo":"receita","moeda":"BRL"}';
 update public.receipt_job_pages set result=jsonb_build_object('statementCheck',jsonb_build_object('source','c6_invoice'),'itens',jsonb_build_array(row_a,row_b)) where job_id in(j,j2);
 notice:=jsonb_build_object('requireFullCoverage',true,'duplicates',1,'matches',jsonb_build_array(observed),'sourceRefs','[{"document":"d","page":1,"line":9,"id":"old-position"},{"document":"d","page":1,"line":10,"index":0}]'::jsonb);
 -- Omitting a real printed row or using its index for a different amount rolls back the whole operation.
 begin
   perform public.receipt_finish_auto_document(u,j,stamp,jsonb_build_array(avulso),jsonb_set(notice,'{sourceRefs}',(notice->'sourceRefs')-1));
   raise exception 'TEST missing row accepted';
 exception when raise_exception then if sqlerrm<>'c6_coverage_mismatch' then raise; end if;end;
 begin
   perform public.receipt_finish_auto_document(u,j,stamp,jsonb_build_array(avulso||'{"amount":99}'),notice);
   raise exception 'TEST wrong value accepted';
 exception when raise_exception then if sqlerrm<>'c6_coverage_mismatch' then raise; end if;end;
 if (select data->'transactions' from public.pastas where user_id=u and id=f)<>jsonb_build_array(original) or
   (select status from public.receipt_jobs where id=j)<>'ready' then raise exception 'TEST partial update'; end if;
 perform public.receipt_finish_auto_document(u,j,stamp,jsonb_build_array(avulso),notice);
 select data,updated_at into updated,stamp from public.pastas where id=f and user_id=u;
 select document_notice into saved from public.receipt_jobs where id=j;
 if jsonb_array_length(updated->'transactions')<>2 or updated->'transactions'->0->>'date'<>'2026-09-30' or
   updated->'transactions'->0->>'id'<>'old-position' or updated->'transactions'->0->>'custom'<>'conservar' or
   updated->'transactions'->0->>'billDueDate'<>'2026-11-05' or updated->'transactions'->0->>'purchaseDate'<>'2026-05-30' or
   saved->'printedIds'<>jsonb_build_array('old-position','receipt_'||j::text||'_0') or saved->'matchedIds'<>'["old-position"]'::jsonb or saved ? 'matches' then raise exception 'TEST evidence/due date';end if;
 -- Another invoice may project the same existing slot; it must not overwrite its actual due date.
 proposal:=jsonb_build_object('matches',jsonb_build_array(observed||'{"observed":false,"billDueDate":"2026-10-07","billClosingDate":"2026-09-27"}'));
 perform public.receipt_finish_auto_document(u,j3,stamp,'[]',proposal);
 if (select data from public.pastas where user_id=u and id=f)<>updated then raise exception 'TEST projection displaced real evidence'; end if;
 -- Two separate physical occurrences in a file cannot both consume one existing transaction.
 update public.receipt_job_pages set result=jsonb_set(result,'{itens}',jsonb_build_array(row_a,row_a||'{"sourceLines":[10]}')) where job_id=j2;
 begin
   perform public.receipt_finish_auto_document(u,j2,stamp,'[]',jsonb_set(notice,'{sourceRefs,1}','{"document":"d","page":1,"line":10,"id":"old-position"}'));
   raise exception 'TEST same id accepted twice';
 exception when raise_exception then if sqlerrm<>'c6_coverage_mismatch' then raise; end if;end;
end $test$;
rollback;
