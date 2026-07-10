import type { SceneObject, VolumePreserveSettings } from './types'

/** This object's Volume Preserve settings, if it has that modifier in its stack (see `Modifier`)
 *  — `undefined` otherwise. Mirrors `getFollowPath`/`getFakeFlag`'s role for their own modifiers. */
export function getVolumePreserve(obj: SceneObject): VolumePreserveSettings | undefined {
  return obj.modifiers?.find((m): m is Extract<typeof m, { type: 'volumePreserve' }> => m.type === 'volumePreserve')
    ?.settings
}

export const DEFAULT_VOLUME_PRESERVE_SETTINGS: VolumePreserveSettings = {
  enabled: true,
  drivingAxis: 'y',
  strength: 1,
}

/** Floor for the driving axis's magnitude before raising it to a (possibly negative) power — same
 *  clamp convention as the object-mode scale handles themselves, so a driving scale that's been
 *  dragged to (near) zero doesn't blow the compensated axis up toward infinity. */
const MIN_DRIVING_MAGNITUDE = 0.01

/** The compensated (non-driving) axis's scale for one object, given its own driving axis's current
 *  scale — see `VolumePreserveSettings`'s doc for the `strength` formula. The compensated axis's
 *  *sign* is left as whatever it already was (a flipped axis stays flipped): area preservation is
 *  about magnitude, not mirroring. `null` when inactive (disabled), so callers can skip touching
 *  this object's transform at all, same convention as every other modifier here. */
export function volumePreserveOtherScale(obj: SceneObject): number | null {
  const settings = getVolumePreserve(obj)
  if (!settings?.enabled) return null
  const driving = settings.drivingAxis === 'x' ? obj.transform.scaleX : obj.transform.scaleY
  const drivingMagnitude = Math.max(MIN_DRIVING_MAGNITUDE, Math.abs(driving))
  const other = settings.drivingAxis === 'x' ? obj.transform.scaleY : obj.transform.scaleX
  const otherSign = Math.sign(other) || 1
  return otherSign * Math.pow(drivingMagnitude, -settings.strength)
}

/** Every Volume Preserve object in `objects`, with its non-driving scale axis recomputed from its
 *  driving axis for this instant — everything else passes through unchanged. Both axes are local
 *  values (unlike Follow Path's world-space target), so unlike `applyFollowPath` this needs no
 *  parent-chain conversion at all. Returns `objects` itself when nothing applies (zero-cost,
 *  matches the shape-key/Fake-Flag precedent). */
export function applyVolumePreserve(objects: SceneObject[]): SceneObject[] {
  if (!objects.some((o) => getVolumePreserve(o)?.enabled)) return objects
  return objects.map((o) => {
    const settings = getVolumePreserve(o)
    const otherScale = volumePreserveOtherScale(o)
    if (!settings || otherScale === null) return o
    return {
      ...o,
      transform: {
        ...o.transform,
        ...(settings.drivingAxis === 'x' ? { scaleY: otherScale } : { scaleX: otherScale }),
      },
    }
  })
}
