"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {c6Invoices,isC6InvoicePayable} = require("../js/installment-schedule.js");

const movement = (id, more={}) => ({
  id, account:"C6", type:"despesa", currency:"BRL", amount:20,
  desc:"Mercado", date:"2026-11-05", ...more,
});
const october = {billClosingDate:"2026-10-29",billDueDate:"2026-11-05",billDateObserved:true};

test("o formulário usa o mesmo primeiro ciclo que o agrupamento, também para um lançamento novo",() => {
  const history = [movement("observado",{...october,billClosingDate:"2026-10-26"})];
  assert.equal(isC6InvoicePayable(movement("novo",{date:"2026-10-26"}),history),false);
  assert.equal(isC6InvoicePayable(movement("novo",{date:"2026-10-27"}),history),true);
  assert.equal(isC6InvoicePayable(movement("conta",{c6Section:"transfer"}),history),false);
  assert.equal(isC6InvoicePayable(movement("reembolso",{c6Section:"card",type:"receita"}),history),false);
});

test("abertura após fechamento, vencimento seguinte e separação entre cartão, conta e outros bancos",() => {
  const rows = [
    movement("loja", {amount:96.5}),
    movement("total", {account:"C6 · Conta/débito", amount:4000}),
    movement("pix", {desc:"Pix enviado a fornecedor"}),
    movement("transf", {account:"Banco C6", desc:"Transferência recebida",type:"receita"}),
    movement("extrato", {c6Section:"transfer"}),
    movement("outro", {account:"Itaú"}),
    movement("salario", {type:"receita",desc:"Salário"}),
    movement("cashback", {type:"receita",desc:"Cashback acumulado"}),
    movement("passado", {...october,date:"2026-07-20",installment:"4/8",amount:50}),
    movement("pagto", {creditKind:"card_payment",type:"receita",amount:50}),
    movement("pagto2", {type:"receita",c6Section:"card",desc:"Inclusão de Pagamento",amount:50}),
    movement("juros", {date:"2026-11-29",desc:"Ajuste de juros",amount:6}),
    movement("estorno", {desc:"Estorno da tarifa",amount:6,type:"receita"}),
    movement("ajuste", {desc:"Crédito especial",c6Section:"card",amount:8.77,type:"receita"}),
    movement("depois", {date:"2026-11-30",amount:13}),
  ];
  const [oct,nov,dec] = c6Invoices(rows);
  assert.equal(oct.month,"2026-10"); assert.equal(oct.dueDateObserved,true);
  assert.deepEqual(nov,{
    month:"2026-11", startDate:"2026-10-30", closingDate:"2026-11-29",
    dueDate:"2026-12-05",closingDateObserved:false,dueDateObserved:false,totals:{BRL:87.73},
    count:4,transactionIds:["loja","juros","estorno","ajuste"],
  });
  assert.equal(dec.startDate,"2026-11-30"); assert.equal(dec.dueDate,"2027-01-05");
  assert.deepEqual(dec.totals,{BRL:13}); assert.equal(nov.totals.BRL,c6Invoices(rows.filter(t=>t.id!=="pagto"))[1].totals.BRL);
});

test("o fechamento real define o mês e ajusta também a data das compras manuais",() => {
  const printed = {billClosingDate:"2026-11-26", billDueDate:"2026-12-07", billDateObserved:true};
  const predicted = {billClosingDate:"2026-11-29", billDueDate:"2026-12-05", billDateObserved:false};
  const rows = [
    movement("legado", {...october,date:"2026-10-29"}),
    movement("previsto", {...predicted,installment:"4/7",date:"2026-09-30",amount:32.49}),
    movement("impresso", {...printed,installment:"2/5", date:"2026-09-10",amount:164.9}),
    movement("nova", {date:"2026-11-27",amount:6}),
    movement("ultima", {date:"2026-11-26",amount:2}),
    movement("antecipada", {billClosingDate:"2027-01-28",billDueDate:"2027-02-05",billDateObserved:false,
      date:"2026-11-15",advance:{scheduledDate:"2027-01-11",paidDate:"2026-11-15"},amount:70}),
  ];
  const [,nov,dec] = c6Invoices(rows);
  assert.deepEqual(nov.totals,{BRL:269.39}); assert.equal(nov.closingDate,"2026-11-26");
  assert.equal(nov.dueDate,"2026-12-07"); assert.equal(nov.dueDateObserved,true);
  assert.equal(dec.startDate,"2026-11-27"); assert.equal(dec.closingDate,"2026-12-26");
  assert.deepEqual(dec.totals,{BRL:6}); assert.equal(dec.dueDate,"2027-01-07");
  assert.deepEqual(c6Invoices(rows.slice().reverse()).map(i=>[i.month,i.dueDate,i.totals]),[...c6Invoices(rows)].map(i=>[i.month,i.dueDate,i.totals]));
});

