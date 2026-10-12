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
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, {textContent:'',title:'',disabled:false,classList:{toggle(name,on){on ? classes.add(name) : classes.delete(name);},contains(name){return classes.has(name);}},replaceChildren(...children){this.children=children;}});
    }
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

test('o reparo exibe a data proposta e exige uma conta conectada',()=>{
  const proposal = {repairableRemoteCount:1,repairableDateCount:3,repairDatePreview:[{before:'2025-00-20',after:'2025-12-20'}]};
  const nodes = render(proposal);
  assert.equal(nodes.get('#btn-cloud-repair').disabled,false);
  assert.equal(nodes.get('#cloud-repair-actions').classList.contains('hidden'),false);
  assert.match(nodes.get('#cloud-repair-hint').textContent,/20\/00\/2025 → 20\/12\/2025/);
  assert.match(nodes.get('#cloud-repair-hint').textContent,/cópia dos registros originais/);
  assert.match(nodes.get('#cloud-repair-hint').textContent,/as duas serão preservadas/);
  const loggedOut = render({...proposal,connected:false,hasRepairBackup:true});
  assert.equal(loggedOut.get('#cloud-repair-actions').classList.contains('hidden'),true);
  assert.equal(loggedOut.get('#btn-cloud-repair').disabled,true);
  assert.equal(loggedOut.get('#cloud-repair-hint').textContent,'');
  assert.equal(loggedOut.get('#btn-cloud-repair-backup').classList.contains('hidden'),true);
});

test('o botão de reparo aguarda a sincronização e mostra andamento explícito',()=>{
  const syncing = render({status:'syncing',repairableRemoteCount:1});
  assert.equal(syncing.get('#btn-cloud-repair').disabled,true);
  const repairing = render({status:'syncing',repairing:true,repairableRemoteCount:1,hasRepairBackup:true});
  assert.equal(repairing.get('#btn-cloud-repair').textContent,'Corrigindo datas…');
  assert.equal(repairing.get('#btn-cloud-repair-backup').disabled,true);
  assert.match(repairing.get('#cloud-repair-hint').textContent,/Aguarde a confirmação/);
});

test('a cópia anterior continua disponível depois que não há datas inválidas',()=>{
  const nodes = render({status:'synced',pendingCount:0,hasRepairBackup:true,repairableRemoteCount:0});
  assert.equal(nodes.get('#btn-cloud-repair').classList.contains('hidden'),true);
  assert.equal(nodes.get('#btn-cloud-repair-backup').classList.contains('hidden'),false);
  assert.equal(nodes.get('#btn-cloud-repair-backup').disabled,false);
  assert.match(nodes.get('#cloud-repair-hint').textContent,/Baixe o arquivo/);
});

test('o aviso padrão de pasta inválida não repete o mesmo motivo',()=>{
  const nodes = render({status:'error',invalidRemoteCount:1,error:'1 pasta(s) da nuvem têm dados inválidos e foram preservadas sem alterações. Confira essas pastas antes de sincronizá-las.'});
  assert.doesNotMatch(nodes.get('#cloud-queue-status').textContent,/Motivo:/);
  assert.match(nodes.get('#cloud-queue-status').textContent,/preservadas sem alterações/);
});
