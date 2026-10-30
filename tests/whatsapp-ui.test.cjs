const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SOURCE = fs.readFileSync(path.join(__dirname,'../js/whatsapp.js'),'utf8');
const CODES = ['BRL','CLP','PYG','USD','EUR','GBP','USDT','USDC'];

class Element {
  constructor() {
    this.innerHTML=''; this.textContent=''; this.value=''; this.dataset={}; this.disabled=false; this.open=false;
    this.listeners=new Map(); const classes=new Set();
    this.classList={contains:n=>classes.has(n),add:n=>classes.add(n),remove:n=>classes.delete(n),toggle(n,on){if(on)classes.add(n);else classes.delete(n);}};
  }
  addEventListener(name,fn) { if(!this.listeners.has(name))this.listeners.set(name,[]);this.listeners.get(name).push(fn); }
  fire(name,event={}) { return (this.listeners.get(name)||[]).map(fn=>fn(event)); }
  contains(child) { return child.parentElement===this; }
}
const validDraft = (extra={}) => ({
  id:'draft-001',status:'pending',revision:'revision-1',summary:'Compra sintética',senderMasked:'•••• 1234',
  folderId:'folder123',folderName:'CASINHA',canConfirm:true,warnings:[],
  transaction:{date:'2026-10-23',desc:'Compra sintética',amount:12.345678,currency:'USDT',type:'despesa',category:'Mercado',account:'Conta de teste'},...extra,
});
const config = (extra={}) => ({
  configured:true,enabled:true,actionsReady:true,
  channel:{phoneNumberId:'public-id',testNumber:'+1 555 000 0000',folderId:'folder123',folderName:'CASINHA',senders:[{masked:'•••• 1234'},{masked:'•••• 9876'}]},
  pending:[validDraft()],webhookUrl:'https://app.example/api/whatsapp',...extra,
});
const ok = body => ({ok:true,status:200,json:async()=>body});
const flush = () => new Promise(setImmediate);
function harness(options={}) {
  const nodes=new Map(); const get=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);};
  const document=Object.assign(new Element(),{getElementById:get,visibilityState:'visible'});
  const window=new Element(),navigator={onLine:true};
  const calls=[], timers=new Map(); let timerId=0, currentToken=options.token===undefined?'synthetic-account-a':options.token, syncCalls=0;
  const syncOptions=[];
  const subjectCloud={getToken:()=>currentToken,async syncNow(settings){syncCalls++;syncOptions.push(JSON.parse(JSON.stringify(settings)));if(options.syncError)throw new Error('synthetic sync failure');}};
  const ctx=vm.createContext({document,window,navigator,Cloud:subjectCloud,
    location:{protocol:'https:',origin:'https://app.example',hostname:'app.example'},URL,AbortController,console,
    CURRENCY_CODES:CODES,
    isValidISODate(value){if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const date=new Date(value+'T12:00:00Z');return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;},
    fmtMoney:(amount,currency)=>currency+' '+amount.toFixed(['USDT','USDC'].includes(currency)?6:['PYG','CLP'].includes(currency)?0:2),
    setTimeout(fn,delay){const id=++timerId;timers.set(id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id),
    fetch:async(url,init)=>{calls.push({url,...init});return options.fetch?options.fetch(url,init,calls.length):ok(config());},
  });
  vm.runInContext(SOURCE+'\nglobalThis.subject = WhatsApp;',ctx);
  document.fire('DOMContentLoaded');
  return {get,document,window,navigator,calls,timers,subject:ctx.subject,cloud:subjectCloud,
    ready:flush,syncCalls:()=>syncCalls,syncOptions,
    async account(value){currentToken=value;document.fire('fyg:cloudstate');await flush();},
    async click(action,id='draft-001') {
      const button={disabled:false,dataset:{waAction:action,waId:id},parentElement:get('wa-drafts'),closest(){return this;}};
      get('wa-drafts').fire('click',{target:button});await flush();
    },
    async timeout(delay){const found=[...timers.entries()].find(([,value])=>value.delay===delay);assert(found,'timer existente');timers.delete(found[0]);found[1].fn();await flush();},
  };
}
function buttonDisabled(html,action) { return new RegExp(`<button[^>]*data-wa-action="${action}"[^>]*\\bdisabled(?:[ >])`).test(html); }

