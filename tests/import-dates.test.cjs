"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const ImportDates = require("../js/import-dates.js");
const row = (date = "", extra = {}) => ({ date, gen: false, sourceDocumentId: "document-a", ...extra });
const dates = rows => rows.map(item => item.date);

test("interpola sequências ascendentes e descendentes em dias UTC", () => {
  const asc = ImportDates.estimate([row("2026-01-01"), row(), row(), row("2026-01-10")]);
  assert.deepEqual(dates(asc), ["2026-01-01", "2026-01-04", "2026-01-07", "2026-01-10"]);
  const desc = ImportDates.estimate([row("2026-01-10"), row(), row(), row("2026-01-01")]);
  assert.deepEqual(dates(desc), ["2026-01-10", "2026-01-07", "2026-01-04", "2026-01-01"]);
  for (const inferred of [asc[1], asc[2], desc[1], desc[2]]) {
    assert.equal(inferred.dateEstimated, true); assert.equal(inferred.dateEstimate.method, "between");
  }
  assert.equal(asc[0].dateEstimated, undefined); assert.equal(asc[3].dateEstimated, undefined);
});

test("preserva extremos inclusivos quando há mais linhas que dias e não altera âncoras", () => {
  const same = ImportDates.estimate([row("2026-03-02"),row(),row(),row("2026-03-02")]);
  assert.deepEqual(dates(same), Array(4).fill("2026-03-02"));
  const near = ImportDates.estimate([row("2026-03-01"),row(),row(),row(),row("2026-03-02")]);
  for (const item of near.slice(1,-1)) {
    assert(item.date >= "2026-03-01" && item.date <= "2026-03-02"); assert.equal(item.dateEstimated, true);
  }
});

test("cruza mês, ano e fevereiro bissexto sem criar mês00 ou usar fuso local", () => {
  assert.deepEqual(dates(ImportDates.estimate([row("2025-12-30"),row(),row(),row("2026-01-02")])), ["2025-12-30","2025-12-31","2026-01-01","2026-01-02"]);
  assert.equal(ImportDates.estimate([row("2024-02-28"),row(),row("2024-03-01")])[1].date, "2024-02-29");
  assert.equal(ImportDates.estimate([row("2026-02-28"),row(),row("2026-03-02")])[1].date, "2026-03-01");
  assert.equal(ImportDates.estimate([row("0001-01-01"),row(),row("0001-01-03")])[1].date, "0001-01-02");
});

test("pontas recebem só a data da âncora real vizinha e ficam explicitamente aproximadas", () => {
  const result = ImportDates.estimate([row(),row(),row("2026-07-20"),row()]);
  assert.deepEqual(dates(result), Array(4).fill("2026-07-20"));
  assert.deepEqual(result[0].dateEstimate, { method: "nearest", nextDate: "2026-07-20" });
  assert.deepEqual(result[3].dateEstimate, { method: "nearest", previousDate: "2026-07-20" });
  assert.equal(result[2].dateEstimated, undefined);
});

test("cada intervalo usa seus vizinhos locais mesmo quando ordem de datas muda", () => {
  const result = ImportDates.estimate([row("2026-01-01"),row(),row("2026-01-05"),row(),row("2026-01-03")]);
  assert.deepEqual(dates(result), ["2026-01-01","2026-01-03","2026-01-05","2026-01-04","2026-01-03"]);
});

test("sem datas observadas não usa hoje, datas inválidas, ano zero ou estimativas antigas", () => {
  const result = ImportDates.estimate([row(),row("2026-02-31"),row("0000-01-01"),row("2025-00-20"),row("2026-01-02", { dateEstimated: true, dateEstimate: { method:"nearest", previousDate:"2026-01-02" } })]);
  assert.deepEqual(dates(result), ["","2026-02-31","0000-01-01","2025-00-20",""]);
  assert(result.every(item => !item.dateEstimated && !item.dateEstimate));
});

test("projeções não servem de âncora, não recebem inferência e não distorcem interpolação", () => {
  const generated = row("2030-01-01", { gen: true });
  const result = ImportDates.estimate([row("2026-01-01"),generated,row(),row("2026-01-03"),row("",{gen:true})]);
  assert.equal(result[2].date,"2026-01-02"); assert.deepEqual(result[1],generated);
  assert.equal(result[4].date,""); assert.equal(result[4].dateEstimated,undefined);
  assert.equal(ImportDates.estimate([generated,row()])[1].date,"");
});

