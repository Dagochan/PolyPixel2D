import { create } from 'zustand'
import type {
  AnimationClip,
  AppMode,
  EasingType,
  EditElementType,
  FakeBehindSettings,
  FakeFlagSettings,
  FfdSettings,
  FakePhysicsMeshSettings,
  FakePhysicsMeshTrack,
  FakePhysicsSettings,
  FollowPathProgressTrack,
  FollowPathSettings,
  InsertSlot,
  LoopMode,
  Mesh,
  Modifier,
  ObjectAnimationTrack,
  PathDeformRailSettings,
  PathOffsetTrack,
  PixelFrame,
  ReferenceImage,
  SceneObject,
  ShapeKey,
  Transform,
  UvIslandTransform,
  Vec2,
  VolumePreserveSettings,
} from './types'
import { REFERENCE_IMAGE_ID } from './types'
import { resolvePlaybackTime, sampleClipAtTime, sampleTrack, shapeKeyTrackKey } from './animation'
import { DEFAULT_FAKE_BEHIND_SETTINGS, getFakeBehind } from './fakeBehind'
import { boundsVertices } from './pathCurve'
import { DEFAULT_FAKE_FLAG_SETTINGS, getFakeFlag } from './fakeFlag'
import { DEFAULT_PATH_DEFORM_RAIL_SETTINGS, getPathDeformRail } from './pathDeformRail'
import { DEFAULT_FOLLOW_PATH_SETTINGS, getFollowPath } from './followPath'
import { DEFAULT_FFD_SETTINGS } from './ffd'
import { DEFAULT_VOLUME_PRESERVE_SETTINGS } from './volumePreserve'
import { DEFAULT_FAKE_PHYSICS_SETTINGS, getFakePhysics, simulateFakePhysicsChain } from './fakePhysics'
import {
  DEFAULT_FAKE_PHYSICS_MESH_SETTINGS,
  getFakePhysicsMesh,
  simulateFakePhysicsMeshSections,
} from './fakePhysicsMesh'
import { createCircleMesh, createHairPathMesh, createRectMesh } from './primitives'
import { applyLoopCut as applyLoopCutToMesh } from './loopCut'
import { findFan, applyRingCut as applyRingCutToMesh } from './ringCut'
import { findFullLoop } from './loopPath'
import { extrudeEdges } from './extrude'
import { deleteVertices, deleteEdges, deleteFaces } from './deleteElements'
import { dissolveVertices, dissolveEdges } from './dissolve'
import { mergeVertices as mergeVerticesInMesh, type MergeMode } from './mergeVertices'
import { applyKnifeCut as applyKnifeCutToMesh, type KnifeCutPoint } from './knifeCut'
import { edgeKey, getEdges, parseEdgeKey, pruneOrphanVertices, pruneOrphanVerticesTracked, mergeMeshAsIsland, clampToMesh } from './meshUtils'
import { findIslands, type Island } from './uv'
import { remapObjectVertexData } from './remapVertexData'
import { getWorldTransform, getParentWorldTransform, worldPositionToLocalOffset, worldBounds } from './transformUtils'

export type ActiveTool = 'select' | 'loopcut' | 'ringcut' | 'knife' | 'place-rect' | 'place-circle' | 'place-hairpath' | 'place-path'

export type { ReferenceImage }

/** Parameters for a primitive about to be placed as an island inside the edited mesh (see `setPendingPrimitive`). */
export type PendingPrimitive =
  | { kind: 'rect'; width: number; height: number; segX: number; segY: number }
  | { kind: 'circle'; radius: number; segments: number }

let nextId = 1
function genId(prefix: string) {
  return `${prefix}_${nextId++}`
}

/** After loading a project, make sure new ids can't collide with the ones it brought in. */
function bumpNextIdPast(objects: SceneObject[]) {
  for (const o of objects) {
    const suffix = o.id.split('_').pop()
    const n = suffix ? parseInt(suffix, 10) : NaN
    if (!Number.isNaN(n) && n >= nextId) nextId = n + 1
  }
}

const DEFAULT_MATERIAL_COLOR = '#91AA9B'

/** Selection state that selects every vertex/edge/face belonging to the given islands (by
 *  `findIslands` index) — shared by `selectLinked` and `selectIsland`. */
function islandSelectionState(
  obj: SceneObject,
  islands: Island[],
  islandIndices: number[],
): Pick<SceneState, 'selectedVertices' | 'selectedEdges' | 'selectedFaces'> {
  const vertices = new Set<number>()
  const faces = new Set<number>()
  for (const i of islandIndices) {
    islands[i].vertices.forEach((v) => vertices.add(v))
    islands[i].faces.forEach((f) => faces.add(f))
  }
  const edges = new Set<string>()
  faces.forEach((fi) => {
    const face = obj.mesh.faces[fi]
    for (let i = 0; i < face.length; i++) {
      edges.add(edgeKey(face[i], face[(i + 1) % face.length]))
    }
  })
  return { selectedVertices: vertices, selectedEdges: edges, selectedFaces: faces }
}

interface SceneState {
  objects: SceneObject[]
  selectedObjectId: string | null
  mode: AppMode
  editElementType: EditElementType
  selectedVertices: Set<number>
  selectedEdges: Set<string> // "a_b" with a < b
  selectedFaces: Set<number>
  /** Id of the shape key currently being sculpted on the selected object, or `null` for normal
   *  Basis editing (unaffected by shape keys). While set, `setVertexPositions` writes into that
   *  key's `positions` instead of `mesh.vertices`, and the viewport shows/hit-tests that key's
   *  isolated pose instead of the blended result. */
  editingShapeKeyId: string | null
  /** Live, wall-clock-driven Fake Flag preview toggle — see `togglePreviewFakeFlag`. */
  previewFakeFlag: boolean
  /** Live, direct-manipulation Fake Physics (mesh) preview toggle — see
   *  `togglePreviewFakePhysicsMesh`. Unlike `previewFakeFlag` (a pure function of wall-clock time),
   *  this drives the spring simulation off the object's *actual* live transform each rendered
   *  frame, so dragging the object around makes its lagging sections visibly jiggle/follow —
   *  nothing to key, no bake needed, just for quick iteration on Stiffness/Pivot before baking. */
  previewFakePhysicsMesh: boolean
  history: HistorySnapshot[]
  future: HistorySnapshot[]
  activeTool: ActiveTool
  /** Reference frame for the object-mode move gizmo's axis arrows (Blender-style). 'local'
   *  (default) follows the object's own world rotation; 'world' is always the scene's X/Y axes.
   *  Doesn't affect the rotate ring (no orientation concept) or scale handles (always local). */
  gizmoOrientation: 'world' | 'local'
  /** Edit-mode pivot, in local mesh space. `null` means "use the object's own pivot". */
  editPivot: Vec2 | null
  /** Dimensions for the primitive currently being placed (activeTool === 'place-rect'/'place-circle'). */
  pendingPrimitive: PendingPrimitive | null
  /** Toggled in the Add ▾ menu before starting a Hair Path — when true, the ribbon stays full
   *  width all the way to the tip instead of tapering to a point (for belts/straps, not just hair). */
  hairPathConstantWidth: boolean
  /** Trace-over reference image shown behind everything; `null` if none loaded. */
  referenceImage: ReferenceImage | null
  /** Global opacity (0..1) applied to every object's material, so you can see a reference image through them. */
  meshOpacity: number
  /** How many sub-grid divisions per major grid cell (viewport display, and the basis for grid
   *  snapping's increment). User-configurable rather than fixed, so different project scales can
   *  pick a finer or coarser snap granularity. */
  gridSubdivisions: number
  /** Persistent "Grid Snap" toggle (Blender-style) — while on, moves snap to the grid by default;
   *  holding Ctrl temporarily inverts it (off while held), and vice versa while this is off. */
  gridSnapEnabled: boolean
  /** Whether the background grid (major + sub-grid lines) is drawn in the viewport. Purely
   *  visual — independent of `gridSnapEnabled`, which keeps working even while the grid is hidden. */
  gridVisible: boolean
  /** Whether every mesh's edge wireframe overlay is drawn in the viewport (Object mode included —
   *  it's not just an Edit Mode thing). Purely visual, e.g. for judging a FakeBehind cutout's
   *  actual silhouette without the edge lines cluttering the read. Edit Mode's other selection
   *  overlays (vertex/edge/face handles) are untouched by this — only the plain edge wireframe. */
  wireframeVisible: boolean
  /** Whether the pixel preview panel (low-res, nearest-neighbor render simulating the final
   *  dot-art output) is shown. */
  pixelPreviewEnabled: boolean
  /** Target resolution (in "pixels") of the pixel preview's render — the long edge of the
   *  framed scene is scaled to fit this, the short edge follows the aspect ratio. */
  pixelPreviewResolution: number
  /** Drag offset (from its default docked position) of the pixel preview panel, persisted across
   *  hide/show so reopening it doesn't reset where the user dragged it. */
  pixelPreviewOffset: { x: number; y: number }
  /** Whether the pixel preview also quantizes its render to a limited, auto-extracted palette
   *  (median-cut over the rendered pixels) — the "real" dot-art color-count look, on top of the
   *  nearest-neighbor resolution/silhouette effect. */
  pixelPreviewPaletteEnabled: boolean
  /** Max number of colors the auto-extracted palette may use. */
  pixelPreviewPaletteSize: number
  /** Whether the pixel preview draws a flat-color outline around the rendered sprite's silhouette
   *  (see `applyPixelOutline`) — applied *after* palette quantization, so the outline color stays
   *  exact rather than getting pulled into the quantized palette. */
  pixelPreviewOutlineEnabled: boolean
  pixelPreviewOutlineColor: string
  /** Outline thickness in output pixels (each pass grows the ring one pixel outward). */
  pixelPreviewOutlineThickness: number
  /** Pixel Preview's fixed "main render camera" — see `PixelFrame`'s doc. `null` means Pixel
   *  Preview falls back to its old per-frame auto-fit-to-visible-objects framing. */
  pixelFrame: PixelFrame | null

  /** Every animation clip in the project (e.g. "Idle", "Walk"). Editing/scrubbing always targets
   *  `activeClipId` — there's no per-clip-project split. */
  clips: AnimationClip[]
  activeClipId: string | null
  /** Current scrub/playback position, in seconds, within the active clip. Moving it re-evaluates
   *  every animated object's transform (see `setPlayhead`) — it's "what you're looking at", not
   *  just a UI cursor. */
  playheadTime: number

  beginChange: () => void
  undo: () => void
  redo: () => void
  /** Abort the in-progress change (e.g. right-click during a drag) and restore the pre-drag snapshot. */
  cancelChange: () => void

  addRect: (width: number, height: number, segX: number, segY: number) => void
  /** Adds a new `kind: 'lattice'` object — an FFD cage, a plain row-major grid mesh (`cols`/`rows`
   *  vertex counts, same shape "Add Rectangle" produces) with `cageRestVertices` frozen
   *  immediately from its own starting shape (see `SceneObject.kind`/`FfdSettings`'s docs). */
  addLattice: (width: number, height: number, cols: number, rows: number) => void
  /** Regenerates a `kind: 'lattice'` object's grid at a new `cols`×`rows` resolution, sized to its
   *  current bounding box — necessarily resets to a fresh, undeformed grid (and re-freezes
   *  `cageRestVertices` to match), since the old and new topologies don't correspond
   *  vertex-for-vertex. No-op on a non-lattice object. */
  resizeLattice: (id: string, cols: number, rows: number) => void
  addCircle: (radius: number, segments: number) => void
  /** Character-part presets (Toolbar's "Character Parts" submenu) — same rectangle/circle meshes
   *  as "Add Rectangle"/"Add Circle", but with `transform.head`/`tail` pre-placed at the shape's
   *  own bottom/top instead of both defaulting to the center. Saves the user from having to enter
   *  Pivot mode and drag Head/Tail into place by hand for every limb-like part; renaming, resizing,
   *  and re-adjusting Head/Tail afterward all work exactly like any other object. */
  addTorso: (width: number, height: number) => void
  addCharacterHead: (radius: number) => void
  addLimb: (width: number, height: number) => void
  /** Standalone new object from a hand-drawn path (`points` already in world/local space, since
   *  the new object's transform is identity) — see `createHairPathMesh`. */
  addHairPath: (points: Vec2[], width: number, constantWidth?: boolean) => void
  addImportedMesh: (mesh: Mesh, name: string) => void
  /** Inserts a user-saved part preset (see `src/scene/partPresetsStore.ts`'s "My Parts" library,
   *  independent of this scene store — saved presets persist across projects via localStorage)
   *  as a fresh object, carrying over its mesh, Head/Tail, and color exactly as saved. */
  addFromPartPreset: (preset: { mesh: Mesh; head: Vec2; tail: Vec2; color: string; name: string }) => void
  /** Adds a mesh-less hierarchy-only dummy object (e.g. a rig root), positioned at the origin. */
  addEmpty: () => void
  /** Adds a new `kind: 'path'` object — `points` (world space, since the new object's transform
   *  is identity, same convention as `addHairPath`) become its `mesh.vertices` (ordered control
   *  points, `mesh.faces` stays empty — see `SceneObject.kind`'s doc). No-op if fewer than 2
   *  points (a single point can't define a curve). */
  addPath: (points: Vec2[]) => void
  /** Live-write one control point's local-space position on an already-confirmed `kind: 'path'`
   *  object — called every pointermove while dragging it in Edit mode; the caller does its own
   *  single `beginChange()` at drag start, matching `setFakeFlagDirection`'s pattern. */
  setPathPointPosition: (id: string, index: number, localPosition: Vec2) => void
  /** Insert a new control point at `index` (so it lands between the previous `index - 1` and
   *  `index`) on a `kind: 'path'` object. */
  insertPathPoint: (id: string, index: number, localPosition: Vec2) => void
  /** Remove control point `index` from a `kind: 'path'` object — no-op if that would leave fewer
   *  than 2 points (a path needs at least 2 to mean anything). */
  removePathPoint: (id: string, index: number) => void
  /** Toggle a `kind: 'path'` object's `closed` flag (Blender's "Cyclic U") — see its doc. */
  togglePathClosed: (id: string) => void
  /** Merge a rect/circle into the given object's mesh as a new disconnected island, instead of
   *  creating a separate object — used when adding a primitive while already in edit mode. */
  addRectIsland: (objectId: string, at: Vec2, width: number, height: number, segX: number, segY: number) => void
  addCircleIsland: (objectId: string, at: Vec2, radius: number, segments: number) => void
  /** Add a hair-path island — `points` must already be converted into `objectId`'s local space. */
  addHairPathIsland: (objectId: string, points: Vec2[], width: number, constantWidth?: boolean) => void
  setPendingPrimitive: (p: PendingPrimitive | null) => void
  setHairPathConstantWidth: (v: boolean) => void
  setReferenceImage: (url: string | null) => void
  setReferenceImageTransform: (
    transform: Partial<
      Pick<ReferenceImage, 'x' | 'y' | 'scale' | 'rotation' | 'opacity' | 'visible' | 'gifOffset' | 'flipX'>
    >,
  ) => void
  setMeshOpacity: (opacity: number) => void
  setGridSubdivisions: (n: number) => void
  setGridSnapEnabled: (enabled: boolean) => void
  setGridVisible: (visible: boolean) => void
  setWireframeVisible: (visible: boolean) => void
  setPixelPreviewEnabled: (enabled: boolean) => void
  setPixelPreviewResolution: (n: number) => void
  setPixelPreviewOffset: (offset: { x: number; y: number }) => void
  setPixelPreviewPaletteEnabled: (enabled: boolean) => void
  setPixelPreviewPaletteSize: (n: number) => void
  setPixelPreviewOutlineEnabled: (enabled: boolean) => void
  setPixelPreviewOutlineColor: (color: string) => void
  setPixelPreviewOutlineThickness: (n: number) => void
  /** Creates a Pixel Frame (sized/centered on the current auto-fit bounding box of every visible
   *  object, same framing Pixel Preview used to compute every frame) if none exists, or removes
   *  the existing one — a single toggle for the "+ Pixel Frame" toolbar button. */
  togglePixelFrame: () => void
  /** Live-write the Pixel Frame's rect while dragging its body/corners in the viewport — not
   *  undo-tracked (a render/export setting, like `setGridVisible`, not scene content). No-op if
   *  there's no Pixel Frame yet. */
  setPixelFrame: (patch: Partial<PixelFrame>) => void
  /** Replace the entire scene with a loaded project (clears selection, undo history, and `nextId` continues from fresh ids). */
  loadProject: (project: {
    objects: SceneObject[]
    referenceImage: ReferenceImage | null
    meshOpacity: number
    clips?: AnimationClip[]
    pixelFrame?: PixelFrame | null
  }) => void
  selectObject: (id: string | null) => void
  removeObject: (id: string) => void
  toggleVisibility: (id: string) => void
  renameObject: (id: string, name: string) => void
  setMaterialColor: (id: string, color: string) => void
  setMaterialTexture: (id: string, textureUrl: string | undefined) => void
  /** Override color for the given faces (indexed like `selectedFaces`) — see `Mesh.faceColors`. */
  setFaceColor: (id: string, faceIndices: number[], color: string) => void
  /** Remove the color override for the given faces, reverting them to the object's material color. */
  clearFaceColor: (id: string, faceIndices: number[]) => void
  /** Merge a partial transform into one UV island's manual offset/scale (by island order). */
  setUvIslandTransform: (id: string, islandIndex: number, transform: Partial<UvIslandTransform>) => void
  /** Swap this island's draw-order rank with the island immediately in front of/behind it
   *  (direction 1 = move forward/up, -1 = move back/down). No-op at either end. */
  moveIslandZOrder: (id: string, islandIndex: number, direction: 1 | -1) => void
  /** Rename one island (by `findIslands` order) — stores the raw value as typed. */
  setIslandName: (id: string, islandIndex: number, name: string) => void
  /** Call on blur: if that island's stored name is empty/whitespace-only, clears it back to the
   *  default "アイランド N" label rather than leaving a blank name stuck in place. */
  clearIslandNameIfEmpty: (id: string, islandIndex: number) => void
  /** Toggle showing every island's name in the viewport, just below its bounding-box center. */
  setShowIslandNames: (id: string, show: boolean) => void
  /** Toggle one island's visibility (by `findIslands` order) — hidden draws nothing at all
   *  (fill, wireframe, edit overlays). */
  toggleIslandVisible: (id: string, islandIndex: number) => void
  /** Toggle one island's edit lock (by `findIslands` order) — locked can't be selected/edited
   *  and hides its wireframe/vertex/edge overlays, but its fill (material/texture) still draws. */
  toggleIslandLocked: (id: string, islandIndex: number) => void
  /** Set this object's unique slot name — stealing it from whichever other object currently
   *  holds it, so the same name is never held by two objects at once. */
  setSlotName: (id: string, slotName: string) => void
  /** Add a new reserved insert slot to the end of this object's island/slot Z-order stack
   *  (unfilled — use `setInsertSlotTarget` to point it at a `slotName`). */
  addInsertSlot: (id: string) => void
  removeInsertSlot: (id: string, slotId: string) => void
  setInsertSlotTarget: (id: string, slotId: string, targetSlotName: string) => void
  /** Swap an insert slot's rank with whichever island or other slot is immediately in front
   *  of/behind it in the combined order (direction 1 = forward/up, -1 = back/down). */
  moveInsertSlotRank: (id: string, slotId: string, direction: 1 | -1) => void
  /** Add a new (empty) shape key to this object, blended at weight 0 until set otherwise. */
  addShapeKey: (id: string) => void
  /** Remove a shape key — also drops its weight entry, and clears `editingShapeKeyId` if it
   *  pointed at this key. */
  removeShapeKey: (id: string, keyId: string) => void
  renameShapeKey: (id: string, keyId: string, name: string) => void
  /** Set a shape key's blend weight (unclamped — see `SceneObject.shapeKeyValues`). */
  setShapeKeyValue: (id: string, keyId: string, value: number) => void
  setShapeKeyInterpolation: (id: string, keyId: string, interpolation: 'linear' | 'arc') => void
  /** Live-write a shape key's Arc pivot (local mesh space) — called every pointermove while
   *  dragging its viewport handle, same pattern as `setHead`/`setTail`. */
  setShapeKeyArcPivot: (id: string, keyId: string, pivot: Vec2) => void
  /** Enter/exit sculpting a shape key in isolation (`null` = back to normal Basis editing). Also
   *  clears the current vertex/edge/face selection, since it belonged to a different mesh state. */
  setEditingShapeKey: (keyId: string | null) => void
  /** Re-stamp the UV rest-pose for specific vertices to their current position — used right after
   *  a post-extrude grab confirms, so the new geometry's UV reflects where it ended up. */
  freezeUvBaseVertices: (id: string, indices: number[]) => void
  /** Re-unwrap the whole object: every vertex's UV rest-pose becomes its current position. Manual
   *  per-island placement (offset/scale/rotation) is untouched. */
  reunwrapUVs: (id: string) => void
  setTransform: (id: string, transform: Partial<Transform>) => void
  /** Move the head (in local mesh space) while keeping the mesh visually in place. */
  setHead: (id: string, localHead: Vec2) => void
  /** Set the tail (in local mesh space) — a plain field set, no x/y compensation needed since
   *  the tail is just an attachment reference point, not something rotation/scale pivots about. */
  setTail: (id: string, localTail: Vec2) => void
  /** Reparent `id` onto `parentId` (or detach to root with `null`). No-op (rejected) if that
   *  would create a cycle. */
  setParent: (id: string, parentId: string | null) => void
  setConnected: (id: string, connected: boolean) => void
  reorder: (id: string, newZOrder: number) => void

