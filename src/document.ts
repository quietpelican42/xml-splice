import { NAME_FULL_RE } from './chars.ts';
import { decodeBytes, encodeText } from './encoding.ts';
import type { Encoding } from './encoding.ts';
import { EditConflictError, EditError } from './errors.ts';
import { assertLegal, cdata, escapeAttr, escapeText } from './escape.ts';
import type { Attribute, Declaration, ElementNode, Node } from './nodes.ts';
import { compilePath, evaluate, textContent } from './query.ts';
import { detectStyle, lineIndent } from './style.ts';
import type { DocStyle } from './style.ts';
import { tokenize } from './tokenizer.ts';
import type { TokenizeOptions } from './tokenizer.ts';

export type Element = ElementNode;

export interface ElementSpec {
  name: string;
  attrs?: Record<string, string>;
  /** Text content. An empty string produces `<name></name>`; undefined with no children produces `<name/>`. */
  text?: string;
  children?: ElementSpec[];
}

export interface InsertOptions {
  /** Insert before this child of the parent. */
  before?: Element;
  /** Insert after this child of the parent. */
  after?: Element;
  /** Where to put the element when neither `before` nor `after` is given. Default 'last'. */
  position?: 'first' | 'last';
}

export interface SetTextOptions {
  /** true forces CDATA, false forces escaping. Default: keep CDATA when the element already uses it. */
  cdata?: boolean;
  /** Keep the leading and trailing whitespace of the existing text, so `<v>\n  1.0\n</v>` stays padded. Default false: the value becomes the exact text. */
  keepPadding?: boolean;
  /** Allow replacing an element that has child elements. Default false. */
  replaceChildren?: boolean;
}

export interface PendingEdit {
  start: number;
  end: number;
  text: string;
}

interface Edit {
  start: number;
  end: number;
  text: string | (() => string);
  seq: number;
  key: string | null;
}

interface Fill {
  edit: Edit;
  kind: 'text' | 'children';
  items: string[];
  block: boolean;
  parentIndent: string;
  childIndent: string;
}

export class XmlDocument {
  /** The original text, without the byte order mark. */
  readonly source: string;
  readonly bom: boolean;
  readonly encoding: Encoding;
  readonly root: Element;
  readonly declaration: Declaration | null;
  readonly hasDoctype: boolean;

  #edits: Edit[] = [];
  #seq = 0;
  #style: DocStyle | null = null;
  #fills = new Map<Element, Fill>();
  #names = new Map<Element, string>();
  #options: TokenizeOptions;

  private constructor(source: string, bom: boolean, encoding: Encoding, options: TokenizeOptions) {
    this.source = source;
    this.bom = bom;
    this.encoding = encoding;
    this.#options = options;
    const r = tokenize(source, options);
    this.root = r.root;
    this.declaration = r.declaration;
    this.hasDoctype = r.doctype !== null;
  }

  /**
   * Parse a document. Strings may start with U+FEFF. Byte input must be UTF-8
   * (BOM optional), US-ASCII or ISO-8859-1; UTF-16 and UTF-32 throw UnsupportedEncodingError.
   */
  static parse(input: string | Uint8Array, options: TokenizeOptions = {}): XmlDocument {
    if (typeof input === 'string') {
      const bom = input.charCodeAt(0) === 0xfeff;
      return new XmlDocument(bom ? input.slice(1) : input, bom, 'utf-8', options);
    }
    const d = decodeBytes(input);
    return new XmlDocument(d.text, d.bom, d.encoding, options);
  }

