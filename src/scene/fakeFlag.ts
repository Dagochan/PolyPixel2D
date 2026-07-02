import { getWorldTransform } from './transformUtils'
import type { FakeFlagSettings, SceneObject, Vec2 } from './types'

/** This object's Fake Flag settings, if it has that modifier in its stack (see `Modifier`) —
 *  `undefined` otherwise. Every other function in this module takes `obj` (not raw `settings`)
 *  precisely so this lookup lives in exactly one place. */
export function getFakeFlag(obj: SceneObject): FakeFlagSettings | undefined {
  return obj.modifiers?.find((m): m is Extract<typeof m, { type: 'fakeFlag' }> => m.type === 'fakeFlag')?.settings
}

const TAU = Math.PI * 2

export const DEFAULT_FAKE_FLAG_SETTINGS: FakeFlagSettings = {
  enabled: true,
  amplitude: 10,
  cyclesPerLoop: 1,
  phase: 0,
  direction: 0,
  wavelength: 100,
  randomStrength: 0,
  seed: 1,
}

/** Anchored vertex mode is enabled iff at least one anchor vertex is assigned. */
export function isFakeFlagVertexMode(settings: FakeFlagSettings | undefined): boolean {
  return !!settings?.anchorVertices?.length
}

/** Deterministic pseudo-random value in [0, 1) for a given (seed, cycle) pair. */
function hashNoise(seed: number, cycleIndex: number): number {
  const h = Math.sin(seed * 127.1 + cycleIndex * 311.7) * 43758.5453
  return h - Math.floor(h)
}

/** `jitter * sin(2*pi*totalPhase)` — a signed value roughly in [-1, 1] the caller scales by its
 *  own amplitude (degrees for rotation mode, world units for vertex mode). `totalPhase` folds in
 *  the time-driven cycle count, the user's `phase` offset, and a caller-supplied spatial phase
 *  (world position for rotation mode, anchor distance for vertex mode). Shared by both Fake Flag
 *  modes so their looping/jitter behavior stays identical. */
function fakeFlagWave(settings: FakeFlagSettings, spatialPhase: number, time: number, loopDuration: number): number {
  const cycleCount = Math.max(1, Math.round(settings.cyclesPerLoop))
  const cyclesElapsed = loopDuration > 0 ? cycleCount * (time / loopDuration) : cycleCount * time
  // spatialPhase MINUS cyclesElapsed (not plus) — sin(kx - wt) is the traveling-wave form whose
  // crests move toward +x (i.e. away from the anchor, the way `direction`'s arrow points) as time
  // increases. The "+" form looks identical at any single instant but visibly runs backwards.
  const totalPhase = spatialPhase - cyclesElapsed + settings.phase

  // Jitter is keyed off the within-loop cycle number (not the raw, ever-growing cycle count) so
  // it repeats identically every loop instead of drifting. It only ever changes right as the base
  // sine crosses zero (an integer `cyclesElapsed`), so the amplitude jump it introduces is inaudible.
  let jitter = 1
  if (settings.randomStrength > 0) {
    const cycleIndex = ((Math.floor(cyclesElapsed) % cycleCount) + cycleCount) % cycleCount
    jitter = 1 + settings.randomStrength * (hashNoise(settings.seed, cycleIndex) * 2 - 1)
  }

  return jitter * Math.sin(totalPhase * TAU)
}

/** Rotation offset (radians) this object's Fake Flag settings contribute at `time` seconds into a
 *  `loopDuration`-second clip, given the object's world head position (used for `direction`/
 *  `wavelength` spatial phase). Pure function of time — nothing to bake or cache. No-op in vertex
 *  (anchored) mode — see `fakeFlagVertexDeltas`. */
export function fakeFlagRotationOffset(
  settings: FakeFlagSettings,
  worldHead: Vec2,
  time: number,
  loopDuration: number,
): number {
  if (!settings.enabled || settings.amplitude === 0 || isFakeFlagVertexMode(settings)) return 0

  const dirRad = (settings.direction * Math.PI) / 180
  const spatialPhase =
    settings.wavelength !== 0
      ? (worldHead.x * Math.cos(dirRad) + worldHead.y * Math.sin(dirRad)) / settings.wavelength
      : 0

  const amplitudeRad = (settings.amplitude * Math.PI) / 180
  return amplitudeRad * fakeFlagWave(settings, spatialPhase, time, loopDuration)
}

/** Every Fake-Flagged (rotation-mode) object in `objects`, with its Fake Flag sway baked into
 *  `transform.rotation` for this instant — everything else passes through unchanged, so parent/
 *  child composition (`getWorldTransform`) naturally carries a swaying parent's motion into its
 *  children. Objects in vertex (anchored) mode are left untouched here — see
 *  `fakeFlagVertexDeltas` instead. Returns `objects` itself when nothing applies (zero-cost,
 *  matches the shape-key precedent). */
export function applyFakeFlagSway(objects: SceneObject[], time: number, loopDuration: number): SceneObject[] {
  if (!objects.some((o) => { const ff = getFakeFlag(o); return ff?.enabled && !isFakeFlagVertexMode(ff) })) return objects
  return objects.map((o) => {
    const ff = getFakeFlag(o)
    if (!ff?.enabled || isFakeFlagVertexMode(ff)) return o
    const worldTransform = getWorldTransform(o, objects)
    const offset = fakeFlagRotationOffset(ff, { x: worldTransform.x, y: worldTransform.y }, time, loopDuration)
    if (offset === 0) return o
    return { ...o, transform: { ...o.transform, rotation: o.transform.rotation + offset } }
  })
}

