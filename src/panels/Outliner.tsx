import { useSceneStore } from '../scene/store'

export default function Outliner() {
  const objects = useSceneStore((s) => s.objects)
  const selectedObjectId = useSceneStore((s) => s.selectedObjectId)
  const selectObject = useSceneStore((s) => s.selectObject)
  const toggleVisibility = useSceneStore((s) => s.toggleVisibility)
  const removeObject = useSceneStore((s) => s.removeObject)
  const renameObject = useSceneStore((s) => s.renameObject)
  const setColor = useSceneStore((s) => s.setColor)
  const reorder = useSceneStore((s) => s.reorder)

  const sorted = [...objects].sort((a, b) => b.zOrder - a.zOrder)

  return (
    <div className="panel outliner">
      <div className="panel-title">アウトライナー</div>
      <ul className="layer-list">
        {sorted.map((obj) => (
          <li
            key={obj.id}
            className={'layer-item' + (obj.id === selectedObjectId ? ' selected' : '')}
            draggable
            onDragStart={(e) => e.dataTransfer.setData('text/plain', obj.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              const draggedId = e.dataTransfer.getData('text/plain')
              if (draggedId && draggedId !== obj.id) reorder(draggedId, obj.zOrder)
            }}
            onClick={() => selectObject(obj.id)}
          >
            <input
              type="color"
              className="swatch"
              value={obj.color}
              title="色を変更"
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setColor(obj.id, e.target.value)}
            />
            <input
              className="layer-name"
              value={obj.name}
              onChange={(e) => renameObject(obj.id, e.target.value)}
              onClick={(e) => e.stopPropagation()}
            />
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
          </li>
        ))}
        {sorted.length === 0 && <li className="empty-hint">オブジェクトがありません</li>}
      </ul>
    </div>
  )
}
