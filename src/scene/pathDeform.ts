import { evaluatePathCurve } from './pathCurve'
import { applyTransform, getWorldTransform, inverseTransform } from './transformUtils'
import type { PathDeformSettings, SceneObject, Vec2 } from './types'

/** This object's Path Deform settings, if it has that modifier in its stack (see `Modifier`) —
 *  `undefined` otherwise. Every other function in this module takes `obj` (not raw `settings`)
 *  precisely so this lookup lives in exactly one place. */
export function getPathDeform(obj: SceneObject): PathDeformSettings | undefined {
  return obj.modifiers?.find((m): m is Extract<typeof m, { type: 'pathDeform' }> => m.type === 'pathDeform')?.settings
}

export const DEFAULT_PATH_DEFORM_SETTINGS: PathDeformSettings = {
  enabled: true,
  pathObjectId: null,
  axis: 'x',
  center: 0,
  stretch: true,
  pathOffset: 0,
}

function polylineLength(polyline: Vec2[]): number {
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
 *  sample boundary. Those are invisible for a vertex near the path itself, but a vertex far along
 *  the lateral `center` offset amplifies them into a visible flicker as `pathOffset` sweeps the
 *  sampled position across segment joints during animation. Central-differencing over a wider
 *  window smooths the normal continuously past those joints instead. */
function samplePolyline(polyline: Vec2[], s: number, pathLength: number): { point: Vec2; normal: Vec2 } {
  if (polyline.length < 2) return { point: polyline[0] ?? { x: 0, y: 0 }, normal: { x: 0, y: 1 } }
  const point = positionAt(polyline, s)
  const eps = Math.max(1, pathLength / 100)
  const before = positionAt(polyline, s - eps)
  const after = positionAt(polyline, s + eps)
  const dx = after.x - before.x
  const dy = after.y - before.y
  const len = Math.hypot(dx, dy) || 1
  return { point, normal: { x: -dy / len, y: dx / len } }
}

/** Circumradius of the 3 points at `s - eps`, `s`, `s + eps` on `polyline` — a single-sample
 *  estimate of the path's local turning radius there. `Infinity` where those 3 points are nearly
 *  collinear (locally straight). This genuinely does swing from finite to `Infinity` and back
 *  within a couple of `eps` at a real inflection (curvature crosses exactly 0 there for an
 *  instant) — expected geometry, not noise. See `localTurnRadius`, which windows this to avoid
 *  that instant showing up as a pop in the clamp it drives. */
function circumradiusAt(polyline: Vec2[], s: number, eps: number): number {
  const a = positionAt(polyline, s - eps)
  const b = positionAt(polyline, s)
  const c = positionAt(polyline, s + eps)
  const ab = Math.hypot(b.x - a.x, b.y - a.y)
  const bc = Math.hypot(c.x - b.x, c.y - b.y)
  const ac = Math.hypot(c.x - a.x, c.y - a.y)
  // Twice the signed triangle area (shoelace) — its magnitude feeds the circumradius formula;
  // near-zero means the 3 points are nearly collinear (locally straight, no meaningful radius).
  const doubleArea = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y))
  if (doubleArea < 1e-6) return Infinity
  return (ab * bc * ac) / (2 * doubleArea)
}

/** Cumulative, *unwrapped* tangent-turn angle of `polyline` as a function of arc length — one
 *  entry per node, `arcLengths[i]`/`angles[i]` giving the arc length and total signed turn (radians,
 *  relative to the first segment's own direction) at that node. Unwrapped by accumulating each
 *  segment-to-segment turn (always small, since `evaluatePathCurve`'s output is densely sampled)
 *  rather than differencing raw `atan2` results, so a path that loops all the way around still
 *  gives a monotonically growing (or shrinking) angle instead of wrapping at ±180°. Feeds
 *  `pathDeformVertexDeltas`'s per-vertex arc-length correction — see its doc for why. */
function buildTurnAngleProfile(polyline: Vec2[]): { arcLengths: number[]; angles: number[] } {
  const arcLengths: number[] = [0]
  const angles: number[] = [0]
  let acc = 0
  let prevDirAngle: number | null = null
  let cumAngle = 0
  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i]
    const b = polyline[i + 1]
    const segLen = Math.hypot(b.x - a.x, b.y - a.y)
    if (segLen > 0) {
      const dirAngle = Math.atan2(b.y - a.y, b.x - a.x)
      if (prevDirAngle !== null) {
        let delta = dirAngle - prevDirAngle
        while (delta > Math.PI) delta -= 2 * Math.PI
        while (delta < -Math.PI) delta += 2 * Math.PI
        cumAngle += delta
      }
      prevDirAngle = dirAngle
    }
    acc += segLen
    arcLengths.push(acc)
    angles.push(cumAngle)
  }
  return { arcLengths, angles }
}

