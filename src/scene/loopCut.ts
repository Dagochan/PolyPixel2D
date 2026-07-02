import type { Mesh, Vec2 } from './types'
import type { LoopPath } from './loopPath'
import { edgeKey } from './meshUtils'

function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

/**
 * Split every quad along `path` with parallel cuts at each t in `ts` (any order).
 * Works on any quad strip found via findFullLoop — not tied to a fixed row/column grid.
 */
export function applyLoopCut(mesh: Mesh, path: LoopPath, ts: number[]): { mesh: Mesh } {
  const vertices = mesh.vertices.map((v) => ({ ...v }))
  const sortedTs = [...ts].sort((a, b) => a - b)

  // one vertex chain per cut edge: [cuts[i][0], ...newly interpolated (ascending t)..., cuts[i][1]]
  const chains: number[][] = path.cuts.map(([a, b]) => {
    const va = mesh.vertices[a]
    const vb = mesh.vertices[b]
    const chain = [a]
    for (const t of sortedTs) {
      chain.push(vertices.length)
      vertices.push(lerp(va, vb, t))
    }
    chain.push(b)
    return chain
  })

  const newFaces: number[][] = []
  for (let qi = 0; qi < path.quads.length; qi++) {
    const chainA = chains[qi]
    const chainB = chains[qi + 1]
    for (let k = 0; k < chainA.length - 1; k++) {
      newFaces.push([chainA[k], chainA[k + 1], chainB[k + 1], chainB[k]])
    }
  }

  // any *other* face (a triangle the loop terminates against, an ngon, or a quad the walk didn't
  // include) that shares one of the cut edges needs the same new vertices spliced into its own
  // vertex loop too — otherwise its boundary stays un-split while the path quad's does, leaving a
  // T-junction that merely *looks* welded (same position) but isn't actually the same vertex, so
  // dragging the inserted vertex tears the two apart. Same "splice inserted vertices into every
  // face touching the edge, whatever its vertex count" idea `knifeCut.ts` already uses.
  const insertsByEdge = new Map<string, { from: number; verts: number[] }>()
  path.cuts.forEach(([a, b], i) => {
    insertsByEdge.set(edgeKey(a, b), { from: a, verts: chains[i].slice(1, -1) })
  })

  const pathFaceSet = new Set(path.quads)
  const faces: number[][] = []
  mesh.faces.forEach((face, fi) => {
    if (pathFaceSet.has(fi)) return // rebuilt above via newFaces
    const next: number[] = []
    for (let i = 0; i < face.length; i++) {
      const a = face[i]
      const b = face[(i + 1) % face.length]
      next.push(a)
      const insert = insertsByEdge.get(edgeKey(a, b))
      if (insert) next.push(...(insert.from === a ? insert.verts : [...insert.verts].reverse()))
    }
    faces.push(next)
  })
  faces.push(...newFaces)

  return { mesh: { vertices, faces } }
}
