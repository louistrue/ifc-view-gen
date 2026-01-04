/**
 * Professional navigation system for 3D BIM viewer
 * Supports both OrbitControls mode (like Revit) and Walk/FPS mode (like games)
 */

import * as THREE from 'three'
import CameraControls from 'camera-controls'

// Initialize camera-controls with Three.js
CameraControls.install({ THREE })

export type NavigationMode = 'orbit' | 'walk'

export interface NavigationState {
  mode: NavigationMode
  target: THREE.Vector3
  position: THREE.Vector3
  rotation: THREE.Euler
}

export class NavigationManager {
  private camera: THREE.PerspectiveCamera
  private scene: THREE.Scene
  private renderer: THREE.WebGLRenderer
  private controls: CameraControls | null = null
  private walkControls: WalkControls | null = null
  private currentMode: NavigationMode = 'orbit'
  private onModeChangeCallbacks: ((mode: NavigationMode) => void)[] = []
  private needsRenderCallback: (() => void) | null = null

  constructor(
    camera: THREE.PerspectiveCamera,
    scene: THREE.Scene,
    renderer: THREE.WebGLRenderer
  ) {
    this.camera = camera
    this.scene = scene
    this.renderer = renderer

    // Initialize orbit controls (default mode)
    this.initializeOrbitControls()
  }

  /**
   * Initialize OrbitControls mode (like Revit/Navisworks)
   */
  private initializeOrbitControls(): void {
    if (this.controls) {
      this.controls.dispose()
    }

    this.controls = new CameraControls(this.camera, this.renderer.domElement)

    // Configure orbit controls for BIM navigation
    this.controls.dollySpeed = 0.5
    this.controls.truckSpeed = 1.0
    this.controls.mouseButtons.wheel = CameraControls.ACTION.DOLLY
    this.controls.mouseButtons.left = CameraControls.ACTION.ROTATE
    this.controls.mouseButtons.right = CameraControls.ACTION.TRUCK
    this.controls.mouseButtons.middle = CameraControls.ACTION.TRUCK

    // Smooth transitions
    this.controls.smoothTime = 0.25

    // Set up update callback
    this.controls.addEventListener('control', () => {
      if (this.needsRenderCallback) {
        this.needsRenderCallback()
      }
    })
  }

  /**
   * Initialize Walk/FPS mode (like games)
   */
  private initializeWalkControls(): void {
    if (this.walkControls) {
      return // Already initialized
    }

    this.walkControls = new WalkControls(
      this.camera,
      this.scene,
      this.renderer.domElement,
      () => {
        if (this.needsRenderCallback) {
          this.needsRenderCallback()
        }
      }
    )
  }

  /**
   * Switch between orbit and walk modes
   */
  setMode(mode: NavigationMode): void {
    if (mode === this.currentMode) return

    const previousMode = this.currentMode
    this.currentMode = mode

    if (mode === 'orbit') {
      // Switch to orbit mode
      if (this.walkControls) {
        this.walkControls.disable()
      }
      this.initializeOrbitControls()
    } else {
      // Switch to walk mode
      if (this.controls) {
        this.controls.enabled = false
      }
      this.initializeWalkControls()
      if (this.walkControls) {
        this.walkControls.enable()
      }
    }

    // Notify callbacks
    this.onModeChangeCallbacks.forEach(cb => cb(mode))
  }

  /**
   * Get current navigation mode
   */
  getMode(): NavigationMode {
    return this.currentMode
  }

  /**
   * Update navigation (call in animation loop)
   */
  update(delta: number): boolean {
    let needsUpdate = false

    if (this.currentMode === 'orbit' && this.controls) {
      const deltaControls = this.controls.update(delta)
      needsUpdate = deltaControls
    } else if (this.currentMode === 'walk' && this.walkControls) {
      this.walkControls.update(delta)
      needsUpdate = true
    }

    return needsUpdate
  }

  /**
   * Register callback for mode changes
   */
  onModeChange(callback: (mode: NavigationMode) => void): void {
    this.onModeChangeCallbacks.push(callback)
  }

  /**
   * Set callback for render requests
   */
  setNeedsRenderCallback(callback: () => void): void {
    this.needsRenderCallback = callback
  }

