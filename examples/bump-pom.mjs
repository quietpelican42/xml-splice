// Bump a dependency in a pom.xml and print the diff-sized change.
// Run after `npm run build`: node examples/bump-pom.mjs
import { XmlDocument, setMavenDependencyVersion } from '../dist/index.js';

const pom = `<?xml version="1.0" encoding="UTF-8"?>
<!-- keep this comment -->
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <properties>
    <guava.version>31.0-jre</guava.version>
  </properties>
  <dependencies>
    <dependency>
      <groupId>com.google.guava</groupId>
      <artifactId>guava</artifactId>
      <version>\${guava.version}</version>
    </dependency>
  </dependencies>
</project>
`;

const doc = XmlDocument.parse(pom);
const [result] = setMavenDependencyVersion(doc, 'com.google.guava:guava', '33.0.0-jre');
console.log(result.status, 'via', result.via, result.property);
doc.insertElement(doc.selectOne('project/properties'), { name: 'junit.version', text: '5.10.0' });

const out = doc.toString();
const a = pom.split('\n');
const b = out.split('\n');
console.log(`lines: ${a.length} -> ${b.length}`);
for (const line of b) if (!a.includes(line)) console.log('+', line);
for (const line of a) if (!b.includes(line)) console.log('-', line);
