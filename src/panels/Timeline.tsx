import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { useSceneStore } from '../scene/store'
import { getFakeFlag } from '../scene/fakeFlag'
import type { EasingType, LoopMode } from '../scene/types'
import { AddKeyframeIcon, DuplicateKeyframeIcon, PlayheadIcon, PlayIcon, PauseIcon, JumpToStartIcon, JumpToEndIcon, JumpToPrevFrameIcon, JumpToNextFrameIcon, TrashIcon } from './icons'
import NumberInput from './NumberInput'

const EASING_OPTIONS: EasingType[] = ['linear', 'easeIn', 'easeOut', 'easeInOut']

const MIN_PX_PER_SECOND = 10
const MAX_PX_PER_SECOND = 2000
const DEFAULT_PX_PER_SECOND = 200
const MIN_TICK_GAP_PX = 60

const CHANNEL_LIST_DEFAULT_WIDTH = 110
const CHANNEL_LIST_MIN_WIDTH = 90
const CHANNEL_LIST_MAX_WIDTH = 400

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
  const setKeyframesTimeLive = useSceneStore((s) => s.setKeyframesTimeLive)
  const beginChange = useSceneStore((s) => s.beginChange)
  const setKeyframeEasing = useSceneStore((s) => s.setKeyframeEasing)
  const duplicateKeyframe = useSceneStore((s) => s.duplicateKeyframe)
  const removeShapeKeyKeyframe = useSceneStore((s) => s.removeShapeKeyKeyframe)
  const setShapeKeyKeyframeTime = useSceneStore((s) => s.setShapeKeyKeyframeTime)
  const setShapeKeyKeyframeEasing = useSceneStore((s) => s.setShapeKeyKeyframeEasing)
  const duplicateShapeKeyKeyframe = useSceneStore((s) => s.duplicateShapeKeyKeyframe)
  const removePathOffsetKeyframe = useSceneStore((s) => s.removePathOffsetKeyframe)
  const setPathOffsetKeyframeTime = useSceneStore((s) => s.setPathOffsetKeyframeTime)
  const setPathOffsetKeyframeEasing = useSceneStore((s) => s.setPathOffsetKeyframeEasing)
  const duplicatePathOffsetKeyframe = useSceneStore((s) => s.duplicatePathOffsetKeyframe)
  const removeFollowPathProgressKeyframe = useSceneStore((s) => s.removeFollowPathProgressKeyframe)
  const setFollowPathProgressKeyframeTime = useSceneStore((s) => s.setFollowPathProgressKeyframeTime)
  const setFollowPathProgressKeyframeEasing = useSceneStore((s) => s.setFollowPathProgressKeyframeEasing)
  const duplicateFollowPathProgressKeyframe = useSceneStore((s) => s.duplicateFollowPathProgressKeyframe)
  const setPlayhead = useSceneStore((s) => s.setPlayhead)
  const bakeAllFakePhysics = useSceneStore((s) => s.bakeAllFakePhysics)

  const activeClip = clips.find((c) => c.id === activeClipId) ?? null

  const [isPlaying, setIsPlaying] = useState(false)
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null)
  // which track (object) `selectedKeyId` belongs to — tracked separately from `selectedObjectId`
  // because clicking a keyframe also re-selects its object (handy, matches a dope sheet), but the
  // reverse shouldn't happen: switching the scene selection elsewhere shouldn't silently relabel
  // an already-selected keyframe as belonging to a different track.
  const [selectedKeyObjectId, setSelectedKeyObjectId] = useState<string | null>(null)
  // which shape key `selectedKeyId` belongs to, if any — `null` means the selected key is on the
  // object's Transform track, not a shape-key weight track
  const [selectedKeyShapeKeyId, setSelectedKeyShapeKeyId] = useState<string | null>(null)
  // whether `selectedKeyId` is on a `pathOffset` track rather than Transform/shape-key — kept as
  // its own flag rather than overloading `selectedKeyShapeKeyId` (a pathOffset key has no
  // shape-key id of its own, but also isn't a Transform key) since a track is keyed by `objectId`
  // alone (see `PathOffsetTrack`'s doc).
  const [selectedKeyIsPathOffset, setSelectedKeyIsPathOffset] = useState(false)
  // same idea as `selectedKeyIsPathOffset`, for a `followPathProgress` track.
  const [selectedKeyIsFollowPathProgress, setSelectedKeyIsFollowPathProgress] = useState(false)
  // set by the keyframe inspector's Duplicate button — identifies the source keyframe to clone
  // and which track it lives on (same discriminated shape as the `selectedKey*` state above).
  // While non-null, the timeline is in a modal "place the duplicate" mode: a ghost keyframe
  // (`duplicateHoverTime`) tracks the pointer instead of the playhead, and the next click on the
  // track commits it there — Blender-style "duplicate, then click to drop" rather than an
  // immediate in-place copy, since there's no meaningful default time for the copy to land on.
  const [pendingDuplicate, setPendingDuplicate] = useState<{
    sourceKeyframeId: string
    objectId: string
    shapeKeyId: string | null
    isPathOffset: boolean
    isFollowPathProgress: boolean
  } | null>(null)
  const [duplicateHoverTime, setDuplicateHoverTime] = useState<number | null>(null)
  // Every currently-selected keyframe's id (globally unique across tracks — see `genId`), kept in
  // sync with `selectedKeyId`'s single-key metadata whenever the selection ends up exactly one key
  // (that's what feeds the keyframe inspector below). A plain click replaces this with just the
  // clicked key; Shift+click toggles one key in/out; Shift+drag on empty track space box-selects
  // (adds to) it — same conventions as a typical dope sheet.
  const [selectedKeyIds, setSelectedKeyIds] = useState<Set<string>>(new Set())
  const [pxPerSecond, setPxPerSecond] = useState(DEFAULT_PX_PER_SECOND)
  const [channelListWidth, setChannelListWidth] = useState(CHANNEL_LIST_DEFAULT_WIDTH)
  const trackRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const resizingChannelListRef = useRef(false)
  const draggingKeyRef = useRef<string | null>(null)
  // set alongside `draggingKeyRef` whenever the dragged key is part of a >1-key selection — the
  // dragged key's own delta (new time minus this snapshot's time for it) is applied identically to
  // every other selected key's own snapshotted start time, so the whole group moves together
  // preserving their relative spacing instead of collapsing onto the dragged key.
  const groupDragRef = useRef<{ anchorStartTime: number; startTimes: Map<string, number> } | null>(null)
  // rubber-band keyframe box-select, in viewport (client) coordinates — compared directly against
  // each row/keyframe's own `getBoundingClientRect()`, so no local-to-track coordinate conversion
  // is needed at all.
  const [boxSelect, setBoxSelect] = useState<{ startX: number; startY: number; curX: number; curY: number } | null>(null)
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
        // 'replay' samples like 'none' (see `LoopMode`'s doc) but keeps playing instead of
        // stopping — just restart the raw clock from 0 once it passes the end, a plain "play it
        // again" rather than 'loop'/'pingpong's seamless wrap math.
        if (clip && clip.loopMode === 'replay' && rawTimeRef.current >= clip.duration) {
          rawTimeRef.current -= clip.duration
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

  // Escape cancels an in-progress duplicate placement or box-select — same modal-drag-cancel
  // convention as the viewport's grab/move tools.
  useEffect(() => {
    if (!pendingDuplicate && !boxSelect) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPendingDuplicate(null)
        setDuplicateHoverTime(null)
        setBoxSelect(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [pendingDuplicate, boxSelect])

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
  // left margin before t=0 so the playhead handle is never clipped behind the channel list
  const RULER_OFFSET_PX = 8
  const contentWidth = Math.max(scrollRef.current?.clientWidth ?? 0, duration * pxPerSecond + RULER_OFFSET_PX)
  const clampTime = (t: number) => Math.min(duration, Math.max(0, t))
  const xToTime = (x: number) => clampTime((x - RULER_OFFSET_PX) / pxPerSecond)
  // frame rate is a snapping/display granularity only (the time axis itself stays seconds-based)
  // — pointer-driven moves (click-seek, keyframe drag) snap to it; typed values stay exact
  const snapToFrame = (t: number) => clampTime(Math.round(t * frameRate) / frameRate)

  const seekFromClientX = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect) return
    setPlayhead(snapToFrame(xToTime(clientX - rect.left)))
  }

  // commits `pendingDuplicate` as a real keyframe at `time`, cloning the source's value/easing —
  // the tail end of the Duplicate button's "click to drop" flow.
  const commitDuplicate = (time: number) => {
    if (!pendingDuplicate) return
    const { sourceKeyframeId, objectId, shapeKeyId, isPathOffset, isFollowPathProgress } = pendingDuplicate
    if (shapeKeyId) duplicateShapeKeyKeyframe(objectId, shapeKeyId, sourceKeyframeId, time)
    else if (isPathOffset) duplicatePathOffsetKeyframe(objectId, sourceKeyframeId, time)
    else if (isFollowPathProgress) duplicateFollowPathProgressKeyframe(objectId, sourceKeyframeId, time)
    else duplicateKeyframe(objectId, sourceKeyframeId, time)
    setPendingDuplicate(null)
    setDuplicateHoverTime(null)
  }

  // all keyframe times on the selected object's tracks (Transform, shape keys, Path Offset,
  // Follow Path progress) — used by the prev/next-keyframe transport buttons below. Baked Fake
  // Physics tracks are deliberately excluded: they're dense, machine-generated keyframes (one per
  // frame), so "jump to keyframe" on them would be indistinguishable from plain frame-stepping.
  const KEYFRAME_JUMP_EPS = 1e-6
  const selectedObjectKeyframeTimes = (): number[] => {
    if (!selectedObjectId) return []
    const times = new Set<number>()
    activeClip.tracks.find((t) => t.objectId === selectedObjectId)?.keyframes.forEach((k) => times.add(k.time))
    for (const skt of (activeClip.shapeKeyTracks ?? []).filter((s) => s.objectId === selectedObjectId)) {
      skt.keyframes.forEach((k) => times.add(k.time))
    }
    ;(activeClip.pathOffsetTracks ?? [])
      .find((pt) => pt.objectId === selectedObjectId)
      ?.keyframes.forEach((k) => times.add(k.time))
    ;(activeClip.followPathProgressTracks ?? [])
      .find((pt) => pt.objectId === selectedObjectId)
      ?.keyframes.forEach((k) => times.add(k.time))
    return Array.from(times).sort((a, b) => a - b)
  }
  const prevKeyframeTime = (): number | undefined =>
    [...selectedObjectKeyframeTimes()].reverse().find((t) => t < playheadTime - KEYFRAME_JUMP_EPS)
  const nextKeyframeTime = (): number | undefined =>
    selectedObjectKeyframeTimes().find((t) => t > playheadTime + KEYFRAME_JUMP_EPS)
  // the Transform keyframe (if any) sitting exactly at the playhead, for the toolbar's Duplicate
  // Keyframe button — same track scope as the Add Keyframe button right next to it (`insertKeyframe`
  // only ever writes a Transform keyframe), so parking the playhead on an existing one and hitting
  // this button is the toolbar-level shortcut for what the per-keyframe inspector's own Duplicate
  // button already does.
  const transformKeyframeAtPlayhead = () =>
    selectedObjectId
      ? activeClip.tracks
          .find((t) => t.objectId === selectedObjectId)
          ?.keyframes.find((k) => Math.abs(k.time - playheadTime) < KEYFRAME_JUMP_EPS)
      : undefined

  const zoomBy = (factor: number) =>
    setPxPerSecond((px) => Math.min(MAX_PX_PER_SECOND, Math.max(MIN_PX_PER_SECOND, px * factor)))

  const zoomToFit = () => {
    const visibleWidth = scrollRef.current?.clientWidth
    if (!visibleWidth || duration <= 0) return
    setPxPerSecond(Math.min(MAX_PX_PER_SECOND, Math.max(MIN_PX_PER_SECOND, visibleWidth / duration)))
  }

  // drag-resize the channel-name column — same window-pointermove-listener pattern as App.tsx's
  // sidebar/properties/timeline resizers, just scoped locally since this one only affects this panel.
  const startChannelListResize = (e: ReactPointerEvent) => {
    e.preventDefault()
    resizingChannelListRef.current = true
    const startX = e.clientX
    const startWidth = channelListWidth
    const onMove = (ev: PointerEvent) => {
      if (!resizingChannelListRef.current) return
      setChannelListWidth(Math.min(CHANNEL_LIST_MAX_WIDTH, Math.max(CHANNEL_LIST_MIN_WIDTH, startWidth + (ev.clientX - startX))))
    }
    const onUp = () => {
      resizingChannelListRef.current = false
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
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

  // one row per Transform track, each immediately followed by that same object's shape-key
  // tracks (if any) — a shape-key track can outlive its object's Transform track (e.g. the
  // Transform track got fully deleted), so this is built from the union of both track lists'
  // object ids, not just `tracks`.
  type Row =
    | { kind: 'transform'; objectId: string; keyframes: typeof activeClip.tracks[number]['keyframes'] }
    | {
        kind: 'shapeKey'
        objectId: string
        shapeKeyId: string
        keyName: string
        keyframes: NonNullable<typeof activeClip.shapeKeyTracks>[number]['keyframes']
      }
    // Fake Flag has no keyframe track (it's a pure function of time, nothing to key) — this row
    // exists purely so an object driven only by Fake Flag isn't invisible in the timeline, and so
    // anyone scrubbing/reading the clip knows a procedural effect is riding along.
    | { kind: 'fakeFlag'; objectId: string }
    // Fake Physics *does* have real dense (one-per-frame) keyframes once baked, in
    // `fakePhysicsTracks` rather than `tracks` — but they're machine-generated and not meant for
    // hand-dragging, so this renders as a solid "baked" bar instead of individual diamonds.
    | { kind: 'fakePhysicsBaked'; objectId: string }
    // Same idea as `fakePhysicsBaked`, for the mesh (vertex-section) variant's `fakePhysicsMeshTracks`.
    | { kind: 'fakePhysicsMeshBaked'; objectId: string }
    // Same idea as `fakePhysicsBaked`, for an Oscillator's baked `oscillatorTracks` (see
    // `bakeOscillator`/the Oscilloscope window's "Add Keyframe").
    | { kind: 'oscillatorBaked'; objectId: string }
    // Path Deform (Rail)'s `pathOffset` — hand-authored keyframes like a shape key's weight, but
    // keyed by `objectId` alone (see `PathOffsetTrack`'s doc), so there's only ever one per object.
    | { kind: 'pathOffset'; objectId: string; keyframes: NonNullable<typeof activeClip.pathOffsetTracks>[number]['keyframes'] }
    // Same idea as `pathOffset`, for Follow Path's `progress` (see `FollowPathProgressTrack`'s doc).
    | {
        kind: 'followPathProgress'
        objectId: string
        keyframes: NonNullable<typeof activeClip.followPathProgressTracks>[number]['keyframes']
      }
  const rowObjectIds: string[] = []
  for (const t of activeClip.tracks) rowObjectIds.push(t.objectId)
  for (const t of activeClip.shapeKeyTracks ?? []) {
    if (!rowObjectIds.includes(t.objectId)) rowObjectIds.push(t.objectId)
  }
  for (const o of objects) {
    if (getFakeFlag(o)?.enabled && !rowObjectIds.includes(o.id)) rowObjectIds.push(o.id)
  }
  for (const t of activeClip.fakePhysicsTracks ?? []) {
    if (!rowObjectIds.includes(t.objectId)) rowObjectIds.push(t.objectId)
  }
  for (const t of activeClip.fakePhysicsMeshTracks ?? []) {
    if (!rowObjectIds.includes(t.objectId)) rowObjectIds.push(t.objectId)
  }
  for (const t of activeClip.oscillatorTracks ?? []) {
    if (!rowObjectIds.includes(t.objectId)) rowObjectIds.push(t.objectId)
  }
  for (const t of activeClip.pathOffsetTracks ?? []) {
    if (!rowObjectIds.includes(t.objectId)) rowObjectIds.push(t.objectId)
  }
  for (const t of activeClip.followPathProgressTracks ?? []) {
    if (!rowObjectIds.includes(t.objectId)) rowObjectIds.push(t.objectId)
  }
  const rows: Row[] = []
  for (const objectId of rowObjectIds) {
    const t = activeClip.tracks.find((tt) => tt.objectId === objectId)
    if (t) rows.push({ kind: 'transform', objectId, keyframes: t.keyframes })
    const obj = objects.find((o) => o.id === objectId)
    for (const skt of (activeClip.shapeKeyTracks ?? []).filter((s) => s.objectId === objectId)) {
      const keyName = obj?.shapeKeys?.find((k) => k.id === skt.shapeKeyId)?.name ?? '(deleted shape key)'
      rows.push({ kind: 'shapeKey', objectId, shapeKeyId: skt.shapeKeyId, keyName, keyframes: skt.keyframes })
    }
    if (obj && getFakeFlag(obj)?.enabled) rows.push({ kind: 'fakeFlag', objectId })
    if ((activeClip.fakePhysicsTracks ?? []).some((ft) => ft.objectId === objectId)) {
      rows.push({ kind: 'fakePhysicsBaked', objectId })
    }
    if ((activeClip.fakePhysicsMeshTracks ?? []).some((ft) => ft.objectId === objectId)) {
      rows.push({ kind: 'fakePhysicsMeshBaked', objectId })
    }
    if ((activeClip.oscillatorTracks ?? []).some((ot) => ot.objectId === objectId)) {
      rows.push({ kind: 'oscillatorBaked', objectId })
    }
    const pot = (activeClip.pathOffsetTracks ?? []).find((pt) => pt.objectId === objectId)
    if (pot) rows.push({ kind: 'pathOffset', objectId, keyframes: pot.keyframes })
    const fppt = (activeClip.followPathProgressTracks ?? []).find((pt) => pt.objectId === objectId)
    if (fppt) rows.push({ kind: 'followPathProgress', objectId, keyframes: fppt.keyframes })
  }

  // true for the one row `pendingDuplicate` targets — that row draws the "click to drop" ghost
  // keyframe at `duplicateHoverTime` instead of the placement affecting every row on the object.
  const isPendingDuplicateRow = (row: Row): boolean => {
    if (!pendingDuplicate || row.objectId !== pendingDuplicate.objectId) return false
    if (row.kind === 'shapeKey') return row.shapeKeyId === pendingDuplicate.shapeKeyId
    if (row.kind === 'pathOffset') return pendingDuplicate.isPathOffset
    if (row.kind === 'followPathProgress') return pendingDuplicate.isFollowPathProgress
    if (row.kind === 'transform') return !pendingDuplicate.shapeKeyId && !pendingDuplicate.isPathOffset && !pendingDuplicate.isFollowPathProgress
    return false
  }

  const rowKey = (row: Row): string =>
    row.kind === 'transform'
      ? `t-${row.objectId}`
      : row.kind === 'shapeKey'
        ? `sk-${row.objectId}-${row.shapeKeyId}`
        : row.kind === 'fakeFlag'
          ? `ff-${row.objectId}`
          : row.kind === 'fakePhysicsBaked'
            ? `fpb-${row.objectId}`
            : row.kind === 'pathOffset'
              ? `po-${row.objectId}`
              : row.kind === 'followPathProgress'
                ? `fpp-${row.objectId}`
                : row.kind === 'oscillatorBaked'
                  ? `osc-${row.objectId}`
                  : `fpmb-${row.objectId}`

  // rows that actually hold real hand-authored keyframes (as opposed to `fakeFlag`/baked-physics
  // rows, which have none) — used by box-select and the group-drag start-time snapshot.
  type KeyedRow = Extract<Row, { kind: 'transform' | 'shapeKey' | 'pathOffset' | 'followPathProgress' }>
  const keyedRows = rows.filter(
    (row): row is KeyedRow =>
      row.kind === 'transform' || row.kind === 'shapeKey' || row.kind === 'pathOffset' || row.kind === 'followPathProgress',
  )

  // syncs the single-key inspector's metadata to `keyframeId` on `row` — used by a plain click and
  // by box-select whenever it lands on exactly one key.
  const selectKeyframe = (row: KeyedRow, keyframeId: string) => {
    selectObject(row.objectId)
    setSelectedKeyObjectId(row.objectId)
    setSelectedKeyShapeKeyId(row.kind === 'shapeKey' ? row.shapeKeyId : null)
    setSelectedKeyIsPathOffset(row.kind === 'pathOffset')
    setSelectedKeyIsFollowPathProgress(row.kind === 'followPathProgress')
    setSelectedKeyId(keyframeId)
  }

  // clicking empty space (no keyframe under the pointer) anywhere in the ruler/grid or track area
  // deselects every keyframe — same "click empty space to deselect" convention as the viewport.
  const clearKeySelection = () => {
    setSelectedKeyId(null)
    setSelectedKeyObjectId(null)
    setSelectedKeyShapeKeyId(null)
    setSelectedKeyIsPathOffset(false)
    setSelectedKeyIsFollowPathProgress(false)
    setSelectedKeyIds(new Set())
  }

  return (
    <div
      className="panel timeline"
      style={style}
      onContextMenu={(e) => {
        // Blender-style: right-click cancels the in-progress operation, same convention as the
        // viewport's drag-cancel — here that's an in-progress duplicate placement or box-select.
        if (!pendingDuplicate && !boxSelect) return
        e.preventDefault()
        setPendingDuplicate(null)
        setDuplicateHoverTime(null)
        setBoxSelect(null)
      }}
    >
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
          <TrashIcon size={14} />
        </button>
        <label className="seg-input">
          Duration (s)
          <NumberInput min={0} step={0.1} value={duration} onCommit={(v) => setClipDuration(activeClip.id, v)} />
        </label>
        <label className="seg-input">
          Loop
          <select
            value={activeClip.loopMode}
            onChange={(e) => setClipLoopMode(activeClip.id, e.target.value as LoopMode)}
          >
            <option value="none">None</option>
            <option value="replay">None - Replay</option>
            <option value="loop">Loop</option>
            <option value="pingpong">Ping-pong</option>
          </select>
        </label>
        <label className="seg-input" title="Snapping/display granularity for the timeline (the time axis itself stays seconds-based)">
          Frame rate
          <NumberInput min={1} step={1} value={frameRate} onCommit={(v) => setClipFrameRate(activeClip.id, Math.round(v))} />
        </label>
        <div className="timeline-transport">
          <button className="timeline-transport-btn" title="Jump to start" onClick={() => setPlayhead(0)}>
            <JumpToStartIcon size={16} />
          </button>
          <button
            className="timeline-transport-btn"
            title="Jump to previous keyframe (selected object)"
            disabled={!selectedObjectId || prevKeyframeTime() === undefined}
            onClick={() => {
              const t = prevKeyframeTime()
              if (t !== undefined) setPlayhead(t)
            }}
          >
            <JumpToPrevFrameIcon size={16} />
          </button>
          <button className={`timeline-transport-btn play${isPlaying ? ' active' : ''}`} title={isPlaying ? 'Pause' : 'Play'} onClick={() => setIsPlaying((p) => !p)}>
            {isPlaying ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
          </button>
          <button
            className="timeline-transport-btn"
            title="Jump to next keyframe (selected object)"
            disabled={!selectedObjectId || nextKeyframeTime() === undefined}
            onClick={() => {
              const t = nextKeyframeTime()
              if (t !== undefined) setPlayhead(t)
            }}
          >
            <JumpToNextFrameIcon size={16} />
          </button>
          <button className="timeline-transport-btn" title="Jump to end" onClick={() => setPlayhead(duration)}>
            <JumpToEndIcon size={16} />
          </button>
        </div>
        <label className="seg-input">
          Time (s)
          <NumberInput min={0} step={1 / frameRate} value={playheadTime} onCommit={(v) => setPlayhead(snapToFrame(v))} />
        </label>
        <span className="timeline-frame-readout">frame {Math.round(playheadTime * frameRate)}</span>
        <button
          className="bake-all"
          title="Simulate and bake every Fake Physics chain (object-chain and mesh) in the scene against this clip — always safe to re-run, since baking is fully deterministic from each modifier's current settings"
          onClick={() => bakeAllFakePhysics()}
        >
          Bake All
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
        <div className="timeline-channel-list" style={{ width: channelListWidth }}>
          <div className="timeline-channel-list-header">
            <button
              className="timeline-insert-keyframe-btn"
              disabled={!selectedObjectId}
              title={selectedObjectId ? 'Insert keyframe at playhead' : 'Select an object first'}
              onClick={() => selectedObjectId && insertKeyframe(selectedObjectId, snapToFrame(playheadTime))}
            >
              <AddKeyframeIcon size={14} />
            </button>
            <button
              className="timeline-insert-keyframe-btn"
              disabled={!selectedObjectId || !transformKeyframeAtPlayhead()}
              title={
                selectedObjectId
                  ? 'Duplicate the Transform keyframe at the playhead — click a frame on the timeline to place the copy'
                  : 'Select an object first'
              }
              onClick={() => {
                const key = transformKeyframeAtPlayhead()
                if (!selectedObjectId || !key) return
                setPendingDuplicate({
                  sourceKeyframeId: key.id,
                  objectId: selectedObjectId,
                  shapeKeyId: null,
                  isPathOffset: false,
                  isFollowPathProgress: false,
                })
                setDuplicateHoverTime(key.time)
              }}
            >
              <DuplicateKeyframeIcon size={14} />
            </button>
          </div>
          {rows.map((row) => {
            if (row.kind === 'transform') {
              const obj = objects.find((o) => o.id === row.objectId)
              return (
                <div
                  key={`t-${row.objectId}`}
                  className={'timeline-channel-name' + (row.objectId === selectedObjectId ? ' selected' : '')}
                  title={obj?.name ?? '(deleted object)'}
                  onClick={() => selectObject(row.objectId)}
                >
                  {obj?.name ?? '(deleted object)'}
                </div>
              )
            }
            if (row.kind === 'shapeKey') {
              return (
                <div
                  key={`sk-${row.objectId}-${row.shapeKeyId}`}
                  className={'timeline-channel-name timeline-channel-subrow' + (row.objectId === selectedObjectId ? ' selected' : '')}
                  title={row.keyName}
                  onClick={() => selectObject(row.objectId)}
                >
                  ↳ {row.keyName}
                </div>
              )
            }
            // Fake Flag/Fake Physics have no user-facing keyframe track of their own — if this
            // object also has a Transform track, this is a sub-row under that row's name (like a
            // shape key); otherwise it's the only row for this object, so it needs the object's
            // own name to say which object it is.
            const hasTransformRow = activeClip.tracks.some((t) => t.objectId === row.objectId)
            const obj = objects.find((o) => o.id === row.objectId)
            if (row.kind === 'fakeFlag') {
              return (
                <div
                  key={`ff-${row.objectId}`}
                  className={'timeline-channel-name' + (hasTransformRow ? ' timeline-channel-subrow' : '') + (row.objectId === selectedObjectId ? ' selected' : '')}
                  title="Fake Flag — a procedural sin-wave sway driven directly by time, not keyframes"
                  onClick={() => selectObject(row.objectId)}
                >
                  {hasTransformRow ? '↳ Fake Flag' : `${obj?.name ?? '(deleted object)'} — Fake Flag`}
                </div>
              )
            }
            if (row.kind === 'fakePhysicsBaked') {
              return (
                <div
                  key={`fpb-${row.objectId}`}
                  className={'timeline-channel-name' + (hasTransformRow ? ' timeline-channel-subrow' : '') + (row.objectId === selectedObjectId ? ' selected' : '')}
                  title="Fake Physics — baked, dense keyframes from a spring simulation. Regenerate via the Properties panel, not by hand."
                  onClick={() => selectObject(row.objectId)}
                >
                  {hasTransformRow ? '↳ Fake Physics (baked)' : `${obj?.name ?? '(deleted object)'} — Fake Physics (baked)`}
                </div>
              )
            }
            if (row.kind === 'pathOffset') {
              return (
                <div
                  key={`po-${row.objectId}`}
                  className={'timeline-channel-name timeline-channel-subrow' + (row.objectId === selectedObjectId ? ' selected' : '')}
                  title="Path Deform — Path Offset"
                  onClick={() => selectObject(row.objectId)}
                >
                  ↳ Path Offset
                </div>
              )
            }
            if (row.kind === 'followPathProgress') {
              return (
                <div
                  key={`fpp-${row.objectId}`}
                  className={'timeline-channel-name timeline-channel-subrow' + (row.objectId === selectedObjectId ? ' selected' : '')}
                  title="Follow Path — Progress"
                  onClick={() => selectObject(row.objectId)}
                >
                  ↳ Progress
                </div>
              )
            }
            if (row.kind === 'oscillatorBaked') {
              return (
                <div
                  key={`osc-${row.objectId}`}
                  className={'timeline-channel-name' + (hasTransformRow ? ' timeline-channel-subrow' : '') + (row.objectId === selectedObjectId ? ' selected' : '')}
                  title="Oscillator — baked, dense keyframes from the Oscilloscope window's sine wave. Regenerate via 'Add Keyframe' there, not by hand."
                  onClick={() => selectObject(row.objectId)}
                >
                  {hasTransformRow ? '↳ Oscillator (baked)' : `${obj?.name ?? '(deleted object)'} — Oscillator (baked)`}
                </div>
              )
            }
            return (
              <div
                key={`fpmb-${row.objectId}`}
                className={'timeline-channel-name' + (hasTransformRow ? ' timeline-channel-subrow' : '') + (row.objectId === selectedObjectId ? ' selected' : '')}
                title="Fake Physics (Mesh) — baked, dense keyframes from a spring simulation over 5 vertex sections. Regenerate via the Properties panel, not by hand."
                onClick={() => selectObject(row.objectId)}
              >
                {hasTransformRow ? '↳ Fake Physics (mesh, baked)' : `${obj?.name ?? '(deleted object)'} — Fake Physics (mesh, baked)`}
              </div>
            )
          })}
          {rows.length === 0 && (
            <div className="timeline-channel-name empty-hint">No keyframed objects yet</div>
          )}
        </div>
        <div className="timeline-channel-list-resizer" onPointerDown={startChannelListResize} />

        <div className="timeline-scroll" ref={scrollRef}>
          <div
            className="timeline-playhead"
            style={{ left: RULER_OFFSET_PX + playheadTime * pxPerSecond }}
            onPointerDown={(e) => {
              e.stopPropagation()
              if (e.button === 2) return
              draggingPlayheadRef.current = true
              seekFromClientX(e.clientX)
              try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* ignore */ }
            }}
            onPointerMove={(e) => {
              if (!draggingPlayheadRef.current) return
              seekFromClientX(e.clientX)
            }}
            onPointerUp={(e) => {
              draggingPlayheadRef.current = false
              try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* ignore */ }
            }}
          >
            <PlayheadIcon size={16} />
          </div>
          <div className="timeline-ruler" style={{ width: contentWidth }} onPointerDown={() => clearKeySelection()}>
            {ticks.map((t) => (
              <div key={t} className="timeline-tick" style={{ left: RULER_OFFSET_PX + t * pxPerSecond }}>
                <span>{t.toFixed(tickInterval < 1 ? 2 : 0)}s</span>
              </div>
            ))}
          </div>
          <div className="timeline-frame-ruler" style={{ width: contentWidth }} onPointerDown={() => clearKeySelection()}>
            {frameTicks.map((f) => (
              <div key={f} className="timeline-tick" style={{ left: RULER_OFFSET_PX + (f / frameRate) * pxPerSecond }}>
                <span>{f}</span>
              </div>
            ))}
          </div>
          <div
            className={'timeline-rows' + (pendingDuplicate ? ' placing-duplicate' : '')}
            ref={trackRef}
            style={{ width: contentWidth }}
            onPointerDown={(e) => {
              // right-click is this app's cancel gesture (see the panel's `onContextMenu`) — a
              // placement click must be button 0, otherwise the duplicate would get committed
              // here before the `contextmenu` event even has a chance to cancel it.
              if (e.button === 2) return
              if (pendingDuplicate) {
                const rect = trackRef.current?.getBoundingClientRect()
                if (rect) commitDuplicate(snapToFrame(xToTime(e.clientX - rect.left)))
                return
              }
              if ((e.target as HTMLElement).closest('.timeline-keyframe')) return
              // Shift+drag on empty track space starts a rubber-band keyframe box-select instead
              // of the usual click-drag-to-scrub (a plain drag here still scrubs, unchanged).
              if (e.shiftKey) {
                setBoxSelect({ startX: e.clientX, startY: e.clientY, curX: e.clientX, curY: e.clientY })
                try {
                  e.currentTarget.setPointerCapture(e.pointerId)
                } catch {
                  /* ignore */
                }
                return
              }
              clearKeySelection()
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
              if (pendingDuplicate) {
                const rect = trackRef.current?.getBoundingClientRect()
                if (rect) setDuplicateHoverTime(snapToFrame(xToTime(e.clientX - rect.left)))
                return
              }
              if (boxSelect) {
                setBoxSelect((b) => (b ? { ...b, curX: e.clientX, curY: e.clientY } : b))
                return
              }
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
              if (!boxSelect) return
              const box = boxSelect
              setBoxSelect(null)
              const x0 = Math.min(box.startX, box.curX)
              const x1 = Math.max(box.startX, box.curX)
              const y0 = Math.min(box.startY, box.curY)
              const y1 = Math.max(box.startY, box.curY)
              // a near-zero-size box is just a Shift+click that didn't drag — nothing to select
              if (x1 - x0 < 3 && y1 - y0 < 3) return
              const picked = new Set(selectedKeyIds)
              for (const row of keyedRows) {
                const rowEl = rowRefs.current.get(rowKey(row))
                if (!rowEl) continue
                const r = rowEl.getBoundingClientRect()
                if (r.bottom < y0 || r.top > y1) continue
                for (const kf of row.keyframes) {
                  const kx = r.left + RULER_OFFSET_PX + kf.time * pxPerSecond
                  if (kx >= x0 && kx <= x1) picked.add(kf.id)
                }
              }
              setSelectedKeyIds(picked)
              if (picked.size === 1) {
                const onlyId = [...picked][0]
                for (const row of keyedRows) {
                  if (row.keyframes.some((k) => k.id === onlyId)) {
                    selectKeyframe(row, onlyId)
                    break
                  }
                }
              }
            }}
          >
            {frameGridlines.map((f) => (
              <div key={`fg-${f}`} className="timeline-gridline frame" style={{ left: RULER_OFFSET_PX + (f / frameRate) * pxPerSecond }} />
            ))}
            {rows.map((row) => (
              <div
                key={rowKey(row)}
                ref={(el) => {
                  if (el) rowRefs.current.set(rowKey(row), el)
                  else rowRefs.current.delete(rowKey(row))
                }}
                className={
                  'timeline-track-row' +
                  (row.kind === 'fakeFlag' ? ' fake-flag' : '') +
                  (row.kind === 'fakePhysicsBaked' || row.kind === 'fakePhysicsMeshBaked' ? ' fake-physics-baked' : '') +
                  (row.kind === 'oscillatorBaked' ? ' oscillator-baked' : '') +
                  (row.objectId === selectedObjectId ? ' selected' : '')
                }
              >
                {row.kind === 'fakeFlag' ? (
                  <span className="timeline-fake-flag-label" title="Procedural — driven directly by time, nothing to key">
                    ≈ sin wave, no keyframes
                  </span>
                ) : row.kind === 'oscillatorBaked' ? (
                  <span className="timeline-oscillator-label" title="Baked Oscillator sine wave — dense, machine-generated keyframes. Regenerate via the Oscilloscope window, not by hand.">
                    ● baked oscillator
                  </span>
                ) : row.kind === 'fakePhysicsBaked' ? (
                  <span className="timeline-fake-physics-label" title="Baked spring simulation — dense, machine-generated keyframes. Regenerate via Properties, not by hand.">
                    ● baked physics
                  </span>
                ) : row.kind === 'fakePhysicsMeshBaked' ? (
                  <span className="timeline-fake-physics-label" title="Baked spring simulation over 5 vertex sections — dense, machine-generated keyframes. Regenerate via Properties, not by hand.">
                    ● baked physics (mesh)
                  </span>
                ) : (
                  row.keyframes.map((k) => (
                    <div
                      key={k.id}
                      className={'timeline-keyframe' + (selectedKeyIds.has(k.id) ? ' selected' : '')}
                      style={{ left: RULER_OFFSET_PX + k.time * pxPerSecond }}
                      title={
                        row.kind === 'transform'
                          ? `${objects.find((o) => o.id === row.objectId)?.name ?? row.objectId}: t=${k.time.toFixed(2)}s, ${k.easing}`
                          : row.kind === 'pathOffset'
                            ? `Path Offset: t=${k.time.toFixed(2)}s, ${k.easing}`
                            : row.kind === 'followPathProgress'
                              ? `Progress: t=${k.time.toFixed(2)}s, ${k.easing}`
                              : `${row.keyName}: t=${k.time.toFixed(2)}s, ${k.easing}`
                      }
                      onPointerDown={(e) => {
                        e.stopPropagation()
                        if (e.button === 2) return
                        if (pendingDuplicate) {
                          const rect = trackRef.current?.getBoundingClientRect()
                          if (rect) commitDuplicate(snapToFrame(xToTime(e.clientX - rect.left)))
                          return
                        }
                        // Shift+click toggles this key in/out of the multi-selection — no drag,
                        // matching a typical dope sheet (drag-to-move is a plain click instead).
                        if (e.shiftKey) {
                          setSelectedKeyIds((prev) => {
                            const next = new Set(prev)
                            if (next.has(k.id)) next.delete(k.id)
                            else next.add(k.id)
                            return next
                          })
                          return
                        }
                        // a plain click on a key that's already part of a >1-key selection keeps
                        // the whole selection (and drags it as a group); otherwise it replaces the
                        // selection with just this key.
                        const nextSelection = selectedKeyIds.has(k.id) && selectedKeyIds.size > 1 ? selectedKeyIds : new Set([k.id])
                        selectKeyframe(row, k.id)
                        setSelectedKeyIds(nextSelection)
                        const startTimes = new Map<string, number>()
                        for (const kr of keyedRows) {
                          for (const kf of kr.keyframes) {
                            if (nextSelection.has(kf.id)) startTimes.set(kf.id, kf.time)
                          }
                        }
                        groupDragRef.current = { anchorStartTime: k.time, startTimes }
                        draggingKeyRef.current = k.id
                        beginChange()
                        e.currentTarget.setPointerCapture(e.pointerId)
                      }}
                      onPointerMove={(e) => {
                        if (draggingKeyRef.current !== k.id) return
                        const rect = trackRef.current?.getBoundingClientRect()
                        if (!rect) return
                        const time = snapToFrame(xToTime(e.clientX - rect.left))
                        const drag = groupDragRef.current
                        if (drag && drag.startTimes.size > 1) {
                          const delta = time - drag.anchorStartTime
                          setKeyframesTimeLive(
                            Array.from(drag.startTimes.entries()).map(([id, startTime]) => ({
                              keyframeId: id,
                              time: clampTime(startTime + delta),
                            })),
                          )
                        } else if (row.kind === 'transform') setKeyframeTime(row.objectId, k.id, time)
                        else if (row.kind === 'pathOffset') setPathOffsetKeyframeTime(row.objectId, k.id, time)
                        else if (row.kind === 'followPathProgress') setFollowPathProgressKeyframeTime(row.objectId, k.id, time)
                        else setShapeKeyKeyframeTime(row.objectId, row.shapeKeyId, k.id, time)
                      }}
                      onPointerUp={() => {
                        draggingKeyRef.current = null
                        groupDragRef.current = null
                      }}
                    />
                  ))
                )}
                {isPendingDuplicateRow(row) && duplicateHoverTime !== null && (
                  <div
                    className="timeline-keyframe ghost"
                    style={{ left: RULER_OFFSET_PX + duplicateHoverTime * pxPerSecond }}
                  />
                )}
              </div>
            ))}
            {rows.length === 0 && <div className="timeline-track-row empty" />}
            {boxSelect && (
              <div
                className="timeline-box-select"
                style={{
                  left: Math.min(boxSelect.startX, boxSelect.curX),
                  top: Math.min(boxSelect.startY, boxSelect.curY),
                  width: Math.abs(boxSelect.curX - boxSelect.startX),
                  height: Math.abs(boxSelect.curY - boxSelect.startY),
                }}
              />
            )}
          </div>
        </div>
      </div>

      {selectedKeyId && selectedKeyObjectId && (
        <div className="timeline-keyframe-inspector">
          {(() => {
            const shapeKeyId = selectedKeyShapeKeyId
            const isPathOffset = selectedKeyIsPathOffset
            const isFollowPathProgress = selectedKeyIsFollowPathProgress
            const key = shapeKeyId
              ? (activeClip.shapeKeyTracks ?? [])
                  .find((t) => t.objectId === selectedKeyObjectId && t.shapeKeyId === shapeKeyId)
                  ?.keyframes.find((k) => k.id === selectedKeyId)
              : isPathOffset
                ? (activeClip.pathOffsetTracks ?? [])
                    .find((t) => t.objectId === selectedKeyObjectId)
                    ?.keyframes.find((k) => k.id === selectedKeyId)
                : isFollowPathProgress
                  ? (activeClip.followPathProgressTracks ?? [])
                      .find((t) => t.objectId === selectedKeyObjectId)
                      ?.keyframes.find((k) => k.id === selectedKeyId)
                  : activeClip.tracks.find((t) => t.objectId === selectedKeyObjectId)?.keyframes.find((k) => k.id === selectedKeyId)
            if (!key) return null
            return (
              <>
                <span>Keyframe @ {key.time.toFixed(2)}s</span>
                <label className="seg-input">
                  Easing
                  <select
                    value={key.easing}
                    onChange={(e) => {
                      const easing = e.target.value as EasingType
                      if (shapeKeyId) setShapeKeyKeyframeEasing(selectedKeyObjectId, shapeKeyId, key.id, easing)
                      else if (isPathOffset) setPathOffsetKeyframeEasing(selectedKeyObjectId, key.id, easing)
                      else if (isFollowPathProgress) setFollowPathProgressKeyframeEasing(selectedKeyObjectId, key.id, easing)
                      else setKeyframeEasing(selectedKeyObjectId, key.id, easing)
                    }}
                  >
                    {EASING_OPTIONS.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  title="Duplicate this keyframe — click a frame on the timeline to place the copy"
                  onClick={() => {
                    setPendingDuplicate({
                      sourceKeyframeId: key.id,
                      objectId: selectedKeyObjectId,
                      shapeKeyId,
                      isPathOffset,
                      isFollowPathProgress,
                    })
                    setDuplicateHoverTime(key.time)
                  }}
                >
                  <DuplicateKeyframeIcon size={14} /> Duplicate keyframe
                </button>
                <button
                  title="Delete this keyframe"
                  onClick={() => {
                    if (shapeKeyId) removeShapeKeyKeyframe(selectedKeyObjectId, shapeKeyId, key.id)
                    else if (isPathOffset) removePathOffsetKeyframe(selectedKeyObjectId, key.id)
                    else if (isFollowPathProgress) removeFollowPathProgressKeyframe(selectedKeyObjectId, key.id)
                    else removeKeyframe(selectedKeyObjectId, key.id)
                    clearKeySelection()
                  }}
                >
                  <TrashIcon size={14} /> Delete keyframe
                </button>
              </>
            )
          })()}
        </div>
      )}
    </div>
  )
}
