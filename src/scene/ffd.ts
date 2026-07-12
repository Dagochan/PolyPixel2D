import { applyTransform, getWorldTransform, inverseTransform } from './transformUtils'
import { pathDeformRailVertexDeltas } from './pathDeformRail'
import type { FfdSettings, SceneObject, Vec2 } from './types'

/** This object's FFD settings, if it has that modifier in its stack (see `Modifier`) —
 *  `undefined` otherwise. Every other function in this module takes `obj` (not raw `settings`)
 *  precisely so this lookup lives in exactly one place. */
export function getFfd(obj: SceneObject): FfdSettings | undefined {
  return obj.modifiers?.find((m): m is Extract<typeof m, { type: 'ffd' }> => m.type === 'ffd')?.settings
}

export const DEFAULT_FFD_SETTINGS: FfdSettings = {
  enabled: true,
  cageObjectId: null,
}

function bilerp(p00: Vec2, p10: Vec2, p01: Vec2, p11: Vec2, tx: number, ty: number): Vec2 {
  const topX = p00.x + (p10.x - p00.x) * tx
  const topY = p00.y + (p10.y - p00.y) * tx
  const bottomX = p01.x + (p11.x - p01.x) * tx
  const bottomY = p01.y + (p11.y - p01.y) * tx
  return { x: topX + (bottomX - topX) * ty, y: topY + (bottomY - topY) * ty }
}

/** Per-vertex local-space deltas that bend `obj`'s Basis mesh according to its assigned FFD
 *  cage's current deformation — see `FfdSettings`'s doc. Each vertex is looked up by its
 *  normalized position within the cage's *rest* grid's bounding box, then bilinearly
 *  re-interpolated from the cage's *current* grid at that same normalized position. Evaluated
 *  entirely in world space so the deforming object's transform and the cage's don't need to
 *  coincide (same convention as FakeBehind/Fake Physics/Path Deform (Rail)). `null` when inactive
 *  (disabled, no cage assigned, cage isn't a `kind: 'lattice'` object, cage has no frozen rest
 *  grid yet, or the cage's vertex count doesn't match its own `latticeCols * latticeRows`).
 *
 *  If the cage itself has a Path Deform (Rail) modifier, that's folded in here (its own pure
 *  function of (cage, allObjects), so it's cheap to just re-evaluate) before reading the cage's
 *  "current" grid — otherwise a path-bent cage would only ever *look* bent in the viewport (Path
 *  Deform (Rail), like FFD, is a display-time transform that never touches `mesh.vertices`)
 *  without anything actually following it, since this function reads `cage.mesh.vertices`
 *  directly. This is what lets a Lattice be bent along a Path and have whatever FFD-references it
 *  follow along — the cage's regular, evenly-spaced grid is a much better-behaved target for that
 *  bend's own arc-length math than an arbitrary silhouette mesh is (see project spec), and every
 *  object referencing that cage inherits the same smooth bend via the bilinear interpolation
 *  below.
 *
 *  Other cage modifiers (shape keys, Fake Flag, Fake Physics) carry per-frame animation state this
 *  pure function has no access to on its own — `deformedVerticesById`, if supplied, is the
 *  caller's own precomputed map of every object's post-shape-key(+Fake Flag+Fake Physics) vertices
 *  (see `composeDisplayObjects`'s two-pass structure), so the cage's *current* grid can reflect a
 *  sculpted Shape Key on the Lattice itself instead of always reading its raw Basis. Falls back to
 *  `cage.mesh.vertices` when omitted (or the cage has no entry), same as before.
 *
 *  `points`, if supplied, are evaluated instead of `obj.mesh.vertices` — same objectLocal→cageLocal
 *  lookup, just against arbitrary object-local points (e.g. `obj.tail`) rather than mesh vertices.
 *  Used by Apply FFD to bake the tail/shape-key/uv points consistently with the mesh itself. */
export function ffdVertexDeltas(
  obj: SceneObject,
  allObjects: SceneObject[],
  deformedVerticesById?: Map<string, Vec2[]>,
  points?: Vec2[],
): Vec2[] | null {
  const settings = getFfd(obj)
  if (!settings?.enabled || !settings.cageObjectId) return null
  const cage = allObjects.find((o) => o.id === settings.cageObjectId)
  if (!cage || cage.kind !== 'lattice') return null
  const rest = cage.cageRestVertices
  if (!rest) return null

  const cols = Math.max(2, Math.floor(cage.latticeCols ?? 0))
  const rows = Math.max(2, Math.floor(cage.latticeRows ?? 0))
  if (rest.length !== cols * rows || cage.mesh.vertices.length !== cols * rows) return null

  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const p of rest) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  const spanX = Math.max(1e-6, maxX - minX)
  const spanY = Math.max(1e-6, maxY - minY)

  const objWorld = getWorldTransform(obj, allObjects)
  const cageWorld = getWorldTransform(cage, allObjects)
  const cageBaseVerts = deformedVerticesById?.get(cage.id) ?? cage.mesh.vertices
  const cagePathDeformDeltas = pathDeformRailVertexDeltas(cage, allObjects)
  const current = cagePathDeformDeltas
    ? cageBaseVerts.map((v, i) => ({ x: v.x + cagePathDeformDeltas[i].x, y: v.y + cagePathDeformDeltas[i].y }))
    : cageBaseVerts

  return (points ?? obj.mesh.vertices).map((v) => {
    const world = applyTransform(v, objWorld)
    const cageLocal = inverseTransform(world, cageWorld)
    // Continuous grid coordinates, clamped to the cage's own extent — a vertex sticking outside
    // the cage's bounds is pinned to whatever the nearest boundary cell does (no extrapolation
    // past the cage for this first version).
    const gx = Math.max(0, Math.min(cols - 1, ((cageLocal.x - minX) / spanX) * (cols - 1)))
    const gy = Math.max(0, Math.min(rows - 1, ((cageLocal.y - minY) / spanY) * (rows - 1)))
    const i0 = Math.min(cols - 2, Math.floor(gx))
    const j0 = Math.min(rows - 2, Math.floor(gy))
    const tx = gx - i0
    const ty = gy - j0
    const p00 = current[j0 * cols + i0]
    const p10 = current[j0 * cols + i0 + 1]
    const p01 = current[(j0 + 1) * cols + i0]
    const p11 = current[(j0 + 1) * cols + i0 + 1]
    const newCageLocal = bilerp(p00, p10, p01, p11, tx, ty)
    const newWorld = applyTransform(newCageLocal, cageWorld)
    const newLocal = inverseTransform(newWorld, objWorld)
    return { x: newLocal.x - v.x, y: newLocal.y - v.y }
  })
}
