import * as THREE from 'three'
import type { SceneObject } from './types'
import type { ReferenceImage } from './store'
import { getWorldTransform, applyTransform } from './transformUtils'
import { computeSplitUVIslands } from './uv'
import { triangulate } from './meshUtils'

/** Bakes the reference image into a UV-mapped texture for `obj`: for every point on the mesh,
 *  looks up where that point sits in the reference image (via its world position and the
 *  reference image's own world placement) and writes that color at the point's UV location.
 *  Implemented as a single GPU render pass — the geometry's render-space position *is* its UV
 *  (scaled to the output resolution), and its texture coordinate is the corresponding lookup
 *  into the reference image, so the rasterizer does the per-pixel sampling and interpolation. */
export async function bakeReferenceToTexture(
  obj: SceneObject,
  objects: SceneObject[],
  referenceImage: ReferenceImage,
  resolution: number,
): Promise<string> {
  const worldTransform = getWorldTransform(obj, objects)
  const perIsland = computeSplitUVIslands(obj.mesh, obj.uvIslandTransforms, obj.uvBaseVertices)

  const texture = await new THREE.TextureLoader().loadAsync(referenceImage.url)
  texture.colorSpace = THREE.SRGBColorSpace
  const image = texture.image as HTMLImageElement
  const imgWidth = image.width * referenceImage.scale
  const imgHeight = image.height * referenceImage.scale

  const positions: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  let indexOffset = 0
  for (const { mesh: islandMesh, uvs: islandUvs } of perIsland) {
    for (const i of triangulate(islandMesh)) indices.push(i + indexOffset)
    islandMesh.vertices.forEach((v, i) => {
      const world = applyTransform(v, worldTransform)
      // render-space position: the UV atlas coordinate, scaled to pixels of the output texture
      positions.push(islandUvs[i].x * resolution, islandUvs[i].y * resolution, 0)
      // texture coordinate: where this point falls within the reference image, in the same
      // (0,0)-centered, Y-up convention the reference plane itself is placed in world space
      uvs.push((world.x - referenceImage.x) / imgWidth + 0.5, (world.y - referenceImage.y) / imgHeight + 0.5)
    })
    indexOffset += islandMesh.vertices.length
  }

  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geom.setIndex(indices)
  // without `transparent: true`, MeshBasicMaterial ignores the texture's alpha channel when
  // compositing — any fully-transparent area whose RGB happens to be black (the common case for
  // PNGs) would bake in as opaque black instead of staying transparent
  const mat = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, transparent: true })
  const mesh = new THREE.Mesh(geom, mat)

  const scene = new THREE.Scene()
  scene.add(mesh)
  const camera = new THREE.OrthographicCamera(0, resolution, resolution, 0, -10, 10)
  camera.position.z = 1

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
  renderer.setSize(resolution, resolution, false)
  renderer.setClearColor(0x000000, 0)
  renderer.render(scene, camera)
  const dataUrl = renderer.domElement.toDataURL('image/png')

  geom.dispose()
  mat.dispose()
  texture.dispose()
  renderer.dispose()

  return dataUrl
}
