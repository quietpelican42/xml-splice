import {XmlDocument, XmlTextNode} from 'xmldoc';
import {XMLParser, XMLBuilder} from 'fast-xml-parser';
import xmljs from 'xml-js';
import {DOMParser, XMLSerializer} from '@xmldom/xmldom';
import {fromXml} from 'xast-util-from-xml';
import {toXml} from 'xast-util-to-xml';
import * as h2 from 'htmlparser2';
import render from 'dom-serializer';
import xmlpoke from 'xmlpoke';
import * as txml from 'txml';

const at=(root,path,kids)=>path.reduce((e,i)=>kids(e)[i],root);
export const adapters=[];

// xmldoc: parse, mutate tree, toString (only serializer it offers)
for(const [vn,vo] of [['preserveWhitespace',{preserveWhitespace:true}],['compressed+preserveWhitespace',{compressed:true,preserveWhitespace:true}],['default',{}]]) adapters.push({name:'xmldoc ('+vn+')',
  parse:s=>new XmlDocument(s), ser:d=>d.toString(vo),
  ops:{
    setText:(d,p)=>{at(d,p,e=>e.children.filter(c=>c.type==='element')).children=[new XmlTextNode('EDITED')]},
    setAttr:(d,p,n)=>{at(d,p,e=>e.children.filter(c=>c.type==='element')).attr[n]='EDITED'},
    removeAttr:(d,p,n)=>{delete at(d,p,e=>e.children.filter(c=>c.type==='element')).attr[n]},
    insertElement:(d)=>{d.children.push(new XmlDocument('<added>x</added>'))},
    removeElement:(d,p)=>{const par=at(d,p.slice(0,-1),e=>e.children.filter(c=>c.type==='element'));const el=at(d,p,e=>e.children.filter(c=>c.type==='element'));par.children.splice(par.children.indexOf(el),1)},
    rename:(d,p,_,n)=>{at(d,p,e=>e.children.filter(c=>c.type==='element')).name=n},
  }});

// fast-xml-parser preserveOrder, options chosen for maximum fidelity
const fxpOpts={preserveOrder:true,ignoreAttributes:false,attributeNamePrefix:'@_',trimValues:false,parseTagValue:false,parseAttributeValue:false,commentPropName:'#comment',cdataPropName:'#cdata',processEntities:false,ignoreDeclaration:false,ignorePiTags:false,allowBooleanAttributes:true};
const fxpKids=e=>{const k=Object.keys(e).find(k=>k!==':@');return e[k]};
const fxpIsEl=e=>{const k=Object.keys(e).find(k=>k!==':@');return k&&!k.startsWith('#')&&!k.startsWith('?')};
const fxpEls=arr=>arr.filter(fxpIsEl);
const fxpNav=(d,p)=>{let list=d,el=null;for(const i of p){el=fxpEls(list)[i];list=fxpKids(el)}return {el,list}};
for(const sup of [false,true]) adapters.push({name:'fast-xml-parser preserveOrder (suppressEmptyNode='+sup+')',
  parse:s=>new XMLParser(fxpOpts).parse(s),
  ser:d=>new XMLBuilder({...fxpOpts,format:false,suppressEmptyNode:sup,suppressBooleanAttributes:false}).build(d),
  ops:{
    setText:(d,p)=>{const {el}=fxpNav(d,p);const k=Object.keys(el).find(k=>k!==':@');el[k]=[{'#text':'EDITED'}]},
    setAttr:(d,p,n)=>{const {el}=fxpNav(d,p);el[':@']['@_'+n]='EDITED'},
    removeAttr:(d,p,n)=>{const {el}=fxpNav(d,p);delete el[':@']['@_'+n]},
    insertElement:(d)=>{const r=fxpEls(d)[0];fxpKids(r).push({added:[{'#text':'x'}]})},
    removeElement:(d,p)=>{const {list}=fxpNav(d,p.slice(0,-1));const el=fxpEls(list)[p.at(-1)];list.splice(list.indexOf(el),1)},
    rename:(d,p,_,n)=>{const {el}=fxpNav(d,p);const k=Object.keys(el).find(k=>k!==':@');const v=el[k];delete el[k];el[n]=v},
  }, rootIsList:true});

adapters.push({name:'xml-js (non-compact, spaces captured)',
  parse:s=>xmljs.xml2js(s,{compact:false,captureSpacesBetweenElements:true,ignoreDeclaration:false}),
  ser:d=>xmljs.js2xml(d,{spaces:0,fullTagEmptyElement:false}),
  ops:(()=>{const els=e=>(e.elements||[]).filter(c=>c.type==='element');const nav=(d,p)=>p.reduce((e,i)=>els(e)[i],{elements:d.elements});
    return {
    setText:(d,p)=>{nav(d,[0,...p]).elements=[{type:'text',text:'EDITED'}]},
    setAttr:(d,p,n)=>{nav(d,[0,...p]).attributes[n]='EDITED'},
    removeAttr:(d,p,n)=>{delete nav(d,[0,...p]).attributes[n]},
    insertElement:(d)=>{nav(d,[0]).elements.push({type:'element',name:'added',elements:[{type:'text',text:'x'}]})},
    removeElement:(d,p)=>{const par=nav(d,[0,...p.slice(0,-1)]);const el=els(par)[p.at(-1)];par.elements.splice(par.elements.indexOf(el),1)},
    rename:(d,p,_,n)=>{nav(d,[0,...p]).name=n},
  }})()});

