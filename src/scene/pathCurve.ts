import type { SceneObject, Vec2 } from './types'

/** Total arc length of a dense polyline (e.g. `evaluatePathCurve`'s output) — just the sum of its
 *  segment lengths. Shared by every "walk along a path by arc length" feature (`pathDeformRail.ts`,
 *  `followPath.ts`). */
export function polylineLength(polyline: Vec2[]): number {
  let total = 0
  for (let i = 0; i < polyline.length - 1; i++) {
    total += Math.hypot(polyline[i + 1].x - polyline[i].x, polyline[i + 1].y - polyline[i].y)
  }
  return total
}

/** Point at arc length `s` along `polyline` — extrapolated past either end along that end's own
 *  tangent when `s` falls outside `[0, polylineLength(polyline)]` (matches how Blender's Curve
 *  Modifier treats mesh extending past a curve's ends: it keeps going straight rather than
 *  clamping flat onto the endpoint). */
function positionAt(polyline: Vec2[], s: number): Vec2 {
  if (polyline.length < 2) return polyline[0] ?? { x: 0, y: 0 }

  const pointOn = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })

  if (s <= 0) return pointOn(polyline[0], polyline[1], s / (Math.hypot(polyline[1].x - polyline[0].x, polyline[1].y - polyline[0].y) || 1))

  let acc = 0
  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i]
    const b = polyline[i + 1]
    const segLen = Math.hypot(b.x - a.x, b.y - a.y)
    const isLastSeg = i === polyline.length - 2
    if (s <= acc + segLen || isLastSeg) {
      const t = segLen > 0 ? (s - acc) / segLen : 0
      return pointOn(a, b, isLastSeg ? t : Math.min(1, t))
    }
    acc += segLen
  }
  return polyline[polyline.length - 1]
}

/** Point + left-normal unit vector at arc length `s` along `polyline`. The normal is a central
 *  difference over a window several dense segments wide (`pathLength`-scaled `eps`), not the raw
 *  direction of whichever single segment `s` happens to land in — `evaluatePathCurve`'s output is
 *  only piecewise-linear, so a single segment's direction has small discontinuities at every
 *  sample boundary. Those are invisible for a point near the path itself, but a point far along a
 *  lateral offset amplifies them into a visible flicker as that offset sweeps the sampled position
 *  across segment joints during animation. Central-differencing over a wider window smooths the
 *  normal continuously past those joints instead.
 *
 *  `closed` (matching `SceneObject.closed`) wraps `s` (and the `±eps` window used for the normal)
 *  modulo `pathLength` instead of letting `positionAt` extrapolate straight past either end — for
 *  a properly closed `polyline` (see `evaluatePathCurve`'s `closed` param — its last point already
 *  coincides with its first), this is what makes a `pathOffset`/`progress` sweep continue
 *  seamlessly through the seam rather than shooting off along the tangent there. */
export function samplePolyline(polyline: Vec2[], s: number, pathLength: number, closed = false): { point: Vec2; normal: Vec2 } {
  if (polyline.length < 2) return { point: polyline[0] ?? { x: 0, y: 0 }, normal: { x: 0, y: 1 } }
  const wrap = (v: number) => (closed && pathLength > 0 ? ((v % pathLength) + pathLength) % pathLength : v)
  const point = positionAt(polyline, wrap(s))
  const eps = Math.max(1, pathLength / 100)
  const before = positionAt(polyline, wrap(s - eps))
  const after = positionAt(polyline, wrap(s + eps))
  const dx = after.x - before.x
  const dy = after.y - before.y
  const len = Math.hypot(dx, dy) || 1
  return { point, normal: { x: -dy / len, y: dx / len } }
}

/** Turns a `SceneObject`(kind `'path'`)'s ordered control points (`mesh.vertices`) into a dense
 *  polyline approximation of the smooth curve running through all of them, via a **Centripetal
 *  Catmull-Rom spline** (see project spec) — chosen over a plain Bezier (needs per-point tangent
 *  handles, a heavier authoring UI) and over a uniform B-spline (only *approaches* the control
 *  points rather than passing through them, which reads as unintuitive when the points are placed
 *  by direct click). Centripetal parametrization (vs. the plain/uniform Catmull-Rom variant) uses
 *  each segment's chord length to avoid the loops/overshoot uniform parametrization can produce
 *  across sharp corners or unevenly spaced points.
 *
 *  Fewer than 2 points has no curve (empty result); exactly 2 points is just that single segment
 *  (`samplesPerSegment` more points along the straight line, for a uniform sample density with
 *  the multi-point case rather than a special-cased 2-point straight line).
 *
 *  `closed` (matching `SceneObject.closed`, Blender's "Cyclic U") adds one more segment closing
 *  the last control point back to the first, and — unlike the open curve's mirrored phantom
 *  points at the two ends — every segment's 4-point neighborhood simply wraps cyclically (`points`
 *  indexed modulo its own length), so the seam gets exactly the same tangent-continuous treatment
 *  as any interior point rather than a special-cased join. The result's last sample coincides
 *  with its first (closing the polyline exactly), which is also what lets `samplePolyline`'s
 *  `closed` wraparound treat it as one continuous loop with no seam-adjacent extrapolation. */
