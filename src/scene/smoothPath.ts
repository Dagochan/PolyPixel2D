import type { Mesh, Vec2 } from './types'
import { evaluatePathCurve, polylineLength, samplePolyline } from './pathCurve'

/** If the given vertices form a single open path (a simple chain via existing mesh edges, with
 *  exactly 2 endpoints of degree 1 and everything else degree 2) — returns them ordered from one
 *  endpoint to the other. Returns null for a closed loop, a branching selection, or anything with
 *  vertices not connected into one simple chain. Unlike `walkBoundaryLoop`/Fan Cut's boundary-edge
 *  restriction, Smooth Path only repositions vertices (no new face), so it works on *any* existing
 *  edge — interior or outer-silhouette alike. */
export function findOpenVertexPath(mesh: Mesh, vertices: number[]): number[] | null {
  if (vertices.length < 3) return null
  const selectedSet = new Set(vertices)
  const neighbors = new Map<number, Set<number>>()
  for (const idx of vertices) neighbors.set(idx, new Set())
  for (const face of mesh.faces) {
    const n = face.length
    for (let i = 0; i < n; i++) {
      const a = face[i]
      const b = face[(i + 1) % n]
      if (selectedSet.has(a) && selectedSet.has(b)) {
        neighbors.get(a)!.add(b)
        neighbors.get(b)!.add(a)
      }
    }
  }
  const endpoints = vertices.filter((v) => neighbors.get(v)!.size === 1)
  if (endpoints.length !== 2 || vertices.some((v) => neighbors.get(v)!.size !== 1 && neighbors.get(v)!.size !== 2)) {
    return null
  }

  const [start, expectedEnd] = endpoints
  const order = [start]
  let prev = -1
  let current = start
  while (order.length < vertices.length) {
    const next = Array.from(neighbors.get(current)!).find((n) => n !== prev)
    if (next === undefined) return null
    order.push(next)
    prev = current
    current = next
  }
  return current === expectedEnd ? order : null
}

/** Repeatedly moves each *interior* point halfway toward the midpoint of its 2 neighbors (the
 *  endpoints never move) — the standard relaxation step behind Blender's own "Smooth Vertices".
 *  `iterations` directly controls how much: a handful just knocks the sharp zigzag down while
 *  keeping the chain's overall arc/trend intact; many dozens converges it toward a near-straight
 *  line between the endpoints (diminishing but nonzero — never truly reaches dead straight in
 *  finite iterations). This is the actual de-zigzagging step — fitting a curve through the
 *  *original* jagged points would just reconstruct them exactly (an interpolating spline
 *  necessarily passes through every control point it's given), so it has to run on pre-relaxed
 *  points, not the raw input, to mean anything. */
function laplacianRelax(points: Vec2[], iterations: number): Vec2[] {
  let current = points
  for (let iter = 0; iter < iterations; iter++) {
    const next = current.map((p, i) => {
      if (i === 0 || i === current.length - 1) return p
      const prev = current[i - 1]
      const nextP = current[i + 1]
      return { x: (prev.x + nextP.x) / 2, y: (prev.y + nextP.y) / 2 }
    })
    current = next
  }
  return current
}

/** Relaxes `orderedPath`'s original positions by `iterations` rounds (`laplacianRelax` — 0 leaves
 *  it untouched), fits a centripetal Catmull-Rom curve through the result for continuous curvature
 *  between vertices, then moves each vertex onto the corresponding point on that curve — at the
 *  same arc-length fraction along the path it started at, so spacing/density is preserved even
 *  though the shape smooths out. The two endpoints are always exactly on the curve regardless of
 *  `iterations` (arc length 0 and the total length map to the curve's own first/last control
 *  point, which are the untouched original endpoints), so they never move. */
export function computeSmoothedPositions(mesh: Mesh, orderedPath: number[], iterations: number): Vec2[] {
  const originalPoints = orderedPath.map((i) => mesh.vertices[i])
  if (iterations <= 0) return originalPoints
  const cumulative = [0]
  for (let i = 1; i < originalPoints.length; i++) {
    const d = Math.hypot(originalPoints[i].x - originalPoints[i - 1].x, originalPoints[i].y - originalPoints[i - 1].y)
    cumulative.push(cumulative[i - 1] + d)
  }
  const total = cumulative[cumulative.length - 1] || 1

  const relaxedPoints = laplacianRelax(originalPoints, iterations)
  const curve = evaluatePathCurve(relaxedPoints, 24, false)
  const curveLength = polylineLength(curve)

  return originalPoints.map((_, i) => {
    const t = cumulative[i] / total
    const { point } = samplePolyline(curve, t * curveLength, curveLength, false)
    return point
  })
}
