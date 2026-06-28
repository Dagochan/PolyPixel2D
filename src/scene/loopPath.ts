import type { Mesh } from './types'
import { edgeKey, parseEdgeKey } from './meshUtils'

export interface LoopPath {
  /** Ordered, directed cut edges; cuts.length === quads.length + 1. Consecutive cuts bound one quad,
   *  and each cut's [a,b] direction is consistent across the whole path (same "side" = same t). */
  cuts: [number, number][]
  quads: number[]
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

  while (true) {
    if (visited.has(face)) break // guard against closed (cyclic) loops
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

    // record the entry edge in the FACE's own natural direction, not whatever direction
    // the caller happened to pass in — otherwise the very first cut (whose direction came
    // straight from the click, not from the swap rule below) ends up with an inverted t
    // relative to the rest of the strip, twisting the loop right at the start.
    if (cuts.length === 0) cuts.push([f[entryIdx], f[(entryIdx + 1) % 4]])

    visited.add(face)
    quads.push(face)
    const exitIdx = (entryIdx + 2) % 4
    // swapped relative to the face's natural order at exitIdx: this is what keeps the t
    // parameter consistent across the strip (same side = same t), since a quad's opposite
    // edges run in opposite winding directions.
    const exitA = f[(exitIdx + 1) % 4]
    const exitB = f[exitIdx]
    cuts.push([exitA, exitB])

    const candidates = edgeFaceMap.get(edgeKey(exitA, exitB)) ?? []
    const nextFace = candidates.find((fi) => fi !== face)
    if (nextFace === undefined) break
    face = nextFace
    a = exitA
    b = exitB
  }

  return { cuts, quads }
}

/** Find the full loop (walking both directions) through the edge (hoverA, hoverB). Null if neither side is a quad. */
export function findFullLoop(mesh: Mesh, hoverA: number, hoverB: number): LoopPath | null {
  const edgeFaceMap = buildEdgeFaceMap(mesh)
  const adjFaces = (edgeFaceMap.get(edgeKey(hoverA, hoverB)) ?? []).filter(
    (fi) => mesh.faces[fi].length === 4,
  )
  if (adjFaces.length === 0) return null

  const fwd = walkOneDirection(mesh, edgeFaceMap, adjFaces[0], hoverA, hoverB)
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
