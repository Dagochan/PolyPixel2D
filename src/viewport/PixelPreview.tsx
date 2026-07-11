import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import * as THREE from 'three'
import { useSceneStore } from '../scene/store'
import { triangulateWithFaceIds } from '../scene/meshUtils'
import { getWorldTransform, worldBounds } from '../scene/transformUtils'
import { computeSplitUVIslands } from '../scene/uv'
import { quantizeImageData } from '../scene/quantize'
import { applyPixelOutline } from '../scene/outline'
import { resolveInsertSlots } from '../scene/insertSlots'
import { collectFakeBehindMaskIds, getFakeBehind, MAX_FAKE_BEHIND_MASKS } from '../scene/fakeBehind'
import { boundsVertices } from '../scene/pathCurve'
import { composeDisplayObjects } from '../scene/composeDisplay'
import NumberInput from '../panels/NumberInput'
import type { Mesh, SceneObject, Vec2 } from '../scene/types'

/** Renders the scene's fill geometry only (no grid, wireframe, gizmos, or edit overlays) into a
 *  small WebGL canvas at the target dot-art resolution, auto-framed to fit all visible objects.
 *  The canvas itself is kept at that low pixel resolution and stretched via CSS with
 *  `image-rendering: pixelated`, so the browser's own upscaling gives the crisp nearest-neighbor
 *  look — no render-target readback or second draw pass needed. */
