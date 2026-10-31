-- Hosted extension grants are owned by supabase_admin. Signed wake migration below avoids reusable secrets in its request queue.
revoke all on net.http_request_queue, net._http_response from public,anon,authenticated; revoke usage on schema net from public,anon,authenticated;
