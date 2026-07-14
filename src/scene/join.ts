import type { SceneObject, ShapeKey, Vec2 } from './types'
import { applyTransform, getWorldTransform, inverseTransform } from './transformUtils'
import { findIslands } from './uv'

/** Blender's Ctrl+J (Join), scoped to plain meshes with no hierarchy of their own (see
 *  `joinSelection`'s doc for why parented/parent objects are rejected before this ever runs).
 *  Merges every donor's geometry into `target`'s local space — each donor vertex is carried
 *  through its own world transform and back through `target`'s inverse, so the combined mesh
 *  keeps everyone's on-screen position/rotation/scale exactly as it was before the join (this is
 *  the one thing the merge must get right; everything else here is best-effort appearance
 *  preservation). `target`'s own `transform`/`tail`/`parentId`/`connected`/`material` survive
 *  untouched — only its `mesh` and the handful of per-vertex/per-island fields below change.
 *
 *  A donor's uniform `material.color` gets baked as an explicit `faceColors` override onto every
 *  one of its faces that doesn't already have one (the merged object only has one `Material`, so
 *  without this a donor whose color differs from `target`'s would silently change color).
 *  A donor's own `Modifier`s and texture are dropped — there's no meaningful way to stack a
 *  second Fake Physics/Fake Flag/etc. onto an object that already has at most one of each, and
 *  this app has no per-face texture override to carry a second texture over either.
 *
 *  Island display state (`islandZOrders`/`islandNames`/`islandVisible`/`islandLocked`) is
 *  recomputed from scratch onto the merged mesh's own (new) island indices, ordered by each
 *  source object's scene `zOrder` first and its own islands' existing relative order second — so
 *  the combined stack of islands draws in exactly the order it already appeared in before the
 *  join, just folded into one object. */
export function joinObjects(target: SceneObject, donors: SceneObject[]): SceneObject {
  if (donors.length === 0) return target
  const targetWorld = getWorldTransform(target, [target, ...donors])

  const vertices: Vec2[] = target.mesh.vertices.map((v) => ({ ...v }))
  const faces: number[][] = target.mesh.faces.map((f) => [...f])
  const faceColors: Record<number, string> = { ...(target.mesh.faceColors ?? {}) }
  const uvBaseVertices: Record<number, Vec2> = { ...(target.uvBaseVertices ?? {}) }
  const shapeKeys: ShapeKey[] = [...(target.shapeKeys ?? [])]
  const shapeKeyValues: Record<string, number> = { ...(target.shapeKeyValues ?? {}) }

  // each source's [start, end) face-index range in the merged mesh, and its own (pre-merge)
  // island list — both needed below to figure out which original island a merged island came
  // from, so its relative order can be preserved.
  const faceRangeBySource = new Map<string, { start: number; end: number }>()
  const islandsBySource = new Map<string, ReturnType<typeof findIslands>>()
  faceRangeBySource.set(target.id, { start: 0, end: faces.length })
  islandsBySource.set(target.id, findIslands(target.mesh))

  for (const donor of donors) {
    const donorWorld = getWorldTransform(donor, [target, ...donors])
    const vertexOffset = vertices.length
    const faceOffset = faces.length

    for (const v of donor.mesh.vertices) {
      vertices.push(inverseTransform(applyTransform(v, donorWorld), targetWorld))
    }
    for (const f of donor.mesh.faces) {
      faces.push(f.map((i) => i + vertexOffset))
    }
    faceRangeBySource.set(donor.id, { start: faceOffset, end: faces.length })
    islandsBySource.set(donor.id, findIslands(donor.mesh))

    if (donor.mesh.faceColors) {
      for (const [fi, color] of Object.entries(donor.mesh.faceColors)) {
        faceColors[Number(fi) + faceOffset] = color
      }
    }
    if (donor.material.color !== target.material.color) {
      donor.mesh.faces.forEach((_, fi) => {
        const key = fi + faceOffset
        if (!(key in faceColors)) faceColors[key] = donor.material.color
      })
    }
    if (donor.uvBaseVertices) {
      for (const [vi, p] of Object.entries(donor.uvBaseVertices)) {
        uvBaseVertices[Number(vi) + vertexOffset] = p
      }
    }
    for (const sk of donor.shapeKeys ?? []) {
      const positions: Record<number, Vec2> = {}
      for (const [vi, p] of Object.entries(sk.positions)) {
        // `positions` holds absolute target positions in the same (local mesh) space as
        // `mesh.vertices` — needs the identical donor-world -> target-local conversion, not just
        // a reindexed key, or a moved/rotated donor's shape key would sculpt toward the wrong spot
        positions[Number(vi) + vertexOffset] = inverseTransform(applyTransform(p, donorWorld), targetWorld)
      }
      shapeKeys.push({
        ...sk,
        positions,
        arcPivot: sk.arcPivot ? inverseTransform(applyTransform(sk.arcPivot, donorWorld), targetWorld) : undefined,
      })
      const weight = donor.shapeKeyValues?.[sk.id]
      if (weight !== undefined) shapeKeyValues[sk.id] = weight
    }
  }

  const sourcesByZOrder = [target, ...donors].slice().sort((a, b) => a.zOrder - b.zOrder)
  const sourceForFace = (fi: number): SceneObject => {
    for (const src of sourcesByZOrder) {
      const range = faceRangeBySource.get(src.id)!
      if (fi >= range.start && fi < range.end) return src
    }
    return target
  }

  const mergedIslands = findIslands({ vertices, faces })
  const islandRanks = mergedIslands.map((island, newIdx) => {
    const repFace = Math.min(...island.faces)
    const src = sourceForFace(repFace)
    const range = faceRangeBySource.get(src.id)!
    const localFaceIdx = repFace - range.start
    const srcIslands = islandsBySource.get(src.id)!
    const origIslandIdx = Math.max(0, srcIslands.findIndex((si) => si.faces.includes(localFaceIdx)))
    const srcRank = src.islandZOrders?.[origIslandIdx] ?? origIslandIdx
    return { newIdx, src, origIslandIdx, srcRank }
  })
  islandRanks.sort((a, b) => a.src.zOrder - b.src.zOrder || a.srcRank - b.srcRank)

  const islandZOrders: Record<number, number> = {}
  const islandNames: Record<number, string> = {}
  const islandVisible: Record<number, boolean> = {}
  const islandLocked: Record<number, boolean> = {}
  islandRanks.forEach(({ newIdx, src, origIslandIdx }, rank) => {
    islandZOrders[newIdx] = rank
    const name = src.islandNames?.[origIslandIdx]
    if (name !== undefined) islandNames[newIdx] = name
    const visible = src.islandVisible?.[origIslandIdx]
    if (visible !== undefined) islandVisible[newIdx] = visible
    const locked = src.islandLocked?.[origIslandIdx]
    if (locked !== undefined) islandLocked[newIdx] = locked
  })

  return {
    ...target,
    mesh: { vertices, faces, ...(Object.keys(faceColors).length ? { faceColors } : {}) },
    uvBaseVertices: Object.keys(uvBaseVertices).length ? uvBaseVertices : undefined,
    shapeKeys: shapeKeys.length ? shapeKeys : undefined,
    shapeKeyValues: Object.keys(shapeKeyValues).length ? shapeKeyValues : undefined,
    islandZOrders,
    islandNames: Object.keys(islandNames).length ? islandNames : undefined,
    islandVisible: Object.keys(islandVisible).length ? islandVisible : undefined,
    islandLocked: Object.keys(islandLocked).length ? islandLocked : undefined,
  }
}
