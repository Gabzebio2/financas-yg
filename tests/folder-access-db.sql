-- Read-only assertions about the client API. Safe to run after all migrations.
do $$
declare
  permission text;
begin
  if not (select relrowsecurity from pg_class where oid='public.pastas'::regclass) then
    raise exception 'Folders require row level security';
  end if;
  foreach permission in array array['SELECT','INSERT','UPDATE','DELETE','REFERENCES','TRIGGER','TRUNCATE'] loop
    if has_table_privilege('anon','public.pastas',permission) then
      raise exception 'Unexpected anonymous folder privilege: %', permission;
    end if;
    if has_table_privilege('authenticated','public.pastas',permission)
       is distinct from (permission = any(array['SELECT','INSERT','UPDATE','DELETE'])) then
      raise exception 'Unexpected authenticated folder privilege: %', permission;
    end if;
  end loop;
  if (select count(*) from pg_policies where schemaname='public' and tablename='pastas') <> 4 or
     (select count(distinct cmd) from pg_policies
      where schemaname='public' and tablename='pastas' and roles=array['authenticated'::name]
        and cmd in ('SELECT','INSERT','UPDATE','DELETE')
        and (cmd='INSERT' or (qual like '%auth.uid()%' and qual like '%user_id%'))
        and (cmd not in ('INSERT','UPDATE') or (with_check like '%auth.uid()%' and with_check like '%user_id%'))) <> 4 then
    raise exception 'Folder ownership policies are incomplete';
  end if;
end
$$;
