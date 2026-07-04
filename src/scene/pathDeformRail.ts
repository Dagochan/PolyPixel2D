import { evaluatePathCurve, polylineLength, samplePolyline } from './pathCurve'
import { applyTransform, getWorldTransform, inverseTransform } from './transformUtils'
import type { PathDeformRailSettings, SceneObject, Vec2 } from './types'

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
