import type { Mesh } from './types'

/** Quad faces for a row-major (idx = j*cols+i) vertex grid. Shared with loop-cut rebuilds. */
export function buildGridFaces(cols: number, rows: number): number[][] {
  const segX = cols - 1
  const segY = rows - 1
  const faces: number[][] = []
  for (let j = 0; j < segY; j++) {
    for (let i = 0; i < segX; i++) {
      const a = j * cols + i
      const b = a + 1
      const c = a + cols + 1
      const d = a + cols
      faces.push([a, b, c, d])
    }
  }
  return faces
}

/** Rectangle subdivided into a grid of quad faces. */
export function createRectMesh(width: number, height: number, segX: number, segY: number): Mesh {
  segX = Math.max(1, Math.floor(segX))
  segY = Math.max(1, Math.floor(segY))
  const vertices: Mesh['vertices'] = []
  const cols = segX + 1
  const rows = segY + 1

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      vertices.push({
        x: -width / 2 + (width * i) / segX,
        y: -height / 2 + (height * j) / segY,
      })
    }
  }

  return { vertices, faces: buildGridFaces(cols, rows) }
}

/** Circle as a fan of triangles around a center vertex. */
export function createCircleMesh(radius: number, segments: number): Mesh {
  segments = Math.max(3, Math.floor(segments))
  const vertices: Mesh['vertices'] = [{ x: 0, y: 0 }]
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * Math.PI * 2
    vertices.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius })
  }

  const faces: number[][] = []
  for (let i = 0; i < segments; i++) {
    const a = 0
    const b = 1 + i
    const c = 1 + ((i + 1) % segments)
    faces.push([a, b, c])
  }

  return { vertices, faces }
}
