# xml-splice

Edit XML files such as pom.xml, csproj, Directory.Build.props and AndroidManifest.xml by splicing into the original text, so every byte outside the edit stays identical.

```js
import { XmlDocument, setMavenDependencyVersion } from 'xml-splice';

const doc = XmlDocument.parse(fs.readFileSync('pom.xml')); // BOM, CRLF, comments, attribute layout: all kept
setMavenDependencyVersion(doc, 'com.google.guava:guava', '33.0.0-jre'); // edits <guava.version> if the version is ${guava.version}
doc.setText(doc.selectOne('project/dependencies/dependency[artifactId="junit"]/version'), '5.10.0');
fs.writeFileSync('pom.xml', doc.toBuffer());
```

## Why

Parse-and-serialize XML libraries rebuild the document from a tree. They drop the BOM, the declaration's line break, blank lines and multi-line attribute layout, rewrite `<a />` as `<a/>` or `<a></a>`, and re-quote attributes. A one-line version bump then becomes a whole-file diff. Tools that need a clean diff (dependency updaters, release scripts, codemods) end up splicing by offset by hand. Renovate's Maven manager does this with `xmldoc` positions and `replaceAt` ([`lib/modules/manager/maven/update.ts`, pinned](https://github.com/renovatebot/renovate/blob/c11053adc321b13b4d581f5babe6446d6adb9b48/lib/modules/manager/maven/update.ts#L138-L172)):

```ts
const startTagPosition = versionNode.startTagPosition!; // TODO: should not be null
const versionPosition = content.indexOf(versionNode.val, startTagPosition);
...
bumpedContent = replaceAt(content, versionPosition, currentValue, newPomVersion);
```

That approach finds the text with `indexOf` after the tag start. It handles one edit type in one file layout. xml-splice records exact source offsets for every node and attribute and offers six edit types on top of them.

Measured: `npm run corpus && npm run build && npm run bench` on 108 real files (18 Maven poms, 23 csproj, 28 props, 7 NuGet.config, 12 AndroidManifest.xml, 5 xcscheme, 15 other; 16 with a BOM, 3 with CRLF, 12 with tab indent). Each file gets up to six independent edits (500 in total), and an edit counts as clean only when the output equals the ideal minimal splice byte for byte. The ideal is computed by a separate oracle built on `@rgrove/parse-xml` offsets, not by this library. Best configuration tried for each incumbent:

| Library | Round trip byte-identical | Clean edits (of 500) |
| --- | --- | --- |
| **xml-splice 0.1.0** | **108 / 108** | **500 (100%)** |
| xml-js 1.6.11 (`compact:false`, `captureSpacesBetweenElements`) | 14 / 108 | 36 (7.2%) |
| xast-util-from-xml + xast-util-to-xml 4.0.0 (`closeEmptyElements`, BOM re-added by caller) | 4 / 108 | 14 (2.8%) |
| htmlparser2 12 (`xmlMode`) + dom-serializer 3.1.1 | 4 / 108 | 12 (2.4%) |
| xmlpoke 0.1.16 (no-op round trip only; wraps xmldom 0.1) | 11 / 108 | not run |
| @xmldom/xmldom 0.9.12 (`DOMParser` + `XMLSerializer`) | 0 / 108 | 0 |
| xmldoc 3.0.0 (`toString`, three option sets) | 0 / 108 | 0 |
| fast-xml-parser 5.11.2 (`preserveOrder`, two option sets) | 0 / 108 | 0 |
| txml 6.0.3 (`parse` + `stringify`, no-op round trip only) | 0 / 108 | not run |

Per edit type, xml-splice: setText 69/69, setAttr 96/96, removeAttr 96/96, insertElement 64/64, removeElement 106/106, renameElement 69/69 (the denominators differ because an edit type only applies to files that have a suitable target). Counts for every option set are in `bench/measure.mjs` output. Not measured as editors: `@rgrove/parse-xml`, `sax`, `saxes`, `@xml-tools/*` (parsers without a serializer) and `xml2js` (lossy by design). No npm package for byte-preserving XML edits was found under `xml-splice`, `xmlsplice`, `xml-preserve`, `xml-lossless`, `xml-patch`, `xml-roundtrip` or the other name patterns tried; `xmledit` on npm is an unrelated page editor.

Typical round-trip failures, from `bench/why.mjs`: XML declaration dropped, BOM dropped, line break after the declaration or after the root lost, `<x />` rewritten as `<x/>`, multi-line attribute lists collapsed, whitespace between elements duplicated.

## Installation

```sh
npm install xml-splice
```

Node 20.6 or later. No runtime dependencies.

## Usage

### Parse, query, edit, write

```js
import { XmlDocument } from 'xml-splice';

const doc = XmlDocument.parse(bytesOrString);
const version = doc.selectOne('project/dependencies/dependency[artifactId="foo"]/version');
doc.setText(version, '2.0.0');
doc.setAttr(doc.root, 'xsi:schemaLocation', '...'); // quote follows the existing value
doc.removeAttr(doc.root, 'obsolete');
doc.insertElement(doc.selectOne('project/dependencies'), {
  name: 'dependency',
  children: [{ name: 'groupId', text: 'org.x' }, { name: 'artifactId', text: 'y' }],
}); // indent, indent character and newline style come from the siblings
doc.removeElement(doc.selectOne('project/build'));  // removes its own line when alone on it
doc.renameElement(doc.selectOne('project/name'), 'description'); // open and close tags
const text = doc.toString();   // string, BOM kept
const bytes = doc.toBuffer();  // bytes, BOM and encoding kept
```

Edits are recorded against the original text. Two edits that touch overlapping ranges throw `EditConflictError`. Call `commit()` to apply the pending edits and get a new document to query.

### Query paths

| Form | Meaning |
| --- | --- |
| `a/b/c` | Absolute from the root; the first step names the root element. |
| `//name` | Any descendant. |
| `*` | Any element. |
| `name[3]` | Third matching child (1-based). |
| `name[@attr]`, `name[@attr="v"]` | Attribute exists or equals. |
| `name[child]`, `name[child="v"]` | Child element exists or has trimmed text equal to `v`. |
| `name[.="v"]` | Trimmed text equals `v`. |
| `{uri}name`, `p:name` | Match by namespace URI or by literal prefix. |

A name without a prefix matches the local name in any namespace, so `project/version` works on a pom that declares `xmlns="http://maven.apache.org/POM/4.0.0"`.

`doc.walk((el, depth) => ...)` visits every element in document order. Return `false` to skip the children.

### Maven

```js
import { mavenDependencies, setMavenDependencyVersion } from 'xml-splice';

for (const d of mavenDependencies(doc)) console.log(d.groupId, d.artifactId, d.version, d.resolved);
const results = setMavenDependencyVersion(doc, 'org.x:foo', '2.0.0');
// [{ status: 'edited', via: 'property', property: 'foo.version', dependency }, ...]
```

A version of the form `${foo.version}` is resolved to the property element in the same file (following `${a}` to `${b}` chains, and `${project.version}` to the project or parent version) and the edit is made there. The `${...}` reference stays in place. Matches inside `dependencies`, `dependencyManagement`, plugins, plugin dependencies, extensions and `parent` are all covered. Results with `status` `unresolved` (property not defined in this file), `complex` (`${a}-SNAPSHOT`) or `no-version` are reported and not edited.

### csproj and props

```js
import { packageReferences, setPackageVersion } from 'xml-splice';

setPackageVersion(doc, 'Newtonsoft.Json', '13.0.3');
```

Handles `PackageReference`, `PackageVersion` and `GlobalPackageReference` with `Include` or `Update`, `Version` as an attribute or as a child element, and `$(Property)` references defined in a `PropertyGroup` of the same file. Package ids and property names match case-insensitively. A property defined more than once (for example under different Conditions) is reported as `ambiguous` and left alone.

## Reference

### `XmlDocument`

| Member | Description |
| --- | --- |
| `XmlDocument.parse(input, { namespaces })` | `input` is a string or `Uint8Array`. `namespaces` (default `true`) enables namespace checks. Throws `XmlSyntaxError` or `UnsupportedEncodingError`. |
| `root`, `declaration`, `source`, `bom`, `encoding` | The root element, the parsed XML declaration, the original text without BOM, whether a BOM was present, `'utf-8'` or `'latin1'`. |
| `select(path, from?)`, `selectOne(path, from?)` | Elements matching a path, in document order. |
| `walk(cb)` | Depth-first visit. |
| `text(el)`, `attr(el, name)`, `elements(el)`, `raw(node)` | Decoded text, decoded attribute value, child elements, exact source text of a node. |
| `setText(el, value, { cdata, keepPadding, replaceChildren })` | Replace the content. Keeps CDATA style if the element already uses CDATA. `keepPadding: true` keeps surrounding whitespace. Throws if the element has child elements unless `replaceChildren`. |
| `setAttr(el, name, value)` | Replace the value inside the existing quotes, or append a new attribute matching the tag layout. |
| `removeAttr(el, name)` | Remove the attribute and the whitespace before it. Returns `false` if absent. |
| `insertElement(parent, spec, { before, after, position })` | `spec` is `{ name, attrs?, text?, children? }`. Default position is after the last child element. |
| `removeElement(el)` | Remove the element; the whole line goes when it sits alone on it. |
| `renameElement(el, name)` | Rename open and close tags. |
| `toString()`, `toBuffer()` | Output with the edits spliced in. |
| `commit()` | Apply the edits and parse the result. |
| `pendingEdits`, `changed` | The edits as `{ start, end, text }` ranges of the original text. |

Nodes expose `start` and `end` offsets into `doc.source` (UTF-16 code unit indexes of the decoded text), plus `startTagEnd`, `endTagStart`, attribute `valueStart`/`valueEnd`, and so on. `tokenize(text)` is exported for callers who only want the position-tracking parser.

### Errors

| Class | When |
| --- | --- |
| `XmlSyntaxError` | Not well-formed XML 1.0 or violates namespace rules. Has `offset`, `line`, `column`. |
| `UnsupportedEncodingError` | UTF-16, UTF-32, invalid UTF-8, or a declared encoding other than UTF-8, US-ASCII and ISO-8859-1. |
| `EditError` | Invalid name, illegal character, undeclared prefix, foreign element, removing the root. |
| `EditConflictError` | Two pending edits overlap. |
| `QuerySyntaxError` | Unparseable path. |

### Escaping and style

- Text escapes `&` and `<`, and `>` only when the file already writes `&gt;` (always for `]]>`). A bare `\r` becomes `&#13;`, and `\n` is written as the file's newline.
- Attribute values escape the quote character in use as `&quot;` or `&apos;`. Tab, newline and CR are written as character references so they survive attribute normalization.
- New attributes use the quote character the element (then the file) uses most, switching to the other quote when the value contains it.
- The indent unit is the most common child-minus-parent indentation in the file. The newline is the file's majority newline.
- In ISO-8859-1 documents, characters above U+00FF are written as `&#x...;`.

## How it works

A single-pass tokenizer validates XML 1.0 well-formedness (names, character ranges, entity references, attribute uniqueness, comment and CDATA rules, one root, matching tags, namespace prefixes) and records the source range of every element, tag, attribute (name, quotes, value), text run, comment, CDATA section and processing instruction. Nothing is normalized. Edits are `(start, end, replacement)` ranges against that text. `toString()` sorts them and concatenates the untouched slices with the replacements, so bytes outside the ranges are copied, not regenerated. Overlaps are rejected when an edit is added.

## Limitations

- Offsets are UTF-16 code unit indexes into the decoded text. Output is byte-identical for UTF-8 and ISO-8859-1 input.
- UTF-16 and UTF-32 input is detected and rejected. Other legacy encodings are rejected.
- XML 1.1 documents are tokenized with XML 1.0 character rules.
- DTDs are scanned for entity names only. Custom entities are not expanded (`text()` returns them as written), and validation against a DTD or schema is not done.
- `setText` writes the given value as the whole content. `insertElement` after `setText` on the same element keeps both; `setText` after `insertElement` on the same element does not remove the inserted child.
- Removing an element and inserting next to it in the same session conflicts when the removal takes the whole line; call `commit()` between them.
- The query language is a small XPath subset. There are no axes, functions or `and`/`or` in predicates.
- Property resolution covers the file itself. A property inherited from a parent pom or a `Directory.Build.props` import is reported as `unresolved`.
- The whole document is held in memory.

## Compatibility

Run for this release: Node 24.20 on macOS (`npm test`, `npm run test:dist`). The CI workflow also runs the built `dist/` smoke tests on Node 20.6, 22 and 24; those runs are not part of the measurements above.

## Development

```sh
npm install
npm run corpus       # downloads the pinned real-world corpus into .corpus/ (gitignored)
npm run typecheck
npm test             # unit, corpus, property and fuzz tests; corpus tests skip loudly without .corpus/
npm run build && npm run test:dist
cd bench && npm install && cd .. && npm run bench   # incumbent comparison
```

`@xmldom/xmldom` is a dev dependency used as an independent well-formedness check. The corpus files are third-party and are fetched at test time from URLs pinned to commit SHAs and verified by sha256 (`test/corpus-manifest.json`); they are never committed.

## License

MIT. See [LICENSE](LICENSE).
