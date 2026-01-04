/**
 * Section box for cutting through the model
 * Uses Three.js clipping planes to create section views
 */

import * as THREE from 'three'

export interface SectionBoxBounds {
    min: THREE.Vector3
    max: THREE.Vector3
}

export class SectionBox {
    private planes: THREE.Plane[] = []
    private boxHelper: THREE.LineSegments | null = null
    private cutPlane: THREE.Mesh | null = null
    private enabled: boolean = false
    private bounds: SectionBoxBounds
    private originalBounds: SectionBoxBounds
    private scene: THREE.Scene
    private renderer: THREE.WebGLRenderer | null = null

    constructor(scene: THREE.Scene, bounds: SectionBoxBounds, renderer?: THREE.WebGLRenderer) {
        this.scene = scene
        this.bounds = { ...bounds }
        this.originalBounds = {
            min: bounds.min.clone(),
            max: bounds.max.clone()
        }
        this.renderer = renderer || null

        // Shrink bounds slightly to show a visible section cut
        const size = new THREE.Vector3().subVectors(bounds.max, bounds.min)
        const shrinkFactor = 0.2 // Cut 20% from top

        const sectionBounds = {
            min: bounds.min.clone(),
            max: bounds.max.clone()
        }
        sectionBounds.max.y = bounds.max.y - size.y * shrinkFactor

        // Create 6 clipping planes (one for each face of the box)
        this.planes = [
            new THREE.Plane(new THREE.Vector3(1, 0, 0), -sectionBounds.min.x),
            new THREE.Plane(new THREE.Vector3(-1, 0, 0), sectionBounds.max.x),
            new THREE.Plane(new THREE.Vector3(0, 1, 0), -sectionBounds.min.y),
            new THREE.Plane(new THREE.Vector3(0, -1, 0), sectionBounds.max.y),
            new THREE.Plane(new THREE.Vector3(0, 0, 1), -sectionBounds.min.z),
            new THREE.Plane(new THREE.Vector3(0, 0, -1), sectionBounds.max.z),
        ]

        this.bounds = sectionBounds

        // Create visual helpers
        this.createVisuals(sectionBounds)
    }

    /**
     * Create elegant visual helpers for the section box - thin wireframe only
     */
    private createVisuals(bounds: { min: THREE.Vector3; max: THREE.Vector3 }): void {
        // Create a subtle wireframe box
        const boxGeometry = new THREE.BoxGeometry(
            bounds.max.x - bounds.min.x,
            bounds.max.y - bounds.min.y,
            bounds.max.z - bounds.min.z
        )
        const edges = new THREE.EdgesGeometry(boxGeometry)
        const lineMaterial = new THREE.LineBasicMaterial({
            color: 0x4ecdc4, // Teal color
            transparent: true,
            opacity: 0.5,
        })
        this.boxHelper = new THREE.LineSegments(edges, lineMaterial)
        this.boxHelper.position.set(
            (bounds.min.x + bounds.max.x) / 2,
            (bounds.min.y + bounds.max.y) / 2,
            (bounds.min.z + bounds.max.z) / 2
        )
        this.boxHelper.visible = false
        boxGeometry.dispose()

        // Create thin outline rectangle at the top cut (no fill)
        const planeWidth = bounds.max.x - bounds.min.x
        const planeDepth = bounds.max.z - bounds.min.z
        const halfW = planeWidth / 2
        const halfD = planeDepth / 2

        // Rectangle outline vertices
        const outlineVertices = new Float32Array([
            -halfW, 0, -halfD, halfW, 0, -halfD,  // front edge
            halfW, 0, -halfD, halfW, 0, halfD,   // right edge
            halfW, 0, halfD, -halfW, 0, halfD,  // back edge
            -halfW, 0, halfD, -halfW, 0, -halfD, // left edge
        ])

        const outlineGeometry = new THREE.BufferGeometry()
        outlineGeometry.setAttribute('position', new THREE.BufferAttribute(outlineVertices, 3))

        const outlineMaterial = new THREE.LineBasicMaterial({
            color: 0x4ecdc4,
            transparent: true,
            opacity: 0.7,
        })

        this.cutPlane = new THREE.LineSegments(outlineGeometry, outlineMaterial) as unknown as THREE.Mesh
        this.cutPlane.position.set(
            (bounds.min.x + bounds.max.x) / 2,
            bounds.max.y,
            (bounds.min.z + bounds.max.z) / 2
        )
        this.cutPlane.visible = false
        this.cutPlane.renderOrder = 999 // Render on top
    }

