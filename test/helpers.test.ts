import assert from 'node:assert/strict';
import test from 'node:test';
import { EditError, XmlDocument, mavenDependencies, packageReferences, setMavenDependencyVersion, setPackageVersion } from '../src/index.ts';
import { assertWellFormed } from './helpers.ts';

const POM = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>org.p</groupId>
    <artifactId>parent</artifactId>
    <version>7</version>
  </parent>
  <artifactId>me</artifactId>
  <properties>
    <foo.version>1.2.3</foo.version>
    <alias.version>\${foo.version}</alias.version>
    <partial.version>\${foo.version}-SNAPSHOT</partial.version>
  </properties>
  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>org.x</groupId>
        <artifactId>foo</artifactId>
        <version>\${foo.version}</version>
      </dependency>
    </dependencies>
  </dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>org.x</groupId>
      <artifactId>foo</artifactId>
    </dependency>
    <dependency>
      <groupId>org.y</groupId>
      <artifactId>bar</artifactId>
      <version>\${alias.version}</version>
    </dependency>
    <dependency>
      <groupId>org.y</groupId>
      <artifactId>baz</artifactId>
      <version>\${partial.version}</version>
    </dependency>
    <dependency>
      <groupId>org.y</groupId>
      <artifactId>inherited</artifactId>
      <version>\${from.parent}</version>
    </dependency>
    <dependency>
      <groupId>org.y</groupId>
      <artifactId>plain</artifactId>
      <version>
        1.0
      </version>
    </dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin>
        <artifactId>maven-compiler-plugin</artifactId>
        <version>3.8.0</version>
        <configuration><dependency><groupId>org.y</groupId><artifactId>plain</artifactId><version>9</version></dependency></configuration>
      </plugin>
    </plugins>
  </build>
</project>
`;

test('mavenDependencies lists coordinates and resolves properties', () => {
  const d = XmlDocument.parse(POM);
  const deps = mavenDependencies(d);
  const by = (a: string) => deps.filter((x) => x.artifactId === a);
  assert.equal(by('foo').length, 2);
  assert.equal(by('foo')[0]!.resolved, '1.2.3');
  assert.equal(by('foo')[0]!.property, 'foo.version');
  assert.equal(by('bar')[0]!.resolved, '1.2.3');
  assert.equal(by('bar')[0]!.property, 'alias.version');
  assert.equal(by('plain')[0]!.resolved, '1.0');
  assert.equal(by('plain').length, 1, 'dependency inside <configuration> is not a coordinate');
  assert.equal(by('maven-compiler-plugin')[0]!.groupId, 'org.apache.maven.plugins');
  assert.equal(by('parent')[0]!.section, 'parent');
});

test('setMavenDependencyVersion edits the property, not the reference', () => {
  const d = XmlDocument.parse(POM);
  const res = setMavenDependencyVersion(d, 'org.x:foo', '2.0.0');
  assert.deepEqual(res.map((r) => [r.status, r.via]), [['edited', 'property'], ['no-version', undefined]]);
  const out = d.toString();
  assertWellFormed(out);
  assert.equal(out, POM.replace('<foo.version>1.2.3<', '<foo.version>2.0.0<'));
});

test('setMavenDependencyVersion follows property chains and reports what it cannot edit', () => {
  const d = XmlDocument.parse(POM);
  assert.equal(setMavenDependencyVersion(d, 'org.y:bar', '5')[0]!.status, 'edited');
  assert.equal(d.toString(), POM.replace('<foo.version>1.2.3<', '<foo.version>5<'));
  assert.equal(setMavenDependencyVersion(XmlDocument.parse(POM), 'org.y:baz', '5')[0]!.status, 'complex');
  assert.equal(setMavenDependencyVersion(XmlDocument.parse(POM), 'org.y:inherited', '5')[0]!.status, 'unresolved');
  assert.equal(setMavenDependencyVersion(XmlDocument.parse(POM), 'org.y:none', '5').length, 0);
  assert.throws(() => setMavenDependencyVersion(d, 'nocolon', '1'), EditError);
});

test('setMavenDependencyVersion edits direct versions with padding kept, and plugins and parent', () => {
  const d = XmlDocument.parse(POM);
  setMavenDependencyVersion(d, 'org.y:plain', '2.0');
  setMavenDependencyVersion(d, 'org.apache.maven.plugins:maven-compiler-plugin', '3.11.0');
  setMavenDependencyVersion(d, 'org.p:parent', '8');
  const out = d.toString();
  assertWellFormed(out);
  assert.equal(
    out,
    POM.replace('\n        1.0\n', '\n        2.0\n').replace('<version>3.8.0<', '<version>3.11.0<').replace('<version>7<', '<version>8<'),
  );
});

test('unchanged versions produce no edit', () => {
  const d = XmlDocument.parse(POM);
  assert.equal(setMavenDependencyVersion(d, 'org.p:parent', '7')[0]!.status, 'unchanged');
  assert.equal(d.changed, false);
});

test('project.version resolves to the project or the parent version', () => {
  const s = `<project>
  <parent><groupId>g</groupId><artifactId>p</artifactId><version>1</version></parent>
  <dependencies><dependency><groupId>g</groupId><artifactId>x</artifactId><version>\${project.version}</version></dependency></dependencies>
