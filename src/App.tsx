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
        }
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
