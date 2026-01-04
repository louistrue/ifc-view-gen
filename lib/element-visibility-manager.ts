/**
 * Element visibility manager using Fragments API
 * Provides hide/show/isolate/filter/highlight functionality with optimal performance
 */

import { FragmentsModel, FragmentsModels } from '@thatopen/fragments'
import * as THREE from 'three'
import type { ElementInfo } from './ifc-types'
import type { SpatialNode } from './spatial-structure'
import { getAllElementIds } from './spatial-structure'

// Highlight colors for different states
export const HIGHLIGHT_COLORS = {
    hovered: new THREE.Color(0x00ff88),    // Bright green for hover
    selected: new THREE.Color(0xffd700),   // Gold/yellow for selection (more visible)
    filtered: new THREE.Color(0x4ecdc4),   // Teal for filtered doors
}

export class ElementVisibilityManager {
    private fragmentsModel: FragmentsModel
    private fragmentsManager: FragmentsModels | null = null
    private elements: Map<number, ElementInfo>
    private allModelIds: number[] = [] // All geometry IDs in the model
    private originalVisibility: Map<number, boolean> = new Map()
    private hiddenElements: Set<number> = new Set()
    private isolatedElements: Set<number> | null = null
    private typeFilters: Set<string> = new Set()
    private ifcClassFilters: Set<string> = new Set()
    private transparencyMap: Map<number, number> = new Map() // localId -> opacity (0-1)
    private onRenderNeeded: (() => void) | null = null

    // Highlight state
    private hoveredElementId: number | null = null
    private highlightedElements: Set<number> = new Set()
    private selectedElements: Set<number> = new Set()
    private originalMaterials: Map<THREE.Mesh, THREE.Material | THREE.Material[]> = new Map()
    private highlightMeshes: Map<number, THREE.Object3D> = new Map() // For glow/outline effects (can be Mesh or Group)
    private scene: THREE.Scene | null = null

    constructor(fragmentsModel: FragmentsModel, elements: ElementInfo[]) {
        this.fragmentsModel = fragmentsModel
        this.elements = new Map()
        elements.forEach(el => {
            this.elements.set(el.expressID, el)
            this.originalVisibility.set(el.expressID, true)
        })

        // Cache all model IDs for isolation operations
        this.cacheAllModelIds()
    }

    /**
     * Cache all local IDs from the model for isolation operations
     */
    private async cacheAllModelIds(): Promise<void> {
        try {
            const ids = await this.fragmentsModel.getItemsIdsWithGeometry()
            this.allModelIds = Array.isArray(ids) ? ids : Array.from(ids)
        } catch (e) {
            console.warn('Failed to cache model IDs:', e)
            // Fallback to tracked elements
            this.allModelIds = Array.from(this.elements.keys())
        }
    }

    /**
     * Set the fragments manager for update calls
     */
    setFragmentsManager(manager: FragmentsModels): void {
        this.fragmentsManager = manager
    }

    /**
     * Set callback for when render is needed
     */
    setRenderCallback(callback: () => void): void {
        this.onRenderNeeded = callback
    }

    /**
     * Apply visibility changes and trigger render
     */
    private async applyChanges(): Promise<void> {
        // Update Fragments internal state
        if (this.fragmentsManager) {
            try {
                await this.fragmentsManager.update(true)
            } catch (e) {
                console.error('Error updating fragments manager:', e)
            }
        }

        // Trigger render AFTER fragments update is complete
        if (this.onRenderNeeded) {
            this.onRenderNeeded()
        }
    }

    /**
     * Hide elements by localIds
     */
    async hideElements(localIds: number[]): Promise<void> {
        for (const id of localIds) {
            this.hiddenElements.add(id)
        }
        await this.fragmentsModel.setVisible(Array.from(this.hiddenElements), false)
        await this.applyChanges()
    }

    /**
     * Hide ALL elements in the model (not just tracked ones)
     */
    async hideAllElements(): Promise<void> {
        // Ensure we have all model IDs cached
        if (this.allModelIds.length === 0) {
            await this.cacheAllModelIds()
        }

        await this.fragmentsModel.setVisible(this.allModelIds, false)
        await this.applyChanges()
    }

    /**
     * Set visibility for specific elements (works with any IDs, not just tracked ones)
     */
    async setElementsVisible(localIds: number[], visible: boolean): Promise<void> {
        await this.fragmentsModel.setVisible(localIds, visible)
        await this.applyChanges()
    }

