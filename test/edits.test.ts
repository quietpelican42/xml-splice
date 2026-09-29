import assert from 'node:assert/strict';
import test from 'node:test';
import { EditConflictError, EditError, UnsupportedEncodingError, XmlDocument } from '../src/index.ts';
import { assertWellFormed } from './helpers.ts';

const POM = `<?xml version="1.0" encoding="UTF-8"?>
<!-- header -->
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>
    <dependencies>
        <dependency>
            <groupId>org.x</groupId>
            <artifactId>foo</artifactId>
            <version>1.0</version>
        </dependency>
        <dependency>
            <groupId>org.x</groupId>
            <artifactId>bar</artifactId>
        </dependency>
    </dependencies>
</project>
`;

function edit(src: string, fn: (d: XmlDocument) => void): string {
  const d = XmlDocument.parse(src);
  fn(d);
  const out = d.toString();
  assertWellFormed(out);
  return out;
}

test('no edits: byte identical, including BOM and CRLF', () => {
  for (const s of [POM, '﻿' + POM, POM.replace(/\n/g, '\r\n'), '<a></a>', '<a  />\n\n\n', '<?xml version="1.0"?>\r<a/>']) {
    const d = XmlDocument.parse(s);
    assert.equal(d.toString(), s);
    assert.deepEqual([...d.toBuffer()], [...Buffer.from(s, 'utf8')]);
  }
});

test('query: predicates, indexes, descendants, namespaces', () => {
  const d = XmlDocument.parse(POM);
  assert.equal(d.select('project/dependencies/dependency').length, 2);
  assert.equal(d.text(d.selectOne('project/dependencies/dependency[artifactId="foo"]/version')!), '1.0');
  assert.equal(d.select('project/dependencies/dependency[artifactId="nope"]').length, 0);
  assert.equal(d.text(d.selectOne('/project/dependencies/dependency[2]/artifactId')!), 'bar');
  assert.equal(d.select('//artifactId').length, 2);
  assert.equal(d.select('project/dependencies/dependency[version]').length, 1);
  assert.equal(d.select('{http://maven.apache.org/POM/4.0.0}project').length, 1);
  assert.equal(d.select('project/*').length, 2);
  assert.throws(() => d.select('project/['));
  const seen: string[] = [];
  d.walk((el, depth) => {
    seen.push(`${depth}:${el.local}`);
    if (el.local === 'dependencies') return false;
  });
  assert.deepEqual(seen, ['0:project', '1:modelVersion', '1:dependencies']);
});

test('setText replaces only the text and keeps padding and CDATA style', () => {
  assert.equal(edit(POM, (d) => d.setText(d.selectOne('project/modelVersion')!, '4.1.0')), POM.replace('4.0.0</model', '4.1.0</model'));
  assert.equal(edit('<a>\n  old\n</a>', (d) => d.setText(d.root, 'new')), '<a>new</a>');
  assert.equal(edit('<a>\n  old\n</a>', (d) => d.setText(d.root, 'new', { keepPadding: true })), '<a>\n  new\n</a>');
  assert.equal(edit('<a><![CDATA[x]]></a>', (d) => d.setText(d.root, 'a<b')), '<a><![CDATA[a<b]]></a>');
  assert.equal(edit('<a><![CDATA[x]]></a>', (d) => d.setText(d.root, 'a]]>b')), '<a><![CDATA[a]]]]><![CDATA[>b]]></a>');
  assert.equal(edit('<a>x</a>', (d) => d.setText(d.root, 'a<b&c')), '<a>a&lt;b&amp;c</a>');
  assert.equal(edit('<a>x</a>', (d) => d.setText(d.root, 'a]]>b')), '<a>a]]&gt;b</a>');
  assert.equal(edit('<a>x</a>', (d) => d.setText(d.root, '')), '<a></a>');
  assert.equal(edit('<a>x</a>', (d) => d.setText(d.root, 'q', { cdata: true })), '<a><![CDATA[q]]></a>');
});

