/**
 * Plain-JS checks against the built package, so they run on every Node version
 * in `engines` (the TypeScript suite needs type stripping and only runs on 24+).
 *
 *   npm run build && node --test test/smoke.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const { XmlDocument, XmlSyntaxError, UnsupportedEncodingError, setMavenDependencyVersion, setPackageVersion } = await import('../dist/index.js');

const POM = `﻿<?xml version="1.0"?>
<project>
    <properties>
        <a.version>1.0</a.version>
    </properties>
    <dependencies>
        <dependency>
            <groupId>g</groupId>
            <artifactId>a</artifactId>
            <version>\${a.version}</version>
        </dependency>
    </dependencies>
</project>
`;

test('round trip is byte identical', () => {
  assert.equal(XmlDocument.parse(POM).toString(), POM);
});

test('edits splice into the original', () => {
  const d = XmlDocument.parse(POM);
  d.setText(d.selectOne('project/properties/a.version'), '2.0');
  d.insertElement(d.selectOne('project/properties'), { name: 'b.version', text: '3' });
  d.removeElement(d.selectOne('project/dependencies'));
  assert.equal(
    d.toString(),
    POM.replace('1.0</a.version>', '2.0</a.version>\n        <b.version>3</b.version>').replace(/    <dependencies>[\s\S]*<\/dependencies>\n/, ''),
  );
});

test('maven property resolution edits the property', () => {
  const d = XmlDocument.parse(POM);
  const [r] = setMavenDependencyVersion(d, 'g:a', '9');
  assert.equal(r.status, 'edited');
  assert.equal(d.toString(), POM.replace('>1.0<', '>9<'));
});

test('csproj version attribute', () => {
  const d = XmlDocument.parse('<Project><ItemGroup><PackageReference Include="X" Version="1" /></ItemGroup></Project>');
  setPackageVersion(d, 'x', '2');
  assert.equal(d.toString(), '<Project><ItemGroup><PackageReference Include="X" Version="2" /></ItemGroup></Project>');
});

test('errors are typed', () => {
  assert.throws(() => XmlDocument.parse('<a><b></a>'), XmlSyntaxError);
  assert.throws(() => XmlDocument.parse(Buffer.from('<a/>', 'utf16le')), UnsupportedEncodingError);
});
