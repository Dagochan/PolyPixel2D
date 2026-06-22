export interface Vec2 {
  x: number
  y: number
}

export interface Mesh {
  vertices: Vec2[]
  // each face is an ordered list of vertex indices (CCW), triangle/quad/ngon
  faces: number[][]
}

export interface Transform {
  x: number // world position of the pivot
  y: number
  rotation: number // radians, about the pivot
  scaleX: number // about the pivot
  scaleY: number
  pivot: Vec2 // in local (mesh) space; defaults to the origin
}

export interface Material {
  color: string
  /** Data URL of an imported texture image, multiplied by `color`. */
  textureUrl?: string
}

/** Scene-wide trace-over reference image (not tied to any object). */
export interface ReferenceImage {
  url: string
  x: number
  y: number
  scale: number
  opacity: number
}

/** Manual adjustment on top of an island's auto-normalized (0..1) base UV. Indexed by island
 *  order from `findIslands` — only meaningful as long as the mesh's islands haven't changed. */
export interface UvIslandTransform {
  offsetX: number
  offsetY: number
  scale: number
}

export interface SceneObject {
  id: string
  name: string
  mesh: Mesh
  transform: Transform
  zOrder: number
  visible: boolean
  material: Material
  uvIslandTransforms?: UvIslandTransform[]
}

export type EditElementType = 'vertex' | 'edge' | 'face'
export type AppMode = 'object' | 'edit'

export interface EdgeKey {
  a: number
  b: number
}