test('setText keeps <a></a> and <a/> forms', () => {
  assert.equal(edit('<r><a></a><b/></r>', (d) => d.setText(d.selectOne('r/a')!, 'x')), '<r><a>x</a><b/></r>');
  assert.equal(edit('<r><a></a><b/></r>', (d) => d.setText(d.selectOne('r/b')!, 'x')), '<r><a></a><b>x</b></r>');
  assert.equal(edit('<r><b x="1" /></r>', (d) => d.setText(d.selectOne('r/b')!, 'x')), '<r><b x="1">x</b></r>');
  assert.equal(edit('<r><b/></r>', (d) => d.setText(d.selectOne('r/b')!, '')), '<r><b/></r>');
});

test('setText leaves an entity-style value alone when the value is unchanged', () => {
  const s = '<a>x &amp; y</a>';
  assert.equal(edit(s, (d) => d.setText(d.root, 'x & y')), s);
});

test('setText refuses to drop child elements unless told to', () => {
  const d = XmlDocument.parse('<a><b/></a>');
  assert.throws(() => d.setText(d.root, 'x'), EditError);
  d.setText(d.root, 'x', { replaceChildren: true });
  assert.equal(d.toString(), '<a>x</a>');
});

test('setText follows the file newline style', () => {
  assert.equal(edit('<a>\r\nx\r\n</a>', (d) => d.setText(d.root, 'l1\nl2', { keepPadding: true })), '<a>\r\nl1\r\nl2\r\n</a>');
  assert.equal(edit('<a>x</a>', (d) => d.setText(d.root, 'l1\nl2')), '<a>l1\nl2</a>');
  assert.equal(edit('<a>x</a>', (d) => d.setText(d.root, 'a\rb')), '<a>a&#13;b</a>');
});

test('setAttr keeps the quote character of the existing value', () => {
  assert.equal(edit(`<a x='1' y="2"/>`, (d) => d.setAttr(d.root, 'x', 'v')), `<a x='v' y="2"/>`);
  assert.equal(edit(`<a x='1' y="2"/>`, (d) => d.setAttr(d.root, 'y', "it's")), `<a x='1' y="it's"/>`);
  assert.equal(edit(`<a x='1'/>`, (d) => d.setAttr(d.root, 'x', "it's")), `<a x='it&apos;s'/>`);
  assert.equal(edit(`<a x="1"/>`, (d) => d.setAttr(d.root, 'x', 'say "hi"')), `<a x="say &quot;hi&quot;"/>`);
  assert.equal(edit(`<a x="1"/>`, (d) => d.setAttr(d.root, 'x', 'a\nb\t<&>')), `<a x="a&#10;b&#9;&lt;&amp;>"/>`);
});

test('setAttr escapes ">" only when the file does', () => {
  assert.equal(edit(`<a x="1" y="a&gt;b"/>`, (d) => d.setAttr(d.root, 'x', '>')), `<a x="&gt;" y="a&gt;b"/>`);
});

test('setAttr on a new attribute follows the tag layout', () => {
  assert.equal(edit(`<a x = "1"/>`, (d) => d.setAttr(d.root, 'y', '2')), `<a x = "1" y = "2"/>`);
  assert.equal(edit(`<a\n  x="1"\n  y="2">t</a>`, (d) => d.setAttr(d.root, 'z', '3')), `<a\n  x="1"\n  y="2"\n  z="3">t</a>`);
  assert.equal(edit(`<a x='1' y='2'/>`, (d) => d.setAttr(d.root, 'z', '3')), `<a x='1' y='2' z='3'/>`);
  assert.equal(edit(`<a x="1" />`, (d) => d.setAttr(d.root, 'z', '3')), `<a x="1" z="3" />`);
  assert.equal(edit(`<a></a>`, (d) => d.setAttr(d.root, 'z', '3')), `<a z="3"></a>`);
  assert.equal(edit(`<a x='1'/>`, (d) => d.setAttr(d.root, 'z', "it's")), `<a x='1' z="it's"/>`);
});