    /**
     * Show elements by localIds
     */
    async showElements(localIds: number[]): Promise<void> {
        for (const id of localIds) {
            this.hiddenElements.delete(id)
        }

        // Update visibility: hide hidden elements, show others (unless isolated)
        if (this.isolatedElements) {
            // In isolate mode, only show isolated elements
            const toShow = Array.from(this.isolatedElements).filter(id => !this.hiddenElements.has(id))
            const toHide = Array.from(this.elements.keys()).filter(id => !this.isolatedElements!.has(id) || this.hiddenElements.has(id))
            await this.fragmentsModel.setVisible(toShow, true)
            await this.fragmentsModel.setVisible(toHide, false)
        } else {
            // Normal mode: show all except hidden
            const toShow = Array.from(this.elements.keys()).filter(id => !this.hiddenElements.has(id))
            const toHide = Array.from(this.hiddenElements)
            await this.fragmentsModel.setVisible(toShow, true)
            await this.fragmentsModel.setVisible(toHide, false)
        }
        await this.applyChanges()
    }

    /**
     * Isolate elements (hide everything else)
     */
    async isolateElements(localIds: number[]): Promise<void> {
        this.isolatedElements = new Set(localIds)

        // Ensure we have all model IDs cached
        if (this.allModelIds.length === 0) {
            await this.cacheAllModelIds()
        }

        // Hide ALL elements in the entire model
        await this.fragmentsModel.setVisible(this.allModelIds, false)

        // Then show only the isolated elements
        await this.fragmentsModel.setVisible(localIds, true)
        await this.applyChanges()
    }

    /**
     * Exit isolation mode
     */
    async exitIsolation(): Promise<void> {
        this.isolatedElements = null

        // Show all elements using resetVisible()
        await this.fragmentsModel.resetVisible()

        // Then hide the ones that were hidden before isolation
        if (this.hiddenElements.size > 0) {
            await this.fragmentsModel.setVisible(Array.from(this.hiddenElements), false)
        }
        await this.applyChanges()
    }

    /**
     * Filter by product type names - hides ALL model elements except matching types
     * Only filters by productTypeName (from IfcDoorType, etc.) - NOT IFC classes
     */
    async filterByType(typeNames: string[]): Promise<void> {
        this.typeFilters = new Set(typeNames.map(t => t.toLowerCase()))
        // Clear IFC class filters when applying type filters (mutually exclusive)
        this.ifcClassFilters.clear()

        // Ensure we have all model IDs cached
        if (this.allModelIds.length === 0) {
            await this.cacheAllModelIds()
        }

        // Find elements that match the filter by productTypeName only
        const visibleIds: number[] = []
        for (const [id, element] of this.elements.entries()) {
            const productType = (element.productTypeName || '').toLowerCase()

            // Only match against product type name (from IfcDoorType, etc.)
            if (productType && this.typeFilters.has(productType) && !this.hiddenElements.has(id)) {
                visibleIds.push(id)
            }
        }


        // First hide ALL elements in the entire model
        await this.fragmentsModel.setVisible(this.allModelIds, false)

        // Then show only the matching elements
        if (visibleIds.length > 0) {
            await this.fragmentsModel.setVisible(visibleIds, true)
        }
        await this.applyChanges()
    }

    /**
     * Filter by IFC class names (e.g., "IFCDOOR", "IFCWALL") - hides ALL model elements except matching classes
     * Filters by typeName (IFC class) - NOT product type names
     */
    async filterByIFCClass(classNames: string[]): Promise<void> {
        this.ifcClassFilters = new Set(classNames.map(c => c.toLowerCase()))
        // Clear type filters when applying IFC class filters (mutually exclusive)
        this.typeFilters.clear()

        // Ensure we have all model IDs cached
        if (this.allModelIds.length === 0) {
            await this.cacheAllModelIds()
        }

        // Find elements that match the filter by typeName (IFC class)
        const visibleIds: number[] = []
        for (const [id, element] of this.elements.entries()) {
            const ifcClass = (element.typeName || '').toLowerCase()

            // Match against IFC class name (e.g., "ifcdoor", "ifcwall")
            if (ifcClass && this.ifcClassFilters.has(ifcClass) && !this.hiddenElements.has(id)) {
                visibleIds.push(id)
            }
        }

        // First hide ALL elements in the entire model
        await this.fragmentsModel.setVisible(this.allModelIds, false)

        // Then show only the matching elements
        if (visibleIds.length > 0) {
            await this.fragmentsModel.setVisible(visibleIds, true)
        }
        await this.applyChanges()
    }

