import { useEffect } from 'react'
import Viewport from './viewport/Viewport'
import Outliner from './panels/Outliner'
import Properties from './panels/Properties'
import Toolbar from './panels/Toolbar'
import { useSceneStore } from './scene/store'

export default function App() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return

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
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
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
      </div>
    </div>
  )
}
