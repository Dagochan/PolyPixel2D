import { useSceneStore } from '../scene/store'
import type { SceneObject } from '../scene/types'

export default function Outliner() {
  const objects = useSceneStore((s) => s.objects)
  const selectedObjectId = useSceneStore((s) => s.selectedObjectId)
  const selectObject = useSceneStore((s) => s.selectObject)
  const toggleVisibility = useSceneStore((s) => s.toggleVisibility)
  const removeObject = useSceneStore((s) => s.removeObject)
  const renameObject = useSceneStore((s) => s.renameObject)
  const setParent = useSceneStore((s) => s.setParent)

  const childrenOf = (parentId: string | null) =>
    objects.filter((o) => o.parentId === parentId).sort((a, b) => b.zOrder - a.zOrder)

  const renderRow = (obj: SceneObject, depth: number) => (
    <li key={obj.id}>
      <div
        className={'layer-item' + (obj.id === selectedObjectId ? ' selected' : '')}
        style={{ paddingLeft: depth * 16 }}
        draggable
        onDragStart={(e) => e.dataTransfer.setData('text/plain', obj.id)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          const draggedId = e.dataTransfer.getData('text/plain')
          if (draggedId && draggedId !== obj.id) setParent(draggedId, obj.id)
        }}
        onClick={() => selectObject(obj.id)}
      >
        <input
          className="layer-name"
          value={obj.name}
          onChange={(e) => renameObject(obj.id, e.target.value)}
          onClick={(e) => e.stopPropagation()}
        />
        {obj.parentId !== null && (
          <button
            className="icon-btn"
            title="親を解除"
            onClick={(e) => {
              e.stopPropagation()
              setParent(obj.id, null)
            }}
          >
            ⛓️‍💥
          </button>
        )}
        <button
          className="icon-btn"
          title="表示切替"
          onClick={(e) => {
            e.stopPropagation()
            toggleVisibility(obj.id)
          }}
        >
          {obj.visible ? '👁' : '🚫'}
        </button>
        <button
          className="icon-btn"
          title="削除"
          onClick={(e) => {
            e.stopPropagation()
            removeObject(obj.id)
          }}
        >
          🗑
        </button>
      </div>
      {childrenOf(obj.id).length > 0 && (
        <ul className="layer-list-nested">{childrenOf(obj.id).map((child) => renderRow(child, depth + 1))}</ul>
      )}
    </li>
  )

  const roots = childrenOf(null)

  return (
    <div className="panel outliner">
      <div className="panel-title">アウトライナー</div>
      <ul
        className="layer-list"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          // dropping on empty background (not on a row, which calls stopPropagation) detaches to root
          e.preventDefault()
          const draggedId = e.dataTransfer.getData('text/plain')
          if (draggedId) setParent(draggedId, null)
        }}
      >
        {roots.map((obj) => renderRow(obj, 0))}
        {roots.length === 0 && <li className="empty-hint">オブジェクトがありません</li>}
      </ul>
    </div>
  )
}