export default function PixelPreview() {
  const displayCanvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const cameraRef = useRef<THREE.OrthographicCamera | null>(null)
  const sceneRef = useRef(new THREE.Scene())
  const resolution = useSceneStore((s) => s.pixelPreviewResolution)
  const setResolution = useSceneStore((s) => s.setPixelPreviewResolution)
  const setEnabled = useSceneStore((s) => s.setPixelPreviewEnabled)
  const textureCacheRef = useRef(new Map<string, THREE.Texture>())
  const textureLoaderRef = useRef(new THREE.TextureLoader())
  const offset = useSceneStore((s) => s.pixelPreviewOffset)
  const setOffset = useSceneStore((s) => s.setPixelPreviewOffset)
  const dragRef = useRef<{ startX: number; startY: number; startOffsetX: number; startOffsetY: number } | null>(null)
  const paletteEnabled = useSceneStore((s) => s.pixelPreviewPaletteEnabled)
  const setPaletteEnabled = useSceneStore((s) => s.setPixelPreviewPaletteEnabled)
  const paletteSize = useSceneStore((s) => s.pixelPreviewPaletteSize)
  const setPaletteSize = useSceneStore((s) => s.setPixelPreviewPaletteSize)
  const outlineEnabled = useSceneStore((s) => s.pixelPreviewOutlineEnabled)
  const setOutlineEnabled = useSceneStore((s) => s.setPixelPreviewOutlineEnabled)
  const outlineColor = useSceneStore((s) => s.pixelPreviewOutlineColor)
  const setOutlineColor = useSceneStore((s) => s.setPixelPreviewOutlineColor)
  const outlineThickness = useSceneStore((s) => s.pixelPreviewOutlineThickness)
  const setOutlineThickness = useSceneStore((s) => s.setPixelPreviewOutlineThickness)
  const [sheetRows, setSheetRows] = useState(4)
  const [sheetColumns, setSheetColumns] = useState(4)
  const [exporting, setExporting] = useState(false)

  const handleHeaderPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = { startX: e.clientX, startY: e.clientY, startOffsetX: offset.x, startOffsetY: offset.y }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const handleHeaderPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d) return
    setOffset({ x: d.startOffsetX + (e.clientX - d.startX), y: d.startOffsetY + (e.clientY - d.startY) })
  }
  const handleHeaderPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
  }

  useEffect(() => {
    const displayCanvas = displayCanvasRef.current!
    const displayCtx = displayCanvas.getContext('2d')!
    // the WebGL canvas itself is never attached to the DOM — it's only an offscreen source that
    // gets drawn (and optionally palette-quantized) onto the visible 2D canvas each frame, since
    // quantization needs pixel readback that a displayed WebGL canvas doesn't offer directly
    const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, preserveDrawingBuffer: true, stencil: true })
    renderer.setPixelRatio(1)
    rendererRef.current = renderer

    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000)
    camera.position.z = 100
    cameraRef.current = camera

    let raf = 0
    const tick = () => {
      const { objects: rawObjects, pixelFrame, editingShapeKeyId, clips, activeClipId, playheadTime, previewFakeFlag } =
        useSceneStore.getState()
      const res = useSceneStore.getState().pixelPreviewResolution

      // Same deform composition Viewport.tsx's render loop applies (shape keys, Fake Flag, Fake
      // Physics mesh, Path Deform, FFD) — see `composeDisplayObjects`'s doc for why this needs to
      // be the exact same call, not a separate copy. No live-drag Fake Physics preview state here
      // (no interactive dragging happens in this read-only panel), so the default clip-sampled
      // branch is always used regardless of the main viewport's `previewFakePhysicsMesh` toggle.
      const activeClip = clips.find((c) => c.id === activeClipId)
      const fakeFlagTime = previewFakeFlag ? performance.now() / 1000 : playheadTime
      const objects = composeDisplayObjects(rawObjects, {
        editingShapeKeyId,
        fakeFlagTime,
        fakeFlagLoopDuration: activeClip?.duration ?? 0,
        activeClip,
        playheadTime,
      })

      // Pixel Frame set: frame exactly that fixed world-space rect, so the pixel-art scale stays
      // stable regardless of how objects move/deform (e.g. Fake Physics) — no re-fitting, no
      // margin (the frame's own size already includes whatever margin the user wants).
      // No frame: fall back to the old auto-fit, framing the bounding box of every visible,
      // non-empty object's world-space mesh fresh every frame.
      let w: number
      let h: number
      let cx: number
      let cy: number
      let margin: number
      if (pixelFrame) {
        w = pixelFrame.width
        h = pixelFrame.height
        cx = pixelFrame.x
        cy = pixelFrame.y
        margin = 1
      } else {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const obj of objects) {
          if (!obj.visible || obj.kind === 'empty' || obj.mesh.vertices.length === 0) continue
          const t = getWorldTransform(obj, objects)
          const b = worldBounds(boundsVertices(obj), t)
          if (b.minX < minX) minX = b.minX
          if (b.minY < minY) minY = b.minY
          if (b.maxX > maxX) maxX = b.maxX
          if (b.maxY > maxY) maxY = b.maxY
        }
        const hasContent = minX <= maxX
        w = hasContent ? maxX - minX : 1
        h = hasContent ? maxY - minY : 1
        cx = hasContent ? (minX + maxX) / 2 : 0
        cy = hasContent ? (minY + maxY) / 2 : 0
        // 10% margin around the content so silhouettes don't touch the frame edge
        margin = 1.1
      }
      const canvasW = w >= h ? res : Math.max(1, Math.round((res * w) / h))
      const canvasH = h > w ? res : Math.max(1, Math.round((res * h) / w))

      // the frustum's aspect ratio must match the canvas's, or the content gets stretched to
      // fit a differently-shaped viewport — so each axis gets its own span (content size +
      // margin) rather than both sharing one square span sized off the longer edge
      camera.left = cx - (w * margin) / 2
      camera.right = cx + (w * margin) / 2
      camera.top = cy + (h * margin) / 2
      camera.bottom = cy - (h * margin) / 2
      camera.updateProjectionMatrix()

      renderer.setSize(canvasW, canvasH, false)
      // display scale is fixed (independent of `res`) so the on-screen panel size doesn't
      // jump around as the user tweaks the resolution input — only the crispness changes
      const DISPLAY_MAX = 256
      const displayScale = DISPLAY_MAX / Math.max(canvasW, canvasH)
      displayCanvas.style.width = `${canvasW * displayScale}px`
      displayCanvas.style.height = `${canvasH * displayScale}px`

      rebuildScene(sceneRef.current, objects, textureCacheRef.current, textureLoaderRef.current)
      renderer.render(sceneRef.current, camera)

      if (displayCanvas.width !== canvasW) displayCanvas.width = canvasW
      if (displayCanvas.height !== canvasH) displayCanvas.height = canvasH
      displayCtx.clearRect(0, 0, canvasW, canvasH)
      displayCtx.drawImage(renderer.domElement, 0, 0)

      const {
        pixelPreviewPaletteEnabled,
        pixelPreviewPaletteSize,
        pixelPreviewOutlineEnabled,
        pixelPreviewOutlineColor,
        pixelPreviewOutlineThickness,
      } = useSceneStore.getState()
      if (pixelPreviewPaletteEnabled || pixelPreviewOutlineEnabled) {
        const imageData = displayCtx.getImageData(0, 0, canvasW, canvasH)
        if (pixelPreviewPaletteEnabled) quantizeImageData(imageData.data, pixelPreviewPaletteSize)
        // outline runs *after* quantization so its color stays exact rather than being pulled
        // into the quantized palette (see `applyPixelOutline`'s doc)
        if (pixelPreviewOutlineEnabled) {
          applyPixelOutline(imageData.data, canvasW, canvasH, pixelPreviewOutlineColor, pixelPreviewOutlineThickness)
        }
        displayCtx.putImageData(imageData, 0, 0)
      }

      raf = requestAnimationFrame(tick)
    }
    tick()

    return () => {
      cancelAnimationFrame(raf)
      disposeSceneContents(sceneRef.current)
      sceneRef.current.clear()
      renderer.dispose()
      for (const tex of textureCacheRef.current.values()) tex.dispose()
      textureCacheRef.current.clear()
      cameraRef.current = null
    }
  }, [])

  const handleExportSpriteSheet = () => {
    const renderer = rendererRef.current
    const camera = cameraRef.current
    if (!renderer || !camera) return
    const { pixelFrame, clips, activeClipId } = useSceneStore.getState()
    if (!pixelFrame) {
      alert('Sprite sheet export requires a Pixel Frame — set one first so every frame shares the same fixed size.')
      return
    }
    const rows = Math.max(1, Math.round(sheetRows))
    const columns = Math.max(1, Math.round(sheetColumns))
    const frameCount = rows * columns
    const activeClip = clips.find((c) => c.id === activeClipId)
    const duration = activeClip?.duration ?? 0
    const loopMode = activeClip?.loopMode ?? 'none'
    const originalPlayheadTime = useSceneStore.getState().playheadTime
    const setPlayhead = useSceneStore.getState().setPlayhead

    setExporting(true)
    try {
      const res = useSceneStore.getState().pixelPreviewResolution
      const { width: w, height: h, x: cx, y: cy } = pixelFrame
      const canvasW = w >= h ? res : Math.max(1, Math.round((res * w) / h))
      const canvasH = h > w ? res : Math.max(1, Math.round((res * h) / w))
      const margin = 1

      camera.left = cx - (w * margin) / 2
      camera.right = cx + (w * margin) / 2
      camera.top = cy + (h * margin) / 2
      camera.bottom = cy - (h * margin) / 2
      camera.updateProjectionMatrix()
      renderer.setSize(canvasW, canvasH, false)

      const sheet = document.createElement('canvas')
      sheet.width = canvasW * columns
      sheet.height = canvasH * rows
      const sctx = sheet.getContext('2d')!

      const {
        pixelPreviewPaletteEnabled,
        pixelPreviewPaletteSize,
        pixelPreviewOutlineEnabled,
        pixelPreviewOutlineColor,
        pixelPreviewOutlineThickness,
      } = useSceneStore.getState()
      const tmp = document.createElement('canvas')
      tmp.width = canvasW
      tmp.height = canvasH
      const tctx = tmp.getContext('2d')!

      for (let i = 0; i < frameCount; i++) {
        // 'loop'/'pingpong' sample the full cycle *excluding* its endpoint (i/frameCount), so the
        // sheet tiles seamlessly instead of repeating the same pose in two different cells; a
        // pingpong's cycle is twice the duration (out and back) — `setPlayhead`'s own
        // `resolvePlaybackTime` folds a time past `duration` back down via the reflection, so
        // passing it a raw time up to 2*duration is enough, no separate reflection math needed here.
        // 'none' has no cycle to avoid repeating, so it samples *inclusive* of both ends
        // (i/(frameCount-1)) to actually capture the authored final pose instead of stopping short.
        let t: number
        if (duration <= 0) t = 0
        else if (loopMode === 'none') t = frameCount > 1 ? (i / (frameCount - 1)) * duration : 0
        else t = (i / frameCount) * (loopMode === 'pingpong' ? duration * 2 : duration)
        // resample every keyframed Transform/shape-key weight/pathOffset/followPath progress onto
        // `objects` for this frame's time — the same mechanism the Timeline scrubber uses (see
        // `setPlayhead`'s doc). `composeDisplayObjects`'s own `playheadTime`/`fakeFlagTime` params
        // only cover Fake Physics/Fake Flag, not the base per-object Transform, so without this every
        // exported frame was identical (whatever pose the playhead happened to be at when exporting).
        setPlayhead(t)
        const { objects: rawObjects, editingShapeKeyId } = useSceneStore.getState()
        const objects = composeDisplayObjects(rawObjects, {
          editingShapeKeyId,
          fakeFlagTime: t,
          fakeFlagLoopDuration: duration,
          activeClip,
          playheadTime: t,
        })
        rebuildScene(sceneRef.current, objects, textureCacheRef.current, textureLoaderRef.current)
        renderer.render(sceneRef.current, camera)

        tctx.clearRect(0, 0, canvasW, canvasH)
        tctx.drawImage(renderer.domElement, 0, 0)
        if (pixelPreviewPaletteEnabled || pixelPreviewOutlineEnabled) {
          const imageData = tctx.getImageData(0, 0, canvasW, canvasH)
          if (pixelPreviewPaletteEnabled) quantizeImageData(imageData.data, pixelPreviewPaletteSize)
          if (pixelPreviewOutlineEnabled) {
            applyPixelOutline(imageData.data, canvasW, canvasH, pixelPreviewOutlineColor, pixelPreviewOutlineThickness)
          }
          tctx.putImageData(imageData, 0, 0)
        }

        const col = i % columns
        const row = Math.floor(i / columns)
        sctx.drawImage(tmp, col * canvasW, row * canvasH)
      }

      const url = sheet.toDataURL('image/png')
      const link = document.createElement('a')
      link.href = url
      link.download = `${activeClip?.name ?? 'spritesheet'}_${columns}x${rows}.png`
      link.click()
    } finally {
      setPlayhead(originalPlayheadTime)
      setExporting(false)
    }
  }

  return (
    <div className="pixel-preview" style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}>
      <div
        className="pixel-preview-header"
        onPointerDown={handleHeaderPointerDown}
        onPointerMove={handleHeaderPointerMove}
        onPointerUp={handleHeaderPointerUp}
      >
        <span>Pixel preview</span>
        <label onPointerDown={(e) => e.stopPropagation()}>
          Resolution
          <NumberInput min={16} max={1024} step={8} value={resolution} onCommit={(v) => setResolution(Math.round(v))} />
        </label>
        <button
          className="icon-btn"
          title="Close"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setEnabled(false)}
        >
          ✕
        </button>
      </div>
      <div className="pixel-preview-controls">
        <label>
          <input
            type="checkbox"
            checked={paletteEnabled}
            onChange={(e) => setPaletteEnabled(e.target.checked)}
          />
          Palette quantization
        </label>
        <label>
          Colors
          <NumberInput min={2} max={64} value={paletteSize} disabled={!paletteEnabled} onCommit={(v) => setPaletteSize(Math.round(v))} />
        </label>
      </div>
      <div className="pixel-preview-controls">
        <label>
          <input
            type="checkbox"
            checked={outlineEnabled}
            onChange={(e) => setOutlineEnabled(e.target.checked)}
          />
          Outline
        </label>
        <label>
          Color
          <input
            type="color"
            value={outlineColor}
            disabled={!outlineEnabled}
            onChange={(e) => setOutlineColor(e.target.value)}
          />
        </label>
        <label>
          Thickness
          <NumberInput min={1} max={16} value={outlineThickness} disabled={!outlineEnabled} onCommit={(v) => setOutlineThickness(Math.round(v))} />
        </label>
      </div>
      <div className="pixel-preview-canvas">
        <canvas ref={displayCanvasRef} />
      </div>
      <div className="pixel-preview-controls">
        <label>
          Columns
          <NumberInput min={1} max={32} value={sheetColumns} onCommit={(v) => setSheetColumns(Math.round(v))} />
        </label>
        <label>
          Rows
          <NumberInput min={1} max={32} value={sheetRows} onCommit={(v) => setSheetRows(Math.round(v))} />
        </label>
        <button onClick={handleExportSpriteSheet} disabled={exporting}>
          {exporting ? 'Exporting…' : 'Export sprite sheet'}
        </button>
      </div>
    </div>
  )
}

