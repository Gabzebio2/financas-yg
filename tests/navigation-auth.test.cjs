const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../js/navigation.js'), 'utf8');
const renderer = source.match(/  function refreshAuthOptions\(\) \{[\s\S]*?(?=\n  document.addEventListener\("fyg:authoptions")/)[0];
function render(options) {
  const nodes = new Map();
  const querySelector = id => { if (!nodes.has(id)) { const classes = new Set(); nodes.set(id, {disabled:false,textContent:'',classList:{toggle:(name,on)=>on?classes.add(name):classes.delete(name),contains:name=>classes.has(name)}}); } return nodes.get(id); };
  vm.runInNewContext(renderer+'\nrefreshAuthOptions();', {Cloud:{getAuthOptions:()=>({passkeysEnabled:true,passkeysSupported:true,busy:false,...options})}, document:{querySelector}, Date});
  return nodes;
}
test('backend desativado não oferece biometria como se estivesse funcional',()=>{
  const n = render({passkeysEnabled:false});
  assert.equal(n.get('#btn-cloud-passkey-login').disabled,true);
  assert.equal(n.get('#btn-cloud-passkey-register').disabled,true);
  assert.equal(n.get('#btn-cloud-magic-link').disabled,false);
  assert.match(n.get('#cloud-passkey-hint').textContent,/ainda não foram ativadas/);
});
test('navegador incompatível e consulta indisponível mantêm senha e link disponíveis',()=>{
  for (const options of [{passkeysSupported:false},{passkeysEnabled:null}]) {
    const n = render(options);
    assert.equal(n.get('#btn-cloud-passkey-login').disabled,true);
    assert.equal(n.get('#btn-cloud-magic-link').disabled,false);
    assert.equal(n.get('#btn-cloud-signin').disabled,false);
  }
});
test('cerimônia em andamento evita iniciar outro método e mostra gesto esperado',()=>{
  const n = render({busy:true,busyAction:'passkey-register'});
  assert.equal(n.get('#btn-cloud-signin').disabled,true);
  assert.equal(n.get('#btn-cloud-passkey-register').disabled,true);
  assert.match(n.get('#btn-cloud-passkey-register').textContent,/Confirme no seu aparelho/);
});
test('cooldown bloqueia somente reenvio de link sem bloquear a senha',()=>{
  const n = render({linkCooldownUntil:Date.now()+60000});
  assert.equal(n.get('#btn-cloud-magic-link').disabled,true);
  assert.equal(n.get('#btn-cloud-signin').disabled,false);
});
test('recurso habilitado explica alternativas à biometria e condição experimental',()=>{
  const n = render({});
  assert.equal(n.get('#btn-cloud-passkey-login').disabled,false);
  assert.match(n.get('#cloud-passkey-hint').textContent,/PIN/);
  assert.match(n.get('#cloud-passkey-hint').textContent,/experimental/);
});

test('cadastro desativado não é oferecido e senha em andamento fica explícita',()=>{
  const n = render({signupsAllowed:false,busy:true,busyAction:'password-login'});
  assert.equal(n.get('#btn-cloud-signup').classList.contains('hidden'),true);
  assert.equal(n.get('#btn-cloud-signin').textContent,'Entrando…');
  assert.equal(n.get('#cloud-email').disabled,true);
  assert.equal(n.get('#btn-cloud-forgot').disabled,true);
});

test('nova senha só pode ser salva em uma recuperação válida',()=>{
  assert.equal(render({recoveryActive:false}).get('#btn-cloud-newpass-save').disabled,true);
  assert.equal(render({recoveryActive:true}).get('#btn-cloud-newpass-save').disabled,false);
});
