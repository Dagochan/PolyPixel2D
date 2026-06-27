import type { Mesh, UvIslandTransform, Vec2 } from './types'
import { edgeKey } from './meshUtils'

export interface Island {
  faces: number[]
  vertices: number[]
}

/** The position UV unwrap math should use for vertex `i`: its frozen rest-pose position if one
 *  has been seeded, else its live position (e.g. a vertex from before this field existed). */
function uvPosition(mesh: Mesh, baseVertices: Record<number, Vec2> | undefined, i: number): Vec2 {
  return baseVertices?.[i] ?? mesh.vertices[i]
}

function finiteOr(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** Backfill any field missing or non-finite in a stored transform — e.g. `rotation` on a
 *  project saved before it existed (undefined), or any field that ended up NaN/Infinity from a
 *  bad computation — so stale/corrupted data can never propagate instead of just resetting it. */
export function normalizeIslandTransform(
  t: Partial<UvIslandTransform> | undefined,
  fallback: UvIslandTransform,
): UvIslandTransform {
  return {
    offsetX: finiteOr(t?.offsetX, fallback.offsetX),
    offsetY: finiteOr(t?.offsetY, fallback.offsetY),
    scale: finiteOr(t?.scale, fallback.scale),
    rotation: finiteOr(t?.rotation, fallback.rotation),
    excludeFromDensityMatch: t?.excludeFromDensityMatch ?? fallback.excludeFromDensityMatch ?? false,
  }
}

/** The island's real-world (mesh-space) size — its longer bounding-box side. */
export function islandFootprint(mesh: Mesh, island: Island, baseVertices?: Record<number, Vec2>): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const i of island.vertices) {
    const v = uvPosition(mesh, baseVertices, i)
    if (v.x < minX) minX = v.x
    if (v.y < minY) minY = v.y
    if (v.x > maxX) maxX = v.x
    if (v.y > maxY) maxY = v.y
  }
  return Math.max(maxX - minX, maxY - minY) || 1
}

/**
 * Initial, non-overlapping placement for islands that don't have a manual transform yet: a
 * simple grid (not true bin-packing), one island per cell, each scaled relative to the largest
 * island's real-world size so a torso doesn't end up the same UV size as a fingertip. Anything
 * past this is left to the user via the UV editor — this only avoids everything landing in the
 * same 0..1 square by default.
 */
export function defaultIslandTransforms(
  mesh: Mesh,
  islands: Island[],
  baseVertices?: Record<number, Vec2>,
): UvIslandTransform[] {
  if (islands.length === 0) return []
  const footprints = islands.map((island) => islandFootprint(mesh, island, baseVertices))
  const maxFootprint = Math.max(...footprints)
  const cols = Math.ceil(Math.sqrt(islands.length))
  const rows = Math.ceil(islands.length / cols)
  const cellW = 1 / cols
  const cellH = 1 / rows
  const cellSize = Math.min(cellW, cellH)

  return islands.map((_, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    const scale = (footprints[i] / maxFootprint) * cellSize
    return {
      offsetX: col * cellW + (cellW - scale) / 2,
      offsetY: 1 - (row + 1) * cellH + (cellH - scale) / 2,
      scale,
      rotation: 0,
    }
  })
}

/**
 * Group faces into connected components for UV purposes: two faces are in the same island if
 * they share a full edge. A mesh made of several genuinely disconnected pieces (e.g. separate
 * primitives merged into one object) gets one island per piece.
 */
