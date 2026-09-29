import type { Element, XmlDocument } from './document.ts';
import { EditError } from './errors.ts';

export interface MavenDependency {
  groupId: string | undefined;
  artifactId: string | undefined;
  /** Version text exactly as written (trimmed), e.g. `${foo.version}`. */
  version: string | undefined;
  /** Version after following `${property}` references inside this file. */
  resolved: string | undefined;
  /** Property name when the version is a reference. */
  property: string | undefined;
  /** The element whose text holds the literal version (the property element for references). */
  target: Element | undefined;
  /** Where the coordinate appears. */
  section: 'dependency' | 'plugin' | 'parent' | 'extension';
  element: Element;
}

export interface MavenVersionResult {
  dependency: MavenDependency;
  status: 'edited' | 'unchanged' | 'no-version' | 'unresolved' | 'complex';
  via?: 'direct' | 'property';
  property?: string;
}

const child = (doc: XmlDocument, el: Element, name: string): Element | undefined => doc.elements(el).find((c) => c.local === name);
const txt = (doc: XmlDocument, el: Element | undefined): string | undefined => (el ? doc.text(el).trim() : undefined);

/** Properties defined in `project/properties`, plus the built-in project version names. Later duplicates are ignored. */
export function mavenProperties(doc: XmlDocument): Map<string, Element> {
  const map = new Map<string, Element>();
  const props = child(doc, doc.root, 'properties');
  if (props) for (const p of doc.elements(props)) if (!map.has(p.local)) map.set(p.local, p);
  const ownVersion = child(doc, doc.root, 'version');
  const parentEl = child(doc, doc.root, 'parent');
  const pv = parentEl ? child(doc, parentEl, 'version') : undefined;
  // Without its own <version>, the project inherits the parent's.
  const projectVersion = ownVersion ?? pv;
  if (projectVersion) for (const n of ['project.version', 'pom.version', 'version']) if (!map.has(n)) map.set(n, projectVersion);
  if (pv) for (const n of ['project.parent.version', 'parent.version']) if (!map.has(n)) map.set(n, pv);
  return map;
}

interface Resolved {
  property?: string;
  target?: Element;
  value?: string;
  complex?: boolean;
  unresolved?: boolean;
}

function resolve(doc: XmlDocument, versionEl: Element, props: Map<string, Element>): Resolved {
  let el = versionEl;
  let value = txt(doc, el) ?? '';
  let property: string | undefined;
  for (let hops = 0; hops < 10; hops++) {
    const m = /^\$\{([^}]+)\}$/.exec(value);
    if (!m) {
      if (value.includes('${')) return { property, target: el, value, complex: true };
      return { property, target: el, value };
    }
    const name = m[1]!;
    property ??= name;
    const next = props.get(name);
    if (!next) return { property, value, unresolved: true };
    if (next === el) return { property, value, unresolved: true };
    el = next;
    value = txt(doc, el) ?? '';
  }
  return { property, value, unresolved: true };
}

/** Every dependency, plugin, extension and parent coordinate in the file. */
export function mavenDependencies(doc: XmlDocument): MavenDependency[] {
  const props = mavenProperties(doc);
  const out: MavenDependency[] = [];
  doc.walk((el) => {
    if (el.local === 'configuration') return false;
    let section: MavenDependency['section'] | undefined;
    if (el.local === 'dependency' && el.parent?.local === 'dependencies') section = 'dependency';
    else if (el.local === 'plugin' && el.parent?.local === 'plugins') section = 'plugin';
    else if (el.local === 'extension' && el.parent?.local === 'extensions') section = 'extension';
    else if (el.local === 'parent' && el.parent === doc.root) section = 'parent';
    if (!section) return;
    const versionEl = child(doc, el, 'version');
    const dep: MavenDependency = {
      groupId: txt(doc, child(doc, el, 'groupId')) ?? (section === 'plugin' ? 'org.apache.maven.plugins' : undefined),
      artifactId: txt(doc, child(doc, el, 'artifactId')),
      version: txt(doc, versionEl),
      resolved: undefined,
      property: undefined,
      target: undefined,
      section,
      element: el,
    };
    if (versionEl) {
      const r = resolve(doc, versionEl, props);
      dep.property = r.property;
      if (!r.unresolved && !r.complex) {
        dep.resolved = r.value;
        dep.target = r.target;
      } else if (r.complex) {
        dep.resolved = r.value;
      }
    }
    out.push(dep);
  });
  return out;
}

/**
 * Set the version of every `groupId:artifactId` in the file. When the version is
 * a `${property}` reference, the property element is edited instead, so the
 * reference stays in place. References that cannot be resolved inside this file
 * (for example a property inherited from a parent pom) are reported, not edited.
 */
export function setMavenDependencyVersion(doc: XmlDocument, coordinate: string, version: string): MavenVersionResult[] {
  const m = /^([^:\s]+):([^:\s]+)$/.exec(coordinate);
  if (!m) throw new EditError(`coordinate must look like "groupId:artifactId", got "${coordinate}"`);
  const results: MavenVersionResult[] = [];
  for (const dep of mavenDependencies(doc)) {
    if (dep.groupId !== m[1] || dep.artifactId !== m[2]) continue;
    if (dep.version === undefined) {
      results.push({ dependency: dep, status: 'no-version' });
      continue;
    }
    const via: 'direct' | 'property' = dep.property ? 'property' : 'direct';
    if (!dep.target) {
      results.push({ dependency: dep, status: dep.resolved !== undefined ? 'complex' : 'unresolved', via, property: dep.property });
      continue;
    }
    if (dep.resolved === version) {
      results.push({ dependency: dep, status: 'unchanged', via, property: dep.property });
      continue;
    }
    doc.setText(dep.target, version, { keepPadding: true });
    results.push({ dependency: dep, status: 'edited', via, property: dep.property });
  }
  return results;
}
