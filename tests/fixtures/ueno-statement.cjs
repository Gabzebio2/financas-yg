// Entirely fictitious operations. No user document or personal data is embedded.
const {PDFDocument,StandardFonts}=require('../../lib/pdf-lib.min.js');
const money=n=>(n<0?'-':'')+Math.abs(n).toLocaleString('de-DE');
async function fixture(){
 const rows=Array.from({length:59},(_,i)=>({date:`${String(30-Math.floor(i/2)).padStart(2,'0')}/09/2026`,time:i%2?'10:00':'11:00',reference:String(900000+Math.floor(i/2)),description:i%8===0?'Devolucion compra TESTE':'Compra ficticia '+(i+1),amount:i%8===0?300000+i*1111:-1000-i*117}));
 let balance=1000000;for(const r of [...rows].reverse()){balance+=r.amount;r.balance=balance;}
 const pages=[];
 for(let p=0;p<2;p++){
  const doc=await PDFDocument.create(),page=doc.addPage([595,842]),font=await doc.embedFont(StandardFonts.Helvetica);
  const put=(s,x,y,size=8)=>page.drawText(s,{x,y,size,font});
  put('ueno bank S.A. - DOCUMENTO FICTICIO DE TESTE',30,810,10);
  put('Reporte de Movimientos',30,790,10);
  if(!p){put('Moneda: Guaranies',30,770,10);put('Saldo final '+money(rows[0].balance),400,750);}
  const h=p?750:720;
  ['Fecha','Comprobante','Concepto','Importe','Saldo'].forEach((s,i)=>put(s,[30,125,185,445,530][i],h));
  const selected=rows.slice(p?32:0,p?59:32);
  selected.forEach((r,i)=>{const y=h-25-i*18;put(r.date+' '+r.time,30,y);put(r.reference,125,y);put(r.description,185,y);const a=money(r.amount),b=money(r.balance);put(a,490-font.widthOfTextAtSize(a,8),y);put(b,575-font.widthOfTextAtSize(b,8),y);});
  if(p)put('Saldo inicial 1.000.000',440,h-25-selected.length*18);
  put('ueno bank S.A. - Pagina '+(p+1)+' de 2',30,50);
  pages.push(await doc.saveAsBase64());
 }
 return {rows,pages,opening:1000000,closing:rows[0].balance};
}
module.exports={fixture};
