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
    console.log('applyChanges called, fragmentsManager:', !!this.fragmentsManager, 'renderCallback:', !!this.onRenderNeeded)
    
    // Update Fragments internal state
    if (this.fragmentsManager) {
      try {
        await this.fragmentsManager.update(true)
        console.log('Fragments manager updated')
      } catch (e) {
        console.error('Error updating fragments manager:', e)
      }
    } else {
      console.warn('No fragments manager set!')
    }
    
    // Trigger render AFTER fragments update is complete
    if (this.onRenderNeeded) {
      console.log('Triggering render...')
      this.onRenderNeeded()
    } else {
      console.warn('No render callback set!')
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
    
    // Hide all elements
    const allIds = Array.from(this.elements.keys())
    await this.fragmentsModel.setVisible(allIds, false)
    
    // Show only isolated elements
    await this.fragmentsModel.setVisible(localIds, true)
    await this.applyChanges()
  }

  /**
   * Exit isolation mode
   */
  async exitIsolation(): Promise<void> {
    this.isolatedElements = null
    
    // Restore visibility based on hiddenElements set
    const toShow = Array.from(this.elements.keys()).filter(id => !this.hiddenElements.has(id))
    const toHide = Array.from(this.hiddenElements)
    await this.fragmentsModel.setVisible(toShow, true)
    await this.fragmentsModel.setVisible(toHide, false)
    await this.applyChanges()
  }

  /**
   * Filter by IFC type names
   */
  async filterByType(typeNames: string[]): Promise<void> {
    this.typeFilters = new Set(typeNames.map(t => t.toLowerCase()))
    
    const visibleIds: number[] = []
    const hiddenIds: number[] = []
    
    for (const [id, element] of this.elements.entries()) {
      const typeName = element.typeName.toLowerCase()
      const shouldShow = this.typeFilters.has(typeName) && !this.hiddenElements.has(id)
      
      if (shouldShow) {
        visibleIds.push(id)
      } else {
        hiddenIds.push(id)
      }
    }
    
    console.log(`Class filter: showing ${visibleIds.length} elements, hiding ${hiddenIds.length}`)
    
    // Apply class filter
    if (hiddenIds.length > 0) {
      await this.fragmentsModel.setVisible(hiddenIds, false)
    }
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
    
    console.log('Clearing class filters, restoring all visibility')
    
    // Restore visibility based on current state
    if (this.isolatedElements) {
      await this.fragmentsModel.setVisible(Array.from(this.isolatedElements), true)
      const toHide = Array.from(this.elements.keys()).filter(id => !this.isolatedElements!.has(id))
      await this.fragmentsModel.setVisible(toHide, false)
    } else {
      const toShow = Array.from(this.elements.keys()).filter(id => !this.hiddenElements.has(id))
      const toHide = Array.from(this.hiddenElements)
      if (toShow.length > 0) {
        await this.fragmentsModel.setVisible(toShow, true)
      }
      if (toHide.length > 0) {
        await this.fragmentsModel.setVisible(toHide, false)
      }
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