</project>`;
  const d = XmlDocument.parse(s);
  setMavenDependencyVersion(d, 'g:x', '2');
  assert.equal(d.toString(), s.replace('<version>1<', '<version>2<'));
});

const CSPROJ = `﻿<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <SerilogVersion>3.0.0</SerilogVersion>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.1" />
    <PackageReference Include="Serilog" Version="$(SerilogVersion)" />
    <PackageReference Include="Dapper">
      <Version>2.0.0</Version>
    </PackageReference>
    <PackageReference Include="xunit" />
    <PackageReference
      Include="Other"
      Version="1.0.0"
      PrivateAssets="all" />
    <PackageReference Include="Missing" Version="$(NotDefined)" />
  </ItemGroup>
</Project>
`;

test('packageReferences reads attribute, element and property versions', () => {
  const refs = packageReferences(XmlDocument.parse(CSPROJ));
  assert.deepEqual(
    refs.map((r) => [r.id, r.versionKind, r.resolved]),
    [
      ['Newtonsoft.Json', 'attribute', '13.0.1'],
      ['Serilog', 'attribute', '3.0.0'],
      ['Dapper', 'element', '2.0.0'],
      ['xunit', 'none', undefined],
      ['Other', 'attribute', '1.0.0'],
      ['Missing', 'attribute', undefined],
    ],
  );
});

test('setPackageVersion handles attribute, child element, property and multi-line tags', () => {
  const d = XmlDocument.parse(CSPROJ);
  assert.equal(setPackageVersion(d, 'newtonsoft.json', '13.0.3')[0]!.via, 'attribute');
  assert.equal(setPackageVersion(d, 'Serilog', '4.0.0')[0]!.via, 'property');
  assert.equal(setPackageVersion(d, 'Dapper', '2.1.0')[0]!.via, 'element');
  assert.equal(setPackageVersion(d, 'Other', '1.1.0')[0]!.status, 'edited');
  assert.equal(setPackageVersion(d, 'xunit', '2')[0]!.status, 'no-version');
  assert.equal(setPackageVersion(d, 'Missing', '2')[0]!.status, 'unresolved');
  const out = d.toString();
  assertWellFormed(out);
  assert.equal(
    out,
    CSPROJ.replace('Version="13.0.1"', 'Version="13.0.3"')
      .replace('>3.0.0<', '>4.0.0<')
      .replace('>2.0.0<', '>2.1.0<')
      .replace('Version="1.0.0"', 'Version="1.1.0"'),
  );
  assert.ok(out.startsWith('﻿'));
});

test('a property defined twice is reported as ambiguous', () => {
  const s = `<Project><PropertyGroup><V>1</V></PropertyGroup><PropertyGroup Condition="x"><V>2</V></PropertyGroup><ItemGroup><PackageReference Include="A" Version="$(V)"/></ItemGroup></Project>`;
  const d = XmlDocument.parse(s);
  assert.equal(setPackageVersion(d, 'A', '9')[0]!.status, 'ambiguous');
  assert.equal(d.changed, false);
});

test('central package management items', () => {
  const s = `<Project>\r\n  <ItemGroup>\r\n    <PackageVersion Include="A" Version="1" />\r\n    <PackageVersion Update="B" Version="2" />\r\n  </ItemGroup>\r\n</Project>\r\n`;
  const d = XmlDocument.parse(s);
  setPackageVersion(d, 'A', '3');
  setPackageVersion(d, 'B', '4');
  assert.equal(d.toString(), s.replace('Version="1"', 'Version="3"').replace('Version="2"', 'Version="4"'));
});
