/**
 * Interactive section plane tool
 * Supports drawing section lines and clicking on faces
 */

import * as THREE from 'three'

export class SectionPlane {
  private plane: THREE.Plane
  private planeMesh: THREE.Mesh | null = null
  private planeOutline: THREE.Mesh | null = null
  private enabled: boolean = false
  private scene: THREE.Scene
  private renderer: THREE.WebGLRenderer | null = null
  private originalBounds: THREE.Box3
  private planeSize: number

  constructor(scene: THREE.Scene, bounds: THREE.Box3, renderer?: THREE.WebGLRenderer) {
    this.scene = scene
    this.renderer = renderer || null
    this.originalBounds = bounds.clone()
    
    // Calculate plane size based on model bounds
    const size = bounds.getSize(new THREE.Vector3())
    this.planeSize = Math.max(size.x, size.y, size.z) * 1.5
    
    // Default plane facing up (horizontal cut)
    this.plane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0)
  }

  /**
   * Set renderer for global clipping
   */
  setRenderer(renderer: THREE.WebGLRenderer): void {
    this.renderer = renderer
  }

  /**
   * Create section from a screen line (perpendicular to view)
   * @param startPoint Start point in NDC (-1 to 1)
   * @param endPoint End point in NDC (-1 to 1)
   * @param camera Camera for unprojection
   */
  setFromScreenLine(
    startPoint: { x: number; y: number },
    endPoint: { x: number; y: number },
    camera: THREE.PerspectiveCamera
  ): void {
    // Get camera basis vectors
    const cameraRight = new THREE.Vector3()
    const cameraUp = new THREE.Vector3()
    const viewDir = new THREE.Vector3()
    camera.matrixWorld.extractBasis(cameraRight, cameraUp, viewDir)
    viewDir.negate() // Camera looks in -Z direction
    
    // Calculate line direction in screen space (NDC)
    const lineDir2D = new THREE.Vector2(
      endPoint.x - startPoint.x,
      endPoint.y - startPoint.y
    ).normalize()
    
    // The section plane normal is perpendicular to the drawn line in screen space
    // Perpendicular in 2D: rotate 90 degrees
    const perpDir2D = new THREE.Vector2(-lineDir2D.y, lineDir2D.x)
    
    // Convert screen perpendicular direction to world space normal
    // This gives us a plane that cuts INTO the screen along the drawn line
    const normal = new THREE.Vector3()
      .addScaledVector(cameraRight, perpDir2D.x)
      .addScaledVector(cameraUp, perpDir2D.y)
      .normalize()
    
    // Calculate where to place the plane
    // Unproject the line midpoint to find intersection with model
    const midPoint2D = {
      x: (startPoint.x + endPoint.x) / 2,
      y: (startPoint.y + endPoint.y) / 2
    }
    
    const nearPoint = new THREE.Vector3(midPoint2D.x, midPoint2D.y, 0).unproject(camera)
    const farPoint = new THREE.Vector3(midPoint2D.x, midPoint2D.y, 1).unproject(camera)
    
    // Create ray through midpoint
    const ray = new THREE.Ray()
    ray.origin.copy(nearPoint)
    ray.direction.copy(farPoint).sub(nearPoint).normalize()
    
    // Intersect with a plane at model center (perpendicular to view)
    const boundsCenter = this.originalBounds.getCenter(new THREE.Vector3())
    const targetPlane = new THREE.Plane()
    targetPlane.setFromNormalAndCoplanarPoint(viewDir, boundsCenter)
    
    const planePoint = new THREE.Vector3()
    const intersected = ray.intersectPlane(targetPlane, planePoint)
    
    if (!intersected) {
      planePoint.copy(boundsCenter)
    }
    
    // Set the section plane with the perpendicular normal
    this.plane.setFromNormalAndCoplanarPoint(normal, planePoint)
    
    // Update helper visualization
    this.updateHelper()
  }

  /**
   * Create section from a face click
   * @param point Click point in world space
   * @param normal Face normal
   */
  setFromFace(point: THREE.Vector3, normal: THREE.Vector3): void {
    // Set plane from face normal and point
    this.plane.setFromNormalAndCoplanarPoint(normal.clone().negate(), point)
    
    // Update helper
    this.updateHelper()
  }

  /**
   * Set plane from world position and camera view direction
   */
  setFromPointAndView(point: THREE.Vector3, camera: THREE.PerspectiveCamera): void {
    const viewDir = new THREE.Vector3()
    camera.getWorldDirection(viewDir)
    
    // Plane normal is opposite to view direction (cuts toward camera)
    this.plane.setFromNormalAndCoplanarPoint(viewDir.negate(), point)
    
    this.updateHelper()
  }

  /**
   * Update the visual helper - creates a nice semi-transparent plane with outline
   */
  private updateHelper(): void {
    // Remove old visuals
    if (this.planeMesh) {
      this.scene.remove(this.planeMesh)
      this.planeMesh.geometry.dispose()
      if (this.planeMesh.material instanceof THREE.Material) {
        this.planeMesh.material.dispose()
      }
      this.planeMesh = null
    }
    if (this.planeOutline) {
      this.scene.remove(this.planeOutline)
      this.planeOutline.geometry.dispose()
      if (this.planeOutline.material instanceof THREE.Material) {
        this.planeOutline.material.dispose()
      }
      this.planeOutline = null
    }

    // Create new visuals if enabled
    if (this.enabled) {
      // Get plane center point
      const planeCenter = new THREE.Vector3()
      this.plane.coplanarPoint(planeCenter)
      
      // Create semi-transparent plane mesh
      const planeGeometry = new THREE.PlaneGeometry(this.planeSize, this.planeSize)
      const planeMaterial = new THREE.MeshBasicMaterial({
        color: 0x4ecdc4, // Teal color
        transparent: true,
        opacity: 0.12,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
      this.planeMesh = new THREE.Mesh(planeGeometry, planeMaterial)
      this.planeMesh.renderOrder = 999
      
      // Create outline ring
      const outlineGeometry = new THREE.RingGeometry(
        this.planeSize * 0.48,
        this.planeSize * 0.5,
        64
      )
      const outlineMaterial = new THREE.MeshBasicMaterial({
        color: 0x4ecdc4,
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
      this.planeOutline = new THREE.Mesh(outlineGeometry, outlineMaterial)
      this.planeOutline.renderOrder = 998
      
      // Position and orient both to match the plane
      const quaternion = new THREE.Quaternion()
      quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 0, 1), // Default plane normal
        this.plane.normal.clone()
      )
      
      this.planeMesh.position.copy(planeCenter)
      this.planeMesh.quaternion.copy(quaternion)
      this.planeOutline.position.copy(planeCenter)
      this.planeOutline.quaternion.copy(quaternion)
      
      this.scene.add(this.planeMesh)
      this.scene.add(this.planeOutline)
    }
  }

  /**
   * Move the section plane along its normal
   */
  offset(distance: number): void {
    this.plane.constant -= distance
    this.updateHelper()
  }

  /**
   * Enable section clipping
   */
  enable(): void {
    if (this.enabled) return
    this.enabled = true
    
    // Use renderer's global clipping planes
    if (this.renderer) {
      this.renderer.clippingPlanes = [this.plane]
      this.renderer.localClippingEnabled = true
    }
    
    // Also apply to materials
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh && object.material) {
        const materials = Array.isArray(object.material) ? object.material : [object.material]
        materials.forEach(mat => {
          if (mat instanceof THREE.Material) {
            mat.clippingPlanes = [this.plane]
            mat.clipShadows = true
            mat.needsUpdate = true
          }
        })
      }
    })

    this.updateHelper()
  }

  /**
   * Disable section clipping
   */
  disable(): void {
    if (!this.enabled) return
    this.enabled = false
    
    // Clear renderer's clipping planes
    if (this.renderer) {
      this.renderer.clippingPlanes = []
    }
    
    // Remove from materials
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh && object.material) {
        const materials = Array.isArray(object.material) ? object.material : [object.material]
        materials.forEach(mat => {
          if (mat instanceof THREE.Material) {
            mat.clippingPlanes = []
            mat.clipShadows = false
            mat.needsUpdate = true
          }
        })
      }
    })

    // Remove visuals
    if (this.planeMesh) {
      this.scene.remove(this.planeMesh)
      this.planeMesh.geometry.dispose()
      if (this.planeMesh.material instanceof THREE.Material) {
        this.planeMesh.material.dispose()
      }
      this.planeMesh = null
    }
    if (this.planeOutline) {
      this.scene.remove(this.planeOutline)
      this.planeOutline.geometry.dispose()
      if (this.planeOutline.material instanceof THREE.Material) {
        this.planeOutline.material.dispose()
      }
      this.planeOutline = null
    }
  }

  /**
   * Check if enabled
   */
  isEnabled(): boolean {
    return this.enabled
  }

  /**
   * Toggle section
   */
  toggle(): void {
    if (this.enabled) {
      this.disable()
    } else {
      this.enable()
    }
  }

  /**
   * Get the plane
   */
  getPlane(): THREE.Plane {
    return this.plane
  }

  /**
   * Flip the section direction
   */
  flip(): void {
    this.plane.negate()
    this.updateHelper()
  }

  /**
   * Dispose resources
   */
  dispose(): void {
    this.disable()
  }
}

