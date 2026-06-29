import type { Mesh } from './types'

/**
 * Parses a flat (planar) Wavefront OBJ into our Mesh format.
 * Only `v` and `f` lines are read; vertex normals/UVs and other directives are ignored.
 *
 * Blender's "up" axis ends up in different OBJ columns depending on export settings
 * (Forward/Up Axis), so rather than assuming X/Y are the in-plane axes, we read all
 * three components and drop whichever axis has the least variance across vertices —
 * that's the "flat" axis for a planar object, regardless of how it was exported.
 */
export function parseObjToMesh(text: string): Mesh {
  const raw: { x: number; y: number; z: number }[] = []
  const faces: number[][] = []

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line.startsWith('v ')) {
      const [x, y, z] = line.slice(2).trim().split(/\s+/).map(Number)
      raw.push({ x, y, z: z ?? 0 })
    } else if (line.startsWith('f ')) {
      const refs = line.slice(2).trim().split(/\s+/)
      const face = refs.map((ref) => {
        const vIndexStr = ref.split('/')[0]
        const vIndex = parseInt(vIndexStr, 10)
        // OBJ indices are 1-based; negative indices count from the end of the vertex list.
        return vIndex > 0 ? vIndex - 1 : raw.length + vIndex
      })
      faces.push(face)
    }
  }

  if (raw.length === 0 || faces.length === 0) {
    throw new Error('Could not read any vertices or faces from the OBJ file.')
  }

  const range = (vals: number[]) => Math.max(...vals) - Math.min(...vals)
  const ranges = {
    x: range(raw.map((v) => v.x)),
    y: range(raw.map((v) => v.y)),
    z: range(raw.map((v) => v.z)),
  }
  // drop the flattest axis; keep the other two (in x,y,z order) as our 2D x,y
  const flatAxis = (Object.keys(ranges) as Array<keyof typeof ranges>).reduce((a, b) =>
    ranges[a] <= ranges[b] ? a : b,
  )
  const keep = (['x', 'y', 'z'] as const).filter((axis) => axis !== flatAxis)
  let vertices = raw.map((v) => ({ x: v[keep[0]], y: v[keep[1]] }))

  // normalize to a comparable size to this tool's built-in primitives (~50-150 units),
  // since Blender units come in as-is and are often far too small/large by comparison
  const targetSize = 120
  const span = Math.max(range(vertices.map((v) => v.x)), range(vertices.map((v) => v.y)))
  if (span > 0) {
    const scale = targetSize / span
    vertices = vertices.map((v) => ({ x: v.x * scale, y: v.y * scale }))
  }

  return { vertices, faces }
}
