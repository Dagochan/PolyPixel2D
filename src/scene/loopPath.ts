import type { Mesh } from './types'
import { edgeKey } from './meshUtils'

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
