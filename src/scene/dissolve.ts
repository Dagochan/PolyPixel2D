import type { Mesh } from './types'
import { edgeKey, getEdges, parseEdgeKey, pruneOrphanVertices } from './meshUtils'

function rotateStartingAt(arr: number[], value: number): number[] {
  const idx = arr.indexOf(value)
  if (idx === -1) return arr
  return [...arr.slice(idx), ...arr.slice(0, idx)]
}

/** Splice two CCW-wound faces that share edge a->b (in `faceA`) / b->a (in `faceB`) into one
 *  face that follows their combined outer boundary, dropping the shared edge entirely. */
function mergeFacesAcrossEdge(faceA: number[], faceB: number[], a: number, b: number): number[] {
  const partA = rotateStartingAt(faceA, b).slice(0, -1)
  const partB = rotateStartingAt(faceB, a).slice(0, -1)
  return [...partA, ...partB]
}

function buildAdjacency(edges: [number, number][]): Map<number, number[]> {
  const adj = new Map<number, number[]>()
  const add = (x: number, y: number) => {
    const arr = adj.get(x) ?? []
    arr.push(y)
    adj.set(x, arr)
  }
  for (const [x, y] of edges) {
    add(x, y)
    add(y, x)
  }
  return adj
}

/** Trace a closed loop through every edge exactly once (each vertex must have degree 2) — used
 *  when dissolving a fully interior vertex, where the surrounding faces' far edges already form
 *  one ring with no loose ends. */
function traceClosedLoop(edges: [number, number][]): number[] | null {
  if (edges.length < 3) return null
  const adj = buildAdjacency(edges)
  for (const nbrs of adj.values()) if (nbrs.length !== 2) return null
  const start = edges[0][0]
  const loop = [start]
  let prev = -1
  let curr = start
  while (true) {
    const nbrs = adj.get(curr)!
    const next = nbrs[0] === prev ? nbrs[1] : nbrs[0]
    if (next === start) break
    loop.push(next)
    prev = curr
    curr = next
    if (loop.length > edges.length) return null
  }
  return loop.length === edges.length ? loop : null
}

/** Trace the single simple path through every edge from `from` to `to` — used when dissolving a
 *  boundary vertex, where the far edges form an open chain between its two outer neighbors. */
function traceChain(edges: [number, number][], from: number, to: number): number[] | null {
  if (edges.length === 0) return from === to ? [] : null
  const adj = buildAdjacency(edges)
  const path = [from]
  let prev = -1
  let curr = from
  while (curr !== to) {
    const nbrs = adj.get(curr)
    if (!nbrs) return null
    const next = nbrs.find((n) => n !== prev)
    if (next === undefined) return null
    path.push(next)
    prev = curr
    curr = next
    if (path.length > edges.length + 1) return null
  }
  return path
}

/** Remove one vertex, merging every face touching it into a single face along the outer boundary
 *  of the hole its removal would otherwise leave (Blender's "Dissolve Vertices"). Falls back to
 *  leaving the mesh untouched for that vertex if its surrounding faces aren't a clean single fan
 *  (shouldn't happen for meshes built by this app's own tools, but better than corrupting data). */
function dissolveOneVertex(mesh: Mesh, v: number): Mesh {
  const touchingFaceIdx: number[] = []
  mesh.faces.forEach((face, fi) => {
    if (face.includes(v)) touchingFaceIdx.push(fi)
  })
  if (touchingFaceIdx.length === 0) return mesh
  const touchingSet = new Set(touchingFaceIdx)

  const spokeCount = new Map<string, number>()
  const spokeKeys: string[] = []
  const farEdges: [number, number][] = []
  for (const fi of touchingFaceIdx) {
    const face = mesh.faces[fi]
    for (let i = 0; i < face.length; i++) {
      const a = face[i]
      const b = face[(i + 1) % face.length]
      if (a === v || b === v) {
        const key = edgeKey(a, b)
        spokeCount.set(key, (spokeCount.get(key) ?? 0) + 1)
        spokeKeys.push(key)
      } else {
        farEdges.push([a, b])
      }
    }
  }

  // a "free" spoke (used by only one touching face) means v sits on the mesh boundary there —
  // its far endpoint becomes a loose end the merged face's boundary must connect through
  const seen = new Set<string>()
  const freeEnds: number[] = []
  for (const key of spokeKeys) {
    if (seen.has(key)) continue
    seen.add(key)
    if (spokeCount.get(key) === 1) {
      const [a, b] = parseEdgeKey(key)
      freeEnds.push(a === v ? b : a)
    }
  }

  let loop: number[] | null
  if (freeEnds.length === 0) loop = traceClosedLoop(farEdges)
  else if (freeEnds.length === 2) loop = traceChain(farEdges, freeEnds[0], freeEnds[1])
  else loop = null // non-manifold fan around v — leave it alone rather than guess

  const otherFaces = mesh.faces.filter((_, fi) => !touchingSet.has(fi))
  if (!loop) return mesh
  // collapsed to a sliver (e.g. the lone vertex of an otherwise-isolated triangle) — nothing
  // meaningful to keep, so just drop the surrounding faces instead of a degenerate polygon
  if (loop.length < 3) return { vertices: mesh.vertices, faces: otherFaces }
  return { vertices: mesh.vertices, faces: [...otherFaces, loop] }
}

