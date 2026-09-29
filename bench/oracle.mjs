import {parseXml} from '@rgrove/parse-xml';
// Independent oracle: exact expected outputs for each edit, built from rgrove offsets.
const NEW_TEXT='EDITED';
export function targets(s){
  let d; try{ d=parseXml(s,{includeOffsets:true,preserveComments:true,preserveCdata:true,preserveDocumentType:true}); }catch(e){ return {error:e.message}; }
  const root=d.root; const out={};
  const els=(n)=>n.children.filter(c=>c.type==='element');
  const nl = s.includes('\r\n')?'\r\n':'\n';
  // walk
  function walk(n,path,cb){ els(n).forEach((c,i)=>{ const p=[...path,i]; cb(c,p,n); walk(c,p,cb); }); }
  // startTag scanning
  function startTag(el){
    let i=el.start+1+el.name.length; const attrs=[];
    const re=/(\s+)([^\s=\/>]+)(\s*=\s*)("([^"]*)"|'([^']*)')/y;
    for(;;){ re.lastIndex=i; const m=re.exec(s); if(!m)break; const vs=i+m[1].length+m[2].length+m[3].length+1;
      attrs.push({name:m[2],wsStart:i,start:i+m[1].length,end:i+m[0].length,vs,ve:vs+(m[5]??m[6]).length}); i+=m[0].length; }
    return attrs; }
  // setText / rename: first leaf with a single plain text child
  let done={};
  walk(root,[],(el,path,parent)=>{
    if(!done.text && el.children.length===1 && el.children[0].type==='text' && el.children[0].text.trim()){
      const t=el.children[0]; done.text=1;
      out.setText={path,expected:s.slice(0,t.start)+NEW_TEXT+s.slice(t.end)};
      // rename: open tag name & close tag name
      const closeIdx=s.lastIndexOf('</'+el.name,el.end);
      out.rename={path,newName:'renamed',expected:s.slice(0,el.start+1)+'renamed'+s.slice(el.start+1+el.name.length,closeIdx+2)+'renamed'+s.slice(closeIdx+2+el.name.length)};
    }
    if(!done.attr){ const a=startTag(el).find(a=>!/^xmlns(:|$)/.test(a.name)); if(a){ done.attr=1;
      out.setAttr={path,name:a.name,expected:s.slice(0,a.vs)+NEW_TEXT+s.slice(a.ve)};
      out.removeAttr={path,name:a.name,expected:s.slice(0,a.wsStart)+s.slice(a.end)}; } }
    if(!done.remove && parent===root){
      const ls=s.lastIndexOf('\n',el.start-1)+1; const pre=s.slice(ls,el.start);
      let le=s.indexOf('\n',el.end); const post=le<0?null:s.slice(el.end,le);
      if(/^[ \t]*$/.test(pre)&&post!==null&&/^[ \t\r]*$/.test(post)){ done.remove=1; out.removeElement={path,expected:s.slice(0,ls)+s.slice(le+1)}; }
    }
  });
  // insert: append <added>x</added> as last child of root, after last element child, own line, same indent
  const rc=els(root);
  if(rc.length){ const last=rc[rc.length-1]; const ls=s.lastIndexOf('\n',last.start-1)+1; const pre=s.slice(ls,last.start);
    const closeIdx=s.lastIndexOf('</'+root.name,root.end);
    const between=s.slice(last.end,closeIdx);
    if(/^[ \t]*$/.test(pre) && /^[ \t\r]*\n[ \t]*$/.test(between) && ls>0){
      out.insertElement={path:[],expected:s.slice(0,last.end)+nl+pre+'<added>x</added>'+s.slice(last.end)}; } }
  return out;
}
