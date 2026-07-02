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

/** A named morph target (Blender-style shape key) — an alternate, sparse vertex pose blended on
 *  top of the object's live `mesh.vertices` (the "Basis"). Several keys blend additively at once,
 *  each scaled by its own weight in `SceneObject.shapeKeyValues`. */
export interface ShapeKey {
  id: string
  name: string
  /** Sparse absolute target vertex positions, indexed like `mesh.vertices`. A vertex absent here
   *  sits at its Basis (live `mesh.vertices`) position — i.e. this key doesn't move it. */
  positions: Record<number, Vec2>
  /** Interpolation from Basis to this key's target pose. 'linear' (default when absent) is the
   *  straight Cartesian lerp. 'arc' sweeps each vertex along an arc around `arcPivot` instead —
   *  fixes volume loss/pinching on rotational deformations. Falls back to 'linear' behavior
   *  whenever `arcPivot` is unset (graceful default). */
  interpolation?: 'linear' | 'arc'
  /** Local mesh-space pivot Arc mode rotates around. Dragged via a dedicated viewport handle —
   *  independent of the transient `editPivot` (P key), since this one must persist with the key
   *  rather than reset on every mode/object switch. */
  arcPivot?: Vec2
}

/** A reservation, within an object's own island Z-order stack, for some *other* object to be
 *  rendered at this position instead — sandwiched between whichever islands end up adjacent to
 *  it in rank order. Lets render order cross object boundaries without splitting a mesh purely
 *  to fight Z-order (e.g. a neck object needing to sit between a collar's front and back islands). */
export interface InsertSlot {
  id: string
  /** Same ranking space as `islandZOrders` (which defaults an absent island to its own index) —
   *  typically a fractional value like 0.5 so the slot sits between two integer-ranked islands
   *  without needing to renumber them. */
  rank: number
  /** The `slotName` of the object to render here. Empty = reserved but unfilled placeholder. */
  targetSlotName: string
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
  /** Per-island edit lock (indexed by island order from `findIslands` — same caveat as
   *  `islandZOrders`). An island absent from this map is unlocked (default false). A locked
   *  island cannot be selected/edited in edit mode (click, box-select, and its wireframe/vertex/
   *  edge overlays are hidden), but its fill (material/texture) still renders normally — useful
   *  for isolating one island's editing when several overlap on screen. */
  islandLocked?: Record<number, boolean>
  /** Unique-per-scene name another object's `InsertSlot.targetSlotName` can reference, to render
   *  this object sandwiched into that object's island stack instead of in normal document order.
   *  Setting it (Properties panel) steals it from whichever other object currently holds it, so
   *  it can never collide. */
  slotName?: string
  /** Reserved positions in this object's own island Z-order stack for other objects to be
   *  inserted into (see `InsertSlot`). */
  insertSlots?: InsertSlot[]
  /** Morph targets blended on top of this object's live mesh (the Basis) — see `ShapeKey`. */
  shapeKeys?: ShapeKey[]
  /** Weight per shape key id (`ShapeKey.id`), applied additively at eval time. Absent = 0.
   *  Unclamped (Blender allows negative/>1 weights for overshoot/corrective use). */
  shapeKeyValues?: Record<string, number>
}

export type EditElementType = 'vertex' | 'edge' | 'face'
export type AppMode = 'object' | 'edit' | 'pivot'

export interface EdgeKey {
  a: number
  b: number
}

/** Interpolation used for the segment leading into a keyframe (i.e. how the *previous* key blends
 *  into this one). Cubic ease curves, not configurable bezier handles — matches the "ease-in/out"
 *  scope agreed for the first pass of the animation system. */
export type EasingType = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut'

/** A full Transform snapshot at a point in time, on one object's animation track. Keyframing the
 *  whole Transform together (rather than per-channel x/y/rotation/scale keys) matches how this
 *  app's keying is triggered (one "insert keyframe" action per object) and avoids cross-channel
 *  timing/easing bookkeeping; per-channel keys can be split out later if a real need shows up. */
export interface TransformKeyframe {
  id: string
  /** Seconds from the clip's start. Keyframes on a track are kept sorted by this. */
  time: number
  transform: Transform
  easing: EasingType
}

/** One object's keyframes within a single `AnimationClip`. An object with no track in a clip is
 *  simply not animated by it (keeps its last-evaluated/static transform). */
export interface ObjectAnimationTrack {
  objectId: string
  keyframes: TransformKeyframe[]
}

/** A single keyed value on a `ShapeKeyTrack` — same shape as `TransformKeyframe` but for one
 *  scalar (a shape key's blend weight) instead of a full `Transform`. */
export interface ShapeKeyKeyframe {
  id: string
  time: number
  value: number
  easing: EasingType
}

/** One shape key's animated weight track within a clip — parallel to `ObjectAnimationTrack`
 *  but keyed by (`objectId`, `shapeKeyId`) since an object can have several independently
 *  keyed shape keys. Deliberately a separate array on `AnimationClip` rather than folded into
 *  `tracks`, so existing Transform-only track code never has to type-narrow. */
export interface ShapeKeyTrack {
  objectId: string
  shapeKeyId: string
  keyframes: ShapeKeyKeyframe[]
}

/** Out-of-range playback behavior once the playhead passes `duration` (or goes below 0 while
 *  scrubbing). 'none' clamps and holds the boundary pose. */
export type LoopMode = 'none' | 'loop' | 'pingpong'

/** A named, independently-playable animation (e.g. "Idle", "Walk"). A project can hold several;
 *  only one is "active" (edited/scrubbed) at a time, per the agreed no-per-clip-projects design. */
export interface AnimationClip {
  id: string
  name: string
  /** Seconds. The nominal playback range is [0, duration] regardless of where the last keyframe
   *  on any track actually falls (lets a clip have trailing/leading hold time). */
  duration: number
  loopMode: LoopMode
  /** Frames per second — purely a snapping/display granularity (this app's time axis stays
   *  seconds-based, per the agreed Blender-style design). Per-clip rather than project-global so a
   *  12fps "chunky" walk cycle and a smoother 30fps idle can coexist. */
  frameRate: number
  tracks: ObjectAnimationTrack[]
  /** Shape-key weight tracks — absent/undefined on older saved projects, treated as empty. */
  shapeKeyTracks?: ShapeKeyTrack[]
}
