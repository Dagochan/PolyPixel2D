import type { SceneObject } from './types'

export interface ResolvedInsert {
  hostId: string
  slotId: string
  rank: number
  object: SceneObject
}

/** Resolves every object's `insertSlots` against the scene's `slotName`s: figures out which
 *  object (if any) fills each reserved slot, and which objects are "consumed" by being inserted
 *  elsewhere (so they should be skipped from their own normal place in the document order).
 *
 *  Ambiguity is deliberately handled with the simplest rule that can't produce a broken/duplicated
 *  render: if multiple objects ever end up with the same `slotName` (the Properties panel is
 *  supposed to prevent this, but data can get into that state via undo/project loading), only the
 *  backmost one (lowest `zOrder`) is matchable. If multiple slots (anywhere) target the same
 *  `slotName`, only the first one encountered (host order, then slot order) actually claims it —
 *  later claims see it as already consumed and leave their slot empty rather than duplicating it.
 *  A slot whose own host already owns the target name is ignored (no self-insertion loops). */
export function resolveInsertSlots(objects: SceneObject[]): {
  insertsByHost: Map<string, ResolvedInsert[]>
  consumedIds: Set<string>
} {
  const sortedByZ = [...objects].sort((a, b) => a.zOrder - b.zOrder)

  const slotNameToObject = new Map<string, SceneObject>()
  for (const obj of sortedByZ) {
    if (obj.slotName && !slotNameToObject.has(obj.slotName)) slotNameToObject.set(obj.slotName, obj)
  }

  const consumedIds = new Set<string>()
  const insertsByHost = new Map<string, ResolvedInsert[]>()
  for (const host of sortedByZ) {
    for (const slot of host.insertSlots ?? []) {
      if (!slot.targetSlotName) continue
      const target = slotNameToObject.get(slot.targetSlotName)
      if (!target || target.id === host.id || consumedIds.has(target.id)) continue
      consumedIds.add(target.id)
      const list = insertsByHost.get(host.id) ?? []
      list.push({ hostId: host.id, slotId: slot.id, rank: slot.rank, object: target })
      insertsByHost.set(host.id, list)
    }
  }
  return { insertsByHost, consumedIds }
}
