import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DOMParser } from '@xmldom/xmldom';
import { UnsupportedEncodingError, XmlDocument, XmlSyntaxError, tokenize } from '../src/index.ts';
import type { ElementNode } from '../src/index.ts';
import { corpusDir, corpusFiles, rng } from './helpers.ts';

const PIECES = [
  '<', '>', '/', '=', '"', "'", '&', ';', '!', '-', '--', '?', '[', ']', ']]>', '<![CDATA[', '<!--', '-->', '<?', '?>', '<!DOCTYPE', '&amp;', '&#x41;', '&#0;', '&nope;',
  'a', 'b', 'xmlns', 'xmlns:p', 'p:', ':', ' ', '\n', '\r\n', '\t', '<a>', '</a>', '<a/>', '<b x="1">', '</b>', '\u0000', '\ud800', '﻿', 'é', '😀', '<?xml version="1.0"?>',
];

function structurallySound(src: string, root: ElementNode): void {
  const stack: ElementNode[] = [root];
  while (stack.length) {
    const el = stack.pop()!;
    assert.ok(el.start >= 0 && el.end <= src.length && el.start < el.end);
    assert.equal(src[el.start], '<');
    assert.equal(src[el.end - 1], '>');
    if (el.selfClosing) {
      assert.equal(el.children.length, 0);
      assert.ok(src.slice(el.closerStart, el.end).trimStart().startsWith('/>'));
      continue;
    }
    let pos = el.startTagEnd;
    for (const c of el.children) {
      assert.equal(c.start, pos, 'children tile the content');
      assert.ok(c.end > c.start);
      pos = c.end;
      if (c.type === 'element') stack.push(c);
    }
    assert.equal(pos, el.endTagStart, 'content ends at the end tag');
    assert.ok(src.startsWith('</' + el.name, el.endTagStart));
    assert.match(src.slice(el.endTagStart, el.end), /^<\/[^\s>]+\s*>$/);
    for (const a of el.attributes) {
      assert.ok(a.start >= el.nameEnd && a.end <= el.startTagEnd);
      assert.equal(src[a.quoteStart], a.quote);
      assert.equal(src[a.valueEnd], a.quote);
      assert.equal(src.slice(a.valueStart, a.valueEnd), a.raw);
    }
  }
}

function tryParse(src: string): boolean {
  try {
    const r = tokenize(src);
    structurallySound(src, r.root);
    assert.equal(XmlDocument.parse(src).toString(), src);
    return true;
  } catch (e) {
    assert.ok(e instanceof XmlSyntaxError, `unexpected ${(e as Error)?.name}: ${(e as Error)?.message}\ninput: ${JSON.stringify(src)}`);
    assert.ok(e.offset >= 0 && e.offset <= src.length, 'offset inside the input');
    assert.ok(e.line >= 1 && e.column >= 1);
    assert.ok(e.message.length > 10);
    return false;
  }
}

test('fuzz: random token soup never crashes and errors are XmlSyntaxError with positions', () => {
  const rand = rng(42);
  let accepted = 0;
  const N = 40_000;
  for (let i = 0; i < N; i++) {
    let s = '';
    const n = Math.floor(rand() * 30);
    for (let k = 0; k < n; k++) s += PIECES[Math.floor(rand() * PIECES.length)];
    if (tryParse(s)) accepted++;
  }
  console.log(`token soup: ${N} inputs, ${accepted} well-formed, ${N - accepted} rejected with XmlSyntaxError`);
});

test('fuzz: wrapped random content (deeper into the parser)', () => {
  const rand = rng(7);
  let accepted = 0;
  const N = 30_000;
  for (let i = 0; i < N; i++) {
    let s = '';
    const n = Math.floor(rand() * 20);
    for (let k = 0; k < n; k++) s += PIECES[Math.floor(rand() * PIECES.length)];
    if (tryParse(`<r>${s}</r>`)) accepted++;
  }
  console.log(`wrapped soup: ${N} inputs, ${accepted} well-formed`);
  assert.ok(accepted > 100, 'the generator must reach the accept path');
});

