import { useEffect, useRef, useState } from 'react'
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
  const gridVisible = useSceneStore((s) => s.gridVisible)
  const setGridVisible = useSceneStore((s) => s.setGridVisible)
  const loadProject = useSceneStore((s) => s.loadProject)
  const undo = useSceneStore((s) => s.undo)
  const redo = useSceneStore((s) => s.redo)
  const canUndo = useSceneStore((s) => s.history.length > 0)
  const canRedo = useSceneStore((s) => s.future.length > 0)
  const setActiveTool = useSceneStore((s) => s.setActiveTool)
  const gizmoOrientation = useSceneStore((s) => s.gizmoOrientation)
  const setGizmoOrientation = useSceneStore((s) => s.setGizmoOrientation)
  const pixelPreviewEnabled = useSceneStore((s) => s.pixelPreviewEnabled)
  const setPixelPreviewEnabled = useSceneStore((s) => s.setPixelPreviewEnabled)
  const selectedObj = useSceneStore((s) => s.objects.find((o) => o.id === s.selectedObjectId))

  const [segX, setSegX] = useState(1)
  const [segY, setSegY] = useState(1)
  const [circleSegs, setCircleSegs] = useState(16)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const refFileInputRef = useRef<HTMLInputElement>(null)
  const projectFileInputRef = useRef<HTMLInputElement>(null)

  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [addSubmenu, setAddSubmenu] = useState<'primitives' | null>(null)
  const addMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!addMenuOpen) return
    const handleOutside = (e: MouseEvent) => {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
        setAddMenuOpen(false)
        setAddSubmenu(null)
      }
    }
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  }, [addMenuOpen])

  const closeAddMenu = () => {
    setAddMenuOpen(false)
    setAddSubmenu(null)
  }

  const handleObjFile = async (file: File) => {
    try {
      const text = await file.text()
      const mesh = parseObjToMesh(text)
      const name = file.name.replace(/\.obj$/i, '')
      addImportedMesh(mesh, name)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to load the OBJ file.')
    }
  }

  const handleReferenceFile = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => setReferenceImage(reader.result as string)
    reader.readAsDataURL(file)
  }

  const handleSaveProject = () => {
    const { objects, referenceImage: ref, meshOpacity: opacity, clips } = useSceneStore.getState()
    const json = serializeProject({ version: PROJECT_VERSION, objects, referenceImage: ref, meshOpacity: opacity, clips })
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
      alert(err instanceof Error ? err.message : 'Failed to load the file.')
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
        <button title={`Open project (${PROJECT_EXTENSION})`} onClick={() => projectFileInputRef.current?.click()}>
          <ProjectOpenIcon />
        </button>
        <button title={`Save project (${PROJECT_EXTENSION})`} onClick={handleSaveProject}>
          <ProjectSaveIcon />
        </button>
      </div>

      <div className="toolbar-group">
        <button title="Undo (Cmd/Ctrl+Z)" disabled={!canUndo} onClick={() => undo()}>
          <UndoIcon />
        </button>
        <button title="Redo (Cmd/Ctrl+Shift+Z)" disabled={!canRedo} onClick={() => redo()}>
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
        <button title="Import an OBJ file (assumes a flat mesh)" onClick={() => fileInputRef.current?.click()}>
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
        <button title="Load a reference image for tracing" onClick={() => refFileInputRef.current?.click()}>
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
              Scale
              <input
                type="number"
                step={0.1}
                min={0.01}
                value={referenceImage.scale}
                onChange={(e) => setReferenceImageTransform({ scale: +e.target.value })}
              />
            </label>
            <button title="Remove reference image" onClick={() => setReferenceImage(null)}>
              Remove reference image
            </button>
          </>
        )}
      </div>

      <div className="toolbar-group">
        <label className="seg-input" title="Lowers all objects' opacity to make tracing the reference image easier">
          Mesh opacity
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
        <label className="seg-input" title="How many subdivisions each main grid cell is split into (also sets the grid-snap interval)">
          Subgrid
          <input
            type="number"
            min={1}
            max={100}
            value={gridSubdivisions}
            onChange={(e) => setGridSubdivisions(+e.target.value)}
          />
        </label>
        <label className="seg-input" title="Always snap to the grid while moving (hold Ctrl to temporarily invert this)">
          Grid snap
          <input
            type="checkbox"
            checked={gridSnapEnabled}
            onChange={(e) => setGridSnapEnabled(e.target.checked)}
          />
        </label>
        <label className="seg-input" title="Toggle the viewport grid display (grid snapping still works regardless of visibility)">
          Show grid
          <input type="checkbox" checked={gridVisible} onChange={(e) => setGridVisible(e.target.checked)} />
        </label>
      </div>

      {mode === 'object' && (
        <div className="toolbar-group">
          <label className="seg-input" title="Reference frame for the move gizmo's axes (Local = follows the object's own rotation, World = always the scene's XY axes)">
            Gizmo
            <select value={gizmoOrientation} onChange={(e) => setGizmoOrientation(e.target.value as 'world' | 'local')}>
              <option value="local">Local</option>
              <option value="world">World</option>
            </select>
          </label>
        </div>
      )}

      <div className="toolbar-group add-menu" ref={addMenuRef}>
        <button
          className={addMenuOpen ? 'active' : ''}
          title="Add an object"
          onClick={() => setAddMenuOpen((o) => !o)}
        >
          + Add ▾
        </button>
        {addMenuOpen && (
          <div className="dropdown-menu">
            <div
              className="dropdown-item has-submenu"
              onMouseEnter={() => setAddSubmenu('primitives')}
              onClick={() => setAddSubmenu('primitives')}
            >
              Primitives ▸
              {addSubmenu === 'primitives' && (
                <div className="dropdown-submenu">
                  <div className="dropdown-item-row">
                    <button
                      title={mode === 'edit' && selectedObj ? 'Add a rectangle as an island (click to place it)' : 'Add a rectangle'}
                      onClick={() => {
                        if (mode === 'edit' && selectedObj) {
                          setPendingPrimitive({ kind: 'rect', width: 100, height: 100, segX, segY })
                          setActiveTool('place-rect')
                        } else {
                          addRect(100, 100, segX, segY)
                        }
                        closeAddMenu()
                      }}
                    >
                      ▭ Rectangle
                    </button>
                    <label className="seg-input">
                      Segments X
                      <input type="number" min={1} value={segX} onChange={(e) => setSegX(+e.target.value)} />
                    </label>
                    <label className="seg-input">
                      Segments Y
                      <input type="number" min={1} value={segY} onChange={(e) => setSegY(+e.target.value)} />
                    </label>
                  </div>
                  <div className="dropdown-item-row">
                    <button
                      title={mode === 'edit' && selectedObj ? 'Add a circle as an island (click to place it)' : 'Add a circle'}
                      onClick={() => {
                        if (mode === 'edit' && selectedObj) {
                          setPendingPrimitive({ kind: 'circle', radius: 60, segments: circleSegs })
                          setActiveTool('place-circle')
                        } else {
                          addCircle(60, circleSegs)
                        }
                        closeAddMenu()
                      }}
                    >
                      ◯ Circle
                    </button>
                    <label className="seg-input">
                      Segments
                      <input
                        type="number"
                        min={3}
                        value={circleSegs}
                        onChange={(e) => setCircleSegs(+e.target.value)}
                      />
                    </label>
                  </div>
                </div>
              )}
            </div>
            <div
              className="dropdown-item"
              onClick={() => {
                addEmpty()
                closeAddMenu()
              }}
            >
              ✛ Empty
            </div>
          </div>
        )}
      </div>

      <div className="toolbar-group">
        <button
          className={pixelPreviewEnabled ? 'active' : ''}
          title="Preview the final pixel-art look at low resolution with nearest-neighbor scaling"
          onClick={() => setPixelPreviewEnabled(!pixelPreviewEnabled)}
        >
          ▦ Pixel preview
        </button>
      </div>

    </div>
  )
}
