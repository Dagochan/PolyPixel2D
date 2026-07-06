import type { AnimationClip, PixelFrame, ReferenceImage, SceneObject } from './types'

export const PROJECT_VERSION = 2
export const PROJECT_EXTENSION = '.pptd'

export interface ProjectFile {
  version: number
  objects: SceneObject[]
  referenceImage: ReferenceImage | null
  meshOpacity: number
  /** Absent in files saved before animation clips existed (version < 2) — `parseProjectFile`
   *  backfills those to `[]`. */
  clips: AnimationClip[]
  /** Absent in files saved before Pixel Frame existed — `parseProjectFile` backfills to `null`
   *  (falls back to Pixel Preview's old auto-fit framing). */
  pixelFrame: PixelFrame | null
}

export function serializeProject(data: ProjectFile): string {
  return JSON.stringify(data)
}

/** Parse and lightly validate a `.pptd` file's contents (plain JSON). Throws on malformed input. */
export function parseProjectFile(json: string): ProjectFile {
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    throw new Error('Could not parse the file as JSON.')
  }
  if (typeof data !== 'object' || data === null || !Array.isArray((data as ProjectFile).objects)) {
    throw new Error('Invalid file format.')
  }
  const d = data as Partial<ProjectFile>
  return {
    version: typeof d.version === 'number' ? d.version : PROJECT_VERSION,
    objects: d.objects as SceneObject[],
    // `visible`/`rotation` are absent in files saved before those existed — default to visible
    // (so old projects don't silently lose their reference image on load) and unrotated.
    referenceImage: d.referenceImage
      ? { ...d.referenceImage, visible: d.referenceImage.visible ?? true, rotation: d.referenceImage.rotation ?? 0 }
      : null,
    meshOpacity: typeof d.meshOpacity === 'number' ? d.meshOpacity : 1,
    clips: Array.isArray(d.clips) ? d.clips : [],
    pixelFrame: d.pixelFrame ?? null,
  }
}