/** Interpolated cumulative turn angle at arc length `s` (clamped flat past either end of the
 *  profile built by `buildTurnAngleProfile`). */
function turnAngleAt(profile: { arcLengths: number[]; angles: number[] }, s: number): number {
  const { arcLengths, angles } = profile
  if (s <= arcLengths[0]) return angles[0]
  const last = arcLengths.length - 1
  if (s >= arcLengths[last]) return angles[last]
  for (let i = 0; i < last; i++) {
    if (s <= arcLengths[i + 1]) {
      const span = arcLengths[i + 1] - arcLengths[i]
      const t = span > 0 ? (s - arcLengths[i]) / span : 0
      return angles[i] + (angles[i + 1] - angles[i]) * t
    }
  }
  return angles[last]
}

/** The path's local turning radius near arc length `s`, for clamping lateral offset (see
 *  `pathDeformVertexDeltas`): offsetting a point further than the path curves is tight bends the
 *  offset "curve" back past its own center and folds it — same failure any curve-offset tool
 *  (Illustrator's "Offset Path", etc.) hits on a tight bend pushed past its radius. Rather than a
 *  single `circumradiusAt` sample (which genuinely swings between a tight radius and `Infinity`
 *  within a couple of `eps` at a real inflection point, popping the clamp on and off as `s`
 *  animates past one), this takes the *tightest* (smallest, most restrictive) radius across a
 *  window of samples straddling `s` — a cheap low-pass that starts softening the clamp before an
 *  upcoming tight bend instead of discontinuously hitting it exactly at one sample. `Infinity`
 *  only where the whole window is straight (or too close to the polyline's own ends to sample). */
function localTurnRadius(polyline: Vec2[], s: number, pathLength: number): number {
  const eps = Math.max(1, pathLength / 200)
  const windowSpan = eps * 4
  if (s - eps - windowSpan < 0 || s + eps + windowSpan > pathLength) return Infinity
  let minRadius = Infinity
  for (let o = -windowSpan; o <= windowSpan; o += eps) {
    minRadius = Math.min(minRadius, circumradiusAt(polyline, s + o, eps))
  }
  return minRadius
}

/** Arc length along `polyline`'s *centerline* whose offset-by-`d` curve has traveled exactly `target`
 *  units from the centerline arc length `base` — i.e. solves `s` in the differential-geometry
 *  identity for a constant-offset parallel curve: `offsetLen(base, s) = (s - base) - d * (turnAngle
 *  (s) - turnAngle(base))` (a parallel curve's length element is `(1 - kappa*d) ds`, and integrating
 *  curvature over arc length is exactly the tangent's turn angle). `target` is a physical arc
 *  length on the *offset* curve, not the centerline. Solved by fixed-point iteration (a few steps
 *  converge well since `turnAngle` changes slowly relative to `s` on any reasonably dense/smooth
 *  path) rather than closed-form, since `turnAngle` has no simple inverse. See
 *  `pathDeformVertexDeltas`'s doc for why this matters: without it, every vertex is forced onto the
 *  *same* centerline fraction regardless of its own lateral distance, which is geometrically
 *  guaranteed to pinch on the inside of a bend and stretch on the outside (concentric circles have
 *  different circumferences) even though each vertex's own lateral distance is preserved exactly. */
function solveOffsetArcLength(profile: { arcLengths: number[]; angles: number[] }, base: number, target: number, d: number): number {
  const thetaBase = turnAngleAt(profile, base)
  let s = base + target
  for (let i = 0; i < 4; i++) {
    s = base + target + d * (turnAngleAt(profile, s) - thetaBase)
  }
  return s
}