export function evaluatePathCurve(points: Vec2[], samplesPerSegment = 12, closed = false): Vec2[] {
  if (points.length < 2) return [...points]
  if (!closed && points.length === 2) {
    const [a, b] = points
    return Array.from({ length: samplesPerSegment + 1 }, (_, i) => {
      const t = i / samplesPerSegment
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    })
  }

  if (closed && points.length >= 3) {
    const n = points.length
    const at = (i: number) => points[((i % n) + n) % n]
    const result: Vec2[] = []
    for (let i = 0; i < n; i++) {
      const segmentSamples = centripetalSegment(at(i - 1), at(i), at(i + 1), at(i + 2), samplesPerSegment)
      result.push(...(i === 0 ? segmentSamples : segmentSamples.slice(1)))
    }
    return result
  }

  // Virtual phantom points before the first and after the last so the real endpoints get a full
  // 4-point neighborhood too (mirrors the segment they cap, a common Catmull-Rom convention).
  const p0 = points[0]
  const p1 = points[1]
  const pn = points[points.length - 1]
  const pn1 = points[points.length - 2]
  const extended = [
    { x: p0.x - (p1.x - p0.x), y: p0.y - (p1.y - p0.y) },
    ...points,
    { x: pn.x - (pn1.x - pn.x), y: pn.y - (pn1.y - pn.y) },
  ]

  const result: Vec2[] = []
  for (let i = 1; i < extended.length - 2; i++) {
    const P0 = extended[i - 1]
    const P1 = extended[i]
    const P2 = extended[i + 1]
    const P3 = extended[i + 2]
    const segmentSamples = centripetalSegment(P0, P1, P2, P3, samplesPerSegment)
    // each segment's first sample coincides with the previous segment's last — drop the
    // duplicate except on the very first segment, so the result has no repeated points
    result.push(...(i === 1 ? segmentSamples : segmentSamples.slice(1)))
  }
  return result
}

/** Which control-point segment (`points[i]`-`points[i+1]`) `p` sits closest to, by straight
 *  chord distance (not the smoothed curve) — good enough for deciding where a newly-inserted
 *  point belongs in the sequence, without needing to map a curve sample back to its source
 *  segment. Returns the insertion index (i.e. `i + 1`, so the new point goes *after* `points[i]`
 *  and before `points[i+1]`). `points` must have at least 2 elements.
 *
 *  `closed` also considers the closing segment (`points[last]`-`points[0]`) — a point nearest that
 *  one is simply appended (`points.length`, i.e. after the current last point), since there's no
 *  "index past the wraparound" for a plain array insert. */
export function nearestSegmentInsertIndex(points: Vec2[], p: Vec2, closed = false): number {
  let bestIndex = 0
  let bestDistSq = Infinity
  const segCount = closed ? points.length : points.length - 1
  for (let i = 0; i < segCount; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const lenSq = dx * dx + dy * dy
    let t = lenSq > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq : 0
    t = Math.max(0, Math.min(1, t))
    const cx = a.x + t * dx
    const cy = a.y + t * dy
    const distSq = (p.x - cx) ** 2 + (p.y - cy) ** 2
    if (distSq < bestDistSq) {
      bestDistSq = distSq
      bestIndex = i
    }
  }
  return bestIndex + 1
}

/** Vertices to bound (for gizmo/BBox/auto-fit-framing purposes) for any `SceneObject` — its raw
 *  `mesh.vertices`, except for a `kind: 'path'` object, where the *control points'* bounds would
 *  be wrong: unlike a Bezier curve, a Catmull-Rom spline has no convex-hull guarantee, so the
 *  actual rendered curve can bulge outside the box its control points alone would bound. Using
 *  `evaluatePathCurve`'s dense samples instead is an approximation (not the mathematically exact
 *  bound from solving each segment's derivative for critical points) but is accurate enough for
 *  every current use (selection outline, Pixel Frame auto-fit) at negligible extra cost. */
export function boundsVertices(obj: SceneObject): Vec2[] {
  return obj.kind === 'path' ? evaluatePathCurve(obj.mesh.vertices, 12, obj.closed) : obj.mesh.vertices
}

const CENTRIPETAL_ALPHA = 0.5

function chordT(prevT: number, a: Vec2, b: Vec2): number {
  const dist = Math.hypot(b.x - a.x, b.y - a.y)
  return prevT + Math.pow(dist, CENTRIPETAL_ALPHA)
}

/** One Catmull-Rom segment (the curve between `P1` and `P2`, shaped by neighbors `P0`/`P3`),
 *  sampled at `samples + 1` points via centripetal (chord-length-based) parametrization. */
function centripetalSegment(P0: Vec2, P1: Vec2, P2: Vec2, P3: Vec2, samples: number): Vec2[] {
  const t0 = 0
  const t1 = chordT(t0, P0, P1)
  const t2 = chordT(t1, P1, P2)
  const t3 = chordT(t2, P2, P3)

  const points: Vec2[] = []
  for (let i = 0; i <= samples; i++) {
    const t = t1 + ((t2 - t1) * i) / samples
    points.push(catmullRomEval(P0, P1, P2, P3, t0, t1, t2, t3, t))
  }
  return points
}

/** Barry-Goldman recursive evaluation of a (possibly non-uniformly parametrized) Catmull-Rom
 *  segment at parameter `t` — the standard construction for the centripetal variant, since its
 *  segments aren't evenly spaced in `t` the way the uniform variant's closed-form basis assumes. */
function catmullRomEval(P0: Vec2, P1: Vec2, P2: Vec2, P3: Vec2, t0: number, t1: number, t2: number, t3: number, t: number): Vec2 {
  const lerp = (a: Vec2, b: Vec2, ta: number, tb: number): Vec2 => {
    if (tb === ta) return a
    const f = (t - ta) / (tb - ta)
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }
  }
  const A1 = lerp(P0, P1, t0, t1)
  const A2 = lerp(P1, P2, t1, t2)
  const A3 = lerp(P2, P3, t2, t3)
  const B1 = lerp(A1, A2, t0, t2)
  const B2 = lerp(A2, A3, t1, t3)
  return lerp(B1, B2, t1, t2)
}
