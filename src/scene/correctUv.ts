import type { Vec2 } from './types'

export interface UvNeighbor {
  /** neighbor vertex's local mesh position at drag start (frozen, not its live position — see
   *  `correctVertexUv`'s doc for why). */
  pos: Vec2
  /** neighbor vertex's UV-defining rest position at drag start (`uvBaseVertices[i]`, falling back
   *  to its own start position if it has none yet, same convention as `uvBaseVertices`'s doc). */
  uv: Vec2
}

function triBarycentric(p: Vec2, a: Vec2, b: Vec2, c: Vec2): [number, number, number] | null {
  const v0x = b.x - a.x
  const v0y = b.y - a.y
  const v1x = c.x - a.x
  const v1y = c.y - a.y
  const v2x = p.x - a.x
  const v2y = p.y - a.y
  const den = v0x * v1y - v1x * v0y
  if (Math.abs(den) < 1e-12) return null
  const v = (v2x * v1y - v1x * v2y) / den
  const w = (v0x * v2y - v2x * v0y) / den
  return [1 - v - w, v, w]
}

/** Blender's "Correct Face Attributes": as a vertex is dragged (G grab, GG slide), re-derive its
 *  `uvBaseVertices` entry so the *texture image* appears to stay put rather than stretching to
 *  the new geometry — the opposite of this app's normal default (`uvBaseVertices`'s doc), and only
 *  applied while the global "Correct Face Attributes" toggle is on.
 *
 *  Fans a triangle out of the moving vertex's own start position (`selfStart`) and each
 *  consecutive pair of its mesh-adjacent neighbors, sorted by angle around `selfStart` — the
 *  same wedge structure a real face would have around that corner, but built purely from
 *  edge-adjacency so it works regardless of face count/shape. Finds whichever wedge best
 *  contains the vertex's *new* position (`newPos`) and reuses that wedge's barycentric weights on
 *  the corresponding UV rest positions (`selfUv`/each neighbor's `uv`) instead of mesh positions —
 *  so sliding the vertex partway toward a neighbor slides its UV the same fraction of the way
 *  toward that neighbor's UV, keeping the image anchored. All neighbor positions/UVs are the
 *  *start-of-drag* snapshot (not live), so this stays well-defined even when several vertices of
 *  the same wedge are being dragged simultaneously — each is corrected independently against a
 *  fixed reference shape instead of chasing a moving target.
 *
 *  Needs at least 2 neighbors to form any wedge at all; returns `undefined` (no correction, same
 *  as leaving `uvBaseVertices` untouched) for an isolated or dead-end vertex. */
export function correctVertexUv(neighbors: UvNeighbor[], selfStart: Vec2, selfUv: Vec2, newPos: Vec2): Vec2 | undefined {
  if (neighbors.length < 2) return undefined

  const ordered = neighbors
    .map((n) => ({ ...n, angle: Math.atan2(n.pos.y - selfStart.y, n.pos.x - selfStart.x) }))
    .sort((a, b) => a.angle - b.angle)
  const n = ordered.length

  // every consecutive wedge (self, n_i, n_{i+1}), wrapping around — for an open (non-closed) fan
  // this over-counts by one spurious wedge spanning the exterior gap, but it's harmless: it's just
  // one more candidate in the "best containment" competition below, never the only one.
  let bestBary: [number, number, number] | null = null
  let bestA: UvNeighbor | null = null
  let bestB: UvNeighbor | null = null
  let bestScore = -Infinity
  for (let i = 0; i < n; i++) {
    const a = ordered[i]
    const b = ordered[(i + 1) % n]
    const bary = triBarycentric(newPos, selfStart, a.pos, b.pos)
    if (!bary) continue
    const score = Math.min(...bary)
    if (score > bestScore) {
      bestScore = score
      bestBary = bary
      bestA = a
      bestB = b
    }
  }
  if (bestBary && bestA && bestB) {
    const [u, v, w] = bestBary
    return {
      x: u * selfUv.x + v * bestA.uv.x + w * bestB.uv.x,
      y: u * selfUv.y + v * bestA.uv.y + w * bestB.uv.y,
    }
  }

  // every wedge was degenerate (zero-area) — the common case is a mid-strip vertex whose two
  // neighbors sit directly opposite each other, so `self` and both neighbors are exactly
  // collinear (the textbook GG-slide setup). 2D barycentric doesn't apply to a 1D neighborhood;
  // fall back to parametrizing along the shared line instead, picking the widest-separated pair
  // of points as the axis for numerical stability, then piecewise-linearly interpolating UV
  // between whichever two points bracket `newPos` along it (extrapolating past the ends, same as
  // sliding a vertex past its neighbor is allowed to).
  const points = [{ pos: selfStart, uv: selfUv }, ...ordered]
  let axisA = points[0]
  let axisB = points[1]
  let maxDist = -Infinity
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const d = Math.hypot(points[i].pos.x - points[j].pos.x, points[i].pos.y - points[j].pos.y)
      if (d > maxDist) {
        maxDist = d
        axisA = points[i]
        axisB = points[j]
      }
    }
  }
  if (maxDist < 1e-9) return undefined
  const dir = { x: axisB.pos.x - axisA.pos.x, y: axisB.pos.y - axisA.pos.y }
  const dirLen = Math.hypot(dir.x, dir.y)
  const project = (p: Vec2) => ((p.x - axisA.pos.x) * dir.x + (p.y - axisA.pos.y) * dir.y) / dirLen
  const sorted = points.map((p) => ({ ...p, t: project(p.pos) })).sort((a, b) => a.t - b.t)
  const tq = project(newPos)
  let lo = sorted[0]
  let hi = sorted[sorted.length - 1]
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i].t <= tq && tq <= sorted[i + 1].t) {
      lo = sorted[i]
      hi = sorted[i + 1]
      break
    }
  }
  const span = hi.t - lo.t
  const t = span > 1e-9 ? (tq - lo.t) / span : 0
  return { x: lo.uv.x + (hi.uv.x - lo.uv.x) * t, y: lo.uv.y + (hi.uv.y - lo.uv.y) * t }
}
