import { useSceneStore } from '../scene/store'

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

export default function Properties() {
  const obj = useSceneStore((s) => s.objects.find((o) => o.id === s.selectedObjectId))
  const setTransform = useSceneStore((s) => s.setTransform)
  const setPivot = useSceneStore((s) => s.setPivot)

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

          <div className="prop-section">メッシュ</div>
          <div className="prop-row prop-static">
            <span>頂点数: {obj.mesh.vertices.length}</span>
            <span>面数: {obj.mesh.faces.length}</span>
          </div>
        </div>
      )}
    </div>
  )
}
