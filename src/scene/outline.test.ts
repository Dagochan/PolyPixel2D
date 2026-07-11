import { describe, expect, it } from 'vitest'
import { applyPixelOutline } from './outline'

/** Builds a WxH RGBA buffer, opaque (white) at every (x,y) in `opaquePixels`, transparent black
 *  everywhere else. */
function makeBuffer(width: number, height: number, opaquePixels: Array<[number, number]>): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4)
  for (const [x, y] of opaquePixels) {
    const i = (y * width + x) * 4
    data[i] = 255
    data[i + 1] = 255
    data[i + 2] = 255
    data[i + 3] = 255
  }
  return data
}

function pixelAt(data: Uint8ClampedArray, width: number, x: number, y: number): [number, number, number, number] {
  const i = (y * width + x) * 4
  return [data[i], data[i + 1], data[i + 2], data[i + 3]]
}

describe('applyPixelOutline', () => {
  it('does nothing when thickness is 0', () => {
    const data = makeBuffer(3, 3, [[1, 1]])
    const before = new Uint8ClampedArray(data)
    applyPixelOutline(data, 3, 3, '#ff0000', 0)
    expect(data).toEqual(before)
  })

  it('outlines the 4-directional neighbors of a single opaque pixel, not the diagonals', () => {
    const data = makeBuffer(3, 3, [[1, 1]])
    applyPixelOutline(data, 3, 3, '#ff0000', 1)
    // orthogonal neighbors get outlined red
    expect(pixelAt(data, 3, 1, 0)).toEqual([255, 0, 0, 255])
    expect(pixelAt(data, 3, 0, 1)).toEqual([255, 0, 0, 255])
    expect(pixelAt(data, 3, 2, 1)).toEqual([255, 0, 0, 255])
    expect(pixelAt(data, 3, 1, 2)).toEqual([255, 0, 0, 255])
    // diagonal neighbors stay transparent
    expect(pixelAt(data, 3, 0, 0)).toEqual([0, 0, 0, 0])
    expect(pixelAt(data, 3, 2, 0)).toEqual([0, 0, 0, 0])
    expect(pixelAt(data, 3, 0, 2)).toEqual([0, 0, 0, 0])
    expect(pixelAt(data, 3, 2, 2)).toEqual([0, 0, 0, 0])
    // the original opaque pixel is untouched
    expect(pixelAt(data, 3, 1, 1)).toEqual([255, 255, 255, 255])
  })

  it('grows the outline outward one ring per thickness pass', () => {
    const data = makeBuffer(5, 5, [[2, 2]])
    applyPixelOutline(data, 5, 5, '#00ff00', 2)
    // 2 rings out from center (2,2) along an axis reaches (2,0)/(0,2)/(4,2)/(2,4)
    expect(pixelAt(data, 5, 2, 0)).toEqual([0, 255, 0, 255])
    expect(pixelAt(data, 5, 0, 2)).toEqual([0, 255, 0, 255])
    expect(pixelAt(data, 5, 4, 2)).toEqual([0, 255, 0, 255])
    expect(pixelAt(data, 5, 2, 4)).toEqual([0, 255, 0, 255])
    // corners are still untouched even at thickness 2 (still purely 4-directional growth)
    expect(pixelAt(data, 5, 0, 0)).toEqual([0, 0, 0, 0])
  })

  it('parses a 3-digit hex color', () => {
    const data = makeBuffer(3, 3, [[1, 1]])
    applyPixelOutline(data, 3, 3, '#0f0', 1)
    expect(pixelAt(data, 3, 1, 0)).toEqual([0, 255, 0, 255])
  })
})
