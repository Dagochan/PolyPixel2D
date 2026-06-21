import type { Mesh, Vec2 } from './types'

export type MergeMode = 'first' | 'last' | 'center'

/**
 * Merge all vertices in `orderedIndices` into one. The survivor is always orderedIndices[0]
 * (relocated per `mode`); every other index in the list is remapped to it. Faces that become
 * degenerate (fewer than 3 distinct vertices, or any leftover internal duplicate — e.g. merging
 * two non-adjacent corners of the same face) are dropped rather than left self-intersecting.
 */
export function mergeVertices(
  mesh: Mesh,
  orderedIndices: number[],
  mode: MergeMode,
): { mesh: Mesh; survivorIndex: number } {
  if (orderedIndices.length < 2) return { mesh, survivorIndex: orderedIndices[0] ?? -1 }
  const survivor = orderedIndices[0]
  const toMerge = new Set(orderedIndices)

  const survivorPos: Vec2 =
    mode === 'first'
      ? mesh.vertices[orderedIndices[0]]
      : mode === 'last'
        ? mesh.vertices[orderedIndices[orderedIndices.length - 1]]
        : (() => {
            let x = 0
            let y = 0
            for (const i of orderedIndices) {
              x += mesh.vertices[i].x
              y += mesh.vertices[i].y
            }
            return { x: x / orderedIndices.length, y: y / orderedIndices.length }
          })()

  const remap = (i: number) => (toMerge.has(i) ? survivor : i)

  const collapsedFaces: number[][] = []
  for (const face of mesh.faces) {
    const mapped = face.map(remap)
    // collapse consecutive duplicates, including the wrap-around pair
    const collapsed: number[] = []
    for (const v of mapped) {
      if (collapsed.length === 0 || collapsed[collapsed.length - 1] !== v) collapsed.push(v)
    }
    if (collapsed.length > 1 && collapsed[0] === collapsed[collapsed.length - 1]) collapsed.pop()
    if (collapsed.length < 3) continue
    if (new Set(collapsed).size !== collapsed.length) continue // non-adjacent merge -> bowtie, drop
    collapsedFaces.push(collapsed)
  }

  const vertices = mesh.vertices.map((v, i) => (i === survivor ? survivorPos : v))

  const usedVerts = new Set<number>()
  for (const f of collapsedFaces) for (const i of f) usedVerts.add(i)
  const oldToNew = new Map<number, number>()
  const finalVertices: Vec2[] = []
  vertices.forEach((v, i) => {
    if (usedVerts.has(i)) {
      oldToNew.set(i, finalVertices.length)
      finalVertices.push(v)
    }
  })
  const finalFaces = collapsedFaces.map((f) => f.map((i) => oldToNew.get(i)!))

  return { mesh: { vertices: finalVertices, faces: finalFaces }, survivorIndex: oldToNew.get(survivor) ?? -1 }
}
