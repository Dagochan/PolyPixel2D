import type { Mesh, Vec2 } from './types'
import { edgeKey } from './meshUtils'

export type KnifeCutPoint =
  | { type: 'vertex'; index: number }
  | { type: 'edge'; a: number; b: number; t: number } // position = lerp(vertices[a], vertices[b], t)

function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

function pointPosition(mesh: Mesh, p: KnifeCutPoint): Vec2 {
  if (p.type === 'vertex') return mesh.vertices[p.index]
  return lerp(mesh.vertices[p.a], mesh.vertices[p.b], p.t)
}

function buildEdgeFaceMap(faces: number[][]): Map<string, number[]> {
  const map = new Map<string, number[]>()
  faces.forEach((face, fi) => {
    for (let i = 0; i < face.length; i++) {
      const a = face[i]
      const b = face[(i + 1) % face.length]
      const key = edgeKey(a, b)
      const list = map.get(key) ?? []
      list.push(fi)
      map.set(key, list)
    }
  })
  return map
}

/** Faces that touch this cut point (vertex: all incident faces; edge point: the ≤2 faces sharing that edge). */
function candidateFaces(faces: number[][], edgeFaceMap: Map<string, number[]>, p: KnifeCutPoint): number[] {
  if (p.type === 'vertex') {
    return faces.reduce<number[]>((acc, face, fi) => {
      if (face.includes(p.index)) acc.push(fi)
      return acc
    }, [])
  }
  return edgeFaceMap.get(edgeKey(p.a, p.b)) ?? []
}

/** Signed perpendicular distance from `pt` to edge a->b (>=0 inside, for a CCW-wound convex polygon). */
function insideDist(a: Vec2, b: Vec2, pt: Vec2): number {
  const ex = b.x - a.x
  const ey = b.y - a.y
  const len = Math.hypot(ex, ey) || 1
  return (ex * (pt.y - a.y) - ey * (pt.x - a.x)) / len
}

function isInsideConvexFace(mesh: Mesh, face: number[], pt: Vec2): boolean {
  const eps = 1e-6
  for (let i = 0; i < face.length; i++) {
    const a = mesh.vertices[face[i]]
    const b = mesh.vertices[face[(i + 1) % face.length]]
    if (insideDist(a, b, pt) < -eps) return false
  }
  return true
}

/** Among `candidates`, the face whose interior lies just past P in direction D. */
function chooseStartFace(mesh: Mesh, faces: number[][], candidates: number[], P: Vec2, D: Vec2): number {
  const probe = { x: P.x + D.x * 0.001, y: P.y + D.y * 0.001 }
  for (const fi of candidates) {
    if (isInsideConvexFace(mesh, faces[fi], probe)) return fi
  }
  return candidates[0] ?? -1
}

/** Ray (O + s*D, s>0) vs segment (A + t*(B-A), t in [0,1]). */
function rayVsSegment(O: Vec2, D: Vec2, A: Vec2, B: Vec2): { tRay: number; tSeg: number } | null {
  const v1 = { x: O.x - A.x, y: O.y - A.y }
  const v2 = { x: B.x - A.x, y: B.y - A.y }
  const v3 = { x: -D.y, y: D.x }
  const denom = v2.x * v3.x + v2.y * v3.y
  if (Math.abs(denom) < 1e-9) return null
  const tSeg = (v1.x * v3.x + v1.y * v3.y) / denom
  const tRay = (v2.x * v1.y - v2.y * v1.x) / denom
  return { tRay, tSeg }
}

interface Crossing {
  point: KnifeCutPoint
  /** Original-mesh face index that the sub-segment *ending* at this crossing passes through. */
  faceIndex: number
}

/**
 * Walk the straight segment P->Q (starting inside `startFaceIdx`, having just entered via
 * `entryEdge` if any) across every convex face it actually crosses.
 */
