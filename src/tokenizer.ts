import { INVALID_CHAR_RE, NAME_RE, NCNAME_FULL_RE, isChar } from './chars.ts';
import { decodeAttrValue } from './decode.ts';
import { XmlSyntaxError } from './errors.ts';
import type { Attribute, Declaration, DoctypeNode, ElementNode, Node, ParseResult } from './nodes.ts';

export interface TokenizeOptions {
  /** Check namespace well-formedness and resolve prefixes. Default true. */
  namespaces?: boolean;
}

const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';
const PREDEFINED = new Set(['amp', 'lt', 'gt', 'apos', 'quot']);

function isWs(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

/**
 * Position-tracking XML 1.0 tokenizer. It never normalizes: every node keeps
 * the offsets of the source text it came from. Throws XmlSyntaxError on any
 * well-formedness violation.
 */
export function tokenize(src: string, options: TokenizeOptions = {}): ParseResult {
  const useNs = options.namespaces !== false;
  const n = src.length;
  let i = 0;

  function fail(msg: string, at: number = i): never {
    let line = 1;
    let last = -1;
    const lim = Math.min(at, n);
    for (let k = 0; k < lim; k++) {
      const c = src.charCodeAt(k);
      if (c === 10) {
        line++;
        last = k;
      } else if (c === 13 && src.charCodeAt(k + 1) !== 10) {
        line++;
        last = k;
      }
    }
    throw new XmlSyntaxError(msg, at, line, at - last);
  }

  const bad = INVALID_CHAR_RE.exec(src);
  if (bad) fail(`illegal character U+${bad[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`, bad.index);

  function skipWs(): boolean {
    const s = i;
    while (i < n && isWs(src.charCodeAt(i))) i++;
    return i > s;
  }

  function readName(what: string): string {
    NAME_RE.lastIndex = i;
    const m = NAME_RE.exec(src);
    if (!m) fail(`expected ${what}`);
    i += m[0].length;
    return m[0];
  }

  // ---------- XML declaration ----------
  let declaration: Declaration | null = null;
  if (src.startsWith('<?xml') && n > 5 && isWs(src.charCodeAt(5))) {
    const start = 0;
    const close = src.indexOf('?>', 5);
    if (close < 0) fail('unterminated XML declaration', 0);
    const body = src.slice(5, close);
    const re = /^\s+version\s*=\s*(?:"([^"]*)"|'([^']*)')(?:\s+encoding\s*=\s*(?:"([^"]*)"|'([^']*)'))?(?:\s+standalone\s*=\s*(?:"([^"]*)"|'([^']*)'))?\s*$/;
    const m = re.exec(body);
    if (!m) fail('malformed XML declaration', 0);
    const version = (m[1] ?? m[2])!;
    if (!/^1\.[0-9]+$/.test(version)) fail(`unsupported XML version "${version}"`, 0);
    const encoding = m[3] ?? m[4] ?? null;
    if (encoding !== null && !/^[A-Za-z][A-Za-z0-9._-]*$/.test(encoding)) fail(`invalid encoding name "${encoding}"`, 0);
    const standalone = m[5] ?? m[6] ?? null;
    if (standalone !== null && standalone !== 'yes' && standalone !== 'no') fail('standalone must be "yes" or "no"', 0);
    declaration = { start, end: close + 2, version, encoding, standalone };
    i = close + 2;
  }

  const entities = new Set<string>();
  let doctype: DoctypeNode | null = null;
  const misc: Node[] = [];
  let root: ElementNode | null = null;

  // ---------- helpers for markup ----------
  function parseComment(parent: ElementNode | null): Node {
    const start = i;
    const close = src.indexOf('-->', i + 4);
    if (close < 0) fail('unterminated comment', start);
    const value = src.slice(i + 4, close);
    const dd = value.indexOf('--');
    if (dd >= 0) fail('"--" is not allowed inside a comment', i + 4 + dd);
    if (value.endsWith('-')) fail('comment must not end with "--->"', close - 1);
    i = close + 3;
    return { type: 'comment', start, end: i, value, parent };
  }

  function parsePI(parent: ElementNode | null): Node {
    const start = i;
    i += 2;
    const target = readName('processing instruction target');
    if (target.toLowerCase() === 'xml') fail('reserved processing instruction target "xml" (declaration must be first)', start);
    if (useNs && target.includes(':')) fail('processing instruction target must not contain a colon', start);
    const close = src.indexOf('?>', i);
    if (close < 0) fail('unterminated processing instruction', start);
    if (close > i && !isWs(src.charCodeAt(i))) fail('expected whitespace after processing instruction target', i);
    i = close + 2;
    return { type: 'pi', start, end: i, target, parent };
  }

  function parseDoctype(): DoctypeNode {
    const start = i;
    i += 9;
    if (!skipWs()) fail('expected whitespace after <!DOCTYPE');
    readName('doctype name');
    let depth = 0;
    let subsetFrom = -1;
    let subsetTo = -1;
    for (;;) {
      if (i >= n) fail('unterminated DOCTYPE', start);
      const c = src[i]!;
      if (c === '"' || c === "'") {
        const q = src.indexOf(c, i + 1);
        if (q < 0) fail('unterminated quoted string in DOCTYPE', i);
        i = q + 1;
      } else if (c === '[' && depth === 0) {
        depth = 1;
        subsetFrom = i + 1;
        i++;
      } else if (c === ']' && depth === 1) {
        depth = 0;
        subsetTo = i;
        i++;
      } else if (depth === 1 && src.startsWith('<!--', i)) {
        const q = src.indexOf('-->', i + 4);
        if (q < 0) fail('unterminated comment in DOCTYPE', i);
        i = q + 3;
      } else if (depth === 1 && src.startsWith('<?', i)) {
        const q = src.indexOf('?>', i + 2);
        if (q < 0) fail('unterminated processing instruction in DOCTYPE', i);
        i = q + 2;
      } else if (c === '>' && depth === 0) {
        i++;
        break;
      } else {
        i++;
      }
    }
    if (subsetFrom >= 0) {
      const subset = src.slice(subsetFrom, subsetTo);
      const re = /<!ENTITY\s+([^\s%][^\s]*)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(subset))) entities.add(m[1]!);
    }
    return { type: 'doctype', start, end: i, parent: null };
  }

  function checkRefs(raw: string, at: number): void {
    let p = raw.indexOf('&');
    while (p >= 0) {
      const semi = raw.indexOf(';', p + 1);
      if (semi < 0) fail('"&" must start a reference ending in ";"', at + p);
      const body = raw.slice(p + 1, semi);
      if (body.charCodeAt(0) === 35) {
        const hex = body[1] === 'x';
        const digits = hex ? body.slice(2) : body.slice(1);
        if (!(hex ? /^[0-9A-Fa-f]+$/ : /^[0-9]+$/).test(digits)) fail('malformed character reference', at + p);
        const cp = parseInt(digits, hex ? 16 : 10);
        if (!isChar(cp)) fail(`character reference &#${body.slice(1)}; is not a legal XML character`, at + p);
      } else {
        NAME_RE.lastIndex = 0;
        const m = NAME_RE.exec(body);
        if (!m || m[0].length !== body.length) fail(`malformed entity reference "&${body};"`, at + p);
        if (!PREDEFINED.has(body) && doctype === null) fail(`undeclared entity "&${body};"`, at + p);
        if (!PREDEFINED.has(body) && useNs && body.includes(':')) fail('entity name must not contain a colon', at + p);
      }
      p = raw.indexOf('&', semi + 1);
    }
  }

  // ---------- namespaces ----------
  const nsStack: Map<string, string>[] = [new Map([['xml', XML_NS]])];
  // Each entry is the fully resolved prefix map; elements without declarations share their parent's map.
  function lookupNs(prefix: string): string | undefined {
    return nsStack[nsStack.length - 1]!.get(prefix);
  }

  function splitQName(qn: string, at: number): [string, string] {
    const c = qn.indexOf(':');
    if (c < 0) return ['', qn];
    const p = qn.slice(0, c);
    const l = qn.slice(c + 1);
    if (!NCNAME_FULL_RE.test(p) || !NCNAME_FULL_RE.test(l)) fail(`invalid qualified name "${qn}"`, at);
    return [p, l];
  }

  // ---------- start tag ----------
  function parseStartTag(parent: ElementNode | null): ElementNode {
    const start = i;
    i++;
    const nameStart = i;
    const name = readName('element name');
    const nameEnd = i;
    const attributes: Attribute[] = [];
    let selfClosing = false;
    let closerStart = -1;
    for (;;) {
      const wsStart = i;
      const hadWs = skipWs();
      if (i >= n) fail(`unterminated start tag <${name}>`, start);
      const c = src.charCodeAt(i);
      if (c === 62) {
        i++;
        break;
      }
      if (c === 47) {
        if (src.charCodeAt(i + 1) !== 62) fail('expected "/>"');
        closerStart = wsStart;
        i += 2;
        selfClosing = true;
        break;
      }
      if (!hadWs) fail('expected whitespace before attribute', i);
      const aStart = i;
      const aName = readName('attribute name');
      const aNameEnd = i;
      skipWs();
      if (src.charCodeAt(i) !== 61) fail(`expected "=" after attribute "${aName}"`);
      i++;
      skipWs();
      const q = src[i];
      if (q !== '"' && q !== "'") fail(`attribute "${aName}" value must be quoted`);
      const quoteStart = i;
      const close = src.indexOf(q, i + 1);
      if (close < 0) fail(`unterminated value of attribute "${aName}"`, quoteStart);
      const raw = src.slice(i + 1, close);
      const lt = raw.indexOf('<');
      if (lt >= 0) fail('"<" is not allowed in an attribute value', i + 1 + lt);
      checkRefs(raw, i + 1);
      i = close + 1;
      const [p, l] = useNs ? splitQName(aName, aStart) : ['', aName];
      attributes.push({
        name: aName,
        prefix: p,
        local: l,
        uri: '',
        start: aStart,
        end: i,
        nameEnd: aNameEnd,
        quoteStart,
        valueStart: quoteStart + 1,
        valueEnd: close,
        quote: q,
        wsStart,
        raw,
        value: decodeAttrValue(raw),
      });
    }
    const startTagEnd = i;

    // duplicate attribute names (by qualified name first: cheap and always applicable)
    if (attributes.length > 1) {
      const seen = new Set<string>();
      for (const a of attributes) {
        if (seen.has(a.name)) fail(`duplicate attribute "${a.name}"`, a.start);
        seen.add(a.name);
      }
    }

    let prefix = '';
    let local = name;
    let uri = '';
    if (useNs) {
      const scope = new Map<string, string>();
      for (const a of attributes) {
        if (a.name === 'xmlns') {
          if (a.value === XML_NS || a.value === XMLNS_NS) fail('reserved namespace URI bound as default namespace', a.start);
          scope.set('', a.value);
        } else if (a.prefix === 'xmlns') {
          if (a.local === 'xmlns') fail('the prefix "xmlns" must not be declared', a.start);
          if (a.local === 'xml' && a.value !== XML_NS) fail('the prefix "xml" is bound to a fixed URI', a.start);
          if (a.local !== 'xml' && (a.value === XML_NS || a.value === XMLNS_NS)) fail('reserved namespace URI bound to another prefix', a.start);
          if (a.value === '') fail(`namespace prefix "${a.local}" cannot be undeclared in XML 1.0`, a.start);
          scope.set(a.local, a.value);
        }
      }
      if (scope.size === 0) nsStack.push(nsStack[nsStack.length - 1]!);
      else nsStack.push(new Map([...nsStack[nsStack.length - 1]!, ...scope]));
      [prefix, local] = splitQName(name, nameStart);
      if (prefix === 'xmlns') fail('element names must not use the prefix "xmlns"', nameStart);
      if (prefix === '') uri = lookupNs('') ?? '';
      else {
        const u = lookupNs(prefix);
        if (u === undefined) fail(`unbound namespace prefix "${prefix}"`, nameStart);
        uri = u;
      }
      const seenNs = new Set<string>();
      for (const a of attributes) {
        if (a.name === 'xmlns' || a.prefix === 'xmlns') {
          a.uri = XMLNS_NS;
          continue;
        }
        if (a.prefix) {
          const u = lookupNs(a.prefix);
          if (u === undefined) fail(`unbound namespace prefix "${a.prefix}"`, a.start);
          a.uri = u;
        }
        const key = `${a.uri}\u0000${a.local}`;
        if (seenNs.has(key)) fail(`duplicate attribute "${a.name}" (same expanded name)`, a.start);
        seenNs.add(key);
      }
    }

    return {
      type: 'element',
      name,
      prefix,
      local,
      uri,
      start,
      end: startTagEnd,
      startTagEnd,
      nameStart,
      nameEnd,
      endTagStart: -1,
      selfClosing,
      closerStart,
      attributes,
      children: [],
      parent,
    };
  }

  // ---------- prolog ----------
  const afterRoot = (): boolean => root !== null && stack.length === 0;
  const stack: ElementNode[] = [];

  function textUntilMarkup(parent: ElementNode): void {
    const start = i;
    let j = src.indexOf('<', i);
    if (j < 0) j = n;
    const raw = src.slice(i, j);
    const cd = raw.indexOf(']]>');
    if (cd >= 0) fail('"]]>" is not allowed in character data', i + cd);
    checkRefs(raw, i);
    i = j;
    parent.children.push({ type: 'text', start, end: j, raw, parent });
  }

  // Misc before root
  for (;;) {
    skipWs();
    if (i >= n) fail('document has no root element');
    if (src.startsWith('<!--', i)) misc.push(parseComment(null));
    else if (src.startsWith('<?', i)) misc.push(parsePI(null));
    else if (src.startsWith('<!DOCTYPE', i)) {
      if (doctype) fail('duplicate DOCTYPE');
      doctype = parseDoctype();
    } else if (src[i] === '<' && src[i + 1] !== '/' && src[i + 1] !== '!' && src[i + 1] !== '?') break;
    else fail(i < n && src[i] !== '<' ? 'text is not allowed before the root element' : 'unexpected markup before the root element');
  }

  // ---------- element tree (iterative) ----------
  root = parseStartTag(null);
  if (!root.selfClosing) stack.push(root);
  else {
    root.end = i;
    if (useNs) nsStack.pop();
  }

  while (stack.length > 0) {
    const cur = stack[stack.length - 1]!;
    if (i >= n) fail(`unclosed element <${cur.name}> (opened at offset ${cur.start})`, i);
    const c = src.charCodeAt(i);
    if (c !== 60) {
      textUntilMarkup(cur);
      continue;
    }
    const c1 = src.charCodeAt(i + 1);
    if (c1 === 47) {
      // end tag
      const tagStart = i;
      i += 2;
      const nm = readName('end tag name');
      if (nm !== cur.name) fail(`mismatched end tag: expected </${cur.name}>, found </${nm}>`, tagStart);
      skipWs();
      if (src.charCodeAt(i) !== 62) fail('expected ">" to close end tag');
      i++;
      cur.endTagStart = tagStart;
      cur.end = i;
      stack.pop();
      if (useNs) nsStack.pop();
    } else if (src.startsWith('<!--', i)) {
      cur.children.push(parseComment(cur));
    } else if (src.startsWith('<![CDATA[', i)) {
      const start = i;
      const close = src.indexOf(']]>', i + 9);
      if (close < 0) fail('unterminated CDATA section', start);
      i = close + 3;
      cur.children.push({ type: 'cdata', start, end: i, value: src.slice(start + 9, close), parent: cur });
    } else if (c1 === 63) {
      cur.children.push(parsePI(cur));
    } else if (c1 === 33) {
      fail('unexpected "<!" markup inside an element');
    } else {
      const el = parseStartTag(cur);
      cur.children.push(el);
      if (el.selfClosing) {
        el.end = i;
        if (useNs) nsStack.pop();
      } else {
        stack.push(el);
      }
    }
  }

  // ---------- epilog ----------
  for (;;) {
    skipWs();
    if (i >= n) break;
    if (src.startsWith('<!--', i)) misc.push(parseComment(null));
    else if (src.startsWith('<?', i)) misc.push(parsePI(null));
    else if (src[i] === '<' && src[i + 1] !== '/' && src[i + 1] !== '!') fail('only one root element is allowed');
    else fail('content is not allowed after the root element');
  }
  void afterRoot;

  return { declaration, doctype, root, misc, entities };
}