  get style(): DocStyle {
    return (this.#style ??= detectStyle(this.source, this.root, this.encoding === 'latin1'));
  }

  // ------------------------------------------------------------------ reading

  /** Elements matching a path such as `project/dependencies/dependency[artifactId="foo"]/version`, in document order. */
  select(path: string, from?: Element): Element[] {
    const c = compilePath(path);
    const res = evaluate(this.root, c.absolute || !from ? null : from, c);
    return res.length > 1 ? res.sort((a, b) => a.start - b.start) : res;
  }

  selectOne(path: string, from?: Element): Element | undefined {
    return this.select(path, from)[0];
  }

  /** Visit every element in document order. Return false from the callback to skip that element's children. */
  walk(cb: (el: Element, depth: number) => boolean | void): void {
    const stack: [Element, number][] = [[this.root, 0]];
    while (stack.length) {
      const [el, d] = stack.pop()!;
      if (cb(el, d) === false) continue;
      for (let k = el.children.length - 1; k >= 0; k--) {
        const c = el.children[k]!;
        if (c.type === 'element') stack.push([c, d + 1]);
      }
    }
  }

  /** Decoded text of the element and its descendants. */
  text(el: Element): string {
    return textContent(el);
  }

  /** Decoded attribute value by qualified name. */
  attr(el: Element, name: string): string | undefined {
    for (const a of el.attributes) if (a.name === name) return a.value;
    return undefined;
  }

  /** Child elements. */
  elements(el: Element): Element[] {
    return el.children.filter((c): c is Element => c.type === 'element');
  }

  /** The exact source text of a node. */
  raw(node: { start: number; end: number }): string {
    return this.source.slice(node.start, node.end);
  }

  // ------------------------------------------------------------------ output

  /** The pending edits as ranges of the original text, in application order. */
  get pendingEdits(): PendingEdit[] {
    return this.#sorted().map((e) => ({ start: e.start, end: e.end, text: typeof e.text === 'function' ? e.text() : e.text }));
  }

  get changed(): boolean {
    return this.#edits.length > 0;
  }

  #body(): string {
    let out = '';
    let pos = 0;
    for (const e of this.#sorted()) {
      out += this.source.slice(pos, e.start) + (typeof e.text === 'function' ? e.text() : e.text);
      pos = e.end;
    }
    return out + this.source.slice(pos);
  }

  toString(): string {
    return (this.bom ? '\uFEFF' : '') + this.#body();
  }

  toBuffer(): Uint8Array {
    return encodeText(this.#body(), this.bom, this.encoding);
  }

  /** Apply the pending edits and parse the result, so new nodes can be queried. */
  commit(): XmlDocument {
    return XmlDocument.parse(this.toBuffer(), this.#options);
  }

  #sorted(): Edit[] {
    return [...this.#edits].sort((a, b) => {
      if (a.start !== b.start) return a.start - b.start;
      const az = a.start === a.end;
      const bz = b.start === b.end;
      if (az !== bz) return az ? -1 : 1;
      return a.seq - b.seq;
    });
  }

  // ------------------------------------------------------------------ edit plumbing

