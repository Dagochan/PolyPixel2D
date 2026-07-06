import { sampleTrack } from './animation'
import type { AnimationClip, FakePhysicsSettings, Modifier, SceneObject } from './types'

export const DEFAULT_FAKE_PHYSICS_SETTINGS: FakePhysicsSettings = {
  enabled: true,
  stiffness: 0.5,
  convergeStart: 0.7,
}

/** This object's Fake Physics settings, if it has that modifier in its stack — `undefined`
 *  otherwise. Mirrors `getFakeFlag`'s role for the fakeFlag modifier. */
export function getFakePhysics(obj: SceneObject): FakePhysicsSettings | undefined {
  return obj.modifiers?.find((m): m is Extract<Modifier, { type: 'fakePhysics' }> => m.type === 'fakePhysics')
    ?.settings
}

/** `stiffness === 1` is a hard cutoff meaning "fully rigid, no give at all" — handled as a special
 *  case (see `stiffnessToSpringParams`) rather than just a very high `omega`, because a chain of
 *  several sections each with their own *finite* response time compounds: even a per-section delay
 *  as small as ~40ms (the old max) adds up across 4 cascaded sections into a lag that's clearly
 *  visible under fast interactive dragging (each section target-chases an already-lagging target),
 *  even though no single section overshoots. True rigidity needs exactly zero lag per section, not
 *  just a very short one. */
export interface RigidSpring {
  rigid: true
}
export interface DampedSpring {
  rigid: false
  omega: number
  zeta: number
}
export type SpringParams = RigidSpring | DampedSpring

/** Maps the abstracted 0..1 "stiffness" dial to spring parameters: 1 is `{ rigid: true }` (snaps
 *  to its target with zero lag, see `RigidSpring`'s doc). Below that, a damped harmonic
 *  oscillator's natural frequency (rad/s) and damping ratio — lower stiffness means lower
 *  frequency (longer delay) and lower damping (more underdamped, bigger wobbly overshoot before
 *  settling).
 *
 *  `omega`'s curve is a gentle linear ramp (2..25) plus a steep `s^10` term that's negligible below
 *  ~0.8 but rockets up near 1 — so the low/mid range keeps its original, already-tuned "how jelly"
 *  feel, while the last stretch before the `rigid` cutoff ramps up fast enough that there's no
 *  jarring cliff between "barely under 1" and "exactly 1" (an earlier version of this used a flat
 *  linear ramp capped at 25 for the whole range, so 0.99 felt just as wobbly as 0.5 under fast
 *  interactive dragging — see `RigidSpring`'s doc for why that compounds badly across sections).
 *
 *  The public 0..1 dial itself is remapped onto this curve's [0.7, 1] stretch (`DIAL_FLOOR` below)
 *  before any of that — below (this curve's) 0.7, sections are so jelly-soft they're not a usable
 *  setting in practice, just a dead zone at the bottom of the slider. Squeezing the dial into the
 *  stretch that's actually useful means every notch of the slider does something perceptible. */
const DIAL_FLOOR = 0.7

export function stiffnessToSpringParams(stiffness: number): SpringParams {
  const dial = Math.min(1, Math.max(0, stiffness))
  if (dial >= 1) return { rigid: true }
  const s = DIAL_FLOOR + dial * (1 - DIAL_FLOOR)
  const omega = 2 + s * 23 + 220 * Math.pow(s, 10)
  return { rigid: false, omega, zeta: 0.15 + s * 0.85 }
}

/** Floor sub-step rate for low-`omega` springs at typical animation frame rates (24-30fps) —
 *  `stepSpring` also raises this further for high-`omega` springs (see `substepsFor`), since a
 *  fixed rate that was tuned for the old omega<=25 range would under-resolve the much stiffer
 *  springs `stiffnessToSpringParams` can now produce near `stiffness=1`. */
