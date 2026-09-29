/** Thrown when the input is not well-formed XML 1.0 (or violates namespace rules). */
export class XmlSyntaxError extends Error {
  readonly offset: number;
  readonly line: number;
  readonly column: number;

  constructor(message: string, offset: number, line: number, column: number) {
    super(`${message} (line ${line}, column ${column})`);
    this.name = 'XmlSyntaxError';
    this.offset = offset;
    this.line = line;
    this.column = column;
  }
}

/** Thrown for input encodings the library cannot round-trip (UTF-16, UTF-32, most legacy code pages). */
export class UnsupportedEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedEncodingError';
  }
}

/** Thrown when an edit is invalid (bad name, illegal character, wrong target). */
export class EditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditError';
  }
}

/** Thrown when two edits touch overlapping ranges of the original text. */
export class EditConflictError extends EditError {
  constructor(message: string) {
    super(message);
    this.name = 'EditConflictError';
  }
}

/** Thrown when a query path cannot be parsed. */
export class QuerySyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuerySyntaxError';
  }
}
