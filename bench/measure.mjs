import fs from 'node:fs';
import {targets} from './oracle.mjs';
import {adapters} from './adapters.mjs';
const dir=new URL('../.corpus/', import.meta.url).pathname; const files=fs.readdirSync(dir).filter(f=>fs.statSync(dir+f).isFile());
const OPS=['setText','setAttr','removeAttr','insertElement','removeElement','rename'];
const oracle={}; let skipped=0;
for(const f of files){ const s=fs.readFileSync(dir+f,'utf8'); oracle[f]=[s,targets(s)]; if(oracle[f][1].error){skipped++;console.error('oracle skip',f,oracle[f][1].error)} }
console.log('files',files.length,'oracle-unparseable',skipped);
const res=[];
const BOM='\uFEFF';
const strip=(s,fix)=>fix?s.replace(/^\uFEFF/,''):s;
const rebom=(o,s,fix)=>fix&&s.startsWith(BOM)?BOM+o:o;
for(const fix of [false,true]) for(const a of adapters){
  let rt=0,rtn=0;
  for(const f of files){ const [s]=oracle[f]; rtn++; try{ const o=rebom(a.rt?a.rt(strip(s,fix)):a.ser(a.parse(strip(s,fix))),s,fix); if(o===s)rt++; }catch{} }
  const row={name:a.name+(fix?' +BOM restored by caller':''),roundTrip:`${rt}/${rtn}`};
  if(!a.roundTripOnly){ let ct=0,tt=0; for(const op of OPS){ let c=0,t=0;
    for(const f of files){ const [s,T]=oracle[f]; const tg=T[op]; if(!tg)continue; t++;
      try{ const d=a.parse(strip(s,fix)); a.ops[op](d,tg.path,tg.name,tg.newName); const o=rebom(a.ser(d),s,fix); if(o===tg.expected)c++; }catch{} }
    row[op]=`${c}/${t}`; ct+=c; tt+=t; }
    row.total=`${ct}/${tt} = ${(100*ct/tt).toFixed(1)}%`; }
  res.push(row); }
console.table(res); fs.writeFileSync(new URL('./results.json', import.meta.url),JSON.stringify(res,null,1));