function walkSegment(
  mesh: Mesh,
  faces: number[][],
  edgeFaceMap: Map<string, number[]>,
  P: Vec2,
  Q: Vec2,
  startFaceIdx: number,
  entryEdge: [number, number] | null,
): { crossings: Crossing[]; finalFaceIdx: number } {
  const crossings: Crossing[] = []
  const D = { x: Q.x - P.x, y: Q.y - P.y }
  if (Math.hypot(D.x, D.y) < 1e-9) return { crossings, finalFaceIdx: startFaceIdx }

  let curFaceIdx = startFaceIdx
  let curP = P
  let cameFrom = entryEdge
  for (let iter = 0; iter < 999 && curFaceIdx !== -1; iter++) {
    const face = faces[curFaceIdx]
    // Check destination containment directly (robust to float noise) rather than relying on
    // the ray parameter landing near exactly 1 — Q very often sits exactly on a face's boundary
    // edge (it's itself an edge-snapped cut point), where tRay≈1 is unreliable.
    if (isInsideConvexFace(mesh, face, Q)) break
    let bestT = Infinity
    let bestEdge: [number, number] | null = null
    let bestSeg = 0
    for (let i = 0; i < face.length; i++) {
      const a = face[i]
      const b = face[(i + 1) % face.length]
      if (cameFrom && ((cameFrom[0] === a && cameFrom[1] === b) || (cameFrom[0] === b && cameFrom[1] === a))) continue
      const hit = rayVsSegment(curP, D, mesh.vertices[a], mesh.vertices[b])
      if (!hit) continue
      if (hit.tRay <= 1e-7 || hit.tSeg < -1e-7 || hit.tSeg > 1 + 1e-7) continue
      if (hit.tRay < bestT) {
        bestT = hit.tRay
        bestEdge = [a, b]
        bestSeg = Math.max(0, Math.min(1, hit.tSeg))
      }
    }
    if (!bestEdge || bestT >= 1 - 1e-6) break // Q lies within this face — done

    const [a, b] = bestEdge
    crossings.push({ point: { type: 'edge', a, b, t: bestSeg }, faceIndex: curFaceIdx })
    const adjFaces = edgeFaceMap.get(edgeKey(a, b)) ?? []
    const nextFaceIdx = adjFaces.find((fi) => fi !== curFaceIdx) ?? -1
    curFaceIdx = nextFaceIdx
    cameFrom = [a, b]
    curP = lerp(mesh.vertices[a], mesh.vertices[b], bestSeg)
  }
  return { crossings, finalFaceIdx: curFaceIdx }
}

/**
 * Expand a user-clicked path so that every straight segment between two consecutive points
 * includes the implicit cut points where it crosses intermediate faces. Also returns, for
 * each resulting segment, the original-mesh face index it actually passes through — so the
 * caller never has to *guess* which face a (possibly ambiguous) pair of points belongs to.
 */
function expandKnifePath(
  mesh: Mesh,
  path: KnifeCutPoint[],
): { points: KnifeCutPoint[]; segmentFaces: number[] } {
  const points: KnifeCutPoint[] = [path[0]]
  const segmentFaces: number[] = []
  if (path.length < 2) return { points, segmentFaces }

  const edgeFaceMap = buildEdgeFaceMap(mesh.faces)
  for (let i = 0; i < path.length - 1; i++) {
    const p = path[i]
    const q = path[i + 1]
    const P = pointPosition(mesh, p)
    const Q = pointPosition(mesh, q)
    const D = { x: Q.x - P.x, y: Q.y - P.y }
    const candidates = candidateFaces(mesh.faces, edgeFaceMap, p)
    const startFace = chooseStartFace(mesh, mesh.faces, candidates, P, D)
    if (startFace === -1) {
      segmentFaces.push(-1) // unknown — caller falls back to a topology-based search
      points.push(q)
      continue
    }
    const entryEdge: [number, number] | null = p.type === 'edge' ? [p.a, p.b] : null
    const { crossings, finalFaceIdx } = walkSegment(mesh, mesh.faces, edgeFaceMap, P, Q, startFace, entryEdge)
    for (const c of crossings) {
      segmentFaces.push(c.faceIndex)
      points.push(c.point)
    }
    segmentFaces.push(finalFaceIdx)
    points.push(q)
  }
  return { points, segmentFaces }
}

/** Index of `v` within cyclic `loop`, or -1. */
function indexOf(loop: number[], v: number): number {
  return loop.indexOf(v)
}

function isAdjacentInLoop(loop: number[], i: number, j: number): boolean {
  const n = loop.length
  return (i + 1) % n === j || (j + 1) % n === i
}

/** Split `loop` at positions i and j (cyclic) into two sub-loops, each including both i and j. */
function splitLoop(loop: number[], i: number, j: number): [number[], number[]] {
  const n = loop.length
  const a: number[] = []
  for (let k = i; ; k = (k + 1) % n) {
    a.push(loop[k])
    if (k === j) break
  }
  const b: number[] = []
  for (let k = j; ; k = (k + 1) % n) {
    b.push(loop[k])
    if (k === i) break
  }
  return [a, b]
}

