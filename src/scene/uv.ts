import type { Mesh, UvIslandTransform, Vec2 } from './types'

export interface Island {
  faces: number[]
  vertices: number[]
}

const IDENTITY_TRANSFORM: UvIslandTransform = { offsetX: 0, offsetY: 0, scale: 1 }

/** Group faces into connected components (faces sharing a vertex are in the same island). */
export function findIslands(mesh: Mesh): Island[] {
  const vertexFaces = new Map<number, number[]>()
  mesh.faces.forEach((face, fi) => {
    for (const v of face) {
      const list = vertexFaces.get(v)
      if (list) list.push(fi)
      else vertexFaces.set(v, [fi])
    }
  })

  const visited = new Array(mesh.faces.length).fill(false)
  const islands: Island[] = []
  for (let start = 0; start < mesh.faces.length; start++) {
    if (visited[start]) continue
    const faces: number[] = []
    const vertexSet = new Set<number>()
    const queue = [start]
    visited[start] = true
    while (queue.length > 0) {
      const fi = queue.pop()!
      faces.push(fi)
      for (const v of mesh.faces[fi]) {
        vertexSet.add(v)
        for (const neighbor of vertexFaces.get(v) ?? []) {
          if (!visited[neighbor]) {
            visited[neighbor] = true
            queue.push(neighbor)
          }
        }
      }
    }
    islands.push({ faces, vertices: Array.from(vertexSet) })
  }
  return islands
}

/** This island's own bounding box, normalized to 0..1 — before any manual transform. */
export function islandBaseUV(mesh: Mesh, island: Island): Map<number, Vec2> {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const i of island.vertices) {
    const v = mesh.vertices[i]
    if (v.x < minX) minX = v.x
    if (v.y < minY) minY = v.y
    if (v.x > maxX) maxX = v.x
    if (v.y > maxY) maxY = v.y
  }
  const w = maxX - minX || 1
  const h = maxY - minY || 1
  const uv = new Map<number, Vec2>()
  for (const i of island.vertices) {
    const v = mesh.vertices[i]
    uv.set(i, { x: (v.x - minX) / w, y: (v.y - minY) / h })
  }
  return uv
}

/** Final per-vertex UVs: each island normalized to its own bounding box, then offset/scaled
 *  by its manual transform (defaults to identity — i.e. each island fills its own 0..1 square). */
export function computeUVs(mesh: Mesh, transforms?: UvIslandTransform[]): Vec2[] {
  const islands = findIslands(mesh)
  const out = new Array<Vec2>(mesh.vertices.length)
  islands.forEach((island, i) => {
    const base = islandBaseUV(mesh, island)
    const t = transforms?.[i] ?? IDENTITY_TRANSFORM
    for (const [vi, uv] of base) {
      out[vi] = { x: uv.x * t.scale + t.offsetX, y: uv.y * t.scale + t.offsetY }
    }
  })
  return out
}
