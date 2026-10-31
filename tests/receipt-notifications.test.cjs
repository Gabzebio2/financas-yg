const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../js/receipt-jobs.js'),'utf8');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function setup(initial=[]){
 const nodes=new Map(),events=new Map(),requests=[],opened=[],confirmations=[];let user='owner',folder='folder',jobs=initial,listFailure=false,discardFailure=false;
 function node(id){if(!nodes.has(id)){const listeners=new Map(),classes=new Set();let html='';nodes.set(id,{open:false,textContent:'',writes:0,attributes:{},classList:{toggle(c,b){b?classes.add(c):classes.delete(c);},contains:c=>classes.has(c)},get innerHTML(){return html;},set innerHTML(s){html=s;this.writes++;},setAttribute(k,v){this.attributes[k]=v;},querySelector:s=>node(s),addEventListener(n,f){listeners.set(n,[...(listeners.get(n)||[]),f]);},async fire(n,e={}){for(const f of listeners.get(n)||[])await f({target:this,currentTarget:this,...e});},showModal(){this.open=true;},close(){this.open=false;}});}return nodes.get(id);}
 const ctx=vm.createContext({console,AbortSignal,crypto:require('node:crypto').webcrypto,window:{addEventListener(){}},document:{visibilityState:'visible',querySelector:node,addEventListener:(n,f)=>events.set(n,f)},setTimeout:()=>1,clearTimeout(){},Cloud:{getSyncState:()=>({owner:user}),getToken:async()=>user?'token':null,syncNow:async()=>true},Dashboard:{getImportTargetId:()=>folder},Batch:{open:d=>opened.push(d)},escapeHtml:s=>String(s).replace(/</g,'&lt;').replace(/"/g,'&quot;'),toast(){},fetch:async(_,init)=>{const b=JSON.parse(init.body);requests.push(b);if(b.action==='list')return {ok:!listFailure,json:async()=>listFailure?{error:'service_unavailable'}:{jobs}};if(b.action==='get')return {ok:true,json:async()=>({job:jobs.find(j=>j.id===b.id),pages:[]})};return {ok:true,json:async()=>({})};}});
 ctx.askConfirm=(title,text,callback)=>confirmations.push({title,text,callback});
 const originalFetch=ctx.fetch;ctx.fetch=async(url,opt)=>{const b=JSON.parse(opt.body);if(b.action==='discard'){requests.push(b);if(discardFailure)return {ok:false,json:async()=>({error:'service_unavailable'})};jobs=jobs.filter(j=>j.id!==b.id);return {ok:true,json:async()=>({discarded:true})};}return originalFetch(url,opt);};
 vm.runInContext(source+'\nthis.api=ReceiptJobs;',ctx);events.get('DOMContentLoaded')();
 return {node,requests,opened,confirmations,api:ctx.api,setJobs:v=>jobs=v,setUser:v=>user=v,setFolder:v=>folder=v,fail:()=>listFailure=true,failDiscard:()=>discardFailure=true};
}
const job=(status='ready',id='test')=>({id,label:'Extrato fictício',status,uploaded:1,total_pages:2,first:2,second:1,expires_at:'2026-11-14',retry_count:0});
test('sino abre diálogo, conta pendências e mostra progresso, resultado e confirmação de inclusão',async()=>{
 const h=setup([job(),job('processing','p'),job('committed','c')]);await settle();
 assert.equal(h.node('#receipt-jobs').open,false);assert.equal(h.node('#receipt-notification-count').textContent,'2');
 await h.node('#hero-notifications').fire('click');assert.equal(h.node('#receipt-jobs').open,true);
 const html=h.node('[data-jobs-list]').innerHTML;assert.match(html,/Conferir e incluir/);assert.match(html,/conferência 1\/2/);assert.match(html,/Incluído na pasta/);
 await h.node('#receipt-notifications-close').fire('click');assert.equal(h.node('#receipt-jobs').open,false);
});
test('resultado abre prévia sem gravar; atualização igual não recria botões e perde foco',async()=>{
 const h=setup([job()]);await settle();const writes=h.node('[data-jobs-list]').writes;await h.api.refresh();assert.equal(h.node('[data-jobs-list]').writes,writes);
 await h.node('#hero-notifications').fire('click');await settle();
 const button={dataset:{action:'open',job:'test'}};await h.node('#receipt-jobs').fire('click',{target:{closest:()=>button}});
 assert.equal(h.node('#receipt-jobs').open,false);assert.equal(h.opened.length,1);assert.equal(h.opened[0].backgroundJob.job.id,'test');assert(!h.requests.some(r=>r.action==='commit'));
});
test('logout e troca de pasta limpam notificações e fecham o diálogo',async()=>{
 const h=setup([job()]);await settle();await h.node('#hero-notifications').fire('click');await settle();
 h.setUser(null);await h.api.refresh();assert.equal(h.node('#receipt-jobs').open,false);assert.equal(h.node('#receipt-notification-count').classList.contains('hidden'),true);assert.doesNotMatch(h.node('[data-jobs-list]').innerHTML,/Extrato fictício/);
 h.setUser('other');h.setFolder('other-folder');h.setJobs([]);await h.api.refresh();assert.match(h.node('[data-jobs-list]').innerHTML,/Tudo em dia/);
});
test('inclusão remove contagem pendente; falha de consulta mantém resultado anterior e erro legível',async()=>{
 const h=setup([job()]);await settle();h.fail();await h.api.refresh();assert.match(h.node('[data-jobs-list]').innerHTML,/Conferir e incluir/);assert.match(h.node('#receipt-jobs [data-jobs-error]').textContent,/Não foi possível conectar/);
 const done=setup([job('committed')]);await settle();assert.equal(done.node('#receipt-notification-count').classList.contains('hidden'),true);assert.match(done.node('[data-jobs-list]').innerHTML,/Incluído na pasta/);
});

test('documento pronto pode ser excluído com confirmação e some do sino sem incluir transações',async()=>{
 const h=setup([job()]);await settle();assert.match(h.node('[data-jobs-list]').innerHTML,/Excluir documento/);
 await h.node('#hero-notifications').fire('click');await settle();const button={dataset:{action:'discard',job:'test'}};
 await h.node('#receipt-jobs').fire('click',{target:{closest:()=>button}});assert.equal(h.node('#receipt-jobs').open,false);assert.equal(h.confirmations.length,1);assert(!h.requests.some(r=>r.action==='discard'));
 await h.confirmations[0].callback();await settle();assert.equal(h.requests.filter(r=>r.action==='discard').length,1);assert(!h.requests.some(r=>r.action==='commit'));assert.doesNotMatch(h.node('[data-jobs-list]').innerHTML,/Extrato fictício/);assert.equal(h.node('#receipt-notification-count').classList.contains('hidden'),true);
});

test('confirmação antiga não exclui após mudar de pasta; erro de rede preserva o documento',async()=>{
 const h=setup([job()]);await settle();const button={dataset:{action:'discard',job:'test'}};
 await h.node('#receipt-jobs').fire('click',{target:{closest:()=>button}});h.setFolder('other');await h.confirmations[0].callback();assert(!h.requests.some(r=>r.action==='discard'));
 const fail=setup([job()]);await settle();fail.failDiscard();await assert.rejects(fail.api.discard('test'));assert.match(fail.node('[data-jobs-list]').innerHTML,/Extrato fictício/);
});