function disposeSceneContents(scene: THREE.Scene) {
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    mesh.geometry?.dispose()
    const material = mesh.material
    if (Array.isArray(material)) material.forEach((m) => m.dispose())
    else material?.dispose()
  })
}

function buildFillMaterial(
  obj: SceneObject,
  textureCache: Map<string, THREE.Texture>,
  textureLoader: THREE.TextureLoader,
  maskBits: Map<string, number>,
): THREE.MeshBasicMaterial {
  let texture: THREE.Texture | undefined
  if (obj.material.textureUrl) {
    texture = textureCache.get(obj.material.textureUrl)
    if (!texture) {
      texture = textureLoader.load(obj.material.textureUrl)
      texture.colorSpace = THREE.SRGBColorSpace
      // sample texels as hard blocks rather than blending — matches the canvas's own
      // nearest-neighbor upscale, so the dot-art look applies to fill color too, not just silhouette
      texture.magFilter = THREE.NearestFilter
      texture.minFilter = THREE.NearestFilter
      textureCache.set(obj.material.textureUrl, texture)
    }
  }
  const material = new THREE.MeshBasicMaterial({
    // per-face color (see `Mesh.faceColors`) is carried entirely by the geometry's vertex color
    // attribute (built in `drawIsland`, resolved against `obj.material.color` as the fallback) —
    // this stays neutral white so it doesn't double-tint on top of that.
    color: 0xffffff,
    vertexColors: true,
    map: texture,
    side: THREE.DoubleSide,
    // a texture's own alpha channel (e.g. a baked/transparent PNG) must be respected, or fully
    // transparent areas render as whatever opaque RGB they happen to store underneath
    transparent: !!texture,
  })
  applyFakeBehindStencil(material, obj, maskBits)
  return material
}

