import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useSceneStore } from '../scene/store'
import type { EasingType, LoopMode } from '../scene/types'

const EASING_OPTIONS: EasingType[] = ['linear', 'easeIn', 'easeOut', 'easeInOut']

const MIN_PX_PER_SECOND = 10
const MAX_PX_PER_SECOND = 2000
const DEFAULT_PX_PER_SECOND = 200
const MIN_TICK_GAP_PX = 60

/** Picks a "nice" (1/2/5 × 10^n) tick spacing in seconds, the smallest one whose on-screen gap is
 *  still at least `MIN_TICK_GAP_PX` at the current zoom — same approach most DAW/NLE rulers use so
 *  labels never overlap and round numbers don't drift as you zoom. */
function niceTickInterval(pxPerSecond: number): number {
  const rawInterval = MIN_TICK_GAP_PX / pxPerSecond
  const exponent = Math.floor(Math.log10(rawInterval))
  const base = Math.pow(10, exponent)
  const fraction = rawInterval / base
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10
  return niceFraction * base
}

/** Bottom-docked animation timeline: clip selection/management, a scrub bar with the active
 *  clip's playhead, and keyframe markers for the currently selected object's track. Keyframing is
 *  per-object (one button snapshots that object's whole Transform) rather than per-channel, see
 *  the design notes in `src/scene/types.ts`. */
