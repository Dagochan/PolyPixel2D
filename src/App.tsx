import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import Viewport from './viewport/Viewport'
import PixelPreview from './viewport/PixelPreview'
import Outliner from './panels/Outliner'
import Properties from './panels/Properties'
import Toolbar from './panels/Toolbar'
import ToolPane from './panels/ToolPane'
import Timeline from './panels/Timeline'
import { useSceneStore } from './scene/store'
import { findCommonBoundaryFace, edgesAmongVertices } from './scene/fanCut'

const SIDEBAR_MIN_WIDTH = 180
const SIDEBAR_MAX_WIDTH = 560
const OUTLINER_MIN_HEIGHT = 80
const PROPERTIES_MIN_HEIGHT = 80
const TIMELINE_MIN_HEIGHT = 80
const TIMELINE_MAX_HEIGHT = 600

export default function App() {
  const [awaitingMerge, setAwaitingMerge] = useState(false)
  const awaitingMergeRef = useRef(false)
  const [sidebarWidth, setSidebarWidth] = useState(240)
  const [propertiesHeight, setPropertiesHeight] = useState(540)
  const [timelineHeight, setTimelineHeight] = useState(180)
  const resizingRef = useRef(false)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const pixelPreviewEnabled = useSceneStore((s) => s.pixelPreviewEnabled)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return

      // M arms a modal "merge vertices" prompt; the very next 1/2/3 picks the mode
      // (first/last/center) — anything else (including Escape) cancels it.
      if (awaitingMergeRef.current) {
        awaitingMergeRef.current = false
        setAwaitingMerge(false)
        if (e.key === '1' || e.key === '2' || e.key === '3') {
          e.preventDefault()
          const mode = e.key === '1' ? 'first' : e.key === '2' ? 'last' : 'center'
          useSceneStore.getState().mergeSelectedVertices(mode)
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          return
        }
        // fall through: let any other key behave normally
      }

      if (e.key.toLowerCase() === 'm') {
        const store = useSceneStore.getState()
        if (store.mode !== 'edit' || store.editElementType !== 'vertex' || store.selectedVertices.size < 2) {
          return
        }
        e.preventDefault()
        awaitingMergeRef.current = true
        setAwaitingMerge(true)
        return
      }

      const meta = e.ctrlKey || e.metaKey
      if (meta && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) useSceneStore.getState().redo()
        else useSceneStore.getState().undo()
        return
      }

      if (meta && e.key.toLowerCase() === 'r') {
        // Ctrl/Cmd+R is the browser's own reload shortcut — preventDefault alone doesn't reliably
        // stop it in every browser once it reaches here, but NOT calling it at all (the previous
        // behavior, only reached once past the mode/selection checks below) meant reaching for
        // this shortcut in Object mode — or with nothing selected — reloaded the page outright
        // and threw away the whole unsaved scene. Block it unconditionally the instant this key
        // combo is seen, before any of those checks, and only *act* on it (Loop/Ring Cut) when
        // Edit mode with a selected non-Lattice object actually applies.
        e.preventDefault()
        const store = useSceneStore.getState()
        if (store.mode !== 'edit' || !store.selectedObjectId) return
        // A Lattice's vertex count/order is load-bearing for FFD — see ToolPane's `isLattice` doc
        if (store.objects.find((o) => o.id === store.selectedObjectId)?.kind === 'lattice') return
        if (e.shiftKey) {
          store.setActiveTool(store.activeTool === 'ringcut' ? 'select' : 'ringcut')
        } else {
          store.setActiveTool(store.activeTool === 'loopcut' ? 'select' : 'loopcut')
        }
        return
      }

      if (!meta && e.key.toLowerCase() === 'p') {
        const store = useSceneStore.getState()
        if (store.mode !== 'edit') return
        e.preventDefault()
        store.setEditPivotFromSelection()
        return
      }

      if (!meta && e.key.toLowerCase() === 'k') {
        const store = useSceneStore.getState()
        if (store.mode !== 'edit' || !store.selectedObjectId) return
        // A Lattice's vertex count/order is load-bearing for FFD — see ToolPane's `isLattice` doc
        if (store.objects.find((o) => o.id === store.selectedObjectId)?.kind === 'lattice') return
        e.preventDefault()
        store.setActiveTool(store.activeTool === 'knife' ? 'select' : 'knife')
        return
      }

      // J for Fan Cut — needs one or more outer-silhouette edges of the same face named by the
      // current selection (any selected edges in Edge mode, e.g. 2 meeting at one corner, or the
      // edges already connecting the selected vertices in Vertex mode); see ToolPane's
      // `fanCutEdges`/`fanCutValid` doc for the same resolution logic.
      if (!meta && e.key.toLowerCase() === 'j') {
        const store = useSceneStore.getState()
        if (store.mode !== 'edit' || !store.selectedObjectId) return
        const obj = store.objects.find((o) => o.id === store.selectedObjectId)
        if (!obj || obj.kind === 'lattice') return
        let edges: [number, number][] | null = null
        if (store.editElementType === 'edge' && store.selectedEdges.size >= 1) {
          edges = Array.from(store.selectedEdges).map((key) => {
            const [a, b] = key.split('_').map(Number)
            return [a, b] as [number, number]
          })
        } else if (store.editElementType === 'vertex' && store.selectedVertices.size >= 2) {
          const derived = edgesAmongVertices(obj.mesh, Array.from(store.selectedVertices))
          edges = derived.length > 0 ? derived : null
        }
        if (store.activeTool !== 'fancut' && (!edges || findCommonBoundaryFace(obj.mesh, edges) === null)) return
        e.preventDefault()
        store.setActiveTool(store.activeTool === 'fancut' ? 'select' : 'fancut')
        return
      }

      if (meta && e.key.toLowerCase() === 'a') {
        const store = useSceneStore.getState()
        if (store.mode !== 'edit' || !store.selectedObjectId) return
        e.preventDefault()
        store.selectAll()
        return
      }

      if (meta && e.key.toLowerCase() === 'i') {
        const store = useSceneStore.getState()
        if (store.mode !== 'edit' || !store.selectedObjectId) return
        e.preventDefault()
        store.invertSelection()
        return
      }

      if (meta && e.key.toLowerCase() === 'l') {
        const store = useSceneStore.getState()
        if (store.mode !== 'edit' || !store.selectedObjectId) return
        e.preventDefault()
        store.selectLinked()
        return
      }

      if (e.key === 'Tab') {
        e.preventDefault()
        const store = useSceneStore.getState()
        if (!store.selectedObjectId) return
        store.setMode(store.mode === 'object' ? 'edit' : 'object')
        return
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        const store = useSceneStore.getState()
        if (store.mode === 'object' && store.selectedObjectId) {
          e.preventDefault()
          store.removeObject(store.selectedObjectId)
        } else if (store.mode === 'edit') {
          e.preventDefault()
          store.deleteSelection()
        }
        return
      }

      // Blender's literal Ctrl+X (not Cmd+X on Mac, which stays the OS "Cut" shortcut) for
      // dissolve — merges the faces around the selection instead of deleting them outright
      if (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'x') {
        const store = useSceneStore.getState()
        if (store.mode !== 'edit') return
        e.preventDefault()
        store.dissolveSelection()
        return
      }

      if (e.key === '1' || e.key === '2' || e.key === '3') {
        const store = useSceneStore.getState()
        if (store.mode !== 'edit') return
        e.preventDefault()
        store.setEditElementType(e.key === '1' ? 'vertex' : e.key === '2' ? 'edge' : 'face')
        return
      }

      if (e.key.toLowerCase() === 'f') {
        const store = useSceneStore.getState()
        if (store.mode !== 'edit' || store.editElementType !== 'vertex' || store.selectedVertices.size < 3) {
          return
        }
        e.preventDefault()
        store.fillSelectedFace()
      }
    }
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 2 || !awaitingMergeRef.current) return
      e.preventDefault()
      awaitingMergeRef.current = false
      setAwaitingMerge(false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('mousedown', onMouseDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('mousedown', onMouseDown)
    }
  }, [])

  const startSidebarResize = (e: ReactPointerEvent) => {
    e.preventDefault()
    resizingRef.current = true
    const onMove = (ev: PointerEvent) => {
      if (!resizingRef.current) return
      // the sidebar sits to the right of the viewport, so dragging left grows it
      const next = window.innerWidth - ev.clientX
      setSidebarWidth(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, next)))
    }
    const onUp = () => {
      resizingRef.current = false
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const startPropertiesResize = (e: ReactPointerEvent) => {
    e.preventDefault()
    resizingRef.current = true
    const onMove = (ev: PointerEvent) => {
      if (!resizingRef.current) return
      const sidebarRect = sidebarRef.current?.getBoundingClientRect()
      if (!sidebarRect) return
      // properties sits below the outliner and is sized from the bottom up,
      // so dragging up (smaller clientY) grows it
      const next = sidebarRect.bottom - ev.clientY
      const maxHeight = sidebarRect.height - OUTLINER_MIN_HEIGHT
      setPropertiesHeight(Math.min(maxHeight, Math.max(PROPERTIES_MIN_HEIGHT, next)))
    }
    const onUp = () => {
      resizingRef.current = false
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const startTimelineResize = (e: ReactPointerEvent) => {
    e.preventDefault()
    resizingRef.current = true
    const onMove = (ev: PointerEvent) => {
      if (!resizingRef.current) return
      // the timeline is docked flush to the bottom of the window, so its height is just the
      // distance from the cursor to the bottom edge — dragging up (smaller clientY) grows it
      const next = window.innerHeight - ev.clientY
      setTimelineHeight(Math.min(TIMELINE_MAX_HEIGHT, Math.max(TIMELINE_MIN_HEIGHT, next)))
    }
    const onUp = () => {
      resizingRef.current = false
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div className="app">
      <Toolbar />
      <div className="main-area">
        <ToolPane />
        <Viewport />
        {pixelPreviewEnabled && <PixelPreview />}
        <div className="sidebar-resizer" onPointerDown={startSidebarResize} />
        <div className="sidebar" ref={sidebarRef} style={{ width: sidebarWidth }}>
          <Outliner />
          <div className="properties-resizer" onPointerDown={startPropertiesResize} />
          <Properties style={{ height: propertiesHeight }} />
        </div>
        {awaitingMerge && (
          <div className="merge-hint">Merge: 1=first vertex 2=last vertex 3=midpoint (Esc or right-click to cancel)</div>
        )}
      </div>
      <div className="timeline-resizer" onPointerDown={startTimelineResize} />
      <Timeline style={{ height: timelineHeight }} />
    </div>
  )
}
