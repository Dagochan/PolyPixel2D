import { evaluatePathCurve, polylineLength, samplePolyline } from './pathCurve'
import { applyTransform, getParentWorldTransform, getWorldTransform, worldPositionToLocalOffset } from './transformUtils'
import type { FollowPathSettings, SceneObject } from './types'

/** This object's Follow Path settings, if it has that modifier in its stack (see `Modifier`) —
 *  `undefined` otherwise. */
export function getFollowPath(obj: SceneObject): FollowPathSettings | undefined {
  return obj.modifiers?.find((m): m is Extract<typeof m, { type: 'followPath' }> => m.type === 'followPath')?.settings
}

export const DEFAULT_FOLLOW_PATH_SETTINGS: FollowPathSettings = {
  enabled: true,
  pathObjectId: null,
  progress: 0,
  alignRotation: false,
  flip: false,
}

/** This object's world position (and, if `alignRotation`, world rotation and mirrored `scaleY`) at
 *  its current `progress` along its assigned path — the Blender "Follow Path" constraint analogue
 *  (see `FollowPathSettings`'s doc). Evaluated entirely in world space so the riding object's
 *  transform and the path's don't need to coincide (same convention as FakeBehind/Fake Physics/
 *  Path Deform). `null` when inactive (disabled or no path assigned) — the caller should leave the
 *  object's own transform untouched in that case, same convention as every other modifier here. */
export function followPathWorldTransform(
  obj: SceneObject,
  allObjects: SceneObject[],
): { x: number; y: number; rotation: number; scaleY: number } | null {
  const settings = getFollowPath(obj)
  if (!settings?.enabled || !settings.pathObjectId) return null
  const pathObj = allObjects.find((o) => o.id === settings.pathObjectId && o.kind === 'path')
  if (!pathObj) return null

  const pathWorld = getWorldTransform(pathObj, allObjects)
  const worldPath = evaluatePathCurve(pathObj.mesh.vertices.map((v) => applyTransform(v, pathWorld)), 12, pathObj.closed)
  if (worldPath.length < 2) return null
  const pathLength = polylineLength(worldPath)
  const s = Math.max(0, Math.min(1, settings.progress)) * pathLength
  const { point, normal } = samplePolyline(worldPath, s, pathLength, pathObj.closed)

  const objWorld = getWorldTransform(obj, allObjects)
  if (!settings.alignRotation) return { x: point.x, y: point.y, rotation: objWorld.rotation, scaleY: obj.transform.scaleY }
  // `normal` is the left-normal of the path's tangent there (see `samplePolyline`'s doc) — rotate
  // it -90° to recover the tangent (direction of travel) itself, then face that direction.
  const travelAngle = Math.atan2(-normal.x, normal.y)
  // Which way is "forward" is read from this object's own Tail→Head vector (in local space, i.e.
  // before this object's own rotation is applied) rather than assuming local +X — anatomical
  // head/tail (front/back), not Blender bone head/tail (base/tip): Head is the "face" that should
  // point where the object is going, Tail the back end trailing behind it — so an object modeled
  // facing any direction just needs its Head dragged (Pivot mode) to point that way once, no
  // separate axis-picker setting needed. A zero-length Tail→Head (Tail left at its default,
  // coincident with Head) falls back to local +X, matching the pre-Head/Tail-aware behavior.
  //
  // `flip` mirrors the object across that same Head→Tail axis (the one remaining degree of
  // freedom it can't pin down — e.g. a fish's dorsal/ventral side) — negating `fy` here before
  // taking the angle is what makes that an exact mirror *across the Head→Tail line itself* rather
  // than across local Y: negating `scaleY` alone would still render Tail's mirrored position at
  // `travelAngle - 2*forwardAngle` instead of `travelAngle` for any non-axis-aligned Head→Tail
  // line, visibly rotating Head off the path — folding the same negation into the angle computed
  // here keeps Head pointing exactly down the path regardless of `forwardAngle`. */
  const fx = obj.transform.head.x - obj.tail.x
  const fy = (obj.transform.head.y - obj.tail.y) * (settings.flip ? -1 : 1)
  const forwardAngle = fx === 0 && fy === 0 ? 0 : Math.atan2(fy, fx)
  return {
    x: point.x,
    y: point.y,
    rotation: travelAngle - forwardAngle,
    scaleY: settings.flip ? -obj.transform.scaleY : obj.transform.scaleY,
  }
}

/** Every Follow-Path object in `objects`, with its current `progress` along its path baked into
 *  `transform.x`/`y` (and `rotation`, if `alignRotation`) for this instant — everything else
 *  passes through unchanged. Mirrors `applyFakeFlagSway`'s "bake into local transform, so parent/
 *  child composition (`getWorldTransform`) naturally carries it into children" shape, but Follow
 *  Path computes an absolute *world* target rather than a rotation delta, so a parented object's
 *  target has to be converted back into local `x`/`y`/`rotation` via `getParentWorldTransform`/
 *  `worldPositionToLocalOffset` (a `connected: true` child's local `x`/`y` is always forced to
 *  (0,0) regardless of what's computed here — see `SceneObject.connected` — so Follow Path simply
 *  has no visible effect on one, same as trying to move it any other way). Returns `objects`
 *  itself when nothing applies (zero-cost, matches the shape-key/Fake-Flag precedent). */
export function applyFollowPath(objects: SceneObject[]): SceneObject[] {
  if (!objects.some((o) => getFollowPath(o)?.enabled)) return objects
  return objects.map((o) => {
    const target = followPathWorldTransform(o, objects)
    if (!target) return o
    if (o.parentId === null) {
      return {
        ...o,
        transform: { ...o.transform, x: target.x, y: target.y, rotation: target.rotation, scaleY: target.scaleY },
      }
    }
    const { transform: parentWorld, tail: parentTail } = getParentWorldTransform(o, objects)
    const localXY = worldPositionToLocalOffset({ x: target.x, y: target.y }, parentWorld, parentTail)
    return {
      ...o,
      transform: {
        ...o.transform,
        x: localXY.x,
        y: localXY.y,
        rotation: target.rotation - parentWorld.rotation,
        scaleY: target.scaleY,
      },
    }
  })
}
