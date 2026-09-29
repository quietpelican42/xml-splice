import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser } from '@xmldom/xmldom';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const corpusDir = path.join(root, '.corpus');

export function corpusFiles(): string[] {
  if (!fs.existsSync(corpusDir)) return [];
  return fs.readdirSync(corpusDir).sort();
}

export const corpusHint = 'corpus not downloaded: run `npm run corpus` (fetches pinned third-party files into .corpus/, gitignored)';

/** Strict well-formedness check with a real parser; throws on any warning, error or fatal error. */
export function assertWellFormed(xml: string): void {
  const problems: string[] = [];
  const handler = (level: string, msg: string): void => {
    problems.push(`${level}: ${msg}`);
  };
  new DOMParser({ onError: handler }).parseFromString(xml.replace(/^﻿/, ''), 'text/xml');
  if (problems.length) throw new Error(`not well-formed per @xmldom/xmldom: ${problems[0]}`);
}

/** Canonical form for semantic comparison: sorted attributes, merged and trimmed text, no whitespace-only text. */
export function canon(node: any): string {
  switch (node.nodeType) {
    case 9:
      return [...node.childNodes].map(canon).join('');
    case 1: {
      const attrs = [...node.attributes].map((a: any) => `${a.name}=${JSON.stringify(a.value)}`).sort().join(' ');
      const kids: string[] = [];
      let buf = '';
      const flush = (): void => {
        if (buf.trim() !== '') kids.push(JSON.stringify(buf.trim()));
        buf = '';
      };
      for (const c of node.childNodes) {
        if (c.nodeType === 3 || c.nodeType === 4) buf += c.data;
        else {
          flush();
          kids.push(canon(c));
        }
      }
      flush();
      return `<${node.nodeName} ${attrs}>${kids.join('')}</>`;
    }
    case 8:
      return `<!--${node.data}-->`;
    case 7:
      return `<?${node.target} ${node.data}?>`;
    default:
      return '';
  }
}

/** Small deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