    /**
     * Set renderer for global clipping
     */
    setRenderer(renderer: THREE.WebGLRenderer): void {
        this.renderer = renderer
    }

    /**
     * Enable section box clipping
     */
    enable(): void {
        if (this.enabled) return
        this.enabled = true

        // Use renderer's global clipping planes
        if (this.renderer) {
            this.renderer.clippingPlanes = this.planes
            this.renderer.localClippingEnabled = true
        }

        // Also apply to materials as fallback
        this.scene.traverse((object) => {
            if (object instanceof THREE.Mesh && object.material) {
                const materials = Array.isArray(object.material) ? object.material : [object.material]
                materials.forEach(mat => {
                    if (mat instanceof THREE.Material) {
                        mat.clippingPlanes = this.planes
                        mat.clipShadows = true
                        mat.needsUpdate = true
                    }
                })
            }
        })

        // Show visual helpers
        if (this.boxHelper) {
            this.boxHelper.visible = true
            if (!this.boxHelper.parent) {
                this.scene.add(this.boxHelper)
            }
        }
        if (this.cutPlane) {
            this.cutPlane.visible = true
            if (!this.cutPlane.parent) {
                this.scene.add(this.cutPlane)
            }
        }
    }

    /**
     * Disable section box clipping
     */
    disable(): void {
        if (!this.enabled) return
        this.enabled = false

        // Clear renderer's global clipping planes
        if (this.renderer) {
            this.renderer.clippingPlanes = []
        }

        // Remove clipping planes from materials
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

        // Hide visual helpers
        if (this.boxHelper) {
            this.boxHelper.visible = false
        }
        if (this.cutPlane) {
            this.cutPlane.visible = false
        }
    }

    /**
     * Update section box bounds
     */
    setBounds(bounds: SectionBoxBounds): void {
        this.bounds = bounds

        // Update plane positions
        this.planes[0].constant = -bounds.min.x
        this.planes[1].constant = bounds.max.x
        this.planes[2].constant = -bounds.min.y
        this.planes[3].constant = bounds.max.y
        this.planes[4].constant = -bounds.min.z
        this.planes[5].constant = bounds.max.z

        // Update visuals
        this.updateVisuals()
    }

    /**
     * Update visual helpers to match current bounds
     */
    private updateVisuals(): void {
        if (this.boxHelper) {
            // Recreate box helper with new bounds
            const boxGeometry = new THREE.BoxGeometry(
                this.bounds.max.x - this.bounds.min.x,
                this.bounds.max.y - this.bounds.min.y,
                this.bounds.max.z - this.bounds.min.z
            )
            const edges = new THREE.EdgesGeometry(boxGeometry)
            this.boxHelper.geometry.dispose()
            this.boxHelper.geometry = edges
            this.boxHelper.position.set(
                (this.bounds.min.x + this.bounds.max.x) / 2,
                (this.bounds.min.y + this.bounds.max.y) / 2,
                (this.bounds.min.z + this.bounds.max.z) / 2
            )
            boxGeometry.dispose()
        }

        if (this.cutPlane) {
            this.cutPlane.position.y = this.bounds.max.y
        }
    }

    /**
     * Set section cut height (0-1, where 1 is full model)
     */
    setCutHeight(ratio: number): void {
        const size = new THREE.Vector3().subVectors(this.originalBounds.max, this.originalBounds.min)
        const newMaxY = this.originalBounds.min.y + size.y * Math.max(0.1, Math.min(1, ratio))

        // Update top plane
        this.planes[3].constant = newMaxY
        this.bounds.max.y = newMaxY

        this.updateVisuals()
    }

    /**
     * Get current bounds
     */
    getBounds(): SectionBoxBounds {
        return this.bounds
    }

    /**
     * Check if section box is enabled
     */
    isEnabled(): boolean {
        return this.enabled
    }

    /**
     * Toggle section box
     */
    toggle(): void {
        if (this.enabled) {
            this.disable()
        } else {
            this.enable()
        }
    }

    /**
     * Reset to original bounds
     */
    reset(): void {
        this.setBounds(this.originalBounds)
    }

    /**
     * Dispose resources
     */
    dispose(): void {
        this.disable()
        if (this.boxHelper) {
            this.scene.remove(this.boxHelper)
            this.boxHelper.geometry.dispose()
            if (this.boxHelper.material instanceof THREE.Material) {
                this.boxHelper.material.dispose()
            }
        }
        if (this.cutPlane) {
            this.scene.remove(this.cutPlane)
            this.cutPlane.geometry.dispose()
            if (this.cutPlane.material instanceof THREE.Material) {
                this.cutPlane.material.dispose()
            }
        }
    }
}
