const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/navigation.js'), 'utf8');
const match = source.match(/  function refreshConnection\(\) \{[\s\S]*?(?=\n  wire\("#btn-cloud-link-local")/);
assert(match, 'connection status renderer must exist');

function render(overrides) {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {textContent:'',title:'',classList:{toggle(){},contains(){return false;}},replaceChildren(...children){this.children=children;}});
    return nodes.get(id);
  };
  const state = {connected:true,autoSync:true,status:'pending',pendingCount:1,pendingUploads:1,pendingDeletes:0,queueDurable:true,...overrides};
  const context = vm.createContext({navigator:{onLine:true},Cloud:{getSyncState:()=>state},document:{querySelector:node,createElement:()=>({setAttribute(){}}),createTextNode:text=>text}});
  vm.runInContext(match[0]+'\nrefreshConnection();',context);
  return nodes;
}

test('a causa real permanece visível mesmo quando há envios pendentes',()=>{
  const nodes=render({status:'error',error:'A política da nuvem recusou a gravação.'});
  assert.match(nodes.get('#cloud-queue-status').textContent,/Motivo: A política da nuvem recusou a gravação/);
  assert.match(nodes.get('#connection-status').title,/recusou a gravação/);
});

test('uma pasta antiga inválida não é apresentada como nuvem em dia ou indisponível',()=>{
  const nodes=render({status:'error',pendingCount:0,pendingUploads:0,invalidRemoteCount:1});
  assert.equal(nodes.get('#connection-status').children.at(-1),'Conferir pastas antigas');
  assert.match(nodes.get('#cloud-queue-status').textContent,/preservadas sem alterações/);
  assert.match(nodes.get('#cloud-queue-status').textContent,/demais pastas podem sincronizar/);
});

test('pendências bloqueadas e pastas sem vínculo têm instruções distintas',()=>{
  const nodes=render({invalidRemoteCount:1,blockedPendingCount:1,unlinkedCount:1});
  assert.match(nodes.get('#cloud-queue-status').textContent,/1 pendência\(s\) dependem da correção/);
  assert.match(nodes.get('#cloud-link-hint').textContent,/Vincular pastas locais a esta conta/);
});

test('sincronização em andamento não reapresenta o erro antigo',()=>{
  const nodes=render({status:'syncing',error:'Erro antigo'});
  assert.doesNotMatch(nodes.get('#cloud-queue-status').textContent,/Erro antigo/);
});
