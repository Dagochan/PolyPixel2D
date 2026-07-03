import { sampleTrack } from './animation'
import { applyConvergence, simulateSpring, stepSpring, stiffnessToSpringParams, type FakePhysicsSignal } from './fakePhysics'
import type { AnimationClip, FakePhysicsMeshSettings, FakePhysicsMeshTrack, Modifier, SceneObject, Transform, Vec2 } from './types'

export const DEFAULT_FAKE_PHYSICS_MESH_SETTINGS: FakePhysicsMeshSettings = {
  enabled: true,
  stiffnessMode: 'simple',
  sectionStiffness: [1, 1, 1, 1, 1],
  convergeStart: 0.7,
  pivotMode: 'head',
  sectionVertices: [[], [], [], [], []],
}

/** This object's Fake Physics (mesh) settings, if it has that modifier in its stack — `undefined`
 *  otherwise. Mirrors `getFakePhysics`/`getFakeFlag`'s role for their own modifiers. */
export function getFakePhysicsMesh(obj: SceneObject): FakePhysicsMeshSettings | undefined {
  return obj.modifiers?.find((m): m is Extract<Modifier, { type: 'fakePhysicsMesh' }> => m.type === 'fakePhysicsMesh')
    ?.settings
}

const SECTIONS = [1, 2, 3, 4, 5] as const
export type FakePhysicsMeshSection = (typeof SECTIONS)[number]

/** Simulates this object's 5-section chain (see `FakePhysicsMeshSettings`): the object's own raw
 *  x/y/rotation (from its `tracks` entry, or its static pose if it has none) is the thing Section 1
 *  lags behind; Section 2 then lags Section 1, Section 3 lags Section 2, and so on — every section
 *  is a real damped-spring stage with its own stiffness, cascading exactly like
 *  `simulateFakePhysicsChain`'s parent/child walk, just within one object's 5 fixed sections
 *  instead of a real object chain. (At the default stiffness of 1/rigid, a section tracks whatever
 *  it's following exactly — so Section 1 defaulting to rigid reproduces the "ROOT just *is* the
 *  object's motion" behavior of an earlier version, as a special case rather than a hardcoded rule.)
 *
 *  Returns each section's *offset* from the object's own raw signal (not its absolute value) —
 *  what actually gets applied on top of the object's own motion at render/bake time, since the
 *  object's transform already carries that motion for every vertex regardless of section. Pure —
 *  no store writes; the caller (`bakeFakePhysicsMesh`) turns this into `FakePhysicsMeshTrack`s. */
export function simulateFakePhysicsMeshSections(
  obj: SceneObject,
  clip: AnimationClip,
): Map<FakePhysicsMeshSection, FakePhysicsSignal> {
  const results = new Map<FakePhysicsMeshSection, FakePhysicsSignal>()
  const settings = getFakePhysicsMesh(obj)
  if (!settings?.enabled || clip.duration <= 0 || clip.frameRate <= 0) return results

  const frameCount = Math.max(1, Math.round(clip.duration * clip.frameRate))
  const dt = 1 / clip.frameRate
  const cycle = clip.loopMode === 'loop' ? { duration: clip.duration } : undefined
  const track = clip.tracks.find((t) => t.objectId === obj.id)

  const rootSignal: FakePhysicsSignal = { x: [], y: [], rotation: [] }
  for (let f = 0; f <= frameCount; f++) {
    const time = (f / frameCount) * clip.duration
    const sampled = track ? sampleTrack(track, time, cycle) : null
    const t = sampled ?? obj.transform
    rootSignal.x.push(t.x)
    rootSignal.y.push(t.y)
    rootSignal.rotation.push(t.rotation)
  }

  let previous = rootSignal
  SECTIONS.forEach((section, i) => {
    const springParams = stiffnessToSpringParams(settings.sectionStiffness[i])
    const spring = (target: number[]) =>
      applyConvergence(simulateSpring(target, dt, springParams), settings.convergeStart)
    const simulated: FakePhysicsSignal = {
      x: spring(previous.x),
      y: spring(previous.y),
      rotation: spring(previous.rotation),
    }
    results.set(section, {
      x: simulated.x.map((v, f) => v - rootSignal.x[f]),
      y: simulated.y.map((v, f) => v - rootSignal.y[f]),
      rotation: simulated.rotation.map((v, f) => v - rootSignal.rotation[f]),
    })
    // the next section cascades off this section's ABSOLUTE simulated signal, not its offset —
    // matches the object-chain version's child-follows-parent's-actual-signal behavior
    previous = simulated
  })

  return results
}

