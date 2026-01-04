/**
 * Element visibility manager using Fragments API
 * Provides hide/show/isolate/filter functionality with optimal performance
 */

import { FragmentsModel, FragmentsModels } from '@thatopen/fragments'
import type { ElementInfo } from './ifc-types'
import type { SpatialNode } from './spatial-structure'
import { getAllElementIds } from './spatial-structure'

export class ElementVisibilityManager {
    private fragmentsModel: FragmentsModel
    private fragmentsManager: FragmentsModels | null = null
    private elements: Map<number, ElementInfo>
    private allModelIds: number[] = [] // All geometry IDs in the model
    private originalVisibility: Map<number, boolean> = new Map()
    private hiddenElements: Set<number> = new Set()
    private isolatedElements: Set<number> | null = null
    private typeFilters: Set<string> = new Set()
    private transparencyMap: Map<number, number> = new Map() // localId -> opacity (0-1)
    private onRenderNeeded: (() => void) | null = null

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
            console.log(`Cached ${this.allModelIds.length} model IDs for visibility management`)
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

        console.log(`Hiding all ${this.allModelIds.length} elements`)
        await this.fragmentsModel.setVisible(this.allModelIds, false)
        await this.applyChanges()
    }

    /**
     * Set visibility for specific elements (works with any IDs, not just tracked ones)
     */
    async setElementsVisible(localIds: number[], visible: boolean): Promise<void> {
        console.log(`Setting ${localIds.length} elements visible: ${visible}`)
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
        console.log(`Isolating ${localIds.length} elements, hiding ${this.allModelIds.length} total`)
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
     * Filter by IFC type names - hides ALL model elements except matching types
     */
    async filterByType(typeNames: string[]): Promise<void> {
        this.typeFilters = new Set(typeNames.map(t => t.toLowerCase()))

        // Ensure we have all model IDs cached
        if (this.allModelIds.length === 0) {
            await this.cacheAllModelIds()
        }

        // Find elements that match the filter
        const visibleIds: number[] = []
        for (const [id, element] of this.elements.entries()) {
            const typeName = element.typeName.toLowerCase()
            if (this.typeFilters.has(typeName) && !this.hiddenElements.has(id)) {
                visibleIds.push(id)
            }
        }

        console.log(`Class filter: showing ${visibleIds.length} elements, hiding ${this.allModelIds.length - visibleIds.length} (total model: ${this.allModelIds.length})`)

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

        console.log('Clearing class filters, showing all elements')

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
        this.transparencyMap.clear()

        console.log('Resetting all visibility')
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
    } {
        return {
            hidden: Array.from(this.hiddenElements),
            isolated: this.isolatedElements ? Array.from(this.isolatedElements) : null,
            typeFilters: Array.from(this.typeFilters),
        }
    }
}


