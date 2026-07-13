export interface Vec2 {
  x: number
  y: number
}

export interface Mesh {
  vertices: Vec2[]
  // each face is an ordered list of vertex indices (CCW), triangle/quad/ngon
  faces: number[][]
  /** Per-face color override (hex string), keyed by index into `faces` — same indexing as
   *  `SceneState.selectedFaces`. A face absent here falls back to the object's own
   *  `Material.color`. Only survives face-index-preserving edits (delete faces, extrude) that
   *  explicitly remap this map; other topology-changing tools (knife, loop cut, subdivide, merge)
   *  don't yet carry it over and may leave affected faces reset to the fallback color. */
  faceColors?: Record<number, string>
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
  rotation: number // radians, about the image's own center (x, y)
  opacity: number
  visible: boolean
  /** GIF only (see `scene/gifDecode.ts`) — seconds added to the playhead before mapping into the
   *  GIF's own per-frame timeline, so a larger value skips further ahead into the GIF at any
   *  given playhead position (letting frame 0 be aligned to wherever the user wants the reference
   *  animation to "start" relative to the clip). The mapping loops over the GIF's own real
   *  (authored) duration, entirely independent of `AnimationClip.frameRate` (which is just a
   *  keyframe-snapping display granularity, not an authoritative clock — see its doc). Ignored
   *  for a non-GIF image. Absent/undefined = 0 (no shift). */
  gifOffset?: number
  /** Mirrors the image horizontally (about its own center) — e.g. tracing a reference drawn/
   *  filmed facing the opposite way the object is modeled. Applied as a texture-space flip (`u`
   *  reversed), not a geometry/transform change, so it composes independently of `rotation`.
   *  Absent/undefined = not flipped. */
  flipX?: boolean
}

/** Sentinel `selectedObjectId` value standing in for the reference image — it isn't a
 *  `SceneObject` (there's at most one, scene-wide, stored separately as `referenceImage`), but
 *  reusing the existing single-slot `selectedObjectId`/`selectObject` selection machinery (rather
 *  than adding a parallel "what kind of thing is selected" flag everywhere) means every place that
 *  already does `objects.find((o) => o.id === selectedObjectId)` naturally treats it as "nothing
 *  selected" for free, and Outliner/Properties/Viewport only need to special-case this one id
 *  where the reference image's behavior actually differs (no mesh, no hierarchy). */
export const REFERENCE_IMAGE_ID = '__reference_image__'

/** A fixed world-space rectangle — Pixel Preview's "main render camera": when set, Pixel Preview
 *  frames exactly this rectangle (world units) instead of auto-fitting to the current visible
 *  objects' bounding box every frame, so the pixel-art scale stays stable as objects move/deform
 *  (e.g. Fake Physics swinging a chain) instead of the framing rescaling frame-to-frame. `x`/`y`
 *  is the rectangle's center, in world space; not undo-tracked (a render/export setting, like
 *  `gridVisible`/`meshOpacity`, not scene content). */
