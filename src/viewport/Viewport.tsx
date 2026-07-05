import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useSceneStore, selectedVertexIndices, type PendingPrimitive, type ReferenceImage } from '../scene/store'
import { triangulate, triangulatePolygon, getEdges, edgeKey, parseEdgeKey, getBounds, localBoundsCenter } from '../scene/meshUtils'
import {
  applyTransform,
  inverseTransform,
  worldBounds,
  getWorldTransform,
  getWorldTail,
  getParentWorldTransform,
  worldPositionToLocalOffset,
} from '../scene/transformUtils'
import { makeOrthoCamera, screenToWorld, updateOrthoCamera, type ViewState } from './camera2d'
import type { Mesh, PixelFrame, SceneObject, Transform, Vec2 } from '../scene/types'
import { findFullLoop, findEdgeLoop, type LoopPath } from '../scene/loopPath'
import { findFan, type FanPath } from '../scene/ringCut'
import type { KnifeCutPoint } from '../scene/knifeCut'
import { computeSplitUVIslands, findIslands } from '../scene/uv'
import { resolveInsertSlots } from '../scene/insertSlots'
import { displayVertices } from '../scene/shapeKeys'
import { applyFakeFlagSway, fakeFlagAnchorExtent, fakeFlagIndicatorSamples, fakeFlagVertexDeltas, getFakeFlag } from '../scene/fakeFlag'
import { pathDeformRailVertexDeltas } from '../scene/pathDeformRail'
import { applyFollowPath } from '../scene/followPath'
import { ffdVertexDeltas } from '../scene/ffd'
import { collectFakeBehindMaskIds, getFakeBehind, MAX_FAKE_BEHIND_MASKS } from '../scene/fakeBehind'
import {
  createFakePhysicsMeshLiveState,
  fakePhysicsMeshVertexDeltas,
  fakePhysicsMeshVertexDeltasLive,
  getFakePhysicsMesh,
  stepFakePhysicsMeshLive,
  type FakePhysicsMeshLiveState,
} from '../scene/fakePhysicsMesh'
import { createHairPathMesh } from '../scene/primitives'
import { boundsVertices, evaluatePathCurve, nearestSegmentInsertIndex } from '../scene/pathCurve'

const HANDLE_SIZE = 8 // px
const VERTEX_HIT_RADIUS = 8 // px
const GIZMO_HIT_TOLERANCE = 7 // px
const RING_RADIUS_PX = 56 // fixed screen size, like Blender's gizmo (doesn't scale with object size)
const ARROW_LENGTH_PX = 42
const EMPTY_GIZMO_SIZE = 12 // world units; stand-in "bounds" half-size for a mesh-less Empty
const EMPTY_HIT_RADIUS_PX = 10 // click hit-test radius for picking an Empty in the viewport
const HEAD_DOT_RADIUS_PX = 4 // pivot-mode Head handle: a small filled dot
const HEAD_HIT_RADIUS_PX = GIZMO_HIT_TOLERANCE * 1.5
// pivot-mode Tail handle: a larger hollow ring + crosshair (not just a different color from
// Head) so the two stay distinguishable — both as a click target and visually — even though
// Head and Tail default to the exact same position. `TAIL_HIT_RADIUS_PX` is deliberately bigger
// than `HEAD_HIT_RADIUS_PX`: since Head's (smaller) hit-test runs first, a click dead-center
// still resolves to Head, while the surrounding ring band only Tail's bigger radius reaches
// becomes real, clickable space for Tail — see the `mode === 'pivot'` hit-test.
const TAIL_RING_OUTER_RADIUS_PX = 11
const TAIL_CROSSHAIR_HALF_LENGTH_PX = 7
// kept proportional to the ring's own radius (same ~2.6x padding-over-visible-size ratio as
// Head's dot/hit-radius pair) rather than a fixed number, so bumping the ring size up doesn't
// also require remembering to separately rebalance the hit radius.
const TAIL_HIT_RADIUS_PX = TAIL_RING_OUTER_RADIUS_PX * 2.6
const HAIR_PATH_DEFAULT_WIDTH = 10 // world units — starting root width of a Hair Path, before any Shift+wheel adjustment
const HAIR_PATH_CP_HIT_RADIUS_PX = 10 // click hit-test radius for grabbing an already-placed control point
const FAKE_FLAG_RING_RADIUS_PX = 22 // fixed screen size rotate-ring for the direction handle, at the anchor root

/** The object as it should actually be displayed/hit-tested right now — every field identical
 *  to `obj` except `mesh.vertices`, which is swapped for the shape-key-evaluated pose (see
 *  `displayVertices`). A no-op (returns `obj` itself) whenever there's nothing to blend, so every
 *  caller can use this unconditionally with zero cost/behavior-change for shape-key-less objects. */
function getEffectiveObj(obj: SceneObject, editingShapeKeyId: string | null, isSelected: boolean): SceneObject {
  const verts = displayVertices(obj, editingShapeKeyId, isSelected)
  return verts === obj.mesh.vertices ? obj : { ...obj, mesh: { ...obj.mesh, vertices: verts } }
}

/** Vertex indices belonging to a locked island (Properties panel lock toggle) — locked
 *  geometry is completely ignored by click-select, box-select, and knife/loop-cut hover, on
 *  top of its wireframe/overlays being hidden during rendering (see the render pass in the
 *  main effect below, which computes this same set independently). */
function getLockedVertices(obj: SceneObject): Set<number> {
  const locked = new Set<number>()
  if (!obj.islandLocked) return locked
  const islands = findIslands(obj.mesh)
  islands.forEach((island, islandIdx) => {
    if (obj.islandLocked?.[islandIdx]) island.vertices.forEach((v) => locked.add(v))
  })
  return locked
}

type DragMode =
  | { kind: 'none' }
  | { kind: 'pan'; startClientX: number; startClientY: number; startPan: { x: number; y: number } }
  | {
      kind: 'move-object'
      objectId: string
      startWorld: { x: number; y: number }
      startWorldPos: { x: number; y: number }
      parentWorld: Transform
      parentTail: Vec2
    }
  | {
      kind: 'move-object-axis'
      objectId: string
      axisDir: { x: number; y: number } // unit vector, world space
      startWorld: { x: number; y: number }
      startWorldPos: { x: number; y: number }
      parentWorld: Transform
      parentTail: Vec2
    }
  | {
      kind: 'scale-object'
      objectId: string
      startTransform: SceneObject['transform']
      meshCornerRel: { x: number; y: number } // relative to pivot
      // null (corner handles): free, non-axis-locked scale — both axes follow the cursor
      // independently. 'x'/'y' (edge-midpoint handles): only that axis's scale changes, the
      // other stays exactly as it was at drag start.
      axisLock: 'x' | 'y' | null
    }
  | {
      kind: 'rotate-object'
      objectId: string
      startRotation: number
      startAngle: number
      center: { x: number; y: number }
      parentWorldRotation: number
    }
  | { kind: 'move-head'; objectId: string }
  | { kind: 'move-tail'; objectId: string }
  | { kind: 'move-shapekey-arc-pivot'; objectId: string; keyId: string }
  | { kind: 'move-fake-flag-direction'; objectId: string; startDirection: number; startAngle: number }
  | { kind: 'move-hairpath-cp'; index: number }
  | { kind: 'move-path-cp'; index: number }
  | { kind: 'move-path-point'; objectId: string; index: number }
  | { kind: 'move-pixel-frame'; startWorld: Vec2; startFrame: PixelFrame }
  | { kind: 'resize-pixel-frame'; corner: 'tl' | 'tr' | 'bl' | 'br'; startFrame: PixelFrame }
  | {
      kind: 'box-select'
      objectId: string
      additive: boolean
      startClientX: number
      startClientY: number
      endClientX: number
      endClientY: number
    }

interface LoopCutHover {
  edgeA: number
  edgeB: number
  t: number
  path: LoopPath
}

interface RingCutHover {
  center: number
  hoverRim: number
  t: number
  path: FanPath
}

/** Blender-style modal transform: started by R/S, follows the mouse with no button held,
 *  confirmed by click/Enter, cancelled by Esc/right-click. */
type ElementModal =
  | {
      kind: 'rotate'
      objectId: string
      indices: number[]
      startPositions: Vec2[]
      pivot: Vec2 // local mesh space
      startAngle: number
    }
  | {
      kind: 'scale'
      objectId: string
      indices: number[]
      startPositions: Vec2[]
      pivot: Vec2 // local mesh space
      startDist: number
      axisLock: 'x' | 'y' | null // local-space axis lock (the other axis stays at 1x), toggled by pressing X/Y again — same convention as 'move'
    }
  | {
      kind: 'move'
      objectId: string
      indices: number[]
      startPositions: Vec2[]
      startWorld: Vec2
      axisLock: 'x' | 'y' | null // world-space axis lock, toggled by pressing X/Y again
      // true for the post-extrude grab only: the new vertices' UV rest-pose was seeded at their
      // pre-drag (zero-size) position, so it must be re-stamped to wherever they end up once
      // this modal confirms — otherwise the new geometry's UV stays collapsed to a sliver
      seedUvOnConfirm: boolean
    }
  | {
      // started by pressing G again while a 'move' modal is active (Blender's GG vertex slide):
      // each vertex is constrained to ride along whichever adjacent edge is currently best
      // aligned with the cumulative drag direction (re-picked every pointermove, not fixed at
      // GG time) — so redirecting the mouse toward a different edge re-targets the slide onto it
      kind: 'vertex-slide'
      objectId: string
      indices: number[]
      origPositions: Vec2[] // pre-drag local positions, parallel to `indices`
      slideOriginWorld: Vec2 // pointer world position when the slide started
      neighbors: Vec2[][] // per index: pre-drag local positions of all adjacent vertices
      // the neighbor each vertex is currently riding toward, persisted across frames with
      // hysteresis (see updateElementModal) so tiny mouse jitter doesn't flicker between two
      // similarly-aligned edges — null until the drag direction is decisive enough to commit
      chosenNeighbor: Array<Vec2 | null>
      // only set while Alt is held: the edge the vertex locked onto the moment Alt went down,
      // ridden exclusively (no competing edge considered) until Alt is released — this is what
      // lets it cross back through the original vertex position without another edge interjecting
      lockedNeighbor: Array<Vec2 | null>
      // world-space rail each vertex is currently riding, refreshed every update — used to draw
      // the dashed guide line, and null for a vertex with nothing to ride (no aligned edge yet)
      liveRails: Array<{ origWorld: Vec2; targetWorld: Vec2 } | null>
    }

