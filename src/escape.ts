import { INVALID_CHAR_RE } from './chars.ts';
import { EditError } from './errors.ts';

export interface EscapeStyle {
  /** Escape ">" as "&gt;" (true when the file already does). */
  escapeGt: boolean;
  newline: string;
  /** Code points above U+00FF must be written as character references. */
  latin1: boolean;
}

export function assertLegal(value: string, what: string): void {
  const m = INVALID_CHAR_RE.exec(value);
  if (m) throw new EditError(`${what} contains U+${m[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}, which XML 1.0 cannot represent`);
}

function refs(s: string, latin1: boolean): string {
  if (!latin1) return s;
  return s.replace(/[^\u0000-ÿ]/gu, (c) => `&#x${c.codePointAt(0)!.toString(16).toUpperCase()};`);
}

/** Escape a text value for element content. "\n" becomes the file's newline; a bare "\r" becomes a reference. */
export function escapeText(value: string, style: EscapeStyle): string {
  assertLegal(value, 'text');
  let s = value.replace(/\r\n/g, '\n').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  s = style.escapeGt ? s.replace(/>/g, '&gt;') : s.replace(/]]>/g, ']]&gt;');
  s = s.replace(/\r/g, '&#13;');
  if (style.newline !== '\n') s = s.replace(/\n/g, style.newline);
  return refs(s, style.latin1);
}

/** Escape an attribute value for the given quote character. Whitespace characters are written as references so they survive normalization. */
export function escapeAttr(value: string, quote: '"' | "'", style: EscapeStyle): string {
  assertLegal(value, 'attribute value');
  let s = value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  if (style.escapeGt) s = s.replace(/>/g, '&gt;');
  s = quote === '"' ? s.replace(/"/g, '&quot;') : s.replace(/'/g, '&apos;');
  s = s.replace(/\t/g, '&#9;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;');
  return refs(s, style.latin1);
}

/** Wrap a value in CDATA, splitting any "]]>" across sections. Returns null when it cannot be represented. */
export function cdata(value: string, style: EscapeStyle): string | null {
  assertLegal(value, 'text');
  if (style.latin1 && /[^\u0000-ÿ]/u.test(value)) return null;
  let s = value.replace(/\r\n/g, '\n');
  if (s.includes('\r')) return null;
  if (style.newline !== '\n') s = s.replace(/\n/g, style.newline);
  return '<![CDATA[' + s.replace(/]]>/g, ']]]]><![CDATA[>') + ']]>';
}
