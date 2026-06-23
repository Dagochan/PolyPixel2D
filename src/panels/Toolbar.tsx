import { useRef, useState } from 'react'
import { useSceneStore, creaseValueForSelection } from '../scene/store'
import { parseObjToMesh } from '../scene/objImport'
import { parseProjectFile, serializeProject, PROJECT_VERSION, PROJECT_EXTENSION } from '../scene/project'
import {
  ObjectModeIcon,
  EditModeIcon,
  VertexIcon,
  EdgeIcon,
  FaceIcon,
  LoopCutIcon,
  KnifeIcon,
  ExtrudeIcon,
  SeamIcon,
  ProjectOpenIcon,
  ProjectSaveIcon,
  UndoIcon,
  RedoIcon,
  ObjImportIcon,
  ReferenceImageIcon,
  CreaseIcon,
} from './icons'

export default function Toolbar() {
  const mode = useSceneStore((s) => s.mode)
  const setMode = useSceneStore((s) => s.setMode)
  const editElementType = useSceneStore((s) => s.editElementType)
  const setEditElementType = useSceneStore((s) => s.setEditElementType)
  const addRect = useSceneStore((s) => s.addRect)
  const addCircle = useSceneStore((s) => s.addCircle)
  const addImportedMesh = useSceneStore((s) => s.addImportedMesh)
  const setPendingPrimitive = useSceneStore((s) => s.setPendingPrimitive)
  const referenceImage = useSceneStore((s) => s.referenceImage)
  const setReferenceImage = useSceneStore((s) => s.setReferenceImage)
  const setReferenceImageTransform = useSceneStore((s) => s.setReferenceImageTransform)
  const meshOpacity = useSceneStore((s) => s.meshOpacity)
  const setMeshOpacity = useSceneStore((s) => s.setMeshOpacity)
  const loadProject = useSceneStore((s) => s.loadProject)
  const undo = useSceneStore((s) => s.undo)
  const redo = useSceneStore((s) => s.redo)
  const canUndo = useSceneStore((s) => s.history.length > 0)
  const canRedo = useSceneStore((s) => s.future.length > 0)
  const activeTool = useSceneStore((s) => s.activeTool)
  const setActiveTool = useSceneStore((s) => s.setActiveTool)
  const selectedObj = useSceneStore((s) => s.objects.find((o) => o.id === s.selectedObjectId))
  const selectedEdges = useSceneStore((s) => s.selectedEdges)
  const selectedVertices = useSceneStore((s) => s.selectedVertices)
  const selectedEdgesCount = selectedEdges.size
  const selectedVerticesCount = selectedVertices.size
  const toggleSeamOnSelection = useSceneStore((s) => s.toggleSeamOnSelection)
  const extrudeSelection = useSceneStore((s) => s.extrudeSelection)
  const setCreaseWeight = useSceneStore((s) => s.setCreaseWeight)
  const creaseValue = creaseValueForSelection(selectedObj, editElementType, selectedEdges, selectedVertices)
  const creaseSelectionEmpty =
    (editElementType === 'edge' && selectedEdgesCount === 0) ||
    (editElementType === 'vertex' && selectedVerticesCount === 0) ||
    editElementType === 'face'

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

      <div className="toolbar-group mode-group">
        <button
          className={mode === 'object' ? 'active' : ''}
          title="オブジェクトモード"
          onClick={() => setMode('object')}
        >
          <ObjectModeIcon />
        </button>
        <button
          className={mode === 'edit' ? 'active' : ''}
          title="編集モード"
          onClick={() => setMode('edit')}
        >
          <EditModeIcon />
        </button>
      </div>

      {mode === 'edit' && (
        <div className="toolbar-group">
          <button
            className={editElementType === 'vertex' ? 'active' : ''}
            title="頂点"
            onClick={() => setEditElementType('vertex')}
          >
            <VertexIcon />
          </button>
          <button
            className={editElementType === 'edge' ? 'active' : ''}
            title="辺"
            onClick={() => setEditElementType('edge')}
          >
            <EdgeIcon />
          </button>
          <button
            className={editElementType === 'face' ? 'active' : ''}
            title="面"
            onClick={() => setEditElementType('face')}
          >
            <FaceIcon />
          </button>
        </div>
      )}

      {mode === 'edit' && (
        <div className="toolbar-group tool-group">
          <button
            className={activeTool === 'loopcut' ? 'active' : ''}
            disabled={!selectedObj}
            title="ループカット（四角面が連なっている部分にカーソルを合わせてください）"
            onClick={() => setActiveTool(activeTool === 'loopcut' ? 'select' : 'loopcut')}
          >
            <LoopCutIcon />
          </button>
          <button
            className={activeTool === 'knife' ? 'active' : ''}
            disabled={!selectedObj}
            title="ナイフ（辺/頂点をクリックして連結。Enter/ダブルクリックで確定、Esc/右クリックでパスをキャンセル）"
            onClick={() => setActiveTool(activeTool === 'knife' ? 'select' : 'knife')}
          >
            <KnifeIcon />
          </button>
          <button
            disabled={
              (editElementType === 'edge' && selectedEdgesCount === 0) ||
              (editElementType === 'vertex' && selectedVerticesCount < 2) ||
              editElementType === 'face'
            }
            title="選択した辺（または頂点間の既存の辺）を押し出します"
            onClick={() => extrudeSelection()}
          >
            <ExtrudeIcon />
          </button>
          <button
            disabled={editElementType !== 'edge' || selectedEdgesCount === 0}
            title="選択した辺をUVシームとしてマーク/解除（トポロジーは繋がったままUVだけ分割できます）"
            onClick={() => toggleSeamOnSelection()}
          >
            <SeamIcon />
          </button>
          {(editElementType === 'edge' || editElementType === 'vertex') && (
            <label
              className="seg-input"
              title="選択中の辺/頂点のSDSクリース強度（0=滑らか、1=分割しても尖りを維持）。複数選択時、値が混在していると空欄表示になりますが、操作すれば選択中全部に一括設定されます"
            >
              <CreaseIcon />
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                disabled={creaseSelectionEmpty}
                value={creaseValue === 'mixed' ? 0 : creaseValue}
                onChange={(e) => setCreaseWeight(+e.target.value)}
              />
              <span>{creaseSelectionEmpty ? '' : creaseValue === 'mixed' ? '—' : creaseValue.toFixed(2)}</span>
            </label>
          )}
        </div>
      )}
    </div>
  )
}