test('setAttr validates names and namespace prefixes', () => {
  const d = XmlDocument.parse('<a xmlns:p="u"/>');
  assert.throws(() => d.setAttr(d.root, '1bad', 'x'), EditError);
  assert.throws(() => d.setAttr(d.root, 'q:x', 'x'), /not declared/);
  d.setAttr(d.root, 'p:x', 'y');
  assert.equal(d.toString(), '<a xmlns:p="u" p:x="y"/>');
  assert.throws(() => d.setAttr(d.root, 'k', 'a\u0000b'), EditError);
});

test('removeAttr removes the attribute and its leading whitespace only', () => {
  assert.equal(edit(`<a x="1" y="2"/>`, (d) => void d.removeAttr(d.root, 'x')), `<a y="2"/>`);
  assert.equal(edit(`<a x="1" y="2"/>`, (d) => void d.removeAttr(d.root, 'y')), `<a x="1"/>`);
  assert.equal(edit(`<a\n  x="1"\n  y="2"\n  z="3">t</a>`, (d) => void d.removeAttr(d.root, 'y')), `<a\n  x="1"\n  z="3">t</a>`);
  assert.equal(edit(`<a x="1" />`, (d) => void d.removeAttr(d.root, 'x')), `<a />`);
  const d = XmlDocument.parse('<a x="1"/>');
  assert.equal(d.removeAttr(d.root, 'nope'), false);
});

test('removeAttr after setAttr on a new attribute cancels it', () => {
  const d = XmlDocument.parse('<a x="1"/>');
  d.setAttr(d.root, 'y', '2');
  assert.equal(d.removeAttr(d.root, 'y'), true);
  assert.equal(d.toString(), '<a x="1"/>');
});

test('insertElement matches indentation, tabs and CRLF', () => {
  const out = edit(POM, (d) => d.insertElement(d.selectOne('project')!, { name: 'packaging', text: 'jar' }));
  assert.equal(out, POM.replace('    </dependencies>\n', '    </dependencies>\n    <packaging>jar</packaging>\n'));

  const nested = edit(POM, (d) =>
    d.insertElement(d.selectOne('project/dependencies')!, { name: 'dependency', children: [{ name: 'groupId', text: 'g' }, { name: 'artifactId', text: 'a' }] }),
  );
  assert.ok(
    nested.includes(
      '        </dependency>\n        <dependency>\n            <groupId>g</groupId>\n            <artifactId>a</artifactId>\n        </dependency>\n    </dependencies>',
    ),
    nested,
  );

  const tabs = '<a>\n\t<b/>\n</a>';
  assert.equal(edit(tabs, (d) => d.insertElement(d.root, { name: 'c' })), '<a>\n\t<b/>\n\t<c/>\n</a>');
  const crlf = '<a>\r\n  <b/>\r\n</a>\r\n';
  assert.equal(edit(crlf, (d) => d.insertElement(d.root, { name: 'c', text: 'x' })), '<a>\r\n  <b/>\r\n  <c>x</c>\r\n</a>\r\n');
  assert.equal(edit(tabs, (d) => d.insertElement(d.root, { name: 'c' }, { position: 'first' })), '<a>\n\t<c/>\n\t<b/>\n</a>');
  assert.equal(edit(tabs, (d) => d.insertElement(d.root, { name: 'c' }, { before: d.selectOne('a/b')! })), '<a>\n\t<c/>\n\t<b/>\n</a>');
});

