import { useState } from 'react'
import { useSceneStore } from '../scene/store'
import type { SceneObject } from '../scene/types'
import { VisibleTrueIcon, VisibleFalseIcon } from './icons'

/** Where a drag-over point falls within a row: near the top/bottom edge reorders this object as
 *  a sibling immediately before/after the hovered row (adopting its parent); the middle band
 *  reparents the dragged object as a child of the hovered row instead. */
type DropZone = 'before' | 'after' | 'inside'

function dropZoneAt(e: { clientY: number }, rect: DOMRect): DropZone {
  const ratio = (e.clientY - rect.top) / rect.height
  if (ratio < 0.25) return 'before'
  if (ratio > 0.75) return 'after'
  return 'inside'
}

export default function Outliner() {
  const objects = useSceneStore((s) => s.objects)
  const selectedObjectId = useSceneStore((s) => s.selectedObjectId)
  const selectObject = useSceneStore((s) => s.selectObject)
  const toggleVisibility = useSceneStore((s) => s.toggleVisibility)
  const removeObject = useSceneStore((s) => s.removeObject)
  const renameObject = useSceneStore((s) => s.renameObject)
  const setParent = useSceneStore((s) => s.setParent)
  const reorder = useSceneStore((s) => s.reorder)
  const [dragOver, setDragOver] = useState<{ id: string; zone: DropZone } | null>(null)

  const childrenOf = (parentId: string | null) =>
    objects.filter((o) => o.parentId === parentId).sort((a, b) => b.zOrder - a.zOrder)

  const dropOnRow = (e: React.DragEvent, obj: SceneObject) => {
    e.preventDefault()
    e.stopPropagation()
    // computed fresh from the drop event itself rather than read back from `dragOver` state —
    // that state is only set by a prior dragover, and isn't guaranteed to have committed yet by
    // the time drop fires in the same gesture
    const zone = dropZoneAt(e, e.currentTarget.getBoundingClientRect())
    const draggedId = e.dataTransfer.getData('text/plain')
    setDragOver(null)
    if (!draggedId || draggedId === obj.id) return
    if (zone === 'inside') {
      setParent(draggedId, obj.id)
    } else {
      // become a sibling at this row's level, positioned immediately before/after it in the
      // (global, flat) zOrder — zOrder values are contiguous 0..N-1, so the row's own zOrder
      // doubles as its index in that ordering
      setParent(draggedId, obj.parentId)
      reorder(draggedId, zone === 'before' ? obj.zOrder : obj.zOrder + 1)
    }
  }

  const renderRow = (obj: SceneObject, depth: number) => (
    <li key={obj.id}>
      <div
        className={
          'layer-item' +
          (obj.id === selectedObjectId ? ' selected' : '') +
          (dragOver?.id === obj.id ? ` drop-${dragOver.zone}` : '')
        }
        style={{ paddingLeft: depth * 16 }}
        draggable
        onDragStart={(e) => e.dataTransfer.setData('text/plain', obj.id)}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver({ id: obj.id, zone: dropZoneAt(e, e.currentTarget.getBoundingClientRect()) })
        }}
        onDragLeave={() => setDragOver((d) => (d?.id === obj.id ? null : d))}
        onDrop={(e) => dropOnRow(e, obj)}
        onDragEnd={() => setDragOver(null)}
        onClick={() => selectObject(obj.id)}
      >
        <span className="drag-handle" title="ドラッグして並び替え/ペアレント">
          ⠿
        </span>
        {obj.kind === 'empty' && <span title="Empty（メッシュなし）">✛</span>}
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
          {obj.visible ? <VisibleTrueIcon size={18} /> : <VisibleFalseIcon size={18} />}
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
          setDragOver(null)
          if (draggedId) setParent(draggedId, null)
        }}
      >
        {roots.map((obj) => renderRow(obj, 0))}
        {roots.length === 0 && <li className="empty-hint">オブジェクトがありません</li>}
      </ul>
    </div>
  )
}
