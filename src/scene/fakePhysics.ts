import { sampleTrack } from './animation'
import type { AnimationClip, FakePhysicsSettings, Modifier, SceneObject } from './types'

export const DEFAULT_FAKE_PHYSICS_SETTINGS: FakePhysicsSettings = {
  enabled: true,
  section: 2,
  stiffness: 0.5,
  convergeStart: 0.7,
}

/** This object's Fake Physics settings, if it has that modifier in its stack — `undefined`
 *  otherwise. Mirrors `getFakeFlag`'s role for the fakeFlag modifier. */
export function getFakePhysics(obj: SceneObject): FakePhysicsSettings | undefined {
  return obj.modifiers?.find((m): m is Extract<Modifier, { type: 'fakePhysics' }> => m.type === 'fakePhysics')
    ?.settings
}

/** Maps the abstracted 0..1 "stiffness" dial to a damped harmonic oscillator's natural frequency
 *  (rad/s) and damping ratio. 1 = rigid: high frequency (near-instant response), critically damped
 *  (no overshoot). 0 = jelly: low frequency (long delay), underdamped (big wobbly overshoot before
 *  settling). */
export function stiffnessToSpringParams(stiffness: number): { omega: number; zeta: number } {
  const s = Math.min(1, Math.max(0, stiffness))
  return { omega: 2 + s * 23, zeta: 0.15 + s * 0.85 }
}

/** Internally sub-steps below this real integration is unstable/oscillates unphysically for stiff
 *  (high omega) springs at typical animation frame rates (24-30fps) — sub-stepping keeps the
 *  simulation's behavior consistent regardless of the clip's frame rate. */
const MIN_SUBSTEP_HZ = 120

/** Damped-spring-follows `target` (one value per frame, e.g. a rotation signal in radians) with
 *  zero initial velocity, starting exactly at `target[0]` — so a section always starts in sync
 *  with what it's following, then lags/overshoots as the target moves. Semi-implicit Euler,
 *  sub-stepped for stability independent of `dt`. */
function simulateSpring(target: number[], dt: number, omega: number, zeta: number): number[] {
  if (target.length === 0) return []
  const result: number[] = new Array(target.length)
  let x = target[0]
  let v = 0
  result[0] = x
  const substeps = Math.max(1, Math.ceil(dt * MIN_SUBSTEP_HZ))
  const subDt = dt / substeps
  for (let i = 1; i < target.length; i++) {
    const t = target[i]
    for (let s = 0; s < substeps; s++) {
      const accel = omega * omega * (t - x) - 2 * zeta * omega * v
      v += accel * subDt
      x += v * subDt
    }
    result[i] = x
  }
  return result
}

/** Blends the tail of `result` (from `convergeStart` fraction of the way through, to the end)
 *  toward `result[0]`, so baking a 'loop' clip doesn't leave a pop at the seam where frame N+1
 *  would otherwise jump back to frame 0's very different simulated value. `convergeStart >= 1`
 *  disables this (the raw simulated tail is kept as-is). */
function applyConvergence(result: number[], convergeStart: number): number[] {
  const n = result.length
  if (convergeStart >= 1 || n < 2) return result
  const startIdx = Math.min(n - 1, Math.max(0, Math.floor(convergeStart * (n - 1))))
  const endValue = result[0]
  const span = Math.max(1, n - 1 - startIdx)
  const out = result.slice()
  for (let i = startIdx; i < n; i++) {
    const t = (i - startIdx) / span
    const w = t * t * (3 - 2 * t) // smoothstep — eases into the convergence instead of a linear kink
    out[i] = out[i] * (1 - w) + endValue * w
  }
  return out
}

/** One channel per frame, for the three independently-sprung Transform channels. */
export interface FakePhysicsSignal {
  x: number[]
  y: number[]
  rotation: number[]
}

/** Simulates a Fake Physics chain rooted at `rootObjectId`: every descendant (via the real
 *  `parentId` hierarchy) that has an enabled `fakePhysics` modifier gets a damped-spring-follow of
 *  its *immediate parent's* x/y/rotation signals — each channel sprung independently with the same
 *  stiffness — cascading down the chain, so delay/overshoot compound the further a section sits
 *  from the root (matching "段階的に追従が遅れる"). Position is local (same space as `rotation`),
 *  so it's only visible for a `connected: false` child — a connected child's local x/y is ignored
 *  at render time regardless of what's baked, so springing it is harmless but moot. A branch stops
 *  the moment a descendant doesn't have the modifier enabled (it and everything under it are left
 *  alone). The root's own signal is read straight from its base `tracks` entry (or its static pose
 *  if it has none) — completely unmodified, since section 1 is the thing everything else lags
 *  behind, not something that itself lags.
 *
 *  Returns one `FakePhysicsSignal` (length `round(clip.duration * clip.frameRate) + 1` per channel,
 *  frame 0 first) per baked descendant object id. Pure — no ids, no store writes; the caller turns
 *  each signal into an `ObjectAnimationTrack`. */
export function simulateFakePhysicsChain(
  objects: SceneObject[],
  clip: AnimationClip,
  rootObjectId: string,
): Map<string, FakePhysicsSignal> {
  const results = new Map<string, FakePhysicsSignal>()
  const root = objects.find((o) => o.id === rootObjectId)
  if (!root || clip.duration <= 0 || clip.frameRate <= 0) return results

  const frameCount = Math.max(1, Math.round(clip.duration * clip.frameRate))
  const dt = 1 / clip.frameRate
  const cycle = clip.loopMode === 'loop' ? { duration: clip.duration } : undefined
  const byParent = new Map<string, SceneObject[]>()
  for (const o of objects) {
    if (!o.parentId) continue
    const list = byParent.get(o.parentId)
    if (list) list.push(o)
    else byParent.set(o.parentId, [o])
  }

  function signalFor(obj: SceneObject): FakePhysicsSignal {
    const track = clip.tracks.find((t) => t.objectId === obj.id)
    const x: number[] = [], y: number[] = [], rotation: number[] = []
    for (let f = 0; f <= frameCount; f++) {
      const time = (f / frameCount) * clip.duration
      const sampled = track ? sampleTrack(track, time, cycle) : null
      const t = sampled ?? obj.transform
      x.push(t.x)
      y.push(t.y)
      rotation.push(t.rotation)
    }
    return { x, y, rotation }
  }

  function walk(current: SceneObject, parentSignal: FakePhysicsSignal) {
    for (const child of byParent.get(current.id) ?? []) {
      const settings = getFakePhysics(child)
      if (!settings?.enabled) continue
      const { omega, zeta } = stiffnessToSpringParams(settings.stiffness)
      const spring = (target: number[]) => applyConvergence(simulateSpring(target, dt, omega, zeta), settings.convergeStart)
      const simulated: FakePhysicsSignal = {
        x: spring(parentSignal.x),
        y: spring(parentSignal.y),
        rotation: spring(parentSignal.rotation),
      }
      results.set(child.id, simulated)
      walk(child, simulated)
    }
  }

  walk(root, signalFor(root))
  return results
}
