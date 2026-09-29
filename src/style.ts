import type { ElementNode } from './nodes.ts';
import type { EscapeStyle } from './escape.ts';

export interface DocStyle extends EscapeStyle {
  indentUnit: string;
  quote: '"' | "'";
}

/** Whitespace before `el` on its line, or null when something else precedes it. */
export function lineIndent(src: string, pos: number): string | null {
  let k = pos;
  while (k > 0) {
    const c = src.charCodeAt(k - 1);
    if (c === 10 || c === 13) break;
    if (c !== 32 && c !== 9) return null;
    k--;
  }
  return src.slice(k, pos);
}

export function detectStyle(src: string, root: ElementNode, latin1: boolean): DocStyle {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let i = src.indexOf('\n') < 0 && src.indexOf('\r') < 0 ? src.length : 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (c === 13) {
      if (src.charCodeAt(i + 1) === 10) {
        crlf++;
        i++;
      } else cr++;
    } else if (c === 10) lf++;
  }
  const newline = crlf > lf && crlf >= cr ? '\r\n' : cr > lf && cr > crlf ? '\r' : '\n';

  let dq = 0;
  let sq = 0;
  let escapeGt = false;
  const tally = new Map<string, number>();
  let tabs = 0;
  const work: ElementNode[] = [root];
  while (work.length) {
    const el = work.pop()!;
    for (const a of el.attributes) {
      if (a.quote === '"') dq++;
      else sq++;
      if (!escapeGt && a.raw.includes('&gt;')) escapeGt = true;
    }
    const ind = lineIndent(src, el.start);
    if (ind !== null && el.parent) {
      const pInd = lineIndent(src, el.parent.start);
      if (pInd !== null && ind.length > pInd.length && ind.startsWith(pInd)) {
        const unit = ind.slice(pInd.length);
        tally.set(unit, (tally.get(unit) ?? 0) + 1);
      }
      if (ind.startsWith('\t')) tabs++;
    }
    for (const c of el.children) {
      if (c.type === 'element') work.push(c);
      else if (c.type === 'text' && !escapeGt && c.raw.includes('&gt;')) escapeGt = true;
    }
  }
  let indentUnit = tabs > 0 && tally.size === 0 ? '\t' : '  ';
  let best = 0;
  for (const [u, k] of tally) {
    if (k > best || (k === best && u.length < indentUnit.length)) {
      best = k;
      indentUnit = u;
    }
  }
  return { newline, indentUnit, quote: sq > dq ? "'" : '"', escapeGt, latin1 };
}
