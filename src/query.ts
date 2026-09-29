import { decodeRefs } from './decode.ts';
import { QuerySyntaxError } from './errors.ts';
import type { ElementNode } from './nodes.ts';

/** Decoded text of an element and all its descendants (text and CDATA). */
export function textContent(el: ElementNode): string {
  let out = '';
  for (const c of el.children) {
    if (c.type === 'text') out += decodeRefs(c.raw);
    else if (c.type === 'cdata') out += c.value;
    else if (c.type === 'element') out += textContent(c);
  }
  return out;
}

type Pred =
  | { kind: 'index'; n: number }
  | { kind: 'attr'; name: string; value: string | null }
  | { kind: 'child'; name: string; value: string | null }
  | { kind: 'text'; value: string };

interface Step {
  descendant: boolean;
  name: string;
  preds: Pred[];
}

export interface CompiledPath {
  absolute: boolean;
  steps: Step[];
}

class Reader {
  s: string;
  i = 0;
  constructor(s: string) {
    this.s = s;
  }
  err(msg: string): never {
    throw new QuerySyntaxError(`${msg} at position ${this.i} in path "${this.s}"`);
  }
  ws(): void {
    while (this.s[this.i] === ' ') this.i++;
  }
  name(): string {
    const m = /^(\{[^}]*\})?[^\s/\[\]="'@{}]+|^\*/.exec(this.s.slice(this.i));
    if (!m) this.err('expected a name');
    this.i += m[0].length;
    return m[0];
  }
  str(): string {
    const q = this.s[this.i];
    if (q !== '"' && q !== "'") this.err('expected a quoted string');
    const e = this.s.indexOf(q, this.i + 1);
    if (e < 0) this.err('unterminated string');
    const v = this.s.slice(this.i + 1, e);
    this.i = e + 1;
    return v;
  }
}

const cache = new Map<string, CompiledPath>();

export function compilePath(path: string): CompiledPath {
  const hit = cache.get(path);
  if (hit) return hit;
  const r = new Reader(path);
  const steps: Step[] = [];
  let absolute = false;
  let descendant = false;
  if (path.startsWith('//')) {
    descendant = true;
    r.i = 2;
  } else if (path.startsWith('/')) {
    absolute = true;
    r.i = 1;
  }
  if (r.i >= path.length) r.err('empty path');
  for (;;) {
    const name = r.name();
    const preds: Pred[] = [];
    while (r.s[r.i] === '[') {
      r.i++;
      r.ws();
      const c = r.s[r.i];
      if (c && c >= '0' && c <= '9') {
        const m = /^\d+/.exec(r.s.slice(r.i))!;
        r.i += m[0].length;
        const n = parseInt(m[0], 10);
        if (n < 1) r.err('positions start at 1');
        preds.push({ kind: 'index', n });
      } else if (c === '@') {
        r.i++;
        const an = r.name();
        r.ws();
        let value: string | null = null;
        if (r.s[r.i] === '=') {
          r.i++;
          r.ws();
          value = r.str();
        }
        preds.push({ kind: 'attr', name: an, value });
      } else if (r.s.startsWith('text()', r.i) || (c === '.' && r.s[r.i + 1] !== '.')) {
        r.i += c === '.' ? 1 : 6;
        r.ws();
        if (r.s[r.i] !== '=') r.err('expected "=" after text()');
        r.i++;
        r.ws();
        preds.push({ kind: 'text', value: r.str() });
      } else {
        const cn = r.name();
        r.ws();
        let value: string | null = null;
        if (r.s[r.i] === '=') {
          r.i++;
          r.ws();
          value = r.str();
        }
        preds.push({ kind: 'child', name: cn, value });
      }
      r.ws();
      if (r.s[r.i] !== ']') r.err('expected "]"');
      r.i++;
    }
    steps.push({ descendant, name, preds });
    if (r.i >= path.length) break;
    if (r.s.startsWith('//', r.i)) {
      descendant = true;
      r.i += 2;
    } else if (r.s[r.i] === '/') {
      descendant = false;
      r.i++;
    } else r.err('unexpected character');
    if (r.i >= path.length) r.err('path ends with "/"');
  }
  const out = { absolute, steps };
  if (cache.size > 500) cache.clear();
  cache.set(path, out);
  return out;
}

export function nameMatches(el: { name: string; local: string; uri: string }, test: string): boolean {
  if (test === '*') return true;
  if (test.startsWith('{')) {
    const e = test.indexOf('}');
    return el.uri === test.slice(1, e) && el.local === test.slice(e + 1);
  }
  if (test.includes(':')) return el.name === test;
  return el.local === test;
}

function attrValue(el: ElementNode, name: string): string | undefined {
  for (const a of el.attributes) if (nameMatches(a, name)) return a.value;
  return undefined;
}

function pass(el: ElementNode, p: Pred): boolean {
  switch (p.kind) {
    case 'attr': {
      const v = attrValue(el, p.name);
      return v !== undefined && (p.value === null || v === p.value);
    }
    case 'child':
      for (const c of el.children) {
        if (c.type === 'element' && nameMatches(c, p.name) && (p.value === null || textContent(c).trim() === p.value)) return true;
      }
      return false;
    case 'text':
      return textContent(el).trim() === p.value;
    default:
      return true;
  }
}

function applyPreds(cands: ElementNode[], preds: Pred[]): ElementNode[] {
  let cur = cands;
  for (const p of preds) {
    if (p.kind === 'index') cur = cur.length >= p.n ? [cur[p.n - 1]!] : [];
    else cur = cur.filter((e) => pass(e, p));
  }
  return cur;
}

function descendantsOrSelf(el: ElementNode, includeSelf: boolean, out: ElementNode[]): void {
  const stack: ElementNode[] = [];
  if (includeSelf) out.push(el);
  for (let k = el.children.length - 1; k >= 0; k--) {
    const c = el.children[k]!;
    if (c.type === 'element') stack.push(c);
  }
  while (stack.length) {
    const e = stack.pop()!;
    out.push(e);
    for (let k = e.children.length - 1; k >= 0; k--) {
      const c = e.children[k]!;
      if (c.type === 'element') stack.push(c);
    }
  }
}

/** Evaluate a compiled path. `from` null means the document (whose only child is the root). */
export function evaluate(root: ElementNode, from: ElementNode | null, path: CompiledPath): ElementNode[] {
  let ctx: (ElementNode | null)[] = [from ?? null];
  for (let s = 0; s < path.steps.length; s++) {
    const step = path.steps[s]!;
    const next: ElementNode[] = [];
    const seen = new Set<ElementNode>();
    for (const c of ctx) {
      let pool: ElementNode[];
      if (step.descendant) {
        pool = [];
        if (c === null) descendantsOrSelf(root, true, pool);
        else descendantsOrSelf(c, false, pool);
        // positions are evaluated per parent for descendant steps
        const byParent = new Map<ElementNode | null, ElementNode[]>();
        for (const e of pool) if (nameMatches(e, step.name)) (byParent.get(e.parent) ?? byParent.set(e.parent, []).get(e.parent)!).push(e);
        for (const group of byParent.values()) for (const e of applyPreds(group, step.preds)) if (!seen.has(e)) (seen.add(e), next.push(e));
      } else {
        pool = c === null ? [root] : (c.children.filter((x) => x.type === 'element') as ElementNode[]);
        for (const e of applyPreds(pool.filter((e) => nameMatches(e, step.name)), step.preds)) if (!seen.has(e)) (seen.add(e), next.push(e));
      }
    }
    ctx = next;
    if (ctx.length === 0) return [];
  }
  return ctx as ElementNode[];
}