/** Per-vertex local-space deltas that bend `obj`'s Basis mesh along its assigned path object's
 *  curve — see project spec. Unlike the first version of this modifier (which projected each
 *  vertex onto a hand-picked, ordered "spine" vertex chain), this reads each vertex's position
 *  along the deform continuously and directly from its own local `mesh.vertices` coordinates —
 *  `settings.axis` ("x" or "y") is the local axis that runs *along* the path, the other is the
 *  lateral distance from it. This is the same convention Blender's Curve Modifier uses (and,
 *  per the user's recollection, closer to how Cinema 4D's Spline Wrap/lattice deformers read a
 *  cage's local coordinates) — every vertex already has smooth, continuous local coordinates, so
 *  there's no discrete polyline to facet at a handful of user-picked points, and no vertex
 *  selection/ordering UI needed at all. Each vertex's own physical arc length is still preserved
 *  along its *own* offset curve (the one running parallel to the path at that vertex's lateral
 *  distance), via `solveOffsetArcLength` — mapping every vertex onto the *same* centerline arc
 *  length regardless of its own lateral distance would still pinch/stretch the cross-section on
 *  any bend (concentric circles have different circumferences), even though each vertex's own
 *  lateral distance is preserved exactly. Evaluated entirely in world space so the deforming
 *  object's transform and the path's don't need to coincide (same convention as FakeBehind/Fake
 *  Physics). `null` when inactive (disabled or no path assigned). */
export function pathDeformVertexDeltas(obj: SceneObject, allObjects: SceneObject[]): Vec2[] | null {
  const settings = getPathDeform(obj)
  if (!settings?.enabled || !settings.pathObjectId) return null
  const pathObj = allObjects.find((o) => o.id === settings.pathObjectId && o.kind === 'path')
  if (!pathObj) return null
  if (obj.mesh.vertices.length === 0) return null

  const objWorld = getWorldTransform(obj, allObjects)
  const pathWorld = getWorldTransform(pathObj, allObjects)
  const worldPath = evaluatePathCurve(pathObj.mesh.vertices.map((v) => applyTransform(v, pathWorld)))
  if (worldPath.length < 2) return null
  const pathLength = polylineLength(worldPath)
  const angleProfile = buildTurnAngleProfile(worldPath)
  const centerlineTurn = turnAngleAt(angleProfile, pathLength)
  const base = settings.stretch ? 0 : settings.pathOffset

  // Local-axis coordinates are scaled into world-length units (via this object's own composed
  // scale) so they line up with the path's own world-unit arc length — rotation/position are
  // deliberately NOT applied here (this deform replaces them for the along-path direction; the
  // final `inverseTransform` below still round-trips rotation/position/scale correctly for
  // wherever the *result* needs storing back as a local vertex).
  const uScale = Math.abs(settings.axis === 'x' ? objWorld.scaleX : objWorld.scaleY)
  const dScale = Math.abs(settings.axis === 'x' ? objWorld.scaleY : objWorld.scaleX)
  const uOf = (v: Vec2) => (settings.axis === 'x' ? v.x : v.y) * uScale
  const dOf = (v: Vec2) => (settings.axis === 'x' ? v.y : v.x) * dScale

  let minU = Infinity
  let maxU = -Infinity
  for (const v of obj.mesh.vertices) {
    const u = uOf(v)
    if (u < minU) minU = u
    if (u > maxU) maxU = u
  }
  const localSpan = Math.max(1e-6, maxU - minU)

  return obj.mesh.vertices.map((v) => {
    const u = uOf(v)
    const d = dOf(v) + settings.center
    // Stretch mode: this vertex's own offset curve should span the same fraction of the path that
    // its own local-axis position spans of the mesh's own local-axis extent, but measured along
    // that offset curve's own length (which differs from the centerline's — a curve offset inward
    // is shorter, outward is longer). Fixed mode: this vertex's own offset curve should travel its
    // actual local-axis distance, unstretched — see `PathDeformSettings.stretch`.
    const target = settings.stretch ? ((u - minU) / localSpan) * (pathLength - d * centerlineTurn) : u
    const pathArcLength = solveOffsetArcLength(angleProfile, base, target, d)
    const { point, normal } = samplePolyline(worldPath, pathArcLength, pathLength)
    // Clamp the total lateral push to just inside the path's local turning radius there, so a
    // large `center` can't push a vertex past the curve's own center and fold the mesh onto
    // itself on a tight bend — see `localTurnRadius`'s doc.
    const radius = localTurnRadius(worldPath, pathArcLength, pathLength)
    const maxLateral = radius * 0.9
    const lateral = Math.sign(d) * Math.min(Math.abs(d), maxLateral)
    const newWorld = {
      x: point.x + normal.x * lateral,
      y: point.y + normal.y * lateral,
    }
    const newLocal = inverseTransform(newWorld, objWorld)
    return { x: newLocal.x - v.x, y: newLocal.y - v.y }
  })
}
