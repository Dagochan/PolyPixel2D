import { describe, expect, it } from 'vitest'
import { correctVertexUv, type UvNeighbor } from './correctUv'

describe('correctVertexUv', () => {
  it('returns undefined with fewer than 2 neighbors (no 2D neighborhood to interpolate within)', () => {
    expect(correctVertexUv([], { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 })).toBeUndefined()
    const one: UvNeighbor[] = [{ pos: { x: 1, y: 0 }, uv: { x: 1, y: 0 } }]
    expect(correctVertexUv(one, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0.5, y: 0 })).toBeUndefined()
  })

  it('returns the unchanged self UV when the vertex has not moved', () => {
    const neighbors: UvNeighbor[] = [
      { pos: { x: 1, y: 0 }, uv: { x: 1, y: 0 } },
      { pos: { x: 0, y: 1 }, uv: { x: 0, y: 1 } },
    ]
    const selfStart = { x: 0, y: 0 }
    const selfUv = { x: 0.25, y: 0.25 }
    const result = correctVertexUv(neighbors, selfStart, selfUv, selfStart)
    expect(result?.x).toBeCloseTo(selfUv.x)
    expect(result?.y).toBeCloseTo(selfUv.y)
  })

  it('slides the UV proportionally along a 2-neighbor chain (the common GG-slide case)', () => {
    // a straight strip: A(-1,0) - self(0,0) - B(1,0), with UVs mirroring positions 1:1
    const neighbors: UvNeighbor[] = [
      { pos: { x: -1, y: 0 }, uv: { x: -1, y: 0 } },
      { pos: { x: 1, y: 0 }, uv: { x: 1, y: 0 } },
    ]
    const selfStart = { x: 0, y: 0 }
    const selfUv = { x: 0, y: 0 }

    // slide 30% of the way toward B(1,0)
    const result = correctVertexUv(neighbors, selfStart, selfUv, { x: 0.3, y: 0 })
    expect(result?.x).toBeCloseTo(0.3)
    expect(result?.y).toBeCloseTo(0)
  })

  it('reduces to standard barycentric interpolation across a fan of 3+ neighbors', () => {
    // self at origin surrounded by 3 neighbors at 0°, 120°, 240° with matching UVs
    const neighbors: UvNeighbor[] = [
      { pos: { x: 1, y: 0 }, uv: { x: 10, y: 0 } },
      { pos: { x: -0.5, y: 0.866 }, uv: { x: -5, y: 8.66 } },
      { pos: { x: -0.5, y: -0.866 }, uv: { x: -5, y: -8.66 } },
    ]
    const selfStart = { x: 0, y: 0 }
    const selfUv = { x: 0, y: 0 }

    // move halfway toward the first neighbor — should land halfway between selfUv and its UV
    const result = correctVertexUv(neighbors, selfStart, selfUv, { x: 0.5, y: 0 })
    expect(result?.x).toBeCloseTo(5)
    expect(result?.y).toBeCloseTo(0)
  })

  it('snaps to a neighbor´s own UV when the new position lands exactly on it', () => {
    const neighbors: UvNeighbor[] = [
      { pos: { x: 1, y: 0 }, uv: { x: 7, y: 2 } },
      { pos: { x: 0, y: 1 }, uv: { x: 3, y: 9 } },
    ]
    const result = correctVertexUv(neighbors, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 })
    expect(result?.x).toBeCloseTo(7)
    expect(result?.y).toBeCloseTo(2)
  })
})
