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
  // For a root object (parentId === null), world position of `head`. For a child object, the
  // local offset from the parent's world tail position (forced to (0,0) when `connected`).
  x: number
  y: number
  rotation: number // radians, about the head
  scaleX: number // about the head
  scaleY: number
  head: Vec2 // in local (mesh) space; defaults to the origin
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
  /** 'mesh' (default, including legacy saves where this field is absent) is a normal modeled
   *  object. 'empty' is a mesh-less hierarchy-only dummy (e.g. a rig root) — it still has the
   *  same `transform`/`tail`/`mesh` fields (mesh always `{vertices: [], faces: []}`) so every
   *  existing transform/hierarchy/Head-Tail code path keeps working unchanged; only edit mode and
   *  mesh/material/UV-dependent UI are gated off by this flag. */
  kind?: 'mesh' | 'empty'
  mesh: Mesh
  transform: Transform
  zOrder: number
  visible: boolean
  material: Material
  uvIslandTransforms?: UvIslandTransform[]
  /** The "rest pose" position UV unwrapping is computed from, per vertex index — frozen at
   *  creation (or last "UVを再展開") and never touched by ordinary vertex edits, so moving a
   *  vertex deforms the mesh without dragging its UV along (matches normal DCC behavior, and is
   *  what keeps texturing sane once bones start deforming the mesh). A vertex missing here (e.g.
   *  one a future mesh op forgot to seed) just falls back to its live position. */
  uvBaseVertices?: Record<number, Vec2>
  /** Local mesh-space point a child object attaches to (its `transform.head`'s world position,
   *  when `connected`). Independent of `transform.head`. */
  tail: Vec2
  /** Id of this object's parent, or `null` for a root object. */
  parentId: string | null
  /** When true (the default), this object's `transform.head` world position is forced to equal
   *  its parent's world tail position — the object cannot be positioned independently of its
   *  parent's tail, like a bone-chain link. When false, the parent-child rotation/scale
   *  composition still applies, but this object keeps an independent offset from the parent's
   *  tail (stored in `transform.x`/`y`). Meaningless when `parentId` is null. */
  connected: boolean
  /** Draw-order rank per island (indexed by island order from `findIslands` — same caveat as
   *  `uvIslandTransforms`: only meaningful as long as the mesh's islands haven't changed). An
   *  island absent from this map draws in its natural (face-traversal) order relative to others
   *  that are also absent. Lower rank draws first (further back). */
  islandZOrders?: Record<number, number>
  /** User-given name per island (indexed by island order from `findIslands` — same caveat as
   *  `islandZOrders`). An island absent from this map displays as "アイランド N" (N = index + 1). */
  islandNames?: Record<number, string>
  /** One toggle for the whole object: show every island's name in the viewport, just below its
   *  bounding-box center. Default false (hidden). */
  showIslandNames?: boolean
  /** Per-island visibility (indexed by island order from `findIslands` — same caveat as
   *  `islandZOrders`). An island absent from this map is visible (default true). A hidden
   *  island draws nothing at all — fill, wireframe, and edit-mode overlays alike. */
  islandVisible?: Record<number, boolean>
}

export type EditElementType = 'vertex' | 'edge' | 'face'
export type AppMode = 'object' | 'edit' | 'pivot'

export interface EdgeKey {
  a: number
  b: number
}