  #own(el: Element): void {
    let e: Element | null = el;
    while (e && e.parent) e = e.parent;
    if (e !== this.root) throw new EditError('element does not belong to this document');
  }

  #add(start: number, end: number, text: string | (() => string), key: string | null): Edit {
    if (key !== null) this.#edits = this.#edits.filter((e) => e.key !== key);
    for (const o of this.#edits) {
      const oz = o.start === o.end;
      const nz = start === end;
      let bad = false;
      if (!oz && !nz) bad = start < o.end && o.start < end;
      else if (oz && !nz) bad = o.start > start && o.start < end;
      else if (!oz && nz) bad = start > o.start && start < o.end;
      if (bad) {
        throw new EditConflictError(
          `edit at ${start}-${end} overlaps another pending edit at ${o.start}-${o.end}; apply one of them, call commit(), and edit the result`,
        );
      }
    }
    const edit: Edit = { start, end, text, seq: this.#seq++, key };
    this.#edits.push(edit);
    return edit;
  }

  #currentName(el: Element): string {
    return this.#names.get(el) ?? el.name;
  }

  #lookupPrefix(el: Element, prefix: string): boolean {
    if (prefix === 'xml') return true;
    for (let e: Element | null = el; e; e = e.parent) {
      for (const a of e.attributes) if (a.name === `xmlns:${prefix}`) return true;
    }
    return false;
  }

  #checkName(name: string, what: string, scope: Element | null): void {
    if (!NAME_FULL_RE.test(name)) throw new EditError(`"${name}" is not a valid XML ${what} name`);
    const c = name.indexOf(':');
    if (this.#options.namespaces !== false && c >= 0) {
      if (c === 0 || c === name.length - 1 || name.indexOf(':', c + 1) >= 0) throw new EditError(`"${name}" is not a valid qualified name`);
      const prefix = name.slice(0, c);
      if (scope && prefix !== 'xmlns' && !this.#lookupPrefix(scope, prefix)) throw new EditError(`namespace prefix "${prefix}" is not declared in scope`);
    }
    if (this.encoding === 'latin1' && /[^\u0000-ÿ]/u.test(name)) throw new EditError(`"${name}" cannot be written in an ISO-8859-1 document`);
  }

  // ------------------------------------------------------------------ setText

  setText(el: Element, value: string, opts: SetTextOptions = {}): void {
    this.#own(el);
    const st = this.style;
    const hasElements = el.children.some((c) => c.type === 'element');
    if (hasElements && !opts.replaceChildren) {
      throw new EditError(`<${el.name}> has child elements; pass { replaceChildren: true } to overwrite them`);
    }
    assertLegal(value, 'text');
    const key = `text:${el.start}`;
    const hasCdata = el.children.some((c) => c.type === 'cdata');
    const plainText = el.children.some((c) => c.type === 'text' && c.raw.trim() !== '');
    const useCdata = value !== '' && (opts.cdata === true || (opts.cdata === undefined && hasCdata && !plainText && !hasElements));
    const encoded = (useCdata ? cdata(value, st) : null) ?? escapeText(value, st);

    if (el.selfClosing) {
      if (value === '') {
        const f = this.#fills.get(el);
        if (f?.kind === 'text') {
          this.#edits = this.#edits.filter((e) => e !== f.edit);
          this.#fills.delete(el);
        }
        return;
      }
      this.#fill(el, 'text', encoded, false, '', '');
      return;
    }
    const cs = el.startTagEnd;
    const ce = el.endTagStart;
    const content = this.source.slice(cs, ce);
    if (!hasElements && opts.keepPadding === true) {
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(content)!;
      if (m[2] !== '') {
        if (textContent(el).trim() === value && !(opts.cdata === true && !hasCdata)) {
          this.#edits = this.#edits.filter((e) => e.key !== key);
          return;
        }
        this.#add(cs, ce, m[1] + (value === '' ? '' : encoded) + m[3], key);
        return;
      }
    }
    if (!hasElements && textContent(el) === value && (opts.cdata === undefined || opts.cdata === hasCdata)) {
      this.#edits = this.#edits.filter((e) => e.key !== key);
      return;
    }
    this.#add(cs, ce, encoded, key);
  }

  // ------------------------------------------------------------------ attributes

  #findAttr(el: Element, name: string): Attribute | undefined {
    return el.attributes.find((a) => a.name === name);
  }

  setAttr(el: Element, name: string, value: string): void {
    this.#own(el);
    const st = this.style;
    const key = `attr:${el.start}:${name}`;
    const a = this.#findAttr(el, name);
    if (a) {
      if (a.value === value) {
        this.#edits = this.#edits.filter((e) => e.key !== key);
        return;
      }
      this.#add(a.valueStart, a.valueEnd, escapeAttr(value, a.quote, st), key);
      return;
    }
    this.#checkName(name, 'attribute', el);
    assertLegal(value, 'attribute value');
    const last = el.attributes.at(-1);
    let dq = 0;
    let sq = 0;
    for (const x of el.attributes) x.quote === '"' ? dq++ : sq++;
    let quote: '"' | "'" = dq === sq ? st.quote : dq > sq ? '"' : "'";
    if (value.includes(quote) && !value.includes(quote === '"' ? "'" : '"')) quote = quote === '"' ? "'" : '"';
    let sep = ' ';
    let eq = '=';
    let at = el.nameEnd;
    if (last) {
      at = last.end;
      const ws = this.source.slice(last.wsStart, last.start);
      if (/[\r\n]/.test(ws)) sep = ws;
      eq = this.source.slice(last.nameEnd, last.quoteStart);
    }
    this.#add(at, at, `${sep}${name}${eq}${quote}${escapeAttr(value, quote, st)}${quote}`, key);
  }

  /** Remove an attribute. Returns false when the element has no such attribute. */
  removeAttr(el: Element, name: string): boolean {
    this.#own(el);
    const key = `attr:${el.start}:${name}`;
    const a = this.#findAttr(el, name);
    if (!a) {
      const had = this.#edits.some((e) => e.key === key);
      this.#edits = this.#edits.filter((e) => e.key !== key);
      return had;
    }
    this.#add(a.wsStart, a.end, '', key);
    return true;
  }

  // ------------------------------------------------------------------ rename

  renameElement(el: Element, newName: string): void {
    this.#own(el);
    this.#checkName(newName, 'element', el.parent ?? el);
    const c = newName.indexOf(':');
    if (c >= 0 && this.#options.namespaces !== false && !this.#lookupPrefix(el, newName.slice(0, c))) {
      throw new EditError(`namespace prefix "${newName.slice(0, c)}" is not declared in scope`);
    }
    const k1 = `name:${el.start}:s`;
    const k2 = `name:${el.start}:e`;
    if (newName === el.name) {
      this.#edits = this.#edits.filter((e) => e.key !== k1 && e.key !== k2);
      this.#names.delete(el);
      return;
    }
    this.#names.set(el, newName);
    this.#add(el.nameStart, el.nameEnd, newName, k1);
    if (!el.selfClosing) this.#add(el.endTagStart + 2, el.endTagStart + 2 + el.name.length, newName, k2);
  }

  // ------------------------------------------------------------------ insert

  #renderSpec(spec: ElementSpec, indent: string | null, unit: string, scope: Element): string {
    this.#checkName(spec.name, 'element', scope);
    const st = this.style;
    let attrs = '';
    for (const [k, v] of Object.entries(spec.attrs ?? {})) {
      this.#checkName(k, 'attribute', scope);
      let q = st.quote;
      if (v.includes(q) && !v.includes(q === '"' ? "'" : '"')) q = q === '"' ? "'" : '"';
      attrs += ` ${k}=${q}${escapeAttr(v, q, st)}${q}`;
    }
    if (spec.children?.length) {
      const inner = spec.children
        .map((c) => (indent === null ? '' : st.newline + indent + unit) + this.#renderSpec(c, indent === null ? null : indent + unit, unit, scope))
        .join('');
      return `<${spec.name}${attrs}>${inner}${indent === null ? '' : st.newline + indent}</${spec.name}>`;
    }
    if (spec.text !== undefined) {
      return spec.text === '' ? `<${spec.name}${attrs}></${spec.name}>` : `<${spec.name}${attrs}>${escapeText(spec.text, st)}</${spec.name}>`;
    }
    return `<${spec.name}${attrs}/>`;
  }

  #fill(el: Element, kind: 'text' | 'children', item: string, block: boolean, parentIndent: string, childIndent: string): void {
    const existing = this.#fills.get(el);
    if (existing) {
      if (existing.kind !== kind) throw new EditConflictError(`<${el.name}> cannot receive both text and child elements from separate edits`);
      if (kind === 'text') existing.items = [item];
      else existing.items.push(item);
      return;
    }
    const nl = this.style.newline;
    const fill: Fill = { edit: null as unknown as Edit, kind, items: [item], block, parentIndent, childIndent };
    const render = (): string => {
      const body =
        fill.kind === 'text'
          ? fill.items[0]!
          : fill.block
            ? fill.items.map((x) => nl + fill.childIndent + x).join('') + nl + fill.parentIndent
            : fill.items.join('');
      return el.selfClosing ? `>${body}</${this.#currentName(el)}>` : body;
    };
    const start = el.selfClosing ? el.closerStart : el.startTagEnd;
    const end = el.selfClosing ? el.end : el.endTagStart;
    fill.edit = this.#add(start, end, render, `fill:${el.start}`);
    this.#fills.set(el, fill);
  }

  /**
   * Insert a new element as a child of `parent`. Indentation is measured from the
   * siblings, and the file's newline style and indent character are reused.
   * The element is inserted after the last child element unless `before`, `after`
   * or `position: 'first'` say otherwise. Several inserts at the same spot appear in call order.
   */
  insertElement(parent: Element, spec: ElementSpec, opts: InsertOptions = {}): void {
    this.#own(parent);
    const st = this.style;
    const src = this.source;
    const kids = this.elements(parent);
    for (const r of [opts.before, opts.after]) if (r && r.parent !== parent) throw new EditError('before/after must be a child of the parent element');

    let ref: Node | undefined;
    let placeAfter = true;
    if (opts.before) {
      ref = opts.before;
      placeAfter = false;
    } else if (opts.after) ref = opts.after;
    else if (opts.position === 'first' && kids.length) {
      ref = kids[0];
      placeAfter = false;
    } else if (kids.length) ref = kids.at(-1);
    else {
      const last = parent.children.filter((c) => c.type === 'comment' || c.type === 'pi').at(-1);
      const hasText = parent.children.some((c) => (c.type === 'text' && c.raw.trim() !== '') || c.type === 'cdata');
      if (last && !hasText && lineIndent(src, last.start) !== null) ref = last;
    }

    if (ref) {
      const ind = lineIndent(src, ref.start);
      if (ind !== null) {
        const xml = this.#renderSpec(spec, ind, st.indentUnit, parent);
        if (placeAfter) this.#add(ref.end, ref.end, st.newline + ind + xml, null);
        else this.#add(ref.start, ref.start, xml + st.newline + ind, null);
      } else {
        const xml = this.#renderSpec(spec, null, st.indentUnit, parent);
        const at = placeAfter ? ref.end : ref.start;
        this.#add(at, at, xml, null);
      }
      return;
    }

    // No element children to measure from.
    const hasText = parent.children.some((c) => (c.type === 'text' && c.raw.trim() !== '') || c.type === 'cdata');
    if (hasText) {
      const xml = this.#renderSpec(spec, null, st.indentUnit, parent);
      this.#add(parent.endTagStart, parent.endTagStart, xml, null);
      return;
    }
    const pInd = lineIndent(src, parent.start);
    if (pInd !== null) {
      const childInd = pInd + this.#unitFor(parent, pInd);
      this.#fill(parent, 'children', this.#renderSpec(spec, childInd, st.indentUnit, parent), true, pInd, childInd);
    } else {
      this.#fill(parent, 'children', this.#renderSpec(spec, null, st.indentUnit, parent), false, '', '');
    }
  }

  #unitFor(_parent: Element, _pInd: string): string {
    return this.style.indentUnit;
  }

  // ------------------------------------------------------------------ remove

  /**
   * Remove an element. When it sits alone on its line(s), the whole line
   * including its indentation and line break goes with it.
   */
  removeElement(el: Element): void {
    this.#own(el);
    if (el === this.root) throw new EditError('the root element cannot be removed');
    const src = this.source;
    const pre = lineIndent(src, el.start);
    let start = el.start;
    let end = el.end;
    if (pre !== null) {
      let k = el.end;
      while (k < src.length && (src.charCodeAt(k) === 32 || src.charCodeAt(k) === 9)) k++;
      let lineEnd = -1;
      if (k >= src.length) lineEnd = k;
      else if (src.charCodeAt(k) === 13) lineEnd = src.charCodeAt(k + 1) === 10 ? k + 2 : k + 1;
      else if (src.charCodeAt(k) === 10) lineEnd = k + 1;
      if (lineEnd >= 0) {
        start = el.start - pre.length;
        end = lineEnd;
      }
    }
    this.#add(start, end, '', `remove:${el.start}`);
  }
}
