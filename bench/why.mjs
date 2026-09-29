import fs from 'node:fs'; import {adapters} from './adapters.mjs';
const dir=new URL('../.corpus/', import.meta.url).pathname; const files=fs.readdirSync(dir);
for(const a of adapters){ if(a.roundTripOnly&&!a.rt)continue; const cnt={};
  for(const f of files){ const s=fs.readFileSync(dir+f,'utf8'); let o; try{o=a.rt?a.rt(s):a.ser(a.parse(s));}catch(e){cnt['throws: '+e.message.slice(0,40)]=(cnt['throws: '+e.message.slice(0,40)]||0)+1;continue}
    if(o===s)continue; let i=0;while(i<s.length&&s[i]===o[i])i++;
    const k=JSON.stringify(s.slice(Math.max(0,i-3),i+12))+' -> '+JSON.stringify(o.slice(Math.max(0,i-3),i+12)); cnt[k]=(cnt[k]||0)+1; }
  console.log('##',a.name); Object.entries(cnt).sort((x,y)=>y[1]-x[1]).slice(0,4).forEach(([k,v])=>console.log('  ',v,k)); }
