import { create } from 'zustand'
import type {
  AppMode,
  EditElementType,
  InsertSlot,
  Mesh,
  ReferenceImage,
  SceneObject,
  Transform,
  UvIslandTransform,
  Vec2,
} from './types'
import { createCircleMesh, createRectMesh } from './primitives'
import { applyLoopCut as applyLoopCutToMesh } from './loopCut'
import { findFan, applyRingCut as applyRingCutToMesh } from './ringCut'
import { findFullLoop } from './loopPath'
import { extrudeEdges } from './extrude'
import { deleteVertices, deleteEdges, deleteFaces } from './deleteElements'
import { dissolveVertices, dissolveEdges } from './dissolve'
import { mergeVertices as mergeVerticesInMesh, type MergeMode } from './mergeVertices'
import { applyKnifeCut as applyKnifeCutToMesh, type KnifeCutPoint } from './knifeCut'
import { edgeKey, getEdges, parseEdgeKey, pruneOrphanVertices, mergeMeshAsIsland, clampToMesh } from './meshUtils'
import { findIslands, type Island } from './uv'

export type ActiveTool = 'select' | 'loopcut' | 'ringcut' | 'knife' | 'place-rect' | 'place-circle'

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
  history: SceneObject[][]
  future: SceneObject[][]
  activeTool: ActiveTool
  /** Reference frame for the object-mode move gizmo's axis arrows (Blender-style). 'local'
   *  (default) follows the object's own world rotation; 'world' is always the scene's X/Y axes.
   *  Doesn't affect the rotate ring (no orientation concept) or scale handles (always local). */
  gizmoOrientation: 'world' | 'local'
  /** Edit-mode pivot, in local mesh space. `null` means "use the object's own pivot". */
  editPivot: Vec2 | null
  /** Dimensions for the primitive currently being placed (activeTool === 'place-rect'/'place-circle'). */
  pendingPrimitive: PendingPrimitive | null
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

  beginChange: () => void
  undo: () => void
  redo: () => void
  /** Abort the in-progress change (e.g. right-click during a drag) and restore the pre-drag snapshot. */
  cancelChange: () => void

  addRect: (width: number, height: number, segX: number, segY: number) => void
  addCircle: (radius: number, segments: number) => void
  addImportedMesh: (mesh: Mesh, name: string) => void
  /** Adds a mesh-less hierarchy-only dummy object (e.g. a rig root), positioned at the origin. */
  addEmpty: () => void
  /** Merge a rect/circle into the given object's mesh as a new disconnected island, instead of
   *  creating a separate object — used when adding a primitive while already in edit mode. */
  addRectIsland: (objectId: string, at: Vec2, width: number, height: number, segX: number, segY: number) => void
  addCircleIsland: (objectId: string, at: Vec2, radius: number, segments: number) => void
  setPendingPrimitive: (p: PendingPrimitive | null) => void
  setReferenceImage: (url: string | null) => void
  setReferenceImageTransform: (transform: Partial<Pick<ReferenceImage, 'x' | 'y' | 'scale' | 'opacity'>>) => void
  setMeshOpacity: (opacity: number) => void
  setGridSubdivisions: (n: number) => void
  setGridSnapEnabled: (enabled: boolean) => void
  setGridVisible: (visible: boolean) => void
  setPixelPreviewEnabled: (enabled: boolean) => void
  setPixelPreviewResolution: (n: number) => void
  setPixelPreviewOffset: (offset: { x: number; y: number }) => void
  setPixelPreviewPaletteEnabled: (enabled: boolean) => void
  setPixelPreviewPaletteSize: (n: number) => void
  /** Replace the entire scene with a loaded project (clears selection, undo history, and `nextId` continues from fresh ids). */
  loadProject: (project: { objects: SceneObject[]; referenceImage: ReferenceImage | null; meshOpacity: number }) => void
  selectObject: (id: string | null) => void
  removeObject: (id: string) => void
  toggleVisibility: (id: string) => void
  renameObject: (id: string, name: string) => void
  setMaterialColor: (id: string, color: string) => void
  setMaterialTexture: (id: string, textureUrl: string | undefined) => void
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
  /** Merge the current vertex selection (2+) into one vertex, positioned per `mode`. */
  mergeSelectedVertices: (mode: MergeMode) => void
  /** Create one new face directly from the selected vertices, in selection (click) order. */
  fillSelectedFace: () => void
  /** Merge `mergeIndex` into `keepIndex` (keepIndex's position wins). Used for drag-to-weld onto an adjacent vertex. */
  mergeVertexPair: (objectId: string, keepIndex: number, mergeIndex: number) => void
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
    mesh: { vertices: o.mesh.vertices.map((v) => ({ ...v })), faces: o.mesh.faces.map((f) => [...f]) },
  }))
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
  history: [],
  future: [],
  activeTool: 'select',
  gizmoOrientation: 'local',
  editPivot: null,
  pendingPrimitive: null,
  referenceImage: null,
  meshOpacity: 1,
  gridSubdivisions: 10,
  gridSnapEnabled: false,
  gridVisible: true,
  pixelPreviewEnabled: false,
  pixelPreviewResolution: 64,
  pixelPreviewOffset: { x: 0, y: 0 },
  pixelPreviewPaletteEnabled: false,
  pixelPreviewPaletteSize: 16,

  beginChange: () =>
    set((s) => ({
      history: [...s.history.slice(-(MAX_HISTORY - 1)), cloneObjects(s.objects)],
      future: [],
    })),

  undo: () =>
    set((s) => {
      if (s.history.length === 0) return {}
      const prev = s.history[s.history.length - 1]
      return {
        history: s.history.slice(0, -1),
        future: [cloneObjects(s.objects), ...s.future],
        objects: prev,
      }
    }),

  redo: () =>
    set((s) => {
      if (s.future.length === 0) return {}
      const next = s.future[0]
      return {
        future: s.future.slice(1),
        history: [...s.history, cloneObjects(s.objects)],
        objects: next,
      }
    }),

  cancelChange: () =>
    set((s) => {
      if (s.history.length === 0) return {}
      const prev = s.history[s.history.length - 1]
      return { history: s.history.slice(0, -1), objects: prev }
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

  setPendingPrimitive: (pendingPrimitive) => set({ pendingPrimitive }),

  setReferenceImage: (url) =>
    set({ referenceImage: url ? { url, x: 0, y: 0, scale: 1, opacity: 1 } : null }),

  setReferenceImageTransform: (transform) =>
    set((s) => (s.referenceImage ? { referenceImage: { ...s.referenceImage, ...transform } } : {})),

  setMeshOpacity: (opacity) => set({ meshOpacity: Math.max(0, Math.min(1, opacity)) }),
  setGridSubdivisions: (n) => set({ gridSubdivisions: Math.max(1, Math.min(100, Math.round(n))) }),
  setGridSnapEnabled: (enabled) => set({ gridSnapEnabled: enabled }),
  setGridVisible: (visible) => set({ gridVisible: visible }),
  setPixelPreviewEnabled: (enabled) => set({ pixelPreviewEnabled: enabled }),
  setPixelPreviewResolution: (n) => set({ pixelPreviewResolution: Math.max(16, Math.min(512, Math.round(n / 8) * 8)) }),
  setPixelPreviewOffset: (offset) => set({ pixelPreviewOffset: offset }),
  setPixelPreviewPaletteEnabled: (enabled) => set({ pixelPreviewPaletteEnabled: enabled }),
  setPixelPreviewPaletteSize: (n) => set({ pixelPreviewPaletteSize: Math.max(2, Math.min(64, Math.round(n))) }),

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
    set({
      objects,
      referenceImage: project.referenceImage,
      meshOpacity: project.meshOpacity,
      selectedObjectId: null,
      selectedVertices: new Set(),
      selectedEdges: new Set(),
      selectedFaces: new Set(),
      mode: 'object',
      editPivot: null,
      activeTool: 'select',
      history: [],
      future: [],
    })
  },

  selectObject: (id) => set({ selectedObjectId: id, selectedVertices: new Set(), editPivot: null }),

  removeObject: (id) => {
    get().beginChange()
    set((s) => ({
      objects: s.objects.filter((o) => o.id !== id),
      selectedObjectId: s.selectedObjectId === id ? null : s.selectedObjectId,
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
      objects: s.objects.map((o) => {
        if (o.id !== id) return o
        const clamped = clampToMesh(o.mesh, localHead)
        const t = o.transform
        const dx = clamped.x - t.head.x
        const dy = clamped.y - t.head.y
        const sx = dx * t.scaleX
        const sy = dy * t.scaleY
        const cos = Math.cos(t.rotation)
        const sin = Math.sin(t.rotation)
        // keep the mesh visually in place: compensate the world position by how far
        // the head moved, transformed through the current rotation/scale
        return {
          ...o,
          transform: {
            ...t,
            head: clamped,
            x: t.x + (sx * cos - sy * sin),
            y: t.y + (sx * sin + sy * cos),
          },
        }
      }),
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
      objects: s.objects.map((o) => (o.id === id ? { ...o, connected } : o)),
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
    const objectId = s.selectedObjectId
    if (!objectId) return false
    const obj = s.objects.find((o) => o.id === objectId)
    if (!obj) return false

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
    const objectId = s.selectedObjectId
    if (!objectId) return
    const obj = s.objects.find((o) => o.id === objectId)
    if (!obj) return

    let mesh: Mesh
    if (s.editElementType === 'vertex') {
      if (s.selectedVertices.size === 0) return
      mesh = deleteVertices(obj.mesh, Array.from(s.selectedVertices))
    } else if (s.editElementType === 'edge') {
      if (s.selectedEdges.size === 0) return
      mesh = pruneOrphanVertices(deleteEdges(obj.mesh, Array.from(s.selectedEdges)))
    } else {
      if (s.selectedFaces.size === 0) return
      mesh = pruneOrphanVertices(deleteFaces(obj.mesh, Array.from(s.selectedFaces)))
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
      objects: st.objects.map((o) => (o.id === objectId ? { ...o, mesh } : o)),
      selectedVertices: new Set(),
      selectedEdges: new Set(),
      selectedFaces: new Set(),
    }))
  },

  dissolveSelection: () => {
    const s = get()
    const objectId = s.selectedObjectId
    if (!objectId) return
    const obj = s.objects.find((o) => o.id === objectId)
    if (!obj) return

    let mesh: Mesh
    if (s.editElementType === 'vertex') {
      if (s.selectedVertices.size === 0) return
      mesh = dissolveVertices(obj.mesh, Array.from(s.selectedVertices))
    } else if (s.editElementType === 'edge') {
      if (s.selectedEdges.size === 0) return
      mesh = dissolveEdges(obj.mesh, Array.from(s.selectedEdges))
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
      objects: st.objects.map((o) => (o.id === objectId ? { ...o, mesh } : o)),
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

  mergeSelectedVertices: (mode) => {
    const s = get()
    const objectId = s.selectedObjectId
    if (!objectId) return
    const obj = s.objects.find((o) => o.id === objectId)
    if (!obj) return
    if (s.editElementType !== 'vertex' || s.selectedVertices.size < 2) return

    // JS Sets preserve insertion order, so this is the actual selection order (click order).
    const orderedIndices = Array.from(s.selectedVertices)
    const { mesh, survivorIndex } = mergeVerticesInMesh(obj.mesh, orderedIndices, mode)

    get().beginChange()
    set((st) => ({
      objects: st.objects.map((o) => (o.id === objectId ? { ...o, mesh } : o)),
      selectedVertices: survivorIndex >= 0 ? new Set([survivorIndex]) : new Set(),
      selectedEdges: new Set(),
      selectedFaces: new Set(),
    }))
  },

  fillSelectedFace: () => {
    const s = get()
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
      editElementType: 'face',
      selectedVertices: new Set(),
      selectedEdges: new Set(),
      selectedFaces: new Set([newFaceIndex]),
    }))
  },

  mergeVertexPair: (objectId, keepIndex, mergeIndex) => {
    const obj = get().objects.find((o) => o.id === objectId)
    if (!obj) return
    // no beginChange here: this is called right after a vertex drag, which already opened
    // its own undo step — folding the snap-merge into the same step feels like one action
    const { mesh, survivorIndex } = mergeVerticesInMesh(obj.mesh, [keepIndex, mergeIndex], 'first')
    set((st) => ({
      objects: st.objects.map((o) => (o.id === objectId ? { ...o, mesh } : o)),
      selectedVertices: survivorIndex >= 0 ? new Set([survivorIndex]) : new Set(),
      selectedEdges: new Set(),
      selectedFaces: new Set(),
    }))
  },
}))