export default function Timeline({ style }: { style?: CSSProperties }) {
  const clips = useSceneStore((s) => s.clips)
  const activeClipId = useSceneStore((s) => s.activeClipId)
  const playheadTime = useSceneStore((s) => s.playheadTime)
  const selectedObjectId = useSceneStore((s) => s.selectedObjectId)
  const objects = useSceneStore((s) => s.objects)
  const selectObject = useSceneStore((s) => s.selectObject)
  const addClip = useSceneStore((s) => s.addClip)
  const removeClip = useSceneStore((s) => s.removeClip)
  const renameClip = useSceneStore((s) => s.renameClip)
  const setActiveClipId = useSceneStore((s) => s.setActiveClipId)
  const setClipDuration = useSceneStore((s) => s.setClipDuration)
  const setClipLoopMode = useSceneStore((s) => s.setClipLoopMode)
  const setClipFrameRate = useSceneStore((s) => s.setClipFrameRate)
  const insertKeyframe = useSceneStore((s) => s.insertKeyframe)
  const removeKeyframe = useSceneStore((s) => s.removeKeyframe)
  const setKeyframeTime = useSceneStore((s) => s.setKeyframeTime)
  const setKeyframeEasing = useSceneStore((s) => s.setKeyframeEasing)
  const setPlayhead = useSceneStore((s) => s.setPlayhead)

  const activeClip = clips.find((c) => c.id === activeClipId) ?? null

  const [isPlaying, setIsPlaying] = useState(false)
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null)
  // which track (object) `selectedKeyId` belongs to — tracked separately from `selectedObjectId`
  // because clicking a keyframe also re-selects its object (handy, matches a dope sheet), but the
  // reverse shouldn't happen: switching the scene selection elsewhere shouldn't silently relabel
  // an already-selected keyframe as belonging to a different track.
  const [selectedKeyObjectId, setSelectedKeyObjectId] = useState<string | null>(null)
  const [pxPerSecond, setPxPerSecond] = useState(DEFAULT_PX_PER_SECOND)
  const trackRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const draggingKeyRef = useRef<string | null>(null)
  const draggingPlayheadRef = useRef(false)
  const rafRef = useRef<number | null>(null)
  const lastTickRef = useRef<number | null>(null)
  // raw, monotonically-increasing playback time — separate from the store's `playheadTime`,
  // which `setPlayhead` folds (resolves) into the clip's [0, duration] range every call. For
  // loop/pingpong clips that resolved value isn't safe to feed back in as next frame's "current
  // time": near the end of a pingpong leg it reflects downward, so adding dt to it immediately
  // reads as moving forward again — the playhead would judder in place instead of continuing
  // smoothly past the turnaround. Keeping our own ever-increasing accumulator avoids that.
  const rawTimeRef = useRef(0)

  // playback loop — advances the playhead each frame while `isPlaying`, stops at clip change/unmount
  useEffect(() => {
    if (!isPlaying || !activeClip) {
      setIsPlaying(false)
      return
    }
    rawTimeRef.current = useSceneStore.getState().playheadTime
    const tick = (now: number) => {
      const last = lastTickRef.current
      lastTickRef.current = now
      if (last !== null) {
        const dt = (now - last) / 1000
        rawTimeRef.current += dt
        // hold each pose for a full frame interval instead of re-sampling continuously every
        // rAF tick (~60fps) — otherwise a clip set to e.g. 7fps still *looks* perfectly smooth
        // during Play, since the frame rate would only ever affect snapping/display, never
        // actual playback. Quantizing to the frame grid here makes low frame rates genuinely
        // read as low frame rates.
        const frameRateNow = useSceneStore.getState().clips.find((c) => c.id === activeClipId)?.frameRate ?? 24
        setPlayhead(Math.floor(rawTimeRef.current * frameRateNow) / frameRateNow)
        // setPlayhead clamps a 'none' clip's playhead to its end instead of looping it — stop
        // playback there instead of spinning the rAF loop forever at a frozen pose
        const s = useSceneStore.getState()
        const clip = s.clips.find((c) => c.id === s.activeClipId)
        if (clip && clip.loopMode === 'none' && s.playheadTime >= clip.duration) {
          setIsPlaying(false)
          return
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      lastTickRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, activeClipId])

  if (clips.length === 0 || !activeClip) {
    return (
      <div className="panel timeline" style={style}>
        <div className="timeline-header">
          <button onClick={() => addClip()}>+ New clip</button>
          <span className="empty-hint">No animation clips yet</span>
        </div>
      </div>
    )
  }

  const duration = activeClip.duration
  const frameRate = activeClip.frameRate
  // the track is at least as wide as the visible scroll area, so a short clip still fills the
  // panel instead of leaving a sliver of ruler at 0px-per-second precision
  const contentWidth = Math.max(scrollRef.current?.clientWidth ?? 0, duration * pxPerSecond)
  const clampTime = (t: number) => Math.min(duration, Math.max(0, t))
  const xToTime = (x: number) => clampTime(x / pxPerSecond)
  // frame rate is a snapping/display granularity only (the time axis itself stays seconds-based)
  // — pointer-driven moves (click-seek, keyframe drag) snap to it; typed values stay exact
  const snapToFrame = (t: number) => clampTime(Math.round(t * frameRate) / frameRate)

  const seekFromClientX = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect) return
    setPlayhead(snapToFrame(xToTime(clientX - rect.left)))
  }

  const zoomBy = (factor: number) =>
    setPxPerSecond((px) => Math.min(MAX_PX_PER_SECOND, Math.max(MIN_PX_PER_SECOND, px * factor)))

  const zoomToFit = () => {
    const visibleWidth = scrollRef.current?.clientWidth
    if (!visibleWidth || duration <= 0) return
    setPxPerSecond(Math.min(MAX_PX_PER_SECOND, Math.max(MIN_PX_PER_SECOND, visibleWidth / duration)))
  }

  const tickInterval = niceTickInterval(pxPerSecond)
  const ticks: number[] = []
  for (let t = 0; t <= duration + tickInterval * 0.5; t += tickInterval) {
    ticks.push(Math.round(t / tickInterval) * tickInterval)
  }

  // second ruler row, in frame units instead of seconds — same "nice" 1/2/5×10^n spacing logic,
  // just fed pixels-per-frame instead of pixels-per-second, then floored to a whole frame (a
  // fractional frame interval isn't a meaningful tick)
  const totalFrames = Math.round(duration * frameRate)
  const frameInterval = Math.max(1, Math.round(niceTickInterval(pxPerSecond / frameRate)))
  const frameTicks: number[] = []
  for (let f = 0; f <= totalFrames + frameInterval * 0.5; f += frameInterval) {
    frameTicks.push(Math.round(f / frameInterval) * frameInterval)
  }

  // the track's gridlines show every frame, not just the labeled/spaced-out ruler ticks above —
  // but only down to a px-per-frame floor, so zooming way out doesn't spawn thousands of
  // sub-pixel-spaced divs. Below that floor it falls back to the same spacing as the ruler.
  const pxPerFrame = pxPerSecond / frameRate
  const frameGridlines: number[] =
    pxPerFrame >= 3 ? Array.from({ length: totalFrames + 1 }, (_, f) => f) : frameTicks

  return (
    <div className="panel timeline" style={style}>
      <div className="timeline-header">
        <select value={activeClipId ?? ''} onChange={(e) => setActiveClipId(e.target.value)}>
          {clips.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <input
          className="layer-name timeline-clip-name"
          value={activeClip.name}
          onChange={(e) => renameClip(activeClip.id, e.target.value)}
        />
        <button onClick={() => addClip()}>+ New clip</button>
        <button title="Delete this clip" onClick={() => removeClip(activeClip.id)}>
          🗑
        </button>
        <label className="seg-input">
          Duration (s)
          <input
            type="number"
            min={0}
            step={0.1}
            value={duration}
            onChange={(e) => setClipDuration(activeClip.id, +e.target.value)}
          />
        </label>
        <label className="seg-input">
          Loop
          <select
            value={activeClip.loopMode}
            onChange={(e) => setClipLoopMode(activeClip.id, e.target.value as LoopMode)}
          >
            <option value="none">None</option>
            <option value="loop">Loop</option>
            <option value="pingpong">Ping-pong</option>
          </select>
        </label>
        <label className="seg-input" title="Snapping/display granularity for the timeline (the time axis itself stays seconds-based)">
          Frame rate
          <input
            type="number"
            min={1}
            step={1}
            value={frameRate}
            onChange={(e) => setClipFrameRate(activeClip.id, +e.target.value)}
          />
        </label>
        <button className={isPlaying ? 'active' : ''} onClick={() => setIsPlaying((p) => !p)}>
          {isPlaying ? '⏸ Pause' : '▶ Play'}
        </button>
        <label className="seg-input">
          Time (s)
          <input
            type="number"
            min={0}
            step={1 / frameRate}
            value={Math.round(playheadTime * 1000) / 1000}
            onChange={(e) => setPlayhead(snapToFrame(+e.target.value))}
          />
        </label>
        <span className="timeline-frame-readout">frame {Math.round(playheadTime * frameRate)}</span>
        <button
          disabled={!selectedObjectId}
          title={selectedObjectId ? 'Snapshot the selected object\'s transform as a keyframe here' : 'Select an object first'}
          onClick={() => selectedObjectId && insertKeyframe(selectedObjectId, snapToFrame(playheadTime))}
        >
          ◆ Insert keyframe
        </button>
        <div className="timeline-zoom-group">
          <button title="Zoom out" onClick={() => zoomBy(1 / 1.25)}>
            −
          </button>
          <button title="Zoom in" onClick={() => zoomBy(1.25)}>
            +
          </button>
          <button title="Fit the clip's duration to the visible width" onClick={zoomToFit}>
            Fit
          </button>
        </div>
      </div>

      <div className="timeline-body">
        <div className="timeline-channel-list">
          <div className="timeline-channel-list-header" />
          {activeClip.tracks.map((t) => {
            const obj = objects.find((o) => o.id === t.objectId)
            return (
              <div
                key={t.objectId}
                className={'timeline-channel-name' + (t.objectId === selectedObjectId ? ' selected' : '')}
                title={obj?.name ?? '(deleted object)'}
                onClick={() => selectObject(t.objectId)}
              >
                {obj?.name ?? '(deleted object)'}
              </div>
            )
          })}
          {activeClip.tracks.length === 0 && (
            <div className="timeline-channel-name empty-hint">No keyframed objects yet</div>
          )}
        </div>

        <div className="timeline-scroll" ref={scrollRef}>
          <div className="timeline-ruler" style={{ width: contentWidth }}>
            {ticks.map((t) => (
              <div key={t} className="timeline-tick" style={{ left: t * pxPerSecond }}>
                <span>{t.toFixed(tickInterval < 1 ? 2 : 0)}s</span>
              </div>
            ))}
          </div>
          <div className="timeline-frame-ruler" style={{ width: contentWidth }}>
            {frameTicks.map((f) => (
              <div key={f} className="timeline-tick" style={{ left: (f / frameRate) * pxPerSecond }}>
                <span>{f}</span>
              </div>
            ))}
          </div>
          <div
            className="timeline-rows"
            ref={trackRef}
            style={{ width: contentWidth }}
            onPointerDown={(e) => {
              if ((e.target as HTMLElement).closest('.timeline-keyframe')) return
              draggingPlayheadRef.current = true
              seekFromClientX(e.clientX)
              // best-effort: keeps the drag tracking the pointer even if it leaves the rows area
              // while held. Pointer capture can throw in some environments (invalid pointer id,
              // etc.) — never let that swallow the seek above.
              try {
                e.currentTarget.setPointerCapture(e.pointerId)
              } catch {
                /* ignore */
              }
            }}
            onPointerMove={(e) => {
              if (!draggingPlayheadRef.current) return
              seekFromClientX(e.clientX)
            }}
            onPointerUp={(e) => {
              draggingPlayheadRef.current = false
              try {
                e.currentTarget.releasePointerCapture(e.pointerId)
              } catch {
                /* ignore */
              }
            }}
          >
            {frameGridlines.map((f) => (
              <div key={`fg-${f}`} className="timeline-gridline frame" style={{ left: (f / frameRate) * pxPerSecond }} />
            ))}
            <div className="timeline-playhead" style={{ left: playheadTime * pxPerSecond }} />
            {activeClip.tracks.map((t) => (
              <div key={t.objectId} className={'timeline-track-row' + (t.objectId === selectedObjectId ? ' selected' : '')}>
                {t.keyframes.map((k) => (
                  <div
                    key={k.id}
                    className={'timeline-keyframe' + (selectedKeyId === k.id ? ' selected' : '')}
                    style={{ left: k.time * pxPerSecond }}
                    title={`${objects.find((o) => o.id === t.objectId)?.name ?? t.objectId}: t=${k.time.toFixed(2)}s, ${k.easing}`}
                    onPointerDown={(e) => {
                      e.stopPropagation()
                      selectObject(t.objectId)
                      setSelectedKeyObjectId(t.objectId)
                      setSelectedKeyId(k.id)
                      draggingKeyRef.current = k.id
                      e.currentTarget.setPointerCapture(e.pointerId)
                    }}
                    onPointerMove={(e) => {
                      if (draggingKeyRef.current !== k.id) return
                      const rect = trackRef.current?.getBoundingClientRect()
                      if (!rect) return
                      setKeyframeTime(t.objectId, k.id, snapToFrame(xToTime(e.clientX - rect.left)))
                    }}
                    onPointerUp={() => {
                      draggingKeyRef.current = null
                    }}
                  />
                ))}
              </div>
            ))}
            {activeClip.tracks.length === 0 && <div className="timeline-track-row empty" />}
          </div>
        </div>
      </div>

      {selectedKeyId && selectedKeyObjectId && (
        <div className="timeline-keyframe-inspector">
          {(() => {
            const keyTrack = activeClip.tracks.find((t) => t.objectId === selectedKeyObjectId)
            const key = keyTrack?.keyframes.find((k) => k.id === selectedKeyId)
            if (!key) return null
            return (
              <>
                <span>Keyframe @ {key.time.toFixed(2)}s</span>
                <label className="seg-input">
                  Easing
                  <select
                    value={key.easing}
                    onChange={(e) => setKeyframeEasing(selectedKeyObjectId, key.id, e.target.value as EasingType)}
                  >
                    {EASING_OPTIONS.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  title="Delete this keyframe"
                  onClick={() => {
                    removeKeyframe(selectedKeyObjectId, key.id)
                    setSelectedKeyId(null)
                    setSelectedKeyObjectId(null)
                  }}
                >
                  🗑 Delete keyframe
                </button>
              </>
            )
          })()}
        </div>
      )}
    </div>
  )
}
