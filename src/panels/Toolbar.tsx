import { useRef, useState } from 'react'
import { useSceneStore } from '../scene/store'
import { parseObjToMesh } from '../scene/objImport'
import { parseProjectFile, serializeProject, PROJECT_VERSION, PROJECT_EXTENSION } from '../scene/project'
import {
  ProjectOpenIcon,
  ProjectSaveIcon,
  UndoIcon,
  RedoIcon,
  ObjImportIcon,
  ReferenceImageIcon,
} from './icons'

export default function Toolbar() {
  const mode = useSceneStore((s) => s.mode)
  const addRect = useSceneStore((s) => s.addRect)
  const addCircle = useSceneStore((s) => s.addCircle)
  const addImportedMesh = useSceneStore((s) => s.addImportedMesh)
  const addEmpty = useSceneStore((s) => s.addEmpty)
  const setPendingPrimitive = useSceneStore((s) => s.setPendingPrimitive)
  const referenceImage = useSceneStore((s) => s.referenceImage)
  const setReferenceImage = useSceneStore((s) => s.setReferenceImage)
  const setReferenceImageTransform = useSceneStore((s) => s.setReferenceImageTransform)
  const meshOpacity = useSceneStore((s) => s.meshOpacity)
  const setMeshOpacity = useSceneStore((s) => s.setMeshOpacity)
  const gridSubdivisions = useSceneStore((s) => s.gridSubdivisions)
  const setGridSubdivisions = useSceneStore((s) => s.setGridSubdivisions)
  const gridSnapEnabled = useSceneStore((s) => s.gridSnapEnabled)
  const setGridSnapEnabled = useSceneStore((s) => s.setGridSnapEnabled)
  const loadProject = useSceneStore((s) => s.loadProject)
  const undo = useSceneStore((s) => s.undo)
  const redo = useSceneStore((s) => s.redo)
  const canUndo = useSceneStore((s) => s.history.length > 0)
  const canRedo = useSceneStore((s) => s.future.length > 0)
  const setActiveTool = useSceneStore((s) => s.setActiveTool)
  const gizmoOrientation = useSceneStore((s) => s.gizmoOrientation)
  const setGizmoOrientation = useSceneStore((s) => s.setGizmoOrientation)
  const selectedObj = useSceneStore((s) => s.objects.find((o) => o.id === s.selectedObjectId))

  const [segX, setSegX] = useState(1)
  const [segY, setSegY] = useState(1)
  const [circleSegs, setCircleSegs] = useState(16)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const refFileInputRef = useRef<HTMLInputElement>(null)
  const projectFileInputRef = useRef<HTMLInputElement>(null)

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

  const handleReferenceFile = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => setReferenceImage(reader.result as string)
    reader.readAsDataURL(file)
  }

  const handleSaveProject = () => {
    const { objects, referenceImage: ref, meshOpacity: opacity } = useSceneStore.getState()
    const json = serializeProject({ version: PROJECT_VERSION, objects, referenceImage: ref, meshOpacity: opacity })
    const blob = new Blob([json], { type: 'application/json' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `project${PROJECT_EXTENSION}`
    link.click()
    URL.revokeObjectURL(link.href)
  }

  const handleOpenProjectFile = async (file: File) => {
    try {
      const text = await file.text()
      loadProject(parseProjectFile(text))
    } catch (err) {
      alert(err instanceof Error ? err.message : 'ファイルの読み込みに失敗しました。')
    }
  }

  return (
    <div className="toolbar">
      <div className="toolbar-group">
        <input
          ref={projectFileInputRef}
          type="file"
          accept={PROJECT_EXTENSION}
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) handleOpenProjectFile(file)
            e.target.value = ''
          }}
        />
        <button title={`プロジェクトを開く（${PROJECT_EXTENSION}）`} onClick={() => projectFileInputRef.current?.click()}>
          <ProjectOpenIcon />
        </button>
        <button title={`プロジェクトを保存（${PROJECT_EXTENSION}）`} onClick={handleSaveProject}>
          <ProjectSaveIcon />
        </button>
      </div>

      <div className="toolbar-group">
        <button title="元に戻す (Cmd/Ctrl+Z)" disabled={!canUndo} onClick={() => undo()}>
          <UndoIcon />
        </button>
        <button title="やり直す (Cmd/Ctrl+Shift+Z)" disabled={!canRedo} onClick={() => redo()}>
          <RedoIcon />
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
          <ObjImportIcon />
        </button>
      </div>

      <div className="toolbar-group">
        <input
          ref={refFileInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) handleReferenceFile(file)
            e.target.value = ''
          }}
        />
        <button title="トレース用の下絵を読み込み" onClick={() => refFileInputRef.current?.click()}>
          <ReferenceImageIcon />
        </button>
        {referenceImage && (
          <>
            <label className="seg-input">
              X
              <input
                type="number"
                value={referenceImage.x}
                onChange={(e) => setReferenceImageTransform({ x: +e.target.value })}
              />
            </label>
            <label className="seg-input">
              Y
              <input
                type="number"
                value={referenceImage.y}
                onChange={(e) => setReferenceImageTransform({ y: +e.target.value })}
              />
            </label>
            <label className="seg-input">
              スケール
              <input
                type="number"
                step={0.1}
                min={0.01}
                value={referenceImage.scale}
                onChange={(e) => setReferenceImageTransform({ scale: +e.target.value })}
              />
            </label>
            <button title="下絵を削除" onClick={() => setReferenceImage(null)}>
              下絵を削除
            </button>
          </>
        )}
      </div>

      <div className="toolbar-group">
        <label className="seg-input" title="全オブジェクトの不透明度を下げて、下絵をトレースしやすくします">
          メッシュ不透明度
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={meshOpacity}
            onChange={(e) => setMeshOpacity(+e.target.value)}
          />
        </label>
      </div>

      <div className="toolbar-group">
        <label className="seg-input" title="主グリッドの1セルを何分割のサブグリッドにするか（グリッドスナップの間隔にもなります）">
          サブグリッド
          <input
            type="number"
            min={1}
            max={100}
            value={gridSubdivisions}
            onChange={(e) => setGridSubdivisions(+e.target.value)}
          />
        </label>
        <label className="seg-input" title="移動時に常にグリッドへスナップします（Ctrlキーで一時的に反転できます）">
          <input
            type="checkbox"
            checked={gridSnapEnabled}
            onChange={(e) => setGridSnapEnabled(e.target.checked)}
          />
          グリッドスナップ
        </label>
      </div>

      {mode === 'object' && (
        <div className="toolbar-group">
          <label className="seg-input" title="移動ギズモの軸の基準（ローカル=オブジェクト自身の回転に追従、ワールド=常にシーンのXY軸）">
            ギズモ
            <select value={gizmoOrientation} onChange={(e) => setGizmoOrientation(e.target.value as 'world' | 'local')}>
              <option value="local">ローカル</option>
              <option value="world">ワールド</option>
            </select>
          </label>
        </div>
      )}

      <div className="toolbar-group">
        <button
          title={mode === 'edit' && selectedObj ? '矩形を島として追加（クリックで配置位置を確定）' : '矩形を追加'}
          onClick={() => {
            if (mode === 'edit' && selectedObj) {
              setPendingPrimitive({ kind: 'rect', width: 100, height: 100, segX, segY })
              setActiveTool('place-rect')
            } else {
              addRect(100, 100, segX, segY)
            }
          }}
        >
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
        <button
          title={mode === 'edit' && selectedObj ? '円を島として追加（クリックで配置位置を確定）' : '円を追加'}
          onClick={() => {
            if (mode === 'edit' && selectedObj) {
              setPendingPrimitive({ kind: 'circle', radius: 60, segments: circleSegs })
              setActiveTool('place-circle')
            } else {
              addCircle(60, circleSegs)
            }
          }}
        >
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
        <button title="メッシュを持たない、階層用のダミーオブジェクトを追加" onClick={() => addEmpty()}>
          ✛ Empty
        </button>
      </div>

    </div>
  )
}