  setMode: (mode: AppMode) => void
  setEditElementType: (t: EditElementType) => void
  setSelectedVertices: (indices: Set<number>) => void
  setSelectedEdges: (keys: Set<string>) => void
  setSelectedFaces: (indices: Set<number>) => void
  /** Overwrite the absolute local-space position of each given vertex index. */
  setVertexPositions: (objectId: string, indices: number[], positions: Vec2[]) => void
  /** Set the edit-mode pivot to the centroid of the vertices touched by the current selection. */
  setEditPivotFromSelection: () => void
  setActiveTool: (tool: ActiveTool) => void
  setGizmoOrientation: (orientation: 'world' | 'local') => void
  /** Cut the quad strip running through the edge (edgeA, edgeB), at each t in `ts`. No-op if neither side is a quad. */
  applyLoopCut: (objectId: string, edgeA: number, edgeB: number, ts: number[]) => void
  /** Cut one or more concentric rings into the triangle fan around `center` (e.g. a circle
   *  primitive), through the spoke (center, hoverRim), at each t (fraction from center to rim)
   *  in `ts`. No-op if (center, hoverRim) isn't a spoke of any triangle. */
  applyRingCut: (objectId: string, center: number, hoverRim: number, ts: number[]) => void
  /** Cut a polyline of vertex/edge-snapped points across one or more connected faces. */
  applyKnifeCut: (objectId: string, path: KnifeCutPoint[]) => void
  /** Extrude the current edge/face selection on the selected object. No-op (returns false) otherwise. */
  extrudeSelection: () => boolean
  /** Delete the current vertex/edge/face selection on the selected object (no-op otherwise). */
  deleteSelection: () => void
  /** Dissolve the current vertex/edge selection: merges the faces around each selected element
   *  into one instead of deleting them outright. No-op in face mode or with nothing selected. */
  dissolveSelection: () => void
  /** Select all vertices/edges/faces (whichever editElementType is active) of the selected object. */
  selectAll: () => void
  /** Invert the selection within the active editElementType — selected become unselected and
   *  vice versa, like Blender's Select Inverse (Ctrl+I). */
  invertSelection: () => void
  /** Expand the current selection to every vertex/edge/face in the same island(s) (topologically
   *  connected component) as anything already selected — like Blender's "Select Linked". No-op
   *  if nothing is selected. */
  selectLinked: () => void
  /** Select every vertex/edge/face in one island (by `findIslands` order) and switch to edit
   *  mode — used by the Properties panel's island list. */
  selectIsland: (islandIndex: number) => void
  /** Select every vertex/edge/face touching the given faces and switch to edit mode/face
   *  select — used by the Properties panel's Face Color list to select all faces sharing one
   *  color, same idea as `selectIsland`. */
  selectFacesByColor: (faceIndices: number[]) => void
  /** Merge the current vertex selection (2+) into one vertex, positioned per `mode`. */
  mergeSelectedVertices: (mode: MergeMode) => void
  /** Create one new face directly from the selected vertices, in selection (click) order. */
  fillSelectedFace: () => void
  /** Merge `mergeIndex` into `keepIndex` (keepIndex's position wins). Used for drag-to-weld onto an adjacent vertex. */
  mergeVertexPair: (objectId: string, keepIndex: number, mergeIndex: number) => void

  /** Create a new, empty animation clip and make it active. Returns its id. */
  addClip: (name?: string) => string
  /** Remove a clip. If it was the active one, falls back to another remaining clip (or `null`). */
  removeClip: (id: string) => void
  renameClip: (id: string, name: string) => void
  setActiveClipId: (id: string | null) => void
  setClipDuration: (id: string, duration: number) => void
  setClipLoopMode: (id: string, loopMode: LoopMode) => void
  setClipFrameRate: (id: string, frameRate: number) => void
  /** Snapshot `objectId`'s current transform into the active clip as a keyframe at `time`
   *  (seconds), creating that object's track if needed. Replaces any existing key at the same
   *  time. No-op if there's no active clip. */
  insertKeyframe: (objectId: string, time: number, easing?: EasingType) => void
  removeKeyframe: (objectId: string, keyframeId: string) => void
  setKeyframeTime: (objectId: string, keyframeId: string, time: number) => void
  setKeyframeEasing: (objectId: string, keyframeId: string, easing: EasingType) => void
  /** Copies `sourceKeyframeId`'s transform/easing into a new keyframe at `time` — unlike
   *  `insertKeyframe`, this doesn't touch the object's *current* live transform at all, it clones
   *  whatever was keyed at the source. Replaces any existing key already at `time`. */
  duplicateKeyframe: (objectId: string, sourceKeyframeId: string, time: number) => void
  /** Keys the given shape key's current live weight (`obj.shapeKeyValues[shapeKeyId] ?? 0`) at
   *  `time` — mirrors `insertKeyframe` capturing the live transform. Creates the track if absent. */
  insertShapeKeyKeyframe: (objectId: string, shapeKeyId: string, time: number, easing?: EasingType) => void
  removeShapeKeyKeyframe: (objectId: string, shapeKeyId: string, keyframeId: string) => void
  setShapeKeyKeyframeTime: (objectId: string, shapeKeyId: string, keyframeId: string, time: number) => void
  setShapeKeyKeyframeEasing: (objectId: string, shapeKeyId: string, keyframeId: string, easing: EasingType) => void
  /** Same idea as `duplicateKeyframe`, for a `ShapeKeyTrack`'s weight keyframes. */
  duplicateShapeKeyKeyframe: (objectId: string, shapeKeyId: string, sourceKeyframeId: string, time: number) => void
  /** Keys the given object's current live `pathDeformRail.pathOffset` at `time` — same idea as
   *  `insertShapeKeyKeyframe`, but for `PathOffsetTrack` (keyed by `objectId` alone — see its
   *  doc). Creates the track if absent, no-op if the object has no `pathDeformRail` modifier or
   *  there's no active clip. */
  insertPathOffsetKeyframe: (objectId: string, time: number, easing?: EasingType) => void
  removePathOffsetKeyframe: (objectId: string, keyframeId: string) => void
  setPathOffsetKeyframeTime: (objectId: string, keyframeId: string, time: number) => void
  setPathOffsetKeyframeEasing: (objectId: string, keyframeId: string, easing: EasingType) => void
  /** Same idea as `duplicateKeyframe`, for a `PathOffsetTrack`. */
  duplicatePathOffsetKeyframe: (objectId: string, sourceKeyframeId: string, time: number) => void
  /** Add a modifier of `type` to this object's stack (see `Modifier`) — a no-op if it already has
   *  one of that type, since the stack holds at most one per type. */
  addModifier: (id: string, type: Modifier['type']) => void
  /** Remove the modifier of `type` from this object's stack entirely (settings and all — unlike
   *  `toggleFakeFlagEnabled`, this can't be undone by just re-enabling it). */
  removeModifier: (id: string, type: Modifier['type']) => void
  /** Quick on/off for an already-added Fake Flag modifier, without removing it (its settings
   *  survive being disabled, unlike `removeModifier`). */
  toggleFakeFlagEnabled: (id: string) => void
  /** Merge a partial patch into this object's Fake Flag settings — adds the modifier (with
   *  defaults merged with `patch`) if it isn't already in the stack. */
  updateFakeFlag: (id: string, patch: Partial<FakeFlagSettings>) => void
  /** Live-write `direction` (degrees) without pushing an undo checkpoint — called every
   *  pointermove while dragging the viewport direction handle; the caller does its own single
   *  `beginChange()` at drag start, matching `setShapeKeyArcPivot`'s pattern. */
  setFakeFlagDirection: (id: string, direction: number) => void
  /** Pin the current Edit Mode vertex/edge/face selection as this object's Fake Flag anchor,
   *  switching it from object-rotation mode into vertex (cloth) mode. Replaces any previous
   *  anchor selection rather than adding to it. */
  assignFakeFlagAnchor: (id: string) => void
  /** Clear the anchor list, switching back to object-rotation mode. */
  clearFakeFlagAnchor: (id: string) => void
  /** Merge a partial patch into this object's Path Deform (Rail) settings — adds the modifier
   *  (with defaults merged with `patch`) if it isn't already in the stack. */
  updatePathDeformRail: (id: string, patch: Partial<PathDeformRailSettings>) => void
  /** Merge a partial patch into this object's Follow Path settings — adds the modifier (with
   *  defaults merged with `patch`) if it isn't already in the stack. */
  updateFollowPath: (id: string, patch: Partial<FollowPathSettings>) => void
  /** Keys the given object's current live `followPath.progress` at `time` — same idea as
   *  `insertPathOffsetKeyframe`, but for `FollowPathProgressTrack`. Creates the track if absent,
   *  no-op if the object has no `followPath` modifier or there's no active clip. */
  insertFollowPathProgressKeyframe: (objectId: string, time: number, easing?: EasingType) => void
  removeFollowPathProgressKeyframe: (objectId: string, keyframeId: string) => void
  setFollowPathProgressKeyframeTime: (objectId: string, keyframeId: string, time: number) => void
  setFollowPathProgressKeyframeEasing: (objectId: string, keyframeId: string, easing: EasingType) => void
  /** Same idea as `duplicateKeyframe`, for a `FollowPathProgressTrack`. */
  duplicateFollowPathProgressKeyframe: (objectId: string, sourceKeyframeId: string, time: number) => void
  /** Merge a partial patch into this object's FFD settings — adds the modifier (with defaults
   *  merged with `patch`) if it isn't already in the stack. Setting `cageObjectId` to a cage
   *  that doesn't yet have a `cageRestVertices` snapshot seeds one from its current
   *  `mesh.vertices` (see `FfdSettings`'s doc) — same "freeze on first use" convention as
   *  `uvBaseVertices`. */
  updateFfd: (id: string, patch: Partial<FfdSettings>) => void
  /** Re-freeze the cage object's `cageRestVertices` from its current `mesh.vertices` — for
   *  redefining what "undeformed" means after intentionally reshaping the cage itself (as
   *  opposed to posing it for others to follow). */
  resetFfdCageRest: (cageObjectId: string) => void
  /** Merge a partial patch into this object's Volume Preserve settings — adds the modifier (with
   *  defaults merged with `patch`) if it isn't already in the stack. */
  updateVolumePreserve: (id: string, patch: Partial<VolumePreserveSettings>) => void
  /** Blender-style "Apply Scale": bakes `transform.scaleX`/`scaleY` into every local-mesh-space
   *  field (`mesh.vertices`, `tail`, `uvBaseVertices`, `cageRestVertices`, each shape key's
   *  `positions`/`arcPivot`) about the pivot (`transform.head`), then resets scale to 1/1. World
   *  appearance is unchanged; only future Edit Mode rotations/scales stop compounding with a
   *  stale non-uniform Object-mode scale. */
  applyScale: (id: string) => void
  /** Live, wall-clock-driven Fake Flag preview, independent of the playhead/active clip — lets a
   *  user see the sway/flutter without laying down any keyframes first. Toggling this never
   *  touches undo history (it's a view setting, not a scene edit). */
  togglePreviewFakeFlag: () => void
  /** Quick on/off for an already-added Fake Physics modifier, without removing it. Disabling it
   *  doesn't clear any existing bake — the object just stops taking part in future bakes of its
   *  chain until re-enabled. */
  toggleFakePhysicsEnabled: (id: string) => void
  /** Merge a partial patch into this object's Fake Physics settings — adds the modifier (with
   *  defaults merged with `patch`) if it isn't already in the stack. Note this does *not*
   *  re-bake — the existing baked keyframes (if any) are now stale until "Bake" is run again. */
  updateFakePhysics: (id: string, patch: Partial<FakePhysicsSettings>) => void
  /** Simulates the Fake Physics chain rooted at `id` (every enabled-modifier descendant, cascading
   *  down the real `parentId` hierarchy) against the active clip, and writes the result into that
   *  clip's `fakePhysicsTracks` — replacing any prior baked entries for the objects touched. A
   *  no-op if there's no active clip. */
  bakeFakePhysics: (id: string) => void
  /** Removes just this object's own baked Fake Physics track (if any), reverting it to its base
   *  `tracks` motion (or its static pose). Doesn't touch descendants' bakes, which may then be
   *  stale relative to their parent until the chain is re-baked from its root. */
  clearFakePhysicsBake: (id: string) => void
  /** Quick on/off for an already-added Fake Physics (mesh) modifier, without removing it. */
  toggleFakePhysicsMeshEnabled: (id: string) => void
  /** Merge a partial patch into this object's Fake Physics (mesh) settings — adds the modifier
   *  (with defaults merged with `patch`) if it isn't already in the stack. Doesn't re-bake — an
   *  existing bake is now stale until "Bake" is run again. */
  updateFakePhysicsMesh: (id: string, patch: Partial<FakePhysicsMeshSettings>) => void
  /** Live-write one section's stiffness (`index` 0-3, for Sections 2-5) without pushing an undo
   *  checkpoint — called every pointermove while dragging a point on the Advanced-mode stiffness
   *  curve; the caller does its own single `beginChange()` at drag start, matching
   *  `setFakeFlagDirection`'s pattern. */
  setFakePhysicsMeshSectionStiffnessLive: (id: string, index: 0 | 1 | 2 | 3 | 4, value: number) => void
  /** Assign the current Edit Mode vertex/edge/face selection to section `section` (1-5) of this
   *  object's Fake Physics (mesh) modifier — removes those vertices from whichever other section
   *  they were previously in, since a vertex belongs to at most one section. */
  assignFakePhysicsMeshSection: (id: string, section: 1 | 2 | 3 | 4 | 5) => void
  /** Re-select (in Edit Mode, vertex sub-mode) whichever vertices are currently assigned to
   *  section `section`, so it's easy to see/re-pick what's already been assigned. */
  selectFakePhysicsMeshSection: (id: string, section: 1 | 2 | 3 | 4 | 5) => void
  /** Remove the current Edit Mode vertex selection from section `section`'s assignment (the
   *  section itself stays — only its member vertices shrink). */
  removeFakePhysicsMeshSectionVertices: (id: string, section: 1 | 2 | 3 | 4 | 5) => void
  /** Simulates this object's 5-section Fake Physics (mesh) chain against the active clip, and
   *  writes the result into that clip's `fakePhysicsMeshTracks` — replacing any prior baked
   *  sections for this object. A no-op if there's no active clip. */
  bakeFakePhysicsMesh: (id: string) => void
  /** Removes this object's baked Fake Physics (mesh) tracks (if any), reverting its mesh to
   *  whatever shape keys/Fake Flag alone would produce. */
  clearFakePhysicsMeshBake: (id: string) => void
  /** Live, direct-manipulation Fake Physics (mesh) preview — see the `previewFakePhysicsMesh`
   *  field doc. Toggling this never touches undo history (it's a view setting, not a scene edit). */
  togglePreviewFakePhysicsMesh: () => void
  /** Bakes every Fake Physics chain (object-chain — every ROOT-candidate object, i.e. one without
   *  its own enabled `fakePhysics` modifier, walked for enabled-modifier descendants) and every
   *  Fake Physics (mesh) modifier in the scene against the active clip, in one undo step. Always
   *  safe to re-run: baking is fully deterministic from an object's current settings, so this
   *  can't clobber hand-authored keyframes (those live in `tracks`, never touched here) or stomp
   *  on an already-good bake (re-baking the same settings just reproduces the same result). A
   *  no-op if there's no active clip. */
  bakeAllFakePhysics: () => void
  /** Quick on/off for an already-added FakeBehind modifier, without removing it (its
   *  `maskObjectIds` survive being disabled). */
  toggleFakeBehindEnabled: (id: string) => void
  /** Add `maskId` to this object's FakeBehind `maskObjectIds` (no-op if already present or if
   *  `maskId === id`) — adds the modifier (enabled, with just this mask) if it isn't already in
   *  the stack. Used by both the drag-and-drop-from-Outliner drop target and the "+ Add mask"
   *  dropdown fallback. */
  addFakeBehindMaskRef: (id: string, maskId: string) => void
  /** Remove `maskId` from this object's FakeBehind `maskObjectIds` (no-op if absent). */
  removeFakeBehindMaskRef: (id: string, maskId: string) => void
  /** Move the scrub position and apply the active clip's evaluated pose to every object it
   *  animates (objects with no track in the active clip are left untouched). This is pose
   *  *evaluation*, not a user edit — it doesn't push undo history. */
  setPlayhead: (time: number) => void
}