export interface PixelFrame {
  x: number
  y: number
  width: number
  height: number
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

/** Sin-wave sway ("flutter") for flags, cloth, hair etc., evaluated fresh from the playhead time
 *  on every render — unlike Fake Physics there's no simulation to converge, so nothing needs
 *  baking. Looping is kept seamless by locking the wave's frequency to a whole number of cycles
 *  across the active clip's duration rather than letting the user pick a raw, possibly-non-looping
 *  frequency.
 *
 *  Two modes sharing one settings object, chosen by whether `anchorVertices` is set: with no
 *  anchors, the whole object rigidly rotates about its head (a swinging pendant/pendulum). With
 *  anchors — vertices pinned in place, e.g. a flag's luff against its pole — the mesh itself
 *  deforms like a real flag: each vertex is displaced *transverse* to `direction` (perpendicular —
 *  a wave traveling along the fabric makes it ripple crosswise, not stretch lengthwise), scaled by
 *  its distance from the nearest anchor (0 right at the anchor, ramping up over one `wavelength` of
 *  distance), so the cloth waves freely at the tip while staying pinned at the anchor. */
export interface FakeFlagSettings {
  enabled: boolean
  /** No anchors: sway amplitude in degrees (rotation swings +-amplitude about the head). With
   *  anchors: peak vertex displacement, in mesh-local world units, transverse to `direction`. */
  amplitude: number
  /** Whole number of full oscillations across the active clip's duration. */
  cyclesPerLoop: number
  /** 0..1 fraction of a cycle to offset the starting phase — desyncs multiple Fake-Flagged objects
   *  from each other, or (with `direction`) makes a wave visibly travel across a row of them. */
  phase: number
  /** No anchors: world-space propagation direction, in degrees, used for inter-object phase offset
   *  (an object further along this direction picks up phase proportional to `wavelength`). With
   *  anchors: the anchor-to-tip propagation direction, in the object's local mesh space — vertices
   *  actually displace *transverse* (perpendicular) to this, not along it. */
  direction: number
  /** No anchors: world units per full cycle of the spatial phase offset along `direction`. With
   *  anchors: local mesh units per full cycle, and also the distance over which a vertex's anchor
   *  falloff ramps from 0 to full strength. */
  wavelength: number
  /** Seeded pseudo-random amplitude jitter per cycle for a less mechanical look — 0 is pure sine,
   *  1 is full-strength jitter. Deterministic per `seed`, and re-synced every loop, so it never
   *  breaks the seamless loop. */
  randomStrength: number
  seed: number
  /** Vertex indices (indexed like `mesh.vertices`) pinned as the "anchor" this object's cloth
   *  waves away from — e.g. a flag's luff edge against its pole. Absent/empty = object-rotation
   *  mode instead of mesh deformation. Assigned via the Properties panel from the current Edit
   *  Mode vertex selection. */
  anchorVertices?: number[]
}

/** "Section+delay" secondary-motion sway (a tail, hair, a loose sleeve) — cascaded from a chain
 *  ROOT down through its Fake-Physics-tagged descendants (the real `parentId` chain, walked at
 *  bake time — chain position is entirely determined by that hierarchy, so there's no separate
 *  section number to track). Unlike Fake Flag this isn't evaluated live: "Bake" runs a damped-
 *  spring simulation across the active clip and writes dense keyframes into
 *  `AnimationClip.fakePhysicsTracks`, so it needs re-baking after the chain's base motion or these
 *  settings change. */
export interface FakePhysicsSettings {
  enabled: boolean
  /** 0..1 abstracted spring feel — 1 is rigid (follows its parent almost instantly, no
   *  overshoot), 0 is jelly (big delay, big wobbly overshoot before settling). Maps internally to
   *  a damping ratio + natural frequency. */
  stiffness: number
  /** 0..1 fraction into the clip's duration where the baked pose starts blending back toward its
   *  own time-0 pose, so a 'loop' clip's seam doesn't pop. 1 = no forced convergence (only safe
   *  for a 'none'/'pingpong' clip, or one already naturally settled by the end). */
  convergeStart: number
}

/** Same "section+delay" secondary motion as `FakePhysicsSettings`, but generalized from a chain of
 *  *objects* to 5 fixed vertex groups within a single mesh (a tail, a pudding's wobbling top, a
 *  cape) — Section 1 (ROOT) always equals the object's own base motion unmodified, and Sections
 *  2-5 each spring-follow the section below with their own stiffness, exactly like the object-chain
 *  version's parent/child cascade. Needs baking (see `AnimationClip.fakePhysicsMeshTracks`) for the
 *  same reason: it's a simulation, not a pure function of time like Fake Flag. */
export interface FakePhysicsMeshSettings {
  enabled: boolean
  /** 'simple' shows one shared Stiffness dial that writes the same value into all five
   *  `sectionStiffness` slots — enough for most uses, and what a newly-added modifier starts in.
   *  'advanced' exposes each section's own dial (the tapered-toward-the-tip tuning the
   *  object-chain version relies on). Purely a UI display choice — `sectionStiffness` is always
   *  the data the simulation actually reads, in both modes. */
  stiffnessMode: 'simple' | 'advanced'
  /** 0..1 abstracted spring feel for each of the 5 sections — index 0 is Section 1 (ROOT), index 4
   *  is Section 5 (TIP). Section 1 lags behind the object's own raw motion exactly like every other
   *  section lags the one before it (a real spring stage, not a hardcoded zero-lag passthrough) —
   *  at the default stiffness of 1 (rigid, see `RigidSpring`) it tracks the object's motion exactly,
   *  which is what makes "1.0 = ROOT behaves like the old hardcoded passthrough" true by
   *  construction rather than a separate special case. Same mapping as `FakePhysicsSettings.
   *  stiffness` (1 = rigid, 0 = jelly), just one dial per section instead of per chain-link object. */
  sectionStiffness: [number, number, number, number, number]
  /** Same meaning as `FakePhysicsSettings.convergeStart`, shared across every section (baked
   *  together in one pass — see `bakeFakePhysicsMesh`). */
  convergeStart: number
  /** What each section's lag offset rotates/translates around. 'head' pivots every section around
   *  the object's own Head — good for a bending tail/rope/cape that swings from one base, since a
   *  section farther from Head naturally shows more positional lag at the same angular delay.
   *  'centroid' pivots each section around its own rest-pose vertex centroid instead — good for an
   *  independently wobbling blob (e.g. a pudding: the rim stays anchored while the top jiggles on
   *  its own), where every section should sway around its own middle rather than one shared point. */
  pivotMode: 'head' | 'centroid'
  /** Vertex indices (indexed like `mesh.vertices`) assigned to each of the 5 sections — index 0 is
   *  Section 1/ROOT ... index 4 is Section 5/TIP. A vertex belongs to at most one section at a
   *  time; assigning it to a new one silently drops it from whichever it was in before. Assigned
   *  from the current Edit Mode selection via the Properties panel, same as Fake Flag's
   *  `anchorVertices`. */
  sectionVertices: [number[], number[], number[], number[], number[]]
}

/** Screen-space occlusion fake, independent of actual Z-order (see project spec) — e.g. a rope
 *  that's always drawn in front of a tree trunk it should appear to wind behind. Rather than
 *  reordering draw order (which would hide the *whole* rope, not just the wrapped segment), this
 *  references one or more mask objects (any `SceneObject`, no separate "is a mask" flag — see
 *  `maskObjectIds`): wherever this object's fragments overlap one of those masks on screen,
 *  they're discarded (via the stencil buffer — see `Viewport.tsx`), regardless of which one is
 *  actually drawn on top. Not baked/simulated — a pure function of the current frame's
 *  screen-space overlap, so it stays correct as objects animate. */
export interface FakeBehindSettings {
  enabled: boolean
  /** Ids of any `SceneObject`s that cut this object away where they overlap it on screen — being
   *  referenced here is what makes an object "a mask" (see `collectFakeBehindMaskIds`), not a
   *  role flag stored on the mask itself. A dangling id (mask deleted) simply contributes nothing
   *  — same tolerant-reference convention as `parentId`/`InsertSlot.targetSlotName`. */
  maskObjectIds: string[]
}

/** Slides an object's own Transform (position, and optionally rotation) along a `kind: 'path'`
 *  object's curve — the Blender "Follow Path" constraint analogue (see project spec). Unlike
 *  `PathDeformRailSettings`, this never touches the mesh at all — the object rides the path as a
 *  rigid body, like a bead on a wire, rather than bending. Not baked/simulated — a pure function of
 *  `progress` and the path's current shape, evaluated at render time (see `followPathTransform`),
 *  so it stays correct as either animates. Offered on any object (no Edit Mode requirement, same
 *  as Fake Flag/FakeBehind — there's no mesh-specific step here at all). */
export interface FollowPathSettings {
  enabled: boolean
  /** Id of the `kind: 'path'` object this object rides along. `null` = not yet assigned. Tolerant
   *  reference — a deleted path just makes this a no-op, same convention as
   *  `parentId`/`FakeBehindSettings.maskObjectIds`. */
  pathObjectId: string | null
  /** 0..1 fraction of the path's current total length — 0 is the path's start, 1 its end. The
   *  "for free" keyframeable dial this whole modifier exists for (see project spec) — animating
   *  this over time is what makes the object travel, without keying a `Transform` snapshot at
   *  every point along a potentially winding curve. */
  progress: number
  /** false (default) — this object's own rotation is left alone; it translates along the path but
   *  keeps facing whichever way it already faced (a bead sliding on a wire). true — rotation is
   *  continuously set to match the path's local tangent direction there (a car turning to follow
   *  the road), Blender's Follow Path "Follow Curve" option. */
  alignRotation: boolean
  /** Only meaningful when `alignRotation` is true. The Head→Tail axis alone pins down which way
   *  is "forward" but not which side is "up" — two mirror-image objects (e.g. a fish modeled with
   *  its dorsal fin on either side of the same nose-tail line) both have their Head pointing the
   *  same way down the path, yet look mirrored. false (default) — the object's own authored
   *  `scaleY` is used as-is. true — `scaleY` is negated (mirrored across the Head→Tail axis, not
   *  across local Y — see `followPathWorldTransform`'s doc for how the rotation math compensates
   *  so Head still points down the path either way), the one remaining degree of freedom Head/Tail
   *  alone can't resolve. */
  flip: boolean
}

/** Bends a `kind: 'lattice'` cage's Basis vertices along a `kind: 'path'` object's curve (see
 *  project spec). Not baked/simulated — a pure function of the current path shape, so it stays
 *  correct as it animates (e.g. via the path's own control points being keyframed). Only ever
 *  offered on a `kind: 'lattice'` cage (see `ModifiersSection`'s `availableTypes`) — see
 *  `pathDeformRail.ts`'s doc for why a cage's sparse control grid is the right scope for this
 *  (an earlier, more general version that applied directly to any mesh's vertices — matching
 *  Blender's Curve Modifier — was removed once this cage-only approach proved to bend more
 *  cleanly, including through tight bends, with no fold-prevention clamp needed). */
export interface PathDeformRailSettings {
  enabled: boolean
  /** Id of the `kind: 'path'` object this cage bends along. `null` = not yet assigned. Tolerant
   *  reference — a deleted path just makes this a no-op, same convention as
   *  `parentId`/`FakeBehindSettings.maskObjectIds`. */
  pathObjectId: string | null
  /** Which of this cage's own local axes runs "along" the path — the other becomes the lateral
   *  distance from it. 'x' (default) matches Blender's Curve Modifier default. */
  axis: 'x' | 'y'
  /** false (default) — this object's own local-axis coordinate maps directly onto the path,
   *  local-axis-min → path start. true — that mapping is mirrored (local-axis-max → path start),
   *  for a mesh whose modeled "front" sits at the opposite end of `axis` from what the path's
   *  start/end direction expects (e.g. a fish modeled tail-first along local X, but the path's
   *  arrow — see the Path object's own start/end indicator — points the other way). Purely a
   *  reinterpretation of which end is which; doesn't change the path/rails themselves. Applies to
   *  whichever local axis `axis` currently reads as "along" the path — the UI always labels this
   *  button "Flip X"/"Flip Y" to match, regardless of which one that is (see `flipLateral` for the
   *  other axis). */
  flip: boolean
  /** Same idea as `flip`, but for the *lateral* axis (the one `axis` doesn't pick) — mirrors which
   *  side is "positive" lateral distance, e.g. swapping which side of the path a mesh modeled
   *  mirror-flipped ends up on. Independent of `flip`/`axis` so either physical local axis (X or Y)
   *  can be flipped regardless of which one is currently "along" the path. */
  flipLateral: boolean
  /** true (default) — this object's own local-axis extent rescales to span the entire path.
   *  false — kept as real local-axis distance, placed `pathOffset` world units along the path
   *  instead, sliding independently of the path's total length. */
  stretch: boolean
  /** Arc-length distance (world units, along the target path) this cage's own local-axis 0 is
   *  placed at. Only meaningful when `stretch` is false — ignored otherwise. */
  pathOffset: number
}

/** Free-Form Deformation (FFD) — bends/squashes a mesh via a `kind: 'lattice'` object used as a
 *  "cage": every vertex is looked up by its normalized position within the cage's *rest* grid
 *  (`SceneObject.cageRestVertices`, frozen at creation), then bilinearly re-interpolated using the
 *  cage's *current* grid — so dragging the cage's own vertices around in Edit Mode
 *  (already-existing UI, no new viewport interaction needed) smoothly deforms every object that
 *  references it. The general-purpose building block a `kind: 'path'`-following deform could
 *  later bend the cage itself along (rather than each target mesh directly), matching how the
 *  user recalled Cinema 4D's Spline Wrap working.
 *
 *  Originally this let *any* mesh object act as a cage, with `cols`/`rows` entered by hand in the
 *  modifier to match — that hand-entry was error-prone (a mismatch silently no-ops the whole
 *  modifier) and duplicated information the cage object already implicitly had. `kind: 'lattice'`
 *  makes the grid dimensions an authoritative property of the cage object itself
 *  (`SceneObject.latticeCols`/`latticeRows`), removing that failure mode entirely. */
export interface FfdSettings {
  enabled: boolean
  /** Id of the `kind: 'lattice'` object used as the deformation cage. `null` = not yet assigned
   *  (modifier is a no-op until one is picked). Tolerant reference — same convention as
   *  `parentId`/`FakeBehindSettings.maskObjectIds`. */
  cageObjectId: string | null
}

/** Which of an object's own `Transform` fields an Oscillator modifier drives. */
export type OscillatorAxis = 'x' | 'y' | 'rotation' | 'scaleX' | 'scaleY'

/** "Oscilloscope"-branded procedural idle-motion driver (see project idea): a pure sine wave,
 *  optionally blended with a few incommensurate-frequency sine harmonics standing in for
 *  deterministic "noise" (`randomness`, 0 = pure sine, 1 = pure noise-ish — never `Math.random()`,
 *  so scrubbing/exporting stays reproducible), added onto one `targetAxis` of this object's own
 *  `transform`. Unlike Fake Physics, a pure function of time (like Fake Flag's rotation sway) — no
 *  simulation/momentum, so it needs no per-frame integration state for its live preview. Not
 *  evaluated live during normal playback though (see `previewOscillator`'s doc): "Add Keyframe"
 *  (the Oscilloscope window's own bake action) samples it across the active clip's duration into
 *  `AnimationClip.oscillatorTracks`, which — like `fakePhysicsTracks` — overrides this object's own
 *  hand-keyed `tracks` entry at eval time once baked. */
export interface OscillatorSettings {
  enabled: boolean
  targetAxis: OscillatorAxis
  /** Seconds per full sine cycle. */
  wavelength: number
  /** Peak deviation from the base value, in the target axis's own units (world units for
   *  x/y, radians for rotation, a plain scale multiplier delta for scaleX/scaleY). */
  amplitude: number
  /** 0..1 blend from pure sine (0) to the seeded pseudo-noise harmonics (1). */
  randomness: number
  /** Seeds the pseudo-noise harmonics — different objects with the same wavelength/amplitude
   *  still desync from each other by picking a different seed. */
  seed: number
}

/** One entry in an object's modifier stack — a Blender-style "add only what you use" list, so an
 *  ordinary object's Properties panel isn't permanently paying rent for every opt-in effect this
 *  app ever grows (Fake Flag/Fake Physics today, FakeBehind later). At most one modifier per
 *  `type` on a given object (re-adding the same type is a no-op) — a discriminated union so each
 *  arm's `settings` type-narrows automatically. */
export type Modifier =
  | { type: 'fakeFlag'; settings: FakeFlagSettings }
  | { type: 'fakePhysics'; settings: FakePhysicsSettings }
  | { type: 'fakePhysicsMesh'; settings: FakePhysicsMeshSettings }
  | { type: 'fakeBehind'; settings: FakeBehindSettings }
  | { type: 'followPath'; settings: FollowPathSettings }
  | { type: 'pathDeformRail'; settings: PathDeformRailSettings }
  | { type: 'ffd'; settings: FfdSettings }
  | { type: 'volumePreserve'; settings: VolumePreserveSettings }
  | { type: 'oscillator'; settings: OscillatorSettings }

/** Object-mode-only squash & stretch helper (Spine2D-style "volume preserve"): keeps one scale
 *  axis (`drivingAxis`) as the one the user keyframes/drags directly, and continuously recomputes
 *  the *other* axis from it every frame — `otherScale = drivingMagnitude ^ -strength`, so
 *  `strength: 1` is exact area preservation (`scaleX * scaleY` constant), `strength: 0` is no
 *  compensation at all, and `strength: 0.5` is the softer `1/sqrt(driving)` some riggers prefer.
 *  Deliberately not offered in Edit Mode — a vertex-mode scale has no single "axis" the way an
 *  object's Scale X/Y does, so there's no well-defined driving value to compensate against. See
 *  `volumePreserve.ts`. */
export interface VolumePreserveSettings {
  enabled: boolean
  drivingAxis: 'x' | 'y'
  /** 0 (no compensation) .. 1 (exact area preservation). */
  strength: number
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
   *  mesh/material/UV-dependent UI are gated off by this flag. 'path' is a curve — like 'empty'
   *  it has no fillable geometry (`mesh.faces` stays empty), but reuses `mesh.vertices` to store
   *  its ordered control points (local space) rather than leaving it empty, since a path's whole
   *  purpose is holding that point list — see `scene/pathCurve.ts` for how they're evaluated into
   *  a smooth curve (Centripetal Catmull-Rom — see project spec). Meant to be referenced by other
   *  objects' Path Follow/Path Deform modifiers (not yet implemented). 'lattice' is an FFD cage
   *  (see `FfdSettings`) — a plain row-major grid mesh (same shape as "Add Rectangle" produces,
   *  `latticeCols`/`latticeRows` giving its authoritative dimensions), edited via the ordinary
   *  Edit Mode vertex tools like any mesh, and rendered/filled normally (unlike 'empty'/'path' it
   *  keeps regular quad `mesh.faces`) so it's easy to see and grab in the viewport. */
  kind?: 'mesh' | 'empty' | 'path' | 'lattice'
  /** Grid dimensions (vertex counts, row-major `idx = j*cols+i`) for a `kind: 'lattice'` object —
   *  meaningless otherwise. Authoritative: `mesh.vertices.length` must equal `cols * rows`, and
   *  ordinary mesh edits that would break that (loop cuts, dissolves) aren't expected to be used
   *  on a lattice, same as a Path's control points aren't expected to gain faces. */
  latticeCols?: number
  latticeRows?: number
  /** `kind: 'path'` only — false/absent (default) is an open curve (start/end are distinct points,
   *  see the start/end arrow drawn in Viewport.tsx). true closes the loop: the curve continues
   *  from the last control point back to the first (an extra segment, not just a straight line —
   *  see `evaluatePathCurve`'s `closed` param), with matching tangent continuity at the seam
   *  (Blender's "Cyclic U" toggle on a curve). Every path-arc-length consumer (`pathDeformRail.ts`,
   *  `followPath.ts`) reads this from the assigned path object so `progress`/`pathOffset` wrap
   *  seamlessly across the seam instead of extrapolating straight past an end that no longer
   *  exists. */
  closed?: boolean
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
  /** A `kind: 'lattice'` object's "undeformed" grid snapshot, for FFD (see `FfdSettings`) —
   *  frozen at creation, or re-baked via an explicit "Reset cage rest shape" action; never touched
   *  by ordinary vertex edits. Same frozen-snapshot convention as `uvBaseVertices`, parallel to
   *  `mesh.vertices` by index rather than keyed by it since every cage vertex needs one (no sparse
   *  fallback makes sense here — a missing entry would silently break the grid math). */
  cageRestVertices?: Vec2[]
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
  /** Opt-in effect stack — see `Modifier`. Absent/empty = none added. */
  modifiers?: Modifier[]
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

/** A single keyed value on a `PathOffsetTrack` — same shape as `ShapeKeyKeyframe` but for
 *  `PathDeformRailSettings.pathOffset` instead of a shape key's blend weight. */
export interface PathOffsetKeyframe {
  id: string
  time: number
  value: number
  easing: EasingType
}

/** One object's animated `pathDeformRail` `pathOffset` track within a clip — parallel to
 *  `ShapeKeyTrack`, but keyed by `objectId` alone (unlike shape keys, an object can have at most
 *  one `pathDeformRail` modifier — see `Modifier`'s "at most one per type" rule — so there's no
 *  need for a second identifying id). Lets `pathOffset` be keyframed the same "crawl along the
 *  path over time" way a shape key's weight is, e.g. animating a rope feeding along a Lattice cage
 *  (see `PathDeformRailSettings.pathOffset`'s doc). */
export interface PathOffsetTrack {
  objectId: string
  keyframes: PathOffsetKeyframe[]
}

/** A single keyed value on a `FollowPathProgressTrack` — same shape as `PathOffsetKeyframe` but
 *  for `FollowPathSettings.progress` instead. */
export interface FollowPathProgressKeyframe {
  id: string
  time: number
  value: number
  easing: EasingType
}

/** One object's animated `followPath` `progress` track within a clip — parallel to
 *  `PathOffsetTrack` (keyed by `objectId` alone, for the same "at most one per type" reason). This
 *  is the whole point of `FollowPathSettings.progress` existing as its own dial rather than
 *  keyframing the object's Transform directly — animating this one scalar drives potentially
 *  complex position (and rotation, if `alignRotation`) changes along a winding path, without
 *  needing a `Transform` key at every point along it. */
export interface FollowPathProgressTrack {
  objectId: string
  keyframes: FollowPathProgressKeyframe[]
}

/** Out-of-range playback behavior once the playhead passes `duration` (or goes below 0 while
 *  scrubbing). 'none' clamps and holds the boundary pose. 'replay' samples exactly like 'none'
 *  (no seamless-loop wrap math, no Fake Physics loop-cycle convergence warm-up) but during Play
 *  simply jumps the playhead back to 0 and keeps going once it hits `duration`, instead of
 *  stopping — a plain "play it again from the top" rather than a mathematically seamless loop
 *  (so a pose that doesn't match at both ends will visibly pop at the restart, unlike 'loop'). */
export type LoopMode = 'none' | 'loop' | 'pingpong' | 'replay'

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
  /** Dense, machine-generated Fake Physics keyframes (see `FakePhysicsSettings`) — kept entirely
   *  separate from the user's own `tracks` so re-baking or clearing the physics layer never
   *  touches hand-authored keyframes. Same shape as `ObjectAnimationTrack`; at eval time these
   *  take priority over `tracks` for the same `objectId` (see `sampleClipAtTime`), since the bake
   *  already folded the object's own base motion into the simulation as its ROOT input. */
  fakePhysicsTracks?: ObjectAnimationTrack[]
  /** Dense, machine-generated Fake Physics *mesh* keyframes (see `FakePhysicsMeshSettings`) — one
   *  track per section (1-5, each a real spring stage) per object. Reuses `TransformKeyframe`'s
   *  shape for its interpolation machinery, but `x`/`y`/`rotation`
   *  carry that section's *offset* from the object's own motion (not an absolute pose) — `scaleX`/
   *  `scaleY`/`head` are unused and always left at their defaults. Unlike `fakePhysicsTracks`, this
   *  doesn't drive the object's own transform: it deforms the mesh directly at render time (see the
   *  viewport's per-vertex delta pipeline, alongside shape keys and Fake Flag's vertex mode). */
  fakePhysicsMeshTracks?: FakePhysicsMeshTrack[]
  /** Path Deform (Rail) `pathOffset` tracks — absent/undefined on older saved projects, treated as
   *  empty. Same "hand-authored, sparse keyframes" nature as `shapeKeyTracks`, not baked. */
  pathOffsetTracks?: PathOffsetTrack[]
  /** Follow Path `progress` tracks — absent/undefined on older saved projects, treated as empty.
   *  Same "hand-authored, sparse keyframes" nature as `pathOffsetTracks`, not baked. */
  followPathProgressTracks?: FollowPathProgressTrack[]
  /** Dense, machine-generated Oscillator keyframes (see `OscillatorSettings`) — same "baked,
   *  overrides `tracks`" convention as `fakePhysicsTracks` (see `sampleClipAtTime`), for the same
   *  reason: the bake already folded the object's own base motion in as its starting point. */
  oscillatorTracks?: ObjectAnimationTrack[]
}

/** One lagging section's baked offset track for one object, within `AnimationClip.fakePhysicsMeshTracks`. */
export interface FakePhysicsMeshTrack {
  objectId: string
  section: 1 | 2 | 3 | 4 | 5
  keyframes: TransformKeyframe[]
}
