import type { Mesh, Vec2 } from './types'

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}_${b}` : `${b}_${a}`
}

/** Finds the mesh face that has (a,b) as one of its edges, where that edge is a true boundary
 *  edge — used by exactly one face in the whole mesh. Fan Cut only operates on the mesh's outer
 *  silhouette, not interior edges shared by two faces. Returns null if no such boundary edge/face
 *  exists (an interior edge, or the two vertices aren't connected by an edge at all). */
export function findBoundaryEdgeFace(mesh: Mesh, a: number, b: number): number | null {
  let ownerFace = -1
  let usageCount = 0
  mesh.faces.forEach((face, faceIndex) => {
    const n = face.length
    for (let i = 0; i < n; i++) {
      const x = face[i]
      const y = face[(i + 1) % n]
      if ((x === a && y === b) || (x === b && y === a)) {
        usageCount++
        ownerFace = faceIndex
      }
    }
  })
  return usageCount === 1 ? ownerFace : null
}

/** Every existing mesh edge (a face's consecutive corner pair) whose both endpoints are in
 *  `vertices` — lets Vertex mode name multiple edges the same way Edge mode does: select the
 *  shared corner plus both far ends (3 vertices), and the 2 boundary edges meeting there are
 *  derived automatically, no explicit path/order required. */
export function edgesAmongVertices(mesh: Mesh, vertices: number[]): [number, number][] {
  const selectedSet = new Set(vertices)
  const seen = new Set<string>()
  const edges: [number, number][] = []
  for (const face of mesh.faces) {
    const n = face.length
    for (let i = 0; i < n; i++) {
      const a = face[i]
      const b = face[(i + 1) % n]
      if (selectedSet.has(a) && selectedSet.has(b)) {
        const key = edgeKey(a, b)
        if (!seen.has(key)) {
          seen.add(key)
          edges.push([a, b])
        }
      }
    }
  }
  return edges
}

/** Finds the single face that owns *every* edge in `edges` as a boundary edge (used by exactly
 *  one face in the whole mesh) — e.g. two edges meeting at a shared corner, both selected. Returns
 *  null if any edge isn't a boundary edge, or if the edges don't all belong to the same face. */
export function findCommonBoundaryFace(mesh: Mesh, edges: [number, number][]): number | null {
  let faceIndex: number | null = null
  for (const [a, b] of edges) {
    const owner = findBoundaryEdgeFace(mesh, a, b)
    if (owner === null) return null
    if (faceIndex === null) faceIndex = owner
    else if (faceIndex !== owner) return null
  }
  return faceIndex
}

/** "Fan Cut": pokes `faceIndex` (adds a vertex at its centroid, fanning a triangle from the center
 *  to every original corner — like Blender's Poke Faces) and additionally subdivides each edge in
 *  `edges` (boundary edges of `faceIndex`, e.g. two edges meeting at one selected corner) into
 *  `segments` pieces, every new point also fanned to the center. Only appends vertices and only
 *  ever *replaces* `faceIndex` in place (extra triangles are pushed after it) — every other
 *  face/vertex index is untouched, so (like cuts/extrude, per remapVertexData's doc) no vertex-
 *  data remap is needed; the replaced face's color (if any) naturally carries over to the first
 *  new triangle. */
export function applyFanCut(
  mesh: Mesh,
  faceIndex: number,
  edges: [number, number][],
  segments: number,
): {
  vertices: Vec2[]
  faces: number[][]
  centerIndex: number
  newEdgeVertexIndices: number[]
  /** Every non-center corner of the poked face, in order (original corners plus each subdivided
   *  edge's new points spliced in) — the "spokes" from `centerIndex` to each of these are the fan
   *  lines. */
  ring: number[]
} {
  const face = mesh.faces[faceIndex]
  const n = face.length
  const targetKeys = new Set(edges.map(([a, b]) => edgeKey(a, b)))
  const clampedSegments = Math.max(1, Math.round(segments))

  const vertices = mesh.vertices.slice()
  const cx = face.reduce((sum, vi) => sum + mesh.vertices[vi].x, 0) / n
  const cy = face.reduce((sum, vi) => sum + mesh.vertices[vi].y, 0) / n
  const centerIndex = vertices.length
  vertices.push({ x: cx, y: cy })

  const orderedRing: number[] = []
  const newEdgeVertexIndices: number[] = []
  for (let i = 0; i < n; i++) {
    const v = face[i]
    const vNext = face[(i + 1) % n]
    orderedRing.push(v)
    if (targetKeys.has(edgeKey(v, vNext))) {
      const a = mesh.vertices[v]
      const b = mesh.vertices[vNext]
      for (let s = 1; s < clampedSegments; s++) {
        const t = s / clampedSegments
        const idx = vertices.length
        vertices.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
        orderedRing.push(idx)
        newEdgeVertexIndices.push(idx)
      }
    }
  }

  const triangles: number[][] = []
  for (let i = 0; i < orderedRing.length; i++) {
    const p1 = orderedRing[i]
    const p2 = orderedRing[(i + 1) % orderedRing.length]
    triangles.push([p1, p2, centerIndex])
  }

  const faces = mesh.faces.slice()
  faces[faceIndex] = triangles[0]
  for (let i = 1; i < triangles.length; i++) faces.push(triangles[i])

  return { vertices, faces, centerIndex, newEdgeVertexIndices, ring: orderedRing }
}
