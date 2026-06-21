import type { Mesh } from './types'

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
