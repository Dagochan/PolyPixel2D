import { useEffect, useRef, useState } from 'react'
import { useSceneStore } from '../scene/store'
import {
  findIslands,
  islandBaseUV,
  islandBaseCenter,
  islandFootprint,
  applyIslandTransform,
  defaultIslandTransforms,
  normalizeIslandTransform,
} from '../scene/uv'
import type { SceneObject, Vec2 } from '../scene/types'

const ISLAND_COLORS = ['#7aa2f7', '#f7768e', '#9ece6a', '#e0af68', '#bb9af7', '#7dcfff']
const HANDLE_SIZE_PX = 8
const ROTATE_HANDLE_DIST_PX = 18
const LOCK_ICON_SIZE_PX = 24

function svgImage(svg: string): HTMLImageElement {
  const img = new Image()
  img.src = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
  return img
}

// "included in density match" (Texel Standardize) vs "excluded, kept independent" (Texel Single)
const MATCHED_ICON = svgImage(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M16,2L22,2L22,8L21,8L21,3L16,3L16,2ZM8,22L2,22L2,16L3,16L3,21L8,21L8,22Z" fill="#dddddd"/><path d="M6,15L15,15L15,6L16,6L16,16L6,16L6,15Z" fill="#dddddd"/><g transform="matrix(1,0,0,1,2,2)"><path d="M6,15L15,15L15,6L16,6L16,16L6,16L6,15Z" fill="#dddddd"/></g><g transform="matrix(1,0,0,1,4,4)"><path d="M6,15L15,15L15,6L16,6L16,16L6,16L6,15Z" fill="#dddddd"/></g><g transform="matrix(1.111111,0,0,1.111111,-1.555556,-1.555556)"><path d="M5,6.8L5,5L6.8,5L6.8,6.8L5,6.8ZM8.6,5L14,5L14,14L5,14L5,8.6L6.8,8.6L6.8,10.4L8.6,10.4L8.6,8.6L10.4,8.6L10.4,6.8L8.6,6.8L8.6,5ZM8.6,6.8L8.6,8.6L6.8,8.6L6.8,6.8L8.6,6.8Z" fill="#dddddd"/></g></svg>',
)
const EXCLUDED_ICON = svgImage(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M16,2L22,2L22,8L21,8L21,3L16,3L16,2ZM8,22L2,22L2,16L3,16L3,21L8,21L8,22Z" fill="#f7a35c"/><g transform="matrix(1.111111,0,0,1.111111,1.444444,1.444444)"><path d="M5,6.8L5,5L6.8,5L6.8,6.8L5,6.8ZM8.6,5L14,5L14,14L5,14L5,8.6L6.8,8.6L6.8,10.4L8.6,10.4L8.6,8.6L10.4,8.6L10.4,6.8L8.6,6.8L8.6,5ZM8.6,6.8L8.6,8.6L6.8,8.6L6.8,6.8L8.6,6.8Z" fill="#f7a35c"/></g></svg>',
)

type DragState =
  | {
      mode: 'move'
      islandIndex: number
      startOffsetX: number
      startOffsetY: number
      startMouseUv: Vec2
    }
  | {
      mode: 'scale'
      islandIndex: number
      startOffsetX: number
      startOffsetY: number
      startScale: number
      startMouseUv: Vec2
      anchor: Vec2 // fixed corner (opposite the dragged handle), in transformed UV space
    }
  | {
      mode: 'rotate'
      islandIndex: number
      startRotation: number
      center: Vec2 // transformed center, fixed for the drag's duration
      startAngle: number
    }

