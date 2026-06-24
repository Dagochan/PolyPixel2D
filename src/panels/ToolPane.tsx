import { useSceneStore } from '../scene/store'
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
} from './icons'

/** Narrow, icon-only vertical tool palette along the left edge of the viewport (Blender-style
 *  left toolbar) — holds the mode switch plus the edit-mode element-type and mesh-tool buttons.
 *  Everything else (project/file ops, undo/redo, primitive add) stays in the top Toolbar. */
export default function ToolPane() {
  const mode = useSceneStore((s) => s.mode)
  const setMode = useSceneStore((s) => s.setMode)
  const editElementType = useSceneStore((s) => s.editElementType)
  const setEditElementType = useSceneStore((s) => s.setEditElementType)
  const activeTool = useSceneStore((s) => s.activeTool)
  const setActiveTool = useSceneStore((s) => s.setActiveTool)
  const selectedObj = useSceneStore((s) => s.objects.find((o) => o.id === s.selectedObjectId))
  const selectedEdges = useSceneStore((s) => s.selectedEdges)
  const selectedVertices = useSceneStore((s) => s.selectedVertices)
  const selectedEdgesCount = selectedEdges.size
  const selectedVerticesCount = selectedVertices.size
  const toggleSeamOnSelection = useSceneStore((s) => s.toggleSeamOnSelection)
  const extrudeSelection = useSceneStore((s) => s.extrudeSelection)

  return (
    <div className="tool-pane">
      <div className="tool-pane-group mode-group">
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
        <>
          <div className="tool-pane-group">
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

          <div className="tool-pane-group tool-group">
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
          </div>
        </>
      )}
    </div>
  )
}