/**
 * Raycast to find face normal at click point
 */
export function getFaceAtPoint(
  screenPoint: { x: number; y: number },
  camera: THREE.PerspectiveCamera,
  scene: THREE.Scene,
  containerWidth: number,
  containerHeight: number,
  modelBounds?: THREE.Box3
): { point: THREE.Vector3; normal: THREE.Vector3 } | null {
  // Convert screen coords to NDC
  const ndcX = (screenPoint.x / containerWidth) * 2 - 1
  const ndcY = -((screenPoint.y / containerHeight) * 2 - 1)
  
  // Get view direction for the section normal
  const viewDir = new THREE.Vector3()
  camera.getWorldDirection(viewDir)
  
  // Use model bounds or compute from scene
  let bounds = modelBounds
  if (!bounds) {
    bounds = new THREE.Box3()
    scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh && obj.geometry) {
        const meshBounds = new THREE.Box3().setFromObject(obj)
        if (!meshBounds.isEmpty()) {
          bounds!.union(meshBounds)
        }
      }
    })
  }
  
  // Project click point to a plane at model center
  // (Avoid raycasting because Fragments geometry doesn't support it)
  const boundsCenter = bounds.isEmpty() 
    ? new THREE.Vector3(0, 0, 0) 
    : bounds.getCenter(new THREE.Vector3())
    
  const targetPlane = new THREE.Plane()
  targetPlane.setFromNormalAndCoplanarPoint(viewDir.clone().negate(), boundsCenter)
  
  // Unproject near and far points to create ray
  const nearPoint = new THREE.Vector3(ndcX, ndcY, 0).unproject(camera)
  const farPoint = new THREE.Vector3(ndcX, ndcY, 1).unproject(camera)
  
  const ray = new THREE.Ray()
  ray.origin.copy(nearPoint)
  ray.direction.copy(farPoint).sub(nearPoint).normalize()
  
  const clickPoint = new THREE.Vector3()
  const intersected = ray.intersectPlane(targetPlane, clickPoint)
  
  if (intersected) {
    return {
      point: clickPoint,
      normal: viewDir.clone()
    }
  }
  
  return null
}