/** The vertex indices touched by the current selection, given which element type is active. */
export function selectedVertexIndices(
  s: Pick<SceneState, 'editElementType' | 'selectedVertices' | 'selectedEdges' | 'selectedFaces'>,
  mesh: Mesh,
): number[] {
  if (s.editElementType === 'vertex') return Array.from(s.selectedVertices)
  const set = new Set<number>()
  if (s.editElementType === 'edge') {
    s.selectedEdges.forEach((key) => {
      const [a, b] = parseEdgeKey(key)
      set.add(a)
      set.add(b)
    })
  } else {
    s.selectedFaces.forEach((fi) => mesh.faces[fi]?.forEach((v) => set.add(v)))
  }
  return Array.from(set)
}

/** Freeze a UV rest-pose position for any of `mesh`'s vertices that don't have one yet (existing
 *  entries are left untouched) — call this after any op that adds vertices, so new geometry gets
 *  a fixed UV reference from the moment it exists, instead of "live" UV that drifts as it's
 *  later moved/posed. Ordinary vertex edits (drag, G/R/S, bone deform later) must NOT call this. */
function seedUvBaseVertices(mesh: Mesh, existing: Record<number, Vec2> | undefined): Record<number, Vec2> {
  const next = { ...(existing ?? {}) }
  mesh.vertices.forEach((v, i) => {
    if (!(i in next)) next[i] = { x: v.x, y: v.y }
  })
  return next
}

function cloneObjects(objects: SceneObject[]): SceneObject[] {
  return objects.map((o) => ({
    ...o,
    transform: { ...o.transform, head: { ...o.transform.head } },
    tail: { ...o.tail },
    mesh: {
      vertices: o.mesh.vertices.map((v) => ({ ...v })),
      faces: o.mesh.faces.map((f) => [...f]),
      ...(o.mesh.faceColors ? { faceColors: { ...o.mesh.faceColors } } : {}),
    },
  }))
}

/** Undo/redo snapshot — covers both `objects` and `clips`, since actions like baking or keying
 *  only mutate `clips` and previously went untracked (see `beginChange`'s doc). `clips` is plain,
 *  cycle-free JSON data (keyframes/tracks, no functions/Sets), so `structuredClone` is a cheap,
 *  correct deep copy without needing a bespoke cloner like `cloneObjects`. */
interface HistorySnapshot {
  objects: SceneObject[]
  clips: AnimationClip[]
}

function snapshotScene(s: { objects: SceneObject[]; clips: AnimationClip[] }): HistorySnapshot {
  return { objects: cloneObjects(s.objects), clips: structuredClone(s.clips) }
}

/** Returns `o` with its Fake Flag modifier's settings replaced by `updater(current settings)` —
 *  adding the modifier (seeded from `DEFAULT_FAKE_FLAG_SETTINGS`) first if `o` doesn't have one
 *  yet, so every Fake-Flag-settings setter can stay a one-liner regardless of whether the object
 *  already has the modifier. */
function withFakeFlagSettings(o: SceneObject, updater: (settings: FakeFlagSettings) => FakeFlagSettings): SceneObject {
  const existing = o.modifiers?.find((m) => m.type === 'fakeFlag')
  const settings = updater(existing?.settings ?? DEFAULT_FAKE_FLAG_SETTINGS)
  const modifiers = existing
    ? o.modifiers!.map((m) => (m.type === 'fakeFlag' ? { ...m, settings } : m))
    : [...(o.modifiers ?? []), { type: 'fakeFlag' as const, settings }]
  return { ...o, modifiers }
}

/** Same idea as `withFakeFlagSettings`, for the `fakePhysics` modifier. */
function withFakePhysicsSettings(o: SceneObject, updater: (settings: FakePhysicsSettings) => FakePhysicsSettings): SceneObject {
  const existing = o.modifiers?.find((m) => m.type === 'fakePhysics')
  const settings = updater(existing?.settings ?? DEFAULT_FAKE_PHYSICS_SETTINGS)
  const modifiers = existing
    ? o.modifiers!.map((m) => (m.type === 'fakePhysics' ? { ...m, settings } : m))
    : [...(o.modifiers ?? []), { type: 'fakePhysics' as const, settings }]
  return { ...o, modifiers }
}

/** Same idea as `withFakeFlagSettings`, for the `fakePhysicsMesh` modifier. */
function withFakePhysicsMeshSettings(
  o: SceneObject,
  updater: (settings: FakePhysicsMeshSettings) => FakePhysicsMeshSettings,
): SceneObject {
  const existing = o.modifiers?.find((m) => m.type === 'fakePhysicsMesh')
  const settings = updater(existing?.settings ?? DEFAULT_FAKE_PHYSICS_MESH_SETTINGS)
  const modifiers = existing
    ? o.modifiers!.map((m) => (m.type === 'fakePhysicsMesh' ? { ...m, settings } : m))
    : [...(o.modifiers ?? []), { type: 'fakePhysicsMesh' as const, settings }]
  return { ...o, modifiers }
}

/** Same idea as `withFakeFlagSettings`, for the `pathDeformRail` modifier. */
function withPathDeformRailSettings(
  o: SceneObject,
  updater: (settings: PathDeformRailSettings) => PathDeformRailSettings,
): SceneObject {
  const existing = o.modifiers?.find((m) => m.type === 'pathDeformRail')
  const settings = updater(existing?.settings ?? DEFAULT_PATH_DEFORM_RAIL_SETTINGS)
  const modifiers = existing
    ? o.modifiers!.map((m) => (m.type === 'pathDeformRail' ? { ...m, settings } : m))
    : [...(o.modifiers ?? []), { type: 'pathDeformRail' as const, settings }]
  return { ...o, modifiers }
}

/** Same idea as `withFakeFlagSettings`, for the `followPath` modifier. */
function withFollowPathSettings(o: SceneObject, updater: (settings: FollowPathSettings) => FollowPathSettings): SceneObject {
  const existing = o.modifiers?.find((m) => m.type === 'followPath')
  const settings = updater(existing?.settings ?? DEFAULT_FOLLOW_PATH_SETTINGS)
  const modifiers = existing
    ? o.modifiers!.map((m) => (m.type === 'followPath' ? { ...m, settings } : m))
    : [...(o.modifiers ?? []), { type: 'followPath' as const, settings }]
  return { ...o, modifiers }
}

/** Same idea as `withFakeFlagSettings`, for the `volumePreserve` modifier. */
function withVolumePreserveSettings(
  o: SceneObject,
  updater: (settings: VolumePreserveSettings) => VolumePreserveSettings,
): SceneObject {
  const existing = o.modifiers?.find((m) => m.type === 'volumePreserve')
  const settings = updater(existing?.settings ?? DEFAULT_VOLUME_PRESERVE_SETTINGS)
  const modifiers = existing
    ? o.modifiers!.map((m) => (m.type === 'volumePreserve' ? { ...m, settings } : m))
    : [...(o.modifiers ?? []), { type: 'volumePreserve' as const, settings }]
  return { ...o, modifiers }
}

/** Same idea as `withFakeFlagSettings`, for the `ffd` modifier. */
function withFfdSettings(o: SceneObject, updater: (settings: FfdSettings) => FfdSettings): SceneObject {
  const existing = o.modifiers?.find((m) => m.type === 'ffd')
  const settings = updater(existing?.settings ?? DEFAULT_FFD_SETTINGS)
  const modifiers = existing
    ? o.modifiers!.map((m) => (m.type === 'ffd' ? { ...m, settings } : m))
    : [...(o.modifiers ?? []), { type: 'ffd' as const, settings }]
  return { ...o, modifiers }
}

/** Same idea as `withFakeFlagSettings`, for the `fakeBehind` modifier. */
function withFakeBehindSettings(o: SceneObject, updater: (settings: FakeBehindSettings) => FakeBehindSettings): SceneObject {
  const existing = o.modifiers?.find((m) => m.type === 'fakeBehind')
  const settings = updater(existing?.settings ?? DEFAULT_FAKE_BEHIND_SETTINGS)
  const modifiers = existing
    ? o.modifiers!.map((m) => (m.type === 'fakeBehind' ? { ...m, settings } : m))
    : [...(o.modifiers ?? []), { type: 'fakeBehind' as const, settings }]
  return { ...o, modifiers }
}

/** Moves `o`'s Head to `localHead` while keeping the mesh visually in place — compensates
 *  `transform.x`/`y` by however far the head moved, transformed through the current rotation/
 *  scale, so this is a pure "which point is the pivot" change, not a visible shift. Used by
 *  `setHead` (user drag/Properties edit). */
function withHeadAt(o: SceneObject, localHead: Vec2): SceneObject {
  const clamped = clampToMesh(o.mesh, localHead)
  const t = o.transform
  const dx = clamped.x - t.head.x
  const dy = clamped.y - t.head.y
  const sx = dx * t.scaleX
  const sy = dy * t.scaleY
  const cos = Math.cos(t.rotation)
  const sin = Math.sin(t.rotation)
  return {
    ...o,
    transform: {
      ...t,
      head: clamped,
      x: t.x + (sx * cos - sy * sin),
      y: t.y + (sx * sin + sy * cos),
    },
  }
}

/** Runs `simulateFakePhysicsChain` rooted at `rootObjectId` and turns the result into
 *  `ObjectAnimationTrack`s ready to merge into a clip's `fakePhysicsTracks` — the shared core
 *  behind `bakeFakePhysics` (one root) and `bakeAllFakePhysics` (every root candidate in the
 *  scene). Empty array if nothing simulates (e.g. no enabled-modifier descendants). */
function buildFakePhysicsTracksForRoot(
  objects: SceneObject[],
  clip: AnimationClip,
  rootObjectId: string,
  frameCount: number,
  cycle: { duration: number } | undefined,
): ObjectAnimationTrack[] {
  const simulated = simulateFakePhysicsChain(objects, clip, rootObjectId)
  const newTracks: ObjectAnimationTrack[] = []
  simulated.forEach((signal, objectId) => {
    const obj = objects.find((o) => o.id === objectId)
    if (!obj) return
    const baseTrack = clip.tracks.find((t) => t.objectId === objectId)
    const keyframes = signal.rotation.map((rotation, f) => {
      const time = (f / frameCount) * clip.duration
      const baseTransform = (baseTrack && sampleTrack(baseTrack, time, cycle)) ?? obj.transform
      return {
        id: genId('fpkey'),
        time,
        transform: { ...baseTransform, x: signal.x[f], y: signal.y[f], rotation },
        easing: 'linear' as const,
      }
    })
    newTracks.push({ objectId, keyframes })
  })
  return newTracks
}

/** Same idea as `buildFakePhysicsTracksForRoot`, for one object's `simulateFakePhysicsMeshSections`
 *  — the shared core behind `bakeFakePhysicsMesh` and `bakeAllFakePhysics`. */
function buildFakePhysicsMeshTracksForObject(
  allObjects: SceneObject[],
  obj: SceneObject,
  clip: AnimationClip,
  frameCount: number,
): FakePhysicsMeshTrack[] {
  const simulated = simulateFakePhysicsMeshSections(allObjects, obj, clip)
  const newTracks: FakePhysicsMeshTrack[] = []
  simulated.forEach((signal, section) => {
    const keyframes = signal.rotation.map((rotation, f) => ({
      id: genId('fpmkey'),
      time: (f / frameCount) * clip.duration,
      transform: { x: signal.x[f], y: signal.y[f], rotation, scaleX: 1, scaleY: 1, head: { x: 0, y: 0 } },
      easing: 'linear' as const,
    }))
    newTracks.push({ objectId: obj.id, section, keyframes })
  })
  return newTracks
}

const MAX_HISTORY = 50

