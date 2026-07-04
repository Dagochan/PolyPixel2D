import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { selectedVertexIndices, useSceneStore } from '../scene/store'
import { computeSplitUVs, findIslands } from '../scene/uv'
import { bakeReferenceToTexture } from '../scene/bakeReference'
import { getEdges } from '../scene/meshUtils'
import type {
  AppMode,
  FakeBehindSettings,
  FakeFlagSettings,
  FakePhysicsMeshSettings,
  FakePhysicsSettings,
  FfdSettings,
  FollowPathSettings,
  InsertSlot,
  Modifier,
  PathDeformRailSettings,
  SceneObject,
} from '../scene/types'
import UvEditor from './UvEditor'
import { VisibleTrueIcon, VisibleFalseIcon, IslandSelectIcon, LockedIcon, UnlockedIcon, AddKeyframeIcon, TrashIcon, PlayIcon, StopIcon } from './icons'

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

/** Which `Section` titles are collapsed — global UI state (not per-object, not undo-tracked),
 *  matching Blender's panel-collapse behavior: it's about how you like to view the properties
 *  editor, not something that travels with the selected object or the scene file. */
const CollapseContext = createContext<{ collapsed: Set<string>; toggle: (title: string) => void }>({
  collapsed: new Set(),
  toggle: () => {},
})

/** A `.prop-section` header that doubles as a collapse/expand toggle for everything passed as
 *  `children` — every section in this panel should use this instead of a bare
 *  `<div className="prop-section">` so the whole panel gets collapsible sections uniformly. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  const { collapsed, toggle } = useContext(CollapseContext)
  const isCollapsed = collapsed.has(title)
  return (
    <>
      <div className="prop-section prop-section-toggle" onClick={() => toggle(title)}>
        <span className="prop-section-caret">{isCollapsed ? '▸' : '▾'}</span>
        {title}
      </div>
      {!isCollapsed && children}
    </>
  )
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
    <Section title="Islands (Z-order)">
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
              <TrashIcon size={14} />
            </button>
          </div>
        )
      })}
      <div className="prop-row">
        <button onClick={() => addInsertSlot(obj.id)}>+ Add INSERT OBJECT</button>
      </div>
    </Section>
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
    <Section title="Shape Keys">
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
              <TrashIcon size={14} />
            </button>
          </div>
        )
      })}
      <div className="prop-row">
        <button onClick={() => addShapeKey(obj.id)}>+ Add Shape Key</button>
      </div>
    </Section>
  )
}

/** One modifier's settings UI, inside the generic chrome (`ModifiersSection`) that gives it a
 *  name row with an enable toggle and a remove button — same shape every future modifier type
 *  will follow. */
function FakeFlagModifierBox({
  obj,
  settings,
  mode,
  hasVertexSelection,
  removeModifier,
  toggleFakeFlagEnabled,
  updateFakeFlag,
  assignFakeFlagAnchor,
  clearFakeFlagAnchor,
  previewFakeFlag,
  togglePreviewFakeFlag,
}: {
  obj: SceneObject
  settings: FakeFlagSettings
  mode: AppMode
  hasVertexSelection: boolean
  removeModifier: (id: string, type: Modifier['type']) => void
  toggleFakeFlagEnabled: (id: string) => void
  updateFakeFlag: (id: string, patch: Partial<FakeFlagSettings>) => void
  assignFakeFlagAnchor: (id: string) => void
  clearFakeFlagAnchor: (id: string) => void
  previewFakeFlag: boolean
  togglePreviewFakeFlag: () => void
}) {
  const anchorCount = settings.anchorVertices?.length ?? 0
  const vertexMode = anchorCount > 0

  return (
    <div className="modifier-box">
      <div className="prop-row modifier-box-header">
        <button
          className={'icon-btn' + (settings.enabled ? ' active' : '')}
          title={settings.enabled ? 'Disable (keeps its settings)' : 'Enable'}
          onClick={() => toggleFakeFlagEnabled(obj.id)}
        >
          {settings.enabled ? <VisibleTrueIcon size={16} /> : <VisibleFalseIcon size={16} />}
        </button>
        <span className="modifier-box-title">Fake Flag</span>
        <button className="icon-btn" title="Remove this modifier" onClick={() => removeModifier(obj.id, 'fakeFlag')}>
          <TrashIcon size={14} />
        </button>
      </div>
      {settings.enabled && (
        <>
          <div className="prop-row prop-static">
            <span>
              {vertexMode
                ? `Vertex (cloth) mode — ${anchorCount} anchor vert${anchorCount === 1 ? '' : 's'} pinned`
                : 'Object rotation mode — sways the whole object about its head'}
            </span>
          </div>
          {obj.kind !== 'empty' && (
            <div className="prop-row">
              <button
                disabled={mode !== 'edit' || !hasVertexSelection}
                title={
                  mode !== 'edit'
                    ? 'Switch to Edit Mode and select vertices to pin as the anchor'
                    : !hasVertexSelection
                      ? 'Select the vertices to pin (e.g. a flag\'s luff against its pole) first'
                      : 'Pin the current vertex selection as the anchor — switches to vertex (cloth) mode'
                }
                onClick={() => assignFakeFlagAnchor(obj.id)}
              >
                Assign anchor from selection
              </button>
              {vertexMode && (
                <button title="Clear the anchor — switches back to object rotation mode" onClick={() => clearFakeFlagAnchor(obj.id)}>
                  Clear anchor
                </button>
              )}
            </div>
          )}
          <div className="prop-row">
            <button
              className={'icon-btn' + (previewFakeFlag ? ' active' : '')}
              title="Live wall-clock preview — see the sway/flutter without laying down any keyframes"
              onClick={togglePreviewFakeFlag}
            >
              {previewFakeFlag ? <StopIcon size={14} /> : <PlayIcon size={14} />}
              {previewFakeFlag ? 'Stop preview' : 'Preview'}
            </button>
          </div>
          <div className="prop-row">
            <NumberField
              label={vertexMode ? 'Amplitude (units)' : 'Amplitude (°)'}
              value={settings.amplitude}
              onChange={(v) => updateFakeFlag(obj.id, { amplitude: v })}
            />
            <NumberField
              label="Cycles / loop"
              value={settings.cyclesPerLoop}
              onChange={(v) => updateFakeFlag(obj.id, { cyclesPerLoop: Math.max(1, Math.round(v)) })}
            />
          </div>
          <div className="prop-row">
            <NumberField label="Phase" value={settings.phase} step={0.05} onChange={(v) => updateFakeFlag(obj.id, { phase: v })} />
            <NumberField label="Direction (°)" value={settings.direction} onChange={(v) => updateFakeFlag(obj.id, { direction: v })} />
          </div>
          <div className="prop-row">
            <NumberField label="Wavelength" value={settings.wavelength} onChange={(v) => updateFakeFlag(obj.id, { wavelength: v })} />
          </div>
          <div className="prop-row">
            <NumberField
              label="Random strength"
              value={settings.randomStrength}
              step={0.05}
              onChange={(v) => updateFakeFlag(obj.id, { randomStrength: v })}
            />
            <NumberField label="Seed" value={settings.seed} onChange={(v) => updateFakeFlag(obj.id, { seed: v })} />
          </div>
        </>
      )}
    </div>
  )
}

