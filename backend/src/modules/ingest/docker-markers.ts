// SPDX-License-Identifier: AGPL-3.0-only
// Change markers for Docker fleets (Docker parity of ADR-062's markers), from a host's
// complete snapshot against its previous containers: a container re-created (same
// name, new container), its image changed, a Compose project brought up or down.

export interface DockerMarker {
  kind: 'recreate' | 'image' | 'compose';
  target: string;
  /** The Compose project ("" for standalone containers). */
  namespace: string;
  details: Record<string, unknown>;
}

export interface SeenContainer {
  uid: string;
  name: string;
  image: string;
  project: string;
}

export function dockerMarkers(
  host: string,
  before: SeenContainer[],
  after: SeenContainer[],
): DockerMarker[] {
  // The first snapshot of a host is its starting point, not a change.
  if (before.length === 0) return [];
  const out: DockerMarker[] = [];
  const prev = new Map(before.map((c) => [c.name, c]));
  for (const c of after) {
    const p = prev.get(c.name);
    if (!p || p.uid === c.uid) continue;
    const target = `Container/${host}/${c.name}`;
    out.push(
      p.image !== c.image
        ? { kind: 'image', target, namespace: c.project, details: { from: p.image, to: c.image } }
        : { kind: 'recreate', target, namespace: c.project, details: { image: c.image } },
    );
  }
  const projects = (list: SeenContainer[]) =>
    new Set(list.map((c) => c.project).filter((p) => p !== ''));
  const was = projects(before);
  const is = projects(after);
  for (const p of is)
    if (!was.has(p))
      out.push({
        kind: 'compose',
        target: `Compose/${host}/${p}`,
        namespace: p,
        details: { action: 'up' },
      });
  for (const p of was)
    if (!is.has(p))
      out.push({
        kind: 'compose',
        target: `Compose/${host}/${p}`,
        namespace: p,
        details: { action: 'down' },
      });
  return out;
}