export default function Viewport() {
  const containerRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const cameraRef = useRef<THREE.OrthographicCamera | null>(null)
  const sceneRef = useRef<THREE.Scene>(new THREE.Scene())
  // Rebuilt fresh every `rebuildScene` — each FakeBehind mask object's id mapped to its unique
  // stencil-buffer bit (see `fakeBehind.ts`'s doc). Read by `applyFakeBehindStencil` for both the
  // main per-object loop and `buildFillMaterialFor` (nested/insert objects).
  const fakeBehindMaskBitsRef = useRef<Map<string, number>>(new Map())
  const viewRef = useRef<ViewState>({ panX: 0, panY: 0, zoom: 1 })
  const dragRef = useRef<DragMode>({ kind: 'none' })
  const loopCutHoverRef = useRef<LoopCutHover | null>(null)
  const loopCutCountRef = useRef(1)
  // Shift, while loop-cutting a single cut, snaps it to the exact edge midpoint instead of
  // following the cursor — there's no other way to land exactly on t=0.5 by hand
  const loopCutSnapMidRef = useRef(false)
  const ringCutHoverRef = useRef<RingCutHover | null>(null)
  const ringCutCountRef = useRef(1)
  // same idea as loopCutSnapMidRef, for a single ring cut
  const ringCutSnapMidRef = useRef(false)
  const knifePathRef = useRef<KnifeCutPoint[]>([])
  const knifeHoverRef = useRef<KnifeCutPoint | null>(null)
  // control points for the in-progress Hair Path primitive, in world space (see createHairPathMesh)
  const hairPathRef = useRef<Vec2[]>([])
  // root width for the in-progress Hair Path — Shift+wheel adjusts this live while drawing
  const hairPathWidthRef = useRef(HAIR_PATH_DEFAULT_WIDTH)
  // control points for the in-progress Path primitive, in world space — same click-to-place/
  // drag-to-reposition flow as Hair Path, but no width (a Path is a bare curve, no ribbon)
  const pathDrawRef = useRef<Vec2[]>([])
  const elementModalRef = useRef<ElementModal | null>(null)
  const lastPointerRef = useRef<{ clientX: number; clientY: number }>({ clientX: 0, clientY: 0 })
  const placePreviewRef = useRef<Vec2 | null>(null)
  const textureCacheRef = useRef(new Map<string, THREE.Texture>())
  const textureLoaderRef = useRef(new THREE.TextureLoader())
  const selectionBoxRef = useRef<HTMLDivElement>(null)
  // Live (unbaked) Fake Physics Mesh preview state, keyed by object id — persists across rAF
  // frames so the spring simulation keeps its position/velocity between renders instead of
  // resetting every frame. Only touched while `previewFakePhysicsMesh` is on (see rebuildScene).
  const fakePhysicsMeshLiveStatesRef = useRef(new Map<string, FakePhysicsMeshLiveState>())
  // Wall-clock timestamp (seconds) of the previous rAF tick — needed to get a real per-frame dt
  // for the live Fake Physics Mesh preview's spring integration (nothing else in this file needs
  // dt: Fake Flag's sway/deform is a pure function of absolute time, not integrated frame-to-frame).
  const lastFrameTimeRef = useRef<number | null>(null)

  function knifePointsEqual(a: KnifeCutPoint, b: KnifeCutPoint): boolean {
    if (a.type === 'vertex' && b.type === 'vertex') return a.index === b.index
    if (a.type === 'edge' && b.type === 'edge') {
      return a.a === b.a && a.b === b.b && Math.abs(a.t - b.t) < 1e-6
    }
    return false
  }

  function knifePointLocal(obj: SceneObject, p: KnifeCutPoint) {
    if (p.type === 'vertex') return obj.mesh.vertices[p.index]
    const va = obj.mesh.vertices[p.a]
    const vb = obj.mesh.vertices[p.b]
    return { x: va.x + (vb.x - va.x) * p.t, y: va.y + (vb.y - va.y) * p.t }
  }

  function finalizeKnife() {
    const store = useSceneStore.getState()
    const objectId = store.selectedObjectId
    const path = [...knifePathRef.current]
    const hover = knifeHoverRef.current
    if (hover && (path.length === 0 || !knifePointsEqual(path[path.length - 1], hover))) {
      path.push(hover)
    }
    knifePathRef.current = []
    knifeHoverRef.current = null
    if (objectId && path.length >= 2) {
      store.applyKnifeCut(objectId, path)
      store.setActiveTool('select')
    }
  }

  /** Confirm the in-progress Hair Path: needs at least 2 control points (a single point can't
   *  define a ribbon). Mirrors Rect/Circle's own island-vs-standalone split — `addHairPathIsland`
   *  when there's a selected object in edit mode to merge into, otherwise a new standalone object. */
  function finalizeHairPath() {
    const store = useSceneStore.getState()
    const points = hairPathRef.current
    const width = hairPathWidthRef.current
    const constantWidth = store.hairPathConstantWidth
    hairPathRef.current = []
    hairPathWidthRef.current = HAIR_PATH_DEFAULT_WIDTH
    if (points.length < 2) return
    if (store.mode === 'edit' && store.selectedObjectId) {
      const obj = store.objects.find((o) => o.id === store.selectedObjectId)
      if (obj) {
        const worldTransform = getWorldTransform(obj, store.objects)
        const localPoints = points.map((p) => inverseTransform(p, worldTransform))
        store.addHairPathIsland(obj.id, localPoints, width, constantWidth)
        store.setActiveTool('select')
        return
      }
    }
    store.addHairPath(points, width, constantWidth)
    store.setActiveTool('select')
  }

  /** Confirm the in-progress Path: needs at least 2 control points. Always a new standalone
   *  object — unlike Hair Path there's no island-merge variant (a Path isn't fillable geometry
   *  to begin with, so "merging into a host mesh" doesn't apply). */
  function finalizePath() {
    const store = useSceneStore.getState()
    const points = pathDrawRef.current
    pathDrawRef.current = []
    if (points.length < 2) return
    store.addPath(points)
    store.setActiveTool('select')
  }

  function currentPointerWorld() {
    const rect = containerRef.current!.getBoundingClientRect()
    return screenToWorld(lastPointerRef.current.clientX, lastPointerRef.current.clientY, rect, viewRef.current)
  }

  /** G/R/S: start a Blender-style modal transform on the current edit-mode selection.
   *  `skipBeginChange` is for the post-extrude grab: extrude already opened its own undo
   *  step, so reusing it (rather than opening a second one) makes "E, drag, click" a single
   *  undo — and makes Escape right after E correctly cancel the whole extrude, not just the move. */
  function startElementModal(kind: 'rotate' | 'scale' | 'move', skipBeginChange = false) {
    const store = useSceneStore.getState()
    if (store.mode !== 'edit' || !store.selectedObjectId) return
    const rawObj = store.objects.find((o) => o.id === store.selectedObjectId)
    if (!rawObj) return
    // while sculpting a shape key, drag start positions come from its isolated pose, not the
    // Basis, or a fresh drag would jump already-sculpted vertices back to their Basis position
    const obj = getEffectiveObj(rawObj, store.editingShapeKeyId, true)
    const indices = selectedVertexIndices(store, obj.mesh)
    if (indices.length === 0) return

    // sculpting an Arc-mode key rotates around its own persisted pivot (so posing matches what
    // Arc evaluation will actually sweep around) — everything else (Basis editing, a Linear key)
    // keeps using the transient session `editPivot` (P key), unchanged
    const editingKey = store.editingShapeKeyId ? rawObj.shapeKeys?.find((k) => k.id === store.editingShapeKeyId) : undefined
    const pivot =
      editingKey?.interpolation === 'arc'
        ? (editingKey.arcPivot ?? obj.transform.head)
        : (store.editPivot ?? obj.transform.head)
    const startPositions = indices.map((i) => ({ ...obj.mesh.vertices[i] }))
    const worldTransform = getWorldTransform(obj, store.objects)
    const local = inverseTransform(currentPointerWorld(), worldTransform)
    if (!skipBeginChange) store.beginChange()
    if (kind === 'rotate') {
      elementModalRef.current = {
        kind: 'rotate',
        objectId: obj.id,
        indices,
        startPositions,
        pivot,
        startAngle: Math.atan2(local.y - pivot.y, local.x - pivot.x),
      }
    } else if (kind === 'scale') {
      elementModalRef.current = {
        kind: 'scale',
        objectId: obj.id,
        indices,
        startPositions,
        pivot,
        startDist: Math.max(1e-6, Math.hypot(local.x - pivot.x, local.y - pivot.y)),
        axisLock: null,
      }
    } else {
      elementModalRef.current = {
        kind: 'move',
        objectId: obj.id,
        indices,
        startPositions,
        startWorld: currentPointerWorld(),
        axisLock: null,
        seedUvOnConfirm: skipBeginChange,
      }
    }
  }

  /** GG: switch the active 'move' modal into a vertex-slide modal. Which adjacent edge each
   *  vertex rides is *not* fixed here — only the neighbor list is captured. The actual edge is
   *  re-picked every pointermove in updateElementModal, based on whatever direction the cursor
   *  has travelled since the slide started, so redirecting the mouse retargets the slide onto a
   *  different edge instead of staying locked to whichever one happened to be best at GG time.
   *  No-op outside a move modal, or in face select mode (face has no well-defined per-vertex
   *  slide edges here). */
  function startVertexSlide() {
    const modal = elementModalRef.current
    if (!modal || modal.kind !== 'move') return
    const store = useSceneStore.getState()
    if (store.editElementType === 'face') return
    const rawObj = store.objects.find((o) => o.id === modal.objectId)
    if (!rawObj) return
    const obj = getEffectiveObj(rawObj, store.editingShapeKeyId, true)

    // undo whatever the free-move drag had already applied — slide computes its own offsets
    // from the original pre-drag positions
    store.setVertexPositions(modal.objectId, modal.indices, modal.startPositions)

    const origLocal = (idx: number): Vec2 => {
      const at = modal.indices.indexOf(idx)
      return at >= 0 ? modal.startPositions[at] : obj.mesh.vertices[idx]
    }

    const neighborsOf = new Map<number, number[]>()
    for (const [a, b] of getEdges(obj.mesh)) {
      if (!neighborsOf.has(a)) neighborsOf.set(a, [])
      if (!neighborsOf.has(b)) neighborsOf.set(b, [])
      neighborsOf.get(a)!.push(b)
      neighborsOf.get(b)!.push(a)
    }

    const neighbors = modal.indices.map((idx) => (neighborsOf.get(idx) ?? []).map((n) => origLocal(n)))

    elementModalRef.current = {
      kind: 'vertex-slide',
      objectId: modal.objectId,
      indices: modal.indices,
      origPositions: modal.startPositions,
      slideOriginWorld: currentPointerWorld(),
      neighbors,
      chosenNeighbor: modal.indices.map(() => null),
      lockedNeighbor: modal.indices.map(() => null),
      liveRails: modal.indices.map(() => null),
    }
  }

  /** Confirm the active modal transform (click/Enter). A vertex move also snap-merges onto
   *  a topologically adjacent vertex it ended up on top of, mirroring the old drag-to-merge behavior. */
  function confirmElementModal() {
    const modal = elementModalRef.current
    if (!modal) return
    if (modal.kind === 'move' || modal.kind === 'vertex-slide') {
      const store = useSceneStore.getState()
      const obj = store.objects.find((o) => o.id === modal.objectId)
      if (obj) {
        const worldTransform = getWorldTransform(obj, store.objects)
        // the post-extrude grab seeded these vertices' UV rest-pose back when they were still
        // sitting at distance 0 — now that the user has actually dragged them out, re-stamp it
        // to where they ended up, or the new geometry's UV would stay collapsed to a sliver
        if (modal.kind === 'move' && modal.seedUvOnConfirm) store.freezeUvBaseVertices(modal.objectId, modal.indices)

        // snap-merge is a topology change (drops a vertex) — out of scope while sculpting a
        // shape key, which can only reposition the Basis's existing vertices, not merge them
        const movedSet = new Set(modal.indices)
        let best: { keep: number; merge: number } | null = null
        let bestDist = Infinity
        for (const [a, b] of store.editingShapeKeyId ? [] : getEdges(obj.mesh)) {
          const aMoved = movedSet.has(a)
          const bMoved = movedSet.has(b)
          if (aMoved === bMoved) continue
          const pa = applyTransform(obj.mesh.vertices[a], worldTransform)
          const pb = applyTransform(obj.mesh.vertices[b], worldTransform)
          const d = pxDistSq(pa.x, pa.y, pb.x, pb.y)
          if (d < bestDist) {
            bestDist = d
            best = aMoved ? { keep: b, merge: a } : { keep: a, merge: b }
          }
        }
        const SNAP_MERGE_RADIUS_PX = 5
        if (best && bestDist < SNAP_MERGE_RADIUS_PX ** 2) {
          store.mergeVertexPair(modal.objectId, best.keep, best.merge)
        }
      }
    }
    elementModalRef.current = null
  }

  /** Recompute and write the live vertex positions for the active R/S modal, given the cursor. */
  function updateElementModal(ctrlKey: boolean, altKey: boolean) {
    const modal = elementModalRef.current
    if (!modal) return
    const store = useSceneStore.getState()
    const obj = store.objects.find((o) => o.id === modal.objectId)
    if (!obj) return
    const worldTransform = getWorldTransform(obj, store.objects)

    if (modal.kind === 'move') {
      const world = currentPointerWorld()
      let dx = world.x - modal.startWorld.x
      let dy = world.y - modal.startWorld.y
      if (modal.axisLock === 'x') dy = 0
      if (modal.axisLock === 'y') dx = 0
      // Grid Snap (toggle, Ctrl flips it) snaps the selection's pivot (median of its start
      // positions) to an absolute grid intersection, then applies that exact offset to every
      // vertex — keeps the selection rigid (no shape distortion) while still landing it precisely
      // on the grid even when it started at an arbitrary, non-grid-aligned position (snapping the
      // raw delta alone wouldn't: the result would just be grid-increments away from that same
      // arbitrary offset).
      if (shouldGridSnap(ctrlKey)) {
        const inc = getGridSnapIncrement()
        const medianLocal = {
          x: modal.startPositions.reduce((sum, p) => sum + p.x, 0) / modal.startPositions.length,
          y: modal.startPositions.reduce((sum, p) => sum + p.y, 0) / modal.startPositions.length,
        }
        const medianWorld = applyTransform(medianLocal, worldTransform)
        if (modal.axisLock !== 'y') dx = snapToIncrement(medianWorld.x + dx, inc) - medianWorld.x
        if (modal.axisLock !== 'x') dy = snapToIncrement(medianWorld.y + dy, inc) - medianWorld.y
      }
      // world-space delta -> local mesh space, undoing the object's rotation/scale
      const cos = Math.cos(-worldTransform.rotation)
      const sin = Math.sin(-worldTransform.rotation)
      const localDx = (dx * cos - dy * sin) / worldTransform.scaleX
      const localDy = (dx * sin + dy * cos) / worldTransform.scaleY
      const positions = modal.startPositions.map((p) => ({ x: p.x + localDx, y: p.y + localDy }))
      store.setVertexPositions(modal.objectId, modal.indices, positions)
      return
    }

    if (modal.kind === 'vertex-slide') {
      const currentWorld = currentPointerWorld()
      const dragX = currentWorld.x - modal.slideOriginWorld.x
      const dragY = currentWorld.y - modal.slideOriginWorld.y
      const dragLen = Math.hypot(dragX, dragY)
      // ignore sub-pixel jitter right after GG — without this, the edge choice reacts to noise
      // before the user has actually committed to a direction
      const DEADZONE = 3 / viewRef.current.zoom
      // without Alt: only switch to a different edge if it's clearly (not just marginally)
      // better aligned with the current drag — otherwise two similarly-angled edges flicker
      // back and forth on ordinary, slightly-wobbly hand movement
      const SWITCH_MARGIN = 0.08
      const positions = modal.indices.map((_, i) => {
        const origPos = modal.origPositions[i]
        const neighborList = modal.neighbors[i]
        if (neighborList.length === 0) {
          modal.liveRails[i] = null
          modal.chosenNeighbor[i] = null
          modal.lockedNeighbor[i] = null
          return origPos
        }
        const origWorld = applyTransform(origPos, worldTransform)

        if (!altKey) {
          // no Alt: dynamic and redirectable (re-picked every frame, hysteresis-stabilized),
          // clamped to the segment, no guide line — and the Alt-lock is released so the next
          // Alt-press re-locks onto whatever edge is current at that moment
          modal.lockedNeighbor[i] = null
          modal.liveRails[i] = null
          if (dragLen < DEADZONE) {
            modal.chosenNeighbor[i] = null
            return origPos
          }
          const dirX = dragX / dragLen
          const dirY = dragY / dragLen
          let bestTarget: Vec2 | null = null
          let bestDot = -Infinity
          let bestLen = 0
          let currentDot = -Infinity
          let currentLen = 0
          for (const n of neighborList) {
            const nWorld = applyTransform(n, worldTransform)
            const ex = nWorld.x - origWorld.x
            const ey = nWorld.y - origWorld.y
            const len = Math.hypot(ex, ey)
            if (len < 1e-9) continue
            const dot = (ex / len) * dirX + (ey / len) * dirY
            if (dot > bestDot) {
              bestDot = dot
              bestTarget = n
              bestLen = len
            }
            if (n === modal.chosenNeighbor[i]) {
              currentDot = dot
              currentLen = len
            }
          }
          if (!bestTarget) {
            modal.chosenNeighbor[i] = null
            return origPos
          }
          let target = bestTarget
          let dot = bestDot
          let len = bestLen
          if (modal.chosenNeighbor[i] && currentDot > -Infinity && bestDot - currentDot < SWITCH_MARGIN) {
            target = modal.chosenNeighbor[i]!
            dot = currentDot
            len = currentLen
          }
          modal.chosenNeighbor[i] = target
          const targetWorld = applyTransform(target, worldTransform)
          const t = Math.max(0, Math.min(1, (dragLen * dot) / len))
          const worldPos = {
            x: origWorld.x + (targetWorld.x - origWorld.x) * t,
            y: origWorld.y + (targetWorld.y - origWorld.y) * t,
          }
          return inverseTransform(worldPos, worldTransform)
        }

        // Alt held: lock onto whatever edge is active right now (falling back to a fresh,
        // direction-agnostic pick if nothing was chosen yet) and ride it exclusively — no
        // competing edge gets reconsidered until Alt is released, so crossing back through the
        // original vertex position can't make a different edge interject
        if (!modal.lockedNeighbor[i]) {
          let lockTarget = modal.chosenNeighbor[i]
          if (!lockTarget) {
            if (dragLen < DEADZONE) {
              modal.liveRails[i] = null
              return origPos
            }
            const dirX = dragX / dragLen
            const dirY = dragY / dragLen
            let bestTarget: Vec2 | null = null
            let bestMetric = -Infinity
            for (const n of neighborList) {
              const nWorld = applyTransform(n, worldTransform)
              const ex = nWorld.x - origWorld.x
              const ey = nWorld.y - origWorld.y
              const len = Math.hypot(ex, ey)
              if (len < 1e-9) continue
              const dot = (ex / len) * dirX + (ey / len) * dirY
              const metric = Math.abs(dot)
              if (metric > bestMetric) {
                bestMetric = metric
                bestTarget = n
              }
            }
            lockTarget = bestTarget
          }
          if (!lockTarget) {
            modal.liveRails[i] = null
            return origPos
          }
          modal.lockedNeighbor[i] = lockTarget
        }

        const target = modal.lockedNeighbor[i]!
        const targetWorld = applyTransform(target, worldTransform)
        const ex = targetWorld.x - origWorld.x
        const ey = targetWorld.y - origWorld.y
        const len = Math.hypot(ex, ey)
        const dot = dragLen > 1e-9 && len > 1e-9 ? (ex / len) * (dragX / dragLen) + (ey / len) * (dragY / dragLen) : 0
        modal.liveRails[i] = { origWorld, targetWorld }
        const t = (dragLen * dot) / len
        const worldPos = {
          x: origWorld.x + (targetWorld.x - origWorld.x) * t,
          y: origWorld.y + (targetWorld.y - origWorld.y) * t,
        }
        return inverseTransform(worldPos, worldTransform)
      })
      store.setVertexPositions(modal.objectId, modal.indices, positions)
      return
    }

    const local = inverseTransform(currentPointerWorld(), worldTransform)

    if (modal.kind === 'rotate') {
      const currentAngle = Math.atan2(local.y - modal.pivot.y, local.x - modal.pivot.x)
      let delta = currentAngle - modal.startAngle
      if (ctrlKey) {
        const step = (5 * Math.PI) / 180
        delta = Math.round(delta / step) * step
      }
      const cos = Math.cos(delta)
      const sin = Math.sin(delta)
      const positions = modal.startPositions.map((p) => {
        const dx = p.x - modal.pivot.x
        const dy = p.y - modal.pivot.y
        return { x: modal.pivot.x + dx * cos - dy * sin, y: modal.pivot.y + dx * sin + dy * cos }
      })
      store.setVertexPositions(modal.objectId, modal.indices, positions)
    } else if (modal.kind === 'scale') {
      const dist = Math.hypot(local.x - modal.pivot.x, local.y - modal.pivot.y)
      let scale = dist / modal.startDist
      if (ctrlKey) scale = Math.round(scale * 20) / 20 // 5% snap
      const scaleX = modal.axisLock === 'y' ? 1 : scale
      const scaleY = modal.axisLock === 'x' ? 1 : scale
      const positions = modal.startPositions.map((p) => ({
        x: modal.pivot.x + (p.x - modal.pivot.x) * scaleX,
        y: modal.pivot.y + (p.y - modal.pivot.y) * scaleY,
      }))
      store.setVertexPositions(modal.objectId, modal.indices, positions)
    }
  }

  function loopCutTs(): number[] {
    const count = loopCutCountRef.current
    const hover = loopCutHoverRef.current
    if (!hover) return []
    if (count <= 1) return [loopCutSnapMidRef.current ? 0.5 : hover.t]
    return Array.from({ length: count }, (_, i) => (i + 1) / (count + 1))
  }

  function ringCutTs(): number[] {
    const count = ringCutCountRef.current
    const hover = ringCutHoverRef.current
    if (!hover) return []
    if (count <= 1) return [ringCutSnapMidRef.current ? 0.5 : hover.t]
    return Array.from({ length: count }, (_, i) => (i + 1) / (count + 1))
  }

  useEffect(() => {
    const container = containerRef.current!
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    container.appendChild(renderer.domElement)
    rendererRef.current = renderer

    const rect = container.getBoundingClientRect()
    const camera = makeOrthoCamera(rect.width, rect.height, viewRef.current)
    cameraRef.current = camera

    const resize = () => {
      const r = container.getBoundingClientRect()
      renderer.setSize(r.width, r.height)
      updateOrthoCamera(camera, r.width, r.height, viewRef.current)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(container)

    let raf = 0
    const tick = () => {
      const r = container.getBoundingClientRect()
      updateOrthoCamera(camera, r.width, r.height, viewRef.current)
      rebuildScene()
      renderer.render(sceneRef.current, camera)
      raf = requestAnimationFrame(tick)
    }
    tick()

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      // while loop-cut tool is hovering a valid edge, scroll adjusts the number of
      // parallel cuts instead of zooming the camera (Blender-style loop cut)
      if (loopCutHoverRef.current) {
        const delta = e.deltaY < 0 ? 1 : -1
        loopCutCountRef.current = Math.max(1, Math.min(20, loopCutCountRef.current + delta))
        return
      }
      // same idea for ring-cut, hovering a spoke of a triangle fan
      if (ringCutHoverRef.current) {
        const delta = e.deltaY < 0 ? 1 : -1
        ringCutCountRef.current = Math.max(1, Math.min(20, ringCutCountRef.current + delta))
        return
      }
      // Shift+wheel while drawing a Hair Path adjusts its width instead of zooming — plain wheel
      // stays zoom (can't repurpose it outright, it's the primary zoom gesture). Most
      // browsers/mice remap a Shift-held wheel scroll onto deltaX instead of deltaY (it becomes
      // a "horizontal scroll" gesture at the OS level), leaving deltaY at 0 — so read whichever
      // axis actually moved.
      if (e.shiftKey && useSceneStore.getState().activeTool === 'place-hairpath') {
        const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX
        const factor = Math.exp(-delta * 0.002)
        hairPathWidthRef.current = Math.max(1, Math.min(200, hairPathWidthRef.current * factor))
        return
      }
      const r = container.getBoundingClientRect()
      const before = screenToWorld(e.clientX, e.clientY, r, viewRef.current)
      const factor = Math.exp(-e.deltaY * 0.001)
      viewRef.current.zoom = Math.min(20, Math.max(0.05, viewRef.current.zoom * factor))
      const after = screenToWorld(e.clientX, e.clientY, r, viewRef.current)
      viewRef.current.panX += before.x - after.x
      viewRef.current.panY += before.y - after.y
      updateOrthoCamera(camera, r.width, r.height, viewRef.current)
    }
    container.addEventListener('wheel', onWheel, { passive: false })

    const cancelActiveDrag = () => {
      if (dragRef.current.kind !== 'none' && dragRef.current.kind !== 'pan') {
        useSceneStore.getState().cancelChange()
      }
      dragRef.current = { kind: 'none' }
      if (useSceneStore.getState().activeTool === 'loopcut') {
        useSceneStore.getState().setActiveTool('select')
        loopCutHoverRef.current = null
      }
      if (useSceneStore.getState().activeTool === 'ringcut') {
        useSceneStore.getState().setActiveTool('select')
        ringCutHoverRef.current = null
      }
      if (useSceneStore.getState().activeTool === 'knife') {
        // discard the in-progress path only — stay in knife mode (press K again to exit)
        knifePathRef.current = []
      }
      if (elementModalRef.current) {
        useSceneStore.getState().cancelChange()
        elementModalRef.current = null
      }
      const activeTool = useSceneStore.getState().activeTool
      if (activeTool === 'place-rect' || activeTool === 'place-circle') {
        useSceneStore.getState().setActiveTool('select')
        useSceneStore.getState().setPendingPrimitive(null)
        placePreviewRef.current = null
      }
      if (activeTool === 'place-hairpath') {
        // discard the in-progress path only — stay in the tool (matches knife's cancel above)
        hairPathRef.current = []
        hairPathWidthRef.current = HAIR_PATH_DEFAULT_WIDTH
      }
      if (activeTool === 'place-path') {
        pathDrawRef.current = []
      }
    }

    // Chrome/Edge trigger native middle-click auto-scroll directly off `mousedown`,
    // independent of pointerdown.preventDefault(). Block it at the source, and also
    // block auxclick so the dismissal click doesn't get swallowed by the browser.
    // Right-click cancel is also handled here (not in pointerdown): the browser only
    // fires `pointerdown` on the initial button-down transition — pressing a second
    // button while the first is still held only updates `buttons` on pointermove and
    // fires a legacy `mousedown`, so that's the event we must listen to for button 2.
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault()
      if (e.button === 2) {
        // right-click an already-confirmed Path's control point (Edit mode only) deletes it
        // directly — no separate "select it first" step, since a plain click gave no visual
        // feedback of having selected anything (that's what dragging is for: the drag itself is
        // the feedback). Only when nothing else is mid-drag, so this doesn't fight the Blender-
        // style "right-click cancels the current drag" behavior just below.
        if (dragRef.current.kind === 'none') {
          const store = useSceneStore.getState()
          const obj = store.objects.find((o) => o.id === store.selectedObjectId)
          if (store.mode === 'edit' && obj?.kind === 'path') {
            const rect = containerRef.current!.getBoundingClientRect()
            const world = screenToWorld(e.clientX, e.clientY, rect, viewRef.current)
            const worldTransform = getWorldTransform(obj, store.objects)
            const hitIndex = obj.mesh.vertices.findIndex((v) => {
              const p = applyTransform(v, worldTransform)
              return pxDistSq(world.x, world.y, p.x, p.y) < HAIR_PATH_CP_HIT_RADIUS_PX ** 2
            })
            if (hitIndex >= 0) {
              store.removePathPoint(obj.id, hitIndex)
              return
            }
          }
        }
        cancelActiveDrag()
      }
    }
    const onAuxClick = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault()
    }
    container.addEventListener('mousedown', onMouseDown)
    container.addEventListener('auxclick', onAuxClick)

    // Blender-style: right-click while dragging cancels the in-progress operation.
    const onContextMenu = (e: MouseEvent) => e.preventDefault()
    container.addEventListener('contextmenu', onContextMenu)

    const onPointerDown = (e: PointerEvent) => {
      if (e.button === 2) return
      lastPointerRef.current = { clientX: e.clientX, clientY: e.clientY }
      container.setPointerCapture(e.pointerId)
      handlePointerDown(e)
    }
    const onPointerMove = (e: PointerEvent) => {
      lastPointerRef.current = { clientX: e.clientX, clientY: e.clientY }
      if (elementModalRef.current) {
        updateElementModal(e.ctrlKey, e.altKey)
        return
      }
      updateLoopCutHover(e)
      updateRingCutHover(e)
      updateKnifeHover(e)
      updatePlacePreview(e)
      handlePointerMove(e)
    }
    const onPointerUp = (e: PointerEvent) => {
      if (container.hasPointerCapture(e.pointerId)) container.releasePointerCapture(e.pointerId)
      handlePointerUp(e)
    }
    // Trackpads often can't register a secondary-click while the primary button is held
    // (the two-finger-tap gesture conflicts with an active single-finger drag), so Escape
    // is the reliable cancel path — this is also how Blender itself supports cancellation.
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return

      if (e.key === 'Escape') cancelActiveDrag()
      if (e.key === 'Enter') {
        if (useSceneStore.getState().activeTool === 'knife') finalizeKnife()
        if (useSceneStore.getState().activeTool === 'place-hairpath') finalizeHairPath()
        if (useSceneStore.getState().activeTool === 'place-path') finalizePath()
        if (elementModalRef.current) confirmElementModal()
      }
      // while grabbing (G), X/Y constrains the move to that world axis; pressing the same
      // key again releases the constraint (Blender-style). Pressing G again (GG) switches
      // into a vertex-slide constrained to the selection's adjacent edges instead.
      const moveModal = elementModalRef.current
      if (moveModal && moveModal.kind === 'move' && !e.ctrlKey && !e.metaKey) {
        const k = e.key.toLowerCase()
        if (k === 'x') moveModal.axisLock = moveModal.axisLock === 'x' ? null : 'x'
        if (k === 'y') moveModal.axisLock = moveModal.axisLock === 'y' ? null : 'y'
        if (k === 'g') startVertexSlide()
      }
      // same X/Y axis-lock convention while scaling (S) — e.g. resizing a Lattice's grid along
      // just one axis without touching the other, so a follow-up rotation isn't skewed by
      // uneven per-axis scale (see FfdSettings-adjacent discussion: rotating under non-uniform
      // *object* scale skews; this locks the *vertex* scale itself instead, which doesn't).
      const scaleModal = elementModalRef.current
      if (scaleModal && scaleModal.kind === 'scale' && !e.ctrlKey && !e.metaKey) {
        const k = e.key.toLowerCase()
        if (k === 'x') scaleModal.axisLock = scaleModal.axisLock === 'x' ? null : 'x'
        if (k === 'y') scaleModal.axisLock = scaleModal.axisLock === 'y' ? null : 'y'
      }
      if (!elementModalRef.current && !e.ctrlKey && !e.metaKey) {
        if (e.key.toLowerCase() === 'g') startElementModal('move')
        if (e.key.toLowerCase() === 'r') startElementModal('rotate')
        if (e.key.toLowerCase() === 's') startElementModal('scale')
        if (e.key.toLowerCase() === 'e') {
          const store = useSceneStore.getState()
          if (store.mode === 'edit' && store.extrudeSelection()) {
            // Blender-style: extrude lands the new geometry on top of the original and
            // immediately drops into a grab modal so the user drags out the extrusion themselves
            startElementModal('move', true)
          }
        }
      }
      // Blender shows the slide guide / lifts the clamp the instant Alt goes down, even if the
      // mouse hasn't moved since the drag paused — without this, the guide only appears once a
      // pointermove happens to fire while Alt is held
      if (e.key === 'Alt' && moveModal && moveModal.kind === 'vertex-slide') {
        updateElementModal(e.ctrlKey, true)
      }
      // same idea for the loop-cut/ring-cut midpoint snap: take effect the instant Shift goes
      // down, even if the cursor hasn't moved since
      if (e.key === 'Shift') {
        loopCutSnapMidRef.current = true
        ringCutSnapMidRef.current = true
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt' && elementModalRef.current?.kind === 'vertex-slide') {
        updateElementModal(e.ctrlKey, false)
      }
      if (e.key === 'Shift') {
        loopCutSnapMidRef.current = false
        ringCutSnapMidRef.current = false
      }
    }
    const onDblClick = () => {
      if (useSceneStore.getState().activeTool === 'knife') finalizeKnife()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    container.addEventListener('pointerdown', onPointerDown)
    container.addEventListener('dblclick', onDblClick)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      container.removeEventListener('wheel', onWheel)
      container.removeEventListener('mousedown', onMouseDown)
      container.removeEventListener('auxclick', onAuxClick)
      container.removeEventListener('contextmenu', onContextMenu)
      container.removeEventListener('pointerdown', onPointerDown)
      container.removeEventListener('dblclick', onDblClick)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      container.removeChild(renderer.domElement)
      renderer.dispose()
      for (const tex of textureCacheRef.current.values()) tex.dispose()
      textureCacheRef.current.clear()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** scene.clear() only detaches children — it doesn't free their GPU buffers, so every
   *  geometry/material created last frame must be disposed explicitly or it leaks. */
  function disposeSceneContents(scene: THREE.Scene) {
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh | THREE.LineSegments
      mesh.geometry?.dispose()
      const material = (obj as THREE.Mesh).material
      if (Array.isArray(material)) material.forEach((m) => m.dispose())
      else material?.dispose()
      // unlike every other texture in this file (cached/reused across frames via
      // textureCacheRef), island-name-label sprites build a brand new CanvasTexture every
      // frame, so it must be disposed here too or it leaks
      if (obj instanceof THREE.Sprite) (obj.material as THREE.SpriteMaterial).map?.dispose()
    })
  }

  function buildFillMaterialFor(targetObj: SceneObject): THREE.MeshBasicMaterial {
    let texture: THREE.Texture | undefined
    if (targetObj.material.textureUrl) {
      texture = textureCacheRef.current.get(targetObj.material.textureUrl)
      if (!texture) {
        texture = textureLoaderRef.current.load(targetObj.material.textureUrl)
        texture.colorSpace = THREE.SRGBColorSpace
        textureCacheRef.current.set(targetObj.material.textureUrl, texture)
      }
    }
    const { meshOpacity } = useSceneStore.getState()
    const material = new THREE.MeshBasicMaterial({
      color: targetObj.material.color,
      map: texture,
      side: THREE.DoubleSide,
      transparent: meshOpacity < 1 || !!texture,
      opacity: meshOpacity,
    })
    applyFakeBehindStencil(material, targetObj, false)
    return material
  }

  /** Configures `mat`'s stencil state for FakeBehind (see `FakeBehindSettings`'s doc). Whether
   *  `obj` is "a mask" isn't a role flag on the object — it's derived from being referenced by
   *  some *other* object's `maskObjectIds` (see `collectFakeBehindMaskIds`), so any object can
   *  become a mask just by being picked in another object's Fake Behind modifier:
   *  - a referenced object (`maskBits.has(obj.id)`) writes its unique bit into the stencil buffer
   *    instead of drawing color (`colorWrite` stays off unless `isSelected`, for a translucent
   *    edit guide) — every island mesh built from `mat` also gets pushed to a very-negative
   *    `renderOrder` in `buildIslandMesh`, so it's guaranteed to draw (and stencil-write) before
   *    any target reads it.
   *  - a target object (enabled `fakeBehind` modifier, non-empty `maskObjectIds`) discards
   *    fragments wherever any of its referenced masks' bits are set.
   *  No-op (leaves `mat`'s default non-stencil state) for every other object. */
  function applyFakeBehindStencil(mat: THREE.MeshBasicMaterial, obj: SceneObject, isSelected: boolean) {
    const maskBits = fakeBehindMaskBitsRef.current
    const ownBit = maskBits.get(obj.id)
    if (ownBit != null) {
      const bit = ownBit
      mat.colorWrite = isSelected
      if (isSelected) {
        mat.color.set(0xffcc00)
        mat.map = null
        mat.transparent = true
        mat.opacity = 0.35
      }
      mat.depthWrite = false
      mat.depthTest = false
      mat.stencilWrite = true
      mat.stencilRef = bit
      mat.stencilFunc = THREE.AlwaysStencilFunc
      mat.stencilZPass = THREE.ReplaceStencilOp
      mat.stencilFail = THREE.KeepStencilOp
      mat.stencilZFail = THREE.KeepStencilOp
      mat.stencilFuncMask = 0xff
      mat.stencilWriteMask = bit
      return
    }
    const settings = getFakeBehind(obj)
    if (!settings?.enabled || settings.maskObjectIds.length === 0) return
    let bits = 0
    for (const maskId of settings.maskObjectIds) bits |= maskBits.get(maskId) ?? 0
    if (bits === 0) return
    mat.stencilWrite = true
    mat.stencilRef = 0
    mat.stencilFunc = THREE.EqualStencilFunc
    mat.stencilFuncMask = bits
    mat.stencilWriteMask = 0
    mat.stencilZPass = THREE.KeepStencilOp
    mat.stencilFail = THREE.KeepStencilOp
    mat.stencilZFail = THREE.KeepStencilOp
  }

  function buildIslandMesh(
    targetObj: SceneObject,
    perIsland: { mesh: Mesh; uvs: Vec2[] }[],
    islandIdx: number,
    material: THREE.MeshBasicMaterial,
    pivot: Vec2,
    worldTransform: Transform,
    z: number,
  ): THREE.Mesh {
    const { mesh: islandMesh, uvs: islandUvs } = perIsland[islandIdx]
    const positions = islandMesh.vertices.flatMap((v) => [v.x - pivot.x, v.y - pivot.y, 0])
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(islandUvs.flatMap((uv) => [uv.x, uv.y]), 2))
    geom.setIndex(triangulate(islandMesh))
    const mesh = new THREE.Mesh(geom, material)
    // a FakeBehind mask must stencil-write before any target reads it, regardless of normal
    // zOrder — pushing it far ahead in THREE's renderOrder sort (independent of the depth buffer)
    // guarantees that ordering without touching every other object's zOrder-derived Z position.
    if (fakeBehindMaskBitsRef.current.has(targetObj.id)) mesh.renderOrder = -100000
    mesh.position.set(worldTransform.x, worldTransform.y, z)
    mesh.rotation.z = worldTransform.rotation
    mesh.scale.set(worldTransform.scaleX, worldTransform.scaleY, 1)
    return mesh
  }

  /** Draws every visible island of an object inserted into another's slot, nested into the
   *  host's own `THREE.Group` (which already carries the host's `depthIndex` as its Z) at
   *  `baseZ` + a finer `microStep` per island — the inserted object keeps its own transform and
   *  material, only its render depth is borrowed from the host's island stack position. */
  function drawNestedObjectFill(
    hostGroup: THREE.Group,
    rawTargetObj: SceneObject,
    objects: SceneObject[],
    baseZ: number,
    microStep: number,
  ) {
    const { selectedObjectId, editingShapeKeyId } = useSceneStore.getState()
    const displayVerts = displayVertices(rawTargetObj, editingShapeKeyId, rawTargetObj.id === selectedObjectId)
    const targetObj: SceneObject =
      displayVerts === rawTargetObj.mesh.vertices
        ? rawTargetObj
        : { ...rawTargetObj, mesh: { ...rawTargetObj.mesh, vertices: displayVerts } }
    const targetWorldTransform = getWorldTransform(targetObj, objects)
    const pivot = targetWorldTransform.head
    const perIsland = computeSplitUVIslands(targetObj.mesh, targetObj.uvIslandTransforms, targetObj.uvBaseVertices)
    const material = buildFillMaterialFor(targetObj)
    const islandOrder = perIsland
      .map((_, i) => i)
      .sort((a, b) => (targetObj.islandZOrders?.[a] ?? a) - (targetObj.islandZOrders?.[b] ?? b))
    islandOrder.forEach((islandIdx, i) => {
      if (targetObj.islandVisible?.[islandIdx] === false) return
      hostGroup.add(buildIslandMesh(targetObj, perIsland, islandIdx, material, pivot, targetWorldTransform, baseZ + i * microStep))
    })
  }

  function rebuildScene() {
    const scene = sceneRef.current
    disposeSceneContents(scene)
    scene.clear()
    scene.add(new THREE.AmbientLight(0xffffff, 1))

    const {
      objects: rawObjects,
      selectedObjectId,
      mode,
      editElementType,
      selectedVertices,
      selectedEdges,
      selectedFaces,
      editingShapeKeyId,
      referenceImage,
      meshOpacity,
      gridVisible,
      wireframeVisible,
      clips,
      activeClipId,
      playheadTime,
      previewFakeFlag,
      previewFakePhysicsMesh,
      pixelFrame,
    } = useSceneStore.getState()

    if (referenceImage) addReferenceImage(scene, referenceImage)
    if (gridVisible) addGrid(scene)
    if (pixelFrame) addPixelFrameGizmo(scene, pixelFrame)

    // Fake Flag sway/deform is a pure function of time, re-evaluated fresh every frame (no baking).
    // Normally that's the playhead; "Preview" instead free-runs off the wall clock so a user can
    // see it without laying down any keyframes first (this render loop already runs every rAF
    // frame regardless of play state, so this needs no extra scheduling).
    const activeClip = clips.find((c) => c.id === activeClipId)
    const fakeFlagLoopDuration = activeClip?.duration ?? 0
    const fakeFlagTime = previewFakeFlag ? performance.now() / 1000 : playheadTime

    // Fake Physics (Mesh) preview is different from Fake Flag's: it's not a pure function of time,
    // it's a live spring simulation driven by the object's *actual* current transform each frame —
    // so dragging an object makes its lagging sections visibly follow, with nothing baked/keyed.
    // Needs a real per-frame dt (clamped: a dropped/very-late frame shouldn't make the spring jump
    // wildly), which nothing else in this file tracks.
    const nowSeconds = performance.now() / 1000
    const physicsMeshDt = lastFrameTimeRef.current == null ? 0 : Math.min(0.1, nowSeconds - lastFrameTimeRef.current)
    lastFrameTimeRef.current = nowSeconds
    if (!previewFakePhysicsMesh) fakePhysicsMeshLiveStatesRef.current.clear()

    // Bake rotation-mode sway into a shadow `objects` array so every world-transform composition
    // below (including parent/child chains) automatically carries it, exactly like
    // `displayVertices` does for shape keys. `objects` still means "editing/gizmo code below should
    // use the raw pose"; only this drawing pass swaps in the swayed version. Follow Path's current
    // `progress` gets the same treatment, applied after Fake Flag so a swaying parent's motion is
    // already folded in before any Follow Path child's world-to-local conversion reads it.
    const objects = applyFollowPath(applyFakeFlagSway(rawObjects, fakeFlagTime, fakeFlagLoopDuration))

    const { insertsByHost, consumedIds } = resolveInsertSlots(objects)
    const sorted = [...objects].sort((a, b) => a.zOrder - b.zOrder)

    // Assign each object currently referenced as a FakeBehind mask (by any other object's
    // `maskObjectIds` — see `collectFakeBehindMaskIds`) a unique stencil-buffer bit (8-bit
    // buffer, so at most `MAX_FAKE_BEHIND_MASKS` concurrent masks — extras beyond that are
    // silently inert, same as a dangling `maskObjectIds` reference). Read by
    // `applyFakeBehindStencil` below.
    const referencedMaskIds = collectFakeBehindMaskIds(objects)
    const maskBits = new Map<string, number>()
    let maskCount = 0
    for (const o of objects) {
      if (referencedMaskIds.has(o.id) && maskCount < MAX_FAKE_BEHIND_MASKS) {
        maskBits.set(o.id, 1 << maskCount)
        maskCount++
      }
    }
    fakeBehindMaskBitsRef.current = maskBits

    sorted.forEach((rawObj, depthIndex) => {
      if (!rawObj.visible) return
      const group = new THREE.Group()
      group.position.z = depthIndex
      const isSelected = rawObj.id === selectedObjectId
      const worldTransform = getWorldTransform(rawObj, objects)

      if (rawObj.kind === 'empty') {
        addEmptyGizmo(group, worldTransform, isSelected)
        scene.add(group)
        return
      }

      if (rawObj.kind === 'path') {
        const worldPoints = rawObj.mesh.vertices.map((v) => applyTransform(v, worldTransform))
        addPathCurveLine(group, evaluatePathCurve(worldPoints, 12, rawObj.closed), 0.5, isSelected, rawObj.closed)
        if (isSelected) {
          const pxToWorld = 1 / viewRef.current.zoom
          worldPoints.forEach((p) => {
            const dot = new THREE.Mesh(
              new THREE.CircleGeometry(3 * pxToWorld, 12),
              new THREE.MeshBasicMaterial({ color: 0xffaa33, depthTest: false, transparent: true }),
            )
            dot.position.set(p.x, p.y, 0.51)
            group.add(dot)
          })
        }
        scene.add(group)
        return
      }

      // shadow `obj` with a shape-key-evaluated (+ Fake Flag vertex-mode, if anchored) view for
      // the rest of this iteration — every other field is identical to `rawObj`, so this is
      // transparent to all the rendering code below, which just needs to draw/hit-test the
      // *displayed* pose instead of the raw Basis
      const shapeKeyVerts = displayVertices(rawObj, editingShapeKeyId, isSelected)
      const flagDeltas = fakeFlagVertexDeltas(rawObj, fakeFlagTime, fakeFlagLoopDuration)
      const swayedVerts = flagDeltas
        ? shapeKeyVerts.map((v, i) => ({ x: v.x + flagDeltas[i].x, y: v.y + flagDeltas[i].y }))
        : shapeKeyVerts
      const physicsMeshSettings = getFakePhysicsMesh(rawObj)
      const physicsMeshDeltas =
        previewFakePhysicsMesh && physicsMeshSettings?.enabled
          ? (() => {
              let state = fakePhysicsMeshLiveStatesRef.current.get(rawObj.id)
              if (!state) {
                state = createFakePhysicsMeshLiveState(rawObj.transform)
                fakePhysicsMeshLiveStatesRef.current.set(rawObj.id, state)
              }
              stepFakePhysicsMeshLive(state, physicsMeshSettings, rawObj.transform, physicsMeshDt)
              return fakePhysicsMeshVertexDeltasLive(rawObj, physicsMeshSettings, state, rawObj.transform)
            })()
          : fakePhysicsMeshVertexDeltas(rawObj, activeClip, playheadTime)
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
      const obj: SceneObject =
        displayVerts === rawObj.mesh.vertices ? rawObj : { ...rawObj, mesh: { ...rawObj.mesh, vertices: displayVerts } }

      // THREE's Object3D position/rotation/scale always pivots about the local origin, but our
      // objects can have an arbitrary head — so bake the head offset into the geometry itself
      // (matches applyTransform: world = R*scale*(v - head) + position).
      const { head: pivot } = worldTransform

      let texture: THREE.Texture | undefined
      if (obj.material.textureUrl) {
        texture = textureCacheRef.current.get(obj.material.textureUrl)
        if (!texture) {
          texture = textureLoaderRef.current.load(obj.material.textureUrl)
          texture.colorSpace = THREE.SRGBColorSpace
          textureCacheRef.current.set(obj.material.textureUrl, texture)
        }
      }
      // material.color always multiplies the texture (if any) — the Properties panel labels
      // this explicitly so a colored default doesn't unexpectedly tint an imported texture
      const mat = new THREE.MeshBasicMaterial({
        color: obj.material.color,
        map: texture,
        side: THREE.DoubleSide,
        // also on whenever there's a texture, not just when opacity<1 — the texture's own alpha
        // channel (e.g. a baked/transparent PNG) needs respecting regardless of the opacity slider
        transparent: meshOpacity < 1 || !!texture,
        opacity: meshOpacity,
      })
      applyFakeBehindStencil(mat, obj, isSelected)

      // a hidden island (per-island eye toggle in the Properties panel) draws nothing at all —
      // fill, wireframe, and edit-mode overlays alike — so collect its vertex/face indices once
      // up front; islands partition the mesh, so any edge or face is entirely in one island or
      // the other, never split between a hidden and a visible one
      const hiddenVertices = new Set<number>()
      const hiddenFaces = new Set<number>()
      // a locked island (per-island lock toggle in the Properties panel) can't be selected/
      // edited, and its wireframe/vertex/edge/face edit overlays are hidden too — but unlike
      // `hiddenVertices`/`hiddenFaces` above, its *fill* (material/texture) still renders, so
      // these are tracked in their own sets rather than folded into the hidden ones
      const lockedVertices = new Set<number>()
      const lockedFaces = new Set<number>()
      const islands =
        obj.showIslandNames || obj.islandVisible || obj.islandLocked ? findIslands(obj.mesh) : null
      if (islands && obj.islandVisible) {
        islands.forEach((island, islandIdx) => {
          if (obj.islandVisible?.[islandIdx] === false) {
            island.vertices.forEach((v) => hiddenVertices.add(v))
            island.faces.forEach((f) => hiddenFaces.add(f))
          }
        })
      }
      if (islands && obj.islandLocked) {
        islands.forEach((island, islandIdx) => {
          if (obj.islandLocked?.[islandIdx]) {
            island.vertices.forEach((v) => lockedVertices.add(v))
            island.faces.forEach((f) => lockedFaces.add(f))
          }
        })
      }

      // one draw call per island, stacked in rank order (`islandZOrders`, default = natural
      // island order) via a tiny per-island Z offset — small enough to never cross into a
      // neighboring object's `depthIndex` slot, which are spaced 1 apart. An object consumed by
      // another's insert slot draws its fill nested over there instead (see below) — everything
      // else here (wireframe, edit overlays, labels) still runs normally so it stays editable.
      const perIsland = computeSplitUVIslands(obj.mesh, obj.uvIslandTransforms, obj.uvBaseVertices)
      // A lattice is a cage, not a renderable shape — skip its filled/textured quads entirely so
      // it never visually obstructs whatever it's deforming (only the wireframe below, forced on
      // regardless of the global "Show wireframe" toggle, plus the ordinary vertex/edge Edit Mode
      // overlays further down still apply, so it's fully editable exactly like any mesh).
      if (!consumedIds.has(obj.id) && obj.kind !== 'lattice') {
        const inserts = insertsByHost.get(obj.id) ?? []
        if (inserts.length === 0) {
          const islandOrder = perIsland
            .map((_, i) => i)
            .sort((a, b) => (obj.islandZOrders?.[a] ?? a) - (obj.islandZOrders?.[b] ?? b))
          islandOrder.forEach((islandIdx, depthWithinObject) => {
            if (obj.islandVisible?.[islandIdx] === false) return
            group.add(buildIslandMesh(obj, perIsland, islandIdx, mat, pivot, worldTransform, depthWithinObject * 0.001))
          })
        } else {
          // this host has a filled insert slot — islands and inserted objects must be interleaved
          // by rank so an insert sandwiched between two islands actually renders between them
          type Entry =
            | { kind: 'island'; islandIdx: number; rank: number }
            | { kind: 'insert'; object: SceneObject; rank: number }
          const entries: Entry[] = [
            ...perIsland.map((_, i) => ({ kind: 'island' as const, islandIdx: i, rank: obj.islandZOrders?.[i] ?? i })),
            ...inserts.map((ins) => ({ kind: 'insert' as const, object: ins.object, rank: ins.rank })),
          ]
          entries.sort((a, b) => a.rank - b.rank)
          entries.forEach((entry, i) => {
            const z = i * 0.001
            if (entry.kind === 'island') {
              if (obj.islandVisible?.[entry.islandIdx] === false) return
              group.add(buildIslandMesh(obj, perIsland, entry.islandIdx, mat, pivot, worldTransform, z))
            } else if (entry.object.visible) {
              drawNestedObjectFill(group, entry.object, objects, z, 0.0001)
            }
          })
        }
      }

      if (obj.showIslandNames && islands) {
        const labelPxToWorld = 1 / viewRef.current.zoom
        islands.forEach((island, islandIdx) => {
          if (obj.islandVisible?.[islandIdx] === false) return
          const label = obj.islandNames?.[islandIdx] ?? `Island ${islandIdx + 1}`
          const localCenter = localBoundsCenter(obj.mesh, island.vertices)
          const worldCenter = applyTransform(localCenter, worldTransform)
          // offset in screen space (not local mesh space) so the label stays legibly "below"
          // the shape regardless of the object's own rotation — roughly two lines of the
          // label's own font size, so it doesn't crowd the silhouette
          addIslandNameLabel(scene, { x: worldCenter.x, y: worldCenter.y - 40 * labelPxToWorld }, label)
        })
      }

      // A lattice's wireframe is forced on regardless of the global toggle — it's a cage, not an
      // ordinary mesh, so its edges *are* its visible representation (see the fill-skip above).
      if (wireframeVisible || obj.kind === 'lattice') {
        const wireMesh = obj.mesh
        const edgePositions: number[] = []
        for (const [a, b] of getEdges(wireMesh)) {
          if (hiddenVertices.has(a) || lockedVertices.has(a)) continue // an edge's endpoints are always in the same island
          const va = wireMesh.vertices[a]
          const vb = wireMesh.vertices[b]
          edgePositions.push(va.x - pivot.x, va.y - pivot.y, 0, vb.x - pivot.x, vb.y - pivot.y, 0)
        }
        const edgeGeom = new THREE.BufferGeometry()
        edgeGeom.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3))
        const edgeMat = new THREE.LineBasicMaterial({
          color: obj.kind === 'lattice' ? 0xffaa33 : isSelected ? 0xffffff : 0x000000,
          opacity: 0.6,
          transparent: true,
        })
        const edgeLines = new THREE.LineSegments(edgeGeom, edgeMat)
        edgeLines.position.set(worldTransform.x, worldTransform.y, 0.01 + (perIsland.length - 1) * 0.001)
        edgeLines.rotation.z = worldTransform.rotation
        edgeLines.scale.set(worldTransform.scaleX, worldTransform.scaleY, 1)
        group.add(edgeLines)
      }

      // edit-mode overlays
      if (mode === 'edit' && isSelected) {
        if (editElementType === 'vertex') {
          obj.mesh.vertices.forEach((v, i) => {
            if (hiddenVertices.has(i) || lockedVertices.has(i)) return
            const p = applyTransform(v, worldTransform)
            const selected = selectedVertices.has(i)
            // unselected dots are deliberately smaller than selected ones, to stay legible at
            // high vertex counts
            const color: THREE.ColorRepresentation = selected ? 0xffcc00 : 0xffffff
            const dotGeom = new THREE.CircleGeometry((selected ? 4 : 1.5) / viewRef.current.zoom, 12)
            // `transparent: true` (even at opacity 1) puts this in Three's transparent render
            // queue, which draws after the opaque one — without it, a low "メッシュ不透明度" fill
            // (itself transparent, to trace over a reference image) would paint over the dot,
            // since opaque objects all render before transparent ones regardless of scene order
            const dotMat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true })
            const dot = new THREE.Mesh(dotGeom, dotMat)
            dot.position.set(p.x, p.y, 0.02)
            group.add(dot)
          })
        }

        if (editElementType === 'edge') {
          for (const [a, b] of getEdges(obj.mesh)) {
            if (hiddenVertices.has(a) || lockedVertices.has(a)) continue
            if (!selectedEdges.has(edgeKey(a, b))) continue
            const pa = applyTransform(obj.mesh.vertices[a], worldTransform)
            const pb = applyTransform(obj.mesh.vertices[b], worldTransform)

            // thick quad along the edge (LineBasicMaterial linewidth is ignored by WebGL)
            const halfWidth = 1.2 / viewRef.current.zoom
            const dx = pb.x - pa.x
            const dy = pb.y - pa.y
            const len = Math.hypot(dx, dy) || 1
            const nx = (-dy / len) * halfWidth
            const ny = (dx / len) * halfWidth
            const quadGeom = new THREE.BufferGeometry()
            quadGeom.setAttribute(
              'position',
              new THREE.Float32BufferAttribute(
                [
                  pa.x + nx, pa.y + ny, 0,
                  pa.x - nx, pa.y - ny, 0,
                  pb.x - nx, pb.y - ny, 0,
                  pb.x + nx, pb.y + ny, 0,
                ],
                3,
              ),
            )
            quadGeom.setIndex([0, 1, 2, 0, 2, 3])
            const quadMat = new THREE.MeshBasicMaterial({ color: 0xffe066, depthTest: false, transparent: true })
            const quad = new THREE.Mesh(quadGeom, quadMat)
            quad.position.z = 0.025
            group.add(quad)

            // endpoint markers for extra visibility
            for (const p of [pa, pb]) {
              const dotGeom = new THREE.CircleGeometry(2.5 / viewRef.current.zoom, 12)
              const dot = new THREE.Mesh(dotGeom, new THREE.MeshBasicMaterial({ color: 0xffe066, depthTest: false, transparent: true }))
              dot.position.set(p.x, p.y, 0.026)
              group.add(dot)
            }
          }
        }

        if (editElementType === 'face') {
          obj.mesh.faces.forEach((face, fi) => {
            if (hiddenFaces.has(fi) || lockedFaces.has(fi)) return
            if (!selectedFaces.has(fi)) return
            const pts = face.map((i) => applyTransform(obj.mesh.vertices[i], worldTransform))
            const positions = pts.flatMap((p) => [p.x, p.y, 0])
            const indices = triangulatePolygon(pts)
            const geom = new THREE.BufferGeometry()
            geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
            geom.setIndex(indices)
            const mat = new THREE.MeshBasicMaterial({ color: 0xffcc00, opacity: 0.45, transparent: true, side: THREE.DoubleSide, depthTest: false })
            const faceMesh = new THREE.Mesh(geom, mat)
            faceMesh.position.z = 0.015
            group.add(faceMesh)
          })
        }
      }

      scene.add(group)
    })

    // informational connector lines for every deliberately-detached parent link (connected:
    // false but still parented) — rendered for all such objects, not just the selected one
    for (const obj of objects) {
      if (obj.connected || obj.parentId === null) continue
      const parent = objects.find((o) => o.id === obj.parentId)
      if (!parent) continue
      const parentWorldTransform = getWorldTransform(parent, objects)
      const parentTailWorld = getWorldTail(parent, parentWorldTransform)
      const childWorldTransform = getWorldTransform(obj, objects)
      addDisconnectedLink(scene, parentTailWorld, { x: childWorldTransform.x, y: childWorldTransform.y })
    }

    // BBox gizmo in object mode
    if (mode === 'object' && selectedObjectId) {
      const obj = objects.find((o) => o.id === selectedObjectId)
      if (obj) addGizmo(scene, obj)
    }

    // Fake Flag vertex-mode anchor/direction indicator — shown whenever the selected object has
    // anchors assigned, in any mode, so it's visible as a reference even outside Edit Mode.
    if (selectedObjectId) {
      const obj = objects.find((o) => o.id === selectedObjectId)
      if (obj) addFakeFlagAnchorIndicator(scene, obj, fakeFlagTime, fakeFlagLoopDuration)
    }

    // head/tail handles only in pivot mode — see addPivotHandles
    if (mode === 'pivot' && selectedObjectId) {
      const obj = objects.find((o) => o.id === selectedObjectId)
      if (obj) addPivotHandles(scene, obj)
    }

    // edit-mode pivot marker (small, always-on) + live R/S modal preview
    if (mode === 'edit' && selectedObjectId) {
      const obj = objects.find((o) => o.id === selectedObjectId)
      if (obj) {
        const state = useSceneStore.getState()
        const indices = selectedVertexIndices(state, obj.mesh)
        if (indices.length > 0) {
          const pivot = state.editPivot ?? obj.transform.head
          addEditPivotMarker(scene, obj, pivot)
        }
        // Arc-mode shape key: its own persisted, draggable pivot handle — shown regardless of
        // selection (it's a handle, not an always-on rotate-anchor marker like the one above)
        if (state.editingShapeKeyId) {
          const editingKey = obj.shapeKeys?.find((k) => k.id === state.editingShapeKeyId)
          if (editingKey?.interpolation === 'arc') {
            addEditPivotMarker(scene, obj, editingKey.arcPivot ?? obj.transform.head, 0xf5a623)
          }
        }
        const modal = elementModalRef.current
        if (modal && modal.objectId === obj.id) {
          if (modal.kind === 'move') {
            if (modal.axisLock) addMoveAxisLine(scene, obj, modal)
          } else if (modal.kind === 'vertex-slide') {
            addVertexSlideGuides(scene, modal)
          } else {
            if (modal.kind === 'scale' && modal.axisLock) addMoveAxisLine(scene, obj, modal)
            addElementModalPreview(scene, obj, modal)
          }
        }
      }
    }

    // loop-cut preview (one polyline per pending parallel cut, running the length of the loop)
    const { activeTool } = useSceneStore.getState()
    if (mode === 'edit' && activeTool === 'loopcut' && loopCutHoverRef.current) {
      const obj = objects.find((o) => o.id === selectedObjectId)
      if (obj) {
        const hover = loopCutHoverRef.current
        for (const t of loopCutTs()) addLoopCutPreview(scene, obj, hover.path, t)
      }
    }

    // ring-cut preview (one concentric ring per pending cut, around the hovered fan's center)
    if (mode === 'edit' && activeTool === 'ringcut' && ringCutHoverRef.current) {
      const obj = objects.find((o) => o.id === selectedObjectId)
      if (obj) {
        const hover = ringCutHoverRef.current
        for (const t of ringCutTs()) addRingCutPreview(scene, obj, hover.path, t)
      }
    }

    // knife preview: confirmed points + a live segment out to the cursor
    if (mode === 'edit' && activeTool === 'knife') {
      const obj = objects.find((o) => o.id === selectedObjectId)
      if (obj) addKnifePreview(scene, obj)
    }

    // ghost outline for a primitive about to be placed as an island
    if (mode === 'edit' && (activeTool === 'place-rect' || activeTool === 'place-circle')) {
      const obj = objects.find((o) => o.id === selectedObjectId)
      const pending = useSceneStore.getState().pendingPrimitive
      const at = placePreviewRef.current
      if (obj && pending && at) addPlacePreview(scene, obj, pending, at)
    }

    // hair path preview: dots at each placed control point, plus the tapered mesh outline once
    // there are enough points to build one — all in world space, works with or without a
    // selected object (unlike Rect/Circle's island-only ghost preview above)
    if (activeTool === 'place-hairpath') {
      addHairPathPreview(scene, hairPathRef.current)
    }

    // path preview: same dots-at-control-points idea, plus the live Centripetal Catmull-Rom
    // curve itself (solid, not dashed — a Path's real, persisted rendering also uses a solid
    // line, so the preview matches what confirming it will actually look like)
    if (activeTool === 'place-path') {
      addPathDrawPreview(scene, pathDrawRef.current)
    }
  }

  function addHairPathPreview(scene: THREE.Scene, points: Vec2[]) {
    const pxToWorld = 1 / viewRef.current.zoom
    points.forEach((p) => {
      const dot = new THREE.Mesh(
        new THREE.CircleGeometry(3 * pxToWorld, 12),
        new THREE.MeshBasicMaterial({ color: 0x4ea1ff, depthTest: false, transparent: true }),
      )
      dot.position.set(p.x, p.y, 0.71)
      scene.add(dot)
    })
    if (points.length < 2) return
    const mesh = createHairPathMesh(points, hairPathWidthRef.current, useSceneStore.getState().hairPathConstantWidth)
    const positions: number[] = []
    for (const [a, b] of getEdges(mesh)) {
      const va = mesh.vertices[a]
      const vb = mesh.vertices[b]
      positions.push(va.x, va.y, 0.7, vb.x, vb.y, 0.7)
    }
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    const mat = new THREE.LineDashedMaterial({
      color: 0x4ea1ff,
      dashSize: 6 * pxToWorld,
      gapSize: 4 * pxToWorld,
      depthTest: false,
      transparent: true,
    })
    const outline = new THREE.LineSegments(geom, mat)
    outline.computeLineDistances()
    scene.add(outline)
  }

  function addPathDrawPreview(scene: THREE.Scene, points: Vec2[]) {
    const pxToWorld = 1 / viewRef.current.zoom
    points.forEach((p) => {
      const dot = new THREE.Mesh(
        new THREE.CircleGeometry(3 * pxToWorld, 12),
        new THREE.MeshBasicMaterial({ color: 0xffaa33, depthTest: false, transparent: true }),
      )
      dot.position.set(p.x, p.y, 0.71)
      scene.add(dot)
    })
    if (points.length < 2) return
    addPathCurveLine(scene, evaluatePathCurve(points), 0.7, false)
  }

  /** Shared curve-line builder for both the in-progress draw preview and a confirmed Path
   *  object's persisted rendering — just a plain `LineSegments` through consecutive samples
   *  (`evaluatePathCurve`'s dense polyline approximation), no fill (a Path has no `mesh.faces`). */
  function addPathCurveLine(target: THREE.Scene | THREE.Group, samples: Vec2[], z: number, isSelected: boolean, closed = false) {
    const positions: number[] = []
    for (let i = 0; i < samples.length - 1; i++) {
      const a = samples[i]
      const b = samples[i + 1]
      positions.push(a.x, a.y, z, b.x, b.y, z)
    }
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    const color = isSelected ? 0xffaa33 : 0xdda85a
    const opacity = isSelected ? 1 : 0.8
    // dashed rather than solid — a Path is a reference curve for other objects' modifiers to
    // follow, not visible rendered content of its own (same "this is a guide, not the art" cue
    // as the Hair Path draw preview's dashed outline)
    const pxToWorld = 1 / viewRef.current.zoom
    const mat = new THREE.LineDashedMaterial({
      color,
      depthTest: false,
      transparent: true,
      opacity,
      dashSize: 6 * pxToWorld,
      gapSize: 4 * pxToWorld,
    })
    const line = new THREE.LineSegments(geom, mat)
    line.computeLineDistances()
    target.add(line)

    // arrowhead at the end point (last control point, i.e. `mesh.vertices[length - 1]`) — the
    // only visual cue for a Path's otherwise-invisible start/end direction, which matters for
    // Follow Path/Path Deform (Rail) reading it as a 0..1 progression from start to end. Skipped
    // for a closed path — there's no distinct "end" once the curve loops back on itself (the last
    // sample coincides with the first, see `evaluatePathCurve`'s `closed` param). */
    if (!closed && samples.length >= 2) {
      const tip = samples[samples.length - 1]
      const prev = samples[samples.length - 2]
      const dx = tip.x - prev.x
      const dy = tip.y - prev.y
      const len = Math.hypot(dx, dy)
      if (len > 0) {
        const dir = { x: dx / len, y: dy / len }
        const perp = { x: -dir.y, y: dir.x }
        const pxToWorld = 1 / viewRef.current.zoom
        const headLen = 10 * pxToWorld
        const headWidth = 5 * pxToWorld
        const base = { x: tip.x - dir.x * headLen, y: tip.y - dir.y * headLen }
        const headGeom = new THREE.BufferGeometry()
        headGeom.setAttribute(
          'position',
          new THREE.Float32BufferAttribute(
            [
              tip.x, tip.y, z,
              base.x + perp.x * headWidth, base.y + perp.y * headWidth, z,
              base.x - perp.x * headWidth, base.y - perp.y * headWidth, z,
            ],
            3,
          ),
        )
        target.add(new THREE.Mesh(headGeom, new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity })))
      }
    }
  }

  function addPlacePreview(scene: THREE.Scene, obj: SceneObject, pending: PendingPrimitive, at: Vec2) {
    const worldTransform = getWorldTransform(obj, useSceneStore.getState().objects)
    const pxToWorld = 1 / viewRef.current.zoom
    const positions: number[] = []
    if (pending.kind === 'rect') {
      const hw = pending.width / 2
      const hh = pending.height / 2
      const corners = [
        { x: at.x - hw, y: at.y - hh },
        { x: at.x + hw, y: at.y - hh },
        { x: at.x + hw, y: at.y + hh },
        { x: at.x - hw, y: at.y + hh },
      ].map((p) => applyTransform(p, worldTransform))
      for (let i = 0; i < corners.length; i++) {
        const a = corners[i]
        const b = corners[(i + 1) % corners.length]
        positions.push(a.x, a.y, 0.7, b.x, b.y, 0.7)
      }
    } else {
      const segments = 32
      const pts: { x: number; y: number }[] = []
      for (let i = 0; i < segments; i++) {
        const angle = (i / segments) * Math.PI * 2
        pts.push(applyTransform({ x: at.x + Math.cos(angle) * pending.radius, y: at.y + Math.sin(angle) * pending.radius }, worldTransform))
      }
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i]
        const b = pts[(i + 1) % pts.length]
        positions.push(a.x, a.y, 0.7, b.x, b.y, 0.7)
      }
    }
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    const mat = new THREE.LineDashedMaterial({
      color: 0x4ea1ff,
      dashSize: 6 * pxToWorld,
      gapSize: 4 * pxToWorld,
      depthTest: false,
      transparent: true,
    })
    const outline = new THREE.LineSegments(geom, mat)
    outline.computeLineDistances()
    scene.add(outline)

    const center = applyTransform(at, worldTransform)
    // `transparent: true` (even at opacity 1) is needed so this draws after a low "メッシュ不透明
    // 度" fill or the reference image — see the vertex-dot comment above for why
    const dot = new THREE.Mesh(
      new THREE.CircleGeometry(3 * pxToWorld, 12),
      new THREE.MeshBasicMaterial({ color: 0x4ea1ff, depthTest: false, transparent: true }),
    )
    dot.position.set(center.x, center.y, 0.71)
    scene.add(dot)
  }

  function addKnifePreview(scene: THREE.Scene, obj: SceneObject) {
    const points = [...knifePathRef.current]
    if (knifeHoverRef.current) points.push(knifeHoverRef.current)
    if (points.length === 0) return

    const worldTransform = getWorldTransform(obj, useSceneStore.getState().objects)
    const worldPts = points.map((p) => applyTransform(knifePointLocal(obj, p), worldTransform))

    const positions: number[] = []
    for (let i = 0; i < worldPts.length - 1; i++) {
      positions.push(worldPts[i].x, worldPts[i].y, 0.7, worldPts[i + 1].x, worldPts[i + 1].y, 0.7)
    }
    if (positions.length > 0) {
      const geom = new THREE.BufferGeometry()
      geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
      scene.add(
        new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color: 0xff5577, depthTest: false, transparent: true })),
      )
    }

    const pxToWorld = 1 / viewRef.current.zoom
    worldPts.forEach((p, i) => {
      const isHoverTip = i === worldPts.length - 1 && knifeHoverRef.current
      const dotGeom = new THREE.CircleGeometry((isHoverTip ? 4 : 3) * pxToWorld, 12)
      const color = isHoverTip ? 0xff5577 : 0xffffff
      // `transparent: true` (even at opacity 1) is needed so this draws after a low "メッシュ不透明
      // 度" fill or the reference image — see the vertex-dot comment above for why
      const dot = new THREE.Mesh(dotGeom, new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true }))
      dot.position.set(p.x, p.y, 0.71)
      scene.add(dot)
    })
  }

  function addLoopCutPreview(scene: THREE.Scene, obj: SceneObject, path: LoopPath, t: number) {
    const { mesh } = obj
    const worldTransform = getWorldTransform(obj, useSceneStore.getState().objects)
    const lerp = (a: { x: number; y: number }, b: { x: number; y: number }, t: number) => ({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
    })

    const points = path.cuts.map(([a, b]) =>
      applyTransform(lerp(mesh.vertices[a], mesh.vertices[b], t), worldTransform),
    )

    const positions: number[] = []
    for (let i = 0; i < points.length - 1; i++) {
      positions.push(points[i].x, points[i].y, 0.7, points[i + 1].x, points[i + 1].y, 0.7)
    }
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    scene.add(
      new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color: 0xffaa33, depthTest: false, transparent: true })),
    )

    const pxToWorld = 1 / viewRef.current.zoom
    for (const p of points) {
      const dotGeom = new THREE.CircleGeometry(3 * pxToWorld, 12)
      // `transparent: true` (even at opacity 1) is needed so this draws after a low "メッシュ不透明
      // 度" fill or the reference image — see the vertex-dot comment above for why
      const dot = new THREE.Mesh(dotGeom, new THREE.MeshBasicMaterial({ color: 0xffaa33, depthTest: false, transparent: true }))
      dot.position.set(p.x, p.y, 0.7)
      scene.add(dot)
    }
  }

  function addRingCutPreview(scene: THREE.Scene, obj: SceneObject, path: FanPath, t: number) {
    const { mesh } = obj
    const worldTransform = getWorldTransform(obj, useSceneStore.getState().objects)
    const centerV = mesh.vertices[path.center]
    const lerp = (a: { x: number; y: number }, b: { x: number; y: number }, t: number) => ({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
    })

    const points = path.rim.map((r) => applyTransform(lerp(centerV, mesh.vertices[r], t), worldTransform))

    const positions: number[] = []
    const segCount = path.closed ? points.length : points.length - 1
    for (let i = 0; i < segCount; i++) {
      const j = path.closed ? (i + 1) % points.length : i + 1
      positions.push(points[i].x, points[i].y, 0.7, points[j].x, points[j].y, 0.7)
    }
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    scene.add(
      new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color: 0xffaa33, depthTest: false, transparent: true })),
    )

    const pxToWorld = 1 / viewRef.current.zoom
    for (const p of points) {
      const dotGeom = new THREE.CircleGeometry(3 * pxToWorld, 12)
      const dot = new THREE.Mesh(dotGeom, new THREE.MeshBasicMaterial({ color: 0xffaa33, depthTest: false, transparent: true }))
      dot.position.set(p.x, p.y, 0.7)
      scene.add(dot)
    }
  }

  /** Trace-over reference image, drawn behind the grid and every object. */
  function addReferenceImage(scene: THREE.Scene, ref: ReferenceImage) {
    let texture = textureCacheRef.current.get(ref.url)
    if (!texture) {
      texture = textureLoaderRef.current.load(ref.url)
      texture.colorSpace = THREE.SRGBColorSpace
      textureCacheRef.current.set(ref.url, texture)
    }
    const image = texture.image as HTMLImageElement | undefined
    if (!image?.width) return // not loaded yet — skip this frame, retry next

    const width = image.width * ref.scale
    const height = image.height * ref.scale
    const geom = new THREE.PlaneGeometry(width, height)
    const mat = new THREE.MeshBasicMaterial({
      map: texture,
      // always on, not just when opacity<1 — the image's own alpha channel (e.g. a PNG with a
      // transparent background) needs respecting regardless of the opacity slider's value
      transparent: true,
      opacity: ref.opacity,
      depthWrite: false,
    })
    const mesh = new THREE.Mesh(geom, mat)
    mesh.position.set(ref.x, ref.y, -50)
    scene.add(mesh)
  }

  /** The adaptive major grid spacing for the current zoom (world units) — lines stay ~60px apart
   *  on screen regardless of zoom. Shared by `addGrid` and grid-snap, so snapping always matches
   *  whatever spacing is actually on screen. */
  function getMajorGridSpacing(zoom: number): number {
    const targetPx = 60
    const rawSpacing = targetPx / zoom
    const pow = Math.pow(10, Math.floor(Math.log10(rawSpacing)))
    const candidates = [1, 2, 5, 10].map((m) => m * pow)
    return candidates.find((c) => c >= rawSpacing) ?? candidates[candidates.length - 1]
  }

  /** Grid-snap increment (world units) — one sub-grid cell, the same lines drawn by `addGrid`. */
  function getGridSnapIncrement(): number {
    const { gridSubdivisions } = useSceneStore.getState()
    return getMajorGridSpacing(viewRef.current.zoom) / gridSubdivisions
  }

  function snapToIncrement(value: number, increment: number): number {
    return Math.round(value / increment) * increment
  }

  /** Whether a move should grid-snap right now: the persistent "Grid Snap" toggle, with Ctrl
   *  held temporarily flipping it (Blender-style) — so leaving the toggle on means continuous
   *  snapping with no key to hold, while Ctrl is still there for the rare one-off override. */
  function shouldGridSnap(ctrlKey: boolean): boolean {
    return useSceneStore.getState().gridSnapEnabled !== ctrlKey
  }

  function addGrid(scene: THREE.Scene) {
    const view = viewRef.current
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return
    const halfW = rect.width / 2 / view.zoom
    const halfH = rect.height / 2 / view.zoom

    const spacing = getMajorGridSpacing(view.zoom)

    const minX = Math.floor((view.panX - halfW) / spacing) * spacing
    const maxX = Math.ceil((view.panX + halfW) / spacing) * spacing
    const minY = Math.floor((view.panY - halfH) / spacing) * spacing
    const maxY = Math.ceil((view.panY + halfH) / spacing) * spacing

    const minorPositions: number[] = []
    let yAxisPositions: number[] | null = null // vertical line through x=0
    let xAxisPositions: number[] | null = null // horizontal line through y=0
    for (let x = minX; x <= maxX; x += spacing) {
      if (Math.abs(x) < spacing / 2) yAxisPositions = [x, minY, -10, x, maxY, -10]
      else minorPositions.push(x, minY, -10, x, maxY, -10)
    }
    for (let y = minY; y <= maxY; y += spacing) {
      if (Math.abs(y) < spacing / 2) xAxisPositions = [minX, y, -10, maxX, y, -10]
      else minorPositions.push(minX, y, -10, maxX, y, -10)
    }

    // sub-grid: finer lines within each major cell, dividing it into `gridSubdivisions` parts —
    // also doubles as the increment grid-snap will snap to, so it stays user-configurable rather
    // than a fixed fraction. Skipped once the lines would land closer than a few px apart (e.g.
    // zoomed out, or a high subdivision count), where they'd just be visual noise.
    const { gridSubdivisions } = useSceneStore.getState()
    const subSpacing = spacing / gridSubdivisions
    const subPositions: number[] = []
    if (subSpacing * view.zoom >= 6) {
      const subMinX = Math.floor(minX / subSpacing) * subSpacing
      const subMaxX = Math.ceil(maxX / subSpacing) * subSpacing
      const subMinY = Math.floor(minY / subSpacing) * subSpacing
      const subMaxY = Math.ceil(maxY / subSpacing) * subSpacing
      const mod = (n: number, m: number) => ((n % m) + m) % m
      // z is a hair in front of the major grid's -10 — sharing the exact same depth let the
      // dashed line's fragments lose the depth test to the (earlier-drawn, opaque) major grid
      // lines at floating-point-precision boundaries, making the dashes flicker out entirely
      for (let x = subMinX; x <= subMaxX; x += subSpacing) {
        const r = mod(x, spacing)
        if (r < subSpacing / 2 || spacing - r < subSpacing / 2) continue // coincides with a major line
        subPositions.push(x, subMinY, -9.99, x, subMaxY, -9.99)
      }
      for (let y = subMinY; y <= subMaxY; y += subSpacing) {
        const r = mod(y, spacing)
        if (r < subSpacing / 2 || spacing - r < subSpacing / 2) continue
        subPositions.push(subMinX, y, -9.99, subMaxX, y, -9.99)
      }
    }
    if (subPositions.length > 0) {
      const pxToWorld = 1 / view.zoom
      const geom = new THREE.BufferGeometry()
      geom.setAttribute('position', new THREE.Float32BufferAttribute(subPositions, 3))
      const mat = new THREE.LineDashedMaterial({
        color: 0x545454,
        dashSize: 2 * pxToWorld,
        gapSize: 2 * pxToWorld,
        transparent: true,
      })
      const subLines = new THREE.LineSegments(geom, mat)
      subLines.computeLineDistances()
      scene.add(subLines)
    }

    if (minorPositions.length > 0) {
      const geom = new THREE.BufferGeometry()
      geom.setAttribute('position', new THREE.Float32BufferAttribute(minorPositions, 3))
      const mat = new THREE.LineBasicMaterial({ color: 0x545454 })
      scene.add(new THREE.LineSegments(geom, mat))
    }
    if (xAxisPositions) {
      const geom = new THREE.BufferGeometry()
      geom.setAttribute('position', new THREE.Float32BufferAttribute(xAxisPositions, 3))
      scene.add(new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color: 0xe5484d })))
    }
    if (yAxisPositions) {
      const geom = new THREE.BufferGeometry()
      geom.setAttribute('position', new THREE.Float32BufferAttribute(yAxisPositions, 3))
      scene.add(new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color: 0x4ec96a })))
    }
  }

  /** Shared geometry for the gizmo, used both for rendering and hit-testing so they stay in sync.
   *  Ring/arrow size is fixed in screen pixels (like Blender) so it doesn't balloon or shrink
   *  with object size/rotation/zoom; the corner scale handles follow the actual mesh bounds,
   *  either rotated with the object ('local') or as a world-axis-aligned AABB ('world'). */
  function getGizmoGeom(obj: SceneObject) {
    const worldTransform = getWorldTransform(obj, useSceneStore.getState().objects)
    // an Empty has no vertices, so getBounds would return +/-Infinity — fall back to a small
    // fixed box around its head so the gizmo still renders at a sane, finite size. A Path uses
    // its evaluated curve samples rather than raw control points — see `boundsVertices`'s doc.
    const boundVerts = boundsVertices(obj)
    const lb =
      boundVerts.length > 0
        ? getBounds({ vertices: boundVerts, faces: [] })
        : { minX: -EMPTY_GIZMO_SIZE, maxX: EMPTY_GIZMO_SIZE, minY: -EMPTY_GIZMO_SIZE, maxY: EMPTY_GIZMO_SIZE }
    const center = { x: worldTransform.x, y: worldTransform.y }
    const pxToWorld = 1 / viewRef.current.zoom
    const ringRadius = RING_RADIUS_PX * pxToWorld
    const arrowLength = ARROW_LENGTH_PX * pxToWorld
    // Blender-style "transform orientation", applied to both the move-gizmo axis arrows and the
    // BBox outline/corner handles below. 'world' pins the arrows to the scene's X/Y and switches
    // the outline to an axis-aligned bounding box (of the rotated shape) instead of one that
    // rotates with the object; 'local' (default) follows the object's own world rotation for
    // both. The rotate ring has no orientation concept either way.
    const useWorldAxes = useSceneStore.getState().gizmoOrientation === 'world'
    const cos = Math.cos(worldTransform.rotation)
    const sin = Math.sin(worldTransform.rotation)
    const axisX = useWorldAxes ? { x: 1, y: 0 } : { x: cos, y: sin } // local +X in world space
    const axisY = useWorldAxes ? { x: 0, y: 1 } : { x: -sin, y: cos } // local +Y in world space
    // the four local corners, transformed into world space (follows rotation exactly)
    const orientedCorners: Array<{ key: 'tl' | 'tr' | 'bl' | 'br'; x: number; y: number }> = [
      { key: 'bl', ...applyTransform({ x: lb.minX, y: lb.minY }, worldTransform) },
      { key: 'br', ...applyTransform({ x: lb.maxX, y: lb.minY }, worldTransform) },
      { key: 'tl', ...applyTransform({ x: lb.minX, y: lb.maxY }, worldTransform) },
      { key: 'tr', ...applyTransform({ x: lb.maxX, y: lb.maxY }, worldTransform) },
    ]
    // in world mode, swap in the axis-aligned bounding box of those same (rotated) corners — the
    // 'bl'/'br'/'tl'/'tr' keys are just labels for outline winding order and the scale-drag log
    // (unused elsewhere), so relabeling them to the AABB's corners is safe
    const corners: Array<{ key: 'tl' | 'tr' | 'bl' | 'br'; x: number; y: number }> = !useWorldAxes
      ? orientedCorners
      : (() => {
          const xs = orientedCorners.map((c) => c.x)
          const ys = orientedCorners.map((c) => c.y)
          const minX = Math.min(...xs)
          const maxX = Math.max(...xs)
          const minY = Math.min(...ys)
          const maxY = Math.max(...ys)
          return [
            { key: 'bl' as const, x: minX, y: minY },
            { key: 'br' as const, x: maxX, y: minY },
            { key: 'tl' as const, x: minX, y: maxY },
            { key: 'tr' as const, x: maxX, y: maxY },
          ]
        })()
    // one handle per edge midpoint, for single-axis (non-corner) scaling — left/right mid
    // handles scale local X only, top/bottom mid handles scale local Y only (see the
    // `scale-object` drag's `axisLock`). Derived from the same `corners` used above so they
    // follow the exact same local-vs-world orientation toggle with no separate logic.
    const cornerByKey = Object.fromEntries(corners.map((c) => [c.key, c])) as unknown as Record<
      'tl' | 'tr' | 'bl' | 'br',
      { x: number; y: number }
    >
    const mid = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
    const edgeHandles: Array<{ axisLock: 'x' | 'y'; x: number; y: number }> = [
      { axisLock: 'x', ...mid(cornerByKey.tr, cornerByKey.br) }, // right
      { axisLock: 'x', ...mid(cornerByKey.tl, cornerByKey.bl) }, // left
      { axisLock: 'y', ...mid(cornerByKey.tl, cornerByKey.tr) }, // top
      { axisLock: 'y', ...mid(cornerByKey.bl, cornerByKey.br) }, // bottom
    ]
    return { localBounds: lb, center, ringRadius, arrowLength, axisX, axisY, corners, edgeHandles }
  }

  /** Small always-on marker at the edit-mode pivot (set via P) — deliberately not a full
   *  gizmo, just enough to know where rotate/scale will anchor when R/S is pressed. Also reused
   *  (with a distinct `color`) for a shape key's draggable Arc-mode pivot handle. */
  function addEditPivotMarker(scene: THREE.Scene, obj: SceneObject, pivot: Vec2, color: THREE.ColorRepresentation = 0xe5484d) {
    const worldTransform = getWorldTransform(obj, useSceneStore.getState().objects)
    const pxToWorld = 1 / viewRef.current.zoom
    const center = applyTransform(pivot, worldTransform)
    const ringGeom = new THREE.RingGeometry(6 * pxToWorld - 0.8 * pxToWorld, 6 * pxToWorld + 0.8 * pxToWorld, 24)
    const ring = new THREE.Mesh(ringGeom, new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true }))
    ring.position.set(center.x, center.y, 0.65)
    scene.add(ring)
  }

  /** World-space anchor point, ring radius, and current-angle marker for a Fake-Flagged object's
   *  direction handle — a compact rotate ring at the anchor root (Blender-gizmo style) rather than
   *  a long arrow, so it stays out of the way of the mesh/wave curve. Shared by the drawing code
   *  and the pointerdown hit-test/drag logic below so they always agree on where the ring actually
   *  is. `null` when Fake Flag doesn't apply at all (disabled, or no settings). The ring itself is
   *  a fixed screen size and doesn't animate with the wave — only `markerWorld` (the dot showing
   *  the current angle) moves, and only when `direction` itself changes. */
  function getFakeFlagDirectionHandle(
    obj: SceneObject,
    time: number,
    loopDuration: number,
  ): { anchorWorld: Vec2; markerWorld: Vec2; ringRadiusWorld: number; worldTransform: Transform } | null {
    const settings = getFakeFlag(obj)
    if (!settings?.enabled) return null
    const worldTransform = getWorldTransform(obj, useSceneStore.getState().objects)
    const pxToWorld = 1 / viewRef.current.zoom
    const anchorIdx = settings.anchorVertices

    let anchorLocal: Vec2
    if (anchorIdx?.length) {
      const anchorLocalPositions = anchorIdx.map((i) => obj.mesh.vertices[i]).filter((v): v is Vec2 => !!v)
      if (anchorLocalPositions.length === 0) return null
      anchorLocal = anchorLocalPositions.reduce(
        (acc, p) => ({ x: acc.x + p.x / anchorLocalPositions.length, y: acc.y + p.y / anchorLocalPositions.length }),
        { x: 0, y: 0 },
      )
    } else {
      anchorLocal = obj.transform.head
    }

    const anchorWorld = applyTransform(anchorLocal, worldTransform)
    const ringRadiusWorld = FAKE_FLAG_RING_RADIUS_PX * pxToWorld
    const dirRad = (settings.direction * Math.PI) / 180 + worldTransform.rotation
    const dirWorld = { x: Math.cos(dirRad), y: Math.sin(dirRad) }
    const markerWorld = { x: anchorWorld.x + dirWorld.x * ringRadiusWorld, y: anchorWorld.y + dirWorld.y * ringRadiusWorld }
    return { anchorWorld, markerWorld, ringRadiusWorld, worldTransform }
  }

  /** Fake Flag's direction indicator/handle. Vertex mode also draws a dashed curve from the
   *  anchor centroid out to the mesh's tip, tracing the *actual current wave shape* (not just a
   *  static arrow) so it's obvious both which way the cloth is set up to wave and what it's doing
   *  right now — anchor vertices themselves are drawn as small rings. Either way, the *draggable*
   *  handle itself (from `getFakeFlagDirectionHandle`) is a small rotate ring at the anchor root —
   *  see that function for why it doesn't follow the animated wave. */
  function addFakeFlagAnchorIndicator(scene: THREE.Scene, obj: SceneObject, time: number, loopDuration: number) {
    const settings = getFakeFlag(obj)
    if (!settings?.enabled) return
    const worldTransform = getWorldTransform(obj, useSceneStore.getState().objects)
    const pxToWorld = 1 / viewRef.current.zoom
    const anchorColor = 0xf5a623
    const anchorIdx = settings.anchorVertices

    const handle = getFakeFlagDirectionHandle(obj, time, loopDuration)
    if (!handle) return

    const ringGeom2 = new THREE.RingGeometry(handle.ringRadiusWorld - 1 * pxToWorld, handle.ringRadiusWorld + 1 * pxToWorld, 40)
    const ringMesh2 = new THREE.Mesh(ringGeom2, new THREE.MeshBasicMaterial({ color: anchorColor, depthTest: false, transparent: true }))
    ringMesh2.position.set(handle.anchorWorld.x, handle.anchorWorld.y, 0.68)
    scene.add(ringMesh2)
    const markerGeom = new THREE.CircleGeometry(3 * pxToWorld, 16)
    const marker = new THREE.Mesh(markerGeom, new THREE.MeshBasicMaterial({ color: anchorColor, depthTest: false, transparent: true }))
    marker.position.set(handle.markerWorld.x, handle.markerWorld.y, 0.69)
    scene.add(marker)

    if (!anchorIdx?.length) return

    const anchorLocalPositions = anchorIdx.map((i) => obj.mesh.vertices[i]).filter((v): v is Vec2 => !!v)
    if (anchorLocalPositions.length === 0) return

    for (const p of anchorLocalPositions) {
      const world = applyTransform(p, worldTransform)
      const ringGeom = new THREE.RingGeometry(4 * pxToWorld - 0.8 * pxToWorld, 4 * pxToWorld + 0.8 * pxToWorld, 20)
      const ring = new THREE.Mesh(ringGeom, new THREE.MeshBasicMaterial({ color: anchorColor, depthTest: false, transparent: true }))
      ring.position.set(world.x, world.y, 0.65)
      scene.add(ring)
    }

    const centroidLocal = anchorLocalPositions.reduce(
      (acc, p) => ({ x: acc.x + p.x / anchorLocalPositions.length, y: acc.y + p.y / anchorLocalPositions.length }),
      { x: 0, y: 0 },
    )
    const extent = Math.max(fakeFlagAnchorExtent(obj), 1e-3)
    const samplesLocal = fakeFlagIndicatorSamples(settings, centroidLocal, extent, time, loopDuration)
    const samplesWorld = samplesLocal.map((p) => applyTransform(p, worldTransform))

    for (let i = 0; i < samplesWorld.length - 1; i++) {
      const a = samplesWorld[i]
      const b = samplesWorld[i + 1]
      addDashedThickLine(scene, a.x, a.y, b.x, b.y, anchorColor, pxToWorld)
    }

    // Small arrowhead at the curve's tip, purely informational (points along the curve's local
    // tangent there) — not draggable itself, that's the ring handle drawn above.
    const tip = samplesWorld[samplesWorld.length - 1]
    const beforeTip = samplesWorld[samplesWorld.length - 2] ?? tip
    const tipDir = { x: tip.x - beforeTip.x, y: tip.y - beforeTip.y }
    const tipDirLen = Math.hypot(tipDir.x, tipDir.y) || 1
    addAxisArrow(scene, beforeTip, { x: tipDir.x / tipDirLen, y: tipDir.y / tipDirLen }, tipDirLen, pxToWorld, anchorColor)
  }

  /** Informational dashed line from a parent's world tail to a `connected: false` child's world
   *  head — the visual indicator that a deliberately-detached parent link still exists. */
  function addDisconnectedLink(scene: THREE.Scene, parentTailWorld: Vec2, childHeadWorld: Vec2) {
    const pxToWorld = 1 / viewRef.current.zoom
    const geom = new THREE.BufferGeometry()
    geom.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [parentTailWorld.x, parentTailWorld.y, 0.6, childHeadWorld.x, childHeadWorld.y, 0.6],
        3,
      ),
    )
    const mat = new THREE.LineDashedMaterial({
      color: 0xcc8400,
      dashSize: 5 * pxToWorld,
      gapSize: 4 * pxToWorld,
      depthTest: false,
      transparent: true,
    })
    const line = new THREE.LineSegments(geom, mat)
    line.computeLineDistances()
    scene.add(line)
  }

  /** A billboarded text label at a world position — used to show every island's name (toggled
   *  once per object in the Properties panel) just below its bounding-box center. Rendered as a
   *  canvas-texture sprite rather than a DOM overlay, consistent with every other viewport
   *  annotation in this file. Drawn at `RESOLUTION_SCALE`x and scaled back down so the on-screen
   *  size matches ordinary UI text (~12px) without the canvas's own low resolution blurring it. */
  function addIslandNameLabel(scene: THREE.Scene, worldPos: Vec2, text: string) {
    const RESOLUTION_SCALE = 3
    const fontSizeOnScreen = 12
    const fontSize = fontSizeOnScreen * RESOLUTION_SCALE
    const fontFamily = "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" // matches body { font-family } in style.css
    const paddingX = 6 * RESOLUTION_SCALE
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')!
    ctx.font = `${fontSize}px ${fontFamily}`
    const textWidth = ctx.measureText(text).width
    canvas.width = Math.ceil(textWidth) + paddingX * 2
    canvas.height = fontSize + paddingX
    ctx.font = `${fontSize}px ${fontFamily}`
    ctx.fillStyle = '#707070'
    ctx.beginPath()
    ctx.roundRect(0, 0, canvas.width, canvas.height, 6 * RESOLUTION_SCALE)
    ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'center'
    ctx.fillText(text, canvas.width / 2, canvas.height / 2)

    const texture = new THREE.CanvasTexture(canvas)
    // without this, the renderer treats the canvas's colors as already-linear and re-encodes
    // them to sRGB on output, washing out/brightening what was actually drawn (e.g. #848484
    // would render visibly lighter, like #bebebe) — same fix as the material texture below
    texture.colorSpace = THREE.SRGBColorSpace
    const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true })
    const sprite = new THREE.Sprite(material)
    const pxToWorld = 1 / viewRef.current.zoom / RESOLUTION_SCALE
    sprite.scale.set(canvas.width * pxToWorld, canvas.height * pxToWorld, 1)
    sprite.position.set(worldPos.x, worldPos.y, 0.9)
    scene.add(sprite)
  }

  /** Dashed line rendered as a chain of quads (LineDashedMaterial linewidth is ignored by WebGL,
   *  so thickness needs actual geometry). x1,y1 -> x2,y2 in world space. */
  function addDashedThickLine(
    scene: THREE.Scene,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: number,
    pxToWorld: number,
  ) {
    const dx = x2 - x1
    const dy = y2 - y1
    const len = Math.hypot(dx, dy)
    if (len < 1e-6) return
    const ux = dx / len
    const uy = dy / len
    const halfWidth = 1 * pxToWorld // 2px total, matching the grid line width
    const dash = 7 * pxToWorld
    const gap = 5 * pxToWorld
    const step = dash + gap
    const count = Math.ceil(len / step)
    const positions: number[] = []
    const indices: number[] = []
    let vi = 0
    for (let i = 0; i < count; i++) {
      const start = i * step
      if (start >= len) break
      const end = Math.min(start + dash, len)
      const sx = x1 + ux * start
      const sy = y1 + uy * start
      const ex = x1 + ux * end
      const ey = y1 + uy * end
      const nx = -uy * halfWidth
      const ny = ux * halfWidth
      positions.push(sx + nx, sy + ny, 0.7, sx - nx, sy - ny, 0.7, ex - nx, ey - ny, 0.7, ex + nx, ey + ny, 0.7)
      indices.push(vi, vi + 1, vi + 2, vi, vi + 2, vi + 3)
      vi += 4
    }
    if (positions.length === 0) return
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geom.setIndex(indices)
    scene.add(new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true })))
  }

  /** Live feedback while a G move is axis-locked (X/Y): a dashed world-space line through the
   *  moving selection's centroid, spanning the visible viewport, colored like Blender's axis
   *  colors (X=red, Y=green). */
  function addMoveAxisLine(scene: THREE.Scene, obj: SceneObject, modal: Extract<ElementModal, { kind: 'move' | 'scale' }>) {
    if (!modal.axisLock) return
    const worldTransform = getWorldTransform(obj, useSceneStore.getState().objects)
    const pts = modal.indices.map((i) => applyTransform(obj.mesh.vertices[i], worldTransform))
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length
    const pxToWorld = 1 / viewRef.current.zoom
    const rect = containerRef.current!.getBoundingClientRect()
    const margin = 50 * pxToWorld
    const color = modal.axisLock === 'x' ? 0xe5484d : 0x4dca5a
    if (modal.axisLock === 'x') {
      const halfW = rect.width / 2 / viewRef.current.zoom + margin
      addDashedThickLine(scene, viewRef.current.panX - halfW, cy, viewRef.current.panX + halfW, cy, color, pxToWorld)
    } else {
      const halfH = rect.height / 2 / viewRef.current.zoom + margin
      addDashedThickLine(scene, cx, viewRef.current.panY - halfH, cx, viewRef.current.panY + halfH, color, pxToWorld)
    }
  }

  /** Live feedback during GG vertex-slide: a dashed guide line through the rail each sliding
   *  vertex is currently riding, extended past both endpoints (Blender shows the same guide,
   *  and it's what makes the Alt-unclamped overshoot past the neighbor legible). */
  function addVertexSlideGuides(scene: THREE.Scene, modal: Extract<ElementModal, { kind: 'vertex-slide' }>) {
    const pxToWorld = 1 / viewRef.current.zoom
    const extend = 2000 * pxToWorld
    for (const rail of modal.liveRails) {
      if (!rail) continue
      const dx = rail.targetWorld.x - rail.origWorld.x
      const dy = rail.targetWorld.y - rail.origWorld.y
      const len = Math.hypot(dx, dy)
      if (len < 1e-6) continue
      const ux = dx / len
      const uy = dy / len
      addDashedThickLine(
        scene,
        rail.origWorld.x - ux * extend,
        rail.origWorld.y - uy * extend,
        rail.origWorld.x + ux * extend,
        rail.origWorld.y + uy * extend,
        0xffaa33,
        pxToWorld,
      )
    }
  }

  /** Live feedback while an R/S modal transform is in progress: a radial line from the pivot
   *  out to the cursor (and, for rotate, a faint full ring as an angle reference). */
  function addElementModalPreview(scene: THREE.Scene, obj: SceneObject, modal: Extract<ElementModal, { kind: 'rotate' | 'scale' }>) {
    const worldTransform = getWorldTransform(obj, useSceneStore.getState().objects)
    const pxToWorld = 1 / viewRef.current.zoom
    const center = applyTransform(modal.pivot, worldTransform)
    const world = screenToWorld(
      lastPointerRef.current.clientX,
      lastPointerRef.current.clientY,
      containerRef.current!.getBoundingClientRect(),
      viewRef.current,
    )

    if (modal.kind === 'rotate') {
      const ringRadius = RING_RADIUS_PX * pxToWorld
      const ringGeom = new THREE.RingGeometry(ringRadius - 1 * pxToWorld, ringRadius + 1 * pxToWorld, 48)
      const ring = new THREE.Mesh(ringGeom, new THREE.MeshBasicMaterial({ color: 0xffaa33, depthTest: false, opacity: 0.5, transparent: true }))
      ring.position.set(center.x, center.y, 0.55)
      scene.add(ring)
    }

    const lineGeom = new THREE.BufferGeometry()
    lineGeom.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([center.x, center.y, 0.7, world.x, world.y, 0.7], 3),
    )
    scene.add(new THREE.LineSegments(lineGeom, new THREE.LineBasicMaterial({ color: 0xe5484d, depthTest: false, transparent: true })))

    const dotGeom = new THREE.CircleGeometry(3 * pxToWorld, 16)
    const dot = new THREE.Mesh(dotGeom, new THREE.MeshBasicMaterial({ color: 0xe5484d, depthTest: false, transparent: true }))
    dot.position.set(center.x, center.y, 0.71)
    scene.add(dot)
  }

  const PIXEL_FRAME_COLOR = 0xffa033
  const PIXEL_FRAME_COLOR_CSS = '#ffa033'

  function gcd(a: number, b: number): number {
    a = Math.abs(a)
    b = Math.abs(b)
    while (b) {
      ;[a, b] = [b, a % b]
    }
    return a || 1
  }

  /** "PIXEL FRAME" + the frame's aspect ratio, drawn just above its top-left corner. The ratio is
   *  Pixel Preview's actual output pixel dimensions (see `PixelPreview.tsx`'s `canvasW`/`canvasH`
   *  derivation, mirrored here) reduced by their GCD — e.g. a wide frame at the default 128
   *  resolution reads "16:9" rather than the raw (and generally non-integer) world-space
   *  `width`/`height` ratio, since that's the ratio that actually matters for the exported art. */
  function addPixelFrameLabel(scene: THREE.Scene, frame: PixelFrame) {
    const res = useSceneStore.getState().pixelPreviewResolution
    const canvasW = frame.width >= frame.height ? res : Math.max(1, Math.round((res * frame.width) / frame.height))
    const canvasH = frame.height > frame.width ? res : Math.max(1, Math.round((res * frame.height) / frame.width))
    const divisor = gcd(canvasW, canvasH)
    const text = `PIXEL FRAME   ${canvasW / divisor}:${canvasH / divisor}`

    const RESOLUTION_SCALE = 3
    const fontSizeOnScreen = 13
    const fontSize = fontSizeOnScreen * RESOLUTION_SCALE
    const fontFamily = "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" // matches body { font-family } in style.css
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')!
    ctx.font = `600 ${fontSize}px ${fontFamily}`
    const textWidth = ctx.measureText(text).width
    canvas.width = Math.ceil(textWidth)
    canvas.height = Math.ceil(fontSize * 1.4)
    ctx.font = `600 ${fontSize}px ${fontFamily}`
    ctx.fillStyle = PIXEL_FRAME_COLOR_CSS
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    ctx.fillText(text, 0, canvas.height / 2)

    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true })
    const sprite = new THREE.Sprite(material)
    // anchor at the sprite's bottom-left (rather than the default center) so it's easy to place
    // just above-left of the frame's top-left corner, growing right/up from that point
    sprite.center.set(0, 0)
    const pxToWorld = 1 / viewRef.current.zoom / RESOLUTION_SCALE
    sprite.scale.set(canvas.width * pxToWorld, canvas.height * pxToWorld, 1)
    const gapPx = 4
    sprite.position.set(frame.x - frame.width / 2, frame.y + frame.height / 2 + gapPx / viewRef.current.zoom, 0.9)
    scene.add(sprite)
  }

  /** Pixel Preview's fixed "main render camera" overlay: a dashed rectangle (same style as the
   *  scale-gizmo's bbox outline, just orange instead of blue so it doesn't get confused with the
   *  selected-object gizmo) plus 4 corner resize handles. Body-drag (move) is picked up via the
   *  border line itself, not the interior, so it doesn't steal clicks meant to select/move objects
   *  that happen to sit inside the frame — see `pixelFrameCorners`/hit-testing in the pointerdown
   *  handler. */
  function addPixelFrameGizmo(scene: THREE.Scene, frame: PixelFrame) {
    const pxToWorld = 1 / viewRef.current.zoom
    const corners = pixelFrameCorners(frame)
    const order: Array<keyof typeof corners> = ['bl', 'br', 'tr', 'tl']
    const outlinePositions: number[] = []
    for (let i = 0; i < order.length; i++) {
      const a = corners[order[i]]
      const b = corners[order[(i + 1) % order.length]]
      outlinePositions.push(a.x, a.y, 0.5, b.x, b.y, 0.5)
    }
    const outlineGeom = new THREE.BufferGeometry()
    outlineGeom.setAttribute('position', new THREE.Float32BufferAttribute(outlinePositions, 3))
    const outline = new THREE.LineSegments(
      outlineGeom,
      new THREE.LineDashedMaterial({ color: PIXEL_FRAME_COLOR, dashSize: 6 * pxToWorld, gapSize: 4 * pxToWorld, depthTest: false, transparent: true }),
    )
    outline.computeLineDistances()
    scene.add(outline)

    const handleMat = new THREE.MeshBasicMaterial({ color: PIXEL_FRAME_COLOR, depthTest: false, transparent: true })
    for (const { x, y } of Object.values(corners)) {
      const size = (HANDLE_SIZE * pxToWorld) / 2
      const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), handleMat)
      m.position.set(x, y, 0.6)
      scene.add(m)
    }

    addPixelFrameLabel(scene, frame)
  }

  /** The Pixel Frame's 4 corners in world space, keyed the same way the scale-gizmo's are. */
  function pixelFrameCorners(frame: PixelFrame): Record<'tl' | 'tr' | 'bl' | 'br', Vec2> {
    const left = frame.x - frame.width / 2
    const right = frame.x + frame.width / 2
    const top = frame.y + frame.height / 2
    const bottom = frame.y - frame.height / 2
    return {
      tl: { x: left, y: top },
      tr: { x: right, y: top },
      bl: { x: left, y: bottom },
      br: { x: right, y: bottom },
    }
  }

  /** One edge-midpoint single-axis scale handle: a thin quad centered at `p`, thin along
   *  whichever of `axisX`/`axisY` corresponds to `axisLock` (the axis it scales) and elongated
   *  along the other (the edge direction) — a "bar", not a square, so it reads as 1D. `axisX`/
   *  `axisY` already carry the local-vs-world orientation toggle (see `getGizmoGeom`), so this
   *  handle rotates along with the bbox outline/corner handles with no separate logic. */
  function addEdgeScaleHandle(
    scene: THREE.Scene,
    p: { x: number; y: number },
    axisLock: 'x' | 'y',
    axisX: { x: number; y: number },
    axisY: { x: number; y: number },
    pxToWorld: number,
    mat: THREE.Material,
  ) {
    const thin = 2 * pxToWorld
    const long = 5 * pxToWorld
    const scaleAxis = axisLock === 'x' ? axisX : axisY
    const edgeAxis = axisLock === 'x' ? axisY : axisX
    const corners = [
      { x: p.x + scaleAxis.x * thin + edgeAxis.x * long, y: p.y + scaleAxis.y * thin + edgeAxis.y * long },
      { x: p.x - scaleAxis.x * thin + edgeAxis.x * long, y: p.y - scaleAxis.y * thin + edgeAxis.y * long },
      { x: p.x - scaleAxis.x * thin - edgeAxis.x * long, y: p.y - scaleAxis.y * thin - edgeAxis.y * long },
      { x: p.x + scaleAxis.x * thin - edgeAxis.x * long, y: p.y + scaleAxis.y * thin - edgeAxis.y * long },
    ]
    const positions: number[] = []
    for (const c of corners) positions.push(c.x, c.y, 0.6)
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    // swapping which of axisX/axisY is `scaleAxis` vs `edgeAxis` between the 'x'/'y' cases mirrors
    // the basis, which flips this quad's winding — without correcting for it, MeshBasicMaterial's
    // default backface culling makes the 'y'-locked (top/bottom) handles invisible while the
    // 'x'-locked (left/right) ones render fine.
    geom.setIndex(axisLock === 'x' ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2])
    scene.add(new THREE.Mesh(geom, mat))
  }

  function addGizmo(scene: THREE.Scene, obj: SceneObject) {
    const { center, ringRadius, arrowLength, axisX, axisY, corners, edgeHandles } = getGizmoGeom(obj)
    const pxToWorld = 1 / viewRef.current.zoom

    // dashed bbox outline connecting the corners in winding order (bl -> br -> tr -> tl -> bl)
    const byKey = Object.fromEntries(corners.map((c) => [c.key, c]))
    const order: Array<'bl' | 'br' | 'tr' | 'tl'> = ['bl', 'br', 'tr', 'tl']
    const outlinePositions: number[] = []
    for (let i = 0; i < order.length; i++) {
      const a = byKey[order[i]]
      const b = byKey[order[(i + 1) % order.length]]
      outlinePositions.push(a.x, a.y, 0.5, b.x, b.y, 0.5)
    }
    const outlineGeom = new THREE.BufferGeometry()
    outlineGeom.setAttribute('position', new THREE.Float32BufferAttribute(outlinePositions, 3))
    const outlineMat = new THREE.LineDashedMaterial({
      color: 0x4ea1ff,
      dashSize: 6 * pxToWorld,
      gapSize: 4 * pxToWorld,
      depthTest: false,
      transparent: true,
    })
    const outline = new THREE.LineSegments(outlineGeom, outlineMat)
    outline.computeLineDistances()
    scene.add(outline)

    // corner handles for free (non-axis-locked) scale
    const handleMat = new THREE.MeshBasicMaterial({ color: 0x4ea1ff, depthTest: false, transparent: true })
    for (const { x, y } of corners) {
      const size = (HANDLE_SIZE * pxToWorld) / 2
      const geom = new THREE.PlaneGeometry(size, size)
      const m = new THREE.Mesh(geom, handleMat)
      m.position.set(x, y, 0.6)
      scene.add(m)
    }

    // edge-midpoint handles for single-axis scale — a thin bar straddling the edge (elongated
    // along the edge, thin along the axis it scales) rather than a square, so their shape alone
    // hints "this one moves along a line" vs. the corners' "this one moves freely"
    for (const eh of edgeHandles) {
      addEdgeScaleHandle(scene, eh, eh.axisLock, axisX, axisY, pxToWorld, handleMat)
    }

    // rotate ring
    const ringGeom = new THREE.RingGeometry(
      ringRadius - 1 * pxToWorld,
      ringRadius + 1 * pxToWorld,
      48,
    )
    const ringMesh = new THREE.Mesh(ringGeom, new THREE.MeshBasicMaterial({ color: 0xffaa33, depthTest: false, transparent: true }))
    ringMesh.position.set(center.x, center.y, 0.55)
    scene.add(ringMesh)

    // axis move arrows (red = local X, green = local Y)
    addAxisArrow(scene, center, axisX, arrowLength, pxToWorld, 0xe5484d)
    addAxisArrow(scene, center, axisY, arrowLength, pxToWorld, 0x4ec96a)

    // head/tail reference rings (hollow circles, not draggable here — switch to pivot mode to
    // relocate them). Hollow rather than filled so they don't read as clickable handles in this mode.
    const headRefGeom = new THREE.RingGeometry(2 * pxToWorld, 3 * pxToWorld, 16)
    const headRefDot = new THREE.Mesh(headRefGeom, new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true }))
    headRefDot.position.set(center.x, center.y, 0.65)
    scene.add(headRefDot)

    const worldTransform = getWorldTransform(obj, useSceneStore.getState().objects)
    const tailWorld = getWorldTail(obj, worldTransform)
    const tailRefGeom = new THREE.RingGeometry(2 * pxToWorld, 3 * pxToWorld, 16)
    const tailRefDot = new THREE.Mesh(tailRefGeom, new THREE.MeshBasicMaterial({ color: 0xff3fb4, depthTest: false, transparent: true }))
    tailRefDot.position.set(tailWorld.x, tailWorld.y, 0.65)
    scene.add(tailRefDot)
  }

  /** Pivot-mode-only overlay: head (white) and tail (magenta) dots, draggable here only — see
   *  the `mode === 'pivot'` hit-tests in handlePointerDown. Kept out of the object-mode BBox
   *  gizmo so head/tail can't be relocated by accident while just moving/rotating an object. */
  /** Renders a mesh-less Empty as a small screen-space-constant cross, always visible (not just
   *  when selected) since it has no silhouette of its own to click on otherwise. */
  function addEmptyGizmo(group: THREE.Group, worldTransform: ReturnType<typeof getWorldTransform>, isSelected: boolean) {
    const pxToWorld = 1 / viewRef.current.zoom
    const size = EMPTY_GIZMO_SIZE * pxToWorld
    const color = isSelected ? 0xffaa33 : 0x4ea1ff
    const positions = [-size, 0, 0, size, 0, 0, 0, -size, 0, 0, size, 0]
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    const mat = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true })
    const cross = new THREE.LineSegments(geom, mat)
    cross.position.set(worldTransform.x, worldTransform.y, 0.5)
    group.add(cross)

    const ringGeom = new THREE.RingGeometry(size * 0.3, size * 0.4, 16)
    const ring = new THREE.Mesh(ringGeom, new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true }))
    ring.position.set(worldTransform.x, worldTransform.y, 0.5)
    group.add(ring)
  }

  function addPivotHandles(scene: THREE.Scene, obj: SceneObject) {
    const { center } = getGizmoGeom(obj)
    const pxToWorld = 1 / viewRef.current.zoom

    const headDotGeom = new THREE.CircleGeometry(HEAD_DOT_RADIUS_PX * pxToWorld, 16)
    const headDot = new THREE.Mesh(headDotGeom, new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true }))
    headDot.position.set(center.x, center.y, 0.66)
    scene.add(headDot)

    const worldTransform = getWorldTransform(obj, useSceneStore.getState().objects)
    const tailWorld = getWorldTail(obj, worldTransform)
    addTailReticle(scene, tailWorld, pxToWorld)
  }

  /** Tail's pivot-mode handle: a hollow ring + crosshair, visibly bigger than Head's small filled
   *  dot — see `TAIL_RING_OUTER_RADIUS_PX`'s doc for why the shape (not just the color) needs to
   *  differ. */
  function addTailReticle(scene: THREE.Scene, worldPos: Vec2, pxToWorld: number) {
    const color = 0xff3fb4
    const mat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true })
    const ringGeom = new THREE.RingGeometry(
      (TAIL_RING_OUTER_RADIUS_PX - 1) * pxToWorld,
      TAIL_RING_OUTER_RADIUS_PX * pxToWorld,
      24,
    )
    const ring = new THREE.Mesh(ringGeom, mat)
    ring.position.set(worldPos.x, worldPos.y, 0.66)
    scene.add(ring)

    const armLen = TAIL_CROSSHAIR_HALF_LENGTH_PX * pxToWorld
    const crossGeom = new THREE.BufferGeometry()
    crossGeom.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-armLen, 0, 0, armLen, 0, 0, 0, -armLen, 0, 0, armLen, 0], 3),
    )
    const cross = new THREE.LineSegments(crossGeom, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }))
    cross.position.set(worldPos.x, worldPos.y, 0.66)
    scene.add(cross)
  }

  function addAxisArrow(
    scene: THREE.Scene,
    center: { x: number; y: number },
    dir: { x: number; y: number },
    length: number,
    pxToWorld: number,
    color: number,
  ) {
    const tip = { x: center.x + dir.x * length, y: center.y + dir.y * length }

    // thick quad shaft (LineBasicMaterial linewidth is ignored by WebGL)
    const shaftHalfWidth = 1.8 * pxToWorld
    const perpShaft = { x: -dir.y, y: dir.x }
    const shaftGeom = new THREE.BufferGeometry()
    shaftGeom.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [
          center.x + perpShaft.x * shaftHalfWidth, center.y + perpShaft.y * shaftHalfWidth, 0.55,
          center.x - perpShaft.x * shaftHalfWidth, center.y - perpShaft.y * shaftHalfWidth, 0.55,
          tip.x - perpShaft.x * shaftHalfWidth, tip.y - perpShaft.y * shaftHalfWidth, 0.55,
          tip.x + perpShaft.x * shaftHalfWidth, tip.y + perpShaft.y * shaftHalfWidth, 0.55,
        ],
        3,
      ),
    )
    shaftGeom.setIndex([0, 1, 2, 0, 2, 3])
    scene.add(new THREE.Mesh(shaftGeom, new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true })))

    const headLen = 12 * pxToWorld
    const headWidth = 6 * pxToWorld
    const perp = { x: -dir.y, y: dir.x }
    const base = { x: tip.x - dir.x * headLen, y: tip.y - dir.y * headLen }
    const headGeom = new THREE.BufferGeometry()
    headGeom.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [
          tip.x, tip.y, 0.55,
          base.x + perp.x * headWidth, base.y + perp.y * headWidth, 0.55,
          base.x - perp.x * headWidth, base.y - perp.y * headWidth, 0.55,
        ],
        3,
      ),
    )
    const head = new THREE.Mesh(headGeom, new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true }))
    scene.add(head)
  }

  function getWorldPos(e: PointerEvent) {
    const rect = containerRef.current!.getBoundingClientRect()
    return screenToWorld(e.clientX, e.clientY, rect, viewRef.current)
  }

  function pxDistSq(ax: number, ay: number, bx: number, by: number) {
    const dx = (ax - bx) * viewRef.current.zoom
    const dy = (ay - by) * viewRef.current.zoom
    return dx * dx + dy * dy
  }

  /** Distance in px from world point p to world segment (a,b). */
  function pxDistToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
    const zoom = viewRef.current.zoom
    const Px = px * zoom, Py = py * zoom
    const Ax = ax * zoom, Ay = ay * zoom
    const Bx = bx * zoom, By = by * zoom
    const dx = Bx - Ax
    const dy = By - Ay
    const lenSq = dx * dx + dy * dy
    let t = lenSq > 0 ? ((Px - Ax) * dx + (Py - Ay) * dy) / lenSq : 0
    t = Math.max(0, Math.min(1, t))
    const cx = Ax + t * dx
    const cy = Ay + t * dy
    return Math.hypot(Px - cx, Py - cy)
  }

  /** Like pxDistToSegment but also returns the (clamped) projection parameter along the segment. */
  function pxDistToSegmentWithT(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
    const zoom = viewRef.current.zoom
    const Px = px * zoom, Py = py * zoom
    const Ax = ax * zoom, Ay = ay * zoom
    const Bx = bx * zoom, By = by * zoom
    const dx = Bx - Ax
    const dy = By - Ay
    const lenSq = dx * dx + dy * dy
    let t = lenSq > 0 ? ((Px - Ax) * dx + (Py - Ay) * dy) / lenSq : 0
    t = Math.max(0, Math.min(1, t))
    const cx = Ax + t * dx
    const cy = Ay + t * dy
    return { dist: Math.hypot(Px - cx, Py - cy), t }
  }

  /** Find the nearest mesh edge to the cursor and trace the quad loop running through it. */
  function updateLoopCutHover(e: PointerEvent) {
    const store = useSceneStore.getState()
    const obj = store.objects.find((o) => o.id === store.selectedObjectId)
    if (store.mode !== 'edit' || store.activeTool !== 'loopcut' || !obj) {
      loopCutHoverRef.current = null
      return
    }
    const worldTransform = getWorldTransform(obj, store.objects)
    const world = getWorldPos(e)
    const locked = getLockedVertices(obj)
    let bestA = -1
    let bestB = -1
    let bestT = 0
    let bestDist = Infinity
    for (const [a, b] of getEdges(obj.mesh)) {
      if (locked.has(a)) continue
      const va = applyTransform(obj.mesh.vertices[a], worldTransform)
      const vb = applyTransform(obj.mesh.vertices[b], worldTransform)
      const { dist, t } = pxDistToSegmentWithT(world.x, world.y, va.x, va.y, vb.x, vb.y)
      if (dist < bestDist) {
        bestDist = dist
        bestA = a
        bestB = b
        bestT = t
      }
    }

    const prev = loopCutHoverRef.current
    let next: LoopCutHover | null = null
    if (bestDist < 40) {
      const path = findFullLoop(obj.mesh, bestA, bestB)
      if (path) {
        // path.cuts[0] is oriented to the *face's* natural winding, which may be reversed
        // relative to (bestA, bestB) — recompute t against that same orientation so the
        // preview always advances the same way the cursor does, regardless of which way
        // getEdges happened to sort this particular edge's vertex indices.
        const [ca, cb] = path.cuts[0]
        const va2 = applyTransform(obj.mesh.vertices[ca], worldTransform)
        const vb2 = applyTransform(obj.mesh.vertices[cb], worldTransform)
        const { t } = pxDistToSegmentWithT(world.x, world.y, va2.x, va2.y, vb2.x, vb2.y)
        next = { edgeA: bestA, edgeB: bestB, t, path }
      }
    }
    if (!next || !prev || next.edgeA !== prev.edgeA || next.edgeB !== prev.edgeB) {
      loopCutCountRef.current = 1
    }
    loopCutHoverRef.current = next
  }

  /** Find the nearest spoke (center-to-rim edge) of a triangle fan to the cursor, and trace the
   *  full fan it belongs to. A "spoke" is identified by degree alone — the fan center has one
   *  edge per surrounding triangle (much higher degree than an ordinary rim vertex's 3), so an
   *  edge whose two endpoints have equal degree is a rim-to-rim boundary edge, not a spoke, and
   *  is skipped. */
  function updateRingCutHover(e: PointerEvent) {
    const store = useSceneStore.getState()
    const obj = store.objects.find((o) => o.id === store.selectedObjectId)
    if (store.mode !== 'edit' || store.activeTool !== 'ringcut' || !obj) {
      ringCutHoverRef.current = null
      return
    }
    const worldTransform = getWorldTransform(obj, store.objects)
    const world = getWorldPos(e)
    const locked = getLockedVertices(obj)
    const edges = getEdges(obj.mesh)
    const degree = new Map<number, number>()
    for (const [a, b] of edges) {
      degree.set(a, (degree.get(a) ?? 0) + 1)
      degree.set(b, (degree.get(b) ?? 0) + 1)
    }

    let bestCenter = -1
    let bestRim = -1
    let bestDist = Infinity
    for (const [a, b] of edges) {
      if (locked.has(a) || locked.has(b)) continue
      const da = degree.get(a) ?? 0
      const db = degree.get(b) ?? 0
      if (da === db) continue // rim-to-rim boundary edge, not a spoke
      const [center, rim] = da > db ? [a, b] : [b, a]
      const va = applyTransform(obj.mesh.vertices[center], worldTransform)
      const vb = applyTransform(obj.mesh.vertices[rim], worldTransform)
      const dist = pxDistToSegment(world.x, world.y, va.x, va.y, vb.x, vb.y)
      if (dist < bestDist) {
        bestDist = dist
        bestCenter = center
        bestRim = rim
      }
    }

    const prev = ringCutHoverRef.current
    let next: RingCutHover | null = null
    if (bestDist < 40) {
      const path = findFan(obj.mesh, bestCenter, bestRim)
      if (path) {
        const vCenter = applyTransform(obj.mesh.vertices[bestCenter], worldTransform)
        const vRim = applyTransform(obj.mesh.vertices[bestRim], worldTransform)
        const { t } = pxDistToSegmentWithT(world.x, world.y, vCenter.x, vCenter.y, vRim.x, vRim.y)
        next = { center: bestCenter, hoverRim: bestRim, t, path }
      }
    }
    if (!next || !prev || next.center !== prev.center) {
      ringCutCountRef.current = 1
    }
    ringCutHoverRef.current = next
  }

  /** Find the nearest existing vertex, falling back to the nearest point on an existing edge. */
  function updateKnifeHover(e: PointerEvent) {
    const store = useSceneStore.getState()
    const obj = store.objects.find((o) => o.id === store.selectedObjectId)
    if (store.mode !== 'edit' || store.activeTool !== 'knife' || !obj) {
      knifeHoverRef.current = null
      return
    }
    const worldTransform = getWorldTransform(obj, store.objects)
    const world = getWorldPos(e)
    const zoom = viewRef.current.zoom
    const locked = getLockedVertices(obj)

    let bestVertex = -1
    let bestVertexDist = Infinity
    obj.mesh.vertices.forEach((v, i) => {
      if (locked.has(i)) return
      const p = applyTransform(v, worldTransform)
      const dist = Math.hypot((world.x - p.x) * zoom, (world.y - p.y) * zoom)
      if (dist < bestVertexDist) {
        bestVertexDist = dist
        bestVertex = i
      }
    })
    if (bestVertexDist < VERTEX_HIT_RADIUS) {
      knifeHoverRef.current = { type: 'vertex', index: bestVertex }
      return
    }

    let bestA = -1
    let bestB = -1
    let bestT = 0
    let bestDist = Infinity
    for (const [a, b] of getEdges(obj.mesh)) {
      if (locked.has(a)) continue
      const va = applyTransform(obj.mesh.vertices[a], worldTransform)
      const vb = applyTransform(obj.mesh.vertices[b], worldTransform)
      const { dist, t } = pxDistToSegmentWithT(world.x, world.y, va.x, va.y, vb.x, vb.y)
      if (dist < bestDist) {
        bestDist = dist
        bestA = a
        bestB = b
        bestT = t
      }
    }
    knifeHoverRef.current = bestDist < 20 ? { type: 'edge', a: bestA, b: bestB, t: bestT } : null
  }

  /** While adding a primitive as an island (activeTool === 'place-rect'/'place-circle'),
   *  track where it would land (in the edited object's local space) under the cursor. */
  function updatePlacePreview(e: PointerEvent) {
    const store = useSceneStore.getState()
    const obj = store.objects.find((o) => o.id === store.selectedObjectId)
    const placing = store.activeTool === 'place-rect' || store.activeTool === 'place-circle'
    if (store.mode !== 'edit' || !obj || !placing) {
      placePreviewRef.current = null
      return
    }
    placePreviewRef.current = inverseTransform(getWorldPos(e), getWorldTransform(obj, store.objects))
  }

  function handlePointerDown(e: PointerEvent) {
    // middle-click (the wheel button) drags to pan; Alt is free for other uses (e.g. Blender-
    // style edge-loop select in edge mode, or unclamping the rail during vertex-slide)
    if (e.button === 1) {
      e.preventDefault() // stop native middle-click auto-scroll from hijacking pointer events
      dragRef.current = {
        kind: 'pan',
        startClientX: e.clientX,
        startClientY: e.clientY,
        startPan: { x: viewRef.current.panX, y: viewRef.current.panY },
      }
      return
    }
    if (e.button !== 0) return

    // a left-click while a G/R/S modal transform is running confirms it (Blender-style)
    if (elementModalRef.current) {
      confirmElementModal()
      return
    }

    // a left-click while placing a primitive island confirms it at the previewed position
    {
      const s = useSceneStore.getState()
      if (s.mode === 'edit' && (s.activeTool === 'place-rect' || s.activeTool === 'place-circle')) {
        const obj = s.objects.find((o) => o.id === s.selectedObjectId)
        const at = placePreviewRef.current
        if (obj && at && s.pendingPrimitive) {
          if (s.pendingPrimitive.kind === 'rect') {
            const p = s.pendingPrimitive
            s.addRectIsland(obj.id, at, p.width, p.height, p.segX, p.segY)
          } else {
            const p = s.pendingPrimitive
            s.addCircleIsland(obj.id, at, p.radius, p.segments)
          }
        }
        s.setActiveTool('select')
        s.setPendingPrimitive(null)
        placePreviewRef.current = null
        return
      }
    }

    // Hair Path: click adds a new control point, unless the click lands on an already-placed
    // one — in which case it starts dragging that point instead (works in either app mode; the
    // path itself is target-agnostic until Enter confirms it, see finalizeHairPath)
    if (useSceneStore.getState().activeTool === 'place-hairpath') {
      const world = getWorldPos(e)
      const path = hairPathRef.current
      const hitIndex = path.findIndex((p) => pxDistSq(world.x, world.y, p.x, p.y) < HAIR_PATH_CP_HIT_RADIUS_PX ** 2)
      if (hitIndex >= 0) {
        dragRef.current = { kind: 'move-hairpath-cp', index: hitIndex }
      } else {
        hairPathRef.current = [...path, world]
      }
      return
    }

    // Path: identical click-to-add/click-to-drag flow as Hair Path above, just without a width
    if (useSceneStore.getState().activeTool === 'place-path') {
      const world = getWorldPos(e)
      const path = pathDrawRef.current
      const hitIndex = path.findIndex((p) => pxDistSq(world.x, world.y, p.x, p.y) < HAIR_PATH_CP_HIT_RADIUS_PX ** 2)
      if (hitIndex >= 0) {
        dragRef.current = { kind: 'move-path-cp', index: hitIndex }
      } else {
        pathDrawRef.current = [...path, world]
      }
      return
    }

    const store0 = useSceneStore.getState()
    if (store0.mode === 'edit' && store0.activeTool === 'knife') {
      const hover = knifeHoverRef.current
      if (hover) {
        const path = knifePathRef.current
        if (path.length === 0 || !knifePointsEqual(path[path.length - 1], hover)) {
          knifePathRef.current = [...path, hover]
        }
      }
      return
    }
    if (store0.mode === 'edit' && store0.activeTool === 'loopcut') {
      const hover = loopCutHoverRef.current
      if (hover && store0.selectedObjectId) {
        store0.applyLoopCut(store0.selectedObjectId, hover.edgeA, hover.edgeB, loopCutTs())
        store0.setActiveTool('select')
        loopCutHoverRef.current = null
        loopCutCountRef.current = 1
      }
      return
    }
    if (store0.mode === 'edit' && store0.activeTool === 'ringcut') {
      const hover = ringCutHoverRef.current
      if (hover && store0.selectedObjectId) {
        store0.applyRingCut(store0.selectedObjectId, hover.center, hover.hoverRim, ringCutTs())
        store0.setActiveTool('select')
        ringCutHoverRef.current = null
        ringCutCountRef.current = 1
      }
      return
    }

    const world = getWorldPos(e)
    const { objects, selectedObjectId, mode, editElementType, editingShapeKeyId, pixelFrame } = useSceneStore.getState()
    const rawSelectedObj = objects.find((o) => o.id === selectedObjectId) || null
    const selectedObj = rawSelectedObj && getEffectiveObj(rawSelectedObj, editingShapeKeyId, true)

    // Pixel Frame (Pixel Preview's fixed "main render camera"): checked before anything
    // mode/selection-specific, since it's a scene-wide overlay independent of both. Corners
    // resize; only the border *line* moves the whole frame (not the interior), so it doesn't
    // steal clicks meant to select/move objects that happen to sit inside it.
    if (pixelFrame) {
      const corners = pixelFrameCorners(pixelFrame)
      for (const key of ['tl', 'tr', 'bl', 'br'] as const) {
        const c = corners[key]
        if (pxDistSq(world.x, world.y, c.x, c.y) < HANDLE_SIZE ** 2) {
          dragRef.current = { kind: 'resize-pixel-frame', corner: key, startFrame: pixelFrame }
          return
        }
      }
      const edges: Array<[Vec2, Vec2]> = [
        [corners.bl, corners.br],
        [corners.br, corners.tr],
        [corners.tr, corners.tl],
        [corners.tl, corners.bl],
      ]
      for (const [a, b] of edges) {
        if (pxDistToSegment(world.x, world.y, a.x, a.y, b.x, b.y) < GIZMO_HIT_TOLERANCE) {
          dragRef.current = { kind: 'move-pixel-frame', startWorld: world, startFrame: pixelFrame }
          return
        }
      }
    }

    // sculpting an Arc-mode shape key: its pivot handle (drawn in rebuildScene) is draggable,
    // checked before the normal edit-mode vertex/edge/face hit-tests below so it takes priority
    if (mode === 'edit' && rawSelectedObj && editingShapeKeyId) {
      const editingKey = rawSelectedObj.shapeKeys?.find((k) => k.id === editingShapeKeyId)
      if (editingKey?.interpolation === 'arc') {
        const worldTransform = getWorldTransform(rawSelectedObj, objects)
        const pivotLocal = editingKey.arcPivot ?? rawSelectedObj.transform.head
        const pivotWorld = applyTransform(pivotLocal, worldTransform)
        if (pxDistSq(world.x, world.y, pivotWorld.x, pivotWorld.y) < (GIZMO_HIT_TOLERANCE * 1.5) ** 2) {
          useSceneStore.getState().beginChange()
          dragRef.current = { kind: 'move-shapekey-arc-pivot', objectId: rawSelectedObj.id, keyId: editingKey.id }
          return
        }
      }
    }

    // an already-confirmed Path's control points, in Edit mode: click-drag an existing one to
    // reposition it (right-click one instead to delete it — see `onMouseDown`'s doc below); click
    // the curve line itself to insert a new point there; both checked before the generic
    // edit-mode vertex/edge/face hit-tests below, since a Path has no faces for those to find
    // anything in.
    if (mode === 'edit' && rawSelectedObj?.kind === 'path') {
      const worldTransform = getWorldTransform(rawSelectedObj, objects)
      const worldPoints = rawSelectedObj.mesh.vertices.map((v) => applyTransform(v, worldTransform))
      const hitIndex = worldPoints.findIndex((p) => pxDistSq(world.x, world.y, p.x, p.y) < HAIR_PATH_CP_HIT_RADIUS_PX ** 2)
      if (hitIndex >= 0) {
        useSceneStore.getState().beginChange()
        dragRef.current = { kind: 'move-path-point', objectId: rawSelectedObj.id, index: hitIndex }
        return
      }
      const samples = evaluatePathCurve(worldPoints, 12, rawSelectedObj.closed)
      for (let i = 0; i < samples.length - 1; i++) {
        if (pxDistToSegment(world.x, world.y, samples[i].x, samples[i].y, samples[i + 1].x, samples[i + 1].y) < GIZMO_HIT_TOLERANCE) {
          const insertIndex = nearestSegmentInsertIndex(worldPoints, world, rawSelectedObj.closed)
          useSceneStore.getState().insertPathPoint(rawSelectedObj.id, insertIndex, inverseTransform(world, worldTransform))
          return
        }
      }
    }

    // Fake Flag's direction-handle ring (drawn in rebuildScene) — draggable in any mode whenever
    // it's shown, so it takes priority right after the (edit-mode-only) Arc pivot check above.
    // Grabbable anywhere on the ring's circumference, Blender-rotate-gizmo style, not just at the
    // current-angle marker dot.
    const selectedFakeFlag = rawSelectedObj ? getFakeFlag(rawSelectedObj) : undefined
    if (rawSelectedObj && selectedFakeFlag?.enabled) {
      const activeClip = useSceneStore.getState().clips.find((c) => c.id === useSceneStore.getState().activeClipId)
      const fakeFlagTime = useSceneStore.getState().previewFakeFlag ? performance.now() / 1000 : useSceneStore.getState().playheadTime
      const handle = getFakeFlagDirectionHandle(rawSelectedObj, fakeFlagTime, activeClip?.duration ?? 0)
      const distFromAnchorPx = handle ? Math.hypot(world.x - handle.anchorWorld.x, world.y - handle.anchorWorld.y) * viewRef.current.zoom : Infinity
      if (handle && Math.abs(distFromAnchorPx - FAKE_FLAG_RING_RADIUS_PX) < GIZMO_HIT_TOLERANCE) {
        useSceneStore.getState().beginChange()
        dragRef.current = {
          kind: 'move-fake-flag-direction',
          objectId: rawSelectedObj.id,
          startDirection: selectedFakeFlag.direction,
          startAngle: Math.atan2(world.y - handle.anchorWorld.y, world.x - handle.anchorWorld.x),
        }
        return
      }
    }

    // pivot mode: head/tail dots are the only draggable handles here (no move/rotate/scale gizmo
    // is rendered in this mode, so there's nothing else to hit-test against). A Path's Head/Tail
    // are ordinary, freely-draggable pivots here just like any other object's — they're no longer
    // derived from its control points (see project spec: that auto-sync was removed since forcing
    // Head to double as "the curve's start point" caused the whole path to visibly jump whenever
    // Edit mode was exited, since Head also doubles as the render pivot).
    if (mode === 'pivot' && selectedObj) {
      const selectedWorldTransform = getWorldTransform(selectedObj, objects)
      const { center } = getGizmoGeom(selectedObj)

      // Head is checked first with the smaller radius — see `TAIL_HIT_RADIUS_PX`'s doc: this is
      // what makes a dead-center click resolve to Head even though both default to the same spot,
      // while Tail's larger radius still gets its own clickable ring around that shared center.
      if (pxDistSq(world.x, world.y, center.x, center.y) < HEAD_HIT_RADIUS_PX ** 2) {
        useSceneStore.getState().beginChange()
        dragRef.current = { kind: 'move-head', objectId: selectedObj.id }
        return
      }

      const tailWorld = getWorldTail(selectedObj, selectedWorldTransform)
      if (pxDistSq(world.x, world.y, tailWorld.x, tailWorld.y) < TAIL_HIT_RADIUS_PX ** 2) {
        useSceneStore.getState().beginChange()
        dragRef.current = { kind: 'move-tail', objectId: selectedObj.id }
        return
      }
    }

    if (mode === 'object' && selectedObj) {
      const selectedWorldTransform = getWorldTransform(selectedObj, objects)
      const { center, ringRadius, arrowLength, axisX, axisY, corners, edgeHandles } = getGizmoGeom(selectedObj)

      // rotate ring: distance from center close to ringRadius
      const distFromCenter = Math.hypot(world.x - center.x, world.y - center.y) * viewRef.current.zoom
      if (Math.abs(distFromCenter - ringRadius * viewRef.current.zoom) < GIZMO_HIT_TOLERANCE) {
        useSceneStore.getState().beginChange()
        dragRef.current = {
          kind: 'rotate-object',
          objectId: selectedObj.id,
          startRotation: selectedWorldTransform.rotation,
          startAngle: Math.atan2(world.y - center.y, world.x - center.x),
          center,
          parentWorldRotation: getParentWorldTransform(selectedObj, objects).transform.rotation,
        }
        return
      }

      // axis move arrows (local X = red, local Y = green) — a connected child's position is
      // forced to the parent's tail, so moving it via these handles would be silently overridden;
      // skip starting the drag entirely rather than leaving the handle visually live but inert.
      const isConnectedChild = selectedObj.connected && selectedObj.parentId !== null
      // an Empty has no silhouette of its own to free-drag from, so its entire "body" is this
      // tiny gizmo, which the arrows pass straight through — without this, every click near it
      // would be swallowed by the axis-arrow hit test below and free (both-axis) dragging would
      // be practically impossible. Mesh objects don't need this: their much larger face area
      // already gives plenty of room to click away from the arrows for a free drag.
      const nearEmptyCenter =
        selectedObj.kind === 'empty' && distFromCenter < EMPTY_HIT_RADIUS_PX
      if (!isConnectedChild && !nearEmptyCenter) {
        for (const axisDir of [axisX, axisY]) {
          const tip = { x: center.x + axisDir.x * arrowLength, y: center.y + axisDir.y * arrowLength }
          const d = pxDistToSegment(world.x, world.y, center.x, center.y, tip.x, tip.y)
          if (d < GIZMO_HIT_TOLERANCE) {
            useSceneStore.getState().beginChange()
            const { transform: parentWorld, tail: parentTail } = getParentWorldTransform(selectedObj, objects)
            dragRef.current = {
              kind: 'move-object-axis',
              objectId: selectedObj.id,
              axisDir,
              startWorld: world,
              startWorldPos: { x: selectedWorldTransform.x, y: selectedWorldTransform.y },
              parentWorld,
              parentTail,
            }
            return
          }
        }
      }

      // corner handles for free (non-axis-locked) scale, anchored at the pivot
      for (const c of corners) {
        if (pxDistSq(world.x, world.y, c.x, c.y) < HANDLE_SIZE ** 2) {
          const meshCorner = inverseTransform({ x: c.x, y: c.y }, selectedWorldTransform)
          const pivot = selectedObj.transform.head
          useSceneStore.getState().beginChange()
          dragRef.current = {
            kind: 'scale-object',
            objectId: selectedObj.id,
            startTransform: { ...selectedObj.transform, head: { ...pivot } },
            meshCornerRel: { x: meshCorner.x - pivot.x, y: meshCorner.y - pivot.y },
            axisLock: null,
          }
          return
        }
      }

      // edge-midpoint handles for single-axis scale, same pivot-anchored math as the corner
      // handles above, just constrained to one axis via `axisLock`
      for (const eh of edgeHandles) {
        if (pxDistSq(world.x, world.y, eh.x, eh.y) < HANDLE_SIZE ** 2) {
          const meshPoint = inverseTransform({ x: eh.x, y: eh.y }, selectedWorldTransform)
          const pivot = selectedObj.transform.head
          useSceneStore.getState().beginChange()
          dragRef.current = {
            kind: 'scale-object',
            objectId: selectedObj.id,
            startTransform: { ...selectedObj.transform, head: { ...pivot } },
            meshCornerRel: { x: meshPoint.x - pivot.x, y: meshPoint.y - pivot.y },
            axisLock: eh.axisLock,
          }
          return
        }
      }
    }

    if (mode === 'edit' && selectedObj && editElementType === 'vertex') {
      const selectedWorldTransform = getWorldTransform(selectedObj, objects)
      const locked = getLockedVertices(selectedObj)
      let hitIndex = -1
      let bestDist = Infinity
      selectedObj.mesh.vertices.forEach((v, i) => {
        if (locked.has(i)) return
        const p = applyTransform(v, selectedWorldTransform)
        const d = pxDistSq(world.x, world.y, p.x, p.y)
        if (d < bestDist) {
          bestDist = d
          hitIndex = i
        }
      })
      const threshold = (VERTEX_HIT_RADIUS) ** 2
      if (hitIndex >= 0 && bestDist < threshold) {
        const store = useSceneStore.getState()
        // shift toggles membership in the existing selection; a plain click always narrows to
        // just this vertex, even if it was already part of a multi-selection (matches edge/face
        // select below, and Blender's plain-click behavior)
        const next = e.shiftKey ? new Set(store.selectedVertices) : new Set<number>()
        if (e.shiftKey && store.selectedVertices.has(hitIndex)) next.delete(hitIndex)
        else next.add(hitIndex)
        store.setSelectedVertices(next)
        dragRef.current = { kind: 'none' }
        return
      }
      if (!e.shiftKey) useSceneStore.getState().setSelectedVertices(new Set())
      dragRef.current = {
        kind: 'box-select',
        objectId: selectedObj.id,
        additive: e.shiftKey,
        startClientX: e.clientX,
        startClientY: e.clientY,
        endClientX: e.clientX,
        endClientY: e.clientY,
      }
      return
    }

    if (mode === 'edit' && selectedObj && editElementType === 'edge') {
      const selectedWorldTransform = getWorldTransform(selectedObj, objects)
      const locked = getLockedVertices(selectedObj)
      let hitKey: string | null = null
      let bestDist = Infinity
      for (const [a, b] of getEdges(selectedObj.mesh)) {
        if (locked.has(a)) continue // an edge's endpoints are always in the same island
        const pa = applyTransform(selectedObj.mesh.vertices[a], selectedWorldTransform)
        const pb = applyTransform(selectedObj.mesh.vertices[b], selectedWorldTransform)
        const d = pxDistToSegment(world.x, world.y, pa.x, pa.y, pb.x, pb.y)
        if (d < bestDist) {
          bestDist = d
          hitKey = edgeKey(a, b)
        }
      }
      if (hitKey && bestDist < VERTEX_HIT_RADIUS) {
        const store = useSceneStore.getState()
        // Blender-style Alt+click: select the whole edge loop running through the clicked edge
        // (findFullLoop already walks exactly that strip, opposite-edge by opposite-edge — see
        // its doc comment — so its `cuts` are precisely the loop's edges, not new cut targets)
        // Cmd/Ctrl+click instead selects the true Blender "Edge Loop" — edges connected end-to-
        // end through 4-valent vertices, which for an ordinary grid runs along the clicked edge's
        // own direction rather than across it.
        if (e.altKey || e.ctrlKey || e.metaKey) {
          const [ha, hb] = parseEdgeKey(hitKey)
          const loopKeys = e.altKey
            ? (findFullLoop(selectedObj.mesh, ha, hb)?.cuts.map(([x, y]) => edgeKey(x, y)) ?? [hitKey])
            : findEdgeLoop(selectedObj.mesh, ha, hb)
          const next = e.shiftKey ? new Set(store.selectedEdges) : new Set<string>()
          for (const k of loopKeys) next.add(k)
          store.setSelectedEdges(next)
          dragRef.current = { kind: 'none' }
          return
        }
        const already = store.selectedEdges.has(hitKey)
        const next = e.shiftKey ? new Set(store.selectedEdges) : new Set<string>()
        if (e.shiftKey && already) next.delete(hitKey)
        else next.add(hitKey)
        store.setSelectedEdges(next)
        dragRef.current = { kind: 'none' }
        return
      }
      if (!e.shiftKey) useSceneStore.getState().setSelectedEdges(new Set())
      dragRef.current = {
        kind: 'box-select',
        objectId: selectedObj.id,
        additive: e.shiftKey,
        startClientX: e.clientX,
        startClientY: e.clientY,
        endClientX: e.clientX,
        endClientY: e.clientY,
      }
      return
    }

    if (mode === 'edit' && selectedObj && editElementType === 'face') {
      const local = inverseTransform(world, getWorldTransform(selectedObj, objects))
      const locked = getLockedVertices(selectedObj)
      let hitFace = -1
      selectedObj.mesh.faces.forEach((face, fi) => {
        if (face.some((i) => locked.has(i))) return
        if (hitFace === -1 && pointInPolygon(local, face.map((i) => selectedObj.mesh.vertices[i]))) {
          hitFace = fi
        }
      })
      if (hitFace >= 0) {
        const store = useSceneStore.getState()
        const already = store.selectedFaces.has(hitFace)
        const next = e.shiftKey ? new Set(store.selectedFaces) : new Set<number>()
        if (e.shiftKey && already) next.delete(hitFace)
        else next.add(hitFace)
        store.setSelectedFaces(next)
        dragRef.current = { kind: 'none' }
        return
      }
      if (!e.shiftKey) useSceneStore.getState().setSelectedFaces(new Set())
      dragRef.current = {
        kind: 'box-select',
        objectId: selectedObj.id,
        additive: e.shiftKey,
        startClientX: e.clientX,
        startClientY: e.clientY,
        endClientX: e.clientX,
        endClientY: e.clientY,
      }
      return
    }

    // object picking via raycast (object mode only)
    if (mode === 'object') {
      const picked = pickObject(e)
      useSceneStore.getState().selectObject(picked)
      if (picked) {
        const obj = objects.find((o) => o.id === picked)!
        // a connected child's position is forced to the parent's tail — free-drag-to-move would
        // be silently overridden, so don't even start the drag (selection still happens above)
        if (!(obj.connected && obj.parentId !== null)) {
          useSceneStore.getState().beginChange()
          const objWorldTransform = getWorldTransform(obj, objects)
          const { transform: parentWorld, tail: parentTail } = getParentWorldTransform(obj, objects)
          dragRef.current = {
            kind: 'move-object',
            objectId: picked,
            startWorld: world,
            startWorldPos: { x: objWorldTransform.x, y: objWorldTransform.y },
            parentWorld,
            parentTail,
          }
        }
      }
    }
  }

  function pickObject(e: PointerEvent): string | null {
    const { objects } = useSceneStore.getState()
    const sorted = [...objects].filter((o) => o.visible).sort((a, b) => b.zOrder - a.zOrder)
    const world = getWorldPos(e)
    for (const obj of sorted) {
      const worldTransform = getWorldTransform(obj, objects)
      if (obj.kind === 'empty') {
        const hitRadius = EMPTY_HIT_RADIUS_PX / viewRef.current.zoom
        const dx = world.x - worldTransform.x
        const dy = world.y - worldTransform.y
        if (dx * dx + dy * dy <= hitRadius * hitRadius) return obj.id
        continue
      }
      if (obj.kind === 'path') {
        // has no fillable faces to point-in-polygon test — hit-test distance to the curve line
        // itself instead (in screen pixels, so the tolerance stays constant regardless of zoom)
        const worldPoints = obj.mesh.vertices.map((v) => applyTransform(v, worldTransform))
        const samples = evaluatePathCurve(worldPoints, 12, obj.closed)
        for (let i = 0; i < samples.length - 1; i++) {
          if (pxDistToSegment(world.x, world.y, samples[i].x, samples[i].y, samples[i + 1].x, samples[i + 1].y) < GIZMO_HIT_TOLERANCE) {
            return obj.id
          }
        }
        continue
      }
      const local = inverseTransform(world, worldTransform)
      if (pointInPolygonFaces(local, obj)) return obj.id
    }
    return null
  }

  function pointInPolygonFaces(p: { x: number; y: number }, obj: SceneObject): boolean {
    for (const face of obj.mesh.faces) {
      if (pointInPolygon(p, face.map((i) => obj.mesh.vertices[i]))) return true
    }
    return false
  }

  function pointInPolygon(p: { x: number; y: number }, poly: { x: number; y: number }[]): boolean {
    let inside = false
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y
      const xj = poly[j].x, yj = poly[j].y
      const intersect =
        yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi
      if (intersect) inside = !inside
    }
    return inside
  }

  function handlePointerMove(e: PointerEvent) {
    const drag = dragRef.current
    if (drag.kind === 'none') return
    const store = useSceneStore.getState()

    if (drag.kind === 'pan') {
      const dx = (e.clientX - drag.startClientX) / viewRef.current.zoom
      const dy = (e.clientY - drag.startClientY) / viewRef.current.zoom
      viewRef.current.panX = drag.startPan.x - dx
      viewRef.current.panY = drag.startPan.y + dy
      return
    }

    const world = getWorldPos(e)

    if (drag.kind === 'move-object') {
      const dx = world.x - drag.startWorld.x
      const dy = world.y - drag.startWorld.y
      // the mouse delta is in world space; for a parented object `transform.x/y` is a local
      // offset from the parent's tail (rotated/scaled by the parent's world transform), so it
      // can't just be added directly — convert the resulting world position back to local first
      const newWorldPos = { x: drag.startWorldPos.x + dx, y: drag.startWorldPos.y + dy }
      if (shouldGridSnap(e.ctrlKey)) {
        const inc = getGridSnapIncrement()
        newWorldPos.x = snapToIncrement(newWorldPos.x, inc)
        newWorldPos.y = snapToIncrement(newWorldPos.y, inc)
      }
      const local = worldPositionToLocalOffset(newWorldPos, drag.parentWorld, drag.parentTail)
      store.setTransform(drag.objectId, { x: local.x, y: local.y })
      return
    }

    if (drag.kind === 'move-object-axis') {
      const dx = world.x - drag.startWorld.x
      const dy = world.y - drag.startWorld.y
      let along = dx * drag.axisDir.x + dy * drag.axisDir.y // project onto axis (world space)
      if (shouldGridSnap(e.ctrlKey)) along = snapToIncrement(along, getGridSnapIncrement())
      const newWorldPos = {
        x: drag.startWorldPos.x + drag.axisDir.x * along,
        y: drag.startWorldPos.y + drag.axisDir.y * along,
      }
      const local = worldPositionToLocalOffset(newWorldPos, drag.parentWorld, drag.parentTail)
      store.setTransform(drag.objectId, { x: local.x, y: local.y })
      return
    }

    if (drag.kind === 'move-pixel-frame') {
      let dx = world.x - drag.startWorld.x
      let dy = world.y - drag.startWorld.y
      if (shouldGridSnap(e.ctrlKey)) {
        const inc = getGridSnapIncrement()
        dx = snapToIncrement(drag.startFrame.x + dx, inc) - drag.startFrame.x
        dy = snapToIncrement(drag.startFrame.y + dy, inc) - drag.startFrame.y
      }
      store.setPixelFrame({ x: drag.startFrame.x + dx, y: drag.startFrame.y + dy })
      return
    }

    if (drag.kind === 'resize-pixel-frame') {
      const { startFrame, corner } = drag
      const left = startFrame.x - startFrame.width / 2
      const right = startFrame.x + startFrame.width / 2
      const bottom = startFrame.y - startFrame.height / 2
      const top = startFrame.y + startFrame.height / 2
      let worldX = world.x
      let worldY = world.y
      if (shouldGridSnap(e.ctrlKey)) {
        const inc = getGridSnapIncrement()
        worldX = snapToIncrement(worldX, inc)
        worldY = snapToIncrement(worldY, inc)
      }
      // the corner opposite the one being dragged stays put; the dragged corner follows the
      // cursor, so width/height/center all fall out of just those two fixed points
      const newLeft = corner === 'tl' || corner === 'bl' ? worldX : left
      const newRight = corner === 'tr' || corner === 'br' ? worldX : right
      const newBottom = corner === 'bl' || corner === 'br' ? worldY : bottom
      const newTop = corner === 'tl' || corner === 'tr' ? worldY : top
      store.setPixelFrame({
        x: (newLeft + newRight) / 2,
        y: (newBottom + newTop) / 2,
        width: Math.max(1, Math.abs(newRight - newLeft)),
        height: Math.max(1, Math.abs(newTop - newBottom)),
      })
      return
    }

    if (drag.kind === 'scale-object') {
      const obj = store.objects.find((o) => o.id === drag.objectId)
      if (!obj) return
      // snap the dragged corner/edge's *world* position to the grid — same convention as every
      // other grid-snapped drag (move-head/move-tail, move-object-axis, ...) — rather than
      // snapping the resulting scale ratio itself, so the handle visibly lands on a grid point.
      let snappedWorld = world
      if (shouldGridSnap(e.ctrlKey)) {
        const inc = getGridSnapIncrement()
        snappedWorld = { x: snapToIncrement(world.x, inc), y: snapToIncrement(world.y, inc) }
      }
      const local = inverseTransform(snappedWorld, { ...drag.startTransform, scaleX: 1, scaleY: 1 })
      const pivot = drag.startTransform.head
      const relX = local.x - pivot.x
      const relY = local.y - pivot.y
      const mc = drag.meshCornerRel
      const rawScaleX = mc.x !== 0 ? relX / mc.x : drag.startTransform.scaleX
      const rawScaleY = mc.y !== 0 ? relY / mc.y : drag.startTransform.scaleY
      // an edge-midpoint handle (axisLock set) only ever touches its own axis — the other axis's
      // scale is left exactly as it was at drag start, regardless of where the cursor wanders
      const newScaleX = drag.axisLock === 'y' ? drag.startTransform.scaleX : rawScaleX
      const newScaleY = drag.axisLock === 'x' ? drag.startTransform.scaleY : rawScaleY
      store.setTransform(drag.objectId, {
        scaleX: Math.abs(newScaleX) < 0.01 ? 0.01 * Math.sign(newScaleX || 1) : newScaleX,
        scaleY: Math.abs(newScaleY) < 0.01 ? 0.01 * Math.sign(newScaleY || 1) : newScaleY,
      })
      return
    }

    if (drag.kind === 'rotate-object') {
      const currentAngle = Math.atan2(world.y - drag.center.y, world.x - drag.center.x)
      const delta = currentAngle - drag.startAngle
      // startRotation/the dragged delta are both in world space (matches the world-space center
      // the ring is drawn around), but `transform.rotation` is local — subtract the parent's
      // world rotation to convert back, or a parented object snaps to its world rotation the
      // instant the drag starts
      let rotation = drag.startRotation + delta - drag.parentWorldRotation
      if (e.ctrlKey) {
        const step = (5 * Math.PI) / 180
        rotation = Math.round(rotation / step) * step
      }
      store.setTransform(drag.objectId, { rotation })
      return
    }

    if (drag.kind === 'move-head') {
      const obj = store.objects.find((o) => o.id === drag.objectId)
      if (!obj) return
      let snappedWorld = world
      if (shouldGridSnap(e.ctrlKey)) {
        const inc = getGridSnapIncrement()
        snappedWorld = { x: snapToIncrement(world.x, inc), y: snapToIncrement(world.y, inc) }
      }
      const localUnderMouse = inverseTransform(snappedWorld, getWorldTransform(obj, store.objects))
      store.setHead(drag.objectId, localUnderMouse)
      return
    }

    if (drag.kind === 'move-tail') {
      const obj = store.objects.find((o) => o.id === drag.objectId)
      if (!obj) return
      let snappedWorld = world
      if (shouldGridSnap(e.ctrlKey)) {
        const inc = getGridSnapIncrement()
        snappedWorld = { x: snapToIncrement(world.x, inc), y: snapToIncrement(world.y, inc) }
      }
      const localUnderMouse = inverseTransform(snappedWorld, getWorldTransform(obj, store.objects))
      store.setTail(drag.objectId, localUnderMouse)
      return
    }

    if (drag.kind === 'move-shapekey-arc-pivot') {
      const rawObj = store.objects.find((o) => o.id === drag.objectId)
      if (!rawObj) return
      // the effective (isolated-pose) vertices are what's actually drawn while sculpting this
      // key, so snap against those rather than the raw Basis — matches what the user sees
      const obj = getEffectiveObj(rawObj, store.editingShapeKeyId, true)
      const worldTransform = getWorldTransform(obj, store.objects)
      let nearestLocal: Vec2 | null = null
      let bestDist = (VERTEX_HIT_RADIUS * 1.5) ** 2
      obj.mesh.vertices.forEach((v) => {
        const p = applyTransform(v, worldTransform)
        const d = pxDistSq(world.x, world.y, p.x, p.y)
        if (d < bestDist) {
          bestDist = d
          nearestLocal = v
        }
      })
      let localUnderMouse: Vec2
      if (nearestLocal) {
        localUnderMouse = nearestLocal
      } else if (shouldGridSnap(e.ctrlKey)) {
        // grid is defined in world space, so snap there first, then convert to this object's
        // local space — matches how the move modal's own grid-snap works
        const inc = getGridSnapIncrement()
        const snappedWorld = { x: snapToIncrement(world.x, inc), y: snapToIncrement(world.y, inc) }
        localUnderMouse = inverseTransform(snappedWorld, worldTransform)
      } else {
        localUnderMouse = inverseTransform(world, worldTransform)
      }
      store.setShapeKeyArcPivot(drag.objectId, drag.keyId, localUnderMouse)
      return
    }

    if (drag.kind === 'move-fake-flag-direction') {
      const obj = store.objects.find((o) => o.id === drag.objectId)
      if (!obj) return
      const activeClip = store.clips.find((c) => c.id === store.activeClipId)
      const fakeFlagTime = store.previewFakeFlag ? performance.now() / 1000 : store.playheadTime
      const handle = getFakeFlagDirectionHandle(obj, fakeFlagTime, activeClip?.duration ?? 0)
      if (!handle) return
      // Delta-based, like `rotate-object`'s ring — the value only moves by however far the mouse
      // has moved *since the click*, so grabbing the ring off-angle from the marker doesn't snap
      // it straight to the cursor.
      const currentAngle = Math.atan2(world.y - handle.anchorWorld.y, world.x - handle.anchorWorld.x)
      const deltaDeg = ((currentAngle - drag.startAngle) * 180) / Math.PI
      store.setFakeFlagDirection(drag.objectId, drag.startDirection + deltaDeg)
      return
    }

    if (drag.kind === 'move-hairpath-cp') {
      hairPathRef.current = hairPathRef.current.map((p, i) => (i === drag.index ? world : p))
      return
    }

    if (drag.kind === 'move-path-cp') {
      pathDrawRef.current = pathDrawRef.current.map((p, i) => (i === drag.index ? world : p))
      return
    }

    if (drag.kind === 'move-path-point') {
      const store = useSceneStore.getState()
      const obj = store.objects.find((o) => o.id === drag.objectId)
      if (obj) {
        const worldTransform = getWorldTransform(obj, store.objects)
        store.setPathPointPosition(drag.objectId, drag.index, inverseTransform(world, worldTransform))
      }
      return
    }

    if (drag.kind === 'box-select') {
      dragRef.current = { ...drag, endClientX: e.clientX, endClientY: e.clientY }
      updateSelectionBoxOverlay(dragRef.current as typeof drag)
      return
    }
  }

  function updateSelectionBoxOverlay(drag: Extract<DragMode, { kind: 'box-select' }>) {
    const box = selectionBoxRef.current
    if (!box) return
    const x1 = Math.min(drag.startClientX, drag.endClientX)
    const y1 = Math.min(drag.startClientY, drag.endClientY)
    const x2 = Math.max(drag.startClientX, drag.endClientX)
    const y2 = Math.max(drag.startClientY, drag.endClientY)
    const containerRect = containerRef.current!.getBoundingClientRect()
    box.style.display = 'block'
    box.style.left = `${x1 - containerRect.left}px`
    box.style.top = `${y1 - containerRect.top}px`
    box.style.width = `${x2 - x1}px`
    box.style.height = `${y2 - y1}px`
  }

  function handlePointerUp(_e: PointerEvent) {
    const drag = dragRef.current
    if (drag.kind === 'box-select') {
      const box = selectionBoxRef.current
      if (box) box.style.display = 'none'

      const movedPx = Math.hypot(drag.endClientX - drag.startClientX, drag.endClientY - drag.startClientY)
      if (movedPx > 4) {
        const store = useSceneStore.getState()
        const rawObj = store.objects.find((o) => o.id === drag.objectId)
        const obj = rawObj && getEffectiveObj(rawObj, store.editingShapeKeyId, true)
        if (obj) {
          const rect = containerRef.current!.getBoundingClientRect()
          const wa = screenToWorld(drag.startClientX, drag.startClientY, rect, viewRef.current)
          const wb = screenToWorld(drag.endClientX, drag.endClientY, rect, viewRef.current)
          const minX = Math.min(wa.x, wb.x)
          const maxX = Math.max(wa.x, wb.x)
          const minY = Math.min(wa.y, wb.y)
          const maxY = Math.max(wa.y, wb.y)
          const inside = (p: { x: number; y: number }) =>
            p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY

          const worldTransform = getWorldTransform(obj, store.objects)
          const locked = getLockedVertices(obj)
          if (store.editElementType === 'vertex') {
            const next = drag.additive ? new Set(store.selectedVertices) : new Set<number>()
            obj.mesh.vertices.forEach((v, i) => {
              if (!locked.has(i) && inside(applyTransform(v, worldTransform))) next.add(i)
            })
            store.setSelectedVertices(next)
          } else if (store.editElementType === 'edge') {
            const next = drag.additive ? new Set(store.selectedEdges) : new Set<string>()
            for (const [a, b] of getEdges(obj.mesh)) {
              if (locked.has(a)) continue
              const pa = applyTransform(obj.mesh.vertices[a], worldTransform)
              const pb = applyTransform(obj.mesh.vertices[b], worldTransform)
              if (inside(pa) && inside(pb)) next.add(edgeKey(a, b))
            }
            store.setSelectedEdges(next)
          } else {
            const next = drag.additive ? new Set(store.selectedFaces) : new Set<number>()
            obj.mesh.faces.forEach((face, fi) => {
              if (face.some((i) => locked.has(i))) return
              if (face.every((i) => inside(applyTransform(obj.mesh.vertices[i], worldTransform)))) {
                next.add(fi)
              }
            })
            store.setSelectedFaces(next)
          }
        }
      }
    }

    dragRef.current = { kind: 'none' }
  }

  return (
    <div ref={containerRef} className="viewport">
      <div ref={selectionBoxRef} className="selection-box" style={{ display: 'none' }} />
    </div>
  )
}
