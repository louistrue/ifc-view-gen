/**
 * Interactive section plane tool
 * Supports drawing section lines
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
    private onChangeCallback: (() => void) | null = null

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
     * Set callback to trigger render when section changes
     */
    setOnChangeCallback(callback: () => void): void {
        this.onChangeCallback = callback
    }

    /**
     * Trigger render callback
     */
    private triggerChange(): void {
        if (this.onChangeCallback) {
            this.onChangeCallback()
        }
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
     * Update the visual helper - elegant thin rectangular outline only
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

            // Create elegant thin rectangular outline using LineSegments
            // Rectangle vertices in local space
            const half = this.planeSize / 2
            const vertices = new Float32Array([
                // Rectangle outline
                -half, -half, 0, half, -half, 0,  // bottom
                half, -half, 0, half, half, 0,   // right
                half, half, 0, -half, half, 0,  // top
                -half, half, 0, -half, -half, 0, // left
                // Cross lines for subtle visual reference
                -half * 0.1, 0, 0, half * 0.1, 0, 0,  // small center horizontal
                0, -half * 0.1, 0, 0, half * 0.1, 0,  // small center vertical
            ])

            const lineGeometry = new THREE.BufferGeometry()
            lineGeometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3))

            const lineMaterial = new THREE.LineBasicMaterial({
                color: 0x4ecdc4,
                transparent: true,
                opacity: 0.6,
                depthWrite: false,
                depthTest: true,
            })

            this.planeOutline = new THREE.LineSegments(lineGeometry, lineMaterial) as unknown as THREE.Mesh
            this.planeOutline.renderOrder = 999

            // Position and orient to match the plane
            const quaternion = new THREE.Quaternion()
            quaternion.setFromUnitVectors(
                new THREE.Vector3(0, 0, 1), // Default plane normal
                this.plane.normal.clone()
            )

            this.planeOutline.position.copy(planeCenter)
            this.planeOutline.quaternion.copy(quaternion)

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

        // Force materials to recognize the change
        this.scene.traverse((object) => {
            if (object instanceof THREE.Mesh && object.material) {
                const materials = Array.isArray(object.material) ? object.material : [object.material]
                materials.forEach(mat => {
                    if (mat instanceof THREE.Material) {
                        mat.needsUpdate = true
                    }
                })
            }
        })

        this.updateHelper()
        this.triggerChange()
    }

    /**
     * Dispose resources
     */
    dispose(): void {
        this.disable()
    }
}


