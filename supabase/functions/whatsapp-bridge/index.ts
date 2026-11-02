import {bridge} from "./core.mjs";
import {pin} from "./verifier.mjs";
const serviceKey=JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")||"{}").default||Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
Deno.serve(bridge({url:Deno.env.get("SUPABASE_URL"),serviceKey,pin}));