test("mesmo nome de arquivo não permite usar datas de outro sourceDocumentId", () => {
  const result = ImportDates.estimate([row("2026-01-01",{src:"extrato.pdf"}),row("",{sourceDocumentId:"document-b",src:"extrato.pdf"}),row("2026-01-03",{src:"extrato.pdf"})]);
  assert.equal(result[1].date,""); assert.equal(result[1].dateEstimated,undefined);
  const missingId = ImportDates.estimate([row("2026-01-01"),row("",{sourceDocumentId:""}),row("",{sourceDocumentId:undefined})]);
  assert.deepEqual(dates(missingId),["2026-01-01","",""]);
});

test("ordem documental explícita tem prioridade e saída preserva a ordem original", () => {
  const result = ImportDates.estimate([row("2026-01-10",{order:3}),row("",{order:2}),row("2026-01-01",{order:0}),row("",{order:1})]);
  assert.deepEqual(dates(result),["2026-01-10","2026-01-07","2026-01-01","2026-01-04"]);
  assert.deepEqual(result.map(item=>item.order),[3,2,0,1]);
});

test("página física e índice reconstroem ordem quando todos possuem coordenadas", () => {
  const result=ImportDates.estimate([row("2026-01-05",{sourcePage:2,sourceIndex:0}),row("",{sourcePage:1,sourceIndex:2}),row("2026-01-01",{sourcePage:1,sourceIndex:1})]);
  assert.equal(result[1].date,"2026-01-03");
  assert.deepEqual(result[1].dateEstimate,{method:"between",previousDate:"2026-01-01",nextDate:"2026-01-05"});
});

test("novo trecho recalcula nearest como between sem usar a estimativa como âncora", () => {
  const first = ImportDates.estimate([row("2026-01-01"),row()]);
  assert.equal(first[1].date,"2026-01-01"); assert.equal(first[1].dateEstimate.method,"nearest");
  const complete = ImportDates.estimate([...first,row("2026-01-07")]);
  assert.equal(complete[1].date,"2026-01-04"); assert.equal(complete[1].dateEstimate.method,"between");
  const reestimated = ImportDates.estimate(complete);
  assert.deepEqual(reestimated,complete);
});

test("datas manuais passam a ser observadas ao remover o marcador", () => {
  const manual=row("2026-01-04");
  const result=ImportDates.estimate([row("2026-01-01"),manual,row(),row("2026-01-10")]);
  assert.equal(result[1].date,"2026-01-04");assert.equal(result[1].dateEstimated,undefined);
  assert.equal(result[2].date,"2026-01-07");
});

test("helper é puro e preserva valores, evidência, seleção e metadados desconhecidos", () => {
  const review=Object.freeze(["Conferir data"]), custom=Object.freeze({keep:true});
  const input=Object.freeze([Object.freeze(row("2026-10-01")),Object.freeze(row("",{review,amount:15,on:false,custom,sourceEvidence:"linha original"})),Object.freeze(row("2026-10-03"))]);
  const before=JSON.stringify(input), result=ImportDates.estimate(input);
  assert.equal(JSON.stringify(input),before);assert.notEqual(result,input);assert.notEqual(result[1],input[1]);
  assert.equal(result[1].amount,15);assert.equal(result[1].on,false);assert.equal(result[1].custom,custom);
  assert.equal(result[1].review,review);assert.equal(result[1].sourceEvidence,"linha original");
  assert.deepEqual(ImportDates.estimate(null),[]);
});

test("merge existente preserva indicador enquanto recebe outra transação da nuvem", () => {
  const CloudMerge = require("../js/cloud-merge.js");
  const observed = { id:"observed001",date:"2026-01-01",amount:10,desc:"Observada",type:"despesa",currency:"BRL" };
  const estimated = { ...observed,id:"estimated001",date:"2026-01-03",dateEstimated:true,dateEstimate:{method:"between",previousDate:"2026-01-01",nextDate:"2026-01-05"} };
  const base={id:"folder001",updatedAt:"2026-01-01T00:00:00Z",transactions:[observed]};
  const local={...base,transactions:[observed,estimated]};
  const remote={...base,updatedAt:"2026-01-02T00:00:00Z",whatsappRevision:1,transactions:[observed,{...observed,id:"wa_external"}]};
  const result=CloudMerge.merge(base,local,remote);
  assert.equal(result.ok,true);assert.equal(result.dataset.transactions.length,3);
  assert.deepEqual(result.dataset.transactions.find(item=>item.id===estimated.id),estimated);
  assert.deepEqual(local.transactions,[observed,estimated]);
});