  /**
   * Focus camera on target (smooth animation) - fits model to screen
   */
  focusOn(target: THREE.Vector3, distance?: number): void {
    if (this.currentMode === 'orbit' && this.controls) {
      // Calculate proper distance to fit model in view
      const box = new THREE.Box3().setFromObject(this.scene)
      const size = box.getSize(new THREE.Vector3())
      const maxDim = Math.max(size.x, size.y, size.z)
      
      // Use FOV to calculate fit distance
      const fov = this.camera.fov * (Math.PI / 180)
      const fitDistance = maxDim / (2 * Math.tan(fov / 2))
      const dollyDistance = distance || fitDistance * 1.2 // 20% margin

      // Position camera at isometric angle
      const offset = dollyDistance / Math.sqrt(3)
      this.controls.setLookAt(
        target.x + offset,
        target.y + offset,
        target.z + offset,
        target.x,
        target.y,
        target.z,
        true // smooth transition
      )
    } else if (this.currentMode === 'walk' && this.walkControls) {
      this.camera.position.set(
        target.x,
        target.y + 1.7, // Eye height
        target.z + 2
      )
      this.camera.lookAt(target)
    }
  }

  /**
   * Set camera to preset view - fits model to fill screen
   */
  setViewPreset(preset: 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'iso'): void {
    if (this.currentMode !== 'orbit') {
      this.setMode('orbit')
    }

    if (!this.controls) return

    const box = new THREE.Box3().setFromObject(this.scene)
    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    
    // Calculate the distance needed to fit the model in view
    // based on camera FOV and model size
    const fov = this.camera.fov * (Math.PI / 180) // Convert to radians
    const aspect = this.camera.aspect
    
    // Determine which dimension to fit based on preset
    let fitSize: number
    switch (preset) {
      case 'top':
      case 'bottom':
        // Looking down/up: fit X and Z dimensions
        fitSize = Math.max(size.x, size.z)
        break
      case 'front':
      case 'back':
        // Looking at front/back: fit X and Y
        fitSize = Math.max(size.x / aspect, size.y)
        break
      case 'left':
      case 'right':
        // Looking at sides: fit Z and Y
        fitSize = Math.max(size.z / aspect, size.y)
        break
      case 'iso':
      default:
        // Isometric: fit the diagonal
        fitSize = Math.max(size.x, size.y, size.z)
    }
    
    // Calculate distance to fit the object in view (with small margin)
    const fitHeightDistance = fitSize / (2 * Math.tan(fov / 2))
    const fitWidthDistance = fitSize / (2 * Math.tan(fov / 2) * aspect)
    const distance = Math.max(fitHeightDistance, fitWidthDistance) * 1.1 // 10% margin

    let position: THREE.Vector3

    switch (preset) {
      case 'top':
        position = new THREE.Vector3(center.x, center.y + distance, center.z)
        break
      case 'bottom':
        position = new THREE.Vector3(center.x, center.y - distance, center.z)
        break
      case 'front':
        position = new THREE.Vector3(center.x, center.y, center.z + distance)
        break
      case 'back':
        position = new THREE.Vector3(center.x, center.y, center.z - distance)
        break
      case 'left':
        // To see the LEFT side of the model, position camera on the RIGHT (positive X)
        position = new THREE.Vector3(center.x + distance, center.y, center.z)
        break
      case 'right':
        // To see the RIGHT side of the model, position camera on the LEFT (negative X)
        position = new THREE.Vector3(center.x - distance, center.y, center.z)
        break
      case 'iso':
      default:
        // Position camera at 45 degrees from all axes
        const isoDistance = distance / Math.sqrt(3) * 1.5 // Adjust for isometric
        position = new THREE.Vector3(
          center.x + isoDistance,
          center.y + isoDistance,
          center.z + isoDistance
        )
    }

    this.controls.setLookAt(
      position.x,
      position.y,
      position.z,
      center.x,
      center.y,
      center.z,
      true // smooth transition
    )
  }

  /**
   * Zoom to fit a screen rectangle (zoom window)
   * Takes pixel coordinates of the selection rectangle
   */
  zoomToRect(
    rect: { x1: number; y1: number; x2: number; y2: number },
    containerWidth: number,
    containerHeight: number
  ): void {
    if (!this.controls) return

    // Get current camera state
    const currentTarget = new THREE.Vector3()
    this.controls.getTarget(currentTarget)
    const cameraDirection = new THREE.Vector3()
    this.camera.getWorldDirection(cameraDirection)
    
    // Calculate the center of the selection in normalized device coordinates
    const centerX = (rect.x1 + rect.x2) / 2
    const centerY = (rect.y1 + rect.y2) / 2
    
    // Convert to NDC (-1 to 1)
    const ndcX = (centerX / containerWidth) * 2 - 1
    const ndcY = -((centerY / containerHeight) * 2 - 1) // Y is inverted
    
    // Calculate the size of selection relative to screen
    const selectionWidth = Math.abs(rect.x2 - rect.x1) / containerWidth
    const selectionHeight = Math.abs(rect.y2 - rect.y1) / containerHeight
    const selectionSize = Math.max(selectionWidth, selectionHeight)
    
    if (selectionSize < 0.01) return // Too small, ignore
    
    // Create a plane at the current target perpendicular to view direction
    // This is where we'll project our new target
    const targetPlane = new THREE.Plane()
    targetPlane.setFromNormalAndCoplanarPoint(cameraDirection.clone().negate(), currentTarget)
    
    // Cast a ray from camera through the center of the selection
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera)
    
