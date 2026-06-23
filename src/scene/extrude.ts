import type { Mesh, Vec2 } from './types'
import { parseEdgeKey, edgeKey } from './meshUtils'

// 0: the duplicated vertices land exactly on top of the originals, since extrude is
// immediately followed by a Blender-style grab modal that the user drags out themselves.
const DEFAULT_DISTANCE = 0

/**
 * `edgeKeys` only carry an unordered (canonical a<b) pair, but the new wall face's winding
 * must match whichever existing face the edge belongs to — otherwise the mesh ends up with
 * inconsistent winding, which breaks anything relying on consistent face orientation (like
 * the loop-cut quad-strip walk). Recover the original directed order from the adjacent face.
 */
function getDirectedEdge(mesh: Mesh, a: number, b: number): [number, number] {
  for (const face of mesh.faces) {
    for (let i = 0; i < face.length; i++) {
      const x = face[i]
      const y = face[(i + 1) % face.length]
      if (x === a && y === b) return [a, b]
      if (x === b && y === a) return [b, a]
    }
  }
  return [a, b]
}

function meshCentroid(mesh: Mesh): Vec2 {
  let x = 0
  let y = 0
  for (const v of mesh.vertices) {
    x += v.x
    y += v.y
  }
  return { x: x / mesh.vertices.length, y: y / mesh.vertices.length }
}

/** Duplicates the given vertices, offset along `dir` by `distance`, returning a map old->new index. */
function duplicateVertices(
  vertices: Vec2[],
  usedVerts: Set<number>,
  dir: Vec2,
  distance: number,
): Map<number, number> {
  const vertexMap = new Map<number, number>()
  for (const idx of usedVerts) {
    const v = vertices[idx]
    const newIdx = vertices.length
    vertices.push({ x: v.x + dir.x * distance, y: v.y + dir.y * distance })
    vertexMap.set(idx, newIdx)
  }
  return vertexMap
}

/**
 * Extrude the given edges: duplicates their vertices once each (shared vertices between
 * selected edges aren't duplicated twice) and connects old->new with a new quad per edge.
 */
export function extrudeEdges(
  mesh: Mesh,
  edgeKeys: string[],
  distance = DEFAULT_DISTANCE,
): { mesh: Mesh; newVertexIndices: number[]; newEdgeKeys: string[] } {
  const centroid = meshCentroid(mesh)
  const edges = edgeKeys.map(parseEdgeKey).map(([a, b]) => getDirectedEdge(mesh, a, b))
  const usedVerts = new Set<number>()
  for (const [a, b] of edges) {
    usedVerts.add(a)
    usedVerts.add(b)
  }

  // average outward normal across the selected edges (outward = away from the mesh centroid)
  let nx = 0
  let ny = 0
  for (const [a, b] of edges) {
    const va = mesh.vertices[a]
    const vb = mesh.vertices[b]
    const dx = vb.x - va.x
    const dy = vb.y - va.y
    const len = Math.hypot(dx, dy) || 1
    let pnx = -dy / len
    let pny = dx / len
    const midX = (va.x + vb.x) / 2
    const midY = (va.y + vb.y) / 2
    if ((midX - centroid.x) * pnx + (midY - centroid.y) * pny < 0) {
      pnx = -pnx
      pny = -pny
    }
    nx += pnx
    ny += pny
  }
  const nLen = Math.hypot(nx, ny) || 1
  const dir = { x: nx / nLen, y: ny / nLen }

  const vertices = mesh.vertices.map((v) => ({ ...v }))
  const vertexMap = duplicateVertices(vertices, usedVerts, dir, distance)

  const faces = mesh.faces.map((f) => [...f])
  const newEdgeKeys: string[] = []
  for (const [a, b] of edges) {
    const na = vertexMap.get(a)!
    const nb = vertexMap.get(b)!
    // (a,b) has the original mesh's interior on its left; the new wall sits on the right,
    // so its own CCW winding (consistent with the rest of the mesh) is b -> a -> na -> nb.
    faces.push([b, a, na, nb])
    // the new edge "facing" the original (a,b) — the one a caller in edge-select mode wants
    // selected afterwards, mirroring how vertex-select mode keeps the new vertices selected
    newEdgeKeys.push(edgeKey(na, nb))
  }

  return { mesh: { vertices, faces }, newVertexIndices: Array.from(vertexMap.values()), newEdgeKeys }
}