const MIN_SUBSTEP_HZ = 120
/** Caps how many radians of phase a single sub-step may advance through, regardless of `omega` —
 *  keeps the semi-implicit Euler integration accurate (and avoids numerical ringing that would
 *  look like an *artificial* wobble, on top of/instead of the physically-real one) for very stiff
 *  springs, by sub-stepping proportionally more the higher `omega` gets. */
const MAX_RADIANS_PER_SUBSTEP = 0.15

function substepsFor(dt: number, omega: number): number {
  return Math.max(1, Math.ceil(dt * MIN_SUBSTEP_HZ), Math.ceil((dt * omega) / MAX_RADIANS_PER_SUBSTEP))
}

/** Advances one damped-spring value by `dt` seconds toward `target`, sub-stepped for stability
 *  independent of `dt` (see `MIN_SUBSTEP_HZ`) — semi-implicit Euler, or an instant snap for a
 *  `RigidSpring`. The shared core behind both `simulateSpring` (looping this over a whole
 *  pre-known array, for baking) and a live/unbaked preview (calling this once per real animation
 *  frame, for interactive dragging). Returns the new `[value, velocity]` pair. */
export function stepSpring(x: number, v: number, target: number, dt: number, params: SpringParams): [number, number] {
  if (params.rigid) return [target, 0]
  const { omega, zeta } = params
  const substeps = substepsFor(dt, omega)
  const subDt = dt / substeps
  let cx = x
  let cv = v
  for (let s = 0; s < substeps; s++) {
    const accel = omega * omega * (target - cx) - 2 * zeta * omega * cv
    cv += accel * subDt
    cx += cv * subDt
  }
  return [cx, cv]
}

/** Damped-spring-follows `target` (one value per frame, e.g. a rotation signal in radians) with
 *  zero initial velocity, starting exactly at `target[0]` — so a section always starts in sync
 *  with what it's following, then lags/overshoots as the target moves (or, for a `RigidSpring`,
 *  just tracks `target` exactly throughout). */
export function simulateSpring(target: number[], dt: number, params: SpringParams): number[] {
  if (target.length === 0) return []
  if (params.rigid) return target.slice()
  const result: number[] = new Array(target.length)
  let x = target[0]
  let v = 0
  result[0] = x
  for (let i = 1; i < target.length; i++) {
    ;[x, v] = stepSpring(x, v, target[i], dt, params)
    result[i] = x
  }
  return result
}

/** Blends the tail of `result` (from `convergeStart` fraction of the way through, to the end)
 *  toward `result[0]`, so baking a 'loop' clip doesn't leave a pop at the seam where frame N+1
 *  would otherwise jump back to frame 0's very different simulated value. `convergeStart >= 1`
 *  disables this (the raw simulated tail is kept as-is). */
export function applyConvergence(result: number[], convergeStart: number): number[] {
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
      const springParams = stiffnessToSpringParams(settings.stiffness)
      const spring = (target: number[]) => applyConvergence(simulateSpring(target, dt, springParams), settings.convergeStart)
      // the spring must chase (this child's own rest x/y/rotation) + (however much the parent's
      // own channel has moved from ITS rest, i.e. parentSignal[0]) — not the parent's raw signal
      // directly, which would replace the child's own local offset/rotation with a copy of the
      // parent's instead of just lagging behind however the parent itself moves. A parent that
      // only rotates in place (parentSignal.x/y constant) must leave a disconnected child sitting
      // at its own authored offset, not snap it to x=0/y=0.
      const restX = parentSignal.x[0]
      const restY = parentSignal.y[0]
      const restRotation = parentSignal.rotation[0]
      const target = (base: number, signal: number[], rest: number) => signal.map((v) => base + (v - rest))
      const simulated: FakePhysicsSignal = {
        x: spring(target(child.transform.x, parentSignal.x, restX)),
        y: spring(target(child.transform.y, parentSignal.y, restY)),
        rotation: spring(target(child.transform.rotation, parentSignal.rotation, restRotation)),
      }
      results.set(child.id, simulated)
      walk(child, simulated)
    }
  }

  walk(root, signalFor(root))
  return results
}