test('sem sessão não consulta o backend nem exibe pendências de outra conta',async()=>{
  const e=harness({token:null});await e.ready();
  assert.equal(e.calls.length,0);assert.equal(e.get('wa-drafts').innerHTML,'');
  assert.match(e.get('wa-status').textContent,/Entre na conta/);assert.equal(e.get('wa-refresh').disabled,true);
});

test('consulta autenticada é same-origin/no-store, escapa conteúdo e não renderiza campos secretos',async()=>{
  const e=harness({fetch:()=>ok(config({secret:'DO_NOT_RENDER_SECRET',channel:{folderId:'folder123',folderName:'<img src=x onerror=attack()>',testNumber:'+1 555 000 0000',senders:[{masked:'+551199991234'}]},
    pending:[validDraft({summary:'<script>attack()</script>',warnings:['<img src=x>'],senderMasked:'+551199991234'})]}))});
  await e.ready();const request=e.calls[0];
  assert.equal(request.url,'/api/whatsapp-config');assert.equal(request.method,'GET');
  assert.equal(request.headers.Authorization,'Bearer synthetic-account-a');assert.equal(request.cache,'no-store');
  assert.equal(request.credentials,'omit');assert.equal(request.redirect,'error');
  const html=e.get('wa-drafts').innerHTML+e.get('wa-channel').innerHTML;
  assert(!html.includes('<script>'));assert(!html.includes('<img'));assert(html.includes('&lt;script&gt;'));
  assert(!html.includes('DO_NOT_RENDER_SECRET'));assert(!html.includes('551199991234'));assert(html.includes('•••• 1234'));
});

test('piloto ainda não configurado mostra estado real e mantém ações bloqueadas',async()=>{
  const e=harness({fetch:()=>ok(config({configured:false,enabled:false,actionsReady:false}))});await e.ready();
  assert.match(e.get('wa-status').textContent,/não está ativo/);
  assert.equal(buttonDisabled(e.get('wa-drafts').innerHTML,'confirm'),true);
  assert.equal(buttonDisabled(e.get('wa-drafts').innerHTML,'reject'),true);
  await e.click('confirm');await e.click('reject');assert.equal(e.calls.length,1);assert.equal(e.syncCalls(),0);
});

test('recebimento só aparece ativo quando o servidor confirma configuração, canal e enabled',async()=>{
  const e=harness({fetch:()=>ok(config({pending:[]}))});await e.ready();
  assert.equal(e.get('wa-status-badge').textContent,'Recebimento ativo');
  assert.match(e.get('wa-guide-note').textContent,/recebimento está ativo/);
  const paused=harness({fetch:()=>ok(config({pending:[],enabled:false}))});await paused.ready();
  assert.equal(paused.get('wa-status-badge').textContent,'Em preparação');
  assert.match(paused.get('wa-status').textContent,/recebimento está pausado/);
});

test('sem ações prontas ou canConfirm, botão não executa POST mesmo por evento forjado',async()=>{
  for(const overrides of [{actionsReady:false},{pending:[validDraft({canConfirm:false})]}]){
    const e=harness({fetch:()=>ok(config(overrides))});await e.ready();await e.click('confirm');
    assert.equal(e.calls.filter(c=>c.method==='POST').length,0);
    assert.equal(buttonDisabled(e.get('wa-drafts').innerHTML,'confirm'),true);
  }
});

test('rascunho com erro permite rejeitar e explica como reenviar os dados completos',async()=>{
  const e=harness({fetch:(_,init)=>init.method==='POST'?ok({ok:true,draftId:'draft-001',status:'rejected'}):ok(config({pending:[validDraft({canConfirm:false,transaction:{},warnings:['Moeda não identificada']})]}))});
  await e.ready();const html=e.get('wa-drafts').innerHTML;
  assert.match(html,/reenvie a mensagem com data, valor, moeda e categoria completos/);
  assert.equal(buttonDisabled(html,'confirm'),true);assert.equal(buttonDisabled(html,'reject'),false);
  await e.click('reject');assert.equal(e.calls.filter(c=>c.method==='POST').length,1);assert.equal(e.syncCalls(),0);
});

