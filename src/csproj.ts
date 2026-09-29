import type { Element, XmlDocument } from './document.ts';

export interface PackageRef {
  id: string;
  /** Version text as written (trimmed), e.g. `$(SerilogVersion)`. */
  version: string | undefined;
  /** Version after following `$(Property)` references inside this file. */
  resolved: string | undefined;
  /** Where the version is written. */
  versionKind: 'attribute' | 'element' | 'none';
  property: string | undefined;
  /** The element or attribute owner holding the literal version. */
  target: Element | undefined;
  kind: 'PackageReference' | 'PackageVersion' | 'GlobalPackageReference';
  /** `Include` or `Update`. */
  verb: 'Include' | 'Update';
  element: Element;
}

export interface PackageVersionResult {
  ref: PackageRef;
  status: 'edited' | 'unchanged' | 'no-version' | 'unresolved' | 'ambiguous';
  via?: 'attribute' | 'element' | 'property';
  property?: string;
}

const KINDS = new Set(['packagereference', 'packageversion', 'globalpackagereference']);
const ci = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** MSBuild properties defined in `PropertyGroup` elements. Names are case-insensitive, so keys are lower case. */
export function msbuildProperties(doc: XmlDocument): Map<string, Element[]> {
  const map = new Map<string, Element[]>();
  doc.walk((el) => {
    if (el.local === 'PropertyGroup') {
      for (const p of doc.elements(el)) {
        const k = p.local.toLowerCase();
        (map.get(k) ?? map.set(k, []).get(k)!).push(p);
      }
      return false;
    }
  });
  return map;
}

function attrCi(doc: XmlDocument, el: Element, name: string) {
  return el.attributes.find((a) => ci(a.name, name));
}

/** PackageReference, PackageVersion and GlobalPackageReference items with their version location. */
export function packageReferences(doc: XmlDocument): PackageRef[] {
  const props = msbuildProperties(doc);
  const out: PackageRef[] = [];
  doc.walk((el) => {
    if (!KINDS.has(el.local.toLowerCase())) return;
    const inc = attrCi(doc, el, 'Include');
    const upd = attrCi(doc, el, 'Update');
    const idAttr = inc ?? upd;
    if (!idAttr) return;
    const kind = ['PackageReference', 'PackageVersion', 'GlobalPackageReference'].find((k) => ci(k, el.local)) as PackageRef['kind'];
    const verAttr = attrCi(doc, el, 'Version');
    const verEl = doc.elements(el).find((c) => ci(c.local, 'Version'));
    let version: string | undefined;
    let versionKind: PackageRef['versionKind'] = 'none';
    if (verAttr) {
      version = verAttr.value.trim();
      versionKind = 'attribute';
    } else if (verEl) {
      version = doc.text(verEl).trim();
      versionKind = 'element';
    }
    const ref: PackageRef = {
      id: idAttr.value.trim(),
      version,
      resolved: version,
      versionKind,
      property: undefined,
      target: versionKind === 'none' ? undefined : versionKind === 'attribute' ? el : verEl,
      kind,
      verb: idAttr === inc ? 'Include' : 'Update',
      element: el,
    };
    if (version !== undefined) {
      const m = /^\$\(([^)]+)\)$/.exec(version);
      if (m) {
        ref.property = m[1];
        const defs = props.get(m[1]!.toLowerCase());
        if (defs && defs.length === 1) {
          ref.target = defs[0];
          ref.resolved = doc.text(defs[0]!).trim();
        } else {
          ref.target = undefined;
          ref.resolved = undefined;
        }
      }
    }
    out.push(ref);
  });
  return out;
}

/**
 * Set the version of a package (matched case-insensitively) in every
 * PackageReference/PackageVersion item in the file. Handles `Version="x"`,
 * a `<Version>` child element, and `$(Property)` references, which are edited at
 * the property definition. A property defined more than once (for example under
 * different Conditions) is reported as ambiguous and left alone.
 */
export function setPackageVersion(doc: XmlDocument, id: string, version: string): PackageVersionResult[] {
  const props = msbuildProperties(doc);
  const results: PackageVersionResult[] = [];
  for (const ref of packageReferences(doc)) {
    if (!ci(ref.id, id)) continue;
    if (ref.version === undefined) {
      results.push({ ref, status: 'no-version' });
      continue;
    }
    if (ref.property) {
      const defs = props.get(ref.property.toLowerCase());
      if (!defs || defs.length === 0) results.push({ ref, status: 'unresolved', via: 'property', property: ref.property });
      else if (defs.length > 1) results.push({ ref, status: 'ambiguous', via: 'property', property: ref.property });
      else if (ref.resolved === version) results.push({ ref, status: 'unchanged', via: 'property', property: ref.property });
      else {
        doc.setText(defs[0]!, version, { keepPadding: true });
        results.push({ ref, status: 'edited', via: 'property', property: ref.property });
      }
      continue;
    }
    if (ref.version === version) {
      results.push({ ref, status: 'unchanged', via: ref.versionKind === 'attribute' ? 'attribute' : 'element' });
      continue;
    }
    if (ref.versionKind === 'attribute') {
      const a = attrCi(doc, ref.element, 'Version')!;
      doc.setAttr(ref.element, a.name, version);
      results.push({ ref, status: 'edited', via: 'attribute' });
    } else {
      doc.setText(ref.target!, version, { keepPadding: true });
      results.push({ ref, status: 'edited', via: 'element' });
    }
  }
  return results;
}
