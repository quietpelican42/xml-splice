import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DOMParser } from '@xmldom/xmldom';
import { EditError, XmlDocument } from '../src/index.ts';
import type { Element } from '../src/index.ts';
import { assertWellFormed, canon, corpusDir, corpusFiles, rng } from './helpers.ts';

const SYNTHETIC: string[] = [
  `<?xml version="1.0" encoding="UTF-8"?>\n<!-- c -->\n<project xmlns="urn:p" xmlns:x="urn:x">\n  <a x:k="1" b='2'>text &amp; more</a>\n  <b><![CDATA[<raw>]]></b>\n  <c></c>\n  <d/>\n  <e>\n    <f>1</f>\n    <f>2</f>\n    <!-- in -->\n    <g h="&quot;q&quot;"\n       i='j'/>\n  </e>\n</project>\n`,
  `<r>\r\n\t<a k="v">1</a>\r\n\t<b>\r\n\t\t<c/>\r\n\t</b>\r\n</r>\r\n`,
  `﻿<r><a>1</a><b x="1"/><c>2</c></r>`,
  `<r>\n  <a>x</a> <b>y</b>\n  <c/>\n</r>`,
  `<?xml version="1.0"?>\n<!DOCTYPE r>\n<r>\n  <a>&#65;&#x42;</a>\n  <b p="&#67;"/>\n</r>\n`,
];

const TEXTS = ['', 'x', ' padded ', 'a<b', 'a&b', 'q"q', "q'q", 'a>b', ']]>', 'line1\nline2', 'tab\there', 'é€😀', 'a\rb', '&amp;'];
const NAMES = ['n', 'item', 'a-b', 'x.y', '_z', 'é'];

function allElements(d: XmlDocument): Element[] {
  const out: Element[] = [];
  d.walk((e) => void out.push(e));
  return out;
}

function pathOf(d: XmlDocument, el: Element): number[] {
  const p: number[] = [];
  for (let e = el; e.parent; e = e.parent) p.unshift(d.elements(e.parent).indexOf(e));
  return p;
}

function domAt(root: any, p: number[]): any {
  let e = root;
  for (const i of p) e = [...e.childNodes].filter((c: any) => c.nodeType === 1)[i];
  return e;
}