test('insertElement into empty parents expands them with detected indent unit', () => {
  const src = '<a>\n    <b/>\n    <c></c>\n    <d>\n    </d>\n</a>';
  assert.equal(
    edit(src, (d) => d.insertElement(d.selectOne('a/b')!, { name: 'x', attrs: { k: 'v' } })),
    '<a>\n    <b>\n        <x k="v"/>\n    </b>\n    <c></c>\n    <d>\n    </d>\n</a>',
  );
  assert.equal(
    edit(src, (d) => d.insertElement(d.selectOne('a/c')!, { name: 'x' })),
    '<a>\n    <b/>\n    <c>\n        <x/>\n    </c>\n    <d>\n    </d>\n</a>',
  );
  assert.equal(
    edit(src, (d) => d.insertElement(d.selectOne('a/d')!, { name: 'x' })),
    '<a>\n    <b/>\n    <c></c>\n    <d>\n        <x/>\n    </d>\n</a>',
  );
  // two inserts into the same self-closing parent stay in call order
  assert.equal(
    edit(src, (d) => {
      d.insertElement(d.selectOne('a/b')!, { name: 'x' });
      d.insertElement(d.selectOne('a/b')!, { name: 'y' });
    }),
    '<a>\n    <b>\n        <x/>\n        <y/>\n    </b>\n    <c></c>\n    <d>\n    </d>\n</a>',
  );
});

test('insertElement inline when the parent is not laid out on lines', () => {
  assert.equal(edit('<a><b/></a>', (d) => d.insertElement(d.root, { name: 'c' })), '<a><b/><c/></a>');
  assert.equal(edit('<a>text</a>', (d) => d.insertElement(d.root, { name: 'c' })), '<a>text<c/></a>');
  assert.equal(edit('<r><a/></r>', (d) => d.insertElement(d.selectOne('r/a')!, { name: 'c' })), '<r><a><c/></a></r>');
});

test('insertElement after a trailing comment-only parent and mixed layouts', () => {
  assert.equal(edit('<a>\n  <!-- c -->\n</a>', (d) => d.insertElement(d.root, { name: 'x' })), '<a>\n  <!-- c -->\n  <x/>\n</a>');
});

test('insertElement rejects bad names and undeclared prefixes', () => {
  const d = XmlDocument.parse('<a/>');
  assert.throws(() => d.insertElement(d.root, { name: 'a b' }), EditError);
  assert.throws(() => d.insertElement(d.root, { name: 'p:x' }), /not declared/);
});

test('removeElement takes its own line when alone', () => {
  assert.equal(
    edit(POM, (d) => d.removeElement(d.selectOne('project/modelVersion')!)),
    POM.replace('    <modelVersion>4.0.0</modelVersion>\n', ''),
  );
  const multi = edit(POM, (d) => d.removeElement(d.selectOne('project/dependencies/dependency[2]')!));
  assert.equal(multi, POM.replace('        <dependency>\n            <groupId>org.x</groupId>\n            <artifactId>bar</artifactId>\n        </dependency>\n', ''));
  assert.equal(
    edit('<a>\r\n  <b/>\r\n  <c/>\r\n</a>', (d) => d.removeElement(d.selectOne('a/b')!)),
    '<a>\r\n  <c/>\r\n</a>',
  );
});

test('removeElement removes only the element when it shares a line', () => {
  assert.equal(edit('<a><b/><c/></a>', (d) => d.removeElement(d.selectOne('a/b')!)), '<a><c/></a>');
  assert.equal(edit('<a>\n  <b/> <!-- k -->\n</a>', (d) => d.removeElement(d.selectOne('a/b')!)), '<a>\n   <!-- k -->\n</a>');
  const d = XmlDocument.parse('<a/>');
  assert.throws(() => d.removeElement(d.root), EditError);
});

test('renameElement renames open and close tags together', () => {
  assert.equal(edit('<a><b x="1">t</b ></a>', (d) => d.renameElement(d.selectOne('a/b')!, 'c')), '<a><c x="1">t</c ></a>');
  assert.equal(edit('<a><b/></a>', (d) => d.renameElement(d.selectOne('a/b')!, 'c')), '<a><c/></a>');
  assert.equal(edit('<x:a xmlns:x="u"><x:b>1</x:b></x:a>', (d) => d.renameElement(d.selectOne('a/b')!, 'x:c')), '<x:a xmlns:x="u"><x:c>1</x:c></x:a>');
  const d = XmlDocument.parse('<a/>');
  assert.throws(() => d.renameElement(d.root, 'p:z'), /not declared/);
  assert.throws(() => d.renameElement(d.root, '9'), EditError);
});

