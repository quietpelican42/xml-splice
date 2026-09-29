export interface Range {
  start: number;
  end: number;
}

export interface Attribute {
  /** Qualified name as written. */
  name: string;
  prefix: string;
  local: string;
  /** Namespace URI, or '' for none. */
  uri: string;
  /** Offset of the first character of the name. */
  start: number;
  /** Offset just past the closing quote. */
  end: number;
  nameEnd: number;
  /** Offset of the opening quote. */
  quoteStart: number;
  /** Offset of the first value character. */
  valueStart: number;
  /** Offset of the closing quote. */
  valueEnd: number;
  quote: '"' | "'";
  /** Start of the whitespace run that precedes the attribute. */
  wsStart: number;
  /** Raw value text between the quotes. */
  raw: string;
  /** Value with entity and character references resolved. */
  value: string;
}

export interface TextNode {
  type: 'text';
  start: number;
  end: number;
  raw: string;
  parent: ElementNode | null;
}

export interface CDataNode {
  type: 'cdata';
  start: number;
  end: number;
  /** Text between `<![CDATA[` and `]]>`. */
  value: string;
  parent: ElementNode | null;
}

export interface CommentNode {
  type: 'comment';
  start: number;
  end: number;
  value: string;
  parent: ElementNode | null;
}

export interface PINode {
  type: 'pi';
  start: number;
  end: number;
  target: string;
  parent: ElementNode | null;
}

export interface DoctypeNode {
  type: 'doctype';
  start: number;
  end: number;
  parent: null;
}

export interface ElementNode {
  type: 'element';
  /** Qualified name as written in the source. */
  name: string;
  prefix: string;
  local: string;
  uri: string;
  /** Start of `<`. */
  start: number;
  /** Offset just past the final `>` (of the end tag, or of `/>`). */
  end: number;
  /** Offset just past the `>` of the start tag. */
  startTagEnd: number;
  /** Offset of the first name character in the start tag. */
  nameStart: number;
  nameEnd: number;
  /** Start of the end tag `</`; -1 when self-closing. */
  endTagStart: number;
  selfClosing: boolean;
  /** For self-closing tags: offset where the whitespace before `/>` begins. */
  closerStart: number;
  attributes: Attribute[];
  children: Node[];
  parent: ElementNode | null;
}

export type Node = ElementNode | TextNode | CDataNode | CommentNode | PINode;

export interface Declaration {
  start: number;
  end: number;
  version: string;
  encoding: string | null;
  standalone: string | null;
}

export interface ParseResult {
  declaration: Declaration | null;
  doctype: DoctypeNode | null;
  root: ElementNode;
  /** Comments and PIs before or after the root. */
  misc: Node[];
  entities: Set<string>;
}
