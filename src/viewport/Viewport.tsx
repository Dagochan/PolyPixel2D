import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useSceneStore } from '../scene/store'
import { triangulate, getEdges, edgeKey, parseEdgeKey, getBounds } from '../scene/meshUtils'
import { applyTransform, inverseTransform, worldBounds } from '../scene/transformUtils'
import { makeOrthoCamera, screenToWorld, updateOrthoCamera, type ViewState } from './camera2d'
import type { SceneObject } from '../scene/types'
import { findFullLoop, type LoopPath } from '../scene/loopPath'

const HANDLE_SIZE = 8 // px
const VERTEX_HIT_RADIUS = 8 // px
const GIZMO_HIT_TOLERANCE = 7 // px
const RING_RADIUS_PX = 56 // fixed screen size, like Blender's gizmo (doesn't scale with object size)
const ARROW_LENGTH_PX = 42

type DragMode =
  | { kind: 'none' }
  | { kind: 'pan'; startClientX: number; startClientY: number; startPan: { x: number; y: number } }
  | { kind: 'move-object'; objectId: string; startWorld: { x: number; y: number }; startTransform: { x: number; y: number } }
  | {
      kind: 'move-object-axis'
      objectId: string
      axisDir: { x: number; y: number } // unit vector, world space
      startWorld: { x: number; y: number }
      startTransform: { x: number; y: number }
    }
  | {
      kind: 'scale-object'
      objectId: string
      corner: 'tl' | 'tr' | 'bl' | 'br'
      startTransform: SceneObject['transform']
      meshCornerRel: { x: number; y: number } // relative to pivot
    }
  | { kind: 'rotate-object'; objectId: string; startRotation: number; startAngle: number; center: { x: number; y: number } }
  | { kind: 'move-vertices'; objectId: string; indices: number[]; lastWorld: { x: number; y: number } }
  | { kind: 'move-pivot'; objectId: string }
  | {
      kind: 'box-select'
      objectId: string
      additive: boolean
      startClientX: number
      startClientY: number
      endClientX: number
      endClientY: number
    }

interface LoopCutHover {
  edgeA: number
  edgeB: number
  t: number
  path: LoopPath
}

