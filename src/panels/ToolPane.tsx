import { useSceneStore } from '../scene/store'
import { findCommonBoundaryFace, edgesAmongVertices } from '../scene/fanCut'
import { findOpenVertexPath } from '../scene/smoothPath'
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
  FanCutIcon,
  SmoothPathIcon,
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
  // A Lattice's vertex count/order is load-bearing for FFD (row-major idx = j*cols+i, see
  // `FfdSettings`'s doc) — any topology-changing tool (loop/ring cut, knife, extrude, dissolve)
  // would desync it from `latticeCols`/`latticeRows`/`cageRestVertices`, silently no-opping the
  // modifier at best. Only plain vertex-drag (which doesn't change count/order) stays available.
  const isLattice = selectedObj?.kind === 'lattice'

  // Fan Cut targets one or more outer-silhouette edges of the same face: any number of selected
  // edges (Edge mode — e.g. two edges meeting at one selected corner), or the edges that already
  // connect the selected vertices (Vertex mode — e.g. select a shared corner plus both far ends
  // to name the same 2-edge corner, no explicit order needed) — see the tool's doc in
  // Viewport.tsx.
  let fanCutEdges: [number, number][] | null = null
  if (editElementType === 'edge' && selectedEdgesCount >= 1) {
    fanCutEdges = Array.from(selectedEdges).map((key) => {
      const [a, b] = key.split('_').map(Number)
      return [a, b] as [number, number]
    })
  } else if (editElementType === 'vertex' && selectedVerticesCount >= 2 && selectedObj) {
    const derived = edgesAmongVertices(selectedObj.mesh, Array.from(selectedVertices))
    fanCutEdges = derived.length > 0 ? derived : null
  }
  const fanCutValid =
    !!selectedObj && !isLattice && !!fanCutEdges && findCommonBoundaryFace(selectedObj.mesh, fanCutEdges) !== null

  // Smooth Path targets a single open vertex chain (any number of selected vertices in Vertex
  // mode, at least 3, connected via existing edges with exactly 2 endpoints) — see the tool's
  // doc in Viewport.tsx / `findOpenVertexPath`.
  const smoothPathValid =
    !!selectedObj &&
    !isLattice &&
    editElementType === 'vertex' &&
    selectedVerticesCount >= 3 &&
    findOpenVertexPath(selectedObj.mesh, Array.from(selectedVertices)) !== null

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
          disabled={!selectedObj}
          title="Pivot mode (drag to edit the Head/Tail position)"
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
              disabled={!selectedObj || isLattice}
              title={
                isLattice
                  ? "A Lattice's vertex count/order is load-bearing for FFD (see FFD modifier) — topology-changing tools are disabled on it"
                  : 'Loop cut (hover over a run of connected quad faces)'
              }
              onClick={() => setActiveTool(activeTool === 'loopcut' ? 'select' : 'loopcut')}
            >
              <LoopCutIcon />
            </button>
            <button
              className={activeTool === 'ringcut' ? 'active' : ''}
              disabled={!selectedObj || isLattice}
              title={
                isLattice
                  ? "A Lattice's vertex count/order is load-bearing for FFD (see FFD modifier) — topology-changing tools are disabled on it"
                  : 'Ring cut (Cmd/Ctrl+Shift+R. Hover over a radial edge of a triangle fan, e.g. a circle primitive)'
              }
              onClick={() => setActiveTool(activeTool === 'ringcut' ? 'select' : 'ringcut')}
            >
              <RingCutIcon />
            </button>
            <button
              className={activeTool === 'knife' ? 'active' : ''}
              disabled={!selectedObj || isLattice}
              title={
                isLattice
                  ? "A Lattice's vertex count/order is load-bearing for FFD (see FFD modifier) — topology-changing tools are disabled on it"
                  : 'Knife (click edges/vertices to connect them. Enter/double-click to confirm, Esc/right-click to cancel the path)'
              }
              onClick={() => setActiveTool(activeTool === 'knife' ? 'select' : 'knife')}
            >
              <KnifeIcon />
            </button>
            <button
              className={activeTool === 'fancut' ? 'active' : ''}
              disabled={!fanCutValid}
              title={
                isLattice
                  ? "A Lattice's vertex count/order is load-bearing for FFD (see FFD modifier) — topology-changing tools are disabled on it"
                  : 'Fan Cut: pokes the face on the selected outer-silhouette edge(s) — e.g. 2 edges meeting at one corner — (or the edges already connecting the selected vertices), fanning it to a new center vertex — scroll to set how many pieces each edge splits into, click to confirm, Esc/right-click to cancel'
              }
              onClick={() => setActiveTool(activeTool === 'fancut' ? 'select' : 'fancut')}
            >
              <FanCutIcon />
            </button>
            <button
              className={activeTool === 'smoothpath' ? 'active' : ''}
              disabled={!smoothPathValid}
              title={
                isLattice
                  ? "A Lattice's vertex count/order is load-bearing for FFD (see FFD modifier) — topology-changing tools are disabled on it"
                  : 'Smooth Path: relaxes the zigzag out of the selected open vertex chain (3+ vertices, one simple path) into a smooth curve — the 2 endpoints never move — scroll to set the relaxation strength (0 = untouched), click to confirm, Esc/right-click to cancel'
              }
              onClick={() => setActiveTool(activeTool === 'smoothpath' ? 'select' : 'smoothpath')}
            >
              <SmoothPathIcon />
            </button>
            <button
              disabled={
                isLattice ||
                (editElementType === 'edge' && selectedEdgesCount === 0) ||
                (editElementType === 'vertex' && selectedVerticesCount < 2) ||
                editElementType === 'face'
              }
              title={
                isLattice
                  ? "A Lattice's vertex count/order is load-bearing for FFD (see FFD modifier) — topology-changing tools are disabled on it"
                  : 'Extrude the selected edges (or the existing edge between selected vertices)'
              }
              onClick={() => extrudeSelection()}
            >
              <ExtrudeIcon />
            </button>
            <button
              disabled={
                isLattice ||
                (editElementType === 'edge' && selectedEdgesCount === 0) ||
                (editElementType === 'vertex' && selectedVerticesCount === 0) ||
                editElementType === 'face'
              }
              title={
                isLattice
                  ? "A Lattice's vertex count/order is load-bearing for FFD (see FFD modifier) — topology-changing tools are disabled on it"
                  : 'Dissolve the selected vertices/edges (merges the surrounding faces into one, then removes it. Ctrl+X)'
              }
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
