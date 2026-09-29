const NAME_START =
  ':A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}';
const NAME_CHAR = NAME_START + '\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040';

/** XML 1.0 (5th ed.) Name, sticky so it can be matched at an offset. */
export const NAME_RE = new RegExp(`[${NAME_START}][${NAME_CHAR}]*`, 'uy');
/** Whole-string Name test. */
export const NAME_FULL_RE = new RegExp(`^[${NAME_START}][${NAME_CHAR}]*$`, 'u');
/** NCName: a Name without colons. */
export const NCNAME_FULL_RE = new RegExp(`^[${NAME_START.replace(':', '')}][${NAME_CHAR.replace(':', '')}]*$`, 'u');
/** Any character that is not in the XML 1.0 Char production. */
export const INVALID_CHAR_RE = /[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/u;

export function isChar(cp: number): boolean {
  return (
    cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

export function isSpace(c: number): boolean {
  return c === 0x20 || c === 0x9 || c === 0xa || c === 0xd;
}
