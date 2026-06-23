import { useRef, useState, type CSSProperties } from 'react'
import { useSceneStore } from '../scene/store'
import { computeUVs } from '../scene/uv'
import { getEdges } from '../scene/meshUtils'
import type { SceneObject } from '../scene/types'
import UvEditor from './UvEditor'

function NumberField({
  label,
  value,
  onChange,
  step = 1,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  step?: number
}) {
  return (
    <label className="prop-field">
      <span>{label}</span>
      <input
        type="number"
        step={step}
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
  const seams = obj.seamEdges ? new Set(obj.seamEdges) : undefined
  const uvs = computeUVs(obj.mesh, obj.uvIslandTransforms, seams)
  const canvas = document.createElement('canvas')
  canvas.width = resolution
  canvas.height = resolution
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, resolution, resolution)
  ctx.strokeStyle = '#000000'
  ctx.lineWidth = 1
  for (const [a, b] of getEdges(obj.mesh)) {
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

export default function Properties({ style }: { style?: CSSProperties }) {
  const obj = useSceneStore((s) => s.objects.find((o) => o.id === s.selectedObjectId))
  const setTransform = useSceneStore((s) => s.setTransform)
  const setPivot = useSceneStore((s) => s.setPivot)
  const setMaterialColor = useSceneStore((s) => s.setMaterialColor)
  const setMaterialTexture = useSceneStore((s) => s.setMaterialTexture)
  const setSdsLevels = useSceneStore((s) => s.setSdsLevels)
  const setSdsShowWireframe = useSceneStore((s) => s.setSdsShowWireframe)
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
          <div className="prop-section">トランスフォーム</div>
          <div className="prop-row">
            <NumberField label="位置 X" value={obj.transform.x} onChange={(v) => setTransform(obj.id, { x: v })} />
            <NumberField label="位置 Y" value={obj.transform.y} onChange={(v) => setTransform(obj.id, { y: v })} />
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

          <div className="prop-section">ピボット（ローカル座標）</div>
          <div className="prop-row">
            <NumberField
              label="ピボット X"
              value={obj.transform.pivot.x}
              onChange={(v) => setPivot(obj.id, { x: v, y: obj.transform.pivot.y })}
            />
            <NumberField
              label="ピボット Y"
              value={obj.transform.pivot.y}
              onChange={(v) => setPivot(obj.id, { x: obj.transform.pivot.x, y: v })}
            />
          </div>

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
          <div className="prop-row">
            <label className="prop-field" title="表示用の輪郭スムージング。編集メッシュ自体は変わらず、見た目だけ滑らかになります（角を立てたい辺を維持するクリース機能は未実装）">
              <span>SDS（サブディビジョン）</span>
              <select
                value={obj.sdsLevels ?? 0}
                onChange={(e) => setSdsLevels(obj.id, parseInt(e.target.value, 10))}
              >
                <option value={0}>オフ</option>
                <option value={1}>1</option>
                <option value={2}>2</option>
                <option value={3}>3</option>
              </select>
            </label>
          </div>
          {(obj.sdsLevels ?? 0) > 0 && (
            <div className="prop-row">
              <label className="uv-hint uv-density-toggle">
                <input
                  type="checkbox"
                  checked={obj.sdsShowWireframe ?? false}
                  onChange={(e) => setSdsShowWireframe(obj.id, e.target.checked)}
                />
                SDSワイヤーフレームを表示
              </label>
            </div>
          )}
        </div>
      )}

      {uvEditorOpen && obj && (
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