    /**
     * Clear class filters (show all classes)
     */
    async clearTypeFilters(): Promise<void> {
        this.typeFilters.clear()


        // Show all elements using resetVisible()
        await this.fragmentsModel.resetVisible()

        // Re-apply any hidden elements
        if (this.hiddenElements.size > 0) {
            await this.fragmentsModel.setVisible(Array.from(this.hiddenElements), false)
        }

        await this.applyChanges()
    }

    /**
     * Clear IFC class filters (show all classes)
     */
    async clearIFCClassFilters(): Promise<void> {
        this.ifcClassFilters.clear()

        // Show all elements using resetVisible()
        await this.fragmentsModel.resetVisible()

        // Re-apply any hidden elements
        if (this.hiddenElements.size > 0) {
            await this.fragmentsModel.setVisible(Array.from(this.hiddenElements), false)
        }

        await this.applyChanges()
    }

    /**
     * Set transparency for elements (0 = fully transparent, 1 = opaque)
     */
    async setTransparency(localIds: number[], opacity: number): Promise<void> {
        // Note: Fragments doesn't have direct opacity control via setVisible
        // We need to modify materials directly for transparency
        // This is a simplified implementation - full transparency requires material manipulation

        for (const id of localIds) {
            if (opacity < 1) {
                this.transparencyMap.set(id, opacity)
            } else {
                this.transparencyMap.delete(id)
            }
        }

        // For now, we'll use visibility as a proxy for very low opacity
        // Full transparency implementation would require accessing meshes and modifying materials
        // This is a placeholder - full implementation would need to:
        // 1. Get meshes for each localId
        // 2. Clone materials
        // 3. Set material.transparent = true
        // 4. Set material.opacity = opacity
        // 5. Update meshes with new materials
    }

    /**
     * Reset all visibility to original state
     */
    async resetAllVisibility(): Promise<void> {
        this.hiddenElements.clear()
        this.isolatedElements = null
        this.typeFilters.clear()
        this.ifcClassFilters.clear()
        this.transparencyMap.clear()

        await this.fragmentsModel.resetVisible()
        await this.applyChanges()
    }

    /**
     * Hide/show spatial node and all its children
     */
    async setSpatialNodeVisibility(node: SpatialNode, visible: boolean): Promise<void> {
        // Get all element IDs from this node and children
        const elementIds = getAllElementIds(node)

        if (visible) {
            await this.showElements(elementIds)
        } else {
            await this.hideElements(elementIds)
        }
    }

    /**
     * Isolate spatial node (hide everything else)
     */
    async isolateSpatialNode(node: SpatialNode): Promise<void> {
        const elementIds = getAllElementIds(node)
        await this.isolateElements(elementIds)
    }

    /**
     * Get current visibility state
     */
    getVisibilityState(): {
        hidden: number[]
        isolated: number[] | null
        typeFilters: string[]
        ifcClassFilters: string[]
    } {
        return {
            hidden: Array.from(this.hiddenElements),
            isolated: this.isolatedElements ? Array.from(this.isolatedElements) : null,
            typeFilters: Array.from(this.typeFilters),
            ifcClassFilters: Array.from(this.ifcClassFilters),
        }
    }

    // ============================================
    // Highlight Methods for Door Panel Integration
    // ============================================

    /**
     * Set the scene reference for adding highlight meshes
     */
    setScene(scene: THREE.Scene): void {
        this.scene = scene
    }

    /**
     * Set hovered element - creates a glow effect on the element
     */
    setHoveredElement(localId: number | null): void {
        // Clear previous hover
        if (this.hoveredElementId !== null) {
            this.removeHighlightMesh(this.hoveredElementId)
        }

        this.hoveredElementId = localId

        if (localId !== null) {
            this.createHighlightMesh(localId, HIGHLIGHT_COLORS.hovered, 1.03)
        }

        if (this.onRenderNeeded) {
            this.onRenderNeeded()
        }
    }

    /**
     * Set selected elements - highlights them with selection color
     */
    setSelectedElements(localIds: number[]): void {

        // Clear previous selections that are no longer selected
        for (const prevId of this.selectedElements) {
            if (!localIds.includes(prevId)) {
                this.removeHighlightMesh(prevId)
            }
        }

        this.selectedElements = new Set(localIds)

        // Create highlight meshes for new selections
        for (const localId of localIds) {
            if (!this.highlightMeshes.has(localId)) {
                const element = this.elements.get(localId)
                if (element) {
                    this.createHighlightMesh(localId, HIGHLIGHT_COLORS.selected, 1.01)
                } else {
                    console.warn(`[Highlight] Could not find element for localId ${localId}`)
                }
            }
        }

        if (this.onRenderNeeded) {
            this.onRenderNeeded()
        }
    }

