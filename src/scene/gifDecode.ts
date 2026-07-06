import { parseGIF, decompressFrames } from 'gifuct-js'

/** One fully-composited frame, ready to draw as-is (no further disposal/patch handling needed). */
export interface DecodedGifFrame {
  imageData: ImageData
  delayMs: number
}

export interface DecodedGif {
  width: number
  height: number
  frames: DecodedGifFrame[]
  /** Sum of every frame's `delayMs` — the GIF's own real (authored) playback duration once. */
  totalDurationMs: number
}

/** A GIF's own reference-image data URL is never re-encoded (see `Toolbar.tsx`'s upload path) —
 *  this is the one place that distinguishes "decode it frame-by-frame" from "load it as an
 *  ordinary static image". */
export function isGifDataUrl(url: string): boolean {
  return url.startsWith('data:image/gif')
}

/**
 * Decodes every frame of a GIF data URL into a full-size, fully-composited `ImageData` — so a
 * caller can render any frame directly without knowing about GIF disposal methods or partial
 * frame patches.
 *
 * A GIF frame's `patch` only covers the region that actually changed (`dims`), and `disposalType`
 * says what happens to the canvas *after* this frame, before the next one draws: 1 (or 0, "no
 * disposal specified") leaves the canvas as-is; 2 clears this frame's own region back out; 3
 * restores whatever the canvas looked like right before this frame drew. Replaying that on a
 * running composite canvas (the standard technique for this library) is what turns the patches
 * into full frames.
 */
export async function decodeGif(dataUrl: string): Promise<DecodedGif> {
  const buffer = await fetch(dataUrl).then((r) => r.arrayBuffer())
  const gif = parseGIF(buffer)
  const parsedFrames = decompressFrames(gif, true)
  const width = gif.lsd.width
  const height = gif.lsd.height

  const composite = document.createElement('canvas')
  composite.width = width
  composite.height = height
  const ctx = composite.getContext('2d')!

  const patchCanvas = document.createElement('canvas')
  const patchCtx = patchCanvas.getContext('2d')!

  let previousImageData: ImageData | null = null
  const frames: DecodedGifFrame[] = []
  let totalDurationMs = 0

  for (const frame of parsedFrames) {
    const { dims, patch, disposalType, delay } = frame
    // disposal 3 ("restore to previous") needs the canvas as it was *before* this frame's own
    // patch is drawn, so it must be captured now, ahead of the draw below
    if (disposalType === 3) {
      previousImageData = ctx.getImageData(0, 0, width, height)
    }

    patchCanvas.width = dims.width
    patchCanvas.height = dims.height
    patchCtx.putImageData(new ImageData(new Uint8ClampedArray(patch), dims.width, dims.height), 0, 0)
    ctx.drawImage(patchCanvas, dims.left, dims.top)

    // a GIF encoder occasionally writes a 0 delay (some viewers/browsers fall back to 100ms —
    // e.g. a delay this short would otherwise make the frame effectively invisible against a
    // real per-second playhead)
    const delayMs = delay > 0 ? delay : 100
    frames.push({ imageData: ctx.getImageData(0, 0, width, height), delayMs })
    totalDurationMs += delayMs

    if (disposalType === 2) {
      ctx.clearRect(dims.left, dims.top, dims.width, dims.height)
    } else if (disposalType === 3 && previousImageData) {
      ctx.putImageData(previousImageData, 0, 0)
    }
  }

  return { width, height, frames, totalDurationMs }
}

/** Which frame (index into `gif.frames`) should be showing at `elapsedMs` into the GIF's own
 *  timeline — wraps (loops) over `gif.totalDurationMs` rather than clamping, so a reference
 *  animation shorter than the clip just repeats instead of freezing on its last frame. */
export function gifFrameAt(gif: DecodedGif, elapsedMs: number): number {
  if (gif.totalDurationMs <= 0) return 0
  let t = elapsedMs % gif.totalDurationMs
  if (t < 0) t += gif.totalDurationMs
  for (let i = 0; i < gif.frames.length; i++) {
    t -= gif.frames[i].delayMs
    if (t < 0) return i
  }
  return gif.frames.length - 1
}

/** The elapsed time (ms into the GIF's own timeline — see `gifFrameAt`) at which `frameIndex`
 *  starts, i.e. the sum of every earlier frame's `delayMs`. The inverse of `gifFrameAt` (up to
 *  which exact instant within the frame's own span is picked — this always picks its start). */
export function gifFrameStartMs(gif: DecodedGif, frameIndex: number): number {
  let t = 0
  for (let i = 0; i < frameIndex && i < gif.frames.length; i++) t += gif.frames[i].delayMs
  return t
}