/** Same stencil-buffer trick as `Viewport.tsx`'s function of the same name — see its doc for the
 *  full mechanics. No selection concept here (this is a read-only preview render, not an editing
 *  viewport), so unlike `Viewport.tsx` a mask is *always* fully invisible (no translucent guide),
 *  just like every other deform this preview doesn't visualize. */
function applyFakeBehindStencil(mat: THREE.MeshBasicMaterial, obj: SceneObject, maskBits: Map<string, number>) {
  const ownBit = maskBits.get(obj.id)
  if (ownBit != null) {
    const bit = ownBit
    mat.colorWrite = false
    mat.depthWrite = false
    mat.depthTest = false
    mat.stencilWrite = true
    mat.stencilRef = bit
    mat.stencilFunc = THREE.AlwaysStencilFunc
    mat.stencilZPass = THREE.ReplaceStencilOp
    mat.stencilFail = THREE.KeepStencilOp
    mat.stencilZFail = THREE.KeepStencilOp
    mat.stencilFuncMask = 0xff
    mat.stencilWriteMask = bit
    return
  }
  const settings = getFakeBehind(obj)
  if (!settings?.enabled || settings.maskObjectIds.length === 0) return
  let bits = 0
  for (const maskId of settings.maskObjectIds) bits |= maskBits.get(maskId) ?? 0
  if (bits === 0) return
  mat.stencilWrite = true
  mat.stencilRef = 0
  mat.stencilFunc = THREE.EqualStencilFunc
  mat.stencilFuncMask = bits
  mat.stencilWriteMask = 0
  mat.stencilZPass = THREE.KeepStencilOp
  mat.stencilFail = THREE.KeepStencilOp
  mat.stencilZFail = THREE.KeepStencilOp
}

