begin;
do $$
declare
  owner_id uuid := gen_random_uuid();
  job_id uuid := gen_random_uuid();
  folder_id text := 'fixture_' || gen_random_uuid();
  manifest jsonb;
begin
  insert into auth.users(id) values(owner_id);
  insert into public.pastas(id,user_id,data) values(folder_id,owner_id,jsonb_build_object('id',folder_id,'name','Teste isolado','transactions','[]'::jsonb));
  select jsonb_agg(jsonb_build_object('mediaType','application/pdf','bytes',42,'sha256',repeat('a',64),'label','Sintético','documentId','original',
         'context',jsonb_build_object('pageStart',n,'pageEnd',n,'totalPages',2,'documentAuto',true)) order by n)
    into manifest from generate_series(1,2) as n;
  perform public.receipt_create(owner_id,job_id,folder_id,manifest,'[]','[]');
  if public.receipt_verify_upload(owner_id,job_id,1)<>'uploading' then raise exception 'Fila iniciou com página faltante'; end if;
  if public.receipt_verify_upload(owner_id,job_id,1)<>'uploading' then raise exception 'Repetir uma página mudou o estado'; end if;
  if public.receipt_verify_upload(owner_id,job_id,0)<>'queued' then raise exception 'Upload completo ficou parado'; end if;
  if public.receipt_verify_upload(owner_id,job_id,0)<>'queued' then raise exception 'Repetição do upload final duplicou trabalho'; end if;
  if public.receipt_submit(owner_id,job_id)<>'queued' then raise exception 'Cliente da versão anterior incompatível'; end if;
  if (select document_auto from public.receipt_jobs where id=job_id) is not true then raise exception 'Perdeu a intenção de inclusão automática'; end if;
  if (select jsonb_array_length(data->'transactions') from public.pastas where id=folder_id)<>0 then raise exception 'Enviar arquivo indevidamente gravou lançamento'; end if;
  if has_function_privilege('authenticated','public.receipt_verify_upload(uuid,uuid,integer)','execute') or
     has_function_privilege('anon','public.receipt_verify_upload(uuid,uuid,integer)','execute') then raise exception 'Função privada exposta'; end if;
end $$;
rollback;
