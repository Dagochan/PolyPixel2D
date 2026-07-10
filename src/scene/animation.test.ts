import { describe, expect, it } from 'vitest'
import { resolvePlaybackTime } from './animation'

describe('resolvePlaybackTime', () => {
  it('clamps to [0, duration] for loopMode "none"', () => {
    expect(resolvePlaybackTime(-1, 2, 'none')).toBe(0)
    expect(resolvePlaybackTime(0, 2, 'none')).toBe(0)
    expect(resolvePlaybackTime(1, 2, 'none')).toBe(1)
    expect(resolvePlaybackTime(2, 2, 'none')).toBe(2)
    expect(resolvePlaybackTime(3, 2, 'none')).toBe(2)
  })

  it('wraps modulo duration for loopMode "loop", including exactly at the boundary', () => {
    expect(resolvePlaybackTime(0, 2, 'loop')).toBe(0)
    expect(resolvePlaybackTime(1, 2, 'loop')).toBe(1)
    // this is the exact case the sprite sheet export bug hinged on: time === duration must wrap
    // back to 0 for a looping clip, not stay at the end
    expect(resolvePlaybackTime(2, 2, 'loop')).toBe(0)
    expect(resolvePlaybackTime(3, 2, 'loop')).toBe(1)
    expect(resolvePlaybackTime(-0.5, 2, 'loop')).toBe(1.5)
  })

  it('reflects within [0, duration] over a 2*duration period for loopMode "pingpong"', () => {
    expect(resolvePlaybackTime(0, 2, 'pingpong')).toBe(0)
    expect(resolvePlaybackTime(1, 2, 'pingpong')).toBe(1)
    expect(resolvePlaybackTime(2, 2, 'pingpong')).toBe(2)
    // past duration, time reflects back down
    expect(resolvePlaybackTime(3, 2, 'pingpong')).toBe(1)
    expect(resolvePlaybackTime(4, 2, 'pingpong')).toBe(0)
    expect(resolvePlaybackTime(-1, 2, 'pingpong')).toBe(1)
  })

  it('returns 0 for a zero or negative duration regardless of loop mode', () => {
    expect(resolvePlaybackTime(5, 0, 'none')).toBe(0)
    expect(resolvePlaybackTime(5, 0, 'loop')).toBe(0)
    expect(resolvePlaybackTime(5, 0, 'pingpong')).toBe(0)
  })
})