export default function Viewport() {
  const containerRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const cameraRef = useRef<THREE.OrthographicCamera | null>(null)
  const sceneRef = useRef<THREE.Scene>(new THREE.Scene())
  const viewRef = useRef<ViewState>({ panX: 0, panY: 0, zoom: 1 })
  const dragRef = useRef<DragMode>({ kind: 'none' })
  const loopCutHoverRef = useRef<LoopCutHover | null>(null)
  const loopCutCountRef = useRef(1)
  const selectionBoxRef = useRef<HTMLDivElement>(null)

  function loopCutTs(): number[] {
    const count = loopCutCountRef.current
    const hover = loopCutHoverRef.current
    if (!hover) return []
    if (count <= 1) return [hover.t]
    return Array.from({ length: count }, (_, i) => (i + 1) / (count + 1))
  }

  useEffect(() => {
    const container = containerRef.current!
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    container.appendChild(renderer.domElement)
    rendererRef.current = renderer

    const rect = container.getBoundingClientRect()
    const camera = makeOrthoCamera(rect.width, rect.height, viewRef.current)
    cameraRef.current = camera

    const resize = () => {
      const r = container.getBoundingClientRect()
      renderer.setSize(r.width, r.height)
      updateOrthoCamera(camera, r.width, r.height, viewRef.current)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(container)

    let raf = 0
    const tick = () => {
      const r = container.getBoundingClientRect()
      updateOrthoCamera(camera, r.width, r.height, viewRef.current)
      rebuildScene()
      renderer.render(sceneRef.current, camera)
      raf = requestAnimationFrame(tick)
    }
    tick()

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      // while loop-cut tool is hovering a valid edge, scroll adjusts the number of
      // parallel cuts instead of zooming the camera (Blender-style loop cut)
      if (loopCutHoverRef.current) {
        const delta = e.deltaY < 0 ? 1 : -1
        loopCutCountRef.current = Math.max(1, Math.min(20, loopCutCountRef.current + delta))
        return
      }
      const r = container.getBoundingClientRect()
      const before = screenToWorld(e.clientX, e.clientY, r, viewRef.current)
      const factor = Math.exp(-e.deltaY * 0.001)
      viewRef.current.zoom = Math.min(20, Math.max(0.05, viewRef.current.zoom * factor))
      const after = screenToWorld(e.clientX, e.clientY, r, viewRef.current)
      viewRef.current.panX += before.x - after.x
      viewRef.current.panY += before.y - after.y
      updateOrthoCamera(camera, r.width, r.height, viewRef.current)
    }
    container.addEventListener('wheel', onWheel, { passive: false })

    const cancelActiveDrag = () => {
      if (dragRef.current.kind !== 'none' && dragRef.current.kind !== 'pan') {
        useSceneStore.getState().cancelChange()
      }
      dragRef.current = { kind: 'none' }
      if (useSceneStore.getState().activeTool === 'loopcut') {
        useSceneStore.getState().setActiveTool('select')
        loopCutHoverRef.current = null
      }
    }

    // Chrome/Edge trigger native middle-click auto-scroll directly off `mousedown`,
    // independent of pointerdown.preventDefault(). Block it at the source, and also
    // block auxclick so the dismissal click doesn't get swallowed by the browser.
    // Right-click cancel is also handled here (not in pointerdown): the browser only
    // fires `pointerdown` on the initial button-down transition — pressing a second
    // button while the first is still held only updates `buttons` on pointermove and
    // fires a legacy `mousedown`, so that's the event we must listen to for button 2.
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault()
      if (e.button === 2) cancelActiveDrag()
    }
    const onAuxClick = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault()
    }
    container.addEventListener('mousedown', onMouseDown)
    container.addEventListener('auxclick', onAuxClick)

    // Blender-style: right-click while dragging cancels the in-progress operation.
    const onContextMenu = (e: MouseEvent) => e.preventDefault()
    container.addEventListener('contextmenu', onContextMenu)

    const onPointerDown = (e: PointerEvent) => {
      if (e.button === 2) return
      container.setPointerCapture(e.pointerId)
      handlePointerDown(e)
    }
    const onPointerMove = (e: PointerEvent) => {
      updateLoopCutHover(e)
      handlePointerMove(e)
    }
    const onPointerUp = (e: PointerEvent) => {
      if (container.hasPointerCapture(e.pointerId)) container.releasePointerCapture(e.pointerId)
      handlePointerUp(e)
    }
    // Trackpads often can't register a secondary-click while the primary button is held
    // (the two-finger-tap gesture conflicts with an active single-finger drag), so Escape
    // is the reliable cancel path — this is also how Blender itself supports cancellation.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelActiveDrag()
    }
    window.addEventListener('keydown', onKeyDown)
    container.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      container.removeEventListener('wheel', onWheel)
      container.removeEventListener('mousedown', onMouseDown)
      container.removeEventListener('auxclick', onAuxClick)
      container.removeEventListener('contextmenu', onContextMenu)
      container.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('keydown', onKeyDown)
      container.removeChild(renderer.domElement)
      renderer.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function rebuildScene() {
    const scene = sceneRef.current
    scene.clear()
    scene.add(new THREE.AmbientLight(0xffffff, 1))
    addGrid(scene)

    const { objects, selectedObjectId, mode, editElementType, selectedVertices, selectedEdges, selectedFaces } =
      useSceneStore.getState()
    const sorted = [...objects].sort((a, b) => a.zOrder - b.zOrder)

    sorted.forEach((obj, depthIndex) => {
      if (!obj.visible) return
      const group = new THREE.Group()
      group.position.z = depthIndex
      const isSelected = obj.id === selectedObjectId

      // THREE's Object3D position/rotation/scale always pivots about the local origin, but our
      // objects can have an arbitrary pivot — so bake the pivot offset into the geometry itself
      // (matches applyTransform: world = R*scale*(v - pivot) + position).
      const { pivot } = obj.transform
      const positions = obj.mesh.vertices.flatMap((v) => [v.x - pivot.x, v.y - pivot.y, 0])
      const geom = new THREE.BufferGeometry()
      geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
      geom.setIndex(triangulate(obj.mesh))
      const mat = new THREE.MeshBasicMaterial({ color: obj.color, side: THREE.DoubleSide })
      const mesh = new THREE.Mesh(geom, mat)
      mesh.position.set(obj.transform.x, obj.transform.y, 0)
      mesh.rotation.z = obj.transform.rotation
      mesh.scale.set(obj.transform.scaleX, obj.transform.scaleY, 1)
      group.add(mesh)

      // wireframe edges
      const edgePositions: number[] = []
      for (const [a, b] of getEdges(obj.mesh)) {
        const va = obj.mesh.vertices[a]
        const vb = obj.mesh.vertices[b]
        edgePositions.push(va.x - pivot.x, va.y - pivot.y, 0, vb.x - pivot.x, vb.y - pivot.y, 0)
      }
      const edgeGeom = new THREE.BufferGeometry()
      edgeGeom.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3))
      const edgeMat = new THREE.LineBasicMaterial({ color: isSelected ? 0xffffff : 0x000000, opacity: 0.6, transparent: true })
      const edgeLines = new THREE.LineSegments(edgeGeom, edgeMat)
      edgeLines.position.copy(mesh.position)
      edgeLines.rotation.copy(mesh.rotation)
      edgeLines.scale.copy(mesh.scale)
      edgeLines.position.z = 0.01
      group.add(edgeLines)

      // edit-mode overlays
      if (mode === 'edit' && isSelected) {
        if (editElementType === 'vertex') {
          obj.mesh.vertices.forEach((v, i) => {
            const p = applyTransform(v, obj.transform)
            const dotGeom = new THREE.CircleGeometry(4 / viewRef.current.zoom, 12)
            const selected = selectedVertices.has(i)
            const dotMat = new THREE.MeshBasicMaterial({ color: selected ? 0xffcc00 : 0xffffff, depthTest: false })
            const dot = new THREE.Mesh(dotGeom, dotMat)
            dot.position.set(p.x, p.y, 0.02)
            group.add(dot)
          })
        }

        if (editElementType === 'edge') {
          for (const [a, b] of getEdges(obj.mesh)) {
            if (!selectedEdges.has(edgeKey(a, b))) continue
            const pa = applyTransform(obj.mesh.vertices[a], obj.transform)
            const pb = applyTransform(obj.mesh.vertices[b], obj.transform)

            // thick quad along the edge (LineBasicMaterial linewidth is ignored by WebGL)
            const halfWidth = 1.2 / viewRef.current.zoom
            const dx = pb.x - pa.x
            const dy = pb.y - pa.y
            const len = Math.hypot(dx, dy) || 1
            const nx = (-dy / len) * halfWidth
            const ny = (dx / len) * halfWidth
            const quadGeom = new THREE.BufferGeometry()
            quadGeom.setAttribute(
              'position',
              new THREE.Float32BufferAttribute(
                [
                  pa.x + nx, pa.y + ny, 0,
                  pa.x - nx, pa.y - ny, 0,
                  pb.x - nx, pb.y - ny, 0,
                  pb.x + nx, pb.y + ny, 0,
                ],
                3,
              ),
            )
            quadGeom.setIndex([0, 1, 2, 0, 2, 3])
            const quadMat = new THREE.MeshBasicMaterial({ color: 0xffe066, depthTest: false })
            const quad = new THREE.Mesh(quadGeom, quadMat)
            quad.position.z = 0.025
            group.add(quad)

            // endpoint markers for extra visibility
            for (const p of [pa, pb]) {
              const dotGeom = new THREE.CircleGeometry(2.5 / viewRef.current.zoom, 12)
              const dot = new THREE.Mesh(dotGeom, new THREE.MeshBasicMaterial({ color: 0xffe066, depthTest: false }))
              dot.position.set(p.x, p.y, 0.026)
              group.add(dot)
            }
          }
        }

        if (editElementType === 'face') {
          obj.mesh.faces.forEach((face, fi) => {
            if (!selectedFaces.has(fi)) return
            const pts = face.map((i) => applyTransform(obj.mesh.vertices[i], obj.transform))
            const positions = pts.flatMap((p) => [p.x, p.y, 0])
            const indices: number[] = []
            for (let i = 1; i < pts.length - 1; i++) indices.push(0, i, i + 1)
            const geom = new THREE.BufferGeometry()
            geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
            geom.setIndex(indices)
            const mat = new THREE.MeshBasicMaterial({ color: 0xffcc00, opacity: 0.45, transparent: true, side: THREE.DoubleSide, depthTest: false })
            const faceMesh = new THREE.Mesh(geom, mat)
            faceMesh.position.z = 0.015
            group.add(faceMesh)
          })
        }
      }

      scene.add(group)
    })

    // BBox gizmo in object mode
    if (mode === 'object' && selectedObjectId) {
      const obj = objects.find((o) => o.id === selectedObjectId)
      if (obj) addGizmo(scene, obj)
    }

    // loop-cut preview (one polyline per pending parallel cut, running the length of the loop)
    const { activeTool } = useSceneStore.getState()
    if (mode === 'edit' && activeTool === 'loopcut' && loopCutHoverRef.current) {
      const obj = objects.find((o) => o.id === selectedObjectId)
      if (obj) {
        const hover = loopCutHoverRef.current
        for (const t of loopCutTs()) addLoopCutPreview(scene, obj, hover.path, t)
      }
    }
  }

  function addLoopCutPreview(scene: THREE.Scene, obj: SceneObject, path: LoopPath, t: number) {
    const { mesh, transform } = obj
    const lerp = (a: { x: number; y: number }, b: { x: number; y: number }, t: number) => ({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
    })

    const points = path.cuts.map(([a, b]) =>
      applyTransform(lerp(mesh.vertices[a], mesh.vertices[b], t), transform),
    )

    const positions: number[] = []
    for (let i = 0; i < points.length - 1; i++) {
      positions.push(points[i].x, points[i].y, 0.7, points[i + 1].x, points[i + 1].y, 0.7)
    }
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    scene.add(new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color: 0xffaa33, depthTest: false })))

    const pxToWorld = 1 / viewRef.current.zoom
    for (const p of points) {
      const dotGeom = new THREE.CircleGeometry(3 * pxToWorld, 12)
      const dot = new THREE.Mesh(dotGeom, new THREE.MeshBasicMaterial({ color: 0xffaa33, depthTest: false }))
      dot.position.set(p.x, p.y, 0.7)
      scene.add(dot)
    }
  }

  function addGrid(scene: THREE.Scene) {
    const view = viewRef.current
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return
    const halfW = rect.width / 2 / view.zoom
    const halfH = rect.height / 2 / view.zoom

    // pick a grid spacing so lines stay ~40-80px apart on screen
    const targetPx = 60
    const rawSpacing = targetPx / view.zoom
    const pow = Math.pow(10, Math.floor(Math.log10(rawSpacing)))
    const candidates = [1, 2, 5, 10].map((m) => m * pow)
    const spacing = candidates.find((c) => c >= rawSpacing) ?? candidates[candidates.length - 1]

    const minX = Math.floor((view.panX - halfW) / spacing) * spacing
    const maxX = Math.ceil((view.panX + halfW) / spacing) * spacing
    const minY = Math.floor((view.panY - halfH) / spacing) * spacing
    const maxY = Math.ceil((view.panY + halfH) / spacing) * spacing

    const minorPositions: number[] = []
    let yAxisPositions: number[] | null = null // vertical line through x=0
    let xAxisPositions: number[] | null = null // horizontal line through y=0
    for (let x = minX; x <= maxX; x += spacing) {
      if (Math.abs(x) < spacing / 2) yAxisPositions = [x, minY, -10, x, maxY, -10]
      else minorPositions.push(x, minY, -10, x, maxY, -10)
    }
    for (let y = minY; y <= maxY; y += spacing) {
      if (Math.abs(y) < spacing / 2) xAxisPositions = [minX, y, -10, maxX, y, -10]
      else minorPositions.push(minX, y, -10, maxX, y, -10)
    }

    if (minorPositions.length > 0) {
      const geom = new THREE.BufferGeometry()
      geom.setAttribute('position', new THREE.Float32BufferAttribute(minorPositions, 3))
      const mat = new THREE.LineBasicMaterial({ color: 0x33343a })
      scene.add(new THREE.LineSegments(geom, mat))
    }
    if (xAxisPositions) {
      const geom = new THREE.BufferGeometry()
      geom.setAttribute('position', new THREE.Float32BufferAttribute(xAxisPositions, 3))
      scene.add(new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color: 0xe5484d })))
    }
    if (yAxisPositions) {
      const geom = new THREE.BufferGeometry()
      geom.setAttribute('position', new THREE.Float32BufferAttribute(yAxisPositions, 3))
      scene.add(new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color: 0x4ec96a })))
    }
  }

  /** Shared geometry for the gizmo, used both for rendering and hit-testing so they stay in sync.
   *  Ring/arrow size is fixed in screen pixels (like Blender) so it doesn't balloon or shrink
   *  with object size/rotation/zoom; only the corner scale handles follow the actual mesh bounds. */
  function getGizmoGeom(obj: SceneObject) {
    const lb = getBounds(obj.mesh)
    const center = { x: obj.transform.x, y: obj.transform.y }
    const pxToWorld = 1 / viewRef.current.zoom
    const ringRadius = RING_RADIUS_PX * pxToWorld
    const arrowLength = ARROW_LENGTH_PX * pxToWorld
    const cos = Math.cos(obj.transform.rotation)
    const sin = Math.sin(obj.transform.rotation)
    const axisX = { x: cos, y: sin } // local +X in world space
    const axisY = { x: -sin, y: cos } // local +Y in world space
    // the four local corners, transformed into world space (follows rotation exactly)
    const corners: Array<{ key: 'tl' | 'tr' | 'bl' | 'br'; x: number; y: number }> = [
      { key: 'bl', ...applyTransform({ x: lb.minX, y: lb.minY }, obj.transform) },
      { key: 'br', ...applyTransform({ x: lb.maxX, y: lb.minY }, obj.transform) },
      { key: 'tl', ...applyTransform({ x: lb.minX, y: lb.maxY }, obj.transform) },
      { key: 'tr', ...applyTransform({ x: lb.maxX, y: lb.maxY }, obj.transform) },
    ]
    return { localBounds: lb, center, ringRadius, arrowLength, axisX, axisY, corners }
  }

  function addGizmo(scene: THREE.Scene, obj: SceneObject) {
    const { center, ringRadius, arrowLength, axisX, axisY, corners } = getGizmoGeom(obj)
    const pxToWorld = 1 / viewRef.current.zoom

    // dashed bbox outline connecting the corners in winding order (bl -> br -> tr -> tl -> bl)
    const byKey = Object.fromEntries(corners.map((c) => [c.key, c]))
    const order: Array<'bl' | 'br' | 'tr' | 'tl'> = ['bl', 'br', 'tr', 'tl']
    const outlinePositions: number[] = []
    for (let i = 0; i < order.length; i++) {
      const a = byKey[order[i]]
      const b = byKey[order[(i + 1) % order.length]]
      outlinePositions.push(a.x, a.y, 0.5, b.x, b.y, 0.5)
    }
    const outlineGeom = new THREE.BufferGeometry()
    outlineGeom.setAttribute('position', new THREE.Float32BufferAttribute(outlinePositions, 3))
    const outlineMat = new THREE.LineDashedMaterial({
      color: 0x4ea1ff,
      dashSize: 6 * pxToWorld,
      gapSize: 4 * pxToWorld,
      depthTest: false,
    })
    const outline = new THREE.LineSegments(outlineGeom, outlineMat)
    outline.computeLineDistances()
    scene.add(outline)

    // corner handles for free (non-axis-locked) scale
    const handleMat = new THREE.MeshBasicMaterial({ color: 0x4ea1ff, depthTest: false })
    for (const { x, y } of corners) {
      const size = (HANDLE_SIZE * pxToWorld) / 2
      const geom = new THREE.PlaneGeometry(size, size)
      const m = new THREE.Mesh(geom, handleMat)
      m.position.set(x, y, 0.6)
      scene.add(m)
    }

    // rotate ring
    const ringGeom = new THREE.RingGeometry(
      ringRadius - 1 * pxToWorld,
      ringRadius + 1 * pxToWorld,
      48,
    )
    const ringMesh = new THREE.Mesh(ringGeom, new THREE.MeshBasicMaterial({ color: 0xffaa33, depthTest: false }))
    ringMesh.position.set(center.x, center.y, 0.55)
    scene.add(ringMesh)

    // axis move arrows (red = local X, green = local Y)
    addAxisArrow(scene, center, axisX, arrowLength, pxToWorld, 0xe5484d)
    addAxisArrow(scene, center, axisY, arrowLength, pxToWorld, 0x4ec96a)

    // pivot dot (white) — Shift+drag this to relocate the pivot without moving the mesh
    const pivotDotGeom = new THREE.CircleGeometry(3.5 * pxToWorld, 16)
    const pivotDot = new THREE.Mesh(pivotDotGeom, new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }))
    pivotDot.position.set(center.x, center.y, 0.65)
    scene.add(pivotDot)
  }

  function addAxisArrow(
    scene: THREE.Scene,
    center: { x: number; y: number },
    dir: { x: number; y: number },
    length: number,
    pxToWorld: number,
    color: number,
  ) {
    const tip = { x: center.x + dir.x * length, y: center.y + dir.y * length }

    // thick quad shaft (LineBasicMaterial linewidth is ignored by WebGL)
    const shaftHalfWidth = 1.8 * pxToWorld
    const perpShaft = { x: -dir.y, y: dir.x }
    const shaftGeom = new THREE.BufferGeometry()
    shaftGeom.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [
          center.x + perpShaft.x * shaftHalfWidth, center.y + perpShaft.y * shaftHalfWidth, 0.55,
          center.x - perpShaft.x * shaftHalfWidth, center.y - perpShaft.y * shaftHalfWidth, 0.55,
          tip.x - perpShaft.x * shaftHalfWidth, tip.y - perpShaft.y * shaftHalfWidth, 0.55,
          tip.x + perpShaft.x * shaftHalfWidth, tip.y + perpShaft.y * shaftHalfWidth, 0.55,
        ],
        3,
      ),
    )
    shaftGeom.setIndex([0, 1, 2, 0, 2, 3])
    scene.add(new THREE.Mesh(shaftGeom, new THREE.MeshBasicMaterial({ color, depthTest: false })))

    const headLen = 12 * pxToWorld
    const headWidth = 6 * pxToWorld
    const perp = { x: -dir.y, y: dir.x }
    const base = { x: tip.x - dir.x * headLen, y: tip.y - dir.y * headLen }
    const headGeom = new THREE.BufferGeometry()
    headGeom.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [
          tip.x, tip.y, 0.55,
          base.x + perp.x * headWidth, base.y + perp.y * headWidth, 0.55,
          base.x - perp.x * headWidth, base.y - perp.y * headWidth, 0.55,
        ],
        3,
      ),
    )
    const head = new THREE.Mesh(headGeom, new THREE.MeshBasicMaterial({ color, depthTest: false }))
    scene.add(head)
  }

  function getWorldPos(e: PointerEvent) {
    const rect = containerRef.current!.getBoundingClientRect()
    return screenToWorld(e.clientX, e.clientY, rect, viewRef.current)
  }

  function pxDistSq(ax: number, ay: number, bx: number, by: number) {
    const dx = (ax - bx) * viewRef.current.zoom
    const dy = (ay - by) * viewRef.current.zoom
    return dx * dx + dy * dy
  }

  /** Distance in px from world point p to world segment (a,b). */
  function pxDistToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
    const zoom = viewRef.current.zoom
    const Px = px * zoom, Py = py * zoom
    const Ax = ax * zoom, Ay = ay * zoom
    const Bx = bx * zoom, By = by * zoom
    const dx = Bx - Ax
    const dy = By - Ay
    const lenSq = dx * dx + dy * dy
    let t = lenSq > 0 ? ((Px - Ax) * dx + (Py - Ay) * dy) / lenSq : 0
    t = Math.max(0, Math.min(1, t))
    const cx = Ax + t * dx
    const cy = Ay + t * dy
    return Math.hypot(Px - cx, Py - cy)
  }

  /** Like pxDistToSegment but also returns the (clamped) projection parameter along the segment. */
  function pxDistToSegmentWithT(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
    const zoom = viewRef.current.zoom
    const Px = px * zoom, Py = py * zoom
    const Ax = ax * zoom, Ay = ay * zoom
    const Bx = bx * zoom, By = by * zoom
    const dx = Bx - Ax
    const dy = By - Ay
    const lenSq = dx * dx + dy * dy
    let t = lenSq > 0 ? ((Px - Ax) * dx + (Py - Ay) * dy) / lenSq : 0
    t = Math.max(0, Math.min(1, t))
    const cx = Ax + t * dx
    const cy = Ay + t * dy
    return { dist: Math.hypot(Px - cx, Py - cy), t }
  }

  /** Find the nearest mesh edge to the cursor and trace the quad loop running through it. */
  function updateLoopCutHover(e: PointerEvent) {
    const store = useSceneStore.getState()
    const obj = store.objects.find((o) => o.id === store.selectedObjectId)
    if (store.mode !== 'edit' || store.activeTool !== 'loopcut' || !obj) {
      loopCutHoverRef.current = null
      return
    }
    const world = getWorldPos(e)
    let bestA = -1
    let bestB = -1
    let bestT = 0
    let bestDist = Infinity
    for (const [a, b] of getEdges(obj.mesh)) {
      const va = applyTransform(obj.mesh.vertices[a], obj.transform)
      const vb = applyTransform(obj.mesh.vertices[b], obj.transform)
      const { dist, t } = pxDistToSegmentWithT(world.x, world.y, va.x, va.y, vb.x, vb.y)
      if (dist < bestDist) {
        bestDist = dist
        bestA = a
        bestB = b
        bestT = t
      }
    }

    const prev = loopCutHoverRef.current
    let next: LoopCutHover | null = null
    if (bestDist < 40) {
      const path = findFullLoop(obj.mesh, bestA, bestB)
      if (path) next = { edgeA: bestA, edgeB: bestB, t: bestT, path }
    }
    if (!next || !prev || next.edgeA !== prev.edgeA || next.edgeB !== prev.edgeB) {
      loopCutCountRef.current = 1
    }
    loopCutHoverRef.current = next
  }

  function handlePointerDown(e: PointerEvent) {
    if (e.button === 1 || e.altKey) {
      e.preventDefault() // stop native middle-click auto-scroll from hijacking pointer events
      dragRef.current = {
        kind: 'pan',
        startClientX: e.clientX,
        startClientY: e.clientY,
        startPan: { x: viewRef.current.panX, y: viewRef.current.panY },
      }
      return
    }
    if (e.button !== 0) return

    const store0 = useSceneStore.getState()
    if (store0.mode === 'edit' && store0.activeTool === 'loopcut') {
      const hover = loopCutHoverRef.current
      if (hover && store0.selectedObjectId) {
        store0.applyLoopCut(store0.selectedObjectId, hover.edgeA, hover.edgeB, loopCutTs())
        store0.setActiveTool('select')
        loopCutHoverRef.current = null
        loopCutCountRef.current = 1
      }
      return
    }

    const world = getWorldPos(e)
    const { objects, selectedObjectId, mode, editElementType } = useSceneStore.getState()
    const selectedObj = objects.find((o) => o.id === selectedObjectId) || null

    if (mode === 'object' && selectedObj) {
      const { center, ringRadius, arrowLength, axisX, axisY, corners } = getGizmoGeom(selectedObj)

      // Shift+click near the pivot dot: relocate the pivot (mesh stays visually in place)
      if (e.shiftKey && pxDistSq(world.x, world.y, center.x, center.y) < (GIZMO_HIT_TOLERANCE * 1.5) ** 2) {
        useSceneStore.getState().beginChange()
        dragRef.current = { kind: 'move-pivot', objectId: selectedObj.id }
        return
      }

      // rotate ring: distance from center close to ringRadius
      const distFromCenter = Math.hypot(world.x - center.x, world.y - center.y) * viewRef.current.zoom
      if (Math.abs(distFromCenter - ringRadius * viewRef.current.zoom) < GIZMO_HIT_TOLERANCE) {
        useSceneStore.getState().beginChange()
        dragRef.current = {
          kind: 'rotate-object',
          objectId: selectedObj.id,
          startRotation: selectedObj.transform.rotation,
          startAngle: Math.atan2(world.y - center.y, world.x - center.x),
          center,
        }
        return
      }

      // axis move arrows (local X = red, local Y = green)
      for (const axisDir of [axisX, axisY]) {
        const tip = { x: center.x + axisDir.x * arrowLength, y: center.y + axisDir.y * arrowLength }
        const d = pxDistToSegment(world.x, world.y, center.x, center.y, tip.x, tip.y)
        if (d < GIZMO_HIT_TOLERANCE) {
          useSceneStore.getState().beginChange()
          dragRef.current = {
            kind: 'move-object-axis',
            objectId: selectedObj.id,
            axisDir,
            startWorld: world,
            startTransform: { x: selectedObj.transform.x, y: selectedObj.transform.y },
          }
          return
        }
      }

      // corner handles for free (non-axis-locked) scale, anchored at the pivot
      for (const c of corners) {
        if (pxDistSq(world.x, world.y, c.x, c.y) < HANDLE_SIZE ** 2) {
          const meshCorner = inverseTransform({ x: c.x, y: c.y }, selectedObj.transform)
          const pivot = selectedObj.transform.pivot
          useSceneStore.getState().beginChange()
          dragRef.current = {
            kind: 'scale-object',
            objectId: selectedObj.id,
            corner: c.key,
            startTransform: { ...selectedObj.transform, pivot: { ...pivot } },
            meshCornerRel: { x: meshCorner.x - pivot.x, y: meshCorner.y - pivot.y },
          }
          return
        }
      }
    }

    if (mode === 'edit' && selectedObj && editElementType === 'vertex') {
      let hitIndex = -1
      let bestDist = Infinity
      selectedObj.mesh.vertices.forEach((v, i) => {
        const p = applyTransform(v, selectedObj.transform)
        const d = pxDistSq(world.x, world.y, p.x, p.y)
        if (d < bestDist) {
          bestDist = d
          hitIndex = i
        }
      })
      const threshold = (VERTEX_HIT_RADIUS) ** 2
      if (hitIndex >= 0 && bestDist < threshold) {
        const store = useSceneStore.getState()
        const already = store.selectedVertices.has(hitIndex)
        // clicking an already-selected vertex (no shift) keeps the whole multi-selection so it
        // can be dragged as a group; shift toggles membership; clicking a new one resets to it alone
        const next = e.shiftKey || already ? new Set(store.selectedVertices) : new Set<number>()
        if (e.shiftKey && already) next.delete(hitIndex)
        else next.add(hitIndex)
        store.setSelectedVertices(next)
        store.beginChange()
        dragRef.current = {
          kind: 'move-vertices',
          objectId: selectedObj.id,
          indices: Array.from(next),
          lastWorld: world,
        }
        return
      }
      if (!e.shiftKey) useSceneStore.getState().setSelectedVertices(new Set())
      dragRef.current = {
        kind: 'box-select',
        objectId: selectedObj.id,
        additive: e.shiftKey,
        startClientX: e.clientX,
        startClientY: e.clientY,
        endClientX: e.clientX,
        endClientY: e.clientY,
      }
      return
    }

    if (mode === 'edit' && selectedObj && editElementType === 'edge') {
      let hitKey: string | null = null
      let bestDist = Infinity
      for (const [a, b] of getEdges(selectedObj.mesh)) {
        const pa = applyTransform(selectedObj.mesh.vertices[a], selectedObj.transform)
        const pb = applyTransform(selectedObj.mesh.vertices[b], selectedObj.transform)
        const d = pxDistToSegment(world.x, world.y, pa.x, pa.y, pb.x, pb.y)
        if (d < bestDist) {
          bestDist = d
          hitKey = edgeKey(a, b)
        }
      }
      if (hitKey && bestDist < VERTEX_HIT_RADIUS) {
        const store = useSceneStore.getState()
        const already = store.selectedEdges.has(hitKey)
        const next = e.shiftKey ? new Set(store.selectedEdges) : new Set<string>()
        if (e.shiftKey && already) next.delete(hitKey)
        else next.add(hitKey)
        store.setSelectedEdges(next)
        const indices = new Set<number>()
        next.forEach((k) => {
          const [a, b] = parseEdgeKey(k)
          indices.add(a)
          indices.add(b)
        })
        store.beginChange()
        dragRef.current = {
          kind: 'move-vertices',
          objectId: selectedObj.id,
          indices: Array.from(indices),
          lastWorld: world,
        }
        return
      }
      if (!e.shiftKey) useSceneStore.getState().setSelectedEdges(new Set())
      dragRef.current = {
        kind: 'box-select',
        objectId: selectedObj.id,
        additive: e.shiftKey,
        startClientX: e.clientX,
        startClientY: e.clientY,
        endClientX: e.clientX,
        endClientY: e.clientY,
      }
      return
    }

    if (mode === 'edit' && selectedObj && editElementType === 'face') {
      const local = inverseTransform(world, selectedObj.transform)
      let hitFace = -1
      selectedObj.mesh.faces.forEach((face, fi) => {
        if (hitFace === -1 && pointInPolygon(local, face.map((i) => selectedObj.mesh.vertices[i]))) {
          hitFace = fi
        }
      })
      if (hitFace >= 0) {
        const store = useSceneStore.getState()
        const already = store.selectedFaces.has(hitFace)
        const next = e.shiftKey ? new Set(store.selectedFaces) : new Set<number>()
        if (e.shiftKey && already) next.delete(hitFace)
        else next.add(hitFace)
        store.setSelectedFaces(next)
        const indices = new Set<number>()
        next.forEach((fi) => selectedObj.mesh.faces[fi].forEach((i) => indices.add(i)))
        store.beginChange()
        dragRef.current = {
          kind: 'move-vertices',
          objectId: selectedObj.id,
          indices: Array.from(indices),
          lastWorld: world,
        }
        return
      }
      if (!e.shiftKey) useSceneStore.getState().setSelectedFaces(new Set())
      dragRef.current = {
        kind: 'box-select',
        objectId: selectedObj.id,
        additive: e.shiftKey,
        startClientX: e.clientX,
        startClientY: e.clientY,
        endClientX: e.clientX,
        endClientY: e.clientY,
      }
      return
    }

    // object picking via raycast (object mode only)
    if (mode === 'object') {
      const picked = pickObject(e)
      useSceneStore.getState().selectObject(picked)
      if (picked) {
        const obj = objects.find((o) => o.id === picked)!
        useSceneStore.getState().beginChange()
        dragRef.current = {
          kind: 'move-object',
          objectId: picked,
          startWorld: world,
          startTransform: { x: obj.transform.x, y: obj.transform.y },
        }
      }
    }
  }

  function pickObject(e: PointerEvent): string | null {
    const { objects } = useSceneStore.getState()
    const sorted = [...objects].filter((o) => o.visible).sort((a, b) => b.zOrder - a.zOrder)
    const world = getWorldPos(e)
    for (const obj of sorted) {
      const local = inverseTransform(world, obj.transform)
      if (pointInPolygonFaces(local, obj)) return obj.id
    }
    return null
  }

  function pointInPolygonFaces(p: { x: number; y: number }, obj: SceneObject): boolean {
    for (const face of obj.mesh.faces) {
      if (pointInPolygon(p, face.map((i) => obj.mesh.vertices[i]))) return true
    }
    return false
  }

  function pointInPolygon(p: { x: number; y: number }, poly: { x: number; y: number }[]): boolean {
    let inside = false
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y
      const xj = poly[j].x, yj = poly[j].y
      const intersect =
        yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi
      if (intersect) inside = !inside
    }
    return inside
  }

  function handlePointerMove(e: PointerEvent) {
    const drag = dragRef.current
    if (drag.kind === 'none') return
    const store = useSceneStore.getState()

    if (drag.kind === 'pan') {
      const dx = (e.clientX - drag.startClientX) / viewRef.current.zoom
      const dy = (e.clientY - drag.startClientY) / viewRef.current.zoom
      viewRef.current.panX = drag.startPan.x - dx
      viewRef.current.panY = drag.startPan.y + dy
      return
    }

    const world = getWorldPos(e)

    if (drag.kind === 'move-object') {
      const dx = world.x - drag.startWorld.x
      const dy = world.y - drag.startWorld.y
      store.setTransform(drag.objectId, { x: drag.startTransform.x + dx, y: drag.startTransform.y + dy })
      return
    }

    if (drag.kind === 'move-object-axis') {
      const dx = world.x - drag.startWorld.x
      const dy = world.y - drag.startWorld.y
      const along = dx * drag.axisDir.x + dy * drag.axisDir.y // project onto axis
      store.setTransform(drag.objectId, {
        x: drag.startTransform.x + drag.axisDir.x * along,
        y: drag.startTransform.y + drag.axisDir.y * along,
      })
      return
    }

    if (drag.kind === 'move-vertices') {
      const dx = world.x - drag.lastWorld.x
      const dy = world.y - drag.lastWorld.y
      const obj = store.objects.find((o) => o.id === drag.objectId)
      if (obj) {
        const cos = Math.cos(-obj.transform.rotation)
        const sin = Math.sin(-obj.transform.rotation)
        const localDx = (dx * cos - dy * sin) / obj.transform.scaleX
        const localDy = (dx * sin + dy * cos) / obj.transform.scaleY
        store.moveVertices(drag.objectId, drag.indices, localDx, localDy)
      }
      dragRef.current = { ...drag, lastWorld: world }
      return
    }

    if (drag.kind === 'scale-object') {
      const obj = store.objects.find((o) => o.id === drag.objectId)
      if (!obj) return
      const local = inverseTransform(world, { ...drag.startTransform, scaleX: 1, scaleY: 1 })
      const pivot = drag.startTransform.pivot
      const relX = local.x - pivot.x
      const relY = local.y - pivot.y
      const mc = drag.meshCornerRel
      const newScaleX = mc.x !== 0 ? relX / mc.x : drag.startTransform.scaleX
      const newScaleY = mc.y !== 0 ? relY / mc.y : drag.startTransform.scaleY
      store.setTransform(drag.objectId, {
        scaleX: Math.abs(newScaleX) < 0.01 ? 0.01 * Math.sign(newScaleX || 1) : newScaleX,
        scaleY: Math.abs(newScaleY) < 0.01 ? 0.01 * Math.sign(newScaleY || 1) : newScaleY,
      })
      return
    }

    if (drag.kind === 'rotate-object') {
      const currentAngle = Math.atan2(world.y - drag.center.y, world.x - drag.center.x)
      const delta = currentAngle - drag.startAngle
      let rotation = drag.startRotation + delta
      if (e.ctrlKey) {
        const step = (5 * Math.PI) / 180
        rotation = Math.round(rotation / step) * step
      }
      store.setTransform(drag.objectId, { rotation })
      return
    }

    if (drag.kind === 'move-pivot') {
      const obj = store.objects.find((o) => o.id === drag.objectId)
      if (!obj) return
      const localUnderMouse = inverseTransform(world, obj.transform)
      store.setPivot(drag.objectId, localUnderMouse)
      return
    }

    if (drag.kind === 'box-select') {
      dragRef.current = { ...drag, endClientX: e.clientX, endClientY: e.clientY }
      updateSelectionBoxOverlay(dragRef.current as typeof drag)
      return
    }
  }

  function updateSelectionBoxOverlay(drag: Extract<DragMode, { kind: 'box-select' }>) {
    const box = selectionBoxRef.current
    if (!box) return
    const x1 = Math.min(drag.startClientX, drag.endClientX)
    const y1 = Math.min(drag.startClientY, drag.endClientY)
    const x2 = Math.max(drag.startClientX, drag.endClientX)
    const y2 = Math.max(drag.startClientY, drag.endClientY)
    const containerRect = containerRef.current!.getBoundingClientRect()
    box.style.display = 'block'
    box.style.left = `${x1 - containerRect.left}px`
    box.style.top = `${y1 - containerRect.top}px`
    box.style.width = `${x2 - x1}px`
    box.style.height = `${y2 - y1}px`
  }

  function handlePointerUp(_e: PointerEvent) {
    const drag = dragRef.current
    if (drag.kind === 'box-select') {
      const box = selectionBoxRef.current
      if (box) box.style.display = 'none'

      const movedPx = Math.hypot(drag.endClientX - drag.startClientX, drag.endClientY - drag.startClientY)
      if (movedPx > 4) {
        const store = useSceneStore.getState()
        const obj = store.objects.find((o) => o.id === drag.objectId)
        if (obj) {
          const rect = containerRef.current!.getBoundingClientRect()
          const wa = screenToWorld(drag.startClientX, drag.startClientY, rect, viewRef.current)
          const wb = screenToWorld(drag.endClientX, drag.endClientY, rect, viewRef.current)
          const minX = Math.min(wa.x, wb.x)
          const maxX = Math.max(wa.x, wb.x)
          const minY = Math.min(wa.y, wb.y)
          const maxY = Math.max(wa.y, wb.y)
          const inside = (p: { x: number; y: number }) =>
            p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY

          if (store.editElementType === 'vertex') {
            const next = drag.additive ? new Set(store.selectedVertices) : new Set<number>()
            obj.mesh.vertices.forEach((v, i) => {
              if (inside(applyTransform(v, obj.transform))) next.add(i)
            })
            store.setSelectedVertices(next)
          } else if (store.editElementType === 'edge') {
            const next = drag.additive ? new Set(store.selectedEdges) : new Set<string>()
            for (const [a, b] of getEdges(obj.mesh)) {
              const pa = applyTransform(obj.mesh.vertices[a], obj.transform)
              const pb = applyTransform(obj.mesh.vertices[b], obj.transform)
              if (inside(pa) && inside(pb)) next.add(edgeKey(a, b))
            }
            store.setSelectedEdges(next)
          } else {
            const next = drag.additive ? new Set(store.selectedFaces) : new Set<number>()
            obj.mesh.faces.forEach((face, fi) => {
              if (face.every((i) => inside(applyTransform(obj.mesh.vertices[i], obj.transform)))) {
                next.add(fi)
              }
            })
            store.setSelectedFaces(next)
          }
        }
      }
    }

    if (drag.kind === 'move-vertices') {
      const store = useSceneStore.getState()
      if (store.editElementType === 'vertex') {
        const obj = store.objects.find((o) => o.id === drag.objectId)
        if (obj) {
          // snap-merge: dragging a vertex onto a topologically adjacent one welds them.
          // Vertices that aren't connected by an edge are intentionally never considered,
          // however close they end up — this is a weld, not a generic "merge by distance".
          const movedSet = new Set(drag.indices)
          let best: { keep: number; merge: number } | null = null
          let bestDist = Infinity
          for (const [a, b] of getEdges(obj.mesh)) {
            const aMoved = movedSet.has(a)
            const bMoved = movedSet.has(b)
            if (aMoved === bMoved) continue // skip if both or neither moved
            const pa = applyTransform(obj.mesh.vertices[a], obj.transform)
            const pb = applyTransform(obj.mesh.vertices[b], obj.transform)
            const d = pxDistSq(pa.x, pa.y, pb.x, pb.y)
            if (d < bestDist) {
              bestDist = d
              best = aMoved ? { keep: b, merge: a } : { keep: a, merge: b }
            }
          }
          const SNAP_MERGE_RADIUS_PX = 5
          if (best && bestDist < SNAP_MERGE_RADIUS_PX ** 2) {
            store.mergeVertexPair(drag.objectId, best.keep, best.merge)
          }
        }
      }
    }

    dragRef.current = { kind: 'none' }
  }

  return (
    <div ref={containerRef} className="viewport">
      <div ref={selectionBoxRef} className="selection-box" style={{ display: 'none' }} />
    </div>
  )
}
