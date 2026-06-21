import type { Mesh } from './types'
import { edgeKey } from './meshUtils'

/** Remove the given faces, then drop any vertices no longer referenced by any remaining face. */
function removeFacesAndOrphanVertices(mesh: Mesh, faceIndicesToRemove: Set<number>): Mesh {
  const keptFaces = mesh.faces.filter((_, fi) => !faceIndicesToRemove.has(fi))

  const usedVerts = new Set<number>()
  for (const face of keptFaces) for (const i of face) usedVerts.add(i)

  const oldToNew = new Map<number, number>()
  const vertices = mesh.vertices.filter((_, i) => usedVerts.has(i))
  let next = 0
  for (let i = 0; i < mesh.vertices.length; i++) {
    if (usedVerts.has(i)) oldToNew.set(i, next++)
  }

  const faces = keptFaces.map((f) => f.map((i) => oldToNew.get(i)!))
  return { vertices, faces }
}

/** Delete vertices: removes any face touching a selected vertex, then the now-orphaned vertices. */
export function deleteVertices(mesh: Mesh, vertexIndices: number[]): Mesh {
  const selected = new Set(vertexIndices)
  const facesToRemove = new Set<number>()
  mesh.faces.forEach((face, fi) => {
    if (face.some((i) => selected.has(i))) facesToRemove.add(fi)
  })
  return removeFacesAndOrphanVertices(mesh, facesToRemove)
}

/** Delete edges: removes any face that uses a selected edge (vertices themselves are kept). */
export function deleteEdges(mesh: Mesh, edgeKeys: string[]): Mesh {
  const selected = new Set(edgeKeys)
  const facesToRemove = new Set<number>()
  mesh.faces.forEach((face, fi) => {
    for (let i = 0; i < face.length; i++) {
      const a = face[i]
      const b = face[(i + 1) % face.length]
      if (selected.has(edgeKey(a, b))) {
        facesToRemove.add(fi)
        break
      }
    }
  })
  // dropping faces only (not orphaning their vertices) keeps the edge-delete semantics
  // distinct from vertex-delete: the vertices stay, just disconnected from any face.
  const keptFaces = mesh.faces.filter((_, fi) => !facesToRemove.has(fi))
  return { vertices: mesh.vertices.map((v) => ({ ...v })), faces: keptFaces }
}

/** Delete faces: removes only the selected faces (vertices/edges remain, even if now unused). */
export function deleteFaces(mesh: Mesh, faceIndices: number[]): Mesh {
  const selected = new Set(faceIndices)
  const faces = mesh.faces.filter((_, fi) => !selected.has(fi))
  return { vertices: mesh.vertices.map((v) => ({ ...v })), faces }
}