test("moedas separadas, precisão de centavos e tokens, edição e exclusão recalculam a mesma fatura",() => {
  const rows = [
    movement("primeira", {amount:0.1,account:"C6 Bank"}),
    movement("segunda", {amount:0.2,account:"C6 · Crédito",paymentStatus:"pending"}),
    movement("usd", {currency:"USD",amount:0.39}),
    movement("token", {currency:"USDC",amount:1.000001}),
    movement("paraguai", {currency:"PYG",amount:10000}),
    movement("estorno", {currency:"USD",amount:0.4,type:"receita",desc:"Reembolso"}),
  ];
  assert.deepEqual(c6Invoices(rows)[0].totals,{BRL:0.3,USD:-0.01,USDC:1.000001,PYG:10000});
  assert.equal(c6Invoices(rows.filter(t=>t.id!=="segunda"))[0].totals.BRL,0.1);
  assert.equal(c6Invoices(rows.map(t=>t.id==="primeira"?{...t,amount:2.4}:t))[0].totals.BRL,2.6);
});

test("ciclos respeitam fevereiro, a virada do ano e um vencimento avulso impresso",() => {
  const rows = [
    movement("dez", {date:"2026-12-30"}),
    movement("fev", {date:"2027-02-28"}),
    movement("vencimento", {date:"2026-09-01",billDueDate:"2027-05-08",billDateObserved:true}),
  ];
  const [jan,fev,abr] = c6Invoices(rows);
  assert.equal(jan.month,"2027-01"); assert.equal(jan.startDate,"2026-12-30"); assert.equal(jan.dueDate,"2027-02-05");
  assert.equal(fev.closingDate,"2027-02-28"); assert.equal(fev.dueDate,"2027-03-05");
  assert.equal(abr.month,"2027-04"); assert.equal(abr.dueDate,"2027-05-08"); assert.equal(abr.dueDateObserved,true);
});

test("melhor dia abre nova fatura vazia mesmo antes de pagar a antiga; fechamento impresso prevalece",() => {
  const last = movement("impresso",{date:"2026-10-29",...october,cardBestPurchaseDay:28});
  const november = movement("novembro",{date:"2026-11-27"});
  const rows = [last,november];
  const noRollover = c6Invoices(rows,"2026-11-27");
  assert.deepEqual(noRollover.map(i=>i.month),["2026-10","2026-11"]);
  assert.equal(noRollover[1].startDate,"2026-10-30"); assert.equal(noRollover[1].closingDate,"2026-11-27");
  const december = c6Invoices(rows,"2026-11-28").at(-1);
  assert.equal(december.startDate,"2026-11-28"); assert.equal(december.month,"2026-12");
  assert.equal(december.closingDateObserved,false); assert.equal(december.dueDate,"2027-01-05");
  assert.deepEqual(december.totals,{BRL:0}); assert.equal(december.count,0);
  const actual = c6Invoices([...rows,movement("conferida",{billClosingDate:"2026-11-29",billDueDate:"2026-12-04",billDateObserved:true})],"2026-11-28");
  assert.equal(actual.at(-1).month,"2026-11"); assert.equal(actual.at(-1).closingDateObserved,true);
  assert.equal(actual.at(-1).dueDate,"2026-12-04");
  const bank = movement("banco",{c6Section:"transfer",...october});
  assert.deepEqual(c6Invoices([bank],"2026-11-28"),[]);
});
