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
    private managed: boolean = false

    constructor(scene: THREE.Scene, bounds: THREE.Box3, renderer?: THREE.WebGLRenderer, managed = false) {
        this.scene = scene
        this.renderer = renderer || null
        this.originalBounds = bounds.clone()
        this.managed = managed

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
     * Update bounds (e.g. when model changes)
     */
    setBounds(bounds: THREE.Box3): void {
        this.originalBounds.copy(bounds)
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
        // Unproject to world positions (same logic as setFromWorldLine) so both use identical normal formula
        const boundsCenter = this.originalBounds.getCenter(new THREE.Vector3())
        const viewDir = new THREE.Vector3()
        camera.getWorldDirection(viewDir)
        const viewPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(viewDir, boundsCenter)

        const toWorld = (ndc: { x: number; y: number }) => {
            const near = new THREE.Vector3(ndc.x, ndc.y, 0).unproject(camera)
            const far = new THREE.Vector3(ndc.x, ndc.y, 1).unproject(camera)
            const dir = new THREE.Vector3().subVectors(far, near).normalize()
            const ray = new THREE.Ray(near, dir)
            const point = new THREE.Vector3()
            ray.intersectPlane(viewPlane, point)
            return point
        }

        const startWorld = toWorld(startPoint)
        const endWorld = toWorld(endPoint)

        // Use same normal formula as setFromWorldLine for consistent visible side
        this.setFromWorldLine(startWorld, endWorld)
    }

    /**
     * Get model bounds for drag-based section positioning
     */
    getBounds(): THREE.Box3 {
        return this.originalBounds.clone()
    }

    /**
     * Set vertical section plane from world positions (exact 90°/180° in world XZ, no projection distortion)
     */
    setFromWorldLine(startWorld: THREE.Vector3, endWorld: THREE.Vector3): void {
        const dirX = endWorld.x - startWorld.x
        const dirZ = endWorld.z - startWorld.z
        const lenSq = dirX * dirX + dirZ * dirZ
        if (lenSq < 0.0001) {
            this.plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(1, 0, 0), startWorld)
        } else {
            const normal = new THREE.Vector3(dirZ, 0, -dirX).normalize()
            const midPoint = new THREE.Vector3().addVectors(startWorld, endWorld).multiplyScalar(0.5)
            this.plane.setFromNormalAndCoplanarPoint(normal, midPoint)
        }
        this.updateHelper()
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

            // Offset along normal to avoid Z-fighting with clipped model geometry (polygonOffset
            // does not work with logarithmicDepthBuffer). Push fill slightly in front of cut plane.
            const size = this.originalBounds.getSize(new THREE.Vector3())
            const maxDim = Math.max(size.x, size.y, size.z, 1)
            meshCenter.addScaledVector(this.plane.normal, maxDim * 1e-5)

            // Transparent filled plane - limited to building bounds (width/height swapped for orientation)
            const planeGeometry = new THREE.PlaneGeometry(height, width)
            const planeMaterial = new THREE.MeshBasicMaterial({
                color: 0x4ecdc4,
                transparent: true,
                opacity: 0.25,
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
        this.triggerChange()
    }

    /**
     * Enable section clipping (when not managed, applies to renderer/materials; when managed, manager applies)
     */
    enable(): void {
        if (this.enabled) return
        this.enabled = true

        if (!this.managed) {
            if (this.renderer) {
                this.renderer.clippingPlanes = [this.plane]
                this.renderer.localClippingEnabled = true
            }
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
        }

        this.updateHelper()
        this.triggerChange()
    }

    /**
     * Disable section clipping
     */
    disable(): void {
        if (!this.enabled) return
        this.enabled = false

        if (!this.managed) {
            if (this.renderer) {
                this.renderer.clippingPlanes = []
            }
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
        }

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

/**
 * Manages multiple section planes - adding new sections does not remove existing ones
 */
export class SectionPlaneManager {
    private planes: SectionPlane[] = []
    private scene: THREE.Scene
    private bounds: THREE.Box3
    private renderer: THREE.WebGLRenderer | null = null
    private onChangeCallback: (() => void) | null = null

    constructor(scene: THREE.Scene, bounds: THREE.Box3, renderer?: THREE.WebGLRenderer) {
        this.scene = scene
        this.bounds = bounds.clone()
        this.renderer = renderer || null
    }

    setRenderer(renderer: THREE.WebGLRenderer): void {
        this.renderer = renderer
        this.planes.forEach(p => p.setRenderer(renderer))
    }

    setOnChangeCallback(callback: () => void): void {
        this.onChangeCallback = callback
    }

    setBounds(bounds: THREE.Box3): void {
        this.bounds.copy(bounds)
        this.planes.forEach(p => p.setBounds(bounds))
    }

    private triggerChange(): void {
        this.onChangeCallback?.()
    }

    private applyAll(): void {
        const allPlanes = this.planes
            .filter(p => p.isEnabled())
            .map(p => p.getPlane())

        if (this.renderer) {
            this.renderer.clippingPlanes = allPlanes
            this.renderer.localClippingEnabled = allPlanes.length > 0
        }

        this.scene.traverse((object) => {
            if (object instanceof THREE.Mesh && object.material) {
                const materials = Array.isArray(object.material) ? object.material : [object.material]
                materials.forEach(mat => {
                    if (mat instanceof THREE.Material) {
                        mat.clippingPlanes = allPlanes
                        mat.clipShadows = allPlanes.length > 0
                        mat.needsUpdate = true
                    }
                })
            }
        })
    }

    addFromScreenLine(
        startPoint: { x: number; y: number },
        endPoint: { x: number; y: number },
        camera: THREE.PerspectiveCamera
    ): SectionPlane {
        const plane = new SectionPlane(this.scene, this.bounds, this.renderer || undefined, true)
        plane.setOnChangeCallback(() => {
            this.applyAll()
            this.triggerChange()
        })
        plane.setFromScreenLine(startPoint, endPoint, camera)
        plane.enable()
        this.planes.push(plane)
        this.applyAll()
        this.triggerChange()
        return plane
    }

    addFromWorldLine(startWorld: THREE.Vector3, endWorld: THREE.Vector3): SectionPlane {
        const plane = new SectionPlane(this.scene, this.bounds, this.renderer || undefined, true)
        plane.setOnChangeCallback(() => {
            this.applyAll()
            this.triggerChange()
        })
        plane.setFromWorldLine(startWorld, endWorld)
        plane.enable()
        this.planes.push(plane)
        this.applyAll()
        this.triggerChange()
        return plane
    }

    addByDirection(direction: 'top' | 'bottom', worldY: number): SectionPlane {
        const plane = new SectionPlane(this.scene, this.bounds, this.renderer || undefined, true)
        plane.setOnChangeCallback(() => {
            this.applyAll()
            this.triggerChange()
        })
        plane.setByDirection(direction, worldY)
        plane.enable()
        this.planes.push(plane)
        this.applyAll()
        this.triggerChange()
        return plane
    }

    getPlanes(): SectionPlane[] {
        return [...this.planes]
    }

    getLastPlane(): SectionPlane | null {
        return this.planes.length > 0 ? this.planes[this.planes.length - 1] : null
    }

    getBounds(): THREE.Box3 {
        return this.bounds.clone()
    }

    removeLast(): void {
        const last = this.planes.pop()
        if (last) {
            last.disable()
            this.applyAll()
            this.triggerChange()
        }
    }

    hasAnyEnabled(): boolean {
        return this.planes.some(p => p.isEnabled())
    }

    clearAll(): void {
        this.planes.forEach(p => p.disable())
        this.planes = []
        if (this.renderer) {
            this.renderer.clippingPlanes = []
        }
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
        this.triggerChange()
    }

    dispose(): void {
        this.clearAll()
    }
}