/**
 * Cut `mesh` along a polyline of `rawPath` points (each snapped to an existing vertex or a
 * point on an existing edge). Every crossed edge is subdivided for *all* faces that share it
 * (no T-junctions). Each segment is then split inside the exact original face that
 * `expandKnifePath` determined it passes through — not just "some" face containing both of
 * its endpoints, which is ambiguous whenever a segment's endpoints sit on a shared edge.
 */
export function applyKnifeCut(mesh: Mesh, rawPath: KnifeCutPoint[]): { mesh: Mesh } {
  if (rawPath.length < 2) return { mesh }
  const { points: path, segmentFaces } = expandKnifePath(mesh, rawPath)

  const vertices = mesh.vertices.map((v) => ({ ...v }))

  // 1. Resolve each edge-type cut point to a new vertex, grouped by the edge it subdivides.
  const insertsByEdge = new Map<string, { a: number; b: number; t: number; index: number }[]>()
  const resolved: number[] = path.map((p) => {
    if (p.type === 'vertex') return p.index
    const index = vertices.length
    vertices.push(lerp(vertices[p.a], vertices[p.b], p.t))
    const key = edgeKey(p.a, p.b)
    const list = insertsByEdge.get(key) ?? []
    list.push({ a: p.a, b: p.b, t: p.t, index })
    insertsByEdge.set(key, list)
    return index
  })

  // 2. Rebuild every face (keyed by its original index — order/count is preserved here),
  //    splicing in the new vertices wherever they subdivide one of its edges.
  const facesById = new Map<number, number[]>()
  mesh.faces.forEach((face, fi) => {
    const next: number[] = []
    for (let i = 0; i < face.length; i++) {
      const a = face[i]
      const b = face[(i + 1) % face.length]
      next.push(a)
      const inserts = insertsByEdge.get(edgeKey(a, b))
      if (!inserts) continue
      const ordered = [...inserts].sort((x, y) => {
        const tx = x.a === a ? x.t : 1 - x.t
        const ty = y.a === a ? y.t : 1 - y.t
        return tx - ty
      })
      for (const ins of ordered) next.push(ins.index)
    }
    facesById.set(fi, next)
  })

  // Tracks every current face-id descended from a given original face index, so a segment
  // that's known to pass through original face F can find the right (possibly already-split) piece.
  const origToCurrentIds = new Map<number, number[]>()
  mesh.faces.forEach((_, fi) => origToCurrentIds.set(fi, [fi]))
  let nextId = mesh.faces.length

  function splitFaceContaining(candidateIds: number[], p: number, q: number): boolean {
    for (const id of candidateIds) {
      const loop = facesById.get(id)
      if (!loop) continue
      const i = indexOf(loop, p)
      const j = indexOf(loop, q)
      if (i === -1 || j === -1 || isAdjacentInLoop(loop, i, j)) continue

      const [partA, partB] = splitLoop(loop, i, j)
      if (partA.length >= 3) facesById.set(id, partA)
      else facesById.delete(id)
      if (partB.length >= 3) {
        const newId = nextId++
        facesById.set(newId, partB)
        candidateIds.push(newId)
      }
      return true
    }
    return false
  }

  // 3. Split the face each segment is known to pass through, along the chord between its two cut points.
  for (let s = 0; s < resolved.length - 1; s++) {
    const p = resolved[s]
    const q = resolved[s + 1]
    if (p === q) continue

    const origFaceIdx = segmentFaces[s]
    const candidateIds = origFaceIdx !== -1 ? origToCurrentIds.get(origFaceIdx) ?? [] : Array.from(facesById.keys())
    const split = splitFaceContaining(candidateIds, p, q) // no-op if already an edge, or nothing matches
    // the scoped candidateIds tracking is an optimization to disambiguate which face a segment
    // belongs to — but it's derived from the *original* mesh's face indices, and can fall out of
    // sync with the actual current split state once several segments land on the same original
    // face (or its already-split pieces) in ways the incremental bookkeeping doesn't anticipate.
    // Rather than silently drop the cut (leaving p and q sitting on the mesh as unconnected
    // points — same position, no shared edge), fall back to searching every currently-live face.
    if (!split && origFaceIdx !== -1) splitFaceContaining(Array.from(facesById.keys()), p, q)
  }

  return { mesh: { vertices, faces: Array.from(facesById.values()) } }
}
