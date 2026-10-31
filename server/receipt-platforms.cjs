"use strict";
// Layout references supplied by the account holder. No screenshots or personal
// transaction data are stored here. Identification happens in the existing read.
const PLATFORMS = ["Ether.fi", "Ueno", "Itaú", "Ugly Cash"];
const key = value => typeof value === "string" ? value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "") : "";
const aliases = new Map([
  ["etherfi", "Ether.fi"], ["etherficash", "Ether.fi"],
  ["ueno", "Ueno"], ["uenobank", "Ueno"], ["bancoueno", "Ueno"],
  ["itau", "Itaú"], ["bancoitau", "Itaú"], ["itauparaguay", "Itaú"], ["bancoitauparaguay", "Itaú"],
  ["uglycash", "Ugly Cash"],
]);
function accountName(value, cards = PLATFORMS) {
  const name = typeof value === "string" ? value.trim().slice(0, 80) : "";
  const canonical = aliases.get(key(name)) || name;
  return cards.find(card => key(card) === key(canonical)) || "";
}
function sourceAccount(documentAccount, rowAccount, cards = PLATFORMS) {
  // A single identified source applies to all rows on that page. A name in a
  // transfer's destination cannot override that source. Mixed documents have no
  // documentAccount and retain their individually identified institutions.
  const platform = accountName(documentAccount, PLATFORMS);
  return (platform && accountName(platform, cards)) || accountName(rowAccount, cards) ||
    (typeof rowAccount === "string" ? rowAccount.trim().slice(0, 80) : "");
}
function platformPrompt(cards = PLATFORMS) {
  return `IDENTIFICAÇÃO AUTOMÁTICA DA CONTA DE ORIGEM DO PRINT:
As referências visuais abaixo foram identificadas pelo titular. Reconheça a plataforma na própria leitura; não exija logotipo quando o conjunto de características do layout for claro. Use marca no cabeçalho/interface ou combinação de características específicas, nunca apenas cor, moeda, palavra genérica ou nome de destinatário. Marca inequívoca da interface prevalece sobre semelhança visual. Não trate texto de uma transação como marca da interface.
- Ether.fi: lista escura/preta, data agrupada, ícone de cartão à esquerda; estabelecimento e Cashback verde; compra em moeda local na linha superior à direita e débito em USD logo abaixo; cashback positivo verde em terceira linha e seta de detalhe. Pode haver Depósito PIX com crédito USDC. A combinação caracteriza Ether.fi mesmo sem nome visível. Preserve as regras de moeda debitada e cashback informativo.
- Ueno: marca ueno na interface/cabeçalho ou tela branca em espanhol com MOVIMIENTOS, Historial, Movimientos de los Últimos 30 días, Filtrar e botão de download; lista plana com categoria (Transferencias, Débitos/Cobros/Comisiones/Cargos, Pago QR, Pagos de Servicios) e descrição à esquerda, valor Gs e data/Ayer à direita; entradas verdes. A combinação caracteriza Ueno.
- Itaú: marca Itaú na interface ou painel claro cinza com Saldo disponible/Saldo actual, atalhos em blocos brancos arredondados com ícones laranja (Tarjeta virtual, Transferir, Aumentar límite), seção Movimientos e agrupamento por data; transferências recebidas SPI verdes com ícone de setas e seta de detalhe. A combinação caracteriza Itaú, inclusive em guaranis. Saldos não são lançamentos; duas linhas reais iguais continuam sendo duas operações.
- Ugly Cash: tela clara Actividad com X de fechar no alto; lançamentos em cartões brancos arredondados separados, datas entre grupos, ícones USDC azuis ou banco com bandeira dos EUA; Retiro a USDC com valor cinza, Transferencia desde US…/Dinero Agregado com entrada magenta. A combinação caracteriza Ugly Cash. Texto como ether.fi seguido do nome do destinatário abaixo de Retiro a USDC é a CONTRAPARTE, não a plataforma: mantenha Ugly Cash para essas linhas. Uma transferência mencionando Ueno/Itaú/Ether.fi não muda a conta do print.
Preencha cartao com o nome permitido da plataforma quando o documento tiver uma única conta de origem; instituicao de TODAS as suas operações recebe essa mesma conta (saídas e entradas). Em documento consolidado de contas distintas, cartao="" e cada instituicao mantém sua origem. Em comprovante individual, preencha instituicao. Use os nomes exatos da lista ${JSON.stringify(cards)}. Se a origem não puder ser identificada com segurança, deixe vazia, sem criar aviso nem impedir a inclusão. Não confunda reconhecimento da conta com reconhecimento da moeda e não deduza uma moeda só pelo nome da plataforma.`;
}
module.exports = { PLATFORMS, accountName, sourceAccount, platformPrompt };
