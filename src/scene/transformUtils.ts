import type { SceneObject, Transform, Vec2 } from './types'

/** Rotation/scale happen about t.head (in local space); t.x/t.y is the head's world position. */
export function applyTransform(p: Vec2, t: Transform): Vec2 {
  const relX = p.x - t.head.x
  const relY = p.y - t.head.y
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
    x: t.head.x + (t.scaleX !== 0 ? rx / t.scaleX : 0),
    y: t.head.y + (t.scaleY !== 0 ? ry / t.scaleY : 0),
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

const IDENTITY_TRANSFORM: Transform = { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, head: { x: 0, y: 0 } }

/** Rotate/scale a local-space vector by a world transform's rotation+scale only (no translation) —
 *  used to carry a child's local offset into its parent's world-rotated/scaled space. */
function rotateScale(v: Vec2, t: Transform): Vec2 {
  const sx = v.x * t.scaleX
  const sy = v.y * t.scaleY
  const cos = Math.cos(t.rotation)
  const sin = Math.sin(t.rotation)
  return { x: sx * cos - sy * sin, y: sx * sin + sy * cos }
}

/** Inverse of rotateScale: undo a world transform's rotation+scale only (no translation). */
function inverseRotateScale(v: Vec2, t: Transform): Vec2 {
  const cos = Math.cos(-t.rotation)
  const sin = Math.sin(-t.rotation)
  const rx = v.x * cos - v.y * sin
  const ry = v.x * sin + v.y * cos
  return { x: t.scaleX !== 0 ? rx / t.scaleX : 0, y: t.scaleY !== 0 ? ry / t.scaleY : 0 }
}

/** This object's world tail position, given its already-resolved world transform: the local
 *  `tail` point carried through `applyTransform` exactly like any other local mesh point. */
export function getWorldTail(obj: SceneObject, worldTransform: Transform): Vec2 {
  return applyTransform(obj.tail, worldTransform)
}

/** Composes the world transform of every ancestor of `obj` (NOT including `obj` itself) into a
 *  single identity-rooted Transform, plus that ancestor chain's resolved world tail position
 *  (where this object's head attaches, if connected). Cycle-safe: a cycle in `parentId` is
 *  treated as if the offending object were a root, rather than looping forever. */
export function getParentWorldTransform(
  obj: SceneObject,
  allObjects: SceneObject[],
): { transform: Transform; tail: Vec2 } {
  if (obj.parentId === null) return { transform: IDENTITY_TRANSFORM, tail: { x: 0, y: 0 } }

  const byId = new Map(allObjects.map((o) => [o.id, o]))
  // Walk the chain from `obj` up to the root, collecting ancestors; bail out (cycle) if `obj`'s
  // own id is revisited.
  const chain: SceneObject[] = []
  const visited = new Set<string>([obj.id])
  let currentParentId: string | null = obj.parentId
  while (currentParentId !== null) {
    if (visited.has(currentParentId)) break // cycle — treat as if it stopped here (root)
    const parent = byId.get(currentParentId)
    if (!parent) break
    visited.add(parent.id)
    chain.push(parent)
    currentParentId = parent.parentId
  }
  // chain is [closest ancestor, ..., root]; compose root-to-closest.
  chain.reverse()

  let world: Transform = IDENTITY_TRANSFORM
  let tail: Vec2 = { x: 0, y: 0 }
  for (const ancestor of chain) {
    // ancestor's own world transform, given the chain composed so far (`world`/`tail`). `connected`
    // is only meaningful for an ancestor that itself has a parent — a root ancestor's x/y is its
    // real world position regardless of its (possibly just-defaulted) `connected` flag.
    const isConnectedChild = ancestor.connected && ancestor.parentId !== null
    const localXY = isConnectedChild ? { x: 0, y: 0 } : { x: ancestor.transform.x, y: ancestor.transform.y }
    const worldOffset = rotateScale(localXY, world)
    const ancestorWorld: Transform = {
      x: tail.x + worldOffset.x,
      y: tail.y + worldOffset.y,
      rotation: world.rotation + ancestor.transform.rotation,
      scaleX: world.scaleX * ancestor.transform.scaleX,
      scaleY: world.scaleY * ancestor.transform.scaleY,
      head: ancestor.transform.head,
    }
    world = ancestorWorld
    tail = getWorldTail(ancestor, ancestorWorld)
  }
  return { transform: world, tail }
}

/** This object's fully resolved world transform (head's world position, accumulated
 *  rotation/scale up the parent chain). For a root object this is just `obj.transform`
 *  unchanged — root behavior is byte-for-byte identical to having no parent system at all. */
export function getWorldTransform(obj: SceneObject, allObjects: SceneObject[]): Transform {
  if (obj.parentId === null) return obj.transform
  const { transform: parentWorld, tail: parentTail } = getParentWorldTransform(obj, allObjects)
  const localXY = obj.connected ? { x: 0, y: 0 } : { x: obj.transform.x, y: obj.transform.y }
  const worldOffset = rotateScale(localXY, parentWorld)
  return {
    x: parentTail.x + worldOffset.x,
    y: parentTail.y + worldOffset.y,
    rotation: parentWorld.rotation + obj.transform.rotation,
    scaleX: parentWorld.scaleX * obj.transform.scaleX,
    scaleY: parentWorld.scaleY * obj.transform.scaleY,
    head: obj.transform.head,
  }
}

/** Inverse of the world-position part of getWorldTransform: given a desired world (x,y) for this
 *  object's head and its parent's resolved world transform/tail, returns the local `x`/`y` that
 *  must be stored on `obj.transform` to achieve it. (Only meaningful for a `connected: false`
 *  child — a connected child's local x/y is always (0,0) regardless of what's passed in here.) */
export function worldPositionToLocalOffset(worldXY: Vec2, parentWorld: Transform, parentTail: Vec2): Vec2 {
  const rel = { x: worldXY.x - parentTail.x, y: worldXY.y - parentTail.y }
  return inverseRotateScale(rel, parentWorld)
}
