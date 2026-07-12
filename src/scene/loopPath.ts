import type { Mesh } from './types'
import { edgeKey, parseEdgeKey } from './meshUtils'

export interface LoopPath {
  /** Ordered, directed cut edges. For an open strip, `cuts.length === quads.length + 1`
   *  (consecutive cuts bound one quad, with one extra cut closing off each end). For a *closed*
   *  strip (`closed: true`, e.g. a ring/annulus with no distinct ends), `cuts.length === quads.length`
   *  instead — the strip wraps back on itself, so `quads[last]` sits between `cuts[last]` and
   *  `cuts[0]` rather than a separate final cut. Either way each cut's `[a,b]` direction is
   *  consistent across the whole path (same "side" = same t). */
  cuts: [number, number][]
  quads: number[]
  /** True when the quad strip loops back on itself (e.g. a ring cut's annulus) rather than
   *  terminating at two distinct ends — see `cuts`' doc for how that changes its length/wraparound. */
  closed: boolean
}

/** Shoelace signed area of a face in its *own* stored vertex order — positive means that face's
 *  own listed order is CCW, negative means it's actually wound CW. Used by `walkOneDirection` to
 *  stay correct even when one quad in the strip has flipped winding relative to its neighbors
 *  (e.g. a wall quad from `extrudeEdges` whose `getDirectedEdge` fallback couldn't recover a
 *  direction, or any other stray CW face) — a single such quad used to twist the cut into an X
 *  (2026-07-12 fix) because the old code assumed every quad shared one global winding. */
function faceSignedArea(mesh: Mesh, face: number[]): number {
  let area = 0
  for (let i = 0; i < face.length; i++) {
    const p = mesh.vertices[face[i]]
    const q = mesh.vertices[face[(i + 1) % face.length]]
    area += p.x * q.y - q.x * p.y
  }
  return area
}

function buildEdgeFaceMap(mesh: Mesh): Map<string, number[]> {
  const map = new Map<string, number[]>()
  mesh.faces.forEach((face, fi) => {
    for (let i = 0; i < face.length; i++) {
      const a = face[i]
      const b = face[(i + 1) % face.length]
      const key = edgeKey(a, b)
      const arr = map.get(key)
      if (arr) arr.push(fi)
      else map.set(key, [fi])
    }
  })
  return map
}

/**
 * Walk a quad strip starting at `startFace`, entering via the directed edge (entryA, entryB)
 * (one of startFace's edges, given in either vertex order), stepping through the opposite edge
 * of each quad until hitting a non-quad face or a boundary. Includes the starting edge as cuts[0].
 */
function walkOneDirection(
  mesh: Mesh,
  edgeFaceMap: Map<string, number[]>,
  startFace: number,
  entryA: number,
  entryB: number,
): LoopPath {
  const cuts: [number, number][] = []
  const quads: number[] = []
  const visited = new Set<number>()
  let face = startFace
  let a = entryA
  let b = entryB
  let closed = false

  while (true) {
    // this walk's own `visited` only ever contains faces *it* has stepped through starting from
    // `startFace`, and each step advances to a uniquely-determined next face, so the only way to
    // land back on an already-visited face is completing the cycle back to `startFace` itself —
    // i.e. a closed (cyclic) strip like a ring cut's annulus, which has no distinct ends at all.
    if (visited.has(face)) {
      closed = face === startFace
      break
    }
    const f = mesh.faces[face]
    if (f.length !== 4) break

    let entryIdx = -1
    for (let i = 0; i < 4; i++) {
      const x = f[i]
      const y = f[(i + 1) % 4]
      if ((x === a && y === b) || (x === b && y === a)) {
        entryIdx = i
        break
      }
    }
    if (entryIdx === -1) break

    // record the entry edge in the same "aligned" sense the exit-edge swap below produces, not
    // whatever direction the caller happened to pass in — otherwise the very first cut (whose
    // direction came straight from the click) ends up with an inverted t relative to the rest of
    // the strip, twisting the loop right at the start. That sense is the face's own natural order
    // for a CCW face, but the *reverse* of it for a CW one (see `faceSignedArea`'s doc) — matching
    // whichever the exit-edge logic below picks for this same face.
    if (cuts.length === 0) {
      const isCcwEntry = faceSignedArea(mesh, f) > 0
      cuts.push(isCcwEntry ? [f[entryIdx], f[(entryIdx + 1) % 4]] : [f[(entryIdx + 1) % 4], f[entryIdx]])
    }

    visited.add(face)
    quads.push(face)
    const exitIdx = (entryIdx + 2) % 4
    // swapped relative to the face's natural order at exitIdx: this is what keeps the t
    // parameter consistent across the strip (same side = same t), since a quad's opposite
    // edges run in opposite winding directions — but only for a CCW-wound face; a stray
    // CW one (see `faceSignedArea`'s doc) needs the *un*-swapped order to keep the same sense.
    const isCcw = faceSignedArea(mesh, f) > 0
    const exitA = isCcw ? f[(exitIdx + 1) % 4] : f[exitIdx]
    const exitB = isCcw ? f[exitIdx] : f[(exitIdx + 1) % 4]
    cuts.push([exitA, exitB])

    const candidates = edgeFaceMap.get(edgeKey(exitA, exitB)) ?? []
    const nextFace = candidates.find((fi) => fi !== face)
    if (nextFace === undefined) break
    face = nextFace
    a = exitA
    b = exitB
  }

  return { cuts, quads, closed }
}

