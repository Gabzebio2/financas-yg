"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {classify, buildHistory, isCategoryOnlyWarning} = require("../js/transaction-categories.js");
const categories = ["Essencial", "Mercado", "Lazer", "Saúde", "Transporte", "Receita", "Viagem", "Outros", "Projeto Azul"];
const guess = (desc, type="despesa", options={}) => classify({desc,type}, {categories,...options});

test("aviso de categoria resolvido pode sair, enquanto avisos mistos continuam visíveis", () => {
  for (const reason of ["Confira a categoria.", "Categoria incerta: confira a classificação.", "Categoria fora da lista", "Não foi possível identificar a categoria"]) {
    assert.equal(isCategoryOnlyWarning(reason), true, reason);
  }
  for (const reason of ["Confira a categoria e a descrição", "Categoria incerta pois a linha está cortada",
    "Categoria ou conta de origem", "Categoria e quantidade", "Moeda indefinida", "", null]) {
    assert.equal(isCategoryOnlyWarning(reason), false, reason);
  }
});

test("reconhece finalidade, abreviações e estabelecimentos das transações locais", () => {
  for (const [expected, descriptions] of [
    ["Mercado", ["Mercado de bairro", "MP * Supermercado Primavera", "Pedidos Ya - Mercado", "Compra en Superseis"]],
    ["Lazer", ["Passeio na praia", "Entrada Playa San José", "Ingresso cinema"]],
    ["Saúde", ["FARMACIA PRECO POPULAR", "DROGAO SUPER FILIAL 79", "remédios", "convênio", "Plan de Salud familiar", "NEOFARMA CAMPINAS MANI"]],
    ["Transporte", ["Posto de gasolina da praia", "AUTO POSTO CAMPINAS", "Estación de servicio", "Posto Shell", "PSJT COMERCIO DE COMBU"]],
    ["Essencial", ["FERREX PARAGUAY", "Feria Asunción", "Compra en Feria de Asunción"]],
  ]) {
    for (const desc of descriptions) assert.equal(guess(desc, "despesa", {suggested:"Outros"}), expected, desc);
  }
  assert.equal(classify({descricao:"Medicamentos",direcao:"enviado"}, {categories:categories.map(name=>({name}))}), "Saúde");
  assert.equal(guess("Farmácia da Praia"), "Saúde");
  assert.equal(guess("Hotel Praia Grande"), "Viagem");
  for (const desc of ["Mercado Pago", "MERCADOPAGO*João", "Mercado Livre", "Tarifa mercado de câmbio"]) {
    assert.equal(guess(desc), "Outros", desc);
  }
  assert.equal(guess("Mercado Pago*Farmacia Central"), "Saúde");
  assert.equal(guess("Mercado Pago","despesa",{suggested:"Mercado"}), "Outros");
  assert.equal(guess("Posto de Saúde"), "Saúde");
});

test("usa direção e natureza do crédito sem alterar os campos financeiros", () => {
  const tx = Object.freeze({descricao:"Transferencia recibida SPI",direcao:"recebido",valor:399.99,moeda:"USD"});
  assert.equal(classify(tx, {categories,suggested:"Essencial"}), "Receita");
  assert.equal(guess("Pix recebido de Farmácia Central","receita"), "Receita");
  const oldGuess = buildHistory([{type:"receita",desc:"Pix recebido de Farmácia Central",category:"Saúde"}]);
  assert.equal(guess("Pix recebido de Farmácia Central","receita",{history:oldGuess}), "Receita");
  assert.equal(guess("Reembolso de farmácia","receita"), "Saúde");
  assert.equal(guess("Inclusão de Pagamento","receita"), "Outros");
  assert.equal(guess("Crédito lançado","receita",{suggested:"Receita",history:buildHistory([])}), "Receita");
  assert.equal(classify({tipo:"receita",descricao:"Crédito lançado",creditKind:"card_payment"},{categories,suggested:"Receita"}), "Outros");
  assert.equal(guess("Cashback acumulado","receita"), "Outros");
  assert.equal(guess("Resgate de cashback","receita"), "Receita");
  assert.equal(guess("Reintegro","receita",{suggested:"Receita"}), "Outros");
  assert.equal(guess("Transferência entre minhas contas","receita"), "Outros");
  assert.equal(guess("La Esquina","despesa",{suggested:"Projeto Azul"}), "Projeto Azul");
  assert.equal(guess("La Esquina","despesa",{suggested:"Receita"}), "Outros");
  assert.equal(guess("La Esquina","despesa",{suggested:"Categoria inexistente"}), "Outros");
});

test("escolha explícita e correção de comerciante valem somente na mesma pasta e direção", () => {
  const previous = [
    {type:"despesa",desc:"MP*Farmácia do Centro - Parcela 1/3",category:"Projeto Azul",categoryEdited:true},
    {type:"despesa",desc:"Farmácia do Centro",category:"Saúde"},
    {type:"despesa",desc:"Pix enviado",category:"Projeto Azul",categoryEdited:true},
    {type:"despesa",desc:"Loja 177",category:"Projeto Azul"},
    {type:"despesa",desc:"Feria Asunción",category:"Outros"},
  ];
  const history = buildHistory(previous);
  assert.equal(guess("Farmácia do Centro","despesa",{history}), "Projeto Azul");
  assert.equal(guess("Farmácia do Centro","despesa",{history,preferred:"Lazer"}), "Lazer");
  assert.equal(guess("Farmácia do Centro","receita",{history}), "Receita");
  assert.equal(guess("Farmácia do Centro"), "Saúde");
  assert.equal(guess("Pix enviado","despesa",{history}), "Outros");
  assert.equal(guess("Loja 177","despesa",{history}), "Projeto Azul");
  assert.equal(guess("Loja 1777","despesa",{history}), "Outros");
  assert.equal(guess("Feria Asunción","despesa",{history}), "Essencial");
  const contradictory=buildHistory([...previous, {type:"despesa",desc:"Farmácia do Centro",category:"Viagem",categoryEdited:true}]);
  assert.equal(guess("Farmácia do Centro","despesa",{history:contradictory}), "Saúde");
  assert.equal(guess("Comprovante","receita",{preferred:"Salário"}), "Receita");
  assert.equal(guess("Ferrex","despesa",{preferred:"Outros"}), "Outros");
  assert.equal(classify({descricao:"Mercado Central",tipo:"despesa"}, {categories:["Feira", "Outros"],suggested:"Feira"}), "Feira");
});
