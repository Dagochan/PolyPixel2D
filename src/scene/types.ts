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
  /** Radians, about the island's own base-UV bounding-box center. */
  rotation: number
  /** Opt this island out of "match texel density" propagation — it neither pushes its density
   *  onto other islands nor gets pulled to theirs, e.g. for a deliberately denser face. */
  excludeFromDensityMatch?: boolean
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
  /** Edge keys ("a_b", a<b) marked as UV seams — cuts a UV island here even if the mesh
   *  itself stays connected (e.g. splitting a one-skin character's limbs from its torso). */
  seamEdges?: string[]
  /** Catmull-Clark subdivision levels (0 = off) applied only to the rendered fill mesh — the
   *  editable control cage (this mesh) and its UVs are untouched. */
  sdsLevels?: number
  /** Show the subdivided display mesh's wireframe instead of the control cage's, when SDS is on. */
  sdsShowWireframe?: boolean
  /** Edge crease weight (0-1) for SDS — keys are edge keys ("a_b", a<b). An edge absent from
   *  this map has weight 0 (fully smooth). Weight 1 makes that edge subdivide as if it were a
   *  mesh boundary, even when it has two adjacent faces. */
  creaseEdges?: Record<string, number>
  /** Vertex crease weight (0-1) for SDS — keys are vertex indices. Weight 1 keeps that vertex
   *  fixed in place under subdivision (e.g. to keep a hair-tip or torn-cloth corner pointed). */
  creaseVertices?: Record<number, number>
}

export type EditElementType = 'vertex' | 'edge' | 'face'
export type AppMode = 'object' | 'edit'

export interface EdgeKey {
  a: number
  b: number
}
