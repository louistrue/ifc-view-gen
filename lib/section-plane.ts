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
    private onChangeCallback: (() => void) | null = null

    constructor(scene: THREE.Scene, bounds: THREE.Box3, renderer?: THREE.WebGLRenderer) {
        this.scene = scene
        this.renderer = renderer || null
        this.originalBounds = bounds.clone()

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
        let normal = new THREE.Vector3()
            .addScaledVector(cameraRight, perpDir2D.x)
            .addScaledVector(cameraUp, perpDir2D.y)

        // Force vertical section: plane normal must be horizontal (Y-up: normal.y = 0)
        // So the section plane is always vertical (90° to Z/Y-axis), like a wall
        normal.y = 0
        const lenSq = normal.x * normal.x + normal.z * normal.z
        if (lenSq < 0.0001) {
            normal.set(1, 0, 0)
        } else {
            normal.normalize()
        }

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
     * Get model bounds for drag-based section positioning
     */
    getBounds(): THREE.Box3 {
        return this.originalBounds.clone()
    }

    /**
     * Set horizontal section plane by direction and world Y
     * @param direction 'top' = drag from top (keep above plane), 'bottom' = drag from bottom (keep below plane)
     * @param worldY World Y coordinate for the section plane
     */
    setByDirection(direction: 'top' | 'bottom', worldY: number): void {
        const center = this.originalBounds.getCenter(new THREE.Vector3())
        const point = new THREE.Vector3(center.x, worldY, center.z)
        // top: keep y > worldY (above plane) -> normal (0,1,0)
        // bottom: keep y < worldY (below plane) -> normal (0,-1,0)
        const normal = direction === 'top' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, -1, 0)
        this.plane.setFromNormalAndCoplanarPoint(normal, point)
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
     * Get the 2D extent of the bounding box projected onto the section plane.
     */
    private getPlaneExtentFromBounds(): {
        width: number
        height: number
        centerU: number
        centerV: number
        u: THREE.Vector3
        v: THREE.Vector3
    } {
        const normal = this.plane.normal
        const planeCenter = new THREE.Vector3()
        this.plane.coplanarPoint(planeCenter)

        // Build orthonormal basis in the plane: u and v
        let u = new THREE.Vector3()
        if (Math.abs(normal.y) < 0.9) {
            u.crossVectors(new THREE.Vector3(0, 1, 0), normal)
        } else {
            u.crossVectors(new THREE.Vector3(1, 0, 0), normal)
        }
        u.normalize()

        const v = new THREE.Vector3().crossVectors(normal, u).normalize()

        // Project 8 corners of bounding box onto plane, then to 2D
        const min = this.originalBounds.min
        const max = this.originalBounds.max
        const corners = [
            new THREE.Vector3(min.x, min.y, min.z),
            new THREE.Vector3(max.x, min.y, min.z),
            new THREE.Vector3(min.x, max.y, min.z),
            new THREE.Vector3(max.x, max.y, min.z),
            new THREE.Vector3(min.x, min.y, max.z),
            new THREE.Vector3(max.x, min.y, max.z),
            new THREE.Vector3(min.x, max.y, max.z),
            new THREE.Vector3(max.x, max.y, max.z),
        ]

        let minU = Infinity, maxU = -Infinity
        let minV = Infinity, maxV = -Infinity

        const toPlane = new THREE.Vector3()
        for (const corner of corners) {
            toPlane.copy(corner).sub(planeCenter)
            const uVal = toPlane.dot(u)
            const vVal = toPlane.dot(v)
            minU = Math.min(minU, uVal)
            maxU = Math.max(maxU, uVal)
            minV = Math.min(minV, vVal)
            maxV = Math.max(maxV, vVal)
        }

        const width = Math.max(maxU - minU, 0.01)
        const height = Math.max(maxV - minV, 0.01)
        const centerU = (minU + maxU) / 2
        const centerV = (minV + maxV) / 2
        return { width, height, centerU, centerV, u, v }
    }

    /**
     * Update the visual helper - plane and outline limited to building bounds
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
            const planeCenter = new THREE.Vector3()
            this.plane.coplanarPoint(planeCenter)

            const { width, height, centerU, centerV, u, v } = this.getPlaneExtentFromBounds()
            // Swap width/height to match PlaneGeometry orientation (90° correction)
            const halfW = height / 2
            const halfH = width / 2

            const quaternion = new THREE.Quaternion()
            quaternion.setFromUnitVectors(
                new THREE.Vector3(0, 0, 1),
                this.plane.normal.clone()
            )

            // Mesh center = plane point + offset to bounds center
            const meshCenter = new THREE.Vector3()
                .copy(planeCenter)
                .addScaledVector(u, centerU)
                .addScaledVector(v, centerV)

            // Transparent filled plane - limited to building bounds (width/height swapped for orientation)
            const planeGeometry = new THREE.PlaneGeometry(height, width)
            const planeMaterial = new THREE.MeshBasicMaterial({
                color: 0x4ecdc4,
                transparent: true,
                opacity: 0.15,
                side: THREE.DoubleSide,
                depthWrite: false,
                depthTest: true,
                clippingPlanes: [], // Don't clip the section plane visual itself
            })
            this.planeMesh = new THREE.Mesh(planeGeometry, planeMaterial)
            this.planeMesh.position.copy(meshCenter)
            this.planeMesh.quaternion.copy(quaternion)
            this.planeMesh.renderOrder = 998
            this.scene.add(this.planeMesh)

            // Create rectangular outline - bounds of building
            const vertices = new Float32Array([
                // Rectangle outline
                -halfW, -halfH, 0, halfW, -halfH, 0,   // bottom
                halfW, -halfH, 0, halfW, halfH, 0,     // right
                halfW, halfH, 0, -halfW, halfH, 0,    // top
                -halfW, halfH, 0, -halfW, -halfH, 0,  // left
                // Cross lines for subtle visual reference
                -halfW * 0.1, 0, 0, halfW * 0.1, 0, 0,
                0, -halfH * 0.1, 0, 0, halfH * 0.1, 0,
            ])

            const lineGeometry = new THREE.BufferGeometry()
            lineGeometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3))

            const lineMaterial = new THREE.LineBasicMaterial({
                color: 0x4ecdc4,
                transparent: true,
                opacity: 0.6,
                depthWrite: false,
                depthTest: true,
                clippingPlanes: [], // Don't clip the section plane visual itself
            })

            this.planeOutline = new THREE.LineSegments(lineGeometry, lineMaterial) as unknown as THREE.Mesh
            this.planeOutline.renderOrder = 999

            this.planeOutline.position.copy(meshCenter)
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


