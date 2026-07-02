import type { Mesh, Vec2 } from './types'

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

function normalize(v: Vec2): Vec2 {
  const len = Math.hypot(v.x, v.y) || 1
  return { x: v.x / len, y: v.y / len }
}

function segmentDir(points: Vec2[], i: number): Vec2 {
  return normalize({ x: points[i + 1].x - points[i].x, y: points[i + 1].y - points[i].y })
}

/** The mitered normal at path point `i`: the averaged (and re-normalized) direction of its two
 *  adjacent segments, so the ribbon doesn't pinch or gap at a bend. The two ends only have one
 *  adjacent segment each, so they just use that segment's normal directly. */
function miteredNormal(points: Vec2[], i: number): Vec2 {
  const n = points.length
  const dir =
    i === 0
      ? segmentDir(points, 0)
      : i === n - 1
        ? segmentDir(points, n - 2)
        : normalize({
            x: segmentDir(points, i - 1).x + segmentDir(points, i).x,
            y: segmentDir(points, i - 1).y + segmentDir(points, i).y,
          })
  return { x: -dir.y, y: dir.x }
}

/** A ribbon along a hand-drawn path, full `width` at the root (`points[0]`). By default (hair/fur
 *  card) it narrows linearly to a single converged vertex at the tip (`points[n-1]`) — no
 *  separate tip-width parameter. With `constantWidth`, it instead stays full width all the way to
 *  the tip (a left/right pair there too, no convergence) — for belts, straps, and other ribbons
 *  that shouldn't taper. Requires at least 2 points. */
export function createHairPathMesh(points: Vec2[], width: number, constantWidth = false): Mesh {
  const n = points.length
  const vertices: Mesh['vertices'] = []
  const faces: number[][] = []

  const lastPaired = constantWidth ? n - 1 : n - 2 // last point that gets a left/right pair
  for (let i = 0; i <= lastPaired; i++) {
    const normal = miteredNormal(points, i)
    const w = (constantWidth ? width : width * (1 - i / (n - 1))) / 2
    vertices.push({ x: points[i].x + normal.x * w, y: points[i].y + normal.y * w })
    vertices.push({ x: points[i].x - normal.x * w, y: points[i].y - normal.y * w })
  }
  for (let i = 0; i < lastPaired; i++) {
    const a = i * 2
    const b = a + 1
    faces.push([a, a + 2, a + 3, b])
  }

  if (!constantWidth) {
    vertices.push({ ...points[n - 1] }) // tip: single converged vertex, no left/right pair
    const tipIdx = vertices.length - 1
    const last = lastPaired * 2
    faces.push([last, tipIdx, last + 1])
  }

  return { vertices, faces }
}
