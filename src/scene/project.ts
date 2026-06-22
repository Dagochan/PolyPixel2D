import type { ReferenceImage, SceneObject } from './types'

export const PROJECT_VERSION = 1
export const PROJECT_EXTENSION = '.fltd'

export interface ProjectFile {
  version: number
  objects: SceneObject[]
  referenceImage: ReferenceImage | null
  meshOpacity: number
}

export function serializeProject(data: ProjectFile): string {
  return JSON.stringify(data)
}

/** Parse and lightly validate a `.fltd` file's contents (plain JSON). Throws on malformed input. */
export function parseProjectFile(json: string): ProjectFile {
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    throw new Error('JSONとして読み込めませんでした。')
  }
  if (typeof data !== 'object' || data === null || !Array.isArray((data as ProjectFile).objects)) {
    throw new Error('不正なファイル形式です。')
  }
  const d = data as Partial<ProjectFile>
  return {
    version: typeof d.version === 'number' ? d.version : PROJECT_VERSION,
    objects: d.objects as SceneObject[],
    referenceImage: d.referenceImage ?? null,
    meshOpacity: typeof d.meshOpacity === 'number' ? d.meshOpacity : 1,
  }
}
