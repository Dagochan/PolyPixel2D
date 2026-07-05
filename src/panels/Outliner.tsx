import { useMemo, useState } from 'react'
import { useSceneStore } from '../scene/store'
import type { SceneObject } from '../scene/types'
import { getFakePhysics } from '../scene/fakePhysics'
import { collectFakeBehindMaskIds } from '../scene/fakeBehind'
import { VisibleTrueIcon, VisibleFalseIcon, TrashIcon } from './icons'

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
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  // objects currently referenced by some other object's Fake Behind `maskObjectIds` — being a
  // mask is derived from that reference, not a role flag stored on the object itself (see
  // `collectFakeBehindMaskIds`'s doc), so this is recomputed whenever the scene changes
  const fakeBehindMaskIds = useMemo(() => collectFakeBehindMaskIds(objects), [objects])

  const toggleCollapsed = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

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

  const renderRow = (obj: SceneObject, depth: number) => {
    const children = childrenOf(obj.id)
    const isCollapsed = collapsed.has(obj.id)
    return (
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
        <span className="drag-handle" title="Drag to reorder/reparent">
          ⠿
        </span>
        {children.length > 0 ? (
          <button
            className="icon-btn collapse-toggle"
            title={isCollapsed ? 'Expand' : 'Collapse'}
            onClick={(e) => {
              e.stopPropagation()
              toggleCollapsed(obj.id)
            }}
          >
            {isCollapsed ? '▶' : '▼'}
          </button>
        ) : (
          <span className="collapse-toggle-spacer" />
        )}
        {obj.kind === 'empty' && <span title="Empty (no mesh)">✛</span>}
        {obj.kind === 'path' && <span title="Path (curve, no mesh)">〜</span>}
        {obj.kind === 'lattice' && <span title="Lattice (FFD cage)">#</span>}
        {fakeBehindMaskIds.has(obj.id) && (
          <span className="fake-behind-mask-badge" title="Referenced as a Fake Behind mask by another object">
            M
          </span>
        )}
        <input
          className={
            'layer-name' +
            (getFakePhysics(obj)?.enabled ? ' fake-physics' : '') +
            (fakeBehindMaskIds.has(obj.id) ? ' fake-behind-mask' : '')
          }
          title={
            fakeBehindMaskIds.has(obj.id)
              ? 'Referenced as a Fake Behind mask by another object'
              : getFakePhysics(obj)?.enabled
                ? 'Has an enabled Fake Physics modifier'
                : undefined
          }
          value={obj.name}
          onChange={(e) => renameObject(obj.id, e.target.value)}
          onClick={(e) => e.stopPropagation()}
        />
        {obj.parentId !== null && (
          <button
            className="icon-btn"
            title="Unparent"
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
          title="Toggle visibility"
          onClick={(e) => {
            e.stopPropagation()
            toggleVisibility(obj.id)
          }}
        >
          {obj.visible ? <VisibleTrueIcon size={18} /> : <VisibleFalseIcon size={18} />}
        </button>
        <button
          className="icon-btn"
          title="Delete"
          onClick={(e) => {
            e.stopPropagation()
            removeObject(obj.id)
          }}
        >
          <TrashIcon size={14} />
        </button>
      </div>
      {children.length > 0 && !isCollapsed && (
        <ul className="layer-list-nested">{children.map((child) => renderRow(child, depth + 1))}</ul>
      )}
    </li>
    )
  }

  const roots = childrenOf(null)

  return (
    <div className="panel outliner">
      <div className="panel-title">Outliner</div>
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
        {roots.length === 0 && <li className="empty-hint">No objects</li>}
      </ul>
    </div>
  )
}