export const useSceneStore = create<SceneState>((set, get) => ({
  objects: [],
  selectedObjectId: null,
  mode: 'object',
  editElementType: 'vertex',
  selectedVertices: new Set(),
  selectedEdges: new Set(),
  selectedFaces: new Set(),
  editingShapeKeyId: null,
  previewFakeFlag: false,
  previewFakePhysicsMesh: false,
  history: [],
  future: [],
  activeTool: 'select',
  gizmoOrientation: 'local',
  editPivot: null,
  pendingPrimitive: null,
  hairPathConstantWidth: false,
  referenceImage: null,
  meshOpacity: 1,
  gridSubdivisions: 10,
  gridSnapEnabled: false,
  gridVisible: true,
  wireframeVisible: true,
  pixelPreviewEnabled: false,
  pixelPreviewResolution: 64,
  pixelPreviewOffset: { x: 0, y: 0 },
  pixelPreviewPaletteEnabled: false,
  pixelPreviewPaletteSize: 16,
  pixelPreviewOutlineEnabled: false,
  pixelPreviewOutlineColor: '#1a1a1a',
  pixelPreviewOutlineThickness: 1,
  pixelFrame: null,
  clips: [],
  activeClipId: null,
  playheadTime: 0,

  beginChange: () =>
    set((s) => ({
      history: [...s.history.slice(-(MAX_HISTORY - 1)), snapshotScene(s)],
      future: [],
    })),

  undo: () =>
    set((s) => {
      if (s.history.length === 0) return {}
      const prev = s.history[s.history.length - 1]
      return {
        history: s.history.slice(0, -1),
        future: [snapshotScene(s), ...s.future],
        objects: prev.objects,
        clips: prev.clips,
      }
    }),

  redo: () =>
    set((s) => {
      if (s.future.length === 0) return {}
      const next = s.future[0]
      return {
        future: s.future.slice(1),
        history: [...s.history, snapshotScene(s)],
        objects: next.objects,
        clips: next.clips,
      }
    }),

  cancelChange: () =>
    set((s) => {
      if (s.history.length === 0) return {}
      const prev = s.history[s.history.length - 1]
      return { history: s.history.slice(0, -1), objects: prev.objects, clips: prev.clips }
    }),

  addRect: (width, height, segX, segY) => {
    get().beginChange()
    const objects = get().objects
    segX = Math.max(1, Math.floor(segX))
    segY = Math.max(1, Math.floor(segY))
    const mesh = createRectMesh(width, height, segX, segY)
    const obj: SceneObject = {
      id: genId('obj'),
      name: `Rect_${objects.length + 1}`,
      mesh,
      transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, head: { x: 0, y: 0 } },
      zOrder: objects.length,
      visible: true,
      material: { color: DEFAULT_MATERIAL_COLOR },
      uvBaseVertices: seedUvBaseVertices(mesh, undefined),
      tail: { x: 0, y: 0 },
      parentId: null,
      connected: true,
    }
    set({ objects: [...objects, obj], selectedObjectId: obj.id })
  },

  addLattice: (width, height, cols, rows) => {
    get().beginChange()
    const objects = get().objects
    cols = Math.max(2, Math.floor(cols))
    rows = Math.max(2, Math.floor(rows))
    const mesh = createRectMesh(width, height, cols - 1, rows - 1)
    const obj: SceneObject = {
      id: genId('obj'),
      name: `Lattice_${objects.length + 1}`,
      kind: 'lattice',
      latticeCols: cols,
      latticeRows: rows,
      mesh,
      transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, head: { x: 0, y: 0 } },
      zOrder: objects.length,
      visible: true,
      material: { color: DEFAULT_MATERIAL_COLOR },
      // Frozen at creation, not on first FFD assignment — a lattice's whole purpose is being a
      // cage, so there's no reason to wait (see `SceneObject.cageRestVertices`'s doc).
      cageRestVertices: mesh.vertices.map((v) => ({ ...v })),
      tail: { x: 0, y: 0 },
      parentId: null,
      connected: true,
    }
    set({ objects: [...objects, obj], selectedObjectId: obj.id })
  },

  resizeLattice: (id, cols, rows) => {
    get().beginChange()
    cols = Math.max(2, Math.floor(cols))
    rows = Math.max(2, Math.floor(rows))
    set((s) => ({
      objects: s.objects.map((o) => {
        if (o.id !== id || o.kind !== 'lattice') return o
        // Regenerates a fresh, undeformed grid at the new resolution, sized to the lattice's
        // current bounding box — any existing deformation is necessarily discarded, since the old
        // and new topologies don't correspond vertex-for-vertex.
        const bounds = worldBounds(o.mesh.vertices, {
          x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, head: { x: 0, y: 0 },
        })
        const width = Math.max(1, bounds.maxX - bounds.minX)
        const height = Math.max(1, bounds.maxY - bounds.minY)
        const mesh = createRectMesh(width, height, cols - 1, rows - 1)
        return {
          ...o,
          latticeCols: cols,
          latticeRows: rows,
          mesh,
          cageRestVertices: mesh.vertices.map((v) => ({ ...v })),
        }
      }),
    }))
  },

  addCircle: (radius, segments) => {
    get().beginChange()
    const objects = get().objects
    const mesh = createCircleMesh(radius, segments)
    const obj: SceneObject = {
      id: genId('obj'),
      name: `Circle_${objects.length + 1}`,
      mesh,
      transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, head: { x: 0, y: 0 } },
      zOrder: objects.length,
      visible: true,
      material: { color: DEFAULT_MATERIAL_COLOR },
      uvBaseVertices: seedUvBaseVertices(mesh, undefined),
      tail: { x: 0, y: 0 },
      parentId: null,
      connected: true,
    }
    set({ objects: [...objects, obj], selectedObjectId: obj.id })
  },

  addTorso: (width, height) => {
    get().beginChange()
    const objects = get().objects
    const mesh = createRectMesh(width, height, 1, 1)
    const obj: SceneObject = {
      id: genId('obj'),
      name: `Torso_${objects.length + 1}`,
      mesh,
      transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, head: { x: 0, y: -height / 2 } },
      zOrder: objects.length,
      visible: true,
      material: { color: DEFAULT_MATERIAL_COLOR },
      uvBaseVertices: seedUvBaseVertices(mesh, undefined),
      tail: { x: 0, y: height / 2 },
      parentId: null,
      connected: true,
    }
    set({ objects: [...objects, obj], selectedObjectId: obj.id })
  },

  addCharacterHead: (radius) => {
    get().beginChange()
    const objects = get().objects
    const mesh = createCircleMesh(radius, 16)
    const obj: SceneObject = {
      id: genId('obj'),
      name: `Head_${objects.length + 1}`,
      mesh,
      // the neck attaches here, so Head (the pivot) sits at the bottom; Tail sits at the crown in
      // case something (hair, an accessory) ever wants to parent off the top
      transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, head: { x: 0, y: -radius } },
      zOrder: objects.length,
      visible: true,
      material: { color: DEFAULT_MATERIAL_COLOR },
      uvBaseVertices: seedUvBaseVertices(mesh, undefined),
      tail: { x: 0, y: radius },
      parentId: null,
      connected: true,
    }
    set({ objects: [...objects, obj], selectedObjectId: obj.id })
  },

  addLimb: (width, height) => {
    get().beginChange()
    const objects = get().objects
    const mesh = createRectMesh(width, height, 1, 1)
    const obj: SceneObject = {
      id: genId('obj'),
      name: `Limb_${objects.length + 1}`,
      mesh,
      transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, head: { x: 0, y: -height / 2 } },
      zOrder: objects.length,
      visible: true,
      material: { color: DEFAULT_MATERIAL_COLOR },
      uvBaseVertices: seedUvBaseVertices(mesh, undefined),
      tail: { x: 0, y: height / 2 },
      parentId: null,
      connected: true,
    }
    set({ objects: [...objects, obj], selectedObjectId: obj.id })
  },

  addFromPartPreset: (preset) => {
    get().beginChange()
    const objects = get().objects
    // deep-clone the preset's mesh so later edits to the inserted object never mutate the saved
    // preset (and vice versa) — presets live in a separate localStorage-backed store, so nothing
    // else would catch this kind of aliasing
    const mesh: Mesh = structuredClone(preset.mesh)
    const obj: SceneObject = {
      id: genId('obj'),
      name: preset.name,
      mesh,
      transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, head: { ...preset.head } },
      zOrder: objects.length,
      visible: true,
      material: { color: preset.color },
      uvBaseVertices: seedUvBaseVertices(mesh, undefined),
      tail: { ...preset.tail },
      parentId: null,
      connected: true,
    }
    set({ objects: [...objects, obj], selectedObjectId: obj.id })
  },

  addHairPath: (points, width, constantWidth) => {
    get().beginChange()
    const objects = get().objects
    const mesh = createHairPathMesh(points, width, constantWidth)
    const obj: SceneObject = {
      id: genId('obj'),
      name: `HairPath_${objects.length + 1}`,
      mesh,
      transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, head: { x: 0, y: 0 } },
      zOrder: objects.length,
      visible: true,
      material: { color: DEFAULT_MATERIAL_COLOR },
      uvBaseVertices: seedUvBaseVertices(mesh, undefined),
      tail: { x: 0, y: 0 },
      parentId: null,
      connected: true,
    }
    set({ objects: [...objects, obj], selectedObjectId: obj.id })
  },

  addImportedMesh: (mesh, name) => {
    get().beginChange()
    const objects = get().objects
    const prunedMesh = pruneOrphanVertices(mesh) // a malformed OBJ could list vertices no face uses
    const obj: SceneObject = {
      id: genId('obj'),
      name,
      mesh: prunedMesh,
      transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, head: { x: 0, y: 0 } },
      zOrder: objects.length,
      visible: true,
      material: { color: DEFAULT_MATERIAL_COLOR },
      uvBaseVertices: seedUvBaseVertices(prunedMesh, undefined),
      tail: { x: 0, y: 0 },
      parentId: null,
      connected: true,
    }
    set({ objects: [...objects, obj], selectedObjectId: obj.id })
  },

  addEmpty: () => {
    get().beginChange()
    const objects = get().objects
    const obj: SceneObject = {
      id: genId('obj'),
      name: `Empty_${objects.length + 1}`,
      kind: 'empty',
      mesh: { vertices: [], faces: [] },
      transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, head: { x: 0, y: 0 } },
      zOrder: objects.length,
      visible: true,
      material: { color: DEFAULT_MATERIAL_COLOR },
      tail: { x: 0, y: 0 },
      parentId: null,
      connected: true,
    }
    set({ objects: [...objects, obj], selectedObjectId: obj.id })
  },

  addPath: (points) => {
    if (points.length < 2) return
    get().beginChange()
    const objects = get().objects
    const vertices = points.map((p) => ({ ...p }))
    const obj: SceneObject = {
      id: genId('obj'),
      name: `Path_${objects.length + 1}`,
      kind: 'path',
      mesh: { vertices, faces: [] },
      transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, head: { x: 0, y: 0 } },
      zOrder: objects.length,
      visible: true,
      material: { color: DEFAULT_MATERIAL_COLOR },
      tail: { x: 0, y: 0 },
      parentId: null,
      connected: true,
    }
    set({ objects: [...objects, obj], selectedObjectId: obj.id })
  },

  setPathPointPosition: (id, index, localPosition) =>
    set((s) => ({
      objects: s.objects.map((o) => {
        if (o.id !== id) return o
        const vertices = o.mesh.vertices.map((v, i) => (i === index ? localPosition : v))
        return { ...o, mesh: { ...o.mesh, vertices } }
      }),
    })),

  insertPathPoint: (id, index, localPosition) => {
    get().beginChange()
    set((s) => ({
      objects: s.objects.map((o) => {
        if (o.id !== id) return o
        const vertices = [...o.mesh.vertices.slice(0, index), localPosition, ...o.mesh.vertices.slice(index)]
        return { ...o, mesh: { ...o.mesh, vertices } }
      }),
    }))
  },

  removePathPoint: (id, index) => {
    const obj = get().objects.find((o) => o.id === id)
    if (!obj || obj.mesh.vertices.length <= 2) return
    get().beginChange()
    set((s) => ({
      objects: s.objects.map((o) => {
        if (o.id !== id) return o
        const vertices = o.mesh.vertices.filter((_, i) => i !== index)
        return { ...o, mesh: { ...o.mesh, vertices } }
      }),
    }))
  },

  togglePathClosed: (id) => {
    get().beginChange()
    set((s) => ({
      objects: s.objects.map((o) => (o.id === id ? { ...o, closed: !o.closed } : o)),
    }))
  },

  addRectIsland: (objectId, at, width, height, segX, segY) => {
    const obj = get().objects.find((o) => o.id === objectId)
    if (!obj) return
    const mesh = mergeMeshAsIsland(obj.mesh, createRectMesh(width, height, segX, segY), at)
    const uvBaseVertices = seedUvBaseVertices(mesh, obj.uvBaseVertices)
    get().beginChange()
    set((s) => ({ objects: s.objects.map((o) => (o.id === objectId ? { ...o, mesh, uvBaseVertices } : o)) }))
  },

  addCircleIsland: (objectId, at, radius, segments) => {
    const obj = get().objects.find((o) => o.id === objectId)
    if (!obj) return
    const mesh = mergeMeshAsIsland(obj.mesh, createCircleMesh(radius, segments), at)
    const uvBaseVertices = seedUvBaseVertices(mesh, obj.uvBaseVertices)
    get().beginChange()
    set((s) => ({ objects: s.objects.map((o) => (o.id === objectId ? { ...o, mesh, uvBaseVertices } : o)) }))
  },

  addHairPathIsland: (objectId, points, width, constantWidth) => {
    const obj = get().objects.find((o) => o.id === objectId)
    if (!obj) return
    const mesh = mergeMeshAsIsland(obj.mesh, createHairPathMesh(points, width, constantWidth), { x: 0, y: 0 })
    const uvBaseVertices = seedUvBaseVertices(mesh, obj.uvBaseVertices)
    get().beginChange()
    set((s) => ({ objects: s.objects.map((o) => (o.id === objectId ? { ...o, mesh, uvBaseVertices } : o)) }))
  },

  setPendingPrimitive: (pendingPrimitive) => set({ pendingPrimitive }),
  setHairPathConstantWidth: (hairPathConstantWidth) => set({ hairPathConstantWidth }),

  setReferenceImage: (url) =>
    set((s) => ({
      referenceImage: url ? { url, x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, visible: true } : null,
      // removing it while it's the current selection would otherwise leave selectedObjectId
      // pointing at a sentinel nothing can resolve — same cleanup `removeObject` does
      selectedObjectId: !url && s.selectedObjectId === REFERENCE_IMAGE_ID ? null : s.selectedObjectId,
    })),

  setReferenceImageTransform: (transform) =>
    set((s) => (s.referenceImage ? { referenceImage: { ...s.referenceImage, ...transform } } : {})),

  setMeshOpacity: (opacity) => set({ meshOpacity: Math.max(0, Math.min(1, opacity)) }),
  setGridSubdivisions: (n) => set({ gridSubdivisions: Math.max(1, Math.min(100, Math.round(n))) }),
  setGridSnapEnabled: (enabled) => set({ gridSnapEnabled: enabled }),
  setGridVisible: (visible) => set({ gridVisible: visible }),
  setWireframeVisible: (visible) => set({ wireframeVisible: visible }),
  setPixelPreviewEnabled: (enabled) => set({ pixelPreviewEnabled: enabled }),
  setPixelPreviewResolution: (n) => set({ pixelPreviewResolution: Math.max(16, Math.min(1024, Math.round(n / 8) * 8)) }),
  setPixelPreviewOffset: (offset) => set({ pixelPreviewOffset: offset }),
  setPixelPreviewPaletteEnabled: (enabled) => set({ pixelPreviewPaletteEnabled: enabled }),
  setPixelPreviewPaletteSize: (n) => set({ pixelPreviewPaletteSize: Math.max(2, Math.min(64, Math.round(n))) }),
  setPixelPreviewOutlineEnabled: (enabled) => set({ pixelPreviewOutlineEnabled: enabled }),
  setPixelPreviewOutlineColor: (color) => set({ pixelPreviewOutlineColor: color }),
  setPixelPreviewOutlineThickness: (n) => set({ pixelPreviewOutlineThickness: Math.max(1, Math.min(16, Math.round(n))) }),

  togglePixelFrame: () =>
    set((s) => {
      if (s.pixelFrame) return { pixelFrame: null }
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const obj of s.objects) {
        if (!obj.visible || obj.kind === 'empty' || obj.mesh.vertices.length === 0) continue
        const t = getWorldTransform(obj, s.objects)
        const b = worldBounds(boundsVertices(obj), t)
        if (b.minX < minX) minX = b.minX
        if (b.minY < minY) minY = b.minY
        if (b.maxX > maxX) maxX = b.maxX
        if (b.maxY > maxY) maxY = b.maxY
      }
      const hasContent = minX <= maxX
      const margin = 1.1
      const width = hasContent ? (maxX - minX) * margin : 200
      const height = hasContent ? (maxY - minY) * margin : 200
      const x = hasContent ? (minX + maxX) / 2 : 0
      const y = hasContent ? (minY + maxY) / 2 : 0
      return { pixelFrame: { x, y, width, height } }
    }),

  setPixelFrame: (patch) =>
    set((s) => (s.pixelFrame ? { pixelFrame: { ...s.pixelFrame, ...patch } } : s)),

  loadProject: (project) => {
    bumpNextIdPast(project.objects)
    // older saved files predate tail/parentId/connected — backfill so every loaded object has
    // the full shape new code can rely on
    const objects = project.objects.map((o) => {
      const partial = o as Partial<SceneObject> & Pick<SceneObject, 'id' | 'name' | 'mesh' | 'transform' | 'zOrder' | 'visible' | 'material'>
      return {
        tail: { x: 0, y: 0 },
        parentId: null,
        connected: true,
        ...partial,
      }
    })
    // older saves predate per-clip frame rate
    const clips = (project.clips ?? []).map((c) => {
      const partial = c as Partial<AnimationClip> & Pick<AnimationClip, 'id' | 'name' | 'duration' | 'loopMode' | 'tracks'>
      return { frameRate: 24, ...partial }
    })
    set({
      objects,
      referenceImage: project.referenceImage,
      meshOpacity: project.meshOpacity,
      pixelFrame: project.pixelFrame ?? null,
      selectedObjectId: null,
      selectedVertices: new Set(),
      selectedEdges: new Set(),
      selectedFaces: new Set(),
      mode: 'object',
      editPivot: null,
      activeTool: 'select',
      history: [],
      future: [],
      clips,
      activeClipId: clips[0]?.id ?? null,
      playheadTime: 0,
    })
  },

  selectObject: (id) => set({ selectedObjectId: id, selectedVertices: new Set(), editPivot: null }),

  removeObject: (id) => {
    get().beginChange()
    set((s) => ({
      objects: s.objects.filter((o) => o.id !== id),
      selectedObjectId: s.selectedObjectId === id ? null : s.selectedObjectId,
      // drop every clip's keyframe data for this object too — otherwise a deleted object's
      // tracks linger forever across every clip, showing as an un-clickable "(deleted object)"
      // row in the Timeline with no way to clear it.
      clips: s.clips.map((c) => ({
        ...c,
        tracks: c.tracks.filter((t) => t.objectId !== id),
        shapeKeyTracks: c.shapeKeyTracks?.filter((t) => t.objectId !== id),
        fakePhysicsTracks: c.fakePhysicsTracks?.filter((t) => t.objectId !== id),
        fakePhysicsMeshTracks: c.fakePhysicsMeshTracks?.filter((t) => t.objectId !== id),
        pathOffsetTracks: c.pathOffsetTracks?.filter((t) => t.objectId !== id),
        followPathProgressTracks: c.followPathProgressTracks?.filter((t) => t.objectId !== id),
      })),
    }))
  },

  toggleVisibility: (id) => {
    get().beginChange()
    set((s) => ({
      objects: s.objects.map((o) => (o.id === id ? { ...o, visible: !o.visible } : o)),
    }))
  },

  renameObject: (id, name) =>
    set((s) => ({ objects: s.objects.map((o) => (o.id === id ? { ...o, name } : o)) })),

  setMaterialColor: (id, color) =>
    set((s) => ({
      objects: s.objects.map((o) => (o.id === id ? { ...o, material: { ...o.material, color } } : o)),
    })),

  setFaceColor: (id, faceIndices, color) =>
    set((s) => ({
      objects: s.objects.map((o) => {
        if (o.id !== id) return o
        const faceColors = { ...o.mesh.faceColors }
        for (const fi of faceIndices) faceColors[fi] = color
        return { ...o, mesh: { ...o.mesh, faceColors } }
      }),
    })),

  clearFaceColor: (id, faceIndices) => {
    get().beginChange()
    set((s) => ({
      objects: s.objects.map((o) => {
        if (o.id !== id) return o
        const faceColors = { ...o.mesh.faceColors }
        for (const fi of faceIndices) delete faceColors[fi]
        return { ...o, mesh: { ...o.mesh, faceColors } }
      }),
    }))
  },

  setMaterialTexture: (id, textureUrl) => {
    get().beginChange()
    set((s) => ({
      objects: s.objects.map((o) => {
        if (o.id !== id) return o
        // the default tint multiplies the texture and visibly discolors it — switch to white
        // the first time a texture is applied, but leave an intentionally customized color alone
        const color = textureUrl && o.material.color === DEFAULT_MATERIAL_COLOR ? '#FFFFFF' : o.material.color
        return { ...o, material: { ...o.material, color, textureUrl } }
      }),
    }))
  },

  setUvIslandTransform: (id, islandIndex, transform) => {
    // never let a bad numeric computation (NaN/Infinity) get written — it would otherwise
    // persist forever, since reads merge stored values in rather than always trusting a fresh default
    const clean = Object.fromEntries(
      Object.entries(transform).filter(
        ([, v]) => typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)),
      ),
    )
    if (Object.keys(clean).length === 0) return
    set((s) => ({
      objects: s.objects.map((o) => {
        if (o.id !== id) return o
        const next = [...(o.uvIslandTransforms ?? [])]
        while (next.length <= islandIndex) next.push({ offsetX: 0, offsetY: 0, scale: 1, rotation: 0 })
        next[islandIndex] = { ...next[islandIndex], ...clean }
        return { ...o, uvIslandTransforms: next }
      }),
    }))
  },

  moveIslandZOrder: (id, islandIndex, direction) => {
    const obj = get().objects.find((o) => o.id === id)
    if (!obj) return
    const islandCount = findIslands(obj.mesh).length
    // islands swap ranks with whichever neighbor is adjacent in the *combined* island+insert-slot
    // order, not just other islands — otherwise an island next to an insert slot in the displayed
    // list wouldn't actually be swappable with it
    type Entry = { kind: 'island'; index: number; rank: number } | { kind: 'slot'; slotId: string; rank: number }
    const entries: Entry[] = [
      ...Array.from({ length: islandCount }, (_, i) => ({ kind: 'island' as const, index: i, rank: obj.islandZOrders?.[i] ?? i })),
      ...(obj.insertSlots ?? []).map((s) => ({ kind: 'slot' as const, slotId: s.id, rank: s.rank })),
    ]
    entries.sort((a, b) => a.rank - b.rank)
    const pos = entries.findIndex((e) => e.kind === 'island' && e.index === islandIndex)
    const swapWith = pos + direction
    if (pos === -1 || swapWith < 0 || swapWith >= entries.length) return
    const self = entries[pos]
    const other = entries[swapWith]
    get().beginChange()
    set((s) => ({
      objects: s.objects.map((o) => {
        if (o.id !== id) return o
        const islandZOrders =
          other.kind === 'island' ? { ...o.islandZOrders, [islandIndex]: other.rank, [other.index]: self.rank } : { ...o.islandZOrders, [islandIndex]: other.rank }
        const insertSlots =
          other.kind === 'slot' ? (o.insertSlots ?? []).map((sl) => (sl.id === other.slotId ? { ...sl, rank: self.rank } : sl)) : o.insertSlots
        return { ...o, islandZOrders, insertSlots }
      }),
    }))
  },

  setIslandName: (id, islandIndex, name) => {
    get().beginChange()
    // stores the raw value as typed (even empty) rather than immediately falling back to the
    // default "アイランド N" label — that fallback only happens on blur (see
    // `clearIslandNameIfEmpty`), otherwise the input field would jump back to the default text
    // the instant it's fully backspaced, fighting the user mid-edit.
    set((s) => ({
      objects: s.objects.map((o) => (o.id === id ? { ...o, islandNames: { ...o.islandNames, [islandIndex]: name } } : o)),
    }))
  },

  clearIslandNameIfEmpty: (id, islandIndex) => {
    set((s) => ({
      objects: s.objects.map((o) => {
        if (o.id !== id) return o
        const current = o.islandNames?.[islandIndex]
        if (current === undefined || current.trim() !== '') return o
        const next = { ...o.islandNames }
        delete next[islandIndex]
        return { ...o, islandNames: next }
      }),
    }))
  },

  setShowIslandNames: (id, show) => {
    set((s) => ({
      objects: s.objects.map((o) => (o.id === id ? { ...o, showIslandNames: show } : o)),
    }))
  },

  toggleIslandVisible: (id, islandIndex) => {
    get().beginChange()
    set((s) => ({
      objects: s.objects.map((o) =>
        o.id === id
          ? { ...o, islandVisible: { ...o.islandVisible, [islandIndex]: !(o.islandVisible?.[islandIndex] ?? true) } }
          : o,
      ),
    }))
  },

  toggleIslandLocked: (id, islandIndex) => {
    get().beginChange()
    set((s) => ({
      objects: s.objects.map((o) =>
        o.id === id
          ? { ...o, islandLocked: { ...o.islandLocked, [islandIndex]: !(o.islandLocked?.[islandIndex] ?? false) } }
          : o,
      ),
    }))
  },

  setSlotName: (id, slotName) => {
    get().beginChange()
    set((s) => ({
      objects: s.objects.map((o) => {
        if (o.id === id) return { ...o, slotName }
        if (slotName && o.slotName === slotName) return { ...o, slotName: '' }
        return o
      }),
    }))
  },

  addInsertSlot: (id) => {
    const obj = get().objects.find((o) => o.id === id)
    if (!obj) return
    const islandCount = findIslands(obj.mesh).length
    const islandRanks = Array.from({ length: islandCount }, (_, i) => obj.islandZOrders?.[i] ?? i)
    const slotRanks = (obj.insertSlots ?? []).map((s) => s.rank)
    const maxRank = Math.max(-1, ...islandRanks, ...slotRanks)
    const newSlot: InsertSlot = { id: genId('slot'), rank: maxRank + 1, targetSlotName: '' }
    get().beginChange()
    set((s) => ({
      objects: s.objects.map((o) => (o.id === id ? { ...o, insertSlots: [...(o.insertSlots ?? []), newSlot] } : o)),
    }))
  },

  removeInsertSlot: (id, slotId) => {
    get().beginChange()
    set((s) => ({
      objects: s.objects.map((o) =>
        o.id === id ? { ...o, insertSlots: (o.insertSlots ?? []).filter((slot) => slot.id !== slotId) } : o,
      ),
    }))
  },

  setInsertSlotTarget: (id, slotId, targetSlotName) => {
    get().beginChange()
    set((s) => ({
      objects: s.objects.map((o) =>
        o.id === id
          ? { ...o, insertSlots: (o.insertSlots ?? []).map((slot) => (slot.id === slotId ? { ...slot, targetSlotName } : slot)) }
          : o,
      ),
    }))
  },

  moveInsertSlotRank: (id, slotId, direction) => {
    const obj = get().objects.find((o) => o.id === id)
    if (!obj) return
    const islandCount = findIslands(obj.mesh).length
    type Entry = { kind: 'island'; index: number; rank: number } | { kind: 'slot'; slotId: string; rank: number }
    const entries: Entry[] = [
      ...Array.from({ length: islandCount }, (_, i) => ({ kind: 'island' as const, index: i, rank: obj.islandZOrders?.[i] ?? i })),
      ...(obj.insertSlots ?? []).map((s) => ({ kind: 'slot' as const, slotId: s.id, rank: s.rank })),
    ]
    entries.sort((a, b) => a.rank - b.rank)
    const pos = entries.findIndex((e) => e.kind === 'slot' && e.slotId === slotId)
    const swapWith = pos + direction
    if (pos === -1 || swapWith < 0 || swapWith >= entries.length) return
    const self = entries[pos]
    const other = entries[swapWith]
    get().beginChange()
    set((s) => ({
      objects: s.objects.map((o) => {
        if (o.id !== id) return o
        const islandZOrders = other.kind === 'island' ? { ...o.islandZOrders, [other.index]: self.rank } : o.islandZOrders
        const insertSlots = (o.insertSlots ?? []).map((sl) => {
          if (sl.id === slotId) return { ...sl, rank: other.rank }
          if (other.kind === 'slot' && sl.id === other.slotId) return { ...sl, rank: self.rank }
          return sl
        })
        return { ...o, islandZOrders, insertSlots }
      }),
    }))
  },

  addShapeKey: (id) => {
    get().beginChange()
    set((s) => ({
      objects: s.objects.map((o) => {
        if (o.id !== id) return o
        const n = (o.shapeKeys?.length ?? 0) + 1
        const key: ShapeKey = { id: genId('shapekey'), name: `Key ${n}`, positions: {} }
        return { ...o, shapeKeys: [...(o.shapeKeys ?? []), key] }
      }),
    }))
  },

  removeShapeKey: (id, keyId) => {
    get().beginChange()
    set((s) => ({
      editingShapeKeyId: s.editingShapeKeyId === keyId ? null : s.editingShapeKeyId,
      objects: s.objects.map((o) => {
        if (o.id !== id) return o
        const { [keyId]: _removed, ...restValues } = o.shapeKeyValues ?? {}
        return { ...o, shapeKeys: (o.shapeKeys ?? []).filter((k) => k.id !== keyId), shapeKeyValues: restValues }
      }),
    }))
  },

  renameShapeKey: (id, keyId, name) => {
    set((s) => ({
      objects: s.objects.map((o) =>
        o.id === id
          ? { ...o, shapeKeys: (o.shapeKeys ?? []).map((k) => (k.id === keyId ? { ...k, name } : k)) }
          : o,
      ),
    }))
  },

  setShapeKeyValue: (id, keyId, value) => {
    get().beginChange()
    set((s) => ({
      objects: s.objects.map((o) =>
        o.id === id ? { ...o, shapeKeyValues: { ...o.shapeKeyValues, [keyId]: value } } : o,
      ),
    }))
  },

  setShapeKeyInterpolation: (id, keyId, interpolation) => {
    get().beginChange()
    set((s) => ({
      objects: s.objects.map((o) =>
        o.id === id
          ? { ...o, shapeKeys: (o.shapeKeys ?? []).map((k) => (k.id === keyId ? { ...k, interpolation } : k)) }
          : o,
      ),
    }))
  },

  setShapeKeyArcPivot: (id, keyId, pivot) => {
    set((s) => ({
      objects: s.objects.map((o) =>
        o.id === id
          ? { ...o, shapeKeys: (o.shapeKeys ?? []).map((k) => (k.id === keyId ? { ...k, arcPivot: pivot } : k)) }
          : o,
      ),
    }))
  },

  setEditingShapeKey: (keyId) => {
    set({
      editingShapeKeyId: keyId,
      selectedVertices: new Set(),
      selectedEdges: new Set(),
      selectedFaces: new Set(),
    })
  },

  freezeUvBaseVertices: (id, indices) =>
    set((s) => ({
      objects: s.objects.map((o) => {
        if (o.id !== id) return o
        const next = { ...(o.uvBaseVertices ?? {}) }
        for (const i of indices) {
          const v = o.mesh.vertices[i]
          if (v) next[i] = { x: v.x, y: v.y }
        }
        return { ...o, uvBaseVertices: next }
      }),
    })),

  reunwrapUVs: (id) => {
    get().beginChange()
    set((s) => ({
      objects: s.objects.map((o) => {
        if (o.id !== id) return o
        const uvBaseVertices: Record<number, Vec2> = {}
        o.mesh.vertices.forEach((v, i) => {
          uvBaseVertices[i] = { x: v.x, y: v.y }
        })
        return { ...o, uvBaseVertices }
      }),
    }))
  },

  setTransform: (id, transform) =>
    set((s) => ({
      objects: s.objects.map((o) =>
        o.id === id ? { ...o, transform: { ...o.transform, ...transform } } : o,
      ),
    })),

  setHead: (id, localHead) =>
    set((s) => ({
      objects: s.objects.map((o) => (o.id === id ? withHeadAt(o, localHead) : o)),
    })),

  setTail: (id, localTail) => {
    get().beginChange()
    set((s) => ({
      objects: s.objects.map((o) => (o.id === id ? { ...o, tail: clampToMesh(o.mesh, localTail) } : o)),
    }))
  },

  setParent: (id, parentId) => {
    if (parentId !== null) {
      // reject if walking up from parentId reaches id (would create a cycle)
      const byId = new Map(get().objects.map((o) => [o.id, o]))
      const visited = new Set<string>()
      let cur: string | null = parentId
      while (cur !== null) {
        if (cur === id) return // cycle — reject
        if (visited.has(cur)) break // already-corrupted chain elsewhere; don't loop forever
        visited.add(cur)
        cur = byId.get(cur)?.parentId ?? null
      }
    }
    get().beginChange()
    set((s) => ({
      objects: s.objects.map((o) => (o.id === id ? { ...o, parentId } : o)),
    }))
  },

  setConnected: (id, connected) => {
    get().beginChange()
    set((s) => ({
      objects: s.objects.map((o) => {
        if (o.id !== id) return o
        if (connected) return { ...o, connected }
        // a connected child's own transform.x/y is ignored entirely (forced to the parent's
        // tail — see getWorldTransform), so it can be stale (e.g. left over from before this
        // object was ever parented, or from a previous disconnect/reconnect); recompute it from
        // where the object is actually sitting right now, or disconnecting would suddenly reveal
        // that stale offset as a jump instead of leaving the object exactly where it visibly was
        const { transform: parentWorld, tail: parentTail } = getParentWorldTransform(o, s.objects)
        const currentWorld = getWorldTransform(o, s.objects)
        const localXY = worldPositionToLocalOffset({ x: currentWorld.x, y: currentWorld.y }, parentWorld, parentTail)
        return { ...o, connected, transform: { ...o.transform, x: localXY.x, y: localXY.y } }
      }),
    }))
  },

  reorder: (id, newZOrder) => {
    get().beginChange()
    set((s) => {
      const objects = [...s.objects].sort((a, b) => a.zOrder - b.zOrder)
      const idx = objects.findIndex((o) => o.id === id)
      if (idx === -1) return {}
      const [item] = objects.splice(idx, 1)
      objects.splice(Math.max(0, Math.min(newZOrder, objects.length)), 0, item)
      objects.forEach((o, i) => (o.zOrder = i))
      return { objects }
    })
  },

  setMode: (mode) => {
    // an Empty has no mesh to edit — block entering edit mode for one (pivot mode, which only
    // touches transform.head/tail, is still allowed)
    if (mode === 'edit') {
      const obj = get().objects.find((o) => o.id === get().selectedObjectId)
      if (obj?.kind === 'empty') return
    }
    set({
      mode,
      selectedVertices: new Set(),
      selectedEdges: new Set(),
      selectedFaces: new Set(),
      editPivot: null,
    })
  },
  setEditElementType: (editElementType) =>
    set({ editElementType, selectedVertices: new Set(), selectedEdges: new Set(), selectedFaces: new Set() }),
  setSelectedVertices: (selectedVertices) => set({ selectedVertices }),
  setSelectedEdges: (selectedEdges) => set({ selectedEdges }),
  setSelectedFaces: (selectedFaces) => set({ selectedFaces }),

  setVertexPositions: (objectId, indices, positions) =>
    set((s) => ({
      objects: s.objects.map((o) => {
        if (o.id !== objectId) return o
        const overrides = new Map(indices.map((idx, k) => [idx, positions[k]]))
        // while sculpting a shape key, grab/move writes into that key's own sparse pose instead
        // of the Basis (`mesh.vertices`) — keeps the Basis and every other key untouched
        if (s.editingShapeKeyId) {
          const key = o.shapeKeys?.find((k) => k.id === s.editingShapeKeyId)
          if (!key) return o
          const nextPositions = { ...key.positions }
          overrides.forEach((pos, i) => (nextPositions[i] = pos))
          return {
            ...o,
            shapeKeys: o.shapeKeys!.map((k) => (k.id === key.id ? { ...k, positions: nextPositions } : k)),
          }
        }
        const vertices = o.mesh.vertices.map((v, i) => overrides.get(i) ?? v)
        return { ...o, mesh: { ...o.mesh, vertices } }
      }),
    })),

  setEditPivotFromSelection: () => {
    const s = get()
    const obj = s.objects.find((o) => o.id === s.selectedObjectId)
    if (!obj) return
    const indices = selectedVertexIndices(s, obj.mesh)
    if (indices.length === 0) return
    let sx = 0
    let sy = 0
    for (const i of indices) {
      sx += obj.mesh.vertices[i].x
      sy += obj.mesh.vertices[i].y
    }
    set({ editPivot: { x: sx / indices.length, y: sy / indices.length } })
  },

  setActiveTool: (activeTool) => set({ activeTool }),
  setGizmoOrientation: (gizmoOrientation) => set({ gizmoOrientation }),

  applyLoopCut: (objectId, edgeA, edgeB, ts) => {
    // topology tools are Basis-only — a shape key can only reposition existing vertices
    if (get().editingShapeKeyId) return
    const obj = get().objects.find((o) => o.id === objectId)
    if (!obj) return
    const path = findFullLoop(obj.mesh, edgeA, edgeB)
    if (!path) return
    const result = applyLoopCutToMesh(obj.mesh, path, ts)
    const mesh = pruneOrphanVertices(result.mesh)
    const uvBaseVertices = seedUvBaseVertices(mesh, obj.uvBaseVertices)

    get().beginChange()
    set((s) => ({
      objects: s.objects.map((o) => (o.id === objectId ? { ...o, mesh, uvBaseVertices } : o)),
      selectedVertices: new Set(),
      selectedEdges: new Set(),
      selectedFaces: new Set(),
    }))
  },

  applyRingCut: (objectId, center, hoverRim, ts) => {
    if (get().editingShapeKeyId) return
    const obj = get().objects.find((o) => o.id === objectId)
    if (!obj) return
    const path = findFan(obj.mesh, center, hoverRim)
    if (!path) return
    const result = applyRingCutToMesh(obj.mesh, path, ts)
    const mesh = pruneOrphanVertices(result.mesh)
    const uvBaseVertices = seedUvBaseVertices(mesh, obj.uvBaseVertices)

    get().beginChange()
    set((s) => ({
      objects: s.objects.map((o) => (o.id === objectId ? { ...o, mesh, uvBaseVertices } : o)),
      selectedVertices: new Set(),
      selectedEdges: new Set(),
      selectedFaces: new Set(),
    }))
  },

  applyKnifeCut: (objectId, path) => {
    if (get().editingShapeKeyId) return
    const obj = get().objects.find((o) => o.id === objectId)
    if (!obj || path.length < 2) return
    const result = applyKnifeCutToMesh(obj.mesh, path)
    const mesh = pruneOrphanVertices(result.mesh)
    const uvBaseVertices = seedUvBaseVertices(mesh, obj.uvBaseVertices)

    get().beginChange()
    set((s) => ({
      objects: s.objects.map((o) => (o.id === objectId ? { ...o, mesh, uvBaseVertices } : o)),
      selectedVertices: new Set(),
      selectedEdges: new Set(),
      selectedFaces: new Set(),
    }))
  },

  extrudeSelection: () => {
    const s = get()
    if (s.editingShapeKeyId) return false
    const objectId = s.selectedObjectId
    if (!objectId) return false
    const obj = s.objects.find((o) => o.id === objectId)
    if (!obj || obj.kind === 'lattice') return false

    let edgeKeys: string[]
    if (s.editElementType === 'edge' && s.selectedEdges.size > 0) {
      edgeKeys = Array.from(s.selectedEdges)
    } else if (s.editElementType === 'vertex' && s.selectedVertices.size >= 2) {
      // extrude whichever existing mesh edges connect two selected vertices
      edgeKeys = getEdges(obj.mesh)
        .filter(([a, b]) => s.selectedVertices.has(a) && s.selectedVertices.has(b))
        .map(([a, b]) => edgeKey(a, b))
      if (edgeKeys.length === 0) return false
    } else {
      return false
    }
    const wasEdgeMode = s.editElementType === 'edge'
    const result = extrudeEdges(obj.mesh, edgeKeys)
    // extrude never orphans a vertex by construction, so this is a no-op safety net
    const mesh = pruneOrphanVertices(result.mesh)

    get().beginChange()
    set((st) => ({
      objects: st.objects.map((o) => (o.id === objectId ? { ...o, mesh } : o)),
      // stay in whichever mode the extrude was triggered from, selecting the new geometry
      // (new edges in edge mode, new vertices in vertex mode) so a follow-up G/R/S/E acts on it
      editElementType: wasEdgeMode ? 'edge' : 'vertex',
      selectedVertices: wasEdgeMode ? new Set<number>() : new Set(result.newVertexIndices),
      selectedEdges: wasEdgeMode ? new Set(result.newEdgeKeys) : new Set<string>(),
      selectedFaces: new Set(),
    }))
    return true
  },

  deleteSelection: () => {
    const s = get()
    if (s.editingShapeKeyId) return
    const objectId = s.selectedObjectId
    if (!objectId) return
    const obj = s.objects.find((o) => o.id === objectId)
    if (!obj || obj.kind === 'lattice') return

    let mesh: Mesh
    let oldToNew: Map<number, number>
    if (s.editElementType === 'vertex') {
      if (s.selectedVertices.size === 0) return
      ;({ mesh, oldToNew } = deleteVertices(obj.mesh, Array.from(s.selectedVertices)))
    } else if (s.editElementType === 'edge') {
      if (s.selectedEdges.size === 0) return
      ;({ mesh, oldToNew } = pruneOrphanVerticesTracked(deleteEdges(obj.mesh, Array.from(s.selectedEdges))))
    } else {
      if (s.selectedFaces.size === 0) return
      ;({ mesh, oldToNew } = pruneOrphanVerticesTracked(deleteFaces(obj.mesh, Array.from(s.selectedFaces))))
    }

    get().beginChange()
    // an object with no faces renders nothing and (without a vertex/face-building tool)
    // can't be made useful again, so remove it outright rather than leaving an empty husk
    if (mesh.faces.length === 0) {
      set((st) => ({
        objects: st.objects.filter((o) => o.id !== objectId),
        selectedObjectId: null,
        mode: 'object',
        selectedVertices: new Set(),
        selectedEdges: new Set(),
        selectedFaces: new Set(),
      }))
      return
    }

    set((st) => ({
      objects: st.objects.map((o) =>
        o.id === objectId ? { ...o, mesh, ...remapObjectVertexData(o, oldToNew) } : o,
      ),
      selectedVertices: new Set(),
      selectedEdges: new Set(),
      selectedFaces: new Set(),
    }))
  },

  dissolveSelection: () => {
    const s = get()
    if (s.editingShapeKeyId) return
    const objectId = s.selectedObjectId
    if (!objectId) return
    const obj = s.objects.find((o) => o.id === objectId)
    if (!obj || obj.kind === 'lattice') return

    let mesh: Mesh
    let oldToNew: Map<number, number>
    if (s.editElementType === 'vertex') {
      if (s.selectedVertices.size === 0) return
      ;({ mesh, oldToNew } = dissolveVertices(obj.mesh, Array.from(s.selectedVertices)))
    } else if (s.editElementType === 'edge') {
      if (s.selectedEdges.size === 0) return
      ;({ mesh, oldToNew } = dissolveEdges(obj.mesh, Array.from(s.selectedEdges)))
    } else {
      return // dissolve has no distinct meaning in face mode — use delete instead
    }

    get().beginChange()
    // an object with no faces renders nothing and (without a vertex/face-building tool) can't
    // be made useful again, so remove it outright rather than leaving an empty husk
    if (mesh.faces.length === 0) {
      set((st) => ({
        objects: st.objects.filter((o) => o.id !== objectId),
        selectedObjectId: null,
        mode: 'object',
        selectedVertices: new Set(),
        selectedEdges: new Set(),
        selectedFaces: new Set(),
      }))
      return
    }

    set((st) => ({
      objects: st.objects.map((o) =>
        o.id === objectId ? { ...o, mesh, ...remapObjectVertexData(o, oldToNew) } : o,
      ),
      selectedVertices: new Set(),
      selectedEdges: new Set(),
      selectedFaces: new Set(),
    }))
  },

  selectAll: () => {
    const s = get()
    const obj = s.objects.find((o) => o.id === s.selectedObjectId)
    if (!obj) return
    if (s.editElementType === 'vertex') {
      set({ selectedVertices: new Set(obj.mesh.vertices.map((_, i) => i)) })
    } else if (s.editElementType === 'edge') {
      set({ selectedEdges: new Set(getEdges(obj.mesh).map(([a, b]) => edgeKey(a, b))) })
    } else {
      set({ selectedFaces: new Set(obj.mesh.faces.map((_, i) => i)) })
    }
  },

  invertSelection: () => {
    const s = get()
    const obj = s.objects.find((o) => o.id === s.selectedObjectId)
    if (!obj) return
    if (s.editElementType === 'vertex') {
      const next = new Set(obj.mesh.vertices.map((_, i) => i).filter((i) => !s.selectedVertices.has(i)))
      set({ selectedVertices: next })
    } else if (s.editElementType === 'edge') {
      const allKeys = getEdges(obj.mesh).map(([a, b]) => edgeKey(a, b))
      set({ selectedEdges: new Set(allKeys.filter((k) => !s.selectedEdges.has(k))) })
    } else {
      const next = new Set(obj.mesh.faces.map((_, i) => i).filter((i) => !s.selectedFaces.has(i)))
      set({ selectedFaces: next })
    }
  },

  selectLinked: () => {
    const s = get()
    const obj = s.objects.find((o) => o.id === s.selectedObjectId)
    if (!obj) return
    const islands = findIslands(obj.mesh)

    const touched = new Set<number>()
    if (s.editElementType === 'vertex') {
      islands.forEach((island, i) => {
        if (island.vertices.some((v) => s.selectedVertices.has(v))) touched.add(i)
      })
    } else if (s.editElementType === 'edge') {
      islands.forEach((island, i) => {
        const verts = new Set(island.vertices)
        if (
          Array.from(s.selectedEdges).some((key) => {
            const [a, b] = parseEdgeKey(key)
            return verts.has(a) || verts.has(b)
          })
        ) {
          touched.add(i)
        }
      })
    } else {
      islands.forEach((island, i) => {
        if (island.faces.some((f) => s.selectedFaces.has(f))) touched.add(i)
      })
    }
    if (touched.size === 0) return
    set(islandSelectionState(obj, islands, Array.from(touched)))
  },

  selectIsland: (islandIndex) => {
    const s = get()
    const obj = s.objects.find((o) => o.id === s.selectedObjectId)
    if (!obj) return
    const islands = findIslands(obj.mesh)
    if (!islands[islandIndex]) return
    set({ mode: 'edit', ...islandSelectionState(obj, islands, [islandIndex]) })
  },

  selectFacesByColor: (faceIndices) => {
    const s = get()
    const obj = s.objects.find((o) => o.id === s.selectedObjectId)
    if (!obj) return
    const faces = new Set(faceIndices)
    const vertices = new Set<number>()
    const edges = new Set<string>()
    faces.forEach((fi) => {
      const face = obj.mesh.faces[fi]
      if (!face) return
      for (let i = 0; i < face.length; i++) {
        vertices.add(face[i])
        edges.add(edgeKey(face[i], face[(i + 1) % face.length]))
      }
    })
    set({
      mode: 'edit',
      editElementType: 'face',
      selectedVertices: vertices,
      selectedEdges: edges,
      selectedFaces: faces,
    })
  },

  mergeSelectedVertices: (mode) => {
    const s = get()
    if (s.editingShapeKeyId) return
    const objectId = s.selectedObjectId
    if (!objectId) return
    const obj = s.objects.find((o) => o.id === objectId)
    if (!obj) return
    if (s.editElementType !== 'vertex' || s.selectedVertices.size < 2) return

    // JS Sets preserve insertion order, so this is the actual selection order (click order).
    const orderedIndices = Array.from(s.selectedVertices)
    const { mesh, survivorIndex, oldToNew } = mergeVerticesInMesh(obj.mesh, orderedIndices, mode)

    get().beginChange()
    set((st) => ({
      objects: st.objects.map((o) =>
        o.id === objectId ? { ...o, mesh, ...remapObjectVertexData(o, oldToNew) } : o,
      ),
      selectedVertices: survivorIndex >= 0 ? new Set([survivorIndex]) : new Set(),
      selectedEdges: new Set(),
      selectedFaces: new Set(),
    }))
  },

  fillSelectedFace: () => {
    const s = get()
    if (s.editingShapeKeyId) return
    const objectId = s.selectedObjectId
    if (!objectId) return
    const obj = s.objects.find((o) => o.id === objectId)
    if (!obj) return
    if (s.editElementType !== 'vertex' || s.selectedVertices.size < 3) return

    // JS Sets preserve insertion order — use the click order as the new face's winding,
    // same as Blender's F: select the hole's boundary in order, then fill.
    const orderedIndices = Array.from(s.selectedVertices)
    const newFaceIndex = obj.mesh.faces.length

    get().beginChange()
    set((st) => ({
      objects: st.objects.map((o) =>
        o.id === objectId ? { ...o, mesh: { ...o.mesh, faces: [...o.mesh.faces, orderedIndices] } } : o,
      ),
      selectedFaces: new Set([newFaceIndex]),
    }))
  },

  mergeVertexPair: (objectId, keepIndex, mergeIndex) => {
    if (get().editingShapeKeyId) return
    const obj = get().objects.find((o) => o.id === objectId)
    if (!obj) return
    // no beginChange here: this is called right after a vertex drag, which already opened
    // its own undo step — folding the snap-merge into the same step feels like one action
    const { mesh, survivorIndex, oldToNew } = mergeVerticesInMesh(obj.mesh, [keepIndex, mergeIndex], 'first')
    set((st) => ({
      objects: st.objects.map((o) =>
        o.id === objectId ? { ...o, mesh, ...remapObjectVertexData(o, oldToNew) } : o,
      ),
      selectedVertices: survivorIndex >= 0 ? new Set([survivorIndex]) : new Set(),
      selectedEdges: new Set(),
      selectedFaces: new Set(),
    }))
  },

  addClip: (name) => {
    const id = genId('clip')
    const clip: AnimationClip = {
      id,
      name: name ?? `Clip ${get().clips.length + 1}`,
      duration: 1,
      loopMode: 'loop',
      frameRate: 24,
      tracks: [],
    }
    set((s) => ({ clips: [...s.clips, clip], activeClipId: id, playheadTime: 0 }))
    return id
  },

  removeClip: (id) =>
    set((s) => {
      const clips = s.clips.filter((c) => c.id !== id)
      const activeClipId = s.activeClipId === id ? (clips[0]?.id ?? null) : s.activeClipId
      return { clips, activeClipId }
    }),

  renameClip: (id, name) =>
    set((s) => ({ clips: s.clips.map((c) => (c.id === id ? { ...c, name } : c)) })),

  setActiveClipId: (id) => set({ activeClipId: id, playheadTime: 0 }),

  setClipDuration: (id, duration) =>
    set((s) => ({ clips: s.clips.map((c) => (c.id === id ? { ...c, duration: Math.max(0, duration) } : c)) })),

  setClipLoopMode: (id, loopMode) =>
    set((s) => ({ clips: s.clips.map((c) => (c.id === id ? { ...c, loopMode } : c)) })),

  setClipFrameRate: (id, frameRate) =>
    set((s) => ({
      clips: s.clips.map((c) => (c.id === id ? { ...c, frameRate: Math.max(1, Math.round(frameRate)) } : c)),
    })),

  insertKeyframe: (objectId, time, easing = 'linear') => {
    const s = get()
    const clipId = s.activeClipId
    if (!clipId) return
    const obj = s.objects.find((o) => o.id === objectId)
    if (!obj) return
    const transform: Transform = { ...obj.transform, head: { ...obj.transform.head } }
    set((st) => ({
      clips: st.clips.map((c) => {
        if (c.id !== clipId) return c
        const existingTrack = c.tracks.find((t) => t.objectId === objectId)
        const newKey = { id: genId('key'), time, transform, easing }
        if (!existingTrack) {
          return { ...c, tracks: [...c.tracks, { objectId, keyframes: [newKey] }] }
        }
        // replace any key already at this exact time, otherwise insert and keep sorted
        const withoutSameTime = existingTrack.keyframes.filter((k) => k.time !== time)
        const keyframes = [...withoutSameTime, newKey].sort((a, b) => a.time - b.time)
        return {
          ...c,
          tracks: c.tracks.map((t) => (t.objectId === objectId ? { ...t, keyframes } : t)),
        }
      }),
    }))
  },

  removeKeyframe: (objectId, keyframeId) =>
    set((s) => ({
      clips: s.clips.map((c) => {
        if (c.id !== s.activeClipId) return c
        return {
          ...c,
          tracks: c.tracks
            .map((t) =>
              t.objectId === objectId
                ? { ...t, keyframes: t.keyframes.filter((k) => k.id !== keyframeId) }
                : t,
            )
            // drop the track entirely once it has no keys left, rather than leaving an empty one around
            .filter((t) => t.objectId !== objectId || t.keyframes.length > 0),
        }
      }),
    })),

  setKeyframeTime: (objectId, keyframeId, time) =>
    set((s) => ({
      clips: s.clips.map((c) => {
        if (c.id !== s.activeClipId) return c
        return {
          ...c,
          tracks: c.tracks.map((t) => {
            if (t.objectId !== objectId) return t
            const keyframes = t.keyframes
              .map((k) => (k.id === keyframeId ? { ...k, time } : k))
              .sort((a, b) => a.time - b.time)
            return { ...t, keyframes }
          }),
        }
      }),
    })),

  setKeyframeEasing: (objectId, keyframeId, easing) =>
    set((s) => ({
      clips: s.clips.map((c) => {
        if (c.id !== s.activeClipId) return c
        return {
          ...c,
          tracks: c.tracks.map((t) =>
            t.objectId !== objectId
              ? t
              : { ...t, keyframes: t.keyframes.map((k) => (k.id === keyframeId ? { ...k, easing } : k)) },
          ),
        }
      }),
    })),

  duplicateKeyframe: (objectId, sourceKeyframeId, time) => {
    get().beginChange()
    set((s) => ({
      clips: s.clips.map((c) => {
        if (c.id !== s.activeClipId) return c
        const track = c.tracks.find((t) => t.objectId === objectId)
        const source = track?.keyframes.find((k) => k.id === sourceKeyframeId)
        if (!source) return c
        const newKey = { ...source, id: genId('key'), time }
        const withoutSameTime = track!.keyframes.filter((k) => k.time !== time)
        const keyframes = [...withoutSameTime, newKey].sort((a, b) => a.time - b.time)
        return { ...c, tracks: c.tracks.map((t) => (t.objectId === objectId ? { ...t, keyframes } : t)) }
      }),
    }))
  },

  insertShapeKeyKeyframe: (objectId, shapeKeyId, time, easing = 'linear') => {
    const s = get()
    const clipId = s.activeClipId
    if (!clipId) return
    const obj = s.objects.find((o) => o.id === objectId)
    if (!obj) return
    const value = obj.shapeKeyValues?.[shapeKeyId] ?? 0
    set((st) => ({
      clips: st.clips.map((c) => {
        if (c.id !== clipId) return c
        const tracks = c.shapeKeyTracks ?? []
        const existingTrack = tracks.find((t) => t.objectId === objectId && t.shapeKeyId === shapeKeyId)
        const newKey = { id: genId('key'), time, value, easing }
        if (!existingTrack) {
          return { ...c, shapeKeyTracks: [...tracks, { objectId, shapeKeyId, keyframes: [newKey] }] }
        }
        const withoutSameTime = existingTrack.keyframes.filter((k) => k.time !== time)
        const keyframes = [...withoutSameTime, newKey].sort((a, b) => a.time - b.time)
        return {
          ...c,
          shapeKeyTracks: tracks.map((t) =>
            t.objectId === objectId && t.shapeKeyId === shapeKeyId ? { ...t, keyframes } : t,
          ),
        }
      }),
    }))
  },

  removeShapeKeyKeyframe: (objectId, shapeKeyId, keyframeId) =>
    set((s) => ({
      clips: s.clips.map((c) => {
        if (c.id !== s.activeClipId) return c
        return {
          ...c,
          shapeKeyTracks: (c.shapeKeyTracks ?? [])
            .map((t) =>
              t.objectId === objectId && t.shapeKeyId === shapeKeyId
                ? { ...t, keyframes: t.keyframes.filter((k) => k.id !== keyframeId) }
                : t,
            )
            .filter((t) => !(t.objectId === objectId && t.shapeKeyId === shapeKeyId) || t.keyframes.length > 0),
        }
      }),
    })),

  setShapeKeyKeyframeTime: (objectId, shapeKeyId, keyframeId, time) =>
    set((s) => ({
      clips: s.clips.map((c) => {
        if (c.id !== s.activeClipId) return c
        return {
          ...c,
          shapeKeyTracks: (c.shapeKeyTracks ?? []).map((t) => {
            if (t.objectId !== objectId || t.shapeKeyId !== shapeKeyId) return t
            const keyframes = t.keyframes
              .map((k) => (k.id === keyframeId ? { ...k, time } : k))
              .sort((a, b) => a.time - b.time)
            return { ...t, keyframes }
          }),
        }
      }),
    })),

  setShapeKeyKeyframeEasing: (objectId, shapeKeyId, keyframeId, easing) =>
    set((s) => ({
      clips: s.clips.map((c) => {
        if (c.id !== s.activeClipId) return c
        return {
          ...c,
          shapeKeyTracks: (c.shapeKeyTracks ?? []).map((t) =>
            t.objectId !== objectId || t.shapeKeyId !== shapeKeyId
              ? t
              : { ...t, keyframes: t.keyframes.map((k) => (k.id === keyframeId ? { ...k, easing } : k)) },
          ),
        }
      }),
    })),

  duplicateShapeKeyKeyframe: (objectId, shapeKeyId, sourceKeyframeId, time) => {
    get().beginChange()
    set((s) => ({
      clips: s.clips.map((c) => {
        if (c.id !== s.activeClipId) return c
        const tracks = c.shapeKeyTracks ?? []
        const track = tracks.find((t) => t.objectId === objectId && t.shapeKeyId === shapeKeyId)
        const source = track?.keyframes.find((k) => k.id === sourceKeyframeId)
        if (!source) return c
        const newKey = { ...source, id: genId('key'), time }
        const withoutSameTime = track!.keyframes.filter((k) => k.time !== time)
        const keyframes = [...withoutSameTime, newKey].sort((a, b) => a.time - b.time)
        return {
          ...c,
          shapeKeyTracks: tracks.map((t) =>
            t.objectId === objectId && t.shapeKeyId === shapeKeyId ? { ...t, keyframes } : t,
          ),
        }
      }),
    }))
  },

  insertPathOffsetKeyframe: (objectId, time, easing = 'linear') => {
    const s = get()
    const clipId = s.activeClipId
    if (!clipId) return
    const obj = s.objects.find((o) => o.id === objectId)
    const settings = obj ? getPathDeformRail(obj) : undefined
    if (!settings) return
    const value = settings.pathOffset
    get().beginChange()
    set((st) => ({
      clips: st.clips.map((c) => {
        if (c.id !== clipId) return c
        const tracks: PathOffsetTrack[] = c.pathOffsetTracks ?? []
        const existingTrack = tracks.find((t) => t.objectId === objectId)
        const newKey = { id: genId('key'), time, value, easing }
        if (!existingTrack) {
          return { ...c, pathOffsetTracks: [...tracks, { objectId, keyframes: [newKey] }] }
        }
        const withoutSameTime = existingTrack.keyframes.filter((k) => k.time !== time)
        const keyframes = [...withoutSameTime, newKey].sort((a, b) => a.time - b.time)
        return {
          ...c,
          pathOffsetTracks: tracks.map((t) => (t.objectId === objectId ? { ...t, keyframes } : t)),
        }
      }),
    }))
  },

  removePathOffsetKeyframe: (objectId, keyframeId) => {
    get().beginChange()
    set((s) => ({
      clips: s.clips.map((c) => {
        if (c.id !== s.activeClipId) return c
        return {
          ...c,
          pathOffsetTracks: (c.pathOffsetTracks ?? [])
            .map((t) => (t.objectId === objectId ? { ...t, keyframes: t.keyframes.filter((k) => k.id !== keyframeId) } : t))
            .filter((t) => t.objectId !== objectId || t.keyframes.length > 0),
        }
      }),
    }))
  },

  setPathOffsetKeyframeTime: (objectId, keyframeId, time) => {
    get().beginChange()
    set((s) => ({
      clips: s.clips.map((c) => {
        if (c.id !== s.activeClipId) return c
        return {
          ...c,
          pathOffsetTracks: (c.pathOffsetTracks ?? []).map((t) => {
            if (t.objectId !== objectId) return t
            const keyframes = t.keyframes.map((k) => (k.id === keyframeId ? { ...k, time } : k)).sort((a, b) => a.time - b.time)
            return { ...t, keyframes }
          }),
        }
      }),
    }))
  },

  setPathOffsetKeyframeEasing: (objectId, keyframeId, easing) => {
    get().beginChange()
    set((s) => ({
      clips: s.clips.map((c) => {
        if (c.id !== s.activeClipId) return c
        return {
          ...c,
          pathOffsetTracks: (c.pathOffsetTracks ?? []).map((t) =>
            t.objectId !== objectId ? t : { ...t, keyframes: t.keyframes.map((k) => (k.id === keyframeId ? { ...k, easing } : k)) },
          ),
        }
      }),
    }))
  },

  duplicatePathOffsetKeyframe: (objectId, sourceKeyframeId, time) => {
    get().beginChange()
    set((s) => ({
      clips: s.clips.map((c) => {
        if (c.id !== s.activeClipId) return c
        const tracks = c.pathOffsetTracks ?? []
        const track = tracks.find((t) => t.objectId === objectId)
        const source = track?.keyframes.find((k) => k.id === sourceKeyframeId)
        if (!source) return c
        const newKey = { ...source, id: genId('key'), time }
        const withoutSameTime = track!.keyframes.filter((k) => k.time !== time)
        const keyframes = [...withoutSameTime, newKey].sort((a, b) => a.time - b.time)
        return { ...c, pathOffsetTracks: tracks.map((t) => (t.objectId === objectId ? { ...t, keyframes } : t)) }
      }),
    }))
  },

  insertFollowPathProgressKeyframe: (objectId, time, easing = 'linear') => {
    const s = get()
    const clipId = s.activeClipId
    if (!clipId) return
    const obj = s.objects.find((o) => o.id === objectId)
    const settings = obj ? getFollowPath(obj) : undefined
    if (!settings) return
    const value = settings.progress
    get().beginChange()
    set((st) => ({
      clips: st.clips.map((c) => {
        if (c.id !== clipId) return c
        const tracks: FollowPathProgressTrack[] = c.followPathProgressTracks ?? []
        const existingTrack = tracks.find((t) => t.objectId === objectId)
        const newKey = { id: genId('key'), time, value, easing }
        if (!existingTrack) {
          return { ...c, followPathProgressTracks: [...tracks, { objectId, keyframes: [newKey] }] }
        }
        const withoutSameTime = existingTrack.keyframes.filter((k) => k.time !== time)
        const keyframes = [...withoutSameTime, newKey].sort((a, b) => a.time - b.time)
        return {
          ...c,
          followPathProgressTracks: tracks.map((t) => (t.objectId === objectId ? { ...t, keyframes } : t)),
        }
      }),
    }))
  },

  removeFollowPathProgressKeyframe: (objectId, keyframeId) => {
    get().beginChange()
    set((s) => ({
      clips: s.clips.map((c) => {
        if (c.id !== s.activeClipId) return c
        return {
          ...c,
          followPathProgressTracks: (c.followPathProgressTracks ?? [])
            .map((t) => (t.objectId === objectId ? { ...t, keyframes: t.keyframes.filter((k) => k.id !== keyframeId) } : t))
            .filter((t) => t.objectId !== objectId || t.keyframes.length > 0),
        }
      }),
    }))
  },

  setFollowPathProgressKeyframeTime: (objectId, keyframeId, time) => {
    get().beginChange()
    set((s) => ({
      clips: s.clips.map((c) => {
        if (c.id !== s.activeClipId) return c
        return {
          ...c,
          followPathProgressTracks: (c.followPathProgressTracks ?? []).map((t) => {
            if (t.objectId !== objectId) return t
            const keyframes = t.keyframes.map((k) => (k.id === keyframeId ? { ...k, time } : k)).sort((a, b) => a.time - b.time)
            return { ...t, keyframes }
          }),
        }
      }),
    }))
  },

  setFollowPathProgressKeyframeEasing: (objectId, keyframeId, easing) => {
    get().beginChange()
    set((s) => ({
      clips: s.clips.map((c) => {
        if (c.id !== s.activeClipId) return c
        return {
          ...c,
          followPathProgressTracks: (c.followPathProgressTracks ?? []).map((t) =>
            t.objectId !== objectId ? t : { ...t, keyframes: t.keyframes.map((k) => (k.id === keyframeId ? { ...k, easing } : k)) },
          ),
        }
      }),
    }))
  },

  duplicateFollowPathProgressKeyframe: (objectId, sourceKeyframeId, time) => {
    get().beginChange()
    set((s) => ({
      clips: s.clips.map((c) => {
        if (c.id !== s.activeClipId) return c
        const tracks = c.followPathProgressTracks ?? []
        const track = tracks.find((t) => t.objectId === objectId)
        const source = track?.keyframes.find((k) => k.id === sourceKeyframeId)
        if (!source) return c
        const newKey = { ...source, id: genId('key'), time }
        const withoutSameTime = track!.keyframes.filter((k) => k.time !== time)
        const keyframes = [...withoutSameTime, newKey].sort((a, b) => a.time - b.time)
        return { ...c, followPathProgressTracks: tracks.map((t) => (t.objectId === objectId ? { ...t, keyframes } : t)) }
      }),
    }))
  },

  addModifier: (id, type) => {
    get().beginChange()
    set((s) => ({
      objects: s.objects.map((o) => {
        if (o.id !== id || o.modifiers?.some((m) => m.type === type)) return o
        const modifier: Modifier =
          type === 'fakeFlag'
            ? { type: 'fakeFlag', settings: { ...DEFAULT_FAKE_FLAG_SETTINGS } }
            : type === 'fakePhysics'
              ? { type: 'fakePhysics', settings: { ...DEFAULT_FAKE_PHYSICS_SETTINGS } }
              : type === 'fakePhysicsMesh'
                ? {
                    type: 'fakePhysicsMesh',
                    settings: { ...DEFAULT_FAKE_PHYSICS_MESH_SETTINGS, sectionVertices: [[], [], [], [], []] },
                  }
                : type === 'fakeBehind'
                  ? { type: 'fakeBehind', settings: { ...DEFAULT_FAKE_BEHIND_SETTINGS, maskObjectIds: [] } }
                  : type === 'followPath'
                    ? { type: 'followPath', settings: { ...DEFAULT_FOLLOW_PATH_SETTINGS } }
                    : type === 'pathDeformRail'
                      ? { type: 'pathDeformRail', settings: { ...DEFAULT_PATH_DEFORM_RAIL_SETTINGS } }
                      : type === 'ffd'
                        ? { type: 'ffd', settings: { ...DEFAULT_FFD_SETTINGS } }
                        : { type: 'volumePreserve', settings: { ...DEFAULT_VOLUME_PRESERVE_SETTINGS } }
        return { ...o, modifiers: [...(o.modifiers ?? []), modifier] }
      }),
    }))
  },

  removeModifier: (id, type) => {
    get().beginChange()
    set((s) => ({
      objects: s.objects.map((o) =>
        o.id === id ? { ...o, modifiers: (o.modifiers ?? []).filter((m) => m.type !== type) } : o,
      ),
      // removing the modifier that owns a bake also clears that bake — otherwise re-adding it
      // later would silently resurrect stale keyframes with no modifier settings to explain them
      clips:
        type === 'fakePhysics' || type === 'fakePhysicsMesh'
          ? s.clips.map((c) => {
              if (c.id !== s.activeClipId) return c
              return type === 'fakePhysics'
                ? { ...c, fakePhysicsTracks: (c.fakePhysicsTracks ?? []).filter((t) => t.objectId !== id) }
                : { ...c, fakePhysicsMeshTracks: (c.fakePhysicsMeshTracks ?? []).filter((t) => t.objectId !== id) }
            })
          : s.clips,
      // dropping a mid-preview Fake Flag/Fake Physics (mesh) shouldn't leave Preview silently
      // armed — re-adding it later would otherwise immediately jump into motion with no warning
      previewFakeFlag: type === 'fakeFlag' ? false : s.previewFakeFlag,
      previewFakePhysicsMesh: type === 'fakePhysicsMesh' ? false : s.previewFakePhysicsMesh,
    }))
  },

  toggleFakeFlagEnabled: (id) => {
    get().beginChange()
    set((s) => {
      const obj = s.objects.find((o) => o.id === id)
      const nextEnabled = !obj || !getFakeFlag(obj)?.enabled
      return {
        objects: s.objects.map((o) =>
          o.id === id ? withFakeFlagSettings(o, (fs) => ({ ...fs, enabled: !fs.enabled })) : o,
        ),
        // switching this object off while it was mid-preview shouldn't leave Preview silently
        // armed — re-enabling it later would otherwise immediately jump into motion with no
        // warning, since Preview is a view setting that outlives any one object's toggle
        previewFakeFlag: nextEnabled ? s.previewFakeFlag : false,
      }
    })
  },

  updateFakeFlag: (id, patch) => {
    get().beginChange()
    set((s) => ({
      objects: s.objects.map((o) => (o.id === id ? withFakeFlagSettings(o, (fs) => ({ ...fs, ...patch })) : o)),
    }))
  },

  setFakeFlagDirection: (id, direction) =>
    set((s) => ({
      objects: s.objects.map((o) => (o.id === id ? withFakeFlagSettings(o, (fs) => ({ ...fs, direction })) : o)),
    })),

  assignFakeFlagAnchor: (id) => {
    const s = get()
    const obj = s.objects.find((o) => o.id === id)
    if (!obj) return
    const anchorVertices = selectedVertexIndices(s, obj.mesh)
    if (anchorVertices.length === 0) return
    get().beginChange()
    set((st) => ({
      objects: st.objects.map((o) => (o.id === id ? withFakeFlagSettings(o, (fs) => ({ ...fs, anchorVertices })) : o)),
    }))
  },

  clearFakeFlagAnchor: (id) => {
    get().beginChange()
    set((s) => ({
      objects: s.objects.map((o) =>
        o.id === id ? withFakeFlagSettings(o, (fs) => ({ ...fs, anchorVertices: [] })) : o,
      ),
    }))
  },

  togglePreviewFakeFlag: () => set((s) => ({ previewFakeFlag: !s.previewFakeFlag })),

  updatePathDeformRail: (id, patch) => {
    get().beginChange()
    set((s) => ({
      objects: s.objects.map((o) => (o.id === id ? withPathDeformRailSettings(o, (ps) => ({ ...ps, ...patch })) : o)),
    }))
  },

  updateFollowPath: (id, patch) => {
    get().beginChange()
    set((s) => ({
      objects: s.objects.map((o) => (o.id === id ? withFollowPathSettings(o, (fs) => ({ ...fs, ...patch })) : o)),
    }))
  },

  updateFfd: (id, patch) => {
    get().beginChange()
    set((s) => ({
      objects: s.objects.map((o) => {
        if (o.id !== id) {
          // Seed the newly-referenced cage's rest snapshot in this same update, if it doesn't
          // have one yet — so assigning a cage "just works" without a separate manual step.
          if (patch.cageObjectId && o.id === patch.cageObjectId && !o.cageRestVertices) {
            return { ...o, cageRestVertices: o.mesh.vertices.map((v) => ({ ...v })) }
          }
          return o
        }
        return withFfdSettings(o, (fs) => ({ ...fs, ...patch }))
      }),
    }))
  },

  resetFfdCageRest: (cageObjectId) => {
    get().beginChange()
    set((s) => ({
      objects: s.objects.map((o) =>
        o.id === cageObjectId ? { ...o, cageRestVertices: o.mesh.vertices.map((v) => ({ ...v })) } : o,
      ),
    }))
  },

  updateVolumePreserve: (id, patch) => {
    get().beginChange()
    set((s) => ({
      objects: s.objects.map((o) => (o.id === id ? withVolumePreserveSettings(o, (vs) => ({ ...vs, ...patch })) : o)),
    }))
  },

  applyScale: (id) => {
    get().beginChange()
    set((s) => ({
      objects: s.objects.map((o) => {
        if (o.id !== id) return o
        const { scaleX, scaleY, head } = o.transform
        if (scaleX === 1 && scaleY === 1) return o
        const bake = (v: Vec2): Vec2 => ({
          x: head.x + (v.x - head.x) * scaleX,
          y: head.y + (v.y - head.y) * scaleY,
        })
        return {
          ...o,
          mesh: { ...o.mesh, vertices: o.mesh.vertices.map(bake) },
          tail: bake(o.tail),
          uvBaseVertices: o.uvBaseVertices
            ? Object.fromEntries(Object.entries(o.uvBaseVertices).map(([i, v]) => [i, bake(v)]))
            : o.uvBaseVertices,
          cageRestVertices: o.cageRestVertices?.map(bake),
          shapeKeys: o.shapeKeys?.map((sk) => ({
            ...sk,
            positions: Object.fromEntries(Object.entries(sk.positions).map(([i, v]) => [i, bake(v)])),
            arcPivot: sk.arcPivot ? bake(sk.arcPivot) : sk.arcPivot,
          })),
          transform: { ...o.transform, scaleX: 1, scaleY: 1 },
        }
      }),
    }))
  },

  toggleFakePhysicsEnabled: (id) => {
    get().beginChange()
    set((s) => ({
      objects: s.objects.map((o) =>
        o.id === id ? withFakePhysicsSettings(o, (fs) => ({ ...fs, enabled: !fs.enabled })) : o,
      ),
    }))
  },

  updateFakePhysics: (id, patch) => {
    get().beginChange()
    set((s) => ({
      objects: s.objects.map((o) => (o.id === id ? withFakePhysicsSettings(o, (fs) => ({ ...fs, ...patch })) : o)),
    }))
  },

  bakeFakePhysics: (id) => {
    const s = get()
    const clip = s.clips.find((c) => c.id === s.activeClipId)
    if (!clip || clip.duration <= 0 || clip.frameRate <= 0) return
    const frameCount = Math.max(1, Math.round(clip.duration * clip.frameRate))
    const cycle = clip.loopMode === 'loop' ? { duration: clip.duration } : undefined
    const newTracks = buildFakePhysicsTracksForRoot(s.objects, clip, id, frameCount, cycle)
    if (newTracks.length === 0) return
    get().beginChange()
    set((st) => ({
      clips: st.clips.map((c) => {
        if (c.id !== st.activeClipId) return c
        const keepIds = new Set(newTracks.map((t) => t.objectId))
        return {
          ...c,
          fakePhysicsTracks: [...(c.fakePhysicsTracks ?? []).filter((t) => !keepIds.has(t.objectId)), ...newTracks],
        }
      }),
    }))
  },

  clearFakePhysicsBake: (id) => {
    get().beginChange()
    set((s) => ({
      clips: s.clips.map((c) =>
        c.id !== s.activeClipId
          ? c
          : { ...c, fakePhysicsTracks: (c.fakePhysicsTracks ?? []).filter((t) => t.objectId !== id) },
      ),
    }))
  },

  toggleFakePhysicsMeshEnabled: (id) => {
    get().beginChange()
    set((s) => {
      const obj = s.objects.find((o) => o.id === id)
      const nextEnabled = !obj || !getFakePhysicsMesh(obj)?.enabled
      return {
        objects: s.objects.map((o) =>
          o.id === id ? withFakePhysicsMeshSettings(o, (fs) => ({ ...fs, enabled: !fs.enabled })) : o,
        ),
        // switching this object off while it was mid-preview shouldn't leave Preview silently
        // armed — re-enabling it later would otherwise immediately jump into motion unannounced
        previewFakePhysicsMesh: nextEnabled ? s.previewFakePhysicsMesh : false,
      }
    })
  },

  updateFakePhysicsMesh: (id, patch) => {
    get().beginChange()
    set((s) => ({
      objects: s.objects.map((o) => (o.id === id ? withFakePhysicsMeshSettings(o, (fs) => ({ ...fs, ...patch })) : o)),
    }))
  },

  setFakePhysicsMeshSectionStiffnessLive: (id, index, value) =>
    set((s) => ({
      objects: s.objects.map((o) =>
        o.id === id
          ? withFakePhysicsMeshSettings(o, (fs) => {
              const next = [...fs.sectionStiffness] as FakePhysicsMeshSettings['sectionStiffness']
              next[index] = Math.min(1, Math.max(0, value))
              return { ...fs, sectionStiffness: next }
            })
          : o,
      ),
    })),

  assignFakePhysicsMeshSection: (id, section) => {
    const s = get()
    const obj = s.objects.find((o) => o.id === id)
    if (!obj) return
    const picked = selectedVertexIndices(s, obj.mesh)
    if (picked.length === 0) return
    const pickedSet = new Set(picked)
    get().beginChange()
    set((st) => ({
      objects: st.objects.map((o) =>
        o.id === id
          ? withFakePhysicsMeshSettings(o, (fs) => ({
              ...fs,
              sectionVertices: fs.sectionVertices.map((arr, idx) =>
                idx === section - 1 ? Array.from(new Set([...arr, ...picked])) : arr.filter((v) => !pickedSet.has(v)),
              ) as FakePhysicsMeshSettings['sectionVertices'],
            }))
          : o,
      ),
    }))
  },

  selectFakePhysicsMeshSection: (id, section) => {
    const s = get()
    const obj = s.objects.find((o) => o.id === id)
    const settings = obj && getFakePhysicsMesh(obj)
    if (!settings) return
    set({
      editElementType: 'vertex',
      selectedVertices: new Set(settings.sectionVertices[section - 1]),
      selectedEdges: new Set(),
      selectedFaces: new Set(),
    })
  },

  removeFakePhysicsMeshSectionVertices: (id, section) => {
    const s = get()
    const obj = s.objects.find((o) => o.id === id)
    if (!obj) return
    const toRemove = new Set(selectedVertexIndices(s, obj.mesh))
    if (toRemove.size === 0) return
    get().beginChange()
    set((st) => ({
      objects: st.objects.map((o) =>
        o.id === id
          ? withFakePhysicsMeshSettings(o, (fs) => ({
              ...fs,
              sectionVertices: fs.sectionVertices.map((arr, idx) =>
                idx === section - 1 ? arr.filter((v) => !toRemove.has(v)) : arr,
              ) as FakePhysicsMeshSettings['sectionVertices'],
            }))
          : o,
      ),
    }))
  },

  bakeFakePhysicsMesh: (id) => {
    const s = get()
    const clip = s.clips.find((c) => c.id === s.activeClipId)
    if (!clip || clip.duration <= 0 || clip.frameRate <= 0) return
    const obj = s.objects.find((o) => o.id === id)
    if (!obj) return
    const frameCount = Math.max(1, Math.round(clip.duration * clip.frameRate))
    const newTracks = buildFakePhysicsMeshTracksForObject(s.objects, obj, clip, frameCount)
    if (newTracks.length === 0) return
    get().beginChange()
    set((st) => ({
      clips: st.clips.map((c) => {
        if (c.id !== st.activeClipId) return c
        return {
          ...c,
          fakePhysicsMeshTracks: [...(c.fakePhysicsMeshTracks ?? []).filter((t) => t.objectId !== id), ...newTracks],
        }
      }),
    }))
  },

  clearFakePhysicsMeshBake: (id) => {
    get().beginChange()
    set((s) => ({
      clips: s.clips.map((c) =>
        c.id !== s.activeClipId
          ? c
          : { ...c, fakePhysicsMeshTracks: (c.fakePhysicsMeshTracks ?? []).filter((t) => t.objectId !== id) },
      ),
    }))
  },

  togglePreviewFakePhysicsMesh: () => set((s) => ({ previewFakePhysicsMesh: !s.previewFakePhysicsMesh })),

  bakeAllFakePhysics: () => {
    const s = get()
    const clip = s.clips.find((c) => c.id === s.activeClipId)
    if (!clip || clip.duration <= 0 || clip.frameRate <= 0) return
    const frameCount = Math.max(1, Math.round(clip.duration * clip.frameRate))
    const cycle = clip.loopMode === 'loop' ? { duration: clip.duration } : undefined

    const chainTracks: ObjectAnimationTrack[] = []
    for (const obj of s.objects) {
      if (getFakePhysics(obj)?.enabled) continue // has its own modifier, not a root candidate
      chainTracks.push(...buildFakePhysicsTracksForRoot(s.objects, clip, obj.id, frameCount, cycle))
    }
    const meshTracks: FakePhysicsMeshTrack[] = []
    for (const obj of s.objects) {
      if (!getFakePhysicsMesh(obj)?.enabled) continue
      meshTracks.push(...buildFakePhysicsMeshTracksForObject(s.objects, obj, clip, frameCount))
    }
    if (chainTracks.length === 0 && meshTracks.length === 0) return

    get().beginChange()
    const chainKeepIds = new Set(chainTracks.map((t) => t.objectId))
    const meshKeepIds = new Set(meshTracks.map((t) => t.objectId))
    set((st) => ({
      clips: st.clips.map((c) =>
        c.id !== st.activeClipId
          ? c
          : {
              ...c,
              fakePhysicsTracks: [...(c.fakePhysicsTracks ?? []).filter((t) => !chainKeepIds.has(t.objectId)), ...chainTracks],
              fakePhysicsMeshTracks: [
                ...(c.fakePhysicsMeshTracks ?? []).filter((t) => !meshKeepIds.has(t.objectId)),
                ...meshTracks,
              ],
            },
      ),
    }))
  },

  toggleFakeBehindEnabled: (id) => {
    get().beginChange()
    set((s) => ({
      objects: s.objects.map((o) =>
        o.id === id ? withFakeBehindSettings(o, (fs) => ({ ...fs, enabled: !fs.enabled })) : o,
      ),
    }))
  },

  addFakeBehindMaskRef: (id, maskId) => {
    if (id === maskId) return // an object can't mask itself
    get().beginChange()
    set((s) => ({
      objects: s.objects.map((o) =>
        o.id === id
          ? withFakeBehindSettings(o, (fs) =>
              fs.maskObjectIds.includes(maskId) ? fs : { ...fs, maskObjectIds: [...fs.maskObjectIds, maskId] },
            )
          : o,
      ),
    }))
  },

  removeFakeBehindMaskRef: (id, maskId) => {
    get().beginChange()
    set((s) => ({
      objects: s.objects.map((o) =>
        o.id === id
          ? withFakeBehindSettings(o, (fs) => ({ ...fs, maskObjectIds: fs.maskObjectIds.filter((m) => m !== maskId) }))
          : o,
      ),
    }))
  },

  setPlayhead: (time) => {
    const s = get()
    const clip = s.clips.find((c) => c.id === s.activeClipId)
    if (!clip) {
      set({ playheadTime: time })
      return
    }
    // resolved into the clip's own [0, duration] range (clamped for 'none', wrapped for
    // loop/pingpong) so the stored playhead — and anything displaying it — never drifts outside
    // the clip's bounds, even while a raw, ever-growing playback time keeps feeding in
    const resolved = resolvePlaybackTime(time, clip.duration, clip.loopMode)
    const sampled = sampleClipAtTime(clip, resolved)
    set((st) => ({
      playheadTime: resolved,
      objects: st.objects.map((o) => {
        const t = sampled.transforms.get(o.id)
        let next = t ? { ...o, transform: t } : o
        // apply any sampled shape-key weights for this object, one lookup per shape key it has —
        // a key with no track at this time is left at whatever weight it already had
        if (next.shapeKeys?.length) {
          let shapeKeyValues: Record<string, number> | null = null
          for (const key of next.shapeKeys) {
            const v = sampled.shapeKeyValues.get(shapeKeyTrackKey(o.id, key.id))
            if (v === undefined) continue
            if (!shapeKeyValues) shapeKeyValues = { ...next.shapeKeyValues }
            shapeKeyValues[key.id] = v
          }
          if (shapeKeyValues) next = { ...next, shapeKeyValues }
        }
        // same idea, one level down: a keyframed `pathOffset` overwrites this object's live
        // `pathDeformRail` settings, which `pathDeformRailVertexDeltas` then just reads normally —
        // no separate "sampled overlay" needed anywhere else (Viewport.tsx/ffd.ts read
        // `obj.modifiers` directly).
        const pathOffset = sampled.pathOffsetValues.get(o.id)
        if (pathOffset !== undefined && getPathDeformRail(next)) {
          next = withPathDeformRailSettings(next, (ps) => ({ ...ps, pathOffset }))
        }
        // same idea again, for Follow Path's `progress` — the actual position/rotation-along-the-
        // path effect itself is applied at render time (`applyFollowPath`, mirroring Fake Flag's
        // sway), not baked into `transform` here; this only keeps the *dial* (`progress`) current
        // so `applyFollowPath` and the Properties panel both read the right live value.
        const followProgress = sampled.followPathProgressValues.get(o.id)
        if (followProgress !== undefined && getFollowPath(next)) {
          next = withFollowPathSettings(next, (fs) => ({ ...fs, progress: followProgress }))
        }
        return next
      }),
    }))
  },
}))