/** Dissolve vertices: removes each vertex and merges the faces around it into one, instead of
 *  deleting every face that touched it (see `deleteVertices` in deleteElements.ts for that). */
export function dissolveVertices(mesh: Mesh, vertexIndices: number[]): Mesh {
  let current: Mesh = mesh
  for (const v of vertexIndices) current = dissolveOneVertex(current, v)
  return pruneOrphanVertices(current)
}

/** Dissolve edges: for each edge shared by exactly two (consistently-wound) faces, merges those
 *  two faces into one and removes the edge. A boundary edge (one face, or none) has nothing to
 *  merge into and is left as-is, matching Blender's dissolve-edge behavior. */
export function dissolveEdges(mesh: Mesh, edgeKeys: string[]): Mesh {
  let faces = mesh.faces.map((f) => [...f])
  const touchedVertices = new Set<number>()
  for (const key of edgeKeys) {
    const [a, b] = parseEdgeKey(key)
    const matches: { fi: number; dir: 'ab' | 'ba' }[] = []
    faces.forEach((face, fi) => {
      for (let i = 0; i < face.length; i++) {
        const x = face[i]
        const y = face[(i + 1) % face.length]
        if (x === a && y === b) matches.push({ fi, dir: 'ab' })
        else if (x === b && y === a) matches.push({ fi, dir: 'ba' })
      }
    })
    if (matches.length !== 2) continue // boundary edge, or non-manifold — nothing to merge
    const [m1, m2] = matches
    if (m1.dir === m2.dir) continue // inconsistent winding — bail out rather than guess
    const abMatch = m1.dir === 'ab' ? m1 : m2
    const baMatch = m1.dir === 'ab' ? m2 : m1
    const merged = mergeFacesAcrossEdge(faces[abMatch.fi], faces[baMatch.fi], a, b)
    faces = faces.filter((_, fi) => fi !== abMatch.fi && fi !== baMatch.fi)
    faces.push(merged)
    touchedVertices.add(a)
    touchedVertices.add(b)
  }

  // a dissolved edge's endpoint can be left with only two edges total — a redundant pass-through
  // point on the merged face's boundary (e.g. dissolving a chain of "spoke" edges in a fan of
  // quads leaves their shared rim vertices just sitting on an otherwise-straight run of the new
  // ngon). Blender's "Dissolve Edges" cleans these up too, so drop them from whichever face still
  // lists them, as long as that doesn't collapse the face below a triangle. Only vertices the
  // dissolve actually touched are considered — unrelated degree-2 corners elsewhere are left alone.
  if (touchedVertices.size > 0) {
    const degree = new Map<number, number>()
    for (const [x, y] of getEdges({ vertices: mesh.vertices, faces })) {
      degree.set(x, (degree.get(x) ?? 0) + 1)
      degree.set(y, (degree.get(y) ?? 0) + 1)
    }
    for (const v of touchedVertices) {
      if (degree.get(v) !== 2) continue
      faces = faces.map((face) => (face.length > 3 && face.includes(v) ? face.filter((i) => i !== v) : face))
    }
  }

  return pruneOrphanVertices({ vertices: mesh.vertices.map((v) => ({ ...v })), faces })
}