    // Find where the ray intersects the target plane - this is our new target
    const newTarget = new THREE.Vector3()
    const intersectionResult = raycaster.ray.intersectPlane(targetPlane, newTarget)
    
    if (!intersectionResult) {
      // Fallback: project to current distance
      const currentDistance = this.camera.position.distanceTo(currentTarget)
      raycaster.ray.at(currentDistance, newTarget)
    }
    
    // Calculate zoom factor based on selection size
    // Smaller selection = more zoom = smaller distance
    const currentDistance = this.camera.position.distanceTo(currentTarget)
    const zoomFactor = Math.min(1 / selectionSize, 8) // Cap at 8x zoom
    const newDistance = Math.max(currentDistance / zoomFactor, 0.5) // Min 0.5 units
    
    // Calculate new camera position: newTarget + direction * distance
    const newPosition = new THREE.Vector3()
      .copy(newTarget)
      .sub(cameraDirection.clone().multiplyScalar(newDistance))
    
    // Animate to new position and target
    this.controls.setLookAt(
      newPosition.x,
      newPosition.y,
      newPosition.z,
      newTarget.x,
      newTarget.y,
      newTarget.z,
      true // smooth transition
    )
  }

  /**
   * Zoom to fit entire scene
   */
  zoomExtents(): void {
    this.setViewPreset('iso')
  }

  /**
   * Zoom to a specific element/bounding box with smooth animation
   */
  zoomToElement(boundingBox: THREE.Box3, padding: number = 1.5): void {
    if (this.currentMode !== 'orbit') {
      this.setMode('orbit')
    }

    if (!this.controls) return

    const center = boundingBox.getCenter(new THREE.Vector3())
    const size = boundingBox.getSize(new THREE.Vector3())
    const maxDim = Math.max(size.x, size.y, size.z)

    // Calculate camera distance for good framing
    const fov = this.camera.fov * (Math.PI / 180)
    const distance = (maxDim * padding) / (2 * Math.tan(fov / 2))

    // Position camera at an isometric angle relative to the element
    const offset = distance / Math.sqrt(3)

    this.controls.setLookAt(
      center.x + offset,
      center.y + offset * 0.5, // Slightly lower angle for door viewing
      center.z + offset,
      center.x,
      center.y,
      center.z,
      true // smooth animation
    )
  }

  /**
   * Zoom to element and look at it from its normal direction (for doors)
   */
  zoomToElementFromNormal(
    boundingBox: THREE.Box3,
    normal: THREE.Vector3,
    padding: number = 2.0
  ): void {
    if (this.currentMode !== 'orbit') {
      this.setMode('orbit')
    }

    if (!this.controls) return

    const center = boundingBox.getCenter(new THREE.Vector3())
    const size = boundingBox.getSize(new THREE.Vector3())
    const maxDim = Math.max(size.x, size.y, size.z)

    // Calculate camera distance for good framing
    const fov = this.camera.fov * (Math.PI / 180)
    const distance = (maxDim * padding) / (2 * Math.tan(fov / 2))

    // Position camera along the normal direction
    const cameraPos = center.clone().add(normal.clone().multiplyScalar(distance))

    // Ensure camera is not below ground
    if (cameraPos.y < 0.5) {
      cameraPos.y = 0.5
    }

    this.controls.setLookAt(
      cameraPos.x,
      cameraPos.y,
      cameraPos.z,
      center.x,
      center.y,
      center.z,
      true // smooth animation
    )
  }

  /**
   * Dispose of controls
   */
  dispose(): void {
    if (this.controls) {
      this.controls.dispose()
      this.controls = null
    }
    if (this.walkControls) {
      this.walkControls.dispose()
      this.walkControls = null
    }
  }
}

/**
 * Walk/FPS controls for first-person navigation
 */
class WalkControls {
  private camera: THREE.PerspectiveCamera
  private scene: THREE.Scene
  private domElement: HTMLElement
  private needsRenderCallback: () => void

