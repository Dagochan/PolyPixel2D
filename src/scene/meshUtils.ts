import type { Mesh, Vec2 } from './types'

export function edgeKey(a: number, b: number): string {
  return a < b ? `${a}_${b}` : `${b}_${a}`
}

export function parseEdgeKey(key: string): [number, number] {
  const [a, b] = key.split('_').map(Number)
  return [a, b]
}

export function getEdges(mesh: Mesh): [number, number][] {
  const seen = new Set<string>()
  const edges: [number, number][] = []
  for (const face of mesh.faces) {
    for (let i = 0; i < face.length; i++) {
      const a = face[i]
      const b = face[(i + 1) % face.length]
      const key = a < b ? `${a}_${b}` : `${b}_${a}`
      if (!seen.has(key)) {
        seen.add(key)
        edges.push(a < b ? [a, b] : [b, a])
      }
    }
  }
  return edges
}

/** Fan-triangulates each face (faces are expected to be convex, true for primitives). */
export function triangulate(mesh: Mesh): number[] {
  const indices: number[] = []
  for (const face of mesh.faces) {
    for (let i = 1; i < face.length - 1; i++) {
      indices.push(face[0], face[i], face[i + 1])
    }
  }
  return indices
}

/** Drop any vertex not referenced by at least one face, and reindex faces to match. */
export function pruneOrphanVertices(mesh: Mesh): Mesh {
  const used = new Set<number>()
  for (const face of mesh.faces) for (const i of face) used.add(i)
  if (used.size === mesh.vertices.length) return mesh // nothing to prune

  const oldToNew = new Map<number, number>()
  const vertices = mesh.vertices.filter((_, i) => used.has(i))
  let next = 0
  for (let i = 0; i < mesh.vertices.length; i++) {
    if (used.has(i)) oldToNew.set(i, next++)
  }
  const faces = mesh.faces.map((f) => f.map((i) => oldToNew.get(i)!))
  return { vertices, faces }
}

/** Merge `addition` into `base` as a disconnected island, offset by `at` (local mesh space). */
export function mergeMeshAsIsland(base: Mesh, addition: Mesh, at: { x: number; y: number }): Mesh {
  const offset = base.vertices.length
  const vertices = [
    ...base.vertices,
    ...addition.vertices.map((v) => ({ x: v.x + at.x, y: v.y + at.y })),
  ]
  const faces = [...base.faces, ...addition.faces.map((f) => f.map((i) => i + offset))]
  return { vertices, faces }
}

/** Standard ray-casting point-in-polygon test, works for convex or concave (single, non-
 *  self-intersecting) polygons. */
function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    const crosses = a.y > p.y !== b.y > p.y
    if (!crosses) continue
    const xAtY = a.x + ((p.y - a.y) / (b.y - a.y)) * (b.x - a.x)
    if (p.x < xAtY) inside = !inside
  }
  return inside
}

/** Is `p` inside any face of `mesh`? Each face is tested as its own (possibly concave) polygon,
 *  so this is correct for multi-island and non-convex meshes alike. */
export function pointInMesh(mesh: Mesh, p: Vec2): boolean {
  return mesh.faces.some((face) => pointInPolygon(p, face.map((i) => mesh.vertices[i])))
}

function closestPointOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  const t = lenSq > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq)) : 0
  return { x: a.x + dx * t, y: a.y + dy * t }
}

/** Clamp `p` to stay within the mesh's actual silhouette (not just its bounding box) — if it's
 *  already inside one of the mesh's faces, it's returned unchanged; otherwise it's projected to
 *  the nearest point on the mesh's boundary edges. */
export function clampToMesh(mesh: Mesh, p: Vec2): Vec2 {
  if (mesh.faces.length === 0) return p
  if (pointInMesh(mesh, p)) return p
  let closest = mesh.vertices[0] ?? p
  let bestDistSq = Infinity
  for (const [a, b] of getEdges(mesh)) {
    const candidate = closestPointOnSegment(p, mesh.vertices[a], mesh.vertices[b])
    const dx = candidate.x - p.x
    const dy = candidate.y - p.y
    const distSq = dx * dx + dy * dy
    if (distSq < bestDistSq) {
      bestDistSq = distSq
      closest = candidate
    }
  }
  return closest
}

export function getBounds(mesh: Mesh) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const v of mesh.vertices) {
    if (v.x < minX) minX = v.x
    if (v.y < minY) minY = v.y
    if (v.x > maxX) maxX = v.x
    if (v.y > maxY) maxY = v.y
  }
  return { minX, minY, maxX, maxY }
}

/** Bounding-box center, in the mesh's own local space, of just the given vertex indices (e.g.
 *  one island's `vertices`) — used to place an island name label near its silhouette. */
export function localBoundsCenter(mesh: Mesh, vertexIndices: number[]): Vec2 {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const i of vertexIndices) {
    const v = mesh.vertices[i]
    if (v.x < minX) minX = v.x
    if (v.y < minY) minY = v.y
    if (v.x > maxX) maxX = v.x
    if (v.y > maxY) maxY = v.y
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
}
