import { useEffect, useRef, useState } from 'react'
import { useSceneStore } from '../scene/store'
import { getOscillator, sampleOscillator } from '../scene/oscillator'
import NumberInput from './NumberInput'
import type { OscillatorSettings } from '../scene/types'

const AXIS_LABELS: Record<OscillatorSettings['targetAxis'], string> = {
  x: 'Position X',
  y: 'Position Y',
  rotation: 'Rotation',
  scaleX: 'Scale X',
  scaleY: 'Scale Y',
}

const SCREEN_W = 480
const SCREEN_H = 220
// how many seconds of history are visible across the screen's width — the trace always shows
// "now" at the right edge, scrolling left, like a real oscilloscope's sweep
const TIME_WINDOW = 4

/** The "Oscilloscope" window (project idea, 2026-07-12): a dedicated modal for tuning and
 *  previewing one object's Oscillator modifier, styled like a real CRT scope — black screen,
 *  glowing green trace — rather than yet another plain settings panel, since the whole point is a
 *  fun, at-a-glance read of the wave you're shaping. The trace runs continuously off the wall
 *  clock the moment this opens (see the rAF loop below), independent of the "Preview" toggle,
 *  which instead controls whether the *target object* in the main viewport actually moves (see
 *  `previewOscillator`'s doc) — the screen is just this window's own live visualization, not a
 *  readout of whether anything else is currently animating. */