export default function UvEditor({
  obj,
  size = 220,
  matchTexelDensity = false,
  textureUrl,
  textureOpacity = 0.5,
}: {
  obj: SceneObject
  size?: number
  /** When scaling one island, scale every other island too, keeping each one's scale
   *  proportional to its real-world size — so texel density stays consistent across islands. */
  matchTexelDensity?: boolean
  /** The object's texture (if any), drawn full-bleed behind the islands so they can be lined up against it. */
  textureUrl?: string
  textureOpacity?: number
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const [redrawTick, forceRedraw] = useState(0)
  const textureImageRef = useRef<HTMLImageElement | null>(null)

  useEffect(() => {
    const onLoad = () => forceRedraw((n) => n + 1)
    MATCHED_ICON.addEventListener('load', onLoad)
    EXCLUDED_ICON.addEventListener('load', onLoad)
    return () => {
      MATCHED_ICON.removeEventListener('load', onLoad)
      EXCLUDED_ICON.removeEventListener('load', onLoad)
    }
  }, [])

  useEffect(() => {
    if (!textureUrl) {
      textureImageRef.current = null
      forceRedraw((n) => n + 1)
      return
    }
    const img = new Image()
    img.onload = () => forceRedraw((n) => n + 1)
    img.src = textureUrl
    textureImageRef.current = img
  }, [textureUrl])
  const setUvIslandTransform = useSceneStore((s) => s.setUvIslandTransform)
  const beginChange = useSceneStore((s) => s.beginChange)

  const seams = obj.seamEdges ? new Set(obj.seamEdges) : undefined
  const islands = findIslands(obj.mesh, seams)
  const defaults = defaultIslandTransforms(obj.mesh, islands, obj.uvBaseVertices)
  const transforms = islands.map((_, i) => normalizeIslandTransform(obj.uvIslandTransforms?.[i], defaults[i]))
  const bases = islands.map((island) => islandBaseUV(obj.mesh, island, obj.uvBaseVertices))
  const baseCenters = bases.map((base) => islandBaseCenter(base.values()))
  const footprints = islands.map((island) => islandFootprint(obj.mesh, island, obj.uvBaseVertices))
  const handleHitUv = HANDLE_SIZE_PX / size
  const lockHitUv = LOCK_ICON_SIZE_PX / size
  const rotateHandleDistUv = ROTATE_HANDLE_DIST_PX / size

  function transformedCenter(i: number): Vec2 {
    return applyIslandTransform(baseCenters[i], baseCenters[i], transforms[i])
  }

  function rotateHandlePos(i: number): Vec2 {
    const center = transformedCenter(i)
    const r = transforms[i].rotation
    return {
      x: center.x - Math.sin(r) * rotateHandleDistUv,
      y: center.y + Math.cos(r) * rotateHandleDistUv,
    }
  }

  function transformedBBox(i: number) {
    return bboxOf(Array.from(bases[i].values(), (uv) => applyIslandTransform(uv, baseCenters[i], transforms[i])))
  }

  /** Bottom-left corner of the island's bbox — where the density-match lock toggle lives. */
  function lockHandlePos(i: number): Vec2 {
    const b = transformedBBox(i)
    return { x: b.minX, y: b.minY }
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, size, size)
    ctx.fillStyle = '#1e1f22'
    ctx.fillRect(0, 0, size, size)

    const texImg = textureImageRef.current
    if (texImg && texImg.complete && texImg.naturalWidth > 0) {
      ctx.save()
      ctx.globalAlpha = textureOpacity
      ctx.drawImage(texImg, 0, 0, size, size)
      ctx.restore()
    }

    ctx.strokeStyle = '#555'
    ctx.strokeRect(0.5, 0.5, size - 1, size - 1)

    const toCanvasPoint = (uv: Vec2) => ({ x: uv.x * size, y: (1 - uv.y) * size })

    islands.forEach((island, i) => {
      const base = bases[i]
      const center = baseCenters[i]
      const t = transforms[i]
      const color = ISLAND_COLORS[i % ISLAND_COLORS.length]

      // mesh wireframe (the actual shape)
      ctx.strokeStyle = color
      ctx.lineWidth = 1.5
      for (const fi of island.faces) {
        const face = obj.mesh.faces[fi]
        ctx.beginPath()
        face.forEach((vi, k) => {
          const p = toCanvasPoint(applyIslandTransform(base.get(vi)!, center, t))
          if (k === 0) ctx.moveTo(p.x, p.y)
          else ctx.lineTo(p.x, p.y)
        })
        ctx.closePath()
        ctx.stroke()
      }

      // dashed bbox + scale handle — always visible regardless of the island's actual shape,
      // so a round or irregular island still has an obvious place to grab to resize it
      const bbox = transformedBBox(i)
      const bl = toCanvasPoint({ x: bbox.minX, y: bbox.minY })
      const tr = toCanvasPoint({ x: bbox.maxX, y: bbox.maxY })
      ctx.save()
      ctx.strokeStyle = color
      ctx.lineWidth = 1
      ctx.setLineDash([4, 3])
      ctx.strokeRect(bl.x, tr.y, tr.x - bl.x, bl.y - tr.y)
      ctx.restore()

      ctx.fillStyle = color
      ctx.fillRect(tr.x - HANDLE_SIZE_PX / 2, tr.y - HANDLE_SIZE_PX / 2, HANDLE_SIZE_PX, HANDLE_SIZE_PX)

      // rotate handle: a small dot orbiting the island's center, fixed pixel distance away
      // regardless of the island's own scale, so it stays easy to grab even when tiny
      const centerPx = toCanvasPoint(transformedCenter(i))
      const handlePx = toCanvasPoint(rotateHandlePos(i))
      ctx.strokeStyle = color
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(centerPx.x, centerPx.y)
      ctx.lineTo(handlePx.x, handlePx.y)
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(handlePx.x, handlePx.y, HANDLE_SIZE_PX / 2, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()

      // density-match lock toggle, bottom-left corner of the bbox
      const lockPx = toCanvasPoint(lockHandlePos(i))
      const icon = t.excludeFromDensityMatch ? EXCLUDED_ICON : MATCHED_ICON
      if (icon.complete && icon.naturalWidth > 0) {
        ctx.drawImage(
          icon,
          lockPx.x - LOCK_ICON_SIZE_PX / 2,
          lockPx.y - LOCK_ICON_SIZE_PX / 2,
          LOCK_ICON_SIZE_PX,
          LOCK_ICON_SIZE_PX,
        )
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [obj.mesh, obj.uvIslandTransforms, size, redrawTick, textureOpacity])

  function uvFromEvent(e: React.PointerEvent): Vec2 {
    const rect = canvasRef.current!.getBoundingClientRect()
    return {
      x: (e.clientX - rect.left) / rect.width,
      y: 1 - (e.clientY - rect.top) / rect.height,
    }
  }

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    const uv = uvFromEvent(e)

    // density-match lock toggle — a plain click, not a drag
    for (let i = islands.length - 1; i >= 0; i--) {
      const h = lockHandlePos(i)
      if (Math.hypot(uv.x - h.x, uv.y - h.y) < lockHitUv * 0.75) {
        beginChange()
        setUvIslandTransform(obj.id, i, { excludeFromDensityMatch: !transforms[i].excludeFromDensityMatch })
        return
      }
    }

    // rotate handle (checked first since it's small and would otherwise be shadowed by move-hit-testing)
    for (let i = islands.length - 1; i >= 0; i--) {
      const h = rotateHandlePos(i)
      if (Math.hypot(uv.x - h.x, uv.y - h.y) < handleHitUv) {
        const center = transformedCenter(i)
        beginChange()
        dragRef.current = {
          mode: 'rotate',
          islandIndex: i,
          startRotation: transforms[i].rotation,
          center,
          startAngle: Math.atan2(uv.y - center.y, uv.x - center.x),
        }
        canvasRef.current!.setPointerCapture(e.pointerId)
        return
      }
    }

    // scale handle: top-right corner of each island's bbox (checked topmost-drawn first)
    for (let i = islands.length - 1; i >= 0; i--) {
      const b = transformedBBox(i)
      if (Math.hypot(uv.x - b.maxX, uv.y - b.maxY) < handleHitUv) {
        beginChange()
        dragRef.current = {
          mode: 'scale',
          islandIndex: i,
          startOffsetX: transforms[i].offsetX,
          startOffsetY: transforms[i].offsetY,
          startScale: transforms[i].scale,
          startMouseUv: uv,
          anchor: { x: b.minX, y: b.minY },
        }
        canvasRef.current!.setPointerCapture(e.pointerId)
        return
      }
    }

    // move: anywhere inside an island's bbox
    for (let i = islands.length - 1; i >= 0; i--) {
      const b = transformedBBox(i)
      if (uv.x >= b.minX && uv.x <= b.maxX && uv.y >= b.minY && uv.y <= b.maxY) {
        beginChange()
        dragRef.current = {
          mode: 'move',
          islandIndex: i,
          startOffsetX: transforms[i].offsetX,
          startOffsetY: transforms[i].offsetY,
          startMouseUv: uv,
        }
        canvasRef.current!.setPointerCapture(e.pointerId)
        return
      }
    }
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current
    if (!drag) return
    const uv = uvFromEvent(e)

    if (drag.mode === 'move') {
      setUvIslandTransform(obj.id, drag.islandIndex, {
        offsetX: drag.startOffsetX + (uv.x - drag.startMouseUv.x),
        offsetY: drag.startOffsetY + (uv.y - drag.startMouseUv.y),
      })
      return
    }

    if (drag.mode === 'rotate') {
      const currentAngle = Math.atan2(uv.y - drag.center.y, uv.x - drag.center.x)
      setUvIslandTransform(obj.id, drag.islandIndex, {
        rotation: drag.startRotation + (currentAngle - drag.startAngle),
      })
      return
    }

    // scale: keep the opposite corner (anchor) fixed in transformed UV space
    const anchorBase = {
      x: (drag.anchor.x - drag.startOffsetX) / drag.startScale,
      y: (drag.anchor.y - drag.startOffsetY) / drag.startScale,
    }
    const startDist = Math.hypot(drag.startMouseUv.x - drag.anchor.x, drag.startMouseUv.y - drag.anchor.y) || 1e-6
    const curDist = Math.hypot(uv.x - drag.anchor.x, uv.y - drag.anchor.y)
    const scale = Math.max(0.05, drag.startScale * (curDist / startDist))
    setUvIslandTransform(obj.id, drag.islandIndex, {
      scale,
      offsetX: drag.anchor.x - anchorBase.x * scale,
      offsetY: drag.anchor.y - anchorBase.y * scale,
    })

    if (matchTexelDensity && !transforms[drag.islandIndex].excludeFromDensityMatch) {
      // texel density = scale / footprint — hold this ratio constant across every island,
      // resizing each one in place (about its own center) so they don't all jump position.
      // Islands locked out of density-matching are skipped both as source and as target.
      const density = scale / footprints[drag.islandIndex]
      islands.forEach((_, j) => {
        if (j === drag.islandIndex || transforms[j].excludeFromDensityMatch) return
        const t = transforms[j]
        const center = baseCenters[j]
        const transformedCenterPoint = applyIslandTransform(center, center, t)
        const newScale = density * footprints[j]
        setUvIslandTransform(obj.id, j, {
          scale: newScale,
          offsetX: transformedCenterPoint.x - center.x * newScale,
          offsetY: transformedCenterPoint.y - center.y * newScale,
        })
      })
    }
  }

  function handlePointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    if (canvasRef.current?.hasPointerCapture(e.pointerId)) canvasRef.current.releasePointerCapture(e.pointerId)
    dragRef.current = null
  }

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      className="uv-editor-canvas"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    />
  )
}

function bboxOf(points: Iterable<Vec2>) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY }
}