test('data, valor, moeda, tipo e revisão incompletos jamais são confirmados',async()=>{
  const mutations=[{date:'2026-02-30'},{date:'2026-10-23junk'},{amount:'12.00'},{amount:Infinity},{amount:0},{currency:'UNKNOWN'},{type:'transfer'},{category:''},{desc:''}];
  for(const patch of mutations){
    const draft=validDraft({transaction:{...validDraft().transaction,...patch}});
    const e=harness({fetch:()=>ok(config({pending:[draft]}))});await e.ready();await e.click('confirm');
    assert.equal(e.calls.length,1,JSON.stringify(patch));assert.equal(buttonDisabled(e.get('wa-drafts').innerHTML,'confirm'),true);
  }
  const e=harness({fetch:()=>ok(config({pending:[validDraft({revision:''})]}))});await e.ready();await e.click('confirm');await e.click('reject');
  assert.equal(e.calls.length,1);
});

test('confirmar envia apenas id/revisão/ação, atualiza nuvem e recarrega a fila',async()=>{
  let applied=false;
  const e=harness({fetch:(_,init)=>{if(init.method==='POST'){applied=true;return ok({ok:true,draftId:'draft-001',status:'confirmed'});}return ok(config({pending:applied?[]:[validDraft()]}));}});
  await e.ready();assert.equal(e.syncCalls(),0);await e.click('confirm');
  const post=e.calls.find(c=>c.method==='POST');
  assert.deepEqual(JSON.parse(post.body),{action:'confirm',draftId:'draft-001',revision:'revision-1'});
  assert.equal(e.syncCalls(),1);assert.equal(e.calls.filter(c=>c.method==='GET').length,2);
  assert.deepEqual(e.syncOptions,[{fresh:true}], 'confirmação exige leitura posterior ao commit no servidor');
  assert.equal(e.get('wa-drafts').innerHTML,'');assert.match(e.get('wa-feedback').textContent,/confirmado na nuvem/);
});

test('rejeitar não cria lançamento nem pede sincronização financeira',async()=>{
  let applied=false;
  const e=harness({fetch:(_,init)=>{if(init.method==='POST'){applied=true;return ok({ok:true,draftId:'draft-001',status:'rejected'});}return ok(config({pending:applied?[]:[validDraft()]}));}});
  await e.ready();await e.click('reject');
  assert.equal(e.syncCalls(),0);assert.equal(e.get('wa-drafts').innerHTML,'');
  assert.match(e.get('wa-feedback').textContent,/Nenhum lançamento foi incluído/);
});

test('clique duplo mantém apenas uma confirmação em andamento',async()=>{
  let release;
  const e=harness({fetch:(_,init)=>init.method==='POST'?new Promise(resolve=>{release=resolve;}):ok(config())});
  await e.ready();await e.click('confirm');await e.click('confirm');await e.click('reject');
  assert.equal(e.calls.filter(c=>c.method==='POST').length,1);
  release(ok({ok:true,draftId:'draft-001',status:'confirmed'}));await flush();assert.equal(e.syncCalls(),1);
});

test('sucesso incompleto e conflito nunca simulam confirmação nem sincronizam',async()=>{
  for(const response of [ok({ok:true}),ok({ok:true,draftId:'other-id',status:'confirmed'}),{ok:false,status:409}]){
    const e=harness({fetch:(_,init)=>init.method==='POST'?response:ok(config())});await e.ready();await e.click('confirm');
    assert.equal(e.syncCalls(),0);assert.equal(e.get('wa-feedback').dataset.error,'true');
    assert(!e.get('wa-feedback').textContent.includes('Lançamento confirmado'));
    assert.equal(buttonDisabled(e.get('wa-drafts').innerHTML,'confirm'),true);
  }
});

test('backend ausente, sessão inválida e JSON malformado não oferecem sucesso ou ações',async()=>{
  for(const response of [{ok:false,status:404},{ok:false,status:503},{ok:false,status:401},{ok:false,status:403},ok({}),{ok:true,json:async()=>{throw new Error('malformed secret');}}]){
    const e=harness({fetch:()=>response});await e.ready();await e.click('confirm');
    assert.equal(e.calls.length,1);assert.equal(e.get('wa-drafts').innerHTML,'');
    assert(!e.get('wa-status').textContent.includes('malformed secret'));
    assert.notEqual(e.get('wa-status-badge').textContent,'Recebimento ativo');
  }
});

