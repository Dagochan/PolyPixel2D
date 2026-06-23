import type { Mesh, Vec2 } from './types'
import { edgeKey, parseEdgeKey } from './meshUtils'

/** edge key ("a_b") -> weight 0-1 */
export type CreaseEdgeMap = Map<string, number>
/** vertex index -> weight 0-1 */
export type CreaseVertexMap = Map<number, number>

/**
 * One level of Catmull-Clark subdivision, generic over any number of parallel per-vertex
 * attribute channels (e.g. position, UV) — all channels share the same topology/weights, so
 * subdividing position and UV together in one pass keeps them in sync automatically.
 *
 * `creaseEdges`/`creaseVertices` are weights (0-1, absent = 0) that blend each edge/vertex
 * toward the "sharp" rule instead of the smooth one — that's what a crease is.
 */
function subdivideOnce(
  faces: number[][],
  vertexCount: number,
  attrChannels: Vec2[][],
  creaseEdges: CreaseEdgeMap,
  creaseVertices: CreaseVertexMap,
): { faces: number[][]; attrChannels: Vec2[][] } {
  // a mesh-boundary edge (only one adjacent face) has no "smooth" side to average with, so it's
  // always fully sharp regardless of any crease weight
  const edgeWeight = (a: number, b: number, faceCount: number) =>
    faceCount < 2 ? 1 : creaseEdges.get(edgeKey(a, b)) ?? 0

  // how many faces touch each edge, and which faces touch each vertex
  const edgeFaceCount = new Map<string, number>()
  const vertexFaces: number[][] = Array.from({ length: vertexCount }, () => [])
  faces.forEach((face, fi) => {
    for (let i = 0; i < face.length; i++) {
      const a = face[i]
      const b = face[(i + 1) % face.length]
      const key = edgeKey(a, b)
      edgeFaceCount.set(key, (edgeFaceCount.get(key) ?? 0) + 1)
      vertexFaces[a].push(fi)
    }
  })

  const lerp = (p: Vec2, q: Vec2, t: number): Vec2 => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t })
  const avg = (pts: Vec2[]): Vec2 => {
    let x = 0
    let y = 0
    for (const p of pts) {
      x += p.x
      y += p.y
    }
    return { x: x / pts.length, y: y / pts.length }
  }

  // new vertex index allocation: original vertices keep their index, then one face-point per
  // face, then one edge-point per edge
  const facePointIndex = new Map<number, number>()
  const edgePointIndex = new Map<string, number>()
  let nextIndex = vertexCount
  faces.forEach((_, fi) => facePointIndex.set(fi, nextIndex++))
  for (const key of edgeFaceCount.keys()) edgePointIndex.set(key, nextIndex++)

  const outChannels = attrChannels.map((channel) => {
    const out: Vec2[] = new Array(nextIndex)

    // face points: centroid of the face's original vertices, for every channel
    faces.forEach((face, fi) => {
      out[facePointIndex.get(fi)!] = avg(face.map((vi) => channel[vi]))
    })

    // edge points: midpoint on a fully-sharp edge, average of the edge's two endpoints and its
    // two adjacent face points on a fully-smooth one, and a blend of the two in between
    for (const key of edgeFaceCount.keys()) {
      const [a, b] = parseEdgeKey(key)
      const count = edgeFaceCount.get(key)!
      const w = edgeWeight(a, b, count)
      const sharpPoint = lerp(channel[a], channel[b], 0.5)
      if (w >= 1) {
        out[edgePointIndex.get(key)!] = sharpPoint
      } else {
        const adjFacePoints: Vec2[] = []
        faces.forEach((face, fi) => {
          for (let i = 0; i < face.length; i++) {
            const x = face[i]
            const y = face[(i + 1) % face.length]
            if (edgeKey(x, y) === key) adjFacePoints.push(out[facePointIndex.get(fi)!])
          }
        })
        const smoothPoint = avg([channel[a], channel[b], ...adjFacePoints])
        out[edgePointIndex.get(key)!] = w > 0 ? lerp(smoothPoint, sharpPoint, w) : smoothPoint
      }
    }

    // repositioned original vertices
    for (let vi = 0; vi < vertexCount; vi++) {
      const incidentFaces = vertexFaces[vi]
      // edges touching this vertex, with whether each is (fully) sharp and its key — partial
      // edge crease still feeds into the edge-point blend above, but for picking which *rule*
      // a vertex uses, an edge only counts as a boundary-like edge once it's fully creased
      const incidentEdges: { other: number; key: string; sharp: boolean }[] = []
      faces.forEach((face) => {
        for (let i = 0; i < face.length; i++) {
          const a = face[i]
          const b = face[(i + 1) % face.length]
          if (a !== vi && b !== vi) continue
          const other = a === vi ? b : a
          const key = edgeKey(a, b)
          if (incidentEdges.some((e) => e.key === key)) continue
          incidentEdges.push({ other, key, sharp: edgeWeight(a, b, edgeFaceCount.get(key)!) >= 1 })
        }
      })
      const sharpEdges = incidentEdges.filter((e) => e.sharp)

      let rulePosition: Vec2
      if (sharpEdges.length === 2 && incidentFaces.length > 0) {
        // boundary/crease vertex: smooth along the boundary polyline (corner-cutting rule) —
        // this is what actually rounds out a 2D shape's silhouette under repeated subdivision
        const p = channel[vi]
        const n0 = channel[sharpEdges[0].other]
        const n1 = channel[sharpEdges[1].other]
        rulePosition = { x: (n0.x + 6 * p.x + n1.x) / 8, y: (n0.y + 6 * p.y + n1.y) / 8 }
      } else if (sharpEdges.length === 0 && incidentFaces.length >= 3) {
        // interior vertex: standard Catmull-Clark smooth rule
        const n = incidentFaces.length
        const F = avg(incidentFaces.map((fi) => out[facePointIndex.get(fi)!]))
        const R = avg(incidentEdges.map((e) => lerp(channel[vi], channel[e.other], 0.5)))
        const P = channel[vi]
        rulePosition = {
          x: (F.x + 2 * R.x + (n - 3) * P.x) / n,
          y: (F.y + 2 * R.y + (n - 3) * P.y) / n,
        }
      } else {
        // corner (3+ sharp edges meeting, or a degenerate vertex) — leave fixed rather than
        // guess; this is the simple, safe fallback the crease feature can refine later
        rulePosition = channel[vi]
      }

      // vertex crease: blend the rule's result back toward the original position — at weight 1
      // the vertex doesn't move at all under this subdivision step, staying a sharp point
      const vw = creaseVertices.get(vi) ?? 0
      out[vi] = vw > 0 ? lerp(rulePosition, channel[vi], vw) : rulePosition
    }

    return out
  })

  // new faces: 4 quads per original face, one per corner
  const outFaces: number[][] = []
  faces.forEach((face, fi) => {
    const fp = facePointIndex.get(fi)!
    for (let i = 0; i < face.length; i++) {
      const prevEdgeKey = edgeKey(face[(i - 1 + face.length) % face.length], face[i])
      const nextEdgeKey = edgeKey(face[i], face[(i + 1) % face.length])
      outFaces.push([face[i], edgePointIndex.get(nextEdgeKey)!, fp, edgePointIndex.get(prevEdgeKey)!])
    }
  })

  return { faces: outFaces, attrChannels: outChannels }
}

