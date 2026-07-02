import { useRef, useState, type CSSProperties } from 'react'
import { useSceneStore } from '../scene/store'
import { computeSplitUVs, findIslands } from '../scene/uv'
import { bakeReferenceToTexture } from '../scene/bakeReference'
import { getEdges } from '../scene/meshUtils'
import type { InsertSlot, SceneObject } from '../scene/types'
import UvEditor from './UvEditor'
import { VisibleTrueIcon, VisibleFalseIcon, IslandSelectIcon, LockedIcon, UnlockedIcon, AddKeyframeIcon } from './icons'

function NumberField({
  label,
  value,
  onChange,
  step = 1,
  disabled = false,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  step?: number
  disabled?: boolean
}) {
  return (
    <label className="prop-field">
      <span>{label}</span>
      <input
        type="number"
        step={step}
        disabled={disabled}
        value={Number.isFinite(value) ? round(value) : 0}
        onChange={(e) => {
          const v = parseFloat(e.target.value)
          if (!Number.isNaN(v)) onChange(v)
        }}
      />
    </label>
  )
}

function round(v: number) {
  return Math.round(v * 1000) / 1000
}

const UV_RESOLUTIONS = [512, 1024, 2048, 4096]

function downloadDataUrl(dataUrl: string, filename: string) {
  const link = document.createElement('a')
  link.href = dataUrl
  link.download = filename
  link.click()
}

/** Draw the mesh's UV wireframe (UV 0,0 = bottom-left, image 0,0 = top-left) and trigger a PNG download. */
function exportUvMap(obj: SceneObject, resolution: number) {
  const { mesh: splitMesh, uvs } = computeSplitUVs(obj.mesh, obj.uvIslandTransforms, obj.uvBaseVertices)
  const canvas = document.createElement('canvas')
  canvas.width = resolution
  canvas.height = resolution
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, resolution, resolution)
  ctx.strokeStyle = '#000000'
  ctx.lineWidth = 1
  for (const [a, b] of getEdges(splitMesh)) {
    const pa = uvs[a]
    const pb = uvs[b]
    ctx.beginPath()
    ctx.moveTo(pa.x * resolution, (1 - pa.y) * resolution)
    ctx.lineTo(pb.x * resolution, (1 - pb.y) * resolution)
    ctx.stroke()
  }
  downloadDataUrl(canvas.toDataURL('image/png'), `${obj.name}_uv.png`)
}

/** Shown for any object with at least one island, or with reserved insert slots — lets the user
 *  pick which island draws in front of which when they overlap on screen, and also reserve
 *  "INSERT OBJECT" slots in that same stack so another object (matched by `slotName`) renders
 *  sandwiched in at that position. Listed front-most first; up/down swap rank with whichever
 *  island or slot is adjacent in this combined order. */
