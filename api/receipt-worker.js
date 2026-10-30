'use strict';
const {timingSafeEqual}=require('node:crypto');
const {readPage}=require('../server/document-reader.cjs');
module.exports=async(req,res)=>{
 res.setHeader('Cache-Control','no-store');
 if(req.method!=='POST')return res.status(405).json({error:'method'});
 const expected=process.env.RECEIPT_WORKER_SECRET;
 const got=typeof req.headers.authorization==='string'?req.headers.authorization:'';
 const wanted='Bearer '+expected;
 if(!expected||Buffer.byteLength(got)!==Buffer.byteLength(wanted)||!timingSafeEqual(Buffer.from(got),Buffer.from(wanted)))return res.status(401).json({error:'unauthorized'});
 try{
  const body=typeof req.body==='string'?JSON.parse(req.body):req.body;
  const image=body?.image,c=body?.documentContext,first=body?.first||null;
  if(!image||!['application/pdf','image/jpeg','image/png','image/webp'].includes(image.media_type)||typeof image.data!=='string'||image.data.length>4200000||!image.data.length||!/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)||!c||!Number.isInteger(c.pageStart)||!Number.isInteger(c.totalPages)||c.pageStart!==c.pageEnd||c.pageStart<1||c.pageStart>c.totalPages||c.totalPages>120)return res.status(400).json({error:'invalid_page'});
  if(first&&(!Array.isArray(first.itens)||first.itens.length>500||JSON.stringify(first).length>1000000))return res.status(400).json({error:'invalid_draft'});
  const key=process.env.OPENAI_API_KEY||process.env.OPENAI_KEYZAO;if(!key)return res.status(503).json({error:'configuracao_ia'});
  const names=v=>Array.isArray(v)?v.filter(x=>typeof x==='string').slice(0,40).map(x=>x.slice(0,80)):[];
  return res.status(200).json(await readPage({image,categories:names(body.categories),cards:names(body.cards),context:c,first,mode:body.mode==='quick'&&!first&&image.media_type!=='application/pdf'?'quick':'full',timeoutMs:105000},key));
 }catch(e){return res.status(502).json({error:['saldo_ia','configuracao_ia','resposta_incompleta','page_too_dense'].includes(e.message)?e.message:e.name==='TimeoutError'?'tempo_ia':'leitura_indisponivel'});}
};