adapters.push({name:'@xmldom/xmldom (DOMParser + XMLSerializer)',
  parse:s=>new DOMParser({onError(){}}).parseFromString(s,'text/xml'), ser:d=>new XMLSerializer().serializeToString(d),
  ops:(()=>{const els=e=>[...e.childNodes].filter(c=>c.nodeType===1);const nav=(d,p)=>p.reduce((e,i)=>els(e)[i],d.documentElement);
    return {
    setText:(d,p)=>{nav(d,p).textContent='EDITED'},
    setAttr:(d,p,n)=>{nav(d,p).setAttribute(n,'EDITED')},
    removeAttr:(d,p,n)=>{nav(d,p).removeAttribute(n)},
    insertElement:(d)=>{const e=d.createElement('added');e.appendChild(d.createTextNode('x'));d.documentElement.appendChild(e)},
    removeElement:(d,p)=>{const el=nav(d,p);el.parentNode.removeChild(el)},
    rename:(d,p,_,n)=>{const el=nav(d,p);const nn=d.createElement(n);while(el.firstChild)nn.appendChild(el.firstChild);for(const a of [...el.attributes])nn.setAttribute(a.name,a.value);el.parentNode.replaceChild(nn,el)},
  }})()});

for(const cee of [false,true]) adapters.push({name:'xast-util-from-xml + to-xml (closeEmptyElements='+cee+')',
  parse:s=>fromXml(s), ser:d=>toXml(d,{closeEmptyElements:cee}),
  ops:(()=>{const els=e=>e.children.filter(c=>c.type==='element');const nav=(d,p)=>p.reduce((e,i)=>els(e)[i],{children:d.children});
    return {
    setText:(d,p)=>{nav(d,[0,...p]).children=[{type:'text',value:'EDITED'}]},
    setAttr:(d,p,n)=>{nav(d,[0,...p]).attributes[n]='EDITED'},
    removeAttr:(d,p,n)=>{delete nav(d,[0,...p]).attributes[n]},
    insertElement:(d)=>{nav(d,[0]).children.push({type:'element',name:'added',attributes:{},children:[{type:'text',value:'x'}]})},
    removeElement:(d,p)=>{const par=nav(d,[0,...p.slice(0,-1)]);const el=els(par)[p.at(-1)];par.children.splice(par.children.indexOf(el),1)},
    rename:(d,p,_,n)=>{nav(d,[0,...p]).name=n},
  }})()});

adapters.push({name:'htmlparser2 (xmlMode) + dom-serializer',
  parse:s=>h2.parseDocument(s,{xmlMode:true,recognizeCDATA:true,recognizeSelfClosing:true,decodeEntities:false}), ser:d=>render(d,{xmlMode:true,decodeEntities:false,selfClosingTags:true}),
  ops:(()=>{const els=e=>e.children.filter(c=>c.type==='tag');const root=d=>d.children.find(c=>c.type==='tag');
    const nv=(d,p)=>p.reduce((e,i)=>els(e)[i],root(d));
    return {
    setText:(d,p)=>{nv(d,p).children[0].data='EDITED'},
    setAttr:(d,p,n)=>{nv(d,p).attribs[n]='EDITED'},
    removeAttr:(d,p,n)=>{delete nv(d,p).attribs[n]},
    insertElement:(d)=>{const r=root(d);const e=h2.parseDocument('<added>x</added>',{xmlMode:true}).children[0];e.parent=r;r.children.push(e)},
    removeElement:(d,p)=>{const el=nv(d,p);el.parent.children.splice(el.parent.children.indexOf(el),1)},
    rename:(d,p,_,n)=>{nv(d,p).name=n},
  }})()});

// xmlpoke wraps old xmldom + xpath: only whole-string round trip is comparable without xpath translation
adapters.push({name:'xmlpoke (no-op round trip only)', roundTripOnly:true,
  rt:s=>xmlpoke(s,function(xml){})});
adapters.push({name:'txml (parse + stringify, round trip only)', roundTripOnly:true,
  rt:s=>txml.stringify(txml.parse(s,{keepComments:true,keepWhitespace:true}))});

// wrap fxp ops to descend from the root element
for(const a of adapters){ if(a.rootIsList){ for(const k of Object.keys(a.ops)){ const f=a.ops[k]; a.ops[k]=(d,p,...r)=>f(d,[0,...p],...r);} } }
// fxp insertElement ignores the path; fix it to use root

// xml-splice itself, built from ../dist (run `npm run build` first)
try {
  const { XmlDocument } = await import('../dist/index.js');
  const el = (d, p) => p.reduce((e, i) => d.elements(e)[i], d.root);
  adapters.unshift({ name: 'xml-splice',
    parse: (s) => XmlDocument.parse(s), ser: (d) => d.toString(),
    ops: {
      setText: (d, p) => d.setText(el(d, p), 'EDITED'),
      setAttr: (d, p, n) => d.setAttr(el(d, p), n, 'EDITED'),
      removeAttr: (d, p, n) => void d.removeAttr(el(d, p), n),
      insertElement: (d) => d.insertElement(d.root, { name: 'added', text: 'x' }),
      removeElement: (d, p) => d.removeElement(el(d, p)),
      rename: (d, p, _, n) => d.renameElement(el(d, p), n),
    } });
} catch { console.error('dist/ not built: xml-splice row skipped'); }