    /**
     * Highlight filtered elements with a subtle tint
     */
    highlightFilteredElements(localIds: number[]): void {
        // Clear previous highlights
        this.clearHighlights()

        this.highlightedElements = new Set(localIds)

        // Create subtle highlight for filtered elements
        for (const localId of localIds) {
            const element = this.elements.get(localId)
            if (element) {
                this.createHighlightMesh(localId, HIGHLIGHT_COLORS.filtered, 1.005)
            }
        }

        if (this.onRenderNeeded) {
            this.onRenderNeeded()
        }
    }

    /**
     * Clear all highlights (keeps selection and hover)
     */
    clearHighlights(): void {
        for (const localId of this.highlightedElements) {
            // Don't remove if it's hovered or selected
            if (localId !== this.hoveredElementId && !this.selectedElements.has(localId)) {
                this.removeHighlightMesh(localId)
            }
        }
        this.highlightedElements.clear()

        if (this.onRenderNeeded) {
            this.onRenderNeeded()
        }
    }

    /**
     * Clear all highlight state (including selection and hover)
     */
    clearAllHighlights(): void {
        for (const [localId] of this.highlightMeshes) {
            this.removeHighlightMesh(localId)
        }
        this.hoveredElementId = null
        this.selectedElements.clear()
        this.highlightedElements.clear()

        if (this.onRenderNeeded) {
            this.onRenderNeeded()
        }
    }

    /**
     * Create a highlight box for an element using its bounding box
     * This is more reliable than using mesh geometry which might be batched/shared
     */
    private createHighlightMesh(
        localId: number,
        color: THREE.Color,
        scale: number = 1.02
    ): void {
        if (!this.scene) return

        // Remove existing highlight mesh for this element
        this.removeHighlightMesh(localId)

        // Get the element's bounding box - more reliable than mesh geometry
        const element = this.elements.get(localId)
        if (!element || !element.boundingBox) {
            console.warn(`[Highlight] No bounding box for element ${localId}`)
            return
        }

        const bbox = element.boundingBox
        const size = bbox.getSize(new THREE.Vector3())
        const center = bbox.getCenter(new THREE.Vector3())


        // Create a group to hold highlight visuals
        const highlightGroup = new THREE.Group()
        highlightGroup.userData.isHighlightGroup = true

        // 1. Create a wireframe box around the element
        const boxGeometry = new THREE.BoxGeometry(size.x * scale, size.y * scale, size.z * scale)
        const edgesGeometry = new THREE.EdgesGeometry(boxGeometry)
        const lineMaterial = new THREE.LineBasicMaterial({
            color: color,
            linewidth: 2,
            transparent: true,
            opacity: 1.0,
        })
        const wireframe = new THREE.LineSegments(edgesGeometry, lineMaterial)
        wireframe.position.copy(center)
        highlightGroup.add(wireframe)

        // 2. Create a semi-transparent fill box
        const fillMaterial = new THREE.MeshBasicMaterial({
            color: color,
            transparent: true,
            opacity: 0.15,
            side: THREE.DoubleSide,
            depthWrite: false,
        })
        const fillMesh = new THREE.Mesh(boxGeometry.clone(), fillMaterial)
        fillMesh.position.copy(center)
        highlightGroup.add(fillMesh)

        // Add to scene
        this.scene.add(highlightGroup)
        this.highlightMeshes.set(localId, highlightGroup)
    }

    /**
     * Remove highlight mesh for an element
     */
    private removeHighlightMesh(localId: number): void {
        const obj = this.highlightMeshes.get(localId)
        if (obj && this.scene) {
            this.scene.remove(obj)

            // Dispose of all children if it's a group
            obj.traverse((child) => {
                if (child instanceof THREE.Mesh) {
                    child.geometry?.dispose()
                    if (child.material instanceof THREE.Material) {
                        child.material.dispose()
                    } else if (Array.isArray(child.material)) {
                        child.material.forEach(m => m.dispose())
                    }
                } else if (child instanceof THREE.LineSegments) {
                    child.geometry?.dispose()
                    if (child.material instanceof THREE.Material) {
                        child.material.dispose()
                    }
                }
            })

            this.highlightMeshes.delete(localId)
        }
    }

    /**
     * Get element info by localId
     */
    getElement(localId: number): ElementInfo | undefined {
        return this.elements.get(localId)
    }

    /**
     * Get all tracked elements
     */
    getAllElements(): ElementInfo[] {
        return Array.from(this.elements.values())
    }
}


