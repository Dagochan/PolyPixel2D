import type { SceneObject, ShapeKey, Vec2 } from './types'

/** Interpolates from `basis` to `target` by `w`, sweeping along an arc around `pivot` (polar
 *  decompose both points, lerp radius and angle independently, recompose) instead of a straight
 *  Cartesian line — avoids the volume loss/pinching a plain lerp shows on large rotations. Angle
 *  interpolates the short way around. Degenerates gracefully when a point sits on the pivot
 *  (radius 0, angle irrelevant there). */
function arcLerp(basis: Vec2, target: Vec2, pivot: Vec2, w: number): Vec2 {
  const r0 = Math.hypot(basis.x - pivot.x, basis.y - pivot.y)
  const r1 = Math.hypot(target.x - pivot.x, target.y - pivot.y)
  const a0 = Math.atan2(basis.y - pivot.y, basis.x - pivot.x)
  const a1 = Math.atan2(target.y - pivot.y, target.x - pivot.x)
  let da = a1 - a0
  while (da > Math.PI) da -= 2 * Math.PI
  while (da < -Math.PI) da += 2 * Math.PI
  const r = r0 + (r1 - r0) * w
  const a = a0 + da * w
  return { x: pivot.x + r * Math.cos(a), y: pivot.y + r * Math.sin(a) }
}

/** One key's own displacement of a single Basis vertex at weight `w` — Linear (default) lerps
 *  straight to the target; Arc (with a pivot set) sweeps along an arc instead. Always returns a
 *  displacement *from* `basis`, so callers can sum several keys' contributions additively. */
function keyDelta(key: ShapeKey, basis: Vec2, target: Vec2, w: number): Vec2 {
  if (key.interpolation === 'arc' && key.arcPivot) {
    const pos = arcLerp(basis, target, key.arcPivot, w)
    return { x: pos.x - basis.x, y: pos.y - basis.y }
  }
  return { x: w * (target.x - basis.x), y: w * (target.y - basis.y) }
}

/** All shape keys additively blended onto the Basis (live `mesh.vertices`) by their current
 *  weight in `shapeKeyValues`. Returns `mesh.vertices` unchanged when there are no shape keys,
 *  so callers can substitute this in everywhere with zero behavior change for existing scenes. */
export function blendedVertices(obj: SceneObject): Vec2[] {
  if (!obj.shapeKeys?.length) return obj.mesh.vertices
  return obj.mesh.vertices.map((basis, i) => {
    let x = basis.x
    let y = basis.y
    for (const key of obj.shapeKeys!) {
      const w = obj.shapeKeyValues?.[key.id] ?? 0
      if (!w) continue
      const target = key.positions[i] ?? basis
      const d = keyDelta(key, basis, target, w)
      x += d.x
      y += d.y
    }
    return { x, y }
  })
}

/** This one key's own pose alone, at full weight, ignoring every other key's weight — the
 *  "sculpt this key in isolation" view shown while it's the active edit target. */
export function isolatedKeyVertices(obj: SceneObject, keyId: string): Vec2[] {
  const key = obj.shapeKeys?.find((k) => k.id === keyId)
  if (!key) return obj.mesh.vertices
  return obj.mesh.vertices.map((basis, i) => key.positions[i] ?? basis)
}

/** The vertex array that should actually be drawn/hit-tested for this object right now: the
 *  isolated pose of the key being sculpted (if this is the selected object and a key is being
 *  edited), otherwise the normal additive blend of all keys. */
export function displayVertices(obj: SceneObject, editingShapeKeyId: string | null, isSelected: boolean): Vec2[] {
  if (isSelected && editingShapeKeyId) return isolatedKeyVertices(obj, editingShapeKeyId)
  return blendedVertices(obj)
}
