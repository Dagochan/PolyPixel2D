import type { Transform, Vec2 } from './types'

/** Rotation/scale happen about t.pivot (in local space); t.x/t.y is the pivot's world position. */
export function applyTransform(p: Vec2, t: Transform): Vec2 {
  const relX = p.x - t.pivot.x
  const relY = p.y - t.pivot.y
  const sx = relX * t.scaleX
  const sy = relY * t.scaleY
  const cos = Math.cos(t.rotation)
  const sin = Math.sin(t.rotation)
  return {
    x: t.x + sx * cos - sy * sin,
    y: t.y + sx * sin + sy * cos,
  }
}

/** Inverse of applyTransform: world point -> local (pre-scale-rotate-translate) mesh space. */
export function inverseTransform(p: Vec2, t: Transform): Vec2 {
  const dx = p.x - t.x
  const dy = p.y - t.y
  const cos = Math.cos(-t.rotation)
  const sin = Math.sin(-t.rotation)
  const rx = dx * cos - dy * sin
  const ry = dx * sin + dy * cos
  return {
    x: t.pivot.x + (t.scaleX !== 0 ? rx / t.scaleX : 0),
    y: t.pivot.y + (t.scaleY !== 0 ? ry / t.scaleY : 0),
  }
}

export function worldBounds(vertices: Vec2[], t: Transform) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const v of vertices) {
    const p = applyTransform(v, t)
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY }
}