/** One modifier's settings UI for Fake Physics — same chrome-vs-content split as
 *  `FakeFlagModifierBox`. Unlike Fake Flag this isn't live: "Bake" runs the damped-spring
 *  simulation across the active clip and writes dense keyframes, so changing settings here doesn't
 *  do anything visible until you bake (or re-bake) again. */
function FakePhysicsModifierBox({
  obj,
  settings,
  removeModifier,
  toggleFakePhysicsEnabled,
  updateFakePhysics,
  clearFakePhysicsBake,
  isBaked,
}: {
  obj: SceneObject
  settings: FakePhysicsSettings
  removeModifier: (id: string, type: Modifier['type']) => void
  toggleFakePhysicsEnabled: (id: string) => void
  updateFakePhysics: (id: string, patch: Partial<FakePhysicsSettings>) => void
  clearFakePhysicsBake: (id: string) => void
  isBaked: boolean
}) {
  return (
    <div className="modifier-box">
      <div className="prop-row modifier-box-header">
        <button
          className={'icon-btn' + (settings.enabled ? ' active' : '')}
          title={settings.enabled ? 'Disable (keeps its settings and any existing bake)' : 'Enable'}
          onClick={() => toggleFakePhysicsEnabled(obj.id)}
        >
          {settings.enabled ? <VisibleTrueIcon size={16} /> : <VisibleFalseIcon size={16} />}
        </button>
        <span className="modifier-box-title">Fake Physics</span>
        <button className="icon-btn" title="Remove this modifier (also clears its own bake)" onClick={() => removeModifier(obj.id, 'fakePhysics')}>
          <TrashIcon size={14} />
        </button>
      </div>
      {settings.enabled && (
        <>
          <div className="prop-row prop-static">
            <span>Lags behind its parent{isBaked ? ', baked' : ', not baked yet'}</span>
          </div>
          <div className="prop-row">
            <NumberField
              label="Stiffness"
              value={settings.stiffness}
              step={0.05}
              onChange={(v) => updateFakePhysics(obj.id, { stiffness: Math.min(1, Math.max(0, v)) })}
            />
            <NumberField
              label="Converge start"
              value={settings.convergeStart}
              step={0.05}
              onChange={(v) => updateFakePhysics(obj.id, { convergeStart: Math.min(1, Math.max(0, v)) })}
            />
          </div>
          {isBaked && (
            <div className="prop-row">
              <button title="Remove this object's own baked keyframes, reverting it to its base motion" onClick={() => clearFakePhysicsBake(obj.id)}>
                Clear bake
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

const FAKE_PHYSICS_MESH_SECTION_NUMBERS = [1, 2, 3, 4, 5] as const
const FAKE_PHYSICS_MESH_SECTION_SUFFIX: Record<number, string> = { 1: 'ROOT', 5: 'TIP' }

const STIFFNESS_GRAPH_TOP = 8
const STIFFNESS_GRAPH_BOTTOM = 82
const STIFFNESS_GRAPH_LEFT = 20
const STIFFNESS_GRAPH_RIGHT = 200
const stiffnessPointX = (i: number) => STIFFNESS_GRAPH_LEFT + (i * (STIFFNESS_GRAPH_RIGHT - STIFFNESS_GRAPH_LEFT)) / 4
const stiffnessValueToY = (v: number) => STIFFNESS_GRAPH_BOTTOM - v * (STIFFNESS_GRAPH_BOTTOM - STIFFNESS_GRAPH_TOP)

/** A Catmull-Rom-through-Bezier smooth curve connecting `points` in order — purely decorative
 *  (the five `sectionStiffness` values are the only data; this just visualizes them as a curve
 *  instead of five disconnected dots, which reads much better for "tapering toward the tip"). */
function smoothPath(points: { x: number; y: number }[]): string {
  if (points.length < 2) return ''
  let d = `M ${points[0].x} ${points[0].y}`
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[i + 2] ?? p2
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 }
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 }
    d += ` C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p2.x} ${p2.y}`
  }
  return d
}

/** Advanced-mode Stiffness editor: a small draggable curve (Sections 1-5 left to right, Soft at
 *  the bottom to Hard at the top) instead of five number fields — deliberately no numeric readout
 *  at all (this is meant to be tuned by feel, not by typing exact values; see `NumberField` for
 *  the still-numeric Simple-mode dial). Drag grouping matches `setFakeFlagDirection`'s pattern:
 *  one `beginChange()` at pointerdown, then plain live-writes for every pointermove in between. */
function FakePhysicsMeshStiffnessCurve({
  objId,
  values,
  beginChange,
  setSectionStiffnessLive,
}: {
  objId: string
  values: FakePhysicsMeshSettings['sectionStiffness']
  beginChange: () => void
  setSectionStiffnessLive: (id: string, index: 0 | 1 | 2 | 3 | 4, value: number) => void
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const draggingRef = useRef<number | null>(null)

  function valueFromClientY(clientY: number): number {
    const rect = svgRef.current!.getBoundingClientRect()
    const svgY = ((clientY - rect.top) / rect.height) * 90
    return Math.min(1, Math.max(0, (STIFFNESS_GRAPH_BOTTOM - svgY) / (STIFFNESS_GRAPH_BOTTOM - STIFFNESS_GRAPH_TOP)))
  }

  const points = values.map((v, i) => ({ x: stiffnessPointX(i), y: stiffnessValueToY(v) }))

  return (
    <svg
      ref={svgRef}
      viewBox="0 0 220 90"
      style={{ width: '100%', height: 90, touchAction: 'none' }}
      onPointerMove={(e) => {
        if (draggingRef.current === null) return
        setSectionStiffnessLive(objId, draggingRef.current as 0 | 1 | 2 | 3 | 4, valueFromClientY(e.clientY))
      }}
    >
      <text x={2} y={12} fontSize={8} fill="#777">
        Hard
      </text>
      <text x={2} y={STIFFNESS_GRAPH_BOTTOM} fontSize={8} fill="#777">
        Soft
      </text>
      {[0, 1, 2, 3, 4].map((i) => (
        <line
          key={`v${i}`}
          x1={stiffnessPointX(i)}
          y1={STIFFNESS_GRAPH_TOP}
          x2={stiffnessPointX(i)}
          y2={STIFFNESS_GRAPH_BOTTOM}
          stroke="#3a3b3e"
          strokeDasharray="2,2"
        />
      ))}
      {[0.25, 0.5, 0.75].map((f) => (
        <line
          key={`h${f}`}
          x1={STIFFNESS_GRAPH_LEFT}
          y1={STIFFNESS_GRAPH_TOP + f * (STIFFNESS_GRAPH_BOTTOM - STIFFNESS_GRAPH_TOP)}
          x2={STIFFNESS_GRAPH_RIGHT}
          y2={STIFFNESS_GRAPH_TOP + f * (STIFFNESS_GRAPH_BOTTOM - STIFFNESS_GRAPH_TOP)}
          stroke="#3a3b3e"
          strokeDasharray="2,2"
        />
      ))}
      <rect
        x={STIFFNESS_GRAPH_LEFT}
        y={STIFFNESS_GRAPH_TOP}
        width={STIFFNESS_GRAPH_RIGHT - STIFFNESS_GRAPH_LEFT}
        height={STIFFNESS_GRAPH_BOTTOM - STIFFNESS_GRAPH_TOP}
        fill="none"
        stroke="#555"
      />
      <path d={smoothPath(points)} fill="none" stroke="#4ea1ff" strokeWidth={1.5} />
      {points.map((p, i) => (
        <circle
          key={i}
          cx={p.x}
          cy={p.y}
          r={5}
          fill="#4ea1ff"
          stroke="#111"
          style={{ cursor: 'ns-resize' }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            draggingRef.current = i
            beginChange()
          }}
          onPointerUp={(e) => {
            e.currentTarget.releasePointerCapture(e.pointerId)
            draggingRef.current = null
          }}
        />
      ))}
      {['1', '2', '3', '4', '5'].map((label, i) => (
        <text key={label} x={stiffnessPointX(i)} y={STIFFNESS_GRAPH_BOTTOM + 10} fontSize={8} fill="#777" textAnchor="middle">
          {label}
        </text>
      ))}
    </svg>
  )
}

/** One modifier's settings UI for Fake Physics (mesh) — same chrome-vs-content split as
 *  `FakePhysicsModifierBox`, generalized from a chain of objects to 5 fixed vertex groups within
 *  this one mesh. Unlike the object-chain version, there's no "only the ROOT gets a Bake button"
 *  ambiguity to resolve (this modifier only ever describes one object's own mesh), so Bake lives
 *  directly in this box instead of being hoisted into `ModifiersSection`. */
function FakePhysicsMeshModifierBox({
  obj,
  mode,
  settings,
  removeModifier,
  toggleFakePhysicsMeshEnabled,
  updateFakePhysicsMesh,
  setFakePhysicsMeshSectionStiffnessLive,
  beginChange,
  assignFakePhysicsMeshSection,
  selectFakePhysicsMeshSection,
  removeFakePhysicsMeshSectionVertices,
  clearFakePhysicsMeshBake,
  previewFakePhysicsMesh,
  togglePreviewFakePhysicsMesh,
  hasVertexSelection,
  isBaked,
}: {
  obj: SceneObject
  mode: AppMode
  settings: FakePhysicsMeshSettings
  removeModifier: (id: string, type: Modifier['type']) => void
  toggleFakePhysicsMeshEnabled: (id: string) => void
  updateFakePhysicsMesh: (id: string, patch: Partial<FakePhysicsMeshSettings>) => void
  setFakePhysicsMeshSectionStiffnessLive: (id: string, index: 0 | 1 | 2 | 3 | 4, value: number) => void
  beginChange: () => void
  assignFakePhysicsMeshSection: (id: string, section: 1 | 2 | 3 | 4 | 5) => void
  selectFakePhysicsMeshSection: (id: string, section: 1 | 2 | 3 | 4 | 5) => void
  removeFakePhysicsMeshSectionVertices: (id: string, section: 1 | 2 | 3 | 4 | 5) => void
  clearFakePhysicsMeshBake: (id: string) => void
  previewFakePhysicsMesh: boolean
  togglePreviewFakePhysicsMesh: () => void
  hasVertexSelection: boolean
  isBaked: boolean
}) {
  const inEditMode = mode === 'edit'
  return (
    <div className="modifier-box">
      <div className="prop-row modifier-box-header">
        <button
          className={'icon-btn' + (settings.enabled ? ' active' : '')}
          title={settings.enabled ? 'Disable (keeps its settings and any existing bake)' : 'Enable'}
          onClick={() => toggleFakePhysicsMeshEnabled(obj.id)}
        >
          {settings.enabled ? <VisibleTrueIcon size={16} /> : <VisibleFalseIcon size={16} />}
        </button>
        <span className="modifier-box-title">Fake Physics (Mesh)</span>
        <button
          className="icon-btn"
          title="Remove this modifier (also clears its own bake)"
          onClick={() => removeModifier(obj.id, 'fakePhysicsMesh')}
        >
          <TrashIcon size={14} />
        </button>
      </div>
      {settings.enabled && (
        <>
          <div className="prop-row prop-static">
            <span>{isBaked ? 'Baked' : 'Not baked yet'}</span>
          </div>
          <div className="prop-row">
            <button
              className={'icon-btn' + (previewFakePhysicsMesh ? ' active' : '')}
              title="Live preview — drag this object in the viewport to see its lagging sections follow, no bake needed"
              onClick={togglePreviewFakePhysicsMesh}
            >
              {previewFakePhysicsMesh ? <StopIcon size={14} /> : <PlayIcon size={14} />}
              {previewFakePhysicsMesh ? 'Stop preview' : 'Preview'}
            </button>
          </div>
          <div className="prop-row">
            <label className="prop-field">
              <span>Pivot</span>
              <select
                value={settings.pivotMode}
                onChange={(e) => updateFakePhysicsMesh(obj.id, { pivotMode: e.target.value as 'head' | 'centroid' })}
              >
                <option value="head">Head (bending tail/rope)</option>
                <option value="centroid">Section centroid (wobbling blob)</option>
              </select>
            </label>
          </div>
          <div className="prop-row">
            <NumberField
              label="Converge start"
              value={settings.convergeStart}
              step={0.05}
              onChange={(v) => updateFakePhysicsMesh(obj.id, { convergeStart: Math.min(1, Math.max(0, v)) })}
            />
          </div>
          <div className="prop-row prop-static">
            <span>Stiffness</span>
            <button
              className={'icon-btn' + (settings.stiffnessMode === 'advanced' ? ' active' : '')}
              title={
                settings.stiffnessMode === 'simple'
                  ? 'Switch to Advanced: tune each section (1-5) separately — lower toward the tip usually looks most natural'
                  : 'Switch to Simple: one shared dial for all five sections'
              }
              onClick={() =>
                updateFakePhysicsMesh(obj.id, {
                  stiffnessMode: settings.stiffnessMode === 'simple' ? 'advanced' : 'simple',
                })
              }
            >
              {settings.stiffnessMode === 'simple' ? 'Simple' : 'Advanced'}
            </button>
          </div>
          <div className="prop-row">
            {settings.stiffnessMode === 'simple' ? (
              <NumberField
                label="Stiffness (all sections)"
                value={settings.sectionStiffness[0]}
                step={0.05}
                onChange={(nv) => {
                  const v = Math.min(1, Math.max(0, nv))
                  updateFakePhysicsMesh(obj.id, { sectionStiffness: [v, v, v, v, v] })
                }}
              />
            ) : (
              <FakePhysicsMeshStiffnessCurve
                objId={obj.id}
                values={settings.sectionStiffness}
                beginChange={beginChange}
                setSectionStiffnessLive={setFakePhysicsMeshSectionStiffnessLive}
              />
            )}
          </div>
          <div className="prop-row">
            {isBaked && (
              <button title="Remove this object's baked mesh physics tracks" onClick={() => clearFakePhysicsMeshBake(obj.id)}>
                Clear bake
              </button>
            )}
          </div>
          {obj.kind !== 'empty' && (
            <>
              <div className="prop-row prop-static">
                <span>Vertex assignment (Edit Mode)</span>
              </div>
              {FAKE_PHYSICS_MESH_SECTION_NUMBERS.map((section) => {
                const count = settings.sectionVertices[section - 1].length
                return (
                  <div className="prop-row" key={section}>
                    <span className="shapekey-value-readout" style={{ width: 32, textAlign: 'left' }}>
                      {FAKE_PHYSICS_MESH_SECTION_SUFFIX[section] ?? ''}
                    </span>
                    <button
                      style={{ flex: 1, textAlign: 'center' }}
                      disabled={!inEditMode || !hasVertexSelection}
                      title={
                        !inEditMode
                          ? 'Switch to Edit Mode and select vertices first'
                          : !hasVertexSelection
                            ? 'Select the vertices for this section first'
                            : `Assign the current selection to Section ${section}`
                      }
                      onClick={() => assignFakePhysicsMeshSection(obj.id, section)}
                    >
                      Section {section}
                    </button>
                    <span className="shapekey-value-readout" style={{ width: 48 }}>
                      {count} vert{count === 1 ? '' : 's'}
                    </span>
                    <button
                      className="icon-btn"
                      disabled={!inEditMode || count === 0}
                      title="Re-select this section's currently assigned vertices"
                      onClick={() => selectFakePhysicsMeshSection(obj.id, section)}
                    >
                      <IslandSelectIcon size={14} />
                    </button>
                    <button
                      className="icon-btn"
                      disabled={!inEditMode || !hasVertexSelection}
                      title="Remove the current selection from this section"
                      onClick={() => removeFakePhysicsMeshSectionVertices(obj.id, section)}
                    >
                      <TrashIcon size={14} />
                    </button>
                  </div>
                )
              })}
            </>
          )}
        </>
      )}
    </div>
  )
}

/** Label shown in the "+ Add Modifier" dropdown. `fakePhysics`/`fakePhysicsMesh` deliberately
 *  share the same "Fake Physics" label — `ModifiersSection` only ever offers one or the other in
 *  a given `AppMode` (never both at once), so there's no ambiguity, and the shared label reads as
 *  "one feature" rather than two competing ones. Each modifier box's own header title (a separate
 *  hardcoded string, not this map) still distinguishes them once added, for the rare case an
 *  object ends up with both (added in different mode visits). */
const MODIFIER_LABELS: Record<Modifier['type'], string> = {
  fakeFlag: 'Fake Flag',
  fakePhysics: 'Fake Physics',
  fakePhysicsMesh: 'Fake Physics',
  fakeBehind: 'Fake Behind',
  followPath: 'Follow Path',
  pathDeformRail: 'Path Deform',
  ffd: 'FFD (Cage)',
}

/** One modifier's settings UI for Follow Path — see `FollowPathSettings`'s doc. Offered on any
 *  object (no Edit Mode / mesh requirement at all), unlike Path Deform's cage-only restriction. */
function FollowPathModifierBox({
  obj,
  objects,
  settings,
  removeModifier,
  updateFollowPath,
  insertFollowPathProgressKeyframe,
  hasActiveClip,
  playheadTime,
}: {
  obj: SceneObject
  objects: SceneObject[]
  settings: FollowPathSettings
  removeModifier: (id: string, type: Modifier['type']) => void
  updateFollowPath: (id: string, patch: Partial<FollowPathSettings>) => void
  insertFollowPathProgressKeyframe: (objectId: string, time: number) => void
  hasActiveClip: boolean
  playheadTime: number
}) {
  const pathObjects = objects.filter((o) => o.kind === 'path')

  return (
    <div className="modifier-box">
      <div className="prop-row modifier-box-header">
        <button
          className={'icon-btn' + (settings.enabled ? ' active' : '')}
          title={settings.enabled ? 'Disable (keeps its settings)' : 'Enable'}
          onClick={() => updateFollowPath(obj.id, { enabled: !settings.enabled })}
        >
          {settings.enabled ? <VisibleTrueIcon size={16} /> : <VisibleFalseIcon size={16} />}
        </button>
        <span className="modifier-box-title">Follow Path</span>
        <button className="icon-btn" title="Remove this modifier" onClick={() => removeModifier(obj.id, 'followPath')}>
          <TrashIcon size={14} />
        </button>
      </div>
      {settings.enabled && (
        <>
          <div className="prop-row">
            <select
              value={settings.pathObjectId ?? ''}
              onChange={(e) => updateFollowPath(obj.id, { pathObjectId: e.target.value || null })}
            >
              <option value="">(no path assigned)</option>
              {pathObjects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="prop-row">
            <NumberField
              label="Progress"
              value={settings.progress}
              step={0.01}
              onChange={(v) => updateFollowPath(obj.id, { progress: v })}
            />
            <button
              className="icon-btn"
              disabled={!hasActiveClip}
              title={hasActiveClip ? 'Insert a keyframe for Progress at the playhead' : 'Create/select an animation clip first'}
              onClick={() => insertFollowPathProgressKeyframe(obj.id, playheadTime)}
            >
              <AddKeyframeIcon size={14} />
            </button>
          </div>
          <div className="prop-row">
            <button
              className={'icon-btn' + (settings.alignRotation ? ' active' : '')}
              title="Follow Curve — rotate to face the path's direction of travel as Progress moves (Blender's Follow Path 'Follow Curve' option). Off: keeps its own rotation, sliding like a bead on a wire."
              onClick={() => updateFollowPath(obj.id, { alignRotation: !settings.alignRotation })}
            >
              Follow Curve
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/** One modifier's settings UI for Path Deform (Rail) — see `PathDeformRailSettings`'s doc. Only
 *  ever offered on a `kind: 'lattice'` cage (see `ModifiersSection`'s `availableTypes`), so unlike
 *  an ordinary Blender-style Curve Modifier there's no "Center" field — the two rails are generated at exactly the
 *  cage's own half-width, with no free lateral shift to offer. */
function PathDeformRailModifierBox({
  obj,
  objects,
  settings,
  removeModifier,
  updatePathDeformRail,
  insertPathOffsetKeyframe,
  hasActiveClip,
  playheadTime,
}: {
  obj: SceneObject
  objects: SceneObject[]
  settings: PathDeformRailSettings
  removeModifier: (id: string, type: Modifier['type']) => void
  updatePathDeformRail: (id: string, patch: Partial<PathDeformRailSettings>) => void
  insertPathOffsetKeyframe: (objectId: string, time: number) => void
  hasActiveClip: boolean
  playheadTime: number
}) {
  const pathObjects = objects.filter((o) => o.kind === 'path')

  return (
    <div className="modifier-box">
      <div className="prop-row modifier-box-header">
        <button
          className={'icon-btn' + (settings.enabled ? ' active' : '')}
          title={settings.enabled ? 'Disable (keeps its settings)' : 'Enable'}
          onClick={() => updatePathDeformRail(obj.id, { enabled: !settings.enabled })}
        >
          {settings.enabled ? <VisibleTrueIcon size={16} /> : <VisibleFalseIcon size={16} />}
        </button>
        <span className="modifier-box-title">Path Deform</span>
        <button className="icon-btn" title="Remove this modifier" onClick={() => removeModifier(obj.id, 'pathDeformRail')}>
          <TrashIcon size={14} />
        </button>
      </div>
      {settings.enabled && (
        <>
          <div className="prop-row">
            <select
              value={settings.pathObjectId ?? ''}
              onChange={(e) => updatePathDeformRail(obj.id, { pathObjectId: e.target.value || null })}
            >
              <option value="">(no path assigned)</option>
              {pathObjects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="prop-row">
            <button
              className={'icon-btn' + (settings.axis === 'x' ? ' active' : '')}
              title="Local X runs along the path"
              onClick={() => updatePathDeformRail(obj.id, { axis: 'x' })}
            >
              Axis: X
            </button>
            <button
              className={'icon-btn' + (settings.axis === 'y' ? ' active' : '')}
              title="Local Y runs along the path"
              onClick={() => updatePathDeformRail(obj.id, { axis: 'y' })}
            >
              Axis: Y
            </button>
            <button
              className={'icon-btn' + (settings.flip ? ' active' : '')}
              title={`Flip ${settings.axis.toUpperCase()} — mirror which end of local ${settings.axis.toUpperCase()} maps to the path's start (e.g. a mesh modeled facing the opposite way from the path's start/end arrow)`}
              onClick={() => updatePathDeformRail(obj.id, { flip: !settings.flip })}
            >
              Flip {settings.axis.toUpperCase()}
            </button>
            <button
              className={'icon-btn' + (settings.flipLateral ? ' active' : '')}
              title={`Flip ${(settings.axis === 'x' ? 'y' : 'x').toUpperCase()} — mirror which side of the path this cage's lateral extent maps to (e.g. a mesh modeled mirror-flipped left/right of the path)`}
              onClick={() => updatePathDeformRail(obj.id, { flipLateral: !settings.flipLateral })}
            >
              Flip {(settings.axis === 'x' ? 'y' : 'x').toUpperCase()}
            </button>
          </div>
          <div className="prop-row">
            <button
              className={'icon-btn' + (settings.stretch ? ' active' : '')}
              title="Stretch — the cage's whole length rescales to span each rail's entire length"
              onClick={() => updatePathDeformRail(obj.id, { stretch: true })}
            >
              Stretch
            </button>
            <button
              className={'icon-btn' + (!settings.stretch ? ' active' : '')}
              title="Fixed length — the cage keeps its own length and slides along the rails from Path Offset"
              onClick={() => updatePathDeformRail(obj.id, { stretch: false })}
            >
              Fixed length
            </button>
          </div>
          {!settings.stretch && (
            <div className="prop-row">
              <NumberField
                label="Path Offset"
                value={settings.pathOffset}
                onChange={(v) => updatePathDeformRail(obj.id, { pathOffset: v })}
              />
              <button
                className="icon-btn"
                disabled={!hasActiveClip}
                title={hasActiveClip ? 'Insert a keyframe for Path Offset at the playhead' : 'Create/select an animation clip first'}
                onClick={() => insertPathOffsetKeyframe(obj.id, playheadTime)}
              >
                <AddKeyframeIcon size={14} />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** One modifier's settings UI for FFD — see `FfdSettings`'s doc. The cage is a `kind: 'lattice'`
 *  object (its grid dimensions are its own authoritative property, not entered here), edited
 *  entirely through the *existing* Edit Mode vertex UI — no new viewport interaction needed here,
 *  since dragging the cage's own vertices is what deforms whatever references it. */
function FfdModifierBox({
  obj,
  objects,
  settings,
  removeModifier,
  updateFfd,
  resetFfdCageRest,
}: {
  obj: SceneObject
  objects: SceneObject[]
  settings: FfdSettings
  removeModifier: (id: string, type: Modifier['type']) => void
  updateFfd: (id: string, patch: Partial<FfdSettings>) => void
  resetFfdCageRest: (cageObjectId: string) => void
}) {
  const cageObjects = objects.filter((o) => o.kind === 'lattice')
  const cage = objects.find((o) => o.id === settings.cageObjectId)
  const expectedCount = (cage ? Math.max(2, Math.floor(cage.latticeCols ?? 0)) * Math.max(2, Math.floor(cage.latticeRows ?? 0)) : 0)
  const vertexCountMismatch = !!cage && cage.mesh.vertices.length !== expectedCount

  return (
    <div className="modifier-box">
      <div className="prop-row modifier-box-header">
        <button
          className={'icon-btn' + (settings.enabled ? ' active' : '')}
          title={settings.enabled ? 'Disable (keeps its settings)' : 'Enable'}
          onClick={() => updateFfd(obj.id, { enabled: !settings.enabled })}
        >
          {settings.enabled ? <VisibleTrueIcon size={16} /> : <VisibleFalseIcon size={16} />}
        </button>
        <span className="modifier-box-title">FFD (Cage)</span>
        <button className="icon-btn" title="Remove this modifier" onClick={() => removeModifier(obj.id, 'ffd')}>
          <TrashIcon size={14} />
        </button>
      </div>
      {settings.enabled && (
        <>
          <div className="prop-row">
            <select
              value={settings.cageObjectId ?? ''}
              onChange={(e) => updateFfd(obj.id, { cageObjectId: e.target.value || null })}
            >
              <option value="">(no cage assigned)</option>
              {cageObjects.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} ({o.latticeCols}×{o.latticeRows})
                </option>
              ))}
            </select>
          </div>
          {cageObjects.length === 0 && (
            <div className="prop-row prop-static">
              <span>No Lattice objects in the scene yet — add one from "+ Add ▾"</span>
            </div>
          )}
          {vertexCountMismatch && (
            <div className="prop-row prop-static">
              <span>
                Cage has {cage!.mesh.vertices.length} vertices, expected {expectedCount} (its topology was edited
                away from a clean grid) — no-op until it's a clean {cage!.latticeCols}×{cage!.latticeRows} grid
                again
              </span>
            </div>
          )}
          {cage && (
            <div className="prop-row">
              <button
                title="Re-freeze this cage's undeformed shape from its current vertex positions"
                onClick={() => resetFfdCageRest(cage.id)}
              >
                Reset cage rest shape
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** One modifier's settings UI for FakeBehind. Rather than checkbox-listing every object in the
 *  scene (unusable once a scene has more than a handful of objects), masks are added by dragging
 *  a row from the Outliner onto the drop target here — it's already draggable with the object's
 *  id in `dataTransfer` (see `Outliner.tsx`'s row `onDragStart`), so this just reuses that same
 *  payload. A "+ Add mask" dropdown covers the same action for when dragging isn't convenient.
 *  Any object can become a mask this way (no separate "mark as mask" step) — see
 *  `collectFakeBehindMaskIds`'s doc. No live/baked state to show (unlike Fake Physics): it's a
 *  pure screen-space overlap test evaluated fresh every frame — see `FakeBehindSettings`'s doc. */
function FakeBehindModifierBox({
  obj,
  objects,
  settings,
  removeModifier,
  toggleFakeBehindEnabled,
  addFakeBehindMaskRef,
  removeFakeBehindMaskRef,
}: {
  obj: SceneObject
  objects: SceneObject[]
  settings: FakeBehindSettings
  removeModifier: (id: string, type: Modifier['type']) => void
  toggleFakeBehindEnabled: (id: string) => void
  addFakeBehindMaskRef: (id: string, maskId: string) => void
  removeFakeBehindMaskRef: (id: string, maskId: string) => void
}) {
  const [dragOver, setDragOver] = useState(false)
  // `m` is `undefined` for a dangling reference (mask object deleted) — still shown, removable,
  // same tolerant-reference convention as elsewhere (see `FakeBehindSettings.maskObjectIds` doc)
  const maskRows = settings.maskObjectIds.map((id) => ({ id, obj: objects.find((o) => o.id === id) }))
  const availableToAdd = objects.filter((o) => o.id !== obj.id && !settings.maskObjectIds.includes(o.id))

  return (
    <div className="modifier-box">
      <div className="prop-row modifier-box-header">
        <button
          className={'icon-btn' + (settings.enabled ? ' active' : '')}
          title={settings.enabled ? 'Disable (keeps its mask list)' : 'Enable'}
          onClick={() => toggleFakeBehindEnabled(obj.id)}
        >
          {settings.enabled ? <VisibleTrueIcon size={16} /> : <VisibleFalseIcon size={16} />}
        </button>
        <span className="modifier-box-title">Fake Behind</span>
        <button className="icon-btn" title="Remove this modifier" onClick={() => removeModifier(obj.id, 'fakeBehind')}>
          <TrashIcon size={14} />
        </button>
      </div>
      {settings.enabled && (
        <>
          <div className="prop-row prop-static">
            <span>Hidden where it overlaps the masks below, on screen</span>
          </div>
          {maskRows.map(({ id, obj: m }) => (
            <div className="prop-row fake-behind-mask-row" key={id}>
              <span className={'fake-behind-mask-row-name' + (m ? '' : ' missing')}>{m?.name ?? '(deleted object)'}</span>
              <button className="icon-btn" title="Remove this mask" onClick={() => removeFakeBehindMaskRef(obj.id, id)}>
                <TrashIcon size={14} />
              </button>
            </div>
          ))}
          <div
            className={'fake-behind-drop-target' + (dragOver ? ' drag-over' : '')}
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(false)
              const draggedId = e.dataTransfer.getData('text/plain')
              if (draggedId) addFakeBehindMaskRef(obj.id, draggedId)
            }}
          >
            Drag an object here from the Outliner to add it as a mask
          </div>
          {availableToAdd.length > 0 && (
            <div className="prop-row">
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value) addFakeBehindMaskRef(obj.id, e.target.value)
                }}
              >
                <option value="">+ Add mask...</option>
                {availableToAdd.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** Blender-style "add only what you use" modifier stack — replaces what used to be a permanently
 *  visible Fake Flag section, so an object that doesn't use any opt-in effect isn't paying rent
 *  for one in its Properties panel. Add a new modifier type by adding it to the `Modifier` union
 *  and the store's `addModifier`, giving it a `MODIFIER_LABELS` entry, and adding its own
 *  `*ModifierBox` component (following `FakeFlagModifierBox`'s or `FakePhysicsModifierBox`'s shape).
 */
function ModifiersSection(props: {
  obj: SceneObject
  objects: SceneObject[]
  mode: AppMode
  hasVertexSelection: boolean
  hasActiveClip: boolean
  addModifier: (id: string, type: Modifier['type']) => void
  removeModifier: (id: string, type: Modifier['type']) => void
  toggleFakeFlagEnabled: (id: string) => void
  updateFakeFlag: (id: string, patch: Partial<FakeFlagSettings>) => void
  assignFakeFlagAnchor: (id: string) => void
  clearFakeFlagAnchor: (id: string) => void
  previewFakeFlag: boolean
  togglePreviewFakeFlag: () => void
  toggleFakePhysicsEnabled: (id: string) => void
  updateFakePhysics: (id: string, patch: Partial<FakePhysicsSettings>) => void
  clearFakePhysicsBake: (id: string) => void
  fakePhysicsBakedObjectIds: Set<string>
  toggleFakePhysicsMeshEnabled: (id: string) => void
  updateFakePhysicsMesh: (id: string, patch: Partial<FakePhysicsMeshSettings>) => void
  setFakePhysicsMeshSectionStiffnessLive: (id: string, index: 0 | 1 | 2 | 3 | 4, value: number) => void
  beginChange: () => void
  assignFakePhysicsMeshSection: (id: string, section: 1 | 2 | 3 | 4 | 5) => void
  selectFakePhysicsMeshSection: (id: string, section: 1 | 2 | 3 | 4 | 5) => void
  removeFakePhysicsMeshSectionVertices: (id: string, section: 1 | 2 | 3 | 4 | 5) => void
  clearFakePhysicsMeshBake: (id: string) => void
  fakePhysicsMeshBakedObjectIds: Set<string>
  previewFakePhysicsMesh: boolean
  togglePreviewFakePhysicsMesh: () => void
  toggleFakeBehindEnabled: (id: string) => void
  addFakeBehindMaskRef: (id: string, maskId: string) => void
  removeFakeBehindMaskRef: (id: string, maskId: string) => void
  updatePathDeformRail: (id: string, patch: Partial<PathDeformRailSettings>) => void
  insertPathOffsetKeyframe: (objectId: string, time: number) => void
  playheadTime: number
  updateFollowPath: (id: string, patch: Partial<FollowPathSettings>) => void
  insertFollowPathProgressKeyframe: (objectId: string, time: number) => void
  updateFfd: (id: string, patch: Partial<FfdSettings>) => void
  resetFfdCageRest: (cageObjectId: string) => void
}) {
  const { obj, objects, mode, addModifier } = props
  const modifiers = obj.modifiers ?? []
  const addedTypes = new Set(modifiers.map((m) => m.type))
  // Fake Physics' object-chain and mesh-section versions are two different mechanisms sharing one
  // "Fake Physics" label (see `MODIFIER_LABELS`'s doc) — offering both at once, regardless of
  // mode, would read as duplicate/confusing candidates for what's meant to be one feature. Instead
  // only the version relevant to the current mode is offered: `fakePhysicsMesh` needs an Edit Mode
  // vertex selection to mean anything (and a mesh to select from), `fakePhysics` is about the
  // object-hierarchy chain, which is edited in Object/Pivot mode.
  const availableTypes = (Object.keys(MODIFIER_LABELS) as Modifier['type'][]).filter((t) => {
    if (addedTypes.has(t)) return false
    if (t === 'fakePhysicsMesh') return mode === 'edit' && obj.kind !== 'empty'
    if (t === 'fakePhysics') return mode !== 'edit'
    // Only ever offered on a `kind: 'lattice'` cage — see `PathDeformRailSettings`'s doc.
    if (t === 'pathDeformRail') return obj.kind === 'lattice'
    return true
  })
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const addMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!addMenuOpen) return
    const handleOutside = (e: MouseEvent) => {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
        setAddMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  }, [addMenuOpen])

  return (
    <Section title="Modifiers">
      {modifiers.map((m) => {
        if (m.type === 'fakeFlag') return <FakeFlagModifierBox key={m.type} {...props} settings={m.settings} />
        if (m.type === 'fakePhysicsMesh') {
          return (
            <FakePhysicsMeshModifierBox
              key={m.type}
              {...props}
              settings={m.settings}
              isBaked={props.fakePhysicsMeshBakedObjectIds.has(obj.id)}
            />
          )
        }
        if (m.type === 'fakeBehind') {
          return <FakeBehindModifierBox key={m.type} {...props} settings={m.settings} />
        }
        if (m.type === 'followPath') {
          return <FollowPathModifierBox key={m.type} {...props} settings={m.settings} />
        }
        if (m.type === 'pathDeformRail') {
          return <PathDeformRailModifierBox key={m.type} {...props} settings={m.settings} />
        }
        if (m.type === 'ffd') {
          return <FfdModifierBox key={m.type} {...props} settings={m.settings} />
        }
        return (
          <FakePhysicsModifierBox
            key={m.type}
            {...props}
            settings={m.settings}
            isBaked={props.fakePhysicsBakedObjectIds.has(obj.id)}
          />
        )
      })}
      {availableTypes.length > 0 && (
        <div className="prop-row" style={{ position: 'relative' }} ref={addMenuRef}>
          <button onClick={() => setAddMenuOpen((o) => !o)}>+ Add Modifier ▾</button>
          {addMenuOpen && (
            <div className="dropdown-menu">
              {availableTypes.map((t) => (
                <div
                  key={t}
                  className="dropdown-item"
                  onClick={() => {
                    addModifier(obj.id, t)
                    setAddMenuOpen(false)
                  }}
                >
                  {MODIFIER_LABELS[t]}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Section>
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
  const addModifier = useSceneStore((s) => s.addModifier)
  const removeModifier = useSceneStore((s) => s.removeModifier)
  const toggleFakeFlagEnabled = useSceneStore((s) => s.toggleFakeFlagEnabled)
  const updateFakeFlag = useSceneStore((s) => s.updateFakeFlag)
  const assignFakeFlagAnchor = useSceneStore((s) => s.assignFakeFlagAnchor)
  const clearFakeFlagAnchor = useSceneStore((s) => s.clearFakeFlagAnchor)
  const previewFakeFlag = useSceneStore((s) => s.previewFakeFlag)
  const togglePreviewFakeFlag = useSceneStore((s) => s.togglePreviewFakeFlag)
  const toggleFakePhysicsEnabled = useSceneStore((s) => s.toggleFakePhysicsEnabled)
  const updateFakePhysics = useSceneStore((s) => s.updateFakePhysics)
  const clearFakePhysicsBake = useSceneStore((s) => s.clearFakePhysicsBake)
  const toggleFakePhysicsMeshEnabled = useSceneStore((s) => s.toggleFakePhysicsMeshEnabled)
  const updateFakePhysicsMesh = useSceneStore((s) => s.updateFakePhysicsMesh)
  const assignFakePhysicsMeshSection = useSceneStore((s) => s.assignFakePhysicsMeshSection)
  const selectFakePhysicsMeshSection = useSceneStore((s) => s.selectFakePhysicsMeshSection)
  const removeFakePhysicsMeshSectionVertices = useSceneStore((s) => s.removeFakePhysicsMeshSectionVertices)
  const clearFakePhysicsMeshBake = useSceneStore((s) => s.clearFakePhysicsMeshBake)
  const previewFakePhysicsMesh = useSceneStore((s) => s.previewFakePhysicsMesh)
  const togglePreviewFakePhysicsMesh = useSceneStore((s) => s.togglePreviewFakePhysicsMesh)
  const setFakePhysicsMeshSectionStiffnessLive = useSceneStore((s) => s.setFakePhysicsMeshSectionStiffnessLive)
  const toggleFakeBehindEnabled = useSceneStore((s) => s.toggleFakeBehindEnabled)
  const addFakeBehindMaskRef = useSceneStore((s) => s.addFakeBehindMaskRef)
  const removeFakeBehindMaskRef = useSceneStore((s) => s.removeFakeBehindMaskRef)
  const updatePathDeformRail = useSceneStore((s) => s.updatePathDeformRail)
  const insertPathOffsetKeyframe = useSceneStore((s) => s.insertPathOffsetKeyframe)
  const updateFollowPath = useSceneStore((s) => s.updateFollowPath)
  const insertFollowPathProgressKeyframe = useSceneStore((s) => s.insertFollowPathProgressKeyframe)
  const updateFfd = useSceneStore((s) => s.updateFfd)
  const resizeLattice = useSceneStore((s) => s.resizeLattice)
  const resetFfdCageRest = useSceneStore((s) => s.resetFfdCageRest)
  const beginChange = useSceneStore((s) => s.beginChange)
  const hasVertexSelection = useSceneStore(
    (s) => selectedVertexIndices(s, s.objects.find((o) => o.id === s.selectedObjectId)?.mesh ?? { vertices: [], faces: [] }).length > 0,
  )
  const hasActiveClip = useSceneStore((s) => s.activeClipId !== null)
  const activeClip = useSceneStore((s) => s.clips.find((c) => c.id === s.activeClipId))
  const fakePhysicsBakedObjectIds = new Set((activeClip?.fakePhysicsTracks ?? []).map((t) => t.objectId))
  const fakePhysicsMeshBakedObjectIds = new Set((activeClip?.fakePhysicsMeshTracks ?? []).map((t) => t.objectId))
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
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set())
  const toggleSection = (title: string) =>
    setCollapsedSections((prev) => {
      const next = new Set(prev)
      if (next.has(title)) next.delete(title)
      else next.add(title)
      return next
    })

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
    <CollapseContext.Provider value={{ collapsed: collapsedSections, toggle: toggleSection }}>
    <div className="panel properties" style={style}>
      <div className="panel-title">Properties</div>
      {!obj ? (
        <div className="empty-hint">No object selected</div>
      ) : (
        <div className="prop-body">
          <Section title="Slot name">
            <div className="prop-row">
              <input
                className="layer-name"
                placeholder="(none)"
                title="A name unique within the scene that other objects' INSERT OBJECT slots can reference. Setting the same name on another object removes it from the previous owner"
                value={obj.slotName ?? ''}
                onChange={(e) => setSlotName(obj.id, e.target.value)}
              />
            </div>
          </Section>

          <Section title="Hierarchy">
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
          </Section>

          <Section title="Transform">
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
          </Section>

          <Section title="Head (local coordinates)">
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
              <NumberField
                label="Tail X"
                value={obj.tail.x}
                onChange={(v) => setTail(obj.id, { x: v, y: obj.tail.y })}
              />
              <NumberField
                label="Tail Y"
                value={obj.tail.y}
                onChange={(v) => setTail(obj.id, { x: obj.tail.x, y: v })}
              />
            </div>
          </Section>

          <ModifiersSection
            obj={obj}
            objects={objects}
            mode={mode}
            hasVertexSelection={hasVertexSelection}
            hasActiveClip={hasActiveClip}
            addModifier={addModifier}
            removeModifier={removeModifier}
            toggleFakeFlagEnabled={toggleFakeFlagEnabled}
            updateFakeFlag={updateFakeFlag}
            assignFakeFlagAnchor={assignFakeFlagAnchor}
            clearFakeFlagAnchor={clearFakeFlagAnchor}
            previewFakeFlag={previewFakeFlag}
            togglePreviewFakeFlag={togglePreviewFakeFlag}
            toggleFakePhysicsEnabled={toggleFakePhysicsEnabled}
            updateFakePhysics={updateFakePhysics}
            clearFakePhysicsBake={clearFakePhysicsBake}
            fakePhysicsBakedObjectIds={fakePhysicsBakedObjectIds}
            toggleFakePhysicsMeshEnabled={toggleFakePhysicsMeshEnabled}
            updateFakePhysicsMesh={updateFakePhysicsMesh}
            setFakePhysicsMeshSectionStiffnessLive={setFakePhysicsMeshSectionStiffnessLive}
            beginChange={beginChange}
            assignFakePhysicsMeshSection={assignFakePhysicsMeshSection}
            selectFakePhysicsMeshSection={selectFakePhysicsMeshSection}
            removeFakePhysicsMeshSectionVertices={removeFakePhysicsMeshSectionVertices}
            clearFakePhysicsMeshBake={clearFakePhysicsMeshBake}
            fakePhysicsMeshBakedObjectIds={fakePhysicsMeshBakedObjectIds}
            previewFakePhysicsMesh={previewFakePhysicsMesh}
            togglePreviewFakePhysicsMesh={togglePreviewFakePhysicsMesh}
            toggleFakeBehindEnabled={toggleFakeBehindEnabled}
            addFakeBehindMaskRef={addFakeBehindMaskRef}
            removeFakeBehindMaskRef={removeFakeBehindMaskRef}
            updatePathDeformRail={updatePathDeformRail}
            insertPathOffsetKeyframe={insertPathOffsetKeyframe}
            playheadTime={playheadTime}
            updateFollowPath={updateFollowPath}
            insertFollowPathProgressKeyframe={insertFollowPathProgressKeyframe}
            updateFfd={updateFfd}
            resetFfdCageRest={resetFfdCageRest}
          />

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
          ) : obj.kind === 'path' ? (
            <div className="prop-row prop-static">
              <span>Path ({obj.mesh.vertices.length} control points) — no mesh, meant to be referenced by other objects' Path Follow/Path Deform modifiers</span>
            </div>
          ) : obj.kind === 'lattice' ? (
            <Section title="Lattice">
              <div className="prop-row prop-static">
                <span>FFD cage — an object's FFD modifier references this, then dragging these vertices in Edit Mode deforms it</span>
              </div>
              <div className="prop-row">
                <NumberField
                  label="Segments X"
                  value={(obj.latticeCols ?? 2) - 1}
                  step={1}
                  onChange={(v) => resizeLattice(obj.id, Math.max(1, Math.round(v)) + 1, obj.latticeRows ?? 2)}
                />
                <NumberField
                  label="Segments Y"
                  value={(obj.latticeRows ?? 2) - 1}
                  step={1}
                  onChange={(v) => resizeLattice(obj.id, obj.latticeCols ?? 2, Math.max(1, Math.round(v)) + 1)}
                />
              </div>
              <div className="prop-row prop-static">
                <span>Changing columns/rows resets this lattice to a fresh, undeformed grid at the new resolution</span>
              </div>
            </Section>
          ) : (
            <>
              <Section title="Material">
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
              </Section>

              <Section title="UV">
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
              </Section>

              <Section title="Mesh">
                <div className="prop-row prop-static">
                  <span>Vertices: {obj.mesh.vertices.length}</span>
                  <span>Faces: {obj.mesh.faces.length}</span>
                </div>
              </Section>
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
    </CollapseContext.Provider>
  )
}
