import { useEffect, useRef, useState } from 'react'
import Viewport from './viewport/Viewport'
import Outliner from './panels/Outliner'
import Properties from './panels/Properties'
import Toolbar from './panels/Toolbar'
import { useSceneStore } from './scene/store'

export default function App() {
  const [awaitingMerge, setAwaitingMerge] = useState(false)
  const awaitingMergeRef = useRef(false)

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
        const store = useSceneStore.getState()
        if (store.mode !== 'edit' || !store.selectedObjectId) return
        e.preventDefault()
        store.setActiveTool(store.activeTool === 'loopcut' ? 'select' : 'loopcut')
        return
      }

      if (meta && e.key.toLowerCase() === 'a') {
        const store = useSceneStore.getState()
        if (store.mode !== 'edit' || !store.selectedObjectId) return
        e.preventDefault()
        store.selectAll()
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

      if (e.key === '1' || e.key === '2' || e.key === '3') {
        const store = useSceneStore.getState()
        if (store.mode !== 'edit') return
        e.preventDefault()
        store.setEditElementType(e.key === '1' ? 'vertex' : e.key === '2' ? 'edge' : 'face')
        return
      }

      if (e.key.toLowerCase() === 'e') {
        const store = useSceneStore.getState()
        if (store.mode !== 'edit') return
        e.preventDefault()
        store.extrudeSelection()
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

  return (
    <div className="app">
      <Toolbar />
      <div className="main-area">
        <Viewport />
        <div className="sidebar">
          <Outliner />
          <Properties />
        </div>
        {awaitingMerge && (
          <div className="merge-hint">マージ: 1=最初の頂点　2=最後の頂点　3=中間位置　(Escまたは右クリックでキャンセル)</div>
        )}
      </div>
    </div>
  )
}
