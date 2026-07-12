import { sampleTrack } from './animation'
import type { AnimationClip, ObjectAnimationTrack, OscillatorSettings, SceneObject, Transform, TransformKeyframe } from './types'

/** This object's Oscillator settings, if it has that modifier in its stack (see `Modifier`) —
 *  `undefined` otherwise. Every other function in this module takes `obj` (not raw `settings`)
 *  precisely so this lookup lives in exactly one place (same convention as `getFfd`/`getFakeFlag`). */
export function getOscillator(obj: SceneObject): OscillatorSettings | undefined {
  return obj.modifiers?.find((m): m is Extract<typeof m, { type: 'oscillator' }> => m.type === 'oscillator')?.settings
}

export const DEFAULT_OSCILLATOR_SETTINGS: OscillatorSettings = {
  enabled: true,
  targetAxis: 'y',
  wavelength: 2,
  amplitude: 10,
  randomness: 0,
  seed: 1,
}

/** A handful of incommensurate-frequency sine waves, phase/frequency-perturbed by `seed`, summed
 *  and normalized to roughly [-1, 1] — a cheap, fully deterministic stand-in for value noise.
 *  Deliberately not `Math.random()`-based (see `OscillatorSettings.randomness`'s doc): the whole
 *  point is that scrubbing the timeline or re-exporting a sprite sheet reproduces the exact same
 *  wiggle every time. */
function seededNoise(seed: number, t: number): number {
  const s1 = Math.sin(t * 2.1 + seed * 12.9898)
  const s2 = Math.sin(t * 3.7 + seed * 78.233) * 0.5
  const s3 = Math.sin(t * 5.3 + seed * 37.719) * 0.25
  return (s1 + s2 + s3) / 1.75
}

/** Pure, deterministic sample of an Oscillator's output at time `t` (seconds) — the value to add
 *  onto `settings.targetAxis`. A plain sine wave at `randomness: 0`, blended toward `seededNoise`
 *  as `randomness` rises to 1. */
export function sampleOscillator(settings: OscillatorSettings, t: number): number {
  const base = Math.sin((2 * Math.PI * t) / Math.max(1e-6, settings.wavelength))
  const noise = seededNoise(settings.seed, t)
  const r = Math.max(0, Math.min(1, settings.randomness))
  return (base * (1 - r) + noise * r) * settings.amplitude
}

function applyToAxis(transform: Transform, axis: OscillatorSettings['targetAxis'], value: number): Transform {
  switch (axis) {
    case 'x':
      return { ...transform, x: transform.x + value }
    case 'y':
      return { ...transform, y: transform.y + value }
    case 'rotation':
      return { ...transform, rotation: transform.rotation + value }
    case 'scaleX':
      return { ...transform, scaleX: transform.scaleX + value }
    case 'scaleY':
      return { ...transform, scaleY: transform.scaleY + value }
  }
}

/** Live (unbaked) Oscillator preview — applies every enabled Oscillator's sway to its own
 *  `transform`, fresh from `time` alone (same idea as Fake Flag's rotation sway: a pure function
 *  of time needs no per-frame integration state, unlike Fake Physics's spring simulation). Callers
 *  gate this behind a "Preview" toggle rather than applying it unconditionally (unlike Fake Flag) —
 *  see `previewOscillator`'s doc — so an enabled-but-not-yet-baked Oscillator doesn't silently
 *  animate the viewport outside of an explicit preview. */
export function applyOscillators(objects: SceneObject[], time: number): SceneObject[] {
  return objects.map((obj) => {
    const settings = getOscillator(obj)
    if (!settings?.enabled) return obj
    const value = sampleOscillator(settings, time)
    return { ...obj, transform: applyToAxis(obj.transform, settings.targetAxis, value) }
  })
}

/** Samples one object's Oscillator across `[0, clip.duration]` into a ready-to-store
 *  `ObjectAnimationTrack` — the shared core behind the store's `bakeOscillator` action, mirroring
 *  `buildFakePhysicsTracksForRoot`'s shape. `null` when the object has no enabled Oscillator.
 *  Folds in the object's own hand-keyed `tracks` entry (if any) as the base pose at each sample
 *  time, same as Fake Physics baking does, so the sway rides on top of whatever base motion is
 *  already keyed rather than assuming a static object. */
export function buildOscillatorTrack(
  objects: SceneObject[],
  clip: AnimationClip,
  objectId: string,
  frameCount: number,
  cycle: { duration: number } | undefined,
  genKeyframeId: () => string,
): ObjectAnimationTrack | null {
  const obj = objects.find((o) => o.id === objectId)
  if (!obj) return null
  const settings = getOscillator(obj)
  if (!settings?.enabled) return null
  const baseTrack = clip.tracks.find((t) => t.objectId === objectId)
  const keyframes: TransformKeyframe[] = []
  for (let f = 0; f <= frameCount; f++) {
    const time = (f / frameCount) * clip.duration
    const baseTransform = (baseTrack && sampleTrack(baseTrack, time, cycle)) ?? obj.transform
    const value = sampleOscillator(settings, time)
    keyframes.push({
      id: genKeyframeId(),
      time,
      transform: applyToAxis(baseTransform, settings.targetAxis, value),
      easing: 'linear',
    })
  }
  return { objectId, keyframes }
}