  private moveForward = false
  private moveBackward = false
  private moveLeft = false
  private moveRight = false
  private canJump = false
  private velocity = new THREE.Vector3()
  private direction = new THREE.Vector3()
  private raycaster = new THREE.Raycaster()
  private prevTime = performance.now()

  private isPointerLocked = false
  private euler = new THREE.Euler(0, 0, 0, 'YXZ')
  private PI_2 = Math.PI / 2

  constructor(
    camera: THREE.PerspectiveCamera,
    scene: THREE.Scene,
    domElement: HTMLElement,
    needsRenderCallback: () => void
  ) {
    this.camera = camera
    this.scene = scene
    this.domElement = domElement
    this.needsRenderCallback = needsRenderCallback

    this.setupEventListeners()
  }

  private setupEventListeners(): void {
    // Keyboard controls
    const onKeyDown = (event: KeyboardEvent) => {
      switch (event.code) {
        case 'KeyW':
          this.moveForward = true
          break
        case 'KeyS':
          this.moveBackward = true
          break
        case 'KeyA':
          this.moveLeft = true
          break
        case 'KeyD':
          this.moveRight = true
          break
        case 'Space':
          if (this.canJump) {
            this.velocity.y += 10
          }
          event.preventDefault()
          break
      }
    }

    const onKeyUp = (event: KeyboardEvent) => {
      switch (event.code) {
        case 'KeyW':
          this.moveForward = false
          break
        case 'KeyS':
          this.moveBackward = false
          break
        case 'KeyA':
          this.moveLeft = false
          break
        case 'KeyD':
          this.moveRight = false
          break
      }
    }

    // Mouse look
    const onMouseMove = (event: MouseEvent) => {
      if (!this.isPointerLocked) return

      const movementX = event.movementX || 0
      const movementY = event.movementY || 0

      this.euler.setFromQuaternion(this.camera.quaternion)
      this.euler.y -= movementX * 0.002
      this.euler.x -= movementY * 0.002
      this.euler.x = Math.max(-this.PI_2, Math.min(this.PI_2, this.euler.x))
      this.camera.quaternion.setFromEuler(this.euler)

      this.needsRenderCallback()
    }

    // Pointer lock
    const onPointerLockChange = () => {
      this.isPointerLocked = document.pointerLockElement === this.domElement
    }

    const onClick = () => {
      if (!this.isPointerLocked) {
        this.domElement.requestPointerLock()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('keyup', onKeyUp)
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('pointerlockchange', onPointerLockChange)
    this.domElement.addEventListener('click', onClick)

    // Store cleanup
    this.cleanup = () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('keyup', onKeyUp)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('pointerlockchange', onPointerLockChange)
      this.domElement.removeEventListener('click', onClick)
      if (document.pointerLockElement === this.domElement) {
        document.exitPointerLock()
      }
    }
  }

  private cleanup: (() => void) | null = null

  enable(): void {
    // Request pointer lock when enabling walk mode
    this.domElement.requestPointerLock()
  }

  disable(): void {
    if (document.pointerLockElement === this.domElement) {
      document.exitPointerLock()
    }
  }

  update(delta: number): void {
    if (!this.isPointerLocked) return

    // Simple collision detection using raycasting
    this.velocity.x -= this.velocity.x * 10.0 * delta
    this.velocity.z -= this.velocity.z * 10.0 * delta
    this.velocity.y -= 9.8 * 100.0 * delta // gravity

    this.direction.z = Number(this.moveForward) - Number(this.moveBackward)
    this.direction.x = Number(this.moveRight) - Number(this.moveLeft)
    this.direction.normalize()

    const speed = 50.0 // movement speed
    if (this.moveForward || this.moveBackward) {
      this.velocity.z -= this.direction.z * speed * delta
    }
    if (this.moveLeft || this.moveRight) {
      this.velocity.x -= this.direction.x * speed * delta
    }

    // Apply movement
    const moveVector = new THREE.Vector3()
    moveVector.set(this.velocity.x * delta, this.velocity.y * delta, this.velocity.z * delta)
    moveVector.applyQuaternion(this.camera.quaternion)
    this.camera.position.add(moveVector)

    // Simple ground collision (Y = 0)
    if (this.camera.position.y < 1.7) {
      this.camera.position.y = 1.7
      this.velocity.y = 0
      this.canJump = true
    } else {
      this.canJump = false
    }

    this.needsRenderCallback()
  }

  dispose(): void {
    this.disable()
    if (this.cleanup) {
      this.cleanup()
      this.cleanup = null
    }
  }
}

