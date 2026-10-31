"use strict";
const {readPage}=require('../server/document-reader.cjs');
const URL='https://mhgagjhwsjjjwwvopjgu.supabase.co';
const PUBLIC='sb_publishable_fB3B_MW3VgJBcJpUbN1wvg_1Glbr2r5';
module.exports=async(req,res)=>{
 res.setHeader('Cache-Control','no-store');
 if(req.method!=='POST')return res.status(405).json({error:'method'});
 const token=req.headers.authorization;
 if(typeof token!=='string'||!token.startsWith('Bearer '))return res.status(401).json({error:'login_required'});
 try {
  const u=await fetch(URL+'/auth/v1/user',{headers:{apikey:PUBLIC,Authorization:token},signal:AbortSignal.timeout(5000),redirect:'error'});
  if(!u.ok)return res.status(u.status===401||u.status===403?401:503).json({error:'auth_indisponivel'});
  const body=typeof req.body==='string'?JSON.parse(req.body):req.body;
  const image=body?.image,context=body?.documentContext;
  if(!image||!['application/pdf','image/jpeg','image/png','image/webp'].includes(image.media_type)||typeof image.data!=='string'||image.data.length>4200000||!image.data.length||!/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)||!context||!Number.isInteger(context.totalPages)||!Number.isInteger(context.pageStart)||context.pageStart!==context.pageEnd||context.pageStart<1||context.pageStart>context.totalPages||context.totalPages>120)return res.status(400).json({error:'invalid_page'});
  const names=a=>Array.isArray(a)?a.filter(v=>typeof v==='string'&&v.trim()).map(v=>v.slice(0,80)).slice(0,40):[];
  const first=body.first||null;
  if(first&&(!Array.isArray(first.itens)||first.itens.length>500||JSON.stringify(first).length>500000))return res.status(400).json({error:'invalid_draft'});
  const key=process.env.OPENAI_API_KEY||process.env.OPENAI_KEYZAO;
  if(!key)return res.status(503).json({error:'configuracao_ia'});
  const pageContext={pageStart:context.pageStart,pageEnd:context.pageEnd,totalPages:context.totalPages};
  const sourceHeader=body.sourceHeader;
  if(sourceHeader!==undefined&&(image.media_type!=='application/pdf'||context.pageStart<=1||typeof sourceHeader!=='string'||!sourceHeader.length||sourceHeader.length>262144||sourceHeader.length+image.data.length>4200000||!/^[A-Za-z0-9+/]*={0,2}$/.test(sourceHeader)))return res.status(400).json({error:'invalid_header'});
  const mode=body.mode==='quick'&&image.media_type!=='application/pdf'&&!first?'quick':'full';
  return res.status(200).json(await readPage({image,categories:names(body.categories),cards:names(body.cards),context:pageContext,first,sourceHeader,mode},key));
 }catch(e){return res.status(502).json({error:['saldo_ia','configuracao_ia','one_page_required','page_too_dense','resposta_incompleta'].includes(e.message)?e.message:e.name==='TimeoutError'?'tempo_ia':'leitura_indisponivel'});}
};
