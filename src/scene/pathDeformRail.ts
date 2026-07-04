import { evaluatePathCurve } from './pathCurve'
import { applyTransform, getWorldTransform, inverseTransform } from './transformUtils'
import type { PathDeformRailSettings, SceneObject, Vec2 } from './types'

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
 *  the lateral offset amplifies them into a visible flicker as `pathOffset` sweeps the sampled
 *  position across segment joints during animation. Central-differencing over a wider window
 *  smooths the normal continuously past those joints instead. */
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

/** This object's Path Deform (Rail) settings, if it has that modifier in its stack (see
 *  `Modifier`) — `undefined` otherwise. */
export function getPathDeformRail(obj: SceneObject): PathDeformRailSettings | undefined {
  return obj.modifiers?.find((m): m is Extract<typeof m, { type: 'pathDeformRail' }> => m.type === 'pathDeformRail')
    ?.settings
}

export const DEFAULT_PATH_DEFORM_RAIL_SETTINGS: PathDeformRailSettings = {
  enabled: true,
  pathObjectId: null,
  axis: 'x',
  flip: false,
  flipLateral: false,
  stretch: true,
  pathOffset: 0,
}

/** Per-vertex local-space deltas that bend `obj`'s Basis mesh along its assigned path object's
 *  curve — see project spec (the "2-rail" approach, and the two earlier designs it replaced).
 *  Every vertex sharing the same along-path coordinate `u` resolves to the exact same arc-length
 *  position `s` on the path (regardless of its own lateral distance `d`), so a whole cross-section
 *  (e.g. a lattice's left and right control points at the same `u`) always lands offset from a
 *  *single* shared point along the *same* shared normal there — perpendicular to the path by
 *  construction, with no separate arc-length bookkeeping per lateral offset needed (earlier designs
 *  tried resolving each lateral offset's own arc length independently, which desynced the two
 *  sides' cross-sections on a bend — see project spec). This is the right trade for a
 *  `kind: 'lattice'` cage's sparse control grid, where a detailed mesh's own decorative spacing
 *  isn't a concern (the *target* mesh referencing the cage via FFD gets its own smooth bilinear
 *  interpolation regardless of how the cage's own few control points space out). There's also no
 *  curvature clamp — offsetting by a large `d` past the path's own local turning radius still
 *  folds/overlaps there (same as any offset-path tool without trimming — see
 *  `PathDeformRailSettings`'s doc), but does so smoothly as `s` sweeps past that point, rather than
 *  snapping discontinuously in and out of a radius-based clamp. `null` when inactive (disabled or
 *  no path assigned). */
export function pathDeformRailVertexDeltas(obj: SceneObject, allObjects: SceneObject[]): Vec2[] | null {
  const settings = getPathDeformRail(obj)
  if (!settings?.enabled || !settings.pathObjectId) return null
  const pathObj = allObjects.find((o) => o.id === settings.pathObjectId && o.kind === 'path')
  if (!pathObj) return null
  if (obj.mesh.vertices.length === 0) return null

  const objWorld = getWorldTransform(obj, allObjects)
  const pathWorld = getWorldTransform(pathObj, allObjects)
  const worldPath = evaluatePathCurve(pathObj.mesh.vertices.map((v) => applyTransform(v, pathWorld)))
  if (worldPath.length < 2) return null
  const pathLength = polylineLength(worldPath)

  const uScale = Math.abs(settings.axis === 'x' ? objWorld.scaleX : objWorld.scaleY) * (settings.flip ? -1 : 1)
  const dScale = Math.abs(settings.axis === 'x' ? objWorld.scaleY : objWorld.scaleX) * (settings.flipLateral ? -1 : 1)
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
    const d = dOf(v)
    const s = settings.stretch ? ((u - minU) / localSpan) * pathLength : u + settings.pathOffset
    const { point, normal } = samplePolyline(worldPath, s, pathLength)
    const newWorld = { x: point.x + normal.x * d, y: point.y + normal.y * d }
    const newLocal = inverseTransform(newWorld, objWorld)
    return { x: newLocal.x - v.x, y: newLocal.y - v.y }
  })
}
