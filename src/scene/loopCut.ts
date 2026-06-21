import type { Mesh, Vec2 } from './types'
import type { LoopPath } from './loopPath'

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

  const pathFaceSet = new Set(path.quads)
  const faces = mesh.faces.filter((_, fi) => !pathFaceSet.has(fi)).map((f) => [...f])
  faces.push(...newFaces)

  return { mesh: { vertices, faces } }
}