export function findIslands(mesh: Mesh): Island[] {
  const edgeFaces = new Map<string, number[]>()
  mesh.faces.forEach((face, fi) => {
    for (let i = 0; i < face.length; i++) {
      const a = face[i]
      const b = face[(i + 1) % face.length]
      const key = edgeKey(a, b)
      const list = edgeFaces.get(key)
      if (list) list.push(fi)
      else edgeFaces.set(key, [fi])
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
      const face = mesh.faces[fi]
      for (const v of face) vertexSet.add(v)
      for (let i = 0; i < face.length; i++) {
        const a = face[i]
        const b = face[(i + 1) % face.length]
        const key = edgeKey(a, b)
        for (const neighbor of edgeFaces.get(key) ?? []) {
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
export function islandBaseUV(mesh: Mesh, island: Island, baseVertices?: Record<number, Vec2>): Map<number, Vec2> {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const i of island.vertices) {
    const v = uvPosition(mesh, baseVertices, i)
    if (v.x < minX) minX = v.x
    if (v.y < minY) minY = v.y
    if (v.x > maxX) maxX = v.x
    if (v.y > maxY) maxY = v.y
  }
  const w = maxX - minX
  const h = maxY - minY
  // divide both axes by the SAME scalar so the island's true aspect ratio survives — its
  // longer axis fills 0..1, the shorter one ends up proportionally smaller, not stretched to match
  const size = Math.max(w, h) || 1
  const uv = new Map<number, Vec2>()
  for (const i of island.vertices) {
    const v = uvPosition(mesh, baseVertices, i)
    uv.set(i, { x: (v.x - minX) / size, y: (v.y - minY) / size })
  }
  return uv
}

/** Center of an island's base (untransformed) bounding box — the pivot rotation happens around. */
export function islandBaseCenter(base: Iterable<Vec2>): Vec2 {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of base) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
}

/** Apply a UV island's manual transform to one base-UV point: rotate about the island's own
 *  base-bbox center, then scale and offset (rotation=0 reduces to the old scale+offset-only behavior). */
export function applyIslandTransform(base: Vec2, baseCenter: Vec2, t: UvIslandTransform): Vec2 {
  const dx = base.x - baseCenter.x
  const dy = base.y - baseCenter.y
  const cos = Math.cos(t.rotation)
  const sin = Math.sin(t.rotation)
  const rx = dx * cos - dy * sin
  const ry = dx * sin + dy * cos
  return {
    x: (rx + baseCenter.x) * t.scale + t.offsetX,
    y: (ry + baseCenter.y) * t.scale + t.offsetY,
  }
}

/**
 * Build one renderable mesh + per-vertex UV per island: each island is normalized to its own
 * bounding box, then rotated/offset/scaled by its manual transform (or, for islands that don't
 * have one yet, the default grid layout). Returned in the same order as `findIslands`. The
 * *editable* mesh (`mesh` argument) is never touched — this only ever produces new meshes for
 * rendering/export. Split out per-island (rather than one merged mesh) so a caller can render
 * each island as its own draw call, e.g. to stack islands at different Z depths.
 */
export function computeSplitUVIslands(
  mesh: Mesh,
  transforms?: UvIslandTransform[],
  baseVertices?: Record<number, Vec2>,
): { mesh: Mesh; uvs: Vec2[] }[] {
  const islands = findIslands(mesh)
  const defaults = defaultIslandTransforms(mesh, islands, baseVertices)

  return islands.map((island, islandIdx) => {
    const base = islandBaseUV(mesh, island, baseVertices)
    const t = normalizeIslandTransform(transforms?.[islandIdx], defaults[islandIdx])
    const center = islandBaseCenter(base.values())

    const vertices: Vec2[] = []
    const uvs: Vec2[] = []
    const faces: number[][] = []
    const newIndex = new Map<number, number>()
    for (const fi of island.faces) {
      const newFace = mesh.faces[fi].map((origIndex) => {
        let ni = newIndex.get(origIndex)
        if (ni === undefined) {
          ni = vertices.length
          vertices.push({ ...mesh.vertices[origIndex] })
          uvs.push(applyIslandTransform(base.get(origIndex)!, center, t))
          newIndex.set(origIndex, ni)
        }
        return ni
      })
      faces.push(newFace)
    }
    return { mesh: { vertices, faces }, uvs }
  })
}

/** Same as `computeSplitUVIslands`, but merged into a single mesh+uv array (islands concatenated
 *  in `findIslands` order) — for consumers that don't need per-island draw calls (UV export, the
 *  UV editor's underlying data). */
export function computeSplitUVs(
  mesh: Mesh,
  transforms?: UvIslandTransform[],
  baseVertices?: Record<number, Vec2>,
): { mesh: Mesh; uvs: Vec2[] } {
  const perIsland = computeSplitUVIslands(mesh, transforms, baseVertices)
  const vertices: Vec2[] = []
  const uvs: Vec2[] = []
  const faces: number[][] = []
  for (const island of perIsland) {
    const offset = vertices.length
    vertices.push(...island.mesh.vertices)
    uvs.push(...island.uvs)
    faces.push(...island.mesh.faces.map((f) => f.map((i) => i + offset)))
  }
  return { mesh: { vertices, faces }, uvs }
}
