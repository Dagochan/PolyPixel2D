import type { AnimationClip, EasingType, LoopMode, ObjectAnimationTrack, Transform } from './types'

function easeFn(easing: EasingType, t: number): number {
  switch (easing) {
    case 'linear':
      return t
    case 'easeIn':
      return t * t
    case 'easeOut':
      return 1 - (1 - t) * (1 - t)
    case 'easeInOut':
      return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
  }
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}

function lerpTransform(a: Transform, b: Transform, t: number): Transform {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    rotation: lerp(a.rotation, b.rotation, t),
    scaleX: lerp(a.scaleX, b.scaleX, t),
    scaleY: lerp(a.scaleY, b.scaleY, t),
    head: { x: lerp(a.head.x, b.head.x, t), y: lerp(a.head.y, b.head.y, t) },
  }
}

/** Maps a raw query time (seconds, can be negative or past `duration`) into a clip's [0, duration]
 *  playback range per its loop mode. 'none' just clamps to the boundary. */
export function resolvePlaybackTime(time: number, duration: number, loopMode: LoopMode): number {
  if (duration <= 0) return 0
  if (loopMode === 'none') return Math.min(Math.max(time, 0), duration)
  if (loopMode === 'loop') {
    const m = time % duration
    return m < 0 ? m + duration : m
  }
  // pingpong: reflect within [0, duration] over a period of 2*duration (0→duration→0→...)
  const period = duration * 2
  let m = time % period
  if (m < 0) m += period
  return m <= duration ? m : period - m
}

/** Evaluates one object's track at `time`, already resolved into the clip's playback range (see
 *  `resolvePlaybackTime`). Before the first key, holds the first key's pose. Between two keys,
 *  interpolates using the *later* key's easing — easing describes how the segment leading into a
 *  key behaves, so the key being approached owns it.
 *
 *  After the last key, behavior depends on `cycle`: without it, holds the last key's pose (a flat
 *  freeze, e.g. for a 'none'/'pingpong' clip where there's nothing past the end to blend toward).
 *  With it, treats the *first* key as if a copy of it also sat at `cycle.duration` — i.e. the gap
 *  is the clip wrapping back to its own start — and interpolates the last key toward that virtual
 *  copy using the first key's easing, by the same "key being approached owns the easing"
 *  convention. Without this, a 'loop' clip whose last key doesn't land exactly on `duration` would
 *  hold dead-still after that key and then hard-snap back to the start on every repeat. */
export function sampleTrack(
  track: ObjectAnimationTrack,
  time: number,
  cycle?: { duration: number },
): Transform | null {
  const keys = track.keyframes
  if (keys.length === 0) return null
  if (time <= keys[0].time) return keys[0].transform
  const lastKey = keys[keys.length - 1]
  if (time >= lastKey.time) {
    if (cycle && lastKey.time < cycle.duration) {
      const span = cycle.duration - lastKey.time
      const rawT = span <= 0 ? 1 : (time - lastKey.time) / span
      return lerpTransform(lastKey.transform, keys[0].transform, easeFn(keys[0].easing, Math.min(1, rawT)))
    }
    return lastKey.transform
  }
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]
    const b = keys[i + 1]
    if (time >= a.time && time <= b.time) {
      const span = b.time - a.time
      const rawT = span <= 0 ? 1 : (time - a.time) / span
      return lerpTransform(a.transform, b.transform, easeFn(b.easing, rawT))
    }
  }
  return lastKey.transform
}

/** Evaluates every animated object in a clip at `time` (raw — this resolves it into the clip's
 *  playback range internally per its loop mode). Objects with no track in this clip are absent
 *  from the result (callers should leave their transform untouched). */
export function sampleClipAtTime(clip: AnimationClip, time: number): Map<string, Transform> {
  const resolved = resolvePlaybackTime(time, clip.duration, clip.loopMode)
  // only a plain 'loop' wraps back to its own start — 'pingpong' already reverses smoothly on its
  // own, and 'none' has nothing past the end to blend toward
  const cycle = clip.loopMode === 'loop' ? { duration: clip.duration } : undefined
  const result = new Map<string, Transform>()
  for (const track of clip.tracks) {
    const sampled = sampleTrack(track, resolved, cycle)
    if (sampled) result.set(track.objectId, sampled)
  }
  return result
}