function toEdgeMap(record: Record<string, number> | undefined): CreaseEdgeMap {
  return new Map(Object.entries(record ?? {}))
}

function toVertexMap(record: Record<number, number> | undefined): CreaseVertexMap {
  return new Map(Object.entries(record ?? {}).map(([k, v]) => [Number(k), v]))
}

/** Subdivide a mesh's positions `levels` times (0 = unchanged), returning a new Mesh. */
export function subdivideMesh(
  mesh: Mesh,
  levels: number,
  creaseEdges?: Record<string, number>,
  creaseVertices?: Record<number, number>,
): Mesh {
  if (levels <= 0) return mesh
  const edgeMap = toEdgeMap(creaseEdges)
  const vertexMap = toVertexMap(creaseVertices)
  let faces = mesh.faces
  let channels = [mesh.vertices]
  for (let i = 0; i < levels; i++) {
    const result = subdivideOnce(faces, channels[0].length, channels, edgeMap, vertexMap)
    faces = result.faces
    channels = result.attrChannels
  }
  return { vertices: channels[0], faces }
}

/** Subdivide positions and UVs together (same topology/weights), `levels` times. */
export function subdivideMeshWithUVs(
  mesh: Mesh,
  uvs: Vec2[],
  levels: number,
  creaseEdges?: Record<string, number>,
  creaseVertices?: Record<number, number>,
): { mesh: Mesh; uvs: Vec2[] } {
  if (levels <= 0) return { mesh, uvs }
  const edgeMap = toEdgeMap(creaseEdges)
  const vertexMap = toVertexMap(creaseVertices)
  let faces = mesh.faces
  let channels = [mesh.vertices, uvs]
  for (let i = 0; i < levels; i++) {
    const result = subdivideOnce(faces, channels[0].length, channels, edgeMap, vertexMap)
    faces = result.faces
    channels = result.attrChannels
  }
  return { mesh: { vertices: channels[0], faces }, uvs: channels[1] }
}
