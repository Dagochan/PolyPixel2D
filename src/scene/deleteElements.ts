import type { Mesh } from './types'
import { edgeKey } from './meshUtils'

/** Remove the given faces, then drop any vertices no longer referenced by any remaining face. */
function removeFacesAndOrphanVertices(
  mesh: Mesh,
  faceIndicesToRemove: Set<number>,
): { mesh: Mesh; oldToNew: Map<number, number> } {
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
  return { mesh: { vertices, faces }, oldToNew }
}

/** Delete vertices: removes any face touching a selected vertex, then the now-orphaned vertices.
 *  Also returns the old->new vertex index map (see `pruneOrphanVerticesTracked`) since this always
 *  drops vertices, so callers must remap index-keyed per-object data via `remapObjectVertexData`. */
export function deleteVertices(
  mesh: Mesh,
  vertexIndices: number[],
): { mesh: Mesh; oldToNew: Map<number, number> } {
  const selected = new Set(vertexIndices)
  const facesToRemove = new Set<number>()
  mesh.faces.forEach((face, fi) => {
    if (face.some((i) => selected.has(i))) facesToRemove.add(fi)
  })
  return removeFacesAndOrphanVertices(mesh, facesToRemove)
}

/**
 * Delete edges: removes any face that uses a selected edge. Vertices that end up touching
 * no remaining face are pruned by the caller (store.ts wraps this with pruneOrphanVertices) —
 * vertices still used by some other, unaffected face are of course left alone.
 */
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
  const faces = mesh.faces.filter((_, fi) => !facesToRemove.has(fi))
  return { vertices: mesh.vertices.map((v) => ({ ...v })), faces }
}

/**
 * Delete faces: removes only the selected faces. Vertices that end up touching no remaining
 * face are pruned by the caller (store.ts wraps this with pruneOrphanVertices). Also remaps
 * `faceColors` onto the surviving faces' new indices — one of the few topology-changing ops that
 * carries it over (see `Mesh.faceColors`'s doc for the ones that don't).
 */
export function deleteFaces(mesh: Mesh, faceIndices: number[]): Mesh {
  const selected = new Set(faceIndices)
  const faces: number[][] = []
  const faceColors: Record<number, string> = {}
  mesh.faces.forEach((face, fi) => {
    if (selected.has(fi)) return
    const color = mesh.faceColors?.[fi]
    if (color) faceColors[faces.length] = color
    faces.push(face)
  })
  return {
    vertices: mesh.vertices.map((v) => ({ ...v })),
    faces,
    ...(mesh.faceColors ? { faceColors } : {}),
  }
}