function drawIsland(
  scene: THREE.Scene,
  obj: SceneObject,
  objects: SceneObject[],
  perIsland: { mesh: Mesh; uvs: Vec2[]; colors: string[] }[],
  material: THREE.MeshBasicMaterial,
  islandIdx: number,
  z: number,
  maskBits: Map<string, number>,
) {
  const worldTransform = getWorldTransform(obj, objects)
  const pivot = worldTransform.head
  const { mesh: islandMesh, uvs: islandUvs, colors: islandColors } = perIsland[islandIdx]
  // see `Viewport.tsx`'s `buildIslandMesh` doc — non-indexed so a face's color never bleeds into
  // an adjacent, differently-colored face across a shared vertex.
  const { indices, faceIndexPerTriangle } = triangulateWithFaceIds(islandMesh)
  const positions: number[] = []
  const uvsFlat: number[] = []
  const colorsFlat: number[] = []
  const colorScratch = new THREE.Color()
  for (let t = 0; t < faceIndexPerTriangle.length; t++) {
    colorScratch.set(islandColors[faceIndexPerTriangle[t]] ?? '#ffffff')
    for (let c = 0; c < 3; c++) {
      const vi = indices[t * 3 + c]
      const v = islandMesh.vertices[vi]
      positions.push(v.x - pivot.x, v.y - pivot.y, 0)
      const uv = islandUvs[vi]
      uvsFlat.push(uv.x, uv.y)
      colorsFlat.push(colorScratch.r, colorScratch.g, colorScratch.b)
    }
  }
  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvsFlat, 2))
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colorsFlat, 3))
  const mesh = new THREE.Mesh(geom, material)
  // see `Viewport.tsx`'s `buildIslandMesh` doc — a FakeBehind mask must stencil-write before any
  // target reads it, independent of normal zOrder
  if (maskBits.has(obj.id)) mesh.renderOrder = -100000
  mesh.position.set(worldTransform.x, worldTransform.y, z)
  mesh.rotation.z = worldTransform.rotation
  mesh.scale.set(worldTransform.scaleX, worldTransform.scaleY, 1)
  scene.add(mesh)
}

