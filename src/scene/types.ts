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

/** Row-major (idx = j*cols+i) grid topology info, present only for grid-based primitives (e.g. rect). */
export interface GridInfo {
  cols: number
  rows: number
}

export interface SceneObject {
  id: string
  name: string
  mesh: Mesh
  transform: Transform
  zOrder: number
  visible: boolean
  color: string
  grid?: GridInfo
}

export type EditElementType = 'vertex' | 'edge' | 'face'
export type AppMode = 'object' | 'edit'

export interface EdgeKey {
  a: number
  b: number
}
