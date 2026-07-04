import { useSceneStore } from '../scene/store'
import {
  ObjectModeIcon,
  EditModeIcon,
  PivotModeIcon,
  VertexIcon,
  EdgeIcon,
  FaceIcon,
  LoopCutIcon,
  RingCutIcon,
  KnifeIcon,
  ExtrudeIcon,
  DissolveIcon,
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
  const extrudeSelection = useSceneStore((s) => s.extrudeSelection)
  const dissolveSelection = useSceneStore((s) => s.dissolveSelection)

  return (
    <div className="tool-pane">
      <div className="tool-pane-group mode-group">
        <button
          className={mode === 'object' ? 'active' : ''}
          title="Object mode"
          onClick={() => setMode('object')}
        >
          <ObjectModeIcon />
        </button>
        <button
          className={mode === 'edit' ? 'active' : ''}
          title="Edit mode"
          onClick={() => setMode('edit')}
        >
          <EditModeIcon />
        </button>
        <button
          className={mode === 'pivot' ? 'active' : ''}
          disabled={!selectedObj || selectedObj.kind === 'path'}
          title={
            selectedObj?.kind === 'path'
              ? "A Path's Head/Tail always match its start/end control point — nothing to drag here"
              : 'Pivot mode (drag to edit the Head/Tail position)'
          }
          onClick={() => setMode('pivot')}
        >
          <PivotModeIcon />
        </button>
      </div>

      {mode === 'edit' && (
        <>
          <div className="tool-pane-group">
            <button
              className={editElementType === 'vertex' ? 'active' : ''}
              title="Vertex"
              onClick={() => setEditElementType('vertex')}
            >
              <VertexIcon />
            </button>
            <button
              className={editElementType === 'edge' ? 'active' : ''}
              title="Edge"
              onClick={() => setEditElementType('edge')}
            >
              <EdgeIcon />
            </button>
            <button
              className={editElementType === 'face' ? 'active' : ''}
              title="Face"
              onClick={() => setEditElementType('face')}
            >
              <FaceIcon />
            </button>
          </div>

          <div className="tool-pane-group tool-group">
            <button
              className={activeTool === 'loopcut' ? 'active' : ''}
              disabled={!selectedObj}
              title="Loop cut (hover over a run of connected quad faces)"
              onClick={() => setActiveTool(activeTool === 'loopcut' ? 'select' : 'loopcut')}
            >
              <LoopCutIcon />
            </button>
            <button
              className={activeTool === 'ringcut' ? 'active' : ''}
              disabled={!selectedObj}
              title="Ring cut (Cmd/Ctrl+Shift+R. Hover over a radial edge of a triangle fan, e.g. a circle primitive)"
              onClick={() => setActiveTool(activeTool === 'ringcut' ? 'select' : 'ringcut')}
            >
              <RingCutIcon />
            </button>
            <button
              className={activeTool === 'knife' ? 'active' : ''}
              disabled={!selectedObj}
              title="Knife (click edges/vertices to connect them. Enter/double-click to confirm, Esc/right-click to cancel the path)"
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
              title="Extrude the selected edges (or the existing edge between selected vertices)"
              onClick={() => extrudeSelection()}
            >
              <ExtrudeIcon />
            </button>
            <button
              disabled={
                (editElementType === 'edge' && selectedEdgesCount === 0) ||
                (editElementType === 'vertex' && selectedVerticesCount === 0) ||
                editElementType === 'face'
              }
              title="Dissolve the selected vertices/edges (merges the surrounding faces into one, then removes it. Ctrl+X)"
              onClick={() => dissolveSelection()}
            >
              <DissolveIcon />
            </button>
          </div>
        </>
      )}
    </div>
  )
}