export default function Oscilloscope({ objectId, onClose }: { objectId: string; onClose: () => void }) {
  const obj = useSceneStore((s) => s.objects.find((o) => o.id === objectId))
  const updateOscillator = useSceneStore((s) => s.updateOscillator)
  const bakeOscillator = useSceneStore((s) => s.bakeOscillator)
  const hasActiveClip = useSceneStore((s) => s.activeClipId !== null)
  const previewOscillator = useSceneStore((s) => s.previewOscillator)
  const togglePreviewOscillator = useSceneStore((s) => s.togglePreviewOscillator)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef(0)
  const settingsRef = useRef<OscillatorSettings | undefined>(undefined)
  settingsRef.current = obj ? getOscillator(obj) : undefined

  const [modalOffset, setModalOffset] = useState({ x: 0, y: 0 })
  const dragRef = useRef<{ startX: number; startY: number; startOffsetX: number; startOffsetY: number } | null>(null)

  // Close on Escape, matching every other modal/pending-UI convention in this app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // An object deleted (or its modifier removed) while this window is open just closes it, rather
  // than showing a dead/blank scope.
  useEffect(() => {
    if (!obj || !settingsRef.current) onClose()
  }, [obj, onClose])

  useEffect(() => {
    const draw = () => {
      const canvas = canvasRef.current
      const settings = settingsRef.current
      const ctx = canvas?.getContext('2d')
      if (ctx && settings) {
        const now = performance.now() / 1000
        ctx.fillStyle = '#03110a'
        ctx.fillRect(0, 0, SCREEN_W, SCREEN_H)

        ctx.strokeStyle = '#0a3320'
        ctx.lineWidth = 1
        for (let gx = 0; gx <= SCREEN_W; gx += SCREEN_W / 8) {
          ctx.beginPath()
          ctx.moveTo(gx + 0.5, 0)
          ctx.lineTo(gx + 0.5, SCREEN_H)
          ctx.stroke()
        }
        for (let gy = 0; gy <= SCREEN_H; gy += SCREEN_H / 4) {
          ctx.beginPath()
          ctx.moveTo(0, gy + 0.5)
          ctx.lineTo(SCREEN_W, gy + 0.5)
          ctx.stroke()
        }
        ctx.strokeStyle = '#1f8a52'
        ctx.beginPath()
        ctx.moveTo(0, SCREEN_H / 2)
        ctx.lineTo(SCREEN_W, SCREEN_H / 2)
        ctx.stroke()

        ctx.strokeStyle = '#41ff8f'
        ctx.lineWidth = 2
        ctx.shadowColor = '#41ff8f'
        ctx.shadowBlur = 8
        ctx.beginPath()
        // fixed volts-per-pixel scale (not normalized by the current amplitude) so dragging
        // Amplitude actually changes the trace's height on screen — REFERENCE_AMPLITUDE units
        // fill the screen's usable half-height; a larger amplitude clips flat at the top/bottom
        // edges instead of overflowing, like a real scope's vertical range.
        const REFERENCE_AMPLITUDE = 20
        const halfHeight = SCREEN_H / 2 - 12
        for (let px = 0; px <= SCREEN_W; px++) {
          const t = now - TIME_WINDOW * (1 - px / SCREEN_W)
          const v = sampleOscillator(settings, t)
          const y = Math.max(12, Math.min(SCREEN_H - 12, SCREEN_H / 2 - (v / REFERENCE_AMPLITUDE) * halfHeight))
          if (px === 0) ctx.moveTo(px, y)
          else ctx.lineTo(px, y)
        }
        ctx.stroke()
        ctx.shadowBlur = 0
      }
      rafRef.current = requestAnimationFrame(draw)
    }
    rafRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafRef.current)
  }, [])

  if (!obj) return null
  const settings = getOscillator(obj)
  if (!settings) return null

  const handleHeaderPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = { startX: e.clientX, startY: e.clientY, startOffsetX: modalOffset.x, startOffsetY: modalOffset.y }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const handleHeaderPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d) return
    setModalOffset({ x: d.startOffsetX + (e.clientX - d.startX), y: d.startOffsetY + (e.clientY - d.startY) })
  }
  const handleHeaderPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
  }

  return (
    <div className="uv-modal-backdrop" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }}>
      <div
        className="oscilloscope-modal"
        style={{ transform: `translate(-50%, -50%) translate(${modalOffset.x}px, ${modalOffset.y}px)` }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="uv-modal-header oscilloscope-header"
          onPointerDown={handleHeaderPointerDown}
          onPointerMove={handleHeaderPointerMove}
          onPointerUp={handleHeaderPointerUp}
        >
          <span>Oscilloscope — {obj.name}</span>
          <button onPointerDown={(e) => e.stopPropagation()} onClick={onClose}>
            Close
          </button>
        </div>

        <canvas ref={canvasRef} width={SCREEN_W} height={SCREEN_H} className="oscilloscope-screen" />

        <div className="prop-row">
          <label className="insert-slot-label">Input</label>
          <select
            value={settings.targetAxis}
            onChange={(e) => updateOscillator(obj.id, { targetAxis: e.target.value as OscillatorSettings['targetAxis'] })}
          >
            {(Object.keys(AXIS_LABELS) as OscillatorSettings['targetAxis'][]).map((axis) => (
              <option key={axis} value={axis}>
                {obj.name} — {AXIS_LABELS[axis]}
              </option>
            ))}
          </select>
        </div>

        <div className="prop-row">
          <label className="seg-input" title="Seconds per full sine cycle">
            Wavelength
            <NumberInput min={0.1} max={60} step={0.1} value={settings.wavelength} onCommit={(v) => updateOscillator(obj.id, { wavelength: v })} />
          </label>
          <label className="seg-input" title="Peak deviation from the base value">
            Amplitude
            <NumberInput min={0} step={1} value={settings.amplitude} onCommit={(v) => updateOscillator(obj.id, { amplitude: v })} />
          </label>
        </div>
        <div className="prop-row">
          <label className="uv-hint uv-density-toggle" title="0 = pure sine, 1 = fully seeded pseudo-noise">
            Randomness
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={settings.randomness}
              onChange={(e) => updateOscillator(obj.id, { randomness: +e.target.value })}
            />
          </label>
          <label className="seg-input" title="Different seeds desync multiple Oscillators sharing the same settings">
            Seed
            <NumberInput min={0} step={1} value={settings.seed} onCommit={(v) => updateOscillator(obj.id, { seed: v })} />
          </label>
        </div>

        <div className="prop-row">
          <button
            className={previewOscillator ? 'active' : ''}
            title="Live-preview this wave driving the target object in the main viewport, without keying anything"
            onClick={() => togglePreviewOscillator()}
          >
            {previewOscillator ? '■ Stop preview' : '▶ Preview'}
          </button>
          <button
            disabled={!hasActiveClip}
            title="Bake this wave across the active clip's whole duration into real keyframes"
            onClick={() => bakeOscillator(obj.id)}
          >
            Add Keyframe
          </button>
        </div>
        {!hasActiveClip && <div className="uv-hint">No active clip — create one to bake this Oscillator into keyframes</div>}
      </div>
    </div>
  )
}