function runOne(src: string, seed: number): { ops: number } {
  const rand = rng(seed);
  const pick = <T>(a: T[]): T => a[Math.floor(rand() * a.length)]!;
  const d = XmlDocument.parse(src);
  const doc = new DOMParser().parseFromString(src.replace(/^﻿/, ''), 'text/xml');
  const els = allElements(d);
  const dom = new Map(els.map((e) => [e, domAt(doc.documentElement, pathOf(d, e))]));
  const regions: [number, number][] = [];
  let applied = 0;
  const inserted = new Set<Element>(); // setText after insert has edit-order-dependent meaning, so the DOM model skips it
  const nOps = 1 + Math.floor(rand() * 6);
  for (let k = 0; k < nOps; k++) {
    const el = pick(els);
    const de = dom.get(el);
    let top = de;
    while (top && top.parentNode) top = top.parentNode;
    if (top !== doc) continue; // already detached from the DOM by an earlier removal
    const kind = pick(['setText', 'setAttr', 'setAttr', 'removeAttr', 'insert', 'remove', 'rename']);
    try {
      if (kind === 'setText') {
        if (inserted.has(el)) continue;
        const v = pick(TEXTS);
        d.setText(el, v);
        de.textContent = v;
        regions.push([el.start, el.end]);
      } else if (kind === 'setAttr') {
        const existing = el.attributes.filter((a) => !a.name.startsWith('xmlns'));
        const name = existing.length && rand() < 0.6 ? pick(existing).name : pick(['k1', 'k2', 'data-x']);
        const v = pick(TEXTS);
        d.setAttr(el, name, v);
        de.setAttribute(name, v.replace(/\r\n/g, '\n'));
        regions.push([el.start, el.startTagEnd]);
      } else if (kind === 'removeAttr') {
        const existing = el.attributes.filter((a) => !a.name.startsWith('xmlns'));
        if (!existing.length) continue;
        const a = pick(existing);
        d.removeAttr(el, a.name);
        de.removeAttribute(a.name);
        regions.push([el.start, el.startTagEnd]);
      } else if (kind === 'insert') {
        const nm = pick(NAMES);
        const v = pick(TEXTS);
        d.insertElement(el, { name: nm, text: v });
        inserted.add(el);
        const ne = doc.createElement(nm);
        if (v) ne.appendChild(doc.createTextNode(v));
        const kids = [...de.childNodes].filter((c: any) => c.nodeType === 1);
        const last = kids.at(-1);
        if (last) de.insertBefore(ne, last.nextSibling);
        else de.appendChild(ne);
        regions.push([el.start, el.end]);
      } else if (kind === 'remove') {
        if (el === d.root) continue;
        d.removeElement(el);
        de.parentNode.removeChild(de);
        regions.push([el.parent!.start, el.parent!.end]);
      } else {
        const nm = pick(NAMES);
        d.renameElement(el, nm);
        const ne = doc.createElement(nm);
        while (de.firstChild) ne.appendChild(de.firstChild);
        for (const a of [...de.attributes]) ne.setAttribute(a.name, a.value);
        de.parentNode.replaceChild(ne, de);
        dom.set(el, ne);
        regions.push([el.start, el.end]);
      }
      applied++;
    } catch (e) {
      if (!(e instanceof EditError)) throw e;
    }
  }
  const out = d.toString();
  assertWellFormed(out);

  // 1. Every byte outside the pending edit ranges is unchanged.
  const body = src.replace(/^﻿/, '');
  let rebuilt = '';
  let pos = 0;
  for (const e of d.pendingEdits) {
    assert.ok(e.start >= pos, 'edits overlap');
    rebuilt += body.slice(pos, e.start) + e.text;
    pos = e.end;
  }
  rebuilt += body.slice(pos);
  assert.equal((src.startsWith('﻿') ? '﻿' : '') + rebuilt, out);

  // 2. Each edit range lies inside the region of the element the op targeted.
  for (const e of d.pendingEdits) {
    assert.ok(regions.some(([s, t]) => e.start >= s && e.end <= t), `edit ${e.start}-${e.end} lies outside every targeted region`);
  }

  // 3. The result means what the same edits mean on a DOM.
  const reparsed = new DOMParser().parseFromString(out.replace(/^﻿/, ''), 'text/xml');
  if (canon(reparsed) !== canon(doc)) assert.fail(`semantic mismatch (seed ${seed})\n${process.env.XS_DEBUG ? out + '\n' + canon(reparsed) + '\n' + canon(doc) : ''}`);

  // 4. The result is itself parseable by this library and round-trips.
  assert.equal(XmlDocument.parse(out).toString(), out);
  return { ops: applied };
}

test('property: random edits on synthetic documents stay local, well-formed and semantically right', () => {
  let ops = 0;
  for (let s = 1; s <= 1500; s++) ops += runOne(SYNTHETIC[s % SYNTHETIC.length]!, s).ops;
  console.log(`synthetic: 1500 runs, ${ops} accepted edits`);
  assert.ok(ops > 2000);
});

const files = corpusFiles();
const skip = files.length < 30 ? 'corpus not downloaded: run `npm run corpus`' : false;
test('property: random edits on the real-world corpus', { skip }, () => {
  let ops = 0;
  let runs = 0;
  for (const [i, f] of files.entries()) {
    const src = fs.readFileSync(path.join(corpusDir, f), 'utf8');
    for (let s = 0; s < 12; s++) {
      ops += runOne(src, 100_000 + i * 100 + s).ops;
      runs++;
    }
  }
  console.log(`corpus: ${runs} runs, ${ops} accepted edits`);
  assert.ok(ops > runs);
});