test('logout apaga imediatamente pendências e resposta antiga não reaparece',async()=>{
  let release;
  const e=harness({fetch:()=>new Promise(resolve=>{release=resolve;})});await e.ready();
  await e.account(null);assert.equal(e.get('wa-drafts').innerHTML,'');
  release(ok(config()));await flush();assert.equal(e.get('wa-drafts').innerHTML,'');
  assert.match(e.get('wa-status').textContent,/Entre na conta/);assert.equal(e.syncCalls(),0);
});

test('trocar de conta isola pendências mesmo quando a consulta antiga chega depois',async()=>{
  let releaseA;
  const e=harness({fetch:(_,init)=>init.headers.Authorization.includes('account-a')?new Promise(resolve=>{releaseA=resolve;}):ok(config({pending:[validDraft({id:'account-b-draft',summary:'Somente conta B'})]}))});
  await e.ready();await e.account('synthetic-account-b');releaseA(ok(config({pending:[validDraft({summary:'Privado da conta A'})]})));await flush();
  assert(e.get('wa-drafts').innerHTML.includes('Somente conta B'));
  assert(!e.get('wa-drafts').innerHTML.includes('Privado da conta A'));
  await e.click('confirm','draft-001');assert.equal(e.calls.filter(c=>c.method==='POST').length,0);
});

test('logout durante POST não publica confirmação na conta seguinte nem sincroniza',async()=>{
  let release;
  const e=harness({fetch:(_,init)=>init.method==='POST'?new Promise(resolve=>{release=resolve;}):ok(config())});
  await e.ready();await e.click('confirm');await e.account(null);
  release(ok({ok:true,draftId:'draft-001',status:'confirmed'}));await flush();
  assert.equal(e.syncCalls(),0);assert.equal(e.get('wa-feedback').textContent,'');assert.equal(e.get('wa-drafts').innerHTML,'');
});

test('timeout aborta consulta, não repete POST automaticamente e mantém mensagem verificável',async()=>{
  const e=harness({fetch:(_,init)=>init.method==='POST'?new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('timeout')))):ok(config())});
  await e.ready();await e.click('confirm');await e.timeout(12000);
  assert.equal(e.calls.filter(c=>c.method==='POST').length,1);assert.equal(e.syncCalls(),0);
  assert.match(e.get('wa-feedback').textContent,/pode ter chegado ao servidor/);
  assert.equal(buttonDisabled(e.get('wa-drafts').innerHTML,'confirm'),true);
});

test('offline bloqueia ações inclusive quando uma consulta termina atrasada',async()=>{
  let release;
  const e=harness({fetch:()=>new Promise(resolve=>{release=resolve;})});await e.ready();
  e.navigator.onLine=false;e.window.fire('offline');release(ok(config()));await flush();await e.click('confirm');
  assert.equal(e.calls.length,1);assert.equal(buttonDisabled(e.get('wa-drafts').innerHTML,'confirm'),true);
  assert.equal(e.get('wa-status-badge').textContent,'Sem conexão');
});

test('URL de recebimento não aceita outro domínio, credenciais ou parâmetros',async()=>{
  for(const webhookUrl of ['https://external.example/api/whatsapp','https://app.example/api/whatsapp?token=secret','javascript:alert(1)','https://user:pass@app.example/api/whatsapp']){
    const e=harness({fetch:()=>ok(config({webhookUrl}))});await e.ready();
    assert.equal(e.get('wa-webhook').value,'');assert.equal(e.get('wa-webhook-wrap').classList.contains('hidden'),true);
  }
});

test('sincronização indisponível não confunde confirmação no servidor com atualização local',async()=>{
  let applied=false;
  const e=harness({syncError:true,fetch:(_,init)=>{if(init.method==='POST'){applied=true;return ok({ok:true,draftId:'draft-001',status:'confirmed'});}return ok(config({pending:applied?[]:[validDraft()]}));}});
  await e.ready();await e.click('confirm');
  assert.match(e.get('wa-feedback').textContent,/confirmado na nuvem/);
  assert.match(e.get('wa-feedback').textContent,/Sincronizar agora/);
});
