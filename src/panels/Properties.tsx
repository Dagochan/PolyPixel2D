import { useRef, useState, type CSSProperties } from 'react'
import { useSceneStore } from '../scene/store'
import { computeSplitUVs, findIslands } from '../scene/uv'
import { getEdges } from '../scene/meshUtils'
import type { SceneObject } from '../scene/types'
import UvEditor from './UvEditor'
import { VisibleTrueIcon, VisibleFalseIcon, IslandSelectIcon } from './icons'

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
  const link = document.createElement('a')
  link.href = canvas.toDataURL('image/png')
  link.download = `${obj.name}_uv.png`
  link.click()
}

/** Only shown for an object whose mesh has 2+ disconnected islands — lets the user pick which
 *  island draws in front of which when they overlap on screen (the spec calls for per-island
 *  Z stacking within a single object's mesh, since one object can hold multiple islands). Listed
 *  front-most first, with up/down buttons swapping rank with the neighboring island. */
function IslandZOrderSection({
  obj,
  moveIslandZOrder,
  selectIsland,
  setIslandName,
  clearIslandNameIfEmpty,
  setShowIslandNames,
  toggleIslandVisible,
}: {
  obj: SceneObject
  moveIslandZOrder: (id: string, islandIndex: number, direction: 1 | -1) => void
  selectIsland: (islandIndex: number) => void
  setIslandName: (id: string, islandIndex: number, name: string) => void
  clearIslandNameIfEmpty: (id: string, islandIndex: number) => void
  setShowIslandNames: (id: string, show: boolean) => void
  toggleIslandVisible: (id: string, islandIndex: number) => void
}) {
  const islandCount = findIslands(obj.mesh).length
  if (islandCount < 2) return null

  const order = Array.from({ length: islandCount }, (_, i) => i).sort(
    (a, b) => (obj.islandZOrders?.[b] ?? b) - (obj.islandZOrders?.[a] ?? a),
  )
  const showNames = obj.showIslandNames ?? false

  return (
    <>
      <div className="prop-section">アイランド（重なり順）</div>
      <div className="prop-row prop-static">
        <span>前面が上、背面が下。左のボタンで選択、名前は編集可能</span>
      </div>
      <div className="prop-row">
        <button
          className={'icon-btn' + (showNames ? ' active' : '')}
          title="ビューポートに全アイランドの名前を表示"
          onClick={() => setShowIslandNames(obj.id, !showNames)}
        >
          🏷 名前を表示
        </button>
      </div>
      {order.map((islandIdx, pos) => {
        const visible = obj.islandVisible?.[islandIdx] ?? true
        return (
          <div className="prop-row" key={islandIdx}>
            <button
              className="icon-btn"
              title="このアイランドを選択（編集モードに切り替えます）"
              onClick={() => selectIsland(islandIdx)}
            >
              <IslandSelectIcon size={18} />
            </button>
            <button
              className="icon-btn"
              title={visible ? 'このアイランドを非表示' : 'このアイランドを表示'}
              onClick={() => toggleIslandVisible(obj.id, islandIdx)}
            >
              {visible ? <VisibleTrueIcon size={18} /> : <VisibleFalseIcon size={18} />}
            </button>
            <input
              className="layer-name"
              value={obj.islandNames?.[islandIdx] ?? `アイランド ${islandIdx + 1}`}
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
              disabled={pos === order.length - 1}
              onClick={() => moveIslandZOrder(obj.id, islandIdx, -1)}
            >
              ▼
            </button>
          </div>
        )
      })}
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
  const reunwrapUVs = useSceneStore((s) => s.reunwrapUVs)
  const moveIslandZOrder = useSceneStore((s) => s.moveIslandZOrder)
  const selectIsland = useSceneStore((s) => s.selectIsland)
  const setIslandName = useSceneStore((s) => s.setIslandName)
  const clearIslandNameIfEmpty = useSceneStore((s) => s.clearIslandNameIfEmpty)
  const setShowIslandNames = useSceneStore((s) => s.setShowIslandNames)
  const toggleIslandVisible = useSceneStore((s) => s.toggleIslandVisible)
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

  return (
    <div className="panel properties" style={style}>
      <div className="panel-title">プロパティ</div>
      {!obj ? (
        <div className="empty-hint">オブジェクトが選択されていません</div>
      ) : (
        <div className="prop-body">
          <div className="prop-section">階層</div>
          {obj.parentId !== null ? (
            <>
              <div className="prop-row prop-static">
                <span>親: {objects.find((o) => o.id === obj.parentId)?.name ?? '(不明)'}</span>
              </div>
              <div className="prop-row">
                <button onClick={() => setParent(obj.id, null)}>親を解除</button>
              </div>
              <div className="prop-row">
                <label className="uv-hint uv-density-toggle">
                  <input
                    type="checkbox"
                    checked={obj.connected}
                    onChange={(e) => setConnected(obj.id, e.target.checked)}
                  />
                  親のTailに接続
                </label>
              </div>
            </>
          ) : (
            <div className="prop-row prop-static">
              <span>親オブジェクトなし（アウトライナーでドラッグして設定）</span>
            </div>
          )}

          <div className="prop-section">トランスフォーム</div>
          <div className="prop-row">
            <NumberField
              label="位置 X"
              value={obj.transform.x}
              disabled={obj.connected && obj.parentId !== null}
              onChange={(v) => setTransform(obj.id, { x: v })}
            />
            <NumberField
              label="位置 Y"
              value={obj.transform.y}
              disabled={obj.connected && obj.parentId !== null}
              onChange={(v) => setTransform(obj.id, { y: v })}
            />
          </div>
          <div className="prop-row">
            <NumberField
              label="回転(°)"
              value={(obj.transform.rotation * 180) / Math.PI}
              onChange={(v) => setTransform(obj.id, { rotation: (v * Math.PI) / 180 })}
            />
          </div>
          <div className="prop-row">
            <NumberField
              label="スケール X"
              value={obj.transform.scaleX}
              step={0.1}
              onChange={(v) => setTransform(obj.id, { scaleX: v })}
            />
            <NumberField
              label="スケール Y"
              value={obj.transform.scaleY}
              step={0.1}
              onChange={(v) => setTransform(obj.id, { scaleY: v })}
            />
          </div>

          <div className="prop-section">Head（ローカル座標）</div>
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
              moveIslandZOrder={moveIslandZOrder}
              selectIsland={selectIsland}
              setIslandName={setIslandName}
              clearIslandNameIfEmpty={clearIslandNameIfEmpty}
              setShowIslandNames={setShowIslandNames}
              toggleIslandVisible={toggleIslandVisible}
            />
          )}

          {obj.kind === 'empty' ? (
            <div className="prop-row prop-static">
              <span>Empty（メッシュなし、階層用のダミーオブジェクト）</span>
            </div>
          ) : (
            <>
              <div className="prop-section">マテリアル</div>
              <div className="prop-row">
                <label className="prop-field">
                  <span>色{obj.material.textureUrl ? '（テクスチャに乗算）' : ''}</span>
                  <input
                    type="color"
                    value={obj.material.color}
                    onChange={(e) => setMaterialColor(obj.id, e.target.value)}
                  />
                </label>
              </div>
              {obj.material.textureUrl && (
                <div className="prop-row">
                  <img src={obj.material.textureUrl} alt="テクスチャ" className="texture-thumb" />
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
                <button onClick={() => textureInputRef.current?.click()}>テクスチャを設定</button>
                {obj.material.textureUrl && (
                  <button onClick={() => setMaterialTexture(obj.id, undefined)}>テクスチャを削除</button>
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
                  UVを編集...
                </button>
                <button
                  title="現在の形状でUVを再計算します。普段は頂点を動かしてもUVは固定されたままテクスチャが伸びますが、大きく作り直した後など、改めて展開し直したい時に使います"
                  onClick={() => reunwrapUVs(obj.id)}
                >
                  UVを再展開
                </button>
              </div>
              <div className="prop-row">
                <label className="prop-field">
                  <span>解像度</span>
                  <select value={uvResolution} onChange={(e) => setUvResolution(parseInt(e.target.value, 10))}>
                    {UV_RESOLUTIONS.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </label>
                <button onClick={() => exportUvMap(obj, uvResolution)}>UVマップを書き出し</button>
              </div>

              <div className="prop-section">メッシュ</div>
              <div className="prop-row prop-static">
                <span>頂点数: {obj.mesh.vertices.length}</span>
                <span>面数: {obj.mesh.faces.length}</span>
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
              <span>UVエディタ — {obj.name}</span>
              <button onPointerDown={(e) => e.stopPropagation()} onClick={() => setUvEditorOpen(false)}>
                閉じる
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
              テクセル密度を一致させる（1つの島をスケールすると他も比率を保って追従）
            </label>
            {obj.material.textureUrl && (
              <label className="uv-hint uv-density-toggle">
                テクスチャ不透明度
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
            <div className="uv-hint">ドラッグで移動、右上の角を引いて拡大縮小、左下の鍵アイコンで密度一致の対象から除外</div>
          </div>
        </div>
      )}
    </div>
  )
}
