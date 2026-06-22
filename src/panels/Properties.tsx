import { useState } from 'react'
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

/** Draw the mesh's UV wireframe (UV 0,0 = bottom-left, image 0,0 = top-left) and trigger a PNG download. */
function exportUvMap(obj: SceneObject, resolution: number) {
  const uvs = computeUVs(obj.mesh, obj.uvIslandTransforms)
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

export default function Properties() {
  const obj = useSceneStore((s) => s.objects.find((o) => o.id === s.selectedObjectId))
  const setTransform = useSceneStore((s) => s.setTransform)
  const setPivot = useSceneStore((s) => s.setPivot)
  const setMaterialColor = useSceneStore((s) => s.setMaterialColor)
  const [uvResolution, setUvResolution] = useState(1024)
  const [uvEditorOpen, setUvEditorOpen] = useState(false)

  return (
    <div className="panel properties">
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
              <span>色</span>
              <input
                type="color"
                value={obj.material.color}
                onChange={(e) => setMaterialColor(obj.id, e.target.value)}
              />
            </label>
          </div>

          <div className="prop-section">UV</div>
          <div className="prop-row">
            <button onClick={() => setUvEditorOpen(true)}>UVを編集...</button>
          </div>
          <div className="prop-row">
            <label className="prop-field">
              <span>解像度</span>
              <input
                type="number"
                step={1}
                min={16}
                value={uvResolution}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10)
                  if (!Number.isNaN(v)) setUvResolution(v)
                }}
              />
            </label>
            <button onClick={() => exportUvMap(obj, uvResolution)}>UVマップを書き出し</button>
          </div>

          <div className="prop-section">メッシュ</div>
          <div className="prop-row prop-static">
            <span>頂点数: {obj.mesh.vertices.length}</span>
            <span>面数: {obj.mesh.faces.length}</span>
          </div>
        </div>
      )}

      {uvEditorOpen && obj && (
        <div className="uv-modal-backdrop" onClick={() => setUvEditorOpen(false)}>
          <div className="uv-modal" onClick={(e) => e.stopPropagation()}>
            <div className="uv-modal-header">
              <span>UVエディタ — {obj.name}</span>
              <button onClick={() => setUvEditorOpen(false)}>閉じる</button>
            </div>
            <UvEditor obj={obj} size={560} />
            <div className="uv-hint">ドラッグで移動、右上の角を引いて拡大縮小</div>
          </div>
        </div>
      )}
    </div>
  )
}
