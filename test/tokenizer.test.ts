import assert from 'node:assert/strict';
import test from 'node:test';
import { XmlDocument, XmlSyntaxError, tokenize } from '../src/index.ts';

const good: [string, string][] = [
  ['minimal', '<a/>'],
  ['declaration + comment + pi', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<!-- c --><?pi data?>\n<a/>\n<!-- after -->\n'],
  ['attributes both quotes', `<a x="1" y='2' z = "3"/>`],
  ['multi-line tag', '<a\n  x="1"\n  y="2"\n/>'],
  ['entities', '<a t="&lt;&amp;&#65;&#x42;">&gt;&quot;&apos;&#x1F600;</a>'],
  ['cdata', '<a><![CDATA[ <not> & markup ]]></a>'],
  ['nested and mixed', '<a>text<b>x</b>tail<c/><!--k--></a>'],
  ['namespaces', '<p:a xmlns:p="urn:p" xmlns="urn:d"><b p:x="1"/></p:a>'],
  ['doctype with subset', '<!DOCTYPE a [ <!ENTITY e "v"> <!-- ] --> ]>\n<a>&e;</a>'],
  ['doctype public', '<!DOCTYPE a PUBLIC "-//X//Y" "http://x/y.dtd">\n<a/>'],
  ['unicode names', '<données été="1"/>'],
  ['end tag whitespace', '<a></a >'],
  ['gt in attribute', '<a x=">"/>'],
];
for (const [name, src] of good) {
  test(`accepts: ${name}`, () => {
    const r = tokenize(src);
    assert.equal(src[r.root.start], '<');
    assert.ok(r.root.end > r.root.start);
  });
}

const bad: [string, string, RegExp][] = [
  ['empty', '', /no root element/],
  ['text only', 'hello', /text is not allowed before/],
  ['unclosed', '<a><b></a>', /mismatched end tag/],
  ['unclosed root', '<a>', /unclosed element <a>/],
  ['two roots', '<a/><b/>', /only one root/],
  ['text after root', '<a/>x', /not allowed after the root/],
  ['unquoted attr', '<a x=1/>', /must be quoted/],
  ['duplicate attr', '<a x="1" x="2"/>', /duplicate attribute/],
  ['lt in attr', '<a x="<"/>', /"<" is not allowed/],
  ['missing ws between attrs', '<a x="1"y="2"/>', /expected whitespace/],
  ['bare ampersand', '<a>&</a>', /must start a reference/],
  ['undeclared entity', '<a>&nope;</a>', /undeclared entity/],
  ['illegal char ref', '<a>&#0;</a>', /not a legal XML character/],
  ['control char', '<a>\u0001</a>', /illegal character U\+0001/],
  ['double dash comment', '<a><!-- a -- b --></a>', /"--" is not allowed/],
  ['unterminated comment', '<a><!-- x</a>', /unterminated comment/],
  ['cdata end in text', '<a>]]></a>', /"\]\]>" is not allowed/],
  ['unterminated cdata', '<a><![CDATA[x</a>', /unterminated CDATA/],
  ['reserved pi', '<a/><?xml version="1.0"?>', /reserved processing instruction/],
  ['decl not first', ' <?xml version="1.0"?><a/>', /reserved processing instruction/],
  ['bad decl', '<?xml version=1.0?><a/>', /malformed XML declaration/],
  ['unbound prefix', '<p:a/>', /unbound namespace prefix "p"/],
  ['unbound attr prefix', '<a p:x="1"/>', /unbound namespace prefix "p"/],
  ['dup expanded attr', '<a xmlns:p="u" xmlns:q="u" p:x="1" q:x="2"/>', /duplicate attribute/],
  ['bad name', '<1a/>', /expected element name/],
  ['lone surrogate', '<a>\ud800</a>', /illegal character/],
  ['bad end tag', '<a></a', /expected ">"/],
  ['doctype after root', '<a/><!DOCTYPE a>', /content is not allowed after|only one root/],
];
for (const [name, src, re] of bad) {
  test(`rejects: ${name}`, () => {
    assert.throws(() => tokenize(src), (e: unknown) => e instanceof XmlSyntaxError && re.test(e.message));
  });
}

test('errors carry line and column', () => {
  try {
    tokenize('<a>\n  <b>\n  </c>\n</a>');
    assert.fail('should throw');
  } catch (e) {
    assert.ok(e instanceof XmlSyntaxError);
    assert.equal(e.line, 3);
    assert.equal(e.column, 3);
    assert.match(e.message, /line 3, column 3/);
  }
});

test('namespaces can be switched off', () => {
  assert.doesNotThrow(() => tokenize('<p:a/>', { namespaces: false }));
  assert.throws(() => tokenize('<p:a/>'));
});

test('records exact offsets', () => {
  const s = `<a  x = "1"\ty='2'>hi<b/><!--c--></a>`;
  const { root } = tokenize(s);
  assert.equal(s.slice(root.start, root.end), s);
  const [x, y] = root.attributes;
  assert.equal(s.slice(x!.start, x!.end), 'x = "1"');
  assert.equal(s.slice(x!.valueStart, x!.valueEnd), '1');
  assert.equal(x!.quote, '"');
  assert.equal(s.slice(y!.start, y!.end), `y='2'`);
  assert.equal(y!.quote, "'");
  assert.equal(s.slice(root.startTagEnd, root.endTagStart), 'hi<b/><!--c-->');
  const b = root.children[1]!;
  assert.equal(b.type, 'element');
  assert.equal(s.slice(b.start, b.end), '<b/>');
});

test('resolves namespaces', () => {
  const d = XmlDocument.parse('<p:a xmlns:p="urn:p" xmlns="urn:d"><b p:x="1" y="2"/></p:a>');
  const b = d.selectOne('a/b')!;
  assert.equal(d.root.uri, 'urn:p');
  assert.equal(b.uri, 'urn:d');
  assert.equal(b.attributes[0]!.uri, 'urn:p');
  assert.equal(b.attributes[1]!.uri, '');
});