test('fuzz: random bytes fail with a typed error', () => {
  const rand = rng(99);
  for (let i = 0; i < 5000; i++) {
    const b = Buffer.alloc(Math.floor(rand() * 40));
    for (let k = 0; k < b.length; k++) b[k] = Math.floor(rand() * 256);
    try {
      XmlDocument.parse(b);
    } catch (e) {
      assert.ok(e instanceof XmlSyntaxError || e instanceof UnsupportedEncodingError, `unexpected ${(e as Error).name}`);
    }
  }
});

const files = corpusFiles();
const skip = files.length < 30 ? 'corpus not downloaded: run `npm run corpus`' : false;

test('fuzz: mutated real files (truncate, splice, delete, duplicate) never crash', { skip }, () => {
  const rand = rng(2024);
  let accepted = 0;
  let total = 0;
  for (const f of files) {
    const src = fs.readFileSync(path.join(corpusDir, f), 'utf8').replace(/^﻿/, '');
    for (let i = 0; i < 60; i++) {
      const at = Math.floor(rand() * src.length);
      const len = Math.floor(rand() * 20);
      let m: string;
      switch (i % 4) {
        case 0:
          m = src.slice(0, at);
          break;
        case 1:
          m = src.slice(0, at) + src.slice(at + len);
          break;
        case 2:
          m = src.slice(0, at) + PIECES[Math.floor(rand() * PIECES.length)] + src.slice(at);
          break;
        default:
          m = src.slice(0, at + len) + src.slice(at);
      }
      total++;
      if (tryParse(m)) accepted++;
    }
  }
  console.log(`mutated corpus: ${total} inputs, ${accepted} still well-formed`);
});

test('differential: everything accepted here is also accepted by @xmldom/xmldom (strict) on mutated corpus and soup', { skip }, () => {
  const rand = rng(5);
  let both = 0;
  let onlyUs = 0;
  const examples: string[] = [];
  const strict = (s: string): boolean => {
    let bad = false;
    new DOMParser({ onError: () => void (bad = true) }).parseFromString(s, 'text/xml');
    return !bad;
  };
  const inputs: string[] = [];
  for (const f of files.slice(0, 40)) {
    const src = fs.readFileSync(path.join(corpusDir, f), 'utf8').replace(/^﻿/, '');
    for (let i = 0; i < 40; i++) {
      const at = Math.floor(rand() * src.length);
      inputs.push(i % 2 ? src.slice(0, at) + src.slice(at + 1 + Math.floor(rand() * 5)) : src.slice(0, at) + PIECES[Math.floor(rand() * PIECES.length)] + src.slice(at));
    }
  }
  for (let i = 0; i < 6000; i++) {
    let s = '';
    for (let k = 0; k < 12; k++) s += PIECES[Math.floor(rand() * PIECES.length)];
    inputs.push(`<r>${s}</r>`);
  }
  for (const s of inputs) {
    let ours = true;
    try {
      tokenize(s);
    } catch {
      ours = false;
    }
    if (!ours) continue;
    if (strict(s)) both++;
    else {
      onlyUs++;
      if (examples.length < 3) examples.push(JSON.stringify(s.slice(0, 120)));
    }
  }
  console.log(`differential: ${both} accepted by both, ${onlyUs} accepted only here; examples: ${examples.join(' | ')}`);
  assert.equal(onlyUs, 0, `accepted here but rejected by xmldom: ${examples.join(' | ')}`);
});

test('fuzz: pathological shapes stay fast and do not overflow the stack', () => {
  const t0 = Date.now();
  const depth = 200_000;
  const deep = '<a>'.repeat(depth) + '</a>'.repeat(depth);
  const r = tokenize(deep);
  assert.equal(r.root.name, 'a');
  assert.throws(() => tokenize('<a>'.repeat(depth)), XmlSyntaxError);
  let attrs = '<a';
  for (let i = 0; i < 20_000; i++) attrs += ` a${i}="v"`;
  assert.equal(tokenize(attrs + '/>').root.attributes.length, 20_000);
  assert.throws(() => tokenize('<a x="' + 'y'.repeat(1_000_000)), XmlSyntaxError);
  assert.throws(() => tokenize('<!--' + '-'.repeat(100_000)), XmlSyntaxError);
  assert.ok(Date.now() - t0 < 5000, 'pathological inputs take well under 5s');
});