test('rename combined with text and insert on a self-closing element', () => {
  const out = edit('<r>\n  <a/>\n</r>', (d) => {
    const a = d.selectOne('r/a')!;
    d.renameElement(a, 'z');
    d.insertElement(a, { name: 'k' });
  });
  assert.equal(out, '<r>\n  <z>\n    <k/>\n  </z>\n</r>');
});

test('edits are recorded against the original text and conflicts are reported', () => {
  const d = XmlDocument.parse('<a>\n  <b>1</b>\n  <c>2</c>\n</a>');
  d.setText(d.selectOne('a/b')!, 'x');
  d.setText(d.selectOne('a/c')!, 'y');
  d.setText(d.selectOne('a/c')!, 'z');
  assert.equal(d.toString(), '<a>\n  <b>x</b>\n  <c>z</c>\n</a>');
  assert.throws(() => d.removeElement(d.selectOne('a/c')!), EditConflictError);
  assert.deepEqual(
    d.pendingEdits.map((e) => e.text),
    ['x', 'z'],
  );
  assert.equal(d.commit().toString(), d.toString());
  assert.equal(d.changed, true);
});

test('foreign elements are rejected', () => {
  const a = XmlDocument.parse('<a><b/></a>');
  const b = XmlDocument.parse('<a><b/></a>');
  assert.throws(() => a.setText(b.root, 'x'), /does not belong/);
});

test('BOM and encoding survive; UTF-16 is rejected clearly', () => {
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<?xml version="1.0"?>\n<a>é</a>\n')]);
  const d = XmlDocument.parse(withBom);
  assert.equal(d.bom, true);
  d.setText(d.root, 'ü');
  assert.deepEqual([...d.toBuffer()].slice(0, 3), [0xef, 0xbb, 0xbf]);
  assert.equal(Buffer.from(d.toBuffer()).toString('utf8'), '﻿<?xml version="1.0"?>\n<a>ü</a>\n');

  const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<a/>', 'utf16le')]);
  assert.throws(() => XmlDocument.parse(u16), (e: unknown) => e instanceof UnsupportedEncodingError && /UTF-16/.test(e.message));
  const u16nobom = Buffer.from('<?xml version="1.0"?><a/>', 'utf16le');
  assert.throws(() => XmlDocument.parse(u16nobom), /UTF-16/);
  assert.throws(() => XmlDocument.parse(Buffer.from('<a/>', 'utf16le')), /UTF-16/);
  assert.throws(() => XmlDocument.parse(Buffer.from('\n<a/>', 'utf16le')), /UTF-16/);
  assert.throws(() => XmlDocument.parse(Buffer.from([0, 0x3c, 0, 0x61, 0, 0x2f, 0, 0x3e])), /UTF-16/);
  assert.throws(() => XmlDocument.parse(Buffer.from('<?xml version="1.0" encoding="Shift_JIS"?><a/>')), /not supported/);
  assert.throws(() => XmlDocument.parse(Buffer.from([0x3c, 0x61, 0x3e, 0xff, 0x3c, 0x2f, 0x61, 0x3e])), /not valid UTF-8/);
});

test('ISO-8859-1 documents round-trip and escape characters they cannot hold', () => {
  const bytes = Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?>\n<a>caf\xe9</a>\n', 'latin1');
  const d = XmlDocument.parse(bytes);
  assert.equal(d.text(d.root), 'café');
  assert.deepEqual([...d.toBuffer()], [...bytes]);
  d.setText(d.root, 'é€');
  assert.equal(Buffer.from(d.toBuffer()).toString('latin1'), '<?xml version="1.0" encoding="ISO-8859-1"?>\n<a>\xe9&#x20AC;</a>\n');
});

test('string input with a leading BOM keeps it', () => {
  const d = XmlDocument.parse('﻿<a>x</a>');
  d.setText(d.root, 'y');
  assert.equal(d.toString(), '﻿<a>y</a>');
});
