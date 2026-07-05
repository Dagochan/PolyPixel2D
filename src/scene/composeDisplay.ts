import { applyFakeFlagSway, fakeFlagVertexDeltas } from './fakeFlag'
import { applyFollowPath } from './followPath'
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
 *  Path baked into `transform` (see `applyFakeFlagSway`/`applyFollowPath`), then every per-vertex
 *  deform chained onto `mesh.vertices` in the same order Viewport.tsx's render loop applies them
 *  (shape keys → Fake Flag vertex-mode → Fake Physics mesh → Path Deform → FFD). `kind: 'empty'`/
 *  `'path'` objects have no mesh to deform and pass through unchanged (aside from the transform
 *  overlay everything gets).
 *
 *  Both Viewport.tsx and PixelPreview.tsx need this exact composition — a mismatch is precisely
 *  what caused PixelPreview.tsx to silently omit every one of these deforms for a long stretch
 *  (see project spec/issue notes): it drew `obj.mesh.vertices` raw, never having called any of
 *  this. Pulled out here as the one shared place both call, instead of split, drifting copies. */
export function composeDisplayObjects(rawObjects: SceneObject[], opts: ComposeDisplayOptions): SceneObject[] {
  const objects = applyFollowPath(applyFakeFlagSway(rawObjects, opts.fakeFlagTime, opts.fakeFlagLoopDuration))
  return objects.map((rawObj) => {
    if (rawObj.kind === 'empty' || rawObj.kind === 'path') return rawObj

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

    const pathDeformDeltas = pathDeformRailVertexDeltas(rawObj, objects)
    const pathDeformedVerts = pathDeformDeltas
      ? physicsDeformedVerts.map((v, i) => ({ x: v.x + pathDeformDeltas[i].x, y: v.y + pathDeformDeltas[i].y }))
      : physicsDeformedVerts

    const ffdDeltas = ffdVertexDeltas(rawObj, objects)
    const displayVerts = ffdDeltas
      ? pathDeformedVerts.map((v, i) => ({ x: v.x + ffdDeltas[i].x, y: v.y + ffdDeltas[i].y }))
      : pathDeformedVerts

    return displayVerts === rawObj.mesh.vertices ? rawObj : { ...rawObj, mesh: { ...rawObj.mesh, vertices: displayVerts } }
  })
}
