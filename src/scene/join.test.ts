import { describe, expect, it } from 'vitest'
import { joinObjects } from './join'
import type { SceneObject } from './types'

function makeObject(overrides: Partial<SceneObject> & { id: string }): SceneObject {
  return {
    name: overrides.id,
    mesh: { vertices: [], faces: [] },
    transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, head: { x: 0, y: 0 } },
    tail: { x: 0, y: 0 },
    zOrder: 0,
    visible: true,
    material: { color: '#ffffff' },
    parentId: null,
    connected: true,
    ...overrides,
  }
}

// a 1x1 quad at the local origin
const unitQuad = {
  vertices: [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ],
  faces: [[0, 1, 2, 3]],
}

describe('joinObjects', () => {
  it('keeps every donor vertex at its original world-space position', () => {
    const target = makeObject({ id: 'target', mesh: unitQuad, zOrder: 0 })
    // donor offset +10 on x, rotated 90deg — its world-space square sits at x in [10,11], y in [-1,0]
    const donor = makeObject({
      id: 'donor',
      mesh: unitQuad,
      transform: { x: 10, y: 0, rotation: -Math.PI / 2, scaleX: 1, scaleY: 1, head: { x: 0, y: 0 } },
      zOrder: 1,
    })
    const merged = joinObjects(target, [donor])
    expect(merged.mesh.vertices).toHaveLength(8)
    // target's own transform is identity, so target-local space === world space here
    const donorWorldPositions = merged.mesh.vertices.slice(4).map((v) => ({ x: Math.round(v.x * 1000) / 1000, y: Math.round(v.y * 1000) / 1000 }))
    expect(donorWorldPositions).toEqual([
      { x: 10, y: 0 },
      { x: 10, y: -1 },
      { x: 11, y: -1 },
      { x: 11, y: 0 },
    ])
  })

  it('appends donor faces with vertex indices offset by the target vertex count', () => {
    const target = makeObject({ id: 'target', mesh: unitQuad })
    const donor = makeObject({ id: 'donor', mesh: unitQuad, transform: { x: 5, y: 0, rotation: 0, scaleX: 1, scaleY: 1, head: { x: 0, y: 0 } } })
    const merged = joinObjects(target, [donor])
    expect(merged.mesh.faces).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6, 7],
    ])
  })

  it("bakes a donor's differing material color as an explicit faceColors override, but not when colors match", () => {
    const target = makeObject({ id: 'target', mesh: unitQuad, material: { color: '#111111' } })
    const sameColorDonor = makeObject({ id: 'd1', mesh: unitQuad, material: { color: '#111111' } })
    const diffColorDonor = makeObject({ id: 'd2', mesh: unitQuad, material: { color: '#ff0000' } })
    const merged = joinObjects(target, [sameColorDonor, diffColorDonor])
    // face 0 = target, face 1 = sameColorDonor (no override), face 2 = diffColorDonor (overridden)
    expect(merged.mesh.faceColors?.[0]).toBeUndefined()
    expect(merged.mesh.faceColors?.[1]).toBeUndefined()
    expect(merged.mesh.faceColors?.[2]).toBe('#ff0000')
  })

  it('orders merged islands by source zOrder, folding each source into sequential islandZOrders', () => {
    // target has 2 disconnected quads (2 islands), donor has 1 — donor drawn behind target (lower zOrder)
    const twoQuads = {
      vertices: [...unitQuad.vertices, { x: 5, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 1 }, { x: 5, y: 1 }],
      faces: [
        [0, 1, 2, 3],
        [4, 5, 6, 7],
      ],
    }
    const target = makeObject({ id: 'target', mesh: twoQuads, zOrder: 5 })
    const donor = makeObject({ id: 'donor', mesh: unitQuad, zOrder: 1 })
    const merged = joinObjects(target, [donor])
    // 3 islands total: donor's (lowest zOrder) should rank before both of target's
    const ranks = Object.values(merged.islandZOrders ?? {})
    expect(new Set(ranks)).toEqual(new Set([0, 1, 2]))
    // find which new island index is the donor's (its single face is index 2 in the merged mesh)
    const donorIslandIdx = 2 // faces: [target island A (face 0), target island B (face 1), donor (face 2)] -> islands in that face order
    expect(merged.islandZOrders?.[donorIslandIdx]).toBe(0)
  })

  it('rekeys shape key positions and arcPivot into target-local space', () => {
    const target = makeObject({ id: 'target', mesh: unitQuad })
    const donor = makeObject({
      id: 'donor',
      mesh: unitQuad,
      transform: { x: 100, y: 0, rotation: 0, scaleX: 1, scaleY: 1, head: { x: 0, y: 0 } },
      shapeKeys: [{ id: 'sk1', name: 'Key', positions: { 0: { x: 0.5, y: 0.5 } }, arcPivot: { x: 0, y: 0 } }],
      shapeKeyValues: { sk1: 0.75 },
    })
    const merged = joinObjects(target, [donor])
    expect(merged.shapeKeys).toHaveLength(1)
    const key = merged.shapeKeys![0]
    expect(key.id).toBe('sk1')
    // donor vertex 0 -> merged index 4; its shape key target moves with the same +100 world offset
    expect(key.positions[4]).toEqual({ x: 100.5, y: 0.5 })
    expect(key.arcPivot).toEqual({ x: 100, y: 0 })
    expect(merged.shapeKeyValues?.sk1).toBe(0.75)
  })
})
