// A capability for the WhatsApp route, not a general PostgREST proxy.
const RPC = {
  wa_ingest: ["p_phone_number_id","p_message_id","p_sender_e164","p_message_kind","p_message_text","p_message_at","p_media"],
  wa_finish_draft: ["p_draft_id","p_lease_token","p_transaction","p_warnings","p_error"],
  wa_decide: ["p_draft_id","p_revision","p_action","p_actor_user_id","p_phone_number_id","p_sender_e164"],
};
const errors = new Set(["draft_revision_conflict","draft_already_decided","draft_not_ready","draft_not_found","category_not_found","actor_not_allowed","sender_not_allowed","channel_disabled","folder_not_found","stale_lease"]);
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const reply = (data,status=200) => Response.json(data,{status,headers:{"Cache-Control":"no-store"}});
const hash = async s => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s))), b=>b.toString(16).padStart(2,"0")).join("");
const matches = (x,y) => { if (x.length !== y.length) return false; let n=0; for(let i=0;i<x.length;i++) n|=x.charCodeAt(i)^y.charCodeAt(i); return n===0; };
export function bridge({url,serviceKey,pin,fetcher=fetch}){
  return async request=>{
    if(request.method!=="POST") return reply({error:"method"},405);
    const m=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization")||"");
    if(!m||!pin||!matches(await hash(m[1]),pin)) return reply({error:"unauthorized"},401);
    if(!serviceKey||!url) return reply({error:"unavailable"},503);
    if(!(request.headers.get("content-type")||"").startsWith("application/json")) return reply({error:"json_required"},415);
    try{
      // Enforce the limit for bodies without a content-length too.
      const limit=65536; if(Number(request.headers.get("content-length"))>limit) return reply({error:"too_large"},413);
      const parts=[]; let size=0; const rd=request.body?.getReader();
      if(!rd) return reply({error:"invalid"},400);
      while(true){const {done,value}=await rd.read(); if(done)break; size+=value.byteLength;if(size>limit){await rd.cancel();return reply({error:"too_large"},413);}parts.push(value);}
      let data;try{data=JSON.parse(await new Blob(parts).text());}catch{return reply({error:"invalid"},400);}
      if(!object(data)||!object(data.args)||typeof data.op!=="string") return reply({error:"invalid"},400);
      const {op,args}=data; let path,method,body;
      if(Object.hasOwn(RPC,op)){
        if(!Object.keys(args).length||Object.keys(args).some(k=>!RPC[op].includes(k))) return reply({error:"invalid"},400);
        path="/rest/v1/rpc/"+op; method="POST"; body=args;
      } else if(op==="notice"||op==="notified"){
        if(!uuid.test(args.id)||!/^\d{5,32}$/.test(args.phone)||!/^\+[1-9]\d{7,14}$/.test(args.sender)) return reply({error:"invalid"},400);
        const q=new URLSearchParams({draft_id:"eq."+args.id,phone_number_id:"eq."+args.phone,sender_e164:"eq."+args.sender});
        if(op==="notice"){q.set("select","draft_id,status,revision,candidate,warnings,can_confirm,phone_number_id,sender_e164,lease_token,notified_revision");method="GET";}
        else{if(!Number.isInteger(args.revision)||args.revision<1||args.revision>2147483647) return reply({error:"invalid"},400);q.set("revision","eq."+args.revision);method="PATCH";body={notified_revision:args.revision};}
        path="/rest/v1/whatsapp_inbox?"+q;
      } else return reply({error:"unknown_operation"},400);
      const headers={apikey:serviceKey,"Content-Type":"application/json"};
      // Current sb_secret keys are API keys; legacy service_role keys are JWTs.
      if(!serviceKey.startsWith("sb_secret_"))headers.Authorization="Bearer "+serviceKey;
      const res=await fetcher(url+path,{method,headers,...(body?{body:JSON.stringify(body)}:{}),redirect:"error",signal:AbortSignal.timeout(6500)});
      if(!res.ok){const error=(await res.json().catch(()=>null))?.message;return errors.has(error)?reply({error},error.includes("not_allowed")?403:409):reply({error:"database_unavailable"},503);}
      return reply({result:op==="notified"?null:await res.json()});
    }catch{return reply({error:"unavailable"},503);}
  };
}
