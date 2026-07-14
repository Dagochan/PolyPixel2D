import { useMemo, useState } from 'react'
import { useSceneStore } from '../scene/store'
import type { SceneObject } from '../scene/types'
import { REFERENCE_IMAGE_ID } from '../scene/types'
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
  const selectedObjectIds = useSceneStore((s) => s.selectedObjectIds)
  const selectObject = useSceneStore((s) => s.selectObject)
  const toggleObjectSelection = useSceneStore((s) => s.toggleObjectSelection)
  const rangeSelectObjects = useSceneStore((s) => s.rangeSelectObjects)
  const joinSelection = useSceneStore((s) => s.joinSelection)
  const toggleVisibility = useSceneStore((s) => s.toggleVisibility)
  const removeObject = useSceneStore((s) => s.removeObject)
  const renameObject = useSceneStore((s) => s.renameObject)
  const setParent = useSceneStore((s) => s.setParent)
  const reorder = useSceneStore((s) => s.reorder)
  const referenceImage = useSceneStore((s) => s.referenceImage)
  const setReferenceImageTransform = useSceneStore((s) => s.setReferenceImageTransform)
  const setReferenceImage = useSceneStore((s) => s.setReferenceImage)
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

  // every object in the exact order the tree currently renders it (respecting collapsed nodes) —
  // used only to resolve a Shift+click range between the active object and the clicked one.
  const flattenVisible = (parentId: string | null): SceneObject[] => {
    const kids = childrenOf(parentId)
    const out: SceneObject[] = []
    for (const k of kids) {
      out.push(k)
      if (!collapsed.has(k.id)) out.push(...flattenVisible(k.id))
    }
    return out
  }

  const handleRowClick = (e: React.MouseEvent, obj: SceneObject) => {
    if (e.ctrlKey || e.metaKey) {
      toggleObjectSelection(obj.id)
      return
    }
    if (e.shiftKey && selectedObjectId) {
      const flat = flattenVisible(null)
      const i1 = flat.findIndex((o) => o.id === selectedObjectId)
      const i2 = flat.findIndex((o) => o.id === obj.id)
      if (i1 === -1 || i2 === -1) {
        selectObject(obj.id)
        return
      }
      const [lo, hi] = i1 < i2 ? [i1, i2] : [i2, i1]
      rangeSelectObjects(flat.slice(lo, hi + 1).map((o) => o.id))
      return
    }
    selectObject(obj.id)
  }

  // mirrors `joinSelection`'s own eligibility guard (see its doc) — only used to decide whether
  // the Join button is enabled, the store re-checks this itself regardless.
  const childIds = new Set(objects.filter((o) => o.parentId !== null).map((o) => o.id))
  const parentIds = new Set(objects.map((o) => o.parentId).filter((id): id is string => id !== null))
  const canJoin =
    selectedObjectIds.size >= 2 &&
    [...selectedObjectIds].every((id) => {
      const o = objects.find((oo) => oo.id === id)
      return o && (o.kind === undefined || o.kind === 'mesh') && !childIds.has(o.id) && !parentIds.has(o.id)
    })

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
          (obj.id === selectedObjectId ? ' selected' : selectedObjectIds.has(obj.id) ? ' multi-selected' : '') +
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
        onClick={(e) => handleRowClick(e, obj)}
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
            (obj.kind === 'empty' || obj.kind === 'path' || obj.kind === 'lattice' ? ' special-kind' : '') +
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
      <div className="panel-title with-actions">
        <span>Outliner</span>
        {selectedObjectIds.size >= 2 && (
          <button
            disabled={!canJoin}
            title={
              canJoin
                ? 'Join the selected objects into one (the active object survives; the rest are merged into it and removed)'
                : "Can't join: every selected object must be a plain mesh with no parent and no children of its own"
            }
            onClick={() => joinSelection()}
          >
            Join
          </button>
        )}
      </div>
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
        {referenceImage && (
          <li>
            <div
              className={'layer-item' + (selectedObjectId === REFERENCE_IMAGE_ID ? ' selected' : '')}
              onClick={() => selectObject(REFERENCE_IMAGE_ID)}
            >
              <span className="collapse-toggle-spacer" />
              <span className="collapse-toggle-spacer" />
              <span className="layer-name reference-image">Reference image</span>
              <button
                className="icon-btn"
                title="Toggle visibility"
                onClick={(e) => {
                  e.stopPropagation()
                  setReferenceImageTransform({ visible: !referenceImage.visible })
                }}
              >
                {referenceImage.visible ? <VisibleTrueIcon size={18} /> : <VisibleFalseIcon size={18} />}
              </button>
              <button
                className="icon-btn"
                title="Delete"
                onClick={(e) => {
                  e.stopPropagation()
                  setReferenceImage(null)
                }}
              >
                <TrashIcon size={14} />
              </button>
            </div>
          </li>
        )}
        {roots.map((obj) => renderRow(obj, 0))}
        {roots.length === 0 && !referenceImage && <li className="empty-hint">No objects</li>}
      </ul>
    </div>
  )
}
