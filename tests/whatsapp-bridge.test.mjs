import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {bridge} from "../supabase/functions/whatsapp-bridge/core.mjs";
const secret="t".repeat(43), pin=createHash("sha256").update(secret).digest("hex");
const id="33333333-3333-4333-8333-333333333333", phone="123456789", sender="+15550001234";
function harness(handler){
  const calls=[];const run=bridge({url:"https://db.test",pin,serviceKey:"sb_secret_fixture",fetcher:async (url,opts)=>{calls.push({url,opts});return handler?handler(url,opts):Response.json([]);}});
  const send=(op,args={},key=secret)=>run(new Request("https://bridge.test",{method:"POST",headers:{authorization:"Bearer "+key,"content-type":"application/json"},body:JSON.stringify({op,args})}));
  return {calls,send};
}
test("sem a credencial ou fora das operações permitidas não acessa o banco",async()=>{
  const h=harness();
  assert.equal((await h.send("notice",{id,phone,sender},"x".repeat(43))).status,401);
  for(const [op,args] of [["/rest/v1/pastas",{}],["constructor",{}],["wa_decide",{sql:"update foo"}],["notice",{id,phone,sender:"or=(id.neq.0)"}],["notified",{id,phone,sender,revision:0}]]){
    assert.equal((await h.send(op,args)).status,400);
  }
  assert.equal(h.calls.length,0);
});
test("revisão e recibo limitados ao rascunho, telefone e remetente atuais",async()=>{
  const h=harness((u,o)=>o.method==="PATCH"?new Response(null,{status:204}):Response.json([]));
  assert.deepEqual(await (await h.send("notice",{id,phone,sender})).json(),{result:[]});
  assert.deepEqual(await (await h.send("notified",{id,phone,sender,revision:3})).json(),{result:null});
  for(const c of h.calls){const u=new URL(c.url); assert.equal(u.pathname,"/rest/v1/whatsapp_inbox");assert.equal(u.searchParams.get("sender_e164"),"eq."+sender);assert.equal(u.searchParams.get("phone_number_id"),"eq."+phone);assert.equal(u.searchParams.get("draft_id"),"eq."+id);assert.equal(c.opts.headers.apikey,"sb_secret_fixture");assert.equal(c.opts.headers.Authorization,undefined);}
  assert.equal(new URL(h.calls[1].url).searchParams.get("revision"),"eq.3");assert.equal(h.calls[1].opts.body,'{"notified_revision":3}');
});
test("preserva negativa de remetente e erros de concorrência sem vazar dados internos",async()=>{
  let h=harness(()=>Response.json({accepted:false,reason:"sender_not_allowed"}));
  assert.deepEqual(await (await h.send("wa_ingest",{p_phone_number_id:phone,p_message_id:"fixture",p_sender_e164:sender})).json(),{result:{accepted:false,reason:"sender_not_allowed"}});
  assert.equal(new URL(h.calls[0].url).pathname,"/rest/v1/rpc/wa_ingest");
  for(const [msg,status] of [["draft_revision_conflict",409],["actor_not_allowed",403],["privado",503]]){
    h=harness(()=>Response.json({message:msg},{status:400}));
    const res=await h.send("wa_decide",{p_draft_id:id});assert.equal(res.status,status);assert(!(await res.text()).includes("privado"));
  }
});
