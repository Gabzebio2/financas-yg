create policy receipt_config_service_only on public.receipt_worker_config for all to service_role using(true) with check(true);
