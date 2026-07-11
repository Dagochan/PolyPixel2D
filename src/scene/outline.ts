/** Parses a `#rrggbb` (or `#rgb`) hex color into `[r, g, b]` (0-255 each). Falls back to black on
 *  anything unparseable, so a bad/partial color never throws mid-render. */
function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return [0, 0, 0]
  const h = m[1]
  if (h.length === 3) {
    return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)]
  }
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

/** Draws a flat-color outline around the sprite's silhouette (every fully-transparent pixel that
 *  touches an opaque one), in place on `data` (RGBA). `thickness` grows the outline outward one
 *  ring of pixels at a time — each pass's "is this opaque" check includes outline pixels painted
 *  by the previous pass, so `thickness: 2` traces a 2px-thick band hugging the silhouette rather
 *  than just running the 1px pass twice from the same starting silhouette. 4-directional (not
 *  8/diagonal) neighbor test, which reads as crisper/more "pixel art" than a rounded 8-direction
 *  outline at this scale. Meant to run *after* palette quantization (see `PixelPreview.tsx`) so
 *  the outline color itself stays exact rather than getting pulled into the quantized palette. */
export function applyPixelOutline(data: Uint8ClampedArray, width: number, height: number, color: string, thickness: number): void {
  if (thickness <= 0) return
  const [r, g, b] = hexToRgb(color)
  const isOpaque = (x: number, y: number) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return false
    return data[(y * width + x) * 4 + 3] !== 0
  }

  for (let pass = 0; pass < thickness; pass++) {
    // collect this pass's newly-outlined pixels first, then paint them all at once — painting
    // in place while still scanning would let an outline pixel from earlier in the same pass
    // feed into a neighbor's opaque check, growing the ring faster than intended
    const toPaint: number[] = []
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4
        if (data[i + 3] !== 0) continue // already opaque (sprite or earlier pass's outline)
        if (isOpaque(x - 1, y) || isOpaque(x + 1, y) || isOpaque(x, y - 1) || isOpaque(x, y + 1)) {
          toPaint.push(i)
        }
      }
    }
    for (const i of toPaint) {
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = 255
    }
  }
}
