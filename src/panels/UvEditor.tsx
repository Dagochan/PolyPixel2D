import { useEffect, useRef } from 'react'
import { useSceneStore } from '../scene/store'
import { findIslands, islandBaseUV } from '../scene/uv'
import type { SceneObject, UvIslandTransform, Vec2 } from '../scene/types'

const ISLAND_COLORS = ['#7aa2f7', '#f7768e', '#9ece6a', '#e0af68', '#bb9af7', '#7dcfff']
const HANDLE_SIZE_PX = 8

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

function identity(): UvIslandTransform {
  return { offsetX: 0, offsetY: 0, scale: 1 }
}

export default function UvEditor({ obj, size = 220 }: { obj: SceneObject; size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const setUvIslandTransform = useSceneStore((s) => s.setUvIslandTransform)
  const beginChange = useSceneStore((s) => s.beginChange)

  const islands = findIslands(obj.mesh)
  const transforms = islands.map((_, i) => obj.uvIslandTransforms?.[i] ?? identity())
  const handleHitUv = HANDLE_SIZE_PX / size

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, size, size)
    ctx.fillStyle = '#1e1f22'
    ctx.fillRect(0, 0, size, size)
    ctx.strokeStyle = '#555'
    ctx.strokeRect(0.5, 0.5, size - 1, size - 1)

    const toCanvasPoint = (uv: Vec2) => ({ x: uv.x * size, y: (1 - uv.y) * size })

    islands.forEach((island, i) => {
      const base = islandBaseUV(obj.mesh, island)
      const t = transforms[i]
      const transformedUv = (vi: number) => {
        const b = base.get(vi)!
        return { x: b.x * t.scale + t.offsetX, y: b.y * t.scale + t.offsetY }
      }
      const color = ISLAND_COLORS[i % ISLAND_COLORS.length]

      // mesh wireframe (the actual shape)
      ctx.strokeStyle = color
      ctx.lineWidth = 1.5
      for (const fi of island.faces) {
        const face = obj.mesh.faces[fi]
        ctx.beginPath()
        face.forEach((vi, k) => {
          const p = toCanvasPoint(transformedUv(vi))
          if (k === 0) ctx.moveTo(p.x, p.y)
          else ctx.lineTo(p.x, p.y)
        })
        ctx.closePath()
        ctx.stroke()
      }

      // dashed bbox + scale handle — always visible regardless of the island's actual shape,
      // so a round or irregular island still has an obvious place to grab to resize it
      const bbox = transformedBBoxOf(base, t)
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
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [obj.mesh, obj.uvIslandTransforms, size])

  function uvFromEvent(e: React.PointerEvent): Vec2 {
    const rect = canvasRef.current!.getBoundingClientRect()
    return {
      x: (e.clientX - rect.left) / rect.width,
      y: 1 - (e.clientY - rect.top) / rect.height,
    }
  }

  function transformedBBox(islandIndex: number) {
    return transformedBBoxOf(islandBaseUV(obj.mesh, islands[islandIndex]), transforms[islandIndex])
  }

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    const uv = uvFromEvent(e)

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

function transformedBBoxOf(base: Map<number, Vec2>, t: UvIslandTransform) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const uv of base.values()) {
    const x = uv.x * t.scale + t.offsetX
    const y = uv.y * t.scale + t.offsetY
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  return { minX, minY, maxX, maxY }
}