/** Find the full loop (walking both directions) through the edge (hoverA, hoverB). Null if neither side is a quad. */
export function findFullLoop(mesh: Mesh, hoverA: number, hoverB: number): LoopPath | null {
  const edgeFaceMap = buildEdgeFaceMap(mesh)
  const adjFaces = (edgeFaceMap.get(edgeKey(hoverA, hoverB)) ?? []).filter(
    (fi) => mesh.faces[fi].length === 4,
  )
  if (adjFaces.length === 0) return null

  const fwd = walkOneDirection(mesh, edgeFaceMap, adjFaces[0], hoverA, hoverB)
  if (fwd.closed) {
    // a closed strip (e.g. a ring cut's annulus) has no distinct ends — walking "the other
    // direction" from this same edge would just retrace this exact loop again, so combining it
    // in like the open-strip case below would double every cut/quad in the ring. `cuts[last]`
    // duplicates `cuts[0]` (the walk closing back on itself), so it's dropped here.
    return { cuts: fwd.cuts.slice(0, -1), quads: fwd.quads, closed: true }
  }
  if (adjFaces.length === 1) return fwd

  const bwd = walkOneDirection(mesh, edgeFaceMap, adjFaces[1], hoverB, hoverA)
  const bwdCutsRest: [number, number][] = bwd.cuts
    .slice(1)
    .map(([x, y]): [number, number] => [y, x])
    .reverse()
  const bwdQuadsRest = bwd.quads.slice().reverse()

  return {
    cuts: [...bwdCutsRest, ...fwd.cuts],
    quads: [...bwdQuadsRest, ...fwd.quads],
    closed: false,
  }
}

function buildVertexEdgeMap(mesh: Mesh): Map<number, Set<string>> {
  const map = new Map<number, Set<string>>()
  for (const face of mesh.faces) {
    for (let i = 0; i < face.length; i++) {
      const a = face[i]
      const b = face[(i + 1) % face.length]
      const key = edgeKey(a, b)
      for (const v of [a, b]) {
        const set = map.get(v)
        if (set) set.add(key)
        else map.set(v, new Set([key]))
      }
    }
  }
  return map
}

/** From `fromVertex`, having just arrived via `viaEdgeKey`, find the single edge that continues
 *  "straight through" — the classic edge-loop step: at a 4-valent vertex, the four faces meeting
 *  there pair the four edges into two opposite pairs; the continuation is whichever of the other
 *  three edges shares no face with the edge we arrived on. Returns null at any vertex that isn't
 *  exactly 4-valent, or where that edge isn't uniquely determined (non-manifold) — both are loop
 *  boundaries, same as Blender's Alt+Click stopping at poles and mesh edges. */
function stepEdgeLoop(
  edgeFaceMap: Map<string, number[]>,
  vertexEdgeMap: Map<number, Set<string>>,
  fromVertex: number,
  viaEdgeKey: string,
): { nextVertex: number; nextEdgeKey: string } | null {
  const incident = vertexEdgeMap.get(fromVertex)
  if (!incident || incident.size !== 4) return null
  const incomingFaces = new Set(edgeFaceMap.get(viaEdgeKey) ?? [])
  let candidate: string | null = null
  for (const ek of incident) {
    if (ek === viaEdgeKey) continue
    const faces = edgeFaceMap.get(ek) ?? []
    if (faces.some((f) => incomingFaces.has(f))) continue // shares a face with the incoming edge — a "turn", not the continuation
    if (candidate !== null) return null // more than one disjoint candidate — ambiguous, bail
    candidate = ek
  }
  if (candidate === null) return null
  const [x, y] = parseEdgeKey(candidate)
  return { nextVertex: x === fromVertex ? y : x, nextEdgeKey: candidate }
}

/** Blender's "Edge Loop" select (Alt+Click): the chain of edges connected end-to-end through the
 *  clicked edge, each continuing straight through a 4-valent vertex — distinct from "Edge Ring"
 *  (`findFullLoop` above), which instead jumps across each face to its parallel opposite edge.
 *  Returns the edge keys in the loop, including the starting edge. */
export function findEdgeLoop(mesh: Mesh, startA: number, startB: number): string[] {
  const edgeFaceMap = buildEdgeFaceMap(mesh)
  const vertexEdgeMap = buildVertexEdgeMap(mesh)
  const startKey = edgeKey(startA, startB)
  const loop = new Set<string>([startKey])

  for (const startVertex of [startB, startA]) {
    let vertex = startVertex
    let edge = startKey
    for (let guard = 0; guard < mesh.vertices.length + 1; guard++) {
      const step = stepEdgeLoop(edgeFaceMap, vertexEdgeMap, vertex, edge)
      if (!step || loop.has(step.nextEdgeKey)) break // boundary/pole, or the loop closed on itself
      loop.add(step.nextEdgeKey)
      vertex = step.nextVertex
      edge = step.nextEdgeKey
    }
  }
  return [...loop]
}
