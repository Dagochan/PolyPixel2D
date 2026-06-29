import type { Mesh, Vec2 } from './types'
import { edgeKey } from './meshUtils'

/** A triangle fan around `center` (e.g. a circle primitive) — `rim` is the ordered ring of outer
 *  vertices, and `faces[i]` is the triangle (center, rim[i], rim[i+1]) (wrapping if `closed`). */
export interface FanPath {
  center: number
  rim: number[]
  faces: number[]
  closed: boolean
}

function buildEdgeFaceMap(mesh: Mesh): Map<string, number[]> {
  const map = new Map<string, number[]>()
  mesh.faces.forEach((face, fi) => {
    for (let i = 0; i < face.length; i++) {
      const a = face[i]
      const b = face[(i + 1) % face.length]
      const key = edgeKey(a, b)
      const arr = map.get(key)
      if (arr) arr.push(fi)
      else map.set(key, [fi])
    }
  })
  return map
}

function thirdVertex(face: number[], center: number, rimVertex: number): number | null {
  for (const v of face) {
    if (v !== center && v !== rimVertex) return v
  }
  return null
}

/** Walk the fan of triangles around `center` in one direction, starting from the spoke edge
 *  (center, startRim) via `startFace`. Stops at a non-triangle/boundary, or reports `closed` if
 *  it makes it all the way back around to `startRim`. */
function walkFan(
  mesh: Mesh,
  edgeFaceMap: Map<string, number[]>,
  center: number,
  startRim: number,
  startFace: number,
): { rim: number[]; faces: number[]; closed: boolean } {
  const rim: number[] = []
  const faces: number[] = []
  let currentRim = startRim
  let currentFace = startFace
  const guard = mesh.faces.length + 1
  for (let i = 0; i < guard; i++) {
    const face = mesh.faces[currentFace]
    if (face.length !== 3) break
    const next = thirdVertex(face, center, currentRim)
    if (next === null) break
    faces.push(currentFace)
    if (next === startRim) return { rim, faces, closed: true }
    rim.push(next)
    const candidates = edgeFaceMap.get(edgeKey(center, next)) ?? []
    const nextFace = candidates.find((fi) => fi !== currentFace)
    if (nextFace === undefined) break
    currentFace = nextFace
    currentRim = next
  }
  return { rim, faces, closed: false }
}

/** Find the full triangle fan around `center`, starting from the spoke edge (center, hoverRim) —
 *  walks both directions until hitting a boundary, or all the way back around (closed, e.g. a
 *  full circle). Null if (center, hoverRim) isn't a spoke of any triangle. */
export function findFan(mesh: Mesh, center: number, hoverRim: number): FanPath | null {
  const edgeFaceMap = buildEdgeFaceMap(mesh)
  const adjFaces = (edgeFaceMap.get(edgeKey(center, hoverRim)) ?? []).filter(
    (fi) => mesh.faces[fi].length === 3 && mesh.faces[fi].includes(center),
  )
  if (adjFaces.length === 0) return null

  const fwd = walkFan(mesh, edgeFaceMap, center, hoverRim, adjFaces[0])
  if (fwd.closed) return { center, rim: [hoverRim, ...fwd.rim], faces: fwd.faces, closed: true }
  if (adjFaces.length === 1) return { center, rim: [hoverRim, ...fwd.rim], faces: fwd.faces, closed: false }

  const bwd = walkFan(mesh, edgeFaceMap, center, hoverRim, adjFaces[1])
  return {
    center,
    rim: [...bwd.rim.slice().reverse(), hoverRim, ...fwd.rim],
    faces: [...bwd.faces.slice().reverse(), ...fwd.faces],
    closed: false,
  }
}

function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

/** Insert one or more concentric rings into a triangle fan (e.g. a circle primitive), splitting
 *  it into a smaller inner fan plus a quad "ring" strip per cut — the fan equivalent of a loop
 *  cut, since a fan has no quad strip for the ordinary loop cut to walk. `ts` are fractions from
 *  the center (0) to the rim (1), in any order. */
export function applyRingCut(mesh: Mesh, path: FanPath, ts: number[]): { mesh: Mesh } {
  const vertices = mesh.vertices.map((v) => ({ ...v }))
  const sortedTs = [...ts].sort((a, b) => a - b)
  const centerV = mesh.vertices[path.center]

  // one new ring of vertices per t, indexed [ringIdx][rimIdx], innermost (smallest t) first
  const rings: number[][] = sortedTs.map((t) =>
    path.rim.map((r) => {
      const idx = vertices.length
      vertices.push(lerp(centerV, mesh.vertices[r], t))
      return idx
    }),
  )

  const segCount = path.closed ? path.rim.length : path.rim.length - 1
  const nextIdx = (i: number) => (path.closed ? (i + 1) % path.rim.length : i + 1)

  const newFaces: number[][] = []
  for (let i = 0; i < segCount; i++) {
    const j = nextIdx(i)
    newFaces.push([path.center, rings[0][i], rings[0][j]])
  }
  for (let r = 0; r < rings.length - 1; r++) {
    for (let i = 0; i < segCount; i++) {
      const j = nextIdx(i)
      newFaces.push([rings[r][i], rings[r][j], rings[r + 1][j], rings[r + 1][i]])
    }
  }
  const lastRing = rings[rings.length - 1]
  for (let i = 0; i < segCount; i++) {
    const j = nextIdx(i)
    newFaces.push([lastRing[i], lastRing[j], path.rim[j], path.rim[i]])
  }

  const faceSet = new Set(path.faces)
  const faces = mesh.faces.filter((_, fi) => !faceSet.has(fi)).map((f) => [...f])
  faces.push(...newFaces)

  return { mesh: { vertices, faces } }
}