function IslandZOrderSection({
  obj,
  objects,
  moveIslandZOrder,
  selectIsland,
  setIslandName,
  clearIslandNameIfEmpty,
  setShowIslandNames,
  toggleIslandVisible,
  toggleIslandLocked,
  addInsertSlot,
  removeInsertSlot,
  setInsertSlotTarget,
  moveInsertSlotRank,
}: {
  obj: SceneObject
  objects: SceneObject[]
  moveIslandZOrder: (id: string, islandIndex: number, direction: 1 | -1) => void
  selectIsland: (islandIndex: number) => void
  setIslandName: (id: string, islandIndex: number, name: string) => void
  clearIslandNameIfEmpty: (id: string, islandIndex: number) => void
  setShowIslandNames: (id: string, show: boolean) => void
  toggleIslandVisible: (id: string, islandIndex: number) => void
  toggleIslandLocked: (id: string, islandIndex: number) => void
  addInsertSlot: (id: string) => void
  removeInsertSlot: (id: string, slotId: string) => void
  setInsertSlotTarget: (id: string, slotId: string, targetSlotName: string) => void
  moveInsertSlotRank: (id: string, slotId: string, direction: 1 | -1) => void
}) {
  const islandCount = findIslands(obj.mesh).length
  const insertSlots = obj.insertSlots ?? []
  if (islandCount < 1 && insertSlots.length === 0) return null

  type Entry = { kind: 'island'; islandIdx: number; rank: number } | { kind: 'slot'; slot: InsertSlot; rank: number }
  const entries: Entry[] = [
    ...Array.from({ length: islandCount }, (_, i) => ({ kind: 'island' as const, islandIdx: i, rank: obj.islandZOrders?.[i] ?? i })),
    ...insertSlots.map((slot) => ({ kind: 'slot' as const, slot, rank: slot.rank })),
  ]
  entries.sort((a, b) => b.rank - a.rank)
  const showNames = obj.showIslandNames ?? false
  const availableSlotNames = Array.from(new Set(objects.map((o) => o.slotName).filter((n): n is string => !!n)))

  return (
    <>
      <div className="prop-section">Islands (Z-order)</div>
      <div className="prop-row prop-static">
        <span>Front on top, back on bottom. Select with the left button, names are editable</span>
      </div>
      <div className="prop-row">
        <button
          className={'icon-btn' + (showNames ? ' active' : '')}
          title="Show all island names in the viewport"
          onClick={() => setShowIslandNames(obj.id, !showNames)}
        >
          🏷 Show names
        </button>
      </div>
      {entries.map((entry, pos) => {
        if (entry.kind === 'island') {
          const islandIdx = entry.islandIdx
          const visible = obj.islandVisible?.[islandIdx] ?? true
          const locked = obj.islandLocked?.[islandIdx] ?? false
          return (
            <div className="prop-row" key={`island-${islandIdx}`}>
              <button
                className="icon-btn"
                title="Select this island (switches to edit mode)"
                onClick={() => selectIsland(islandIdx)}
              >
                <IslandSelectIcon size={18} />
              </button>
              <button
                className="icon-btn"
                title={visible ? 'Hide this island' : 'Show this island'}
                onClick={() => toggleIslandVisible(obj.id, islandIdx)}
              >
                {visible ? <VisibleTrueIcon size={18} /> : <VisibleFalseIcon size={18} />}
              </button>
              <button
                className="icon-btn"
                title={locked ? 'Unlock this island (allow selecting/editing it)' : 'Lock this island (can\'t be selected/edited, wireframe hidden — texture stays visible)'}
                onClick={() => toggleIslandLocked(obj.id, islandIdx)}
              >
                {locked ? <LockedIcon size={18} /> : <UnlockedIcon size={18} />}
              </button>
              <input
                className="layer-name"
                value={obj.islandNames?.[islandIdx] ?? `Island ${islandIdx + 1}`}
                onChange={(e) => setIslandName(obj.id, islandIdx, e.target.value)}
                onBlur={() => clearIslandNameIfEmpty(obj.id, islandIdx)}
                onKeyDown={(e) => {
                  // ignore the Enter that confirms an IME conversion (isComposing) — only a "real"
                  // Enter after that should commit the name and blur, otherwise blurring mid-
                  // composition lets the IME re-commit the same text a second time
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.currentTarget.blur()
                }}
              />
              <button className="zorder-btn" disabled={pos === 0} onClick={() => moveIslandZOrder(obj.id, islandIdx, 1)}>
                ▲
              </button>
              <button
                className="zorder-btn"
                disabled={pos === entries.length - 1}
                onClick={() => moveIslandZOrder(obj.id, islandIdx, -1)}
              >
                ▼
              </button>
            </div>
          )
        }
        const slot = entry.slot
        return (
          <div className="prop-row" key={`slot-${slot.id}`}>
            <span className="insert-slot-label">INSERT OBJECT:</span>
            <select
              value={slot.targetSlotName}
              onChange={(e) => setInsertSlotTarget(obj.id, slot.id, e.target.value)}
            >
              <option value="">EMPTY</option>
              {availableSlotNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <button className="zorder-btn" disabled={pos === 0} onClick={() => moveInsertSlotRank(obj.id, slot.id, 1)}>
              ▲
            </button>
            <button
              className="zorder-btn"
              disabled={pos === entries.length - 1}
              onClick={() => moveInsertSlotRank(obj.id, slot.id, -1)}
            >
              ▼
            </button>
            <button className="icon-btn" title="Remove this slot" onClick={() => removeInsertSlot(obj.id, slot.id)}>
              🗑
            </button>
          </div>
        )
      })}
      <div className="prop-row">
        <button onClick={() => addInsertSlot(obj.id)}>+ Add INSERT OBJECT</button>
      </div>
    </>
  )
}

/** Blender-style shape keys (morph targets) — a list of named alternate vertex poses blended
 *  additively on top of the live mesh (the "Basis") by their own weight. Modeled directly on
 *  `IslandZOrderSection` above: one `.prop-row` per key, editable name, and a delete button. The
 *  "Edit" toggle enters isolated sculpt mode for that key (see `setEditingShapeKey` in the
 *  store) — while active, a banner at the top offers the only way back to normal Basis editing. */
function ShapeKeysSection({
  obj,
  editingShapeKeyId,
  addShapeKey,
  removeShapeKey,
  renameShapeKey,
  setShapeKeyValue,
  setShapeKeyInterpolation,
  setEditingShapeKey,
  insertShapeKeyKeyframe,
  hasActiveClip,
  playheadTime,
  animatedShapeKeyIds,
}: {
  obj: SceneObject
  editingShapeKeyId: string | null
  addShapeKey: (id: string) => void
  removeShapeKey: (id: string, keyId: string) => void
  renameShapeKey: (id: string, keyId: string, name: string) => void
  setShapeKeyValue: (id: string, keyId: string, value: number) => void
  setShapeKeyInterpolation: (id: string, keyId: string, interpolation: 'linear' | 'arc') => void
  setEditingShapeKey: (keyId: string | null) => void
  insertShapeKeyKeyframe: (id: string, keyId: string, time: number) => void
  hasActiveClip: boolean
  playheadTime: number
  /** Shape key ids that have at least one keyframe on the active clip — their name gets a
   *  distinct color, same idea as a DCC's "this property is animated" highlight. */
  animatedShapeKeyIds: Set<string>
}) {
  const keys = obj.shapeKeys ?? []
  const editingKey = keys.find((k) => k.id === editingShapeKeyId)

  return (
    <>
      <div className="prop-section">Shape Keys</div>
      {editingKey && (
        <div className="prop-row prop-static">
          <span>
            Editing shape key: <strong>{editingKey.name}</strong> — pose it with the vertex tool, then
            {editingKey.interpolation === 'arc' && ' — drag the orange pivot handle in the viewport, then rotate (R) to pose the target'}
          </span>
        </div>
      )}
      {editingKey && (
        <div className="prop-row">
          <button onClick={() => setEditingShapeKey(null)}>Done editing</button>
        </div>
      )}
      {keys.map((key) => {
        const isEditing = key.id === editingShapeKeyId
        const value = obj.shapeKeyValues?.[key.id] ?? 0
        const interpolation = key.interpolation ?? 'linear'
        return (
          <div className="prop-row" key={key.id}>
            <button
              className={'icon-btn' + (isEditing ? ' active' : '')}
              title={isEditing ? 'Stop sculpting this shape key' : 'Sculpt this shape key (isolated pose, vertex tool only)'}
              onClick={() => setEditingShapeKey(isEditing ? null : key.id)}
            >
              ✏️
            </button>
            <input
              className={'layer-name' + (animatedShapeKeyIds.has(key.id) ? ' animated' : '')}
              title={animatedShapeKeyIds.has(key.id) ? 'This shape key has keyframes on the active clip' : undefined}
              value={key.name}
              onChange={(e) => renameShapeKey(obj.id, key.id, e.target.value)}
            />
            <button
              className={'icon-btn' + (interpolation === 'linear' ? ' active' : '')}
              title="Linear — straight Cartesian blend from Basis to target"
              onClick={() => setShapeKeyInterpolation(obj.id, key.id, 'linear')}
            >
              Lin
            </button>
            <button
              className={'icon-btn' + (interpolation === 'arc' ? ' active' : '')}
              title="Arc — sweeps along an arc around a pivot instead of a straight line, avoiding volume loss on large rotations"
              onClick={() => setShapeKeyInterpolation(obj.id, key.id, 'arc')}
            >
              Arc
            </button>
            <input
              className="shapekey-value-slider"
              type="range"
              title="Blend weight — 0 is the Basis (original) shape, 1 is the sculpted shape key; a bit of over/undershoot beyond that is allowed for corrective use"
              min={-1}
              max={2}
              step={0.01}
              value={value}
              onChange={(e) => setShapeKeyValue(obj.id, key.id, +e.target.value)}
            />
            <span className="shapekey-value-readout">{round(value)}</span>
            <button
              className="icon-btn"
              disabled={!hasActiveClip}
              title={hasActiveClip ? 'Insert a keyframe for this weight at the playhead' : 'Create/select an animation clip first'}
              onClick={() => insertShapeKeyKeyframe(obj.id, key.id, playheadTime)}
            >
              <AddKeyframeIcon size={14} />
            </button>
            <button className="icon-btn" title="Delete this shape key" onClick={() => removeShapeKey(obj.id, key.id)}>
              🗑
            </button>
          </div>
        )
      })}
      <div className="prop-row">
        <button onClick={() => addShapeKey(obj.id)}>+ Add Shape Key</button>
      </div>
    </>
  )
}

export default function Properties({ style }: { style?: CSSProperties }) {
  const obj = useSceneStore((s) => s.objects.find((o) => o.id === s.selectedObjectId))
  const objects = useSceneStore((s) => s.objects)
  const setTransform = useSceneStore((s) => s.setTransform)
  const setHead = useSceneStore((s) => s.setHead)
  const setTail = useSceneStore((s) => s.setTail)
  const setParent = useSceneStore((s) => s.setParent)
  const setConnected = useSceneStore((s) => s.setConnected)
  const setMaterialColor = useSceneStore((s) => s.setMaterialColor)
  const setMaterialTexture = useSceneStore((s) => s.setMaterialTexture)
  const referenceImage = useSceneStore((s) => s.referenceImage)
  const reunwrapUVs = useSceneStore((s) => s.reunwrapUVs)
  const moveIslandZOrder = useSceneStore((s) => s.moveIslandZOrder)
  const selectIsland = useSceneStore((s) => s.selectIsland)
  const setIslandName = useSceneStore((s) => s.setIslandName)
  const clearIslandNameIfEmpty = useSceneStore((s) => s.clearIslandNameIfEmpty)
  const setShowIslandNames = useSceneStore((s) => s.setShowIslandNames)
  const toggleIslandVisible = useSceneStore((s) => s.toggleIslandVisible)
  const toggleIslandLocked = useSceneStore((s) => s.toggleIslandLocked)
  const setSlotName = useSceneStore((s) => s.setSlotName)
  const addInsertSlot = useSceneStore((s) => s.addInsertSlot)
  const removeInsertSlot = useSceneStore((s) => s.removeInsertSlot)
  const setInsertSlotTarget = useSceneStore((s) => s.setInsertSlotTarget)
  const moveInsertSlotRank = useSceneStore((s) => s.moveInsertSlotRank)
  const editingShapeKeyId = useSceneStore((s) => s.editingShapeKeyId)
  const addShapeKey = useSceneStore((s) => s.addShapeKey)
  const removeShapeKey = useSceneStore((s) => s.removeShapeKey)
  const renameShapeKey = useSceneStore((s) => s.renameShapeKey)
  const setShapeKeyValue = useSceneStore((s) => s.setShapeKeyValue)
  const setShapeKeyInterpolation = useSceneStore((s) => s.setShapeKeyInterpolation)
  const setEditingShapeKey = useSceneStore((s) => s.setEditingShapeKey)
  const insertShapeKeyKeyframe = useSceneStore((s) => s.insertShapeKeyKeyframe)
  const hasActiveClip = useSceneStore((s) => s.activeClipId !== null)
  const activeClip = useSceneStore((s) => s.clips.find((c) => c.id === s.activeClipId))
  const playheadTime = useSceneStore((s) => s.playheadTime)
  const mode = useSceneStore((s) => s.mode)
  const [uvResolution, setUvResolution] = useState(1024)
  const [uvEditorOpen, setUvEditorOpen] = useState(false)
  const [matchTexelDensity, setMatchTexelDensity] = useState(false)
  const [uvTextureOpacity, setUvTextureOpacity] = useState(0.5)
  const [modalOffset, setModalOffset] = useState({ x: 0, y: 0 })
  const modalDragRef = useRef<{ startX: number; startY: number; startOffsetX: number; startOffsetY: number } | null>(
    null,
  )
  const textureInputRef = useRef<HTMLInputElement>(null)
  const [baking, setBaking] = useState(false)

  const handleModalHeaderPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    modalDragRef.current = { startX: e.clientX, startY: e.clientY, startOffsetX: modalOffset.x, startOffsetY: modalOffset.y }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const handleModalHeaderPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = modalDragRef.current
    if (!d) return
    setModalOffset({ x: d.startOffsetX + (e.clientX - d.startX), y: d.startOffsetY + (e.clientY - d.startY) })
  }
  const handleModalHeaderPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    modalDragRef.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
  }

  const handleTextureFile = (objId: string, file: File) => {
    const reader = new FileReader()
    reader.onload = () => setMaterialTexture(objId, reader.result as string)
    reader.readAsDataURL(file)
  }

  const handleBakeReference = async (target: SceneObject) => {
    if (!referenceImage) return
    setBaking(true)
    try {
      const dataUrl = await bakeReferenceToTexture(target, objects, referenceImage, uvResolution)
      setMaterialTexture(target.id, dataUrl)
    } finally {
      setBaking(false)
    }
  }

  return (
    <div className="panel properties" style={style}>
      <div className="panel-title">Properties</div>
      {!obj ? (
        <div className="empty-hint">No object selected</div>
      ) : (
        <div className="prop-body">
          <div className="prop-section">Slot name</div>
          <div className="prop-row">
            <input
              className="layer-name"
              placeholder="(none)"
              title="A name unique within the scene that other objects' INSERT OBJECT slots can reference. Setting the same name on another object removes it from the previous owner"
              value={obj.slotName ?? ''}
              onChange={(e) => setSlotName(obj.id, e.target.value)}
            />
          </div>

          <div className="prop-section">Hierarchy</div>
          {obj.parentId !== null ? (
            <>
              <div className="prop-row prop-static">
                <span>Parent: {objects.find((o) => o.id === obj.parentId)?.name ?? '(unknown)'}</span>
              </div>
              <div className="prop-row">
                <button onClick={() => setParent(obj.id, null)}>Unparent</button>
              </div>
              <div className="prop-row">
                <label className="uv-hint uv-density-toggle">
                  <input
                    type="checkbox"
                    checked={obj.connected}
                    onChange={(e) => setConnected(obj.id, e.target.checked)}
                  />
                  Connect to parent's Tail
                </label>
              </div>
            </>
          ) : (
            <div className="prop-row prop-static">
              <span>No parent object (drag in the outliner to set one)</span>
            </div>
          )}

          <div className="prop-section">Transform</div>
          <div className="prop-row">
            <NumberField
              label="Position X"
              value={obj.transform.x}
              disabled={obj.connected && obj.parentId !== null}
              onChange={(v) => setTransform(obj.id, { x: v })}
            />
            <NumberField
              label="Position Y"
              value={obj.transform.y}
              disabled={obj.connected && obj.parentId !== null}
              onChange={(v) => setTransform(obj.id, { y: v })}
            />
          </div>
          <div className="prop-row">
            <NumberField
              label="Rotation (°)"
              value={(obj.transform.rotation * 180) / Math.PI}
              onChange={(v) => setTransform(obj.id, { rotation: (v * Math.PI) / 180 })}
            />
          </div>
          <div className="prop-row">
            <NumberField
              label="Scale X"
              value={obj.transform.scaleX}
              step={0.1}
              onChange={(v) => setTransform(obj.id, { scaleX: v })}
            />
            <NumberField
              label="Scale Y"
              value={obj.transform.scaleY}
              step={0.1}
              onChange={(v) => setTransform(obj.id, { scaleY: v })}
            />
          </div>

          <div className="prop-section">Head (local coordinates)</div>
          <div className="prop-row">
            <NumberField
              label="Head X"
              value={obj.transform.head.x}
              onChange={(v) => setHead(obj.id, { x: v, y: obj.transform.head.y })}
            />
            <NumberField
              label="Head Y"
              value={obj.transform.head.y}
              onChange={(v) => setHead(obj.id, { x: obj.transform.head.x, y: v })}
            />
          </div>
          <div className="prop-row">
            <NumberField label="Tail X" value={obj.tail.x} onChange={(v) => setTail(obj.id, { x: v, y: obj.tail.y })} />
            <NumberField label="Tail Y" value={obj.tail.y} onChange={(v) => setTail(obj.id, { x: obj.tail.x, y: v })} />
          </div>

          {mode === 'edit' && obj.kind !== 'empty' && (
            <IslandZOrderSection
              obj={obj}
              objects={objects}
              moveIslandZOrder={moveIslandZOrder}
              selectIsland={selectIsland}
              setIslandName={setIslandName}
              clearIslandNameIfEmpty={clearIslandNameIfEmpty}
              setShowIslandNames={setShowIslandNames}
              toggleIslandLocked={toggleIslandLocked}
              toggleIslandVisible={toggleIslandVisible}
              addInsertSlot={addInsertSlot}
              removeInsertSlot={removeInsertSlot}
              setInsertSlotTarget={setInsertSlotTarget}
              moveInsertSlotRank={moveInsertSlotRank}
            />
          )}

          {mode === 'edit' && obj.kind !== 'empty' && (
            <ShapeKeysSection
              obj={obj}
              editingShapeKeyId={editingShapeKeyId}
              addShapeKey={addShapeKey}
              removeShapeKey={removeShapeKey}
              renameShapeKey={renameShapeKey}
              setShapeKeyValue={setShapeKeyValue}
              setShapeKeyInterpolation={setShapeKeyInterpolation}
              setEditingShapeKey={setEditingShapeKey}
              insertShapeKeyKeyframe={insertShapeKeyKeyframe}
              hasActiveClip={hasActiveClip}
              animatedShapeKeyIds={
                new Set(
                  (activeClip?.shapeKeyTracks ?? [])
                    .filter((t) => t.objectId === obj.id && t.keyframes.length > 0)
                    .map((t) => t.shapeKeyId),
                )
              }
              playheadTime={playheadTime}
            />
          )}

          {obj.kind === 'empty' ? (
            <div className="prop-row prop-static">
              <span>Empty (no mesh, a dummy object for hierarchy)</span>
            </div>
          ) : (
            <>
              <div className="prop-section">Material</div>
              <div className="prop-row">
                <label className="prop-field">
                  <span>Color{obj.material.textureUrl ? ' (multiplied with texture)' : ''}</span>
                  <input
                    type="color"
                    value={obj.material.color}
                    onChange={(e) => setMaterialColor(obj.id, e.target.value)}
                  />
                </label>
              </div>
              {obj.material.textureUrl && (
                <div className="prop-row">
                  <img src={obj.material.textureUrl} alt="Texture" className="texture-thumb" />
                </div>
              )}
              <div className="prop-row">
                <input
                  ref={textureInputRef}
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) handleTextureFile(obj.id, file)
                    e.target.value = ''
                  }}
                />
                <button onClick={() => textureInputRef.current?.click()}>Set texture</button>
                {obj.material.textureUrl && (
                  <>
                    <button onClick={() => setMaterialTexture(obj.id, undefined)}>Remove texture</button>
                    <button
                      onClick={() => downloadDataUrl(obj.material.textureUrl!, `${obj.name}_texture.png`)}
                    >
                      Export texture
                    </button>
                  </>
                )}
              </div>

              <div className="prop-section">UV</div>
              <div className="prop-row">
                <button
                  onClick={() => {
                    setModalOffset({ x: 0, y: 0 })
                    setUvEditorOpen(true)
                  }}
                >
                  Edit UVs...
                </button>
                <button
                  title="Recompute UVs from the current shape. Normally moving vertices keeps UVs fixed and stretches the texture instead — use this after a major reshape when you want to re-unwrap"
                  onClick={() => reunwrapUVs(obj.id)}
                >
                  Re-unwrap UVs
                </button>
                {referenceImage && (
                  <button
                    title="Bake the reference image into a texture matching this object's UV layout, and apply it directly"
                    disabled={baking}
                    onClick={() => handleBakeReference(obj)}
                  >
                    {baking ? 'Baking…' : 'Bake reference image'}
                  </button>
                )}
              </div>
              <div className="prop-row">
                <label className="prop-field">
                  <span>Resolution</span>
                  <select value={uvResolution} onChange={(e) => setUvResolution(parseInt(e.target.value, 10))}>
                    {UV_RESOLUTIONS.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </label>
                <button onClick={() => exportUvMap(obj, uvResolution)}>Export UV map</button>
              </div>

              <div className="prop-section">Mesh</div>
              <div className="prop-row prop-static">
                <span>Vertices: {obj.mesh.vertices.length}</span>
                <span>Faces: {obj.mesh.faces.length}</span>
              </div>
            </>
          )}
        </div>
      )}

      {uvEditorOpen && obj && obj.kind !== 'empty' && (
        <div className="uv-modal-backdrop" onClick={() => setUvEditorOpen(false)}>
          <div
            className="uv-modal"
            style={{ transform: `translate(-50%, -50%) translate(${modalOffset.x}px, ${modalOffset.y}px)` }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="uv-modal-header"
              onPointerDown={handleModalHeaderPointerDown}
              onPointerMove={handleModalHeaderPointerMove}
              onPointerUp={handleModalHeaderPointerUp}
            >
              <span>UV Editor — {obj.name}</span>
              <button onPointerDown={(e) => e.stopPropagation()} onClick={() => setUvEditorOpen(false)}>
                Close
              </button>
            </div>
            <UvEditor
              obj={obj}
              size={560}
              matchTexelDensity={matchTexelDensity}
              textureUrl={obj.material.textureUrl}
              textureOpacity={uvTextureOpacity}
            />
            <label className="uv-hint uv-density-toggle">
              <input
                type="checkbox"
                checked={matchTexelDensity}
                onChange={(e) => setMatchTexelDensity(e.target.checked)}
              />
              Match texel density (scaling one island keeps the others' ratio in sync)
            </label>
            {obj.material.textureUrl && (
              <label className="uv-hint uv-density-toggle">
                Texture opacity
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={uvTextureOpacity}
                  onChange={(e) => setUvTextureOpacity(+e.target.value)}
                />
              </label>
            )}
            <div className="uv-hint">Drag to move, pull the top-right corner to scale, the bottom-left lock icon excludes it from density matching</div>
          </div>
        </div>
      )}
    </div>
  )
}
