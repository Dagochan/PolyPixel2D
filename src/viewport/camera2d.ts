import * as THREE from 'three'

export interface ViewState {
  panX: number
  panY: number
  zoom: number // world units visible per pixel is inverse of this; higher zoom = more zoomed in
}

export function makeOrthoCamera(width: number, height: number, view: ViewState) {
  const halfW = width / 2 / view.zoom
  const halfH = height / 2 / view.zoom
  const camera = new THREE.OrthographicCamera(
    -halfW,
    halfW,
    halfH,
    -halfH,
    -1000,
    1000,
  )
  camera.position.set(view.panX, view.panY, 100)
  camera.lookAt(view.panX, view.panY, 0)
  return camera
}

export function updateOrthoCamera(camera: THREE.OrthographicCamera, width: number, height: number, view: ViewState) {
  const halfW = width / 2 / view.zoom
  const halfH = height / 2 / view.zoom
  camera.left = -halfW
  camera.right = halfW
  camera.top = halfH
  camera.bottom = -halfH
  camera.position.set(view.panX, view.panY, 100)
  camera.updateProjectionMatrix()
}

export function screenToWorld(
  clientX: number,
  clientY: number,
  rect: DOMRect,
  view: ViewState,
): { x: number; y: number } {
  const px = clientX - rect.left - rect.width / 2
  const py = clientY - rect.top - rect.height / 2
  return {
    x: view.panX + px / view.zoom,
    y: view.panY - py / view.zoom,
  }
}
