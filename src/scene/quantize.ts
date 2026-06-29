/** Median-cut color quantization: repeatedly splits the largest-range bucket of pixels in half
 *  (by the channel with the widest spread) until there are `colorCount` buckets, then averages
 *  each bucket into one palette color. Cheap and deterministic — no iteration/convergence like
 *  k-means — which matters since this reruns every frame the preview is open. */
function buildPalette(pixels: number[][], colorCount: number): number[][] {
  let buckets: number[][][] = [pixels]
  while (buckets.length < colorCount) {
    let targetIdx = -1
    let targetRange = -1
    let targetChannel = 0
    buckets.forEach((bucket, idx) => {
      if (bucket.length < 2) return
      for (let c = 0; c < 3; c++) {
        let min = Infinity
        let max = -Infinity
        for (const p of bucket) {
          if (p[c] < min) min = p[c]
          if (p[c] > max) max = p[c]
        }
        const range = max - min
        if (range > targetRange) {
          targetRange = range
          targetIdx = idx
          targetChannel = c
        }
      }
    })
    if (targetIdx === -1 || targetRange <= 0) break
    const bucket = buckets[targetIdx]
    bucket.sort((a, b) => a[targetChannel] - b[targetChannel])
    const mid = Math.floor(bucket.length / 2)
    buckets.splice(targetIdx, 1, bucket.slice(0, mid), bucket.slice(mid))
  }
  return buckets
    .filter((b) => b.length > 0)
    .map((bucket) => {
      const sum = [0, 0, 0]
      for (const p of bucket) {
        sum[0] += p[0]
        sum[1] += p[1]
        sum[2] += p[2]
      }
      return [Math.round(sum[0] / bucket.length), Math.round(sum[1] / bucket.length), Math.round(sum[2] / bucket.length)]
    })
}

function nearestColorIndex(palette: number[][], r: number, g: number, b: number): number {
  let best = 0
  let bestDist = Infinity
  for (let i = 0; i < palette.length; i++) {
    const c = palette[i]
    const dr = c[0] - r
    const dg = c[1] - g
    const db = c[2] - b
    const dist = dr * dr + dg * dg + db * db
    if (dist < bestDist) {
      bestDist = dist
      best = i
    }
  }
  return best
}

/** Quantizes `data` (RGBA, in place) to a palette of at most `colorCount` colors auto-extracted
 *  from the image's own (non-transparent) pixels via median-cut. Alpha is left untouched —
 *  fully-transparent pixels are also excluded from palette extraction so a transparent
 *  background doesn't waste palette slots or skew the averaged colors. */
export function quantizeImageData(data: Uint8ClampedArray, colorCount: number): void {
  const pixels: number[][] = []
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue
    pixels.push([data[i], data[i + 1], data[i + 2]])
  }
  if (pixels.length === 0) return

  const palette = buildPalette(pixels, colorCount)
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue
    const idx = nearestColorIndex(palette, data[i], data[i + 1], data[i + 2])
    const c = palette[idx]
    data[i] = c[0]
    data[i + 1] = c[1]
    data[i + 2] = c[2]
  }
}
