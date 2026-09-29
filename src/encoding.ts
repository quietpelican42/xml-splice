import { UnsupportedEncodingError } from './errors.ts';

export type Encoding = 'utf-8' | 'latin1';

export interface Decoded {
  text: string;
  bom: boolean;
  encoding: Encoding;
}

/**
 * Decode raw bytes. UTF-8 (with or without BOM), US-ASCII and ISO-8859-1 are
 * supported because they map byte-for-byte onto the text. UTF-16 and UTF-32 are
 * detected and rejected with a clear error instead of being mangled.
 */
export function decodeBytes(bytes: Uint8Array): Decoded {
  const b = bytes;
  if (b.length >= 4 && ((b[0] === 0xff && b[1] === 0xfe && b[2] === 0 && b[3] === 0) || (b[0] === 0 && b[1] === 0 && b[2] === 0xfe && b[3] === 0xff))) {
    throw new UnsupportedEncodingError('UTF-32 input is not supported; convert the file to UTF-8 first');
  }
  if (b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff))) {
    throw new UnsupportedEncodingError('UTF-16 input (byte order mark found) is not supported; convert the file to UTF-8 first');
  }
  if (b.length >= 4) {
    if ((b[0] === 0x3c && b[1] === 0 && b[2] === 0 && b[3] === 0) || (b[0] === 0 && b[1] === 0 && b[2] === 0 && b[3] === 0x3c)) {
      throw new UnsupportedEncodingError('UTF-32 input (no byte order mark) is not supported; convert the file to UTF-8 first');
    }
    if ((b[0] === 0x3c && b[1] === 0 && b[2] === 0x3f && b[3] === 0) || (b[0] === 0 && b[1] === 0x3c && b[2] === 0 && b[3] === 0x3f)) {
      throw new UnsupportedEncodingError('UTF-16 input (no byte order mark) is not supported; convert the file to UTF-8 first');
    }
  }
  // Any document starting with a NUL byte pair pattern ("<\0", "\0<", " \0") is UTF-16 without a BOM.
  if (b.length >= 2 && (b[0] === 0) !== (b[1] === 0)) {
    throw new UnsupportedEncodingError('UTF-16 input (no byte order mark, detected from NUL bytes) is not supported; convert the file to UTF-8 first');
  }
  const bom = b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
  const body = bom ? b.subarray(3) : b;

  // Look at the declared encoding in the first bytes (ASCII-compatible by construction).
  let head = '';
  const lim = Math.min(body.length, 200);
  for (let i = 0; i < lim; i++) head += String.fromCharCode(body[i]!);
  const m = /^<\?xml[^>]*?\sencoding\s*=\s*(["'])([A-Za-z][A-Za-z0-9._-]*)\1/.exec(head);
  const declared = m ? m[2]!.toLowerCase() : null;
  let encoding: Encoding = 'utf-8';
  if (declared !== null) {
    if (declared === 'utf-8' || declared === 'utf8' || declared === 'us-ascii' || declared === 'ascii') encoding = 'utf-8';
    else if (['iso-8859-1', 'iso_8859-1', 'latin1', 'latin-1', 'l1'].includes(declared)) encoding = 'latin1';
    else if (declared.startsWith('utf-16') || declared.startsWith('utf16') || declared.startsWith('utf-32') || declared.startsWith('ucs')) {
      throw new UnsupportedEncodingError(`the XML declaration says encoding="${m![2]}" but the bytes are 8-bit; UTF-16/32 is not supported`);
    } else {
      throw new UnsupportedEncodingError(`encoding "${m![2]}" is not supported (supported: UTF-8, US-ASCII, ISO-8859-1)`);
    }
  }
  if (encoding === 'latin1') {
    if (bom) throw new UnsupportedEncodingError('a UTF-8 byte order mark on an ISO-8859-1 document is contradictory');
    return { text: Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('latin1'), bom: false, encoding };
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    throw new UnsupportedEncodingError('input is not valid UTF-8 and the XML declaration names no other supported encoding');
  }
  return { text, bom, encoding };
}

export function encodeText(text: string, bom: boolean, encoding: Encoding): Uint8Array {
  if (encoding === 'latin1') return Buffer.from(text, 'latin1');
  const body = new TextEncoder().encode(text);
  if (!bom) return body;
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf], 0);
  out.set(body, 3);
  return out;
}