/** Draws every visible island of `obj` (in its own Z-order), spaced `microStep` apart starting
 *  at `baseZ` — used both for a plain top-level object and for an object nested into a host's
 *  insert slot (with a finer `microStep` so it stays within the slot's single position). */
function drawAllIslands(
  scene: THREE.Scene,
  obj: SceneObject,
  objects: SceneObject[],
  baseZ: number,
  microStep: number,
  textureCache: Map<string, THREE.Texture>,
  textureLoader: THREE.TextureLoader,
  maskBits: Map<string, number>,
) {
  const perIsland = computeSplitUVIslands(
    obj.mesh,
    obj.uvIslandTransforms,
    obj.uvBaseVertices,
    obj.mesh.faceColors,
    obj.material.color,
  )
  const material = buildFillMaterial(obj, textureCache, textureLoader, maskBits)
  const islandOrder = perIsland
    .map((_, i) => i)
    .sort((a, b) => (obj.islandZOrders?.[a] ?? a) - (obj.islandZOrders?.[b] ?? b))
  islandOrder.forEach((islandIdx, i) => {
    if (obj.islandVisible?.[islandIdx] === false) return
    drawIsland(scene, obj, objects, perIsland, material, islandIdx, baseZ + i * microStep, maskBits)
  })
}

function rebuildScene(
  scene: THREE.Scene,
  objects: ReturnType<typeof useSceneStore.getState>['objects'],
  textureCache: Map<string, THREE.Texture>,
  textureLoader: THREE.TextureLoader,
) {
  disposeSceneContents(scene)
  scene.clear()

  // see `Viewport.tsx`'s identical setup in `rebuildScene` for the full doc on this bit
  // assignment scheme
  const referencedMaskIds = collectFakeBehindMaskIds(objects)
  const maskBits = new Map<string, number>()
  let maskCount = 0
  for (const o of objects) {
    if (referencedMaskIds.has(o.id) && maskCount < MAX_FAKE_BEHIND_MASKS) {
      maskBits.set(o.id, 1 << maskCount)
      maskCount++
    }
  }

  const { insertsByHost, consumedIds } = resolveInsertSlots(objects)
  const sorted = [...objects].filter((o) => !consumedIds.has(o.id)).sort((a, b) => a.zOrder - b.zOrder)

  sorted.forEach((obj, depthIndex) => {
    if (!obj.visible || obj.kind === 'empty') return
    const inserts = insertsByHost.get(obj.id) ?? []
    if (inserts.length === 0) {
      drawAllIslands(scene, obj, objects, depthIndex, 0.001, textureCache, textureLoader, maskBits)
      return
    }

    // this host has at least one filled insert slot — islands and inserted objects must be
    // interleaved by rank so an insert sandwiched between two islands actually renders between them
    const perIsland = computeSplitUVIslands(
      obj.mesh,
      obj.uvIslandTransforms,
      obj.uvBaseVertices,
      obj.mesh.faceColors,
      obj.material.color,
    )
    const material = buildFillMaterial(obj, textureCache, textureLoader, maskBits)
    type Entry =
      | { kind: 'island'; islandIdx: number; rank: number }
      | { kind: 'insert'; object: SceneObject; rank: number }
    const entries: Entry[] = [
      ...perIsland.map((_, i) => ({ kind: 'island' as const, islandIdx: i, rank: obj.islandZOrders?.[i] ?? i })),
      ...inserts.map((ins) => ({ kind: 'insert' as const, object: ins.object, rank: ins.rank })),
    ]
    entries.sort((a, b) => a.rank - b.rank)
    entries.forEach((entry, i) => {
      const z = depthIndex + i * 0.001
      if (entry.kind === 'island') {
        if (obj.islandVisible?.[entry.islandIdx] === false) return
        drawIsland(scene, obj, objects, perIsland, material, entry.islandIdx, z, maskBits)
      } else if (entry.object.visible) {
        drawAllIslands(scene, entry.object, objects, z, 0.0001, textureCache, textureLoader, maskBits)
      }
    })
  })
}
