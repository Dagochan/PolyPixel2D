import type { Modifier, SceneObject, Vec2 } from './types'

function remapRecord<T>(
  record: Record<number, T> | undefined,
  oldToNew: Map<number, number>,
): Record<number, T> | undefined {
  if (!record) return record
  const next: Record<number, T> = {}
  for (const [key, value] of Object.entries(record)) {
    const newIndex = oldToNew.get(Number(key))
    if (newIndex !== undefined) next[newIndex] = value
  }
  return next
}

function remapIndices(indices: number[] | undefined, oldToNew: Map<number, number>): number[] | undefined {
  if (!indices) return indices
  return indices.map((i) => oldToNew.get(i)).filter((i): i is number => i !== undefined)
}

function remapModifier(m: Modifier, oldToNew: Map<number, number>): Modifier {
  if (m.type === 'fakeFlag' && m.settings.anchorVertices) {
    return { ...m, settings: { ...m.settings, anchorVertices: remapIndices(m.settings.anchorVertices, oldToNew) } }
  }
  if (m.type === 'fakePhysicsMesh') {
    const sectionVertices = m.settings.sectionVertices.map((arr) => remapIndices(arr, oldToNew) ?? []) as [
      number[],
      number[],
      number[],
      number[],
      number[],
    ]
    return { ...m, settings: { ...m.settings, sectionVertices } }
  }
  return m
}

/** After a topology edit that can drop/reorder vertices (delete, dissolve, merge — unlike cuts or
 *  extrude, which only append), every vertex-index-keyed field on the object needs remapping too,
 *  or it silently keeps pointing at whatever vertex now sits at that old index (or a vertex that no
 *  longer exists). Covers `uvBaseVertices`, `shapeKeys[].positions`, and per-modifier vertex refs
 *  (e.g. Fake Flag's `anchorVertices`) — extend `remapModifier` when a new modifier gains one. */
export function remapObjectVertexData(obj: SceneObject, oldToNew: Map<number, number>): Partial<SceneObject> {
  const patch: Partial<SceneObject> = {
    uvBaseVertices: remapRecord(obj.uvBaseVertices, oldToNew) as Record<number, Vec2> | undefined,
  }
  if (obj.shapeKeys) {
    patch.shapeKeys = obj.shapeKeys.map((sk) => ({ ...sk, positions: remapRecord(sk.positions, oldToNew) ?? {} }))
  }
  if (obj.modifiers) {
    patch.modifiers = obj.modifiers.map((m) => remapModifier(m, oldToNew))
  }
  return patch
}
