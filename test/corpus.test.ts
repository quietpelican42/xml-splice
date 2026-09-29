import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { targets } from '../bench/oracle.mjs';
import type { Target } from '../bench/oracle.mjs';
import { XmlDocument } from '../src/index.ts';
import type { Element } from '../src/index.ts';
import { assertWellFormed, corpusDir, corpusFiles, corpusHint } from './helpers.ts';

const files = corpusFiles();
const skip = files.length < 30 ? corpusHint : false;
if (skip) console.warn(`SKIPPED corpus tests: ${skip}`);

const OPS = ['setText', 'setAttr', 'removeAttr', 'insertElement', 'removeElement', 'rename'] as const;

function at(d: XmlDocument, p: number[]): Element {
  return p.reduce((e, i) => d.elements(e)[i]!, d.root);
}

function apply(d: XmlDocument, op: (typeof OPS)[number], t: Target): void {
  const el = at(d, t.path);
  switch (op) {
    case 'setText':
      return d.setText(el, 'EDITED');
    case 'setAttr':
      return d.setAttr(el, t.name!, 'EDITED');
    case 'removeAttr':
      d.removeAttr(el, t.name!);
      return;
    case 'insertElement':
      return d.insertElement(el, { name: 'added', text: 'x' });
    case 'removeElement':
      return d.removeElement(el);
    case 'rename':
      return d.renameElement(el, t.newName!);
  }
}

function measure(transform: (s: string) => string): Record<string, [number, number]> {
  const tally: Record<string, [number, number]> = { roundTrip: [0, 0] };
  for (const op of OPS) tally[op] = [0, 0];
  for (const f of files) {
    const bytes = fs.readFileSync(path.join(corpusDir, f));
    const src = transform(bytes.toString('utf8'));
    const buf = Buffer.from(src, 'utf8');
    tally.roundTrip![1]++;
    if (Buffer.compare(Buffer.from(XmlDocument.parse(buf).toBuffer()), buf) === 0 && XmlDocument.parse(src).toString() === src) tally.roundTrip![0]++;
    const T = targets(src);
    for (const op of OPS) {
      const t = T[op];
      if (!t) continue;
      tally[op]![1]++;
      const d = XmlDocument.parse(buf);
      apply(d, op, t);
      const out = d.toString();
      if (out === t.expected) {
        assertWellFormed(out);
        tally[op]![0]++;
      } else {
        console.error(`MISMATCH ${op} ${f}`);
      }
    }
  }
  return tally;
}

function check(tally: Record<string, [number, number]>): void {
  for (const [k, [ok, total]] of Object.entries(tally)) {
    assert.ok(total > 0, `${k}: no applicable files`);
    assert.equal(ok, total, `${k}: ${ok}/${total} clean`);
  }
}

test('corpus: round trip is byte-identical and all six edit types are exact', { skip }, () => {
  const tally = measure((s) => s);
  console.log('corpus results (clean/applicable):', JSON.stringify(tally));
  check(tally);
});

test('corpus converted to CRLF: same guarantees', { skip }, () => {
  check(measure((s) => s.replace(/\r?\n/g, '\r\n')));
});

test('corpus converted to tabs-for-indent and LF-only: same guarantees', { skip }, () => {
  check(measure((s) => s.replace(/\r\n/g, '\n').replace(/^( {2})+/gm, (m) => '\t'.repeat(m.length / 2))));
});
