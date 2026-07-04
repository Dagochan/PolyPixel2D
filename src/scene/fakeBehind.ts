import type { FakeBehindSettings, SceneObject } from './types'

/** This object's FakeBehind settings, if it has that modifier in its stack (see `Modifier`) —
 *  `undefined` otherwise. */
export function getFakeBehind(obj: SceneObject): FakeBehindSettings | undefined {
  return obj.modifiers?.find((m): m is Extract<typeof m, { type: 'fakeBehind' }> => m.type === 'fakeBehind')
    ?.settings
}

export const DEFAULT_FAKE_BEHIND_SETTINGS: FakeBehindSettings = {
  enabled: true,
  maskObjectIds: [],
}

/** Up to this many FakeBehind masks can be active in the scene at once — each gets its own bit
 *  in the (8-bit) WebGL stencil buffer, so a target can be cut by any combination of its
 *  referenced masks in a single draw (see `Viewport.tsx`'s stencil pass). */
export const MAX_FAKE_BEHIND_MASKS = 8

/** Which objects currently act as a FakeBehind mask — derived from every *other* object's
 *  `maskObjectIds`, rather than a role flag stored on the mask itself. Any object can be
 *  referenced (no separate "mark this as a mask" step): pick it in some other object's Fake
 *  Behind modifier and it becomes a mask, purely by being referenced. Used both by the stencil
 *  render passes (`Viewport.tsx`/`PixelPreview.tsx`) and by the Outliner/Properties UI to show
 *  which objects are currently playing that role. */
export function collectFakeBehindMaskIds(objects: SceneObject[]): Set<string> {
  const ids = new Set<string>()
  for (const o of objects) {
    const settings = getFakeBehind(o)
    if (!settings?.enabled) continue
    for (const maskId of settings.maskObjectIds) ids.add(maskId)
  }
  return ids
}
