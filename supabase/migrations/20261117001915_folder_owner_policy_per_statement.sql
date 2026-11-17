-- Keep the existing policy roles and ownership checks. An uncorrelated subquery
-- lets Postgres evaluate the authenticated user once per statement.
alter policy "dono le" on public.pastas using ((select auth.uid()) = user_id);
alter policy "dono cria" on public.pastas with check ((select auth.uid()) = user_id);
alter policy "dono altera" on public.pastas using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "dono apaga" on public.pastas using ((select auth.uid()) = user_id);
