import { describe, expect, it } from 'vitest'
import { sampleOscillator, buildOscillatorTrack, DEFAULT_OSCILLATOR_SETTINGS } from './oscillator'
import type { AnimationClip, SceneObject } from './types'

describe('sampleOscillator', () => {
  it('is a pure sine wave at randomness 0, scaled by amplitude and wavelength', () => {
    const settings = { ...DEFAULT_OSCILLATOR_SETTINGS, wavelength: 4, amplitude: 10, randomness: 0 }
    expect(sampleOscillator(settings, 0)).toBeCloseTo(0)
    expect(sampleOscillator(settings, 1)).toBeCloseTo(10) // quarter cycle -> peak
    expect(sampleOscillator(settings, 2)).toBeCloseTo(0) // half cycle -> back to 0
    expect(sampleOscillator(settings, 4)).toBeCloseTo(0) // full cycle
  })

  it('is deterministic — same inputs always produce the same output', () => {
    const settings = { ...DEFAULT_OSCILLATOR_SETTINGS, randomness: 0.7, seed: 3 }
    const a = sampleOscillator(settings, 1.2345)
    const b = sampleOscillator(settings, 1.2345)
    expect(a).toBe(b)
  })

  it('differs by seed at randomness > 0 (so multiple oscillators desync)', () => {
    const s1 = { ...DEFAULT_OSCILLATOR_SETTINGS, randomness: 1, seed: 1 }
    const s2 = { ...DEFAULT_OSCILLATOR_SETTINGS, randomness: 1, seed: 2 }
    expect(sampleOscillator(s1, 1.5)).not.toBeCloseTo(sampleOscillator(s2, 1.5), 5)
  })

  it('stays within [-amplitude, amplitude] regardless of randomness blend', () => {
    const settings = { ...DEFAULT_OSCILLATOR_SETTINGS, amplitude: 5, randomness: 0.5 }
    for (let t = 0; t < 20; t += 0.37) {
      const v = sampleOscillator(settings, t)
      expect(Math.abs(v)).toBeLessThanOrEqual(5 + 1e-9)
    }
  })
})

describe('buildOscillatorTrack', () => {
  const obj: SceneObject = {
    id: 'obj_1',
    name: 'Test',
    kind: 'mesh',
    mesh: { vertices: [], faces: [] },
    transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, head: { x: 0, y: 0 } },
    zOrder: 0,
    visible: true,
    material: { color: '#ffffff' },
    tail: { x: 0, y: 0 },
    parentId: null,
    connected: true,
    modifiers: [
      { type: 'oscillator', settings: { ...DEFAULT_OSCILLATOR_SETTINGS, targetAxis: 'y', amplitude: 10, wavelength: 4 } },
    ],
  }

  const clip: AnimationClip = { id: 'clip_1', name: 'Clip', duration: 4, loopMode: 'none', frameRate: 4, tracks: [] }

  it('returns null when the object has no enabled Oscillator', () => {
    const bare: SceneObject = { ...obj, modifiers: [] }
    expect(buildOscillatorTrack([bare], clip, 'obj_1', 4, undefined, () => 'k')).toBeNull()
  })

  it('samples across [0, duration] into dense keyframes riding on the base y', () => {
    const track = buildOscillatorTrack([obj], clip, 'obj_1', 4, undefined, () => 'k')
    expect(track).not.toBeNull()
    expect(track!.objectId).toBe('obj_1')
    expect(track!.keyframes).toHaveLength(5) // frameCount(4) + 1
    expect(track!.keyframes[0].time).toBe(0)
    expect(track!.keyframes[0].transform.y).toBeCloseTo(0)
    expect(track!.keyframes[1].time).toBe(1)
    expect(track!.keyframes[1].transform.y).toBeCloseTo(10) // quarter cycle of wavelength 4 -> peak amplitude
    // x/rotation/scale are untouched since targetAxis is 'y'
    expect(track!.keyframes[1].transform.x).toBeCloseTo(0)
    expect(track!.keyframes[1].transform.rotation).toBeCloseTo(0)
  })
})