function sectionCentroid(obj: SceneObject, vertexIndices: number[]): Vec2 {
  const verts = vertexIndices.map((i) => obj.mesh.vertices[i]).filter((v): v is Vec2 => !!v)
  if (verts.length === 0) return obj.transform.head
  let x = 0
  let y = 0
  for (const v of verts) {
    x += v.x
    y += v.y
  }
  return { x: x / verts.length, y: y / verts.length }
}

/** One section's lag, applied to a vertex as a rigid rotate-then-translate around a pivot — shared
 *  by both the baked path (`fakePhysicsMeshVertexDeltas`) and the live preview path
 *  (`fakePhysicsMeshVertexDeltasLive`), which differ only in *where* they get this offset from
 *  (a sampled baked keyframe vs. an in-progress live spring simulation). */
function applySectionOffset(v: Vec2, pivot: Vec2, offset: { x: number; y: number; rotation: number }): Vec2 {
  const dx = v.x - pivot.x
  const dy = v.y - pivot.y
  const cos = Math.cos(offset.rotation)
  const sin = Math.sin(offset.rotation)
  const rx = dx * cos - dy * sin
  const ry = dx * sin + dy * cos
  return { x: pivot.x + rx + offset.x - v.x, y: pivot.y + ry + offset.y - v.y }
}

/** Every vertex assigned to a section, mapped to that section number — shared setup for both the
 *  baked and live-preview vertex-delta functions. */
function sectionOfEachVertex(settings: FakePhysicsMeshSettings): Map<number, FakePhysicsMeshSection> {
  const sectionOf = new Map<number, FakePhysicsMeshSection>()
  SECTIONS.forEach((section) => {
    for (const vi of settings.sectionVertices[section - 1]) sectionOf.set(vi, section)
  })
  return sectionOf
}

/** Caches each section's pivot point per `pivotMode` ('head': the object's own Head, shared by
 *  every section; 'centroid': each section's own rest-pose vertex centroid, computed lazily). */
function makePivotResolver(obj: SceneObject, settings: FakePhysicsMeshSettings): (section: FakePhysicsMeshSection) => Vec2 {
  const centroidCache = new Map<FakePhysicsMeshSection, Vec2>()
  return (section) => {
    if (settings.pivotMode === 'head') return obj.transform.head
    const cached = centroidCache.get(section)
    if (cached) return cached
    const c = sectionCentroid(obj, settings.sectionVertices[section - 1])
    centroidCache.set(section, c)
    return c
  }
}

/** Per-vertex (local mesh-space) displacement this object's baked Fake Physics (mesh) sections
 *  contribute at `time` seconds — one entry per `obj.mesh.vertices`, all-zero for a vertex not
 *  assigned to any section or one whose section has no bake yet. `null` when the modifier is
 *  missing/disabled or nothing is baked at all, so callers can skip the per-vertex work entirely
 *  (same convention as `fakeFlagVertexDeltas`). Distances/pivots are always computed from the
 *  Basis (`obj.mesh.vertices`), so this composes predictably as an additive delta on top of shape
 *  keys and Fake Flag. */
export function fakePhysicsMeshVertexDeltas(obj: SceneObject, clip: AnimationClip | undefined, time: number): Vec2[] | null {
  const settings = getFakePhysicsMesh(obj)
  if (!settings?.enabled) return null
  const tracks = (clip?.fakePhysicsMeshTracks ?? []).filter((t) => t.objectId === obj.id)
  if (tracks.length === 0) return null
  const cycle = clip && clip.loopMode === 'loop' ? { duration: clip.duration } : undefined

  const sectionOf = sectionOfEachVertex(settings)
  if (sectionOf.size === 0) return null

  const tracksBySection = new Map<FakePhysicsMeshSection, FakePhysicsMeshTrack>()
  for (const t of tracks) tracksBySection.set(t.section, t)
  const pivotFor = makePivotResolver(obj, settings)

  return obj.mesh.vertices.map((v, i) => {
    const section = sectionOf.get(i)
    const track = section && tracksBySection.get(section)
    if (!track) return { x: 0, y: 0 }
    const sampled = sampleTrack(track, time, cycle)
    if (!sampled) return { x: 0, y: 0 }
    return applySectionOffset(v, pivotFor(section), sampled)
  })
}

