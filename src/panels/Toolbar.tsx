import { useRef, useState } from 'react'
import { useSceneStore } from '../scene/store'
import { parseObjToMesh } from '../scene/objImport'

export default function Toolbar() {
  const mode = useSceneStore((s) => s.mode)
  const setMode = useSceneStore((s) => s.setMode)
  const editElementType = useSceneStore((s) => s.editElementType)
  const setEditElementType = useSceneStore((s) => s.setEditElementType)
  const addRect = useSceneStore((s) => s.addRect)
  const addCircle = useSceneStore((s) => s.addCircle)
  const addImportedMesh = useSceneStore((s) => s.addImportedMesh)
  const undo = useSceneStore((s) => s.undo)
  const redo = useSceneStore((s) => s.redo)
  const canUndo = useSceneStore((s) => s.history.length > 0)
  const canRedo = useSceneStore((s) => s.future.length > 0)
  const activeTool = useSceneStore((s) => s.activeTool)
  const setActiveTool = useSceneStore((s) => s.setActiveTool)
  const selectedObj = useSceneStore((s) => s.objects.find((o) => o.id === s.selectedObjectId))

  const [segX, setSegX] = useState(1)
  const [segY, setSegY] = useState(1)
  const [circleSegs, setCircleSegs] = useState(16)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleObjFile = async (file: File) => {
    try {
      const text = await file.text()
      const mesh = parseObjToMesh(text)
      const name = file.name.replace(/\.obj$/i, '')
      addImportedMesh(mesh, name)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'OBJファイルの読み込みに失敗しました。')
    }
  }

  return (
    <div className="toolbar">
      <div className="toolbar-group">
        <button title="元に戻す (Cmd/Ctrl+Z)" disabled={!canUndo} onClick={() => undo()}>
          ↶ 戻す
        </button>
        <button title="やり直す (Cmd/Ctrl+Shift+Z)" disabled={!canRedo} onClick={() => redo()}>
          ↷ 進む
        </button>
      </div>

      <div className="toolbar-group">
        <input
          ref={fileInputRef}
          type="file"
          accept=".obj"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) handleObjFile(file)
            e.target.value = ''
          }}
        />
        <button title="OBJファイルを読み込み（平面メッシュ想定）" onClick={() => fileInputRef.current?.click()}>
          📂 OBJ読込
        </button>
      </div>

      <div className="toolbar-group">
        <button title="矩形を追加" onClick={() => addRect(100, 100, segX, segY)}>
          ▭ 矩形
        </button>
        <label className="seg-input">
          X分割
          <input type="number" min={1} value={segX} onChange={(e) => setSegX(+e.target.value)} />
        </label>
        <label className="seg-input">
          Y分割
          <input type="number" min={1} value={segY} onChange={(e) => setSegY(+e.target.value)} />
        </label>
      </div>

      <div className="toolbar-group">
        <button title="円を追加" onClick={() => addCircle(60, circleSegs)}>
          ◯ 円
        </button>
        <label className="seg-input">
          分割数
          <input
            type="number"
            min={3}
            value={circleSegs}
            onChange={(e) => setCircleSegs(+e.target.value)}
          />
        </label>
      </div>

      <div className="toolbar-group">
        <button className={mode === 'object' ? 'active' : ''} onClick={() => setMode('object')}>
          オブジェクトモード
        </button>
        <button className={mode === 'edit' ? 'active' : ''} onClick={() => setMode('edit')}>
          編集モード
        </button>
      </div>

      {mode === 'edit' && (
        <div className="toolbar-group">
          <button
            className={editElementType === 'vertex' ? 'active' : ''}
            onClick={() => setEditElementType('vertex')}
          >
            頂点
          </button>
          <button
            className={editElementType === 'edge' ? 'active' : ''}
            onClick={() => setEditElementType('edge')}
          >
            辺
          </button>
          <button
            className={editElementType === 'face' ? 'active' : ''}
            onClick={() => setEditElementType('face')}
          >
            面
          </button>
          <button
            className={activeTool === 'loopcut' ? 'active' : ''}
            disabled={!selectedObj?.grid}
            title={selectedObj?.grid ? 'ループカット' : 'グリッド構造を持つオブジェクト（矩形）のみ対応'}
            onClick={() => setActiveTool(activeTool === 'loopcut' ? 'select' : 'loopcut')}
          >
            ループカット
          </button>
        </div>
      )}
    </div>
  )
}
