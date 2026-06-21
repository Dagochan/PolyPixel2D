import type { GridInfo, Mesh, Vec2 } from './types'
import { buildGridFaces } from './primitives'

function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

/** Insert new horizontal loops (rows) between rows `afterRow` and `afterRow+1`, at each t in `ts` (ascending). */
export function insertLoopCutRows(
  mesh: Mesh,
  grid: GridInfo,
  afterRow: number,
  ts: number[],
): { mesh: Mesh; grid: GridInfo } {
  const { cols, rows } = grid
  const vertices: Vec2[] = []
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) vertices.push(mesh.vertices[j * cols + i])
    if (j === afterRow) {
      for (const t of ts) {
        for (let i = 0; i < cols; i++) {
          const a = mesh.vertices[j * cols + i]
          const b = mesh.vertices[(j + 1) * cols + i]
          vertices.push(lerp(a, b, t))
        }
      }
    }
  }
  const newGrid: GridInfo = { cols, rows: rows + ts.length }
  return { mesh: { vertices, faces: buildGridFaces(newGrid.cols, newGrid.rows) }, grid: newGrid }
}

/** Insert new vertical loops (columns) between columns `afterCol` and `afterCol+1`, at each t in `ts` (ascending). */
export function insertLoopCutColumns(
  mesh: Mesh,
  grid: GridInfo,
  afterCol: number,
  ts: number[],
): { mesh: Mesh; grid: GridInfo } {
  const { cols, rows } = grid
  const vertices: Vec2[] = []
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      vertices.push(mesh.vertices[j * cols + i])
      if (i === afterCol) {
        for (const t of ts) {
          const a = mesh.vertices[j * cols + i]
          const b = mesh.vertices[j * cols + i + 1]
          vertices.push(lerp(a, b, t))
        }
      }
    }
  }
  const newGrid: GridInfo = { cols: cols + ts.length, rows }
  return { mesh: { vertices, faces: buildGridFaces(newGrid.cols, newGrid.rows) }, grid: newGrid }
}
