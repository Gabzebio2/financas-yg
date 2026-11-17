-- Folder ownership is enforced per row. Only the four operations covered by the
-- ownership policies are part of the client API. TRUNCATE bypasses row policies.
revoke all privileges on table public.pastas from public, anon, authenticated;
grant select, insert, update, delete on table public.pastas to authenticated;

alter policy "dono le" on public.pastas to authenticated;
alter policy "dono cria" on public.pastas to authenticated;
alter policy "dono altera" on public.pastas to authenticated;
alter policy "dono apaga" on public.pastas to authenticated;
