import { applyFakeFlagSway, fakeFlagVertexDeltas } from './fakeFlag'
import { applyFollowPath } from './followPath'
import { applyVolumePreserve } from './volumePreserve'
import { fakePhysicsMeshVertexDeltas } from './fakePhysicsMesh'
import { ffdVertexDeltas } from './ffd'
import { pathDeformRailVertexDeltas } from './pathDeformRail'
import { displayVertices } from './shapeKeys'
import type { AnimationClip, SceneObject, Vec2 } from './types'

export interface ComposeDisplayOptions {
  editingShapeKeyId: string | null
  fakeFlagTime: number
  fakeFlagLoopDuration: number
  activeClip: AnimationClip | undefined
  playheadTime: number
  /** Which object (if any) should show its isolated single-shape-key sculpt view instead of the
   *  normal blend (see `displayVertices`) — only meaningful while actively editing that key in
   *  Edit Mode. Omit/null for a read-only render (Pixel Preview has no such concept). */
  isolatedShapeKeyObjectId?: string | null
  /** Overrides the default (clip-sampled) Fake Physics (mesh) deltas — Viewport.tsx supplies its
   *  own per-frame live drag-preview simulation here while `previewFakePhysicsMesh` is on; omit
   *  for the default `fakePhysicsMeshVertexDeltas(rawObj, activeClip, playheadTime)`. */
  physicsMeshDeltasOverride?: (rawObj: SceneObject) => Vec2[] | null
}

/** Every visible object's fully-composed *displayed* pose for one frame: Fake Flag sway/Follow
 *  Path/Volume Preserve baked into `transform` (see `applyFakeFlagSway`/`applyFollowPath`/
 *  `applyVolumePreserve`), then every per-vertex
 *  deform chained onto `mesh.vertices` in the same order Viewport.tsx's render loop applies them
 *  (shape keys → Fake Flag vertex-mode → Fake Physics mesh → Path Deform → FFD). `kind: 'empty'`/
 *  `'path'` objects have no mesh to deform and pass through unchanged (aside from the transform
 *  overlay everything gets).
 *
 *  Both Viewport.tsx and PixelPreview.tsx need this exact composition — a mismatch is precisely
 *  what caused PixelPreview.tsx to silently omit every one of these deforms for a long stretch
 *  (see project spec/issue notes): it drew `obj.mesh.vertices` raw, never having called any of
 *  this. Pulled out here as the one shared place both call, instead of split, drifting copies.
 *
 *  Runs in two passes rather than one single `.map` because FFD needs its cage's *already
 *  shape-keyed(+Fake Flag+Fake Physics)* vertices, not its raw Basis (see `ffd.ts`'s doc) — and an
 *  object can reference another object as its cage regardless of array order. Pass 1 computes
 *  every object's pose up through Fake Physics (mesh) and stashes it by id; pass 2 does Path
 *  Deform + FFD, letting FFD look its cage up in that map instead of reading `cage.mesh.vertices`
 *  directly. */
export function composeDisplayObjects(rawObjects: SceneObject[], opts: ComposeDisplayOptions): SceneObject[] {
  const objects = applyVolumePreserve(applyFollowPath(applyFakeFlagSway(rawObjects, opts.fakeFlagTime, opts.fakeFlagLoopDuration)))

  const physicsDeformedById = new Map<string, Vec2[]>()
  for (const rawObj of objects) {
    if (rawObj.kind === 'empty' || rawObj.kind === 'path') continue

    const isSelected = rawObj.id === opts.isolatedShapeKeyObjectId
    const shapeKeyVerts = displayVertices(rawObj, opts.editingShapeKeyId, isSelected)
    const flagDeltas = fakeFlagVertexDeltas(rawObj, opts.fakeFlagTime, opts.fakeFlagLoopDuration)
    const swayedVerts = flagDeltas
      ? shapeKeyVerts.map((v, i) => ({ x: v.x + flagDeltas[i].x, y: v.y + flagDeltas[i].y }))
      : shapeKeyVerts

    const physicsMeshDeltas = opts.physicsMeshDeltasOverride
      ? opts.physicsMeshDeltasOverride(rawObj)
      : fakePhysicsMeshVertexDeltas(rawObj, opts.activeClip, opts.playheadTime)
    const physicsDeformedVerts = physicsMeshDeltas
      ? swayedVerts.map((v, i) => ({ x: v.x + physicsMeshDeltas[i].x, y: v.y + physicsMeshDeltas[i].y }))
      : swayedVerts

    physicsDeformedById.set(rawObj.id, physicsDeformedVerts)
  }

  return objects.map((rawObj) => {
    if (rawObj.kind === 'empty' || rawObj.kind === 'path') return rawObj
    const physicsDeformedVerts = physicsDeformedById.get(rawObj.id)!

    const pathDeformDeltas = pathDeformRailVertexDeltas(rawObj, objects)
    const pathDeformedVerts = pathDeformDeltas
      ? physicsDeformedVerts.map((v, i) => ({ x: v.x + pathDeformDeltas[i].x, y: v.y + pathDeformDeltas[i].y }))
      : physicsDeformedVerts

    const ffdDeltas = ffdVertexDeltas(rawObj, objects, physicsDeformedById)
    const displayVerts = ffdDeltas
      ? pathDeformedVerts.map((v, i) => ({ x: v.x + ffdDeltas[i].x, y: v.y + ffdDeltas[i].y }))
      : pathDeformedVerts

    return displayVerts === rawObj.mesh.vertices ? rawObj : { ...rawObj, mesh: { ...rawObj.mesh, vertices: displayVerts } }
  })
}
