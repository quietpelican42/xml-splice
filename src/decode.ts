import { isChar } from './chars.ts';

const PREDEFINED: Record<string, string> = { amp: '&', lt: '<', gt: '>', apos: "'", quot: '"' };

/**
 * Resolve predefined entities and character references. Named references that
 * are not predefined (declared in a DTD) are left as written.
 */
export function decodeRefs(raw: string): string {
  if (raw.indexOf('&') < 0) return raw;
  return raw.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|[^;&\s<]+);/g, (m, body: string) => {
    if (body.charCodeAt(0) === 35) {
      const cp = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return isChar(cp) ? String.fromCodePoint(cp) : m;
    }
    return PREDEFINED[body] ?? m;
  });
}

/** Normalize an attribute value the way an XML processor would (whitespace chars become spaces). */
export function decodeAttrValue(raw: string): string {
  return decodeRefsWithSpaces(raw);
}

function decodeRefsWithSpaces(raw: string): string {
  // Literal whitespace normalizes to a space; character references do not.
  return raw
    .replace(/\r\n|[\t\n\r]/g, ' ')
    .replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|[^;&\s<]+);/g, (m, body: string) => {
      if (body.charCodeAt(0) === 35) {
        const cp = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        return isChar(cp) ? String.fromCodePoint(cp) : m;
      }
      return PREDEFINED[body] ?? m;
    });
}