/** One lagging section's live (unbaked) spring state — mutated in place, once per real animation
 *  frame, by `stepFakePhysicsMeshLive`. Tracks the section's *absolute* x/y/rotation (not an
 *  offset — the offset is only meaningful relative to whatever the object's live signal is *this*
 *  frame, computed on demand in `fakePhysicsMeshVertexDeltasLive`), since the cascade needs each
 *  section's absolute value as the next section's spring target. */
export interface FakePhysicsMeshLiveSectionState {
  x: number
  y: number
  rotation: number
  vx: number
  vy: number
  vrotation: number
}

/** One object's full live simulation state — index 0 is Section 1 ... index 4 is Section 5. */
export type FakePhysicsMeshLiveState = FakePhysicsMeshLiveSectionState[]

/** A fresh live state with every section starting in sync with the object's current pose (zero
 *  velocity) — matches `simulateSpring`'s "starts exactly at target[0]" convention, so a preview
 *  that's just been turned on doesn't jump/snap on its first frame. */
export function createFakePhysicsMeshLiveState(root: Pick<Transform, 'x' | 'y' | 'rotation'>): FakePhysicsMeshLiveState {
  return SECTIONS.map(() => ({ x: root.x, y: root.y, rotation: root.rotation, vx: 0, vy: 0, vrotation: 0 }))
}

/** Advances a live preview simulation by `dt` real seconds, given the object's actual current
 *  x/y/rotation as the raw signal Section 1 lags behind — mutates `state` in place (cheap enough
 *  to call every rendered frame) and returns it back for convenience/chaining. Unlike `simulateSpring`
 *  (which needs the whole clip's signal known up front, for baking), this only ever needs "now",
 *  so it works for direct-manipulation dragging with no keyframes involved at all. */
export function stepFakePhysicsMeshLive(
  state: FakePhysicsMeshLiveState,
  settings: FakePhysicsMeshSettings,
  root: Pick<Transform, 'x' | 'y' | 'rotation'>,
  dt: number,
): FakePhysicsMeshLiveState {
  let targetX = root.x
  let targetY = root.y
  let targetRotation = root.rotation
  SECTIONS.forEach((_, i) => {
    const ch = state[i]
    const springParams = stiffnessToSpringParams(settings.sectionStiffness[i])
    ;[ch.x, ch.vx] = stepSpring(ch.x, ch.vx, targetX, dt, springParams)
    ;[ch.y, ch.vy] = stepSpring(ch.y, ch.vy, targetY, dt, springParams)
    ;[ch.rotation, ch.vrotation] = stepSpring(ch.rotation, ch.vrotation, targetRotation, dt, springParams)
    targetX = ch.x
    targetY = ch.y
    targetRotation = ch.rotation
  })
  return state
}

/** Same idea as `fakePhysicsMeshVertexDeltas`, but reading each section's offset from a live
 *  (unbaked) simulation state instead of a sampled keyframe — see `stepFakePhysicsMeshLive`. */
export function fakePhysicsMeshVertexDeltasLive(
  obj: SceneObject,
  settings: FakePhysicsMeshSettings,
  state: FakePhysicsMeshLiveState,
  root: Pick<Transform, 'x' | 'y' | 'rotation'>,
): Vec2[] | null {
  const sectionOf = sectionOfEachVertex(settings)
  if (sectionOf.size === 0) return null
  const pivotFor = makePivotResolver(obj, settings)

  return obj.mesh.vertices.map((v, i) => {
    const section = sectionOf.get(i)
    if (!section) return { x: 0, y: 0 }
    const ch = state[section - 1]
    const offset = { x: ch.x - root.x, y: ch.y - root.y, rotation: ch.rotation - root.rotation }
    return applySectionOffset(v, pivotFor(section), offset)
  })
}