/** Signed displacement magnitude, along the *transverse* (perpendicular-to-`direction`) axis, for
 *  a point `distanceFromAnchor` mesh units out from the nearest anchor — the shared math behind
 *  both `fakeFlagVertexDeltas` (real mesh vertices) and the viewport's wave-shape indicator
 *  (synthetic sample points along the anchor-to-tip axis). Anchor-to-tip spatial phase (a wave
 *  visibly traveling outward) and falloff (pinned at the anchor, full strength by one `wavelength`
 *  out) both ride on the same distance. */
function fakeFlagTransverseMagnitude(settings: FakeFlagSettings, distanceFromAnchor: number, time: number, loopDuration: number): number {
  const spatialPhase = settings.wavelength !== 0 ? distanceFromAnchor / settings.wavelength : 0
  const falloff = settings.wavelength !== 0 ? Math.min(1, distanceFromAnchor / Math.abs(settings.wavelength)) : 1
  return settings.amplitude * falloff * fakeFlagWave(settings, spatialPhase, time, loopDuration)
}

/** Unit vector perpendicular to `direction` (degrees) — the axis vertices actually displace along.
 *  `direction` itself is the propagation axis (spatial phase runs along it via anchor distance),
 *  not the displacement axis: a flag waves transverse to the wind, like a real one. */
function fakeFlagTransverseAxis(settings: FakeFlagSettings): Vec2 {
  const dirRad = (settings.direction * Math.PI) / 180
  return { x: -Math.sin(dirRad), y: Math.cos(dirRad) }
}

/** Per-vertex (local mesh-space) displacement this object's Fake Flag settings contribute at
 *  `time` seconds into a `loopDuration`-second clip, one entry per `obj.mesh.vertices` — or `null`
 *  when vertex mode doesn't apply (disabled, or no anchors assigned). Distances/falloff are always
 *  computed from the Basis (`obj.mesh.vertices`), not any already-deformed pose, so this composes
 *  predictably as an additive delta on top of e.g. shape keys. */
export function fakeFlagVertexDeltas(obj: SceneObject, time: number, loopDuration: number): Vec2[] | null {
  const settings = getFakeFlag(obj)
  if (!settings?.enabled || !isFakeFlagVertexMode(settings) || settings.amplitude === 0) return null
  const anchors = (settings.anchorVertices ?? [])
    .map((i) => obj.mesh.vertices[i])
    .filter((v): v is Vec2 => !!v)
  if (anchors.length === 0) return null

  const perp = fakeFlagTransverseAxis(settings)

  return obj.mesh.vertices.map((v) => {
    let nearestDist = Infinity
    for (const a of anchors) {
      const d = Math.hypot(v.x - a.x, v.y - a.y)
      if (d < nearestDist) nearestDist = d
    }
    const magnitude = fakeFlagTransverseMagnitude(settings, nearestDist, time, loopDuration)
    return { x: perp.x * magnitude, y: perp.y * magnitude }
  })
}

/** Farthest any of `obj`'s vertices sits from its nearest Fake Flag anchor (0 if unset/no
 *  anchors) — sizes the viewport's wave-shape indicator to the mesh's actual extent. */
export function fakeFlagAnchorExtent(obj: SceneObject): number {
  const settings = getFakeFlag(obj)
  const anchors = (settings?.anchorVertices ?? []).map((i) => obj.mesh.vertices[i]).filter((v): v is Vec2 => !!v)
  if (anchors.length === 0) return 0
  let maxDist = 0
  for (const v of obj.mesh.vertices) {
    let nearestDist = Infinity
    for (const a of anchors) {
      const d = Math.hypot(v.x - a.x, v.y - a.y)
      if (d < nearestDist) nearestDist = d
    }
    if (nearestDist > maxDist) maxDist = nearestDist
  }
  return maxDist
}

/** Sample points (local mesh space) tracing the current wave shape from the anchor centroid out to
 *  `length` mesh units along `direction` — feeds the viewport's indicator curve, which shows the
 *  live wave shape rather than just a static arrow. `sampleCount` points span `[0, length]`. */
export function fakeFlagIndicatorSamples(
  settings: FakeFlagSettings,
  anchorCentroid: Vec2,
  length: number,
  time: number,
  loopDuration: number,
  sampleCount = 24,
): Vec2[] {
  const dirRad = (settings.direction * Math.PI) / 180
  const dir = { x: Math.cos(dirRad), y: Math.sin(dirRad) }
  const perp = fakeFlagTransverseAxis(settings)

  const points: Vec2[] = []
  for (let i = 0; i <= sampleCount; i++) {
    const t = (length * i) / sampleCount
    const magnitude = fakeFlagTransverseMagnitude(settings, t, time, loopDuration)
    points.push({
      x: anchorCentroid.x + dir.x * t + perp.x * magnitude,
      y: anchorCentroid.y + dir.y * t + perp.y * magnitude,
    })
  }
  return points
}
