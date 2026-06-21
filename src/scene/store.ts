import { create } from 'zustand'
import type { AppMode, EditElementType, Mesh, SceneObject, Transform, Vec2 } from './types'
import { createCircleMesh, createRectMesh } from './primitives'
import { insertLoopCutColumns, insertLoopCutRows } from './loopCut'

export type ActiveTool = 'select' | 'loopcut'

let nextId = 1
function genId(prefix: string) {
  return `${prefix}_${nextId++}`
}

const DEFAULT_COLORS = ['#7aa2f7', '#f7768e', '#9ece6a', '#e0af68', '#bb9af7', '#7dcfff']

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

  beginChange: () => void
  undo: () => void
  redo: () => void
  /** Abort the in-progress change (e.g. right-click during a drag) and restore the pre-drag snapshot. */
  cancelChange: () => void

  addRect: (width: number, height: number, segX: number, segY: number) => void
  addCircle: (radius: number, segments: number) => void
  addImportedMesh: (mesh: Mesh, name: string) => void
  selectObject: (id: string | null) => void
  removeObject: (id: string) => void
  toggleVisibility: (id: string) => void
  renameObject: (id: string, name: string) => void
  setColor: (id: string, color: string) => void
  setTransform: (id: string, transform: Partial<Transform>) => void
  /** Move the pivot (in local mesh space) while keeping the mesh visually in place. */
  setPivot: (id: string, localPivot: Vec2) => void
  reorder: (id: string, newZOrder: number) => void

  setMode: (mode: AppMode) => void
  setEditElementType: (t: EditElementType) => void
  setSelectedVertices: (indices: Set<number>) => void
  setSelectedEdges: (keys: Set<string>) => void
  setSelectedFaces: (indices: Set<number>) => void
  moveVertices: (objectId: string, indices: number[], dx: number, dy: number) => void
  setActiveTool: (tool: ActiveTool) => void
  applyLoopCut: (objectId: string, axis: 'row' | 'col', index: number, ts: number[]) => void
}

function nextColor(objects: SceneObject[]) {
  return DEFAULT_COLORS[objects.length % DEFAULT_COLORS.length]
}

function cloneObjects(objects: SceneObject[]): SceneObject[] {
  return objects.map((o) => ({
    ...o,
    transform: { ...o.transform, pivot: { ...o.transform.pivot } },
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
    const obj: SceneObject = {
      id: genId('obj'),
      name: `Rect_${objects.length + 1}`,
      mesh: createRectMesh(width, height, segX, segY),
      transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, pivot: { x: 0, y: 0 } },
      zOrder: objects.length,
      visible: true,
      color: nextColor(objects),
      grid: { cols: segX + 1, rows: segY + 1 },
    }
    set({ objects: [...objects, obj], selectedObjectId: obj.id })
  },

  addCircle: (radius, segments) => {
    get().beginChange()
    const objects = get().objects
    const obj: SceneObject = {
      id: genId('obj'),
      name: `Circle_${objects.length + 1}`,
      mesh: createCircleMesh(radius, segments),
      transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, pivot: { x: 0, y: 0 } },
      zOrder: objects.length,
      visible: true,
      color: nextColor(objects),
    }
    set({ objects: [...objects, obj], selectedObjectId: obj.id })
  },

  addImportedMesh: (mesh, name) => {
    get().beginChange()
    const objects = get().objects
    const obj: SceneObject = {
      id: genId('obj'),
      name,
      mesh,
      transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, pivot: { x: 0, y: 0 } },
      zOrder: objects.length,
      visible: true,
      color: nextColor(objects),
      // no `grid`: arbitrary imported topology doesn't support loop cuts
    }
    set({ objects: [...objects, obj], selectedObjectId: obj.id })
  },

  selectObject: (id) => set({ selectedObjectId: id, selectedVertices: new Set() }),

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

  setColor: (id, color) =>
    set((s) => ({ objects: s.objects.map((o) => (o.id === id ? { ...o, color } : o)) })),

  setTransform: (id, transform) =>
    set((s) => ({
      objects: s.objects.map((o) =>
        o.id === id ? { ...o, transform: { ...o.transform, ...transform } } : o,
      ),
    })),

  setPivot: (id, localPivot) =>
    set((s) => ({
      objects: s.objects.map((o) => {
        if (o.id !== id) return o
        const t = o.transform
        const dx = localPivot.x - t.pivot.x
        const dy = localPivot.y - t.pivot.y
        const sx = dx * t.scaleX
        const sy = dy * t.scaleY
        const cos = Math.cos(t.rotation)
        const sin = Math.sin(t.rotation)
        // keep the mesh visually in place: compensate the world position by how far
        // the pivot moved, transformed through the current rotation/scale
        return {
          ...o,
          transform: {
            ...t,
            pivot: { ...localPivot },
            x: t.x + (sx * cos - sy * sin),
            y: t.y + (sx * sin + sy * cos),
          },
        }
      }),
    })),

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

  setMode: (mode) =>
    set({ mode, selectedVertices: new Set(), selectedEdges: new Set(), selectedFaces: new Set() }),
  setEditElementType: (editElementType) =>
    set({ editElementType, selectedVertices: new Set(), selectedEdges: new Set(), selectedFaces: new Set() }),
  setSelectedVertices: (selectedVertices) => set({ selectedVertices }),
  setSelectedEdges: (selectedEdges) => set({ selectedEdges }),
  setSelectedFaces: (selectedFaces) => set({ selectedFaces }),

  moveVertices: (objectId, indices, dx, dy) =>
    set((s) => ({
      objects: s.objects.map((o) => {
        if (o.id !== objectId) return o
        const vertices = o.mesh.vertices.map((v, i) =>
          indices.includes(i) ? { x: v.x + dx, y: v.y + dy } : v,
        )
        return { ...o, mesh: { ...o.mesh, vertices } }
      }),
    })),

  setActiveTool: (activeTool) => set({ activeTool }),

  applyLoopCut: (objectId, axis, index, ts) => {
    get().beginChange()
    set((s) => ({
      objects: s.objects.map((o) => {
        if (o.id !== objectId || !o.grid) return o
        const result =
          axis === 'row'
            ? insertLoopCutRows(o.mesh, o.grid, index, ts)
            : insertLoopCutColumns(o.mesh, o.grid, index, ts)
        return { ...o, mesh: result.mesh, grid: result.grid }
      }),
      selectedVertices: new Set(),
      selectedEdges: new Set(),
      selectedFaces: new Set(),
    }))
  },
}))
