/**
 * Extract IFC spatial hierarchy (Project → Site → Building → Storey → Space)
 * from Fragments model using the proper getSpatialStructure() API
 * With fallback to category-based grouping if spatial structure is unavailable
 */

import { FragmentsModel, type SpatialTreeItem } from '@thatopen/fragments'
import type { ElementInfo } from './ifc-types'

export interface SpatialNode {
  id: number // localId
  globalId?: string
  name: string
  type: 'IfcProject' | 'IfcSite' | 'IfcBuilding' | 'IfcBuildingStorey' | 'IfcSpace' | 'Element' | 'Category'
  children: SpatialNode[]
  elementIds: number[] // localIds of geometry elements contained in this spatial container
  visible: boolean
  isolated: boolean
  boundingBox?: { min: [number, number, number]; max: [number, number, number] }
}

/**
 * Extract spatial hierarchy from Fragments model using getSpatialStructure()
 * Falls back to category-based grouping if spatial structure is unavailable
 */
export async function extractSpatialStructure(
  fragmentsModel: FragmentsModel,
  elements: ElementInfo[]
): Promise<SpatialNode | null> {
  try {
    // Try Fragments' built-in spatial structure API first
    let spatialTree: SpatialTreeItem | null = null
    try {
      spatialTree = await fragmentsModel.getSpatialStructure()
    } catch (e) {
      console.warn('getSpatialStructure not available:', e)
    }
    
    // Get all local IDs and their categories for both methods
    const allLocalIds = await fragmentsModel.getItemsIdsWithGeometry()
    const itemCategories = await fragmentsModel.getItemsWithGeometryCategories()
    
    // Create category map
    const categoryMap = new Map<number, string>()
    for (let i = 0; i < allLocalIds.length; i++) {
      const localId = allLocalIds[i]
      if (itemCategories[i]) categoryMap.set(localId, itemCategories[i])
    }

    // If spatial tree exists and has valid structure, use it
    if (spatialTree && spatialTree.localId) {
      const result = await tryBuildFromSpatialTree(fragmentsModel, spatialTree, elements, categoryMap)
      if (result) return result
    }

    // Fallback: Build structure from element categories
    console.log('Using category-based fallback for spatial structure')
    return buildFromCategories(elements, categoryMap)
    
  } catch (error) {
    console.error('Failed to extract spatial structure:', error)
    // Last resort fallback
    return buildFromCategories(elements, new Map())
  }
}

/**
 * Try to build spatial structure from Fragments getSpatialStructure()
 */
async function tryBuildFromSpatialTree(
  fragmentsModel: FragmentsModel,
  spatialTree: SpatialTreeItem,
  elements: ElementInfo[],
  categoryMap: Map<number, string>
): Promise<SpatialNode | null> {
  try {
    const allLocalIds = await fragmentsModel.getItemsIdsWithGeometry()
    
    // Get item data for names
    let dataMap = new Map<number, any>()
    let guidMap = new Map<number, string>()
    
    try {
      const itemsData = await fragmentsModel.getItemsData(allLocalIds, {
        attributesDefault: true,
        relationsDefault: { attributes: false, relations: false },
      })
      const guids = await fragmentsModel.getGuidsByLocalIds(allLocalIds)
      
      for (let i = 0; i < allLocalIds.length; i++) {
        const localId = allLocalIds[i]
        dataMap.set(localId, itemsData[i])
        if (guids[i]) guidMap.set(localId, guids[i])
      }
    } catch (e) {
      console.warn('Could not get item data:', e)
    }

    // Convert SpatialTreeItem to our SpatialNode format
    const convertTreeItem = (item: SpatialTreeItem): SpatialNode | null => {
      if (!item.localId) return null

      const localId = item.localId
      const category = item.category || categoryMap.get(localId) || 'Unknown'
      const spatialType = getSpatialType(category)
      
      if (!spatialType) return null // Skip non-spatial items

      const itemData = dataMap.get(localId)
      const name = extractName(itemData) || `${spatialType}_${localId}`
      const globalId = guidMap.get(localId)

      const node: SpatialNode = {
        id: localId,
        globalId,
        name,
        type: spatialType,
        children: [],
        elementIds: [],
        visible: true,
        isolated: false,
      }

      // Recursively convert children
      if (item.children && item.children.length > 0) {
        for (const child of item.children) {
          const childNode = convertTreeItem(child)
          if (childNode) {
            node.children.push(childNode)
          }
        }
      }

      return node
    }

    const root = convertTreeItem(spatialTree)
    
    if (!root) {
      return null
    }

    // Try to map elements to spatial containers
    const spatialNodeIds = new Set<number>()
    const collectIds = (node: SpatialNode) => {
      spatialNodeIds.add(node.id)
      node.children.forEach(collectIds)
    }
    collectIds(root)

    const elementToSpatialMap = new Map<number, number>()
    
    try {
      for (const spatialId of spatialNodeIds) {
        const children = await fragmentsModel.getItemsChildren([spatialId])
        for (const childId of children) {
          const element = elements.find(e => e.expressID === childId)
          if (element && !elementToSpatialMap.has(childId)) {
            elementToSpatialMap.set(childId, spatialId)
          }
        }
      }
    } catch (e) {
      // Ignore
    }

    // Assign elements to spatial nodes
    const assignElements = (node: SpatialNode) => {
      for (const [elementId, spatialId] of elementToSpatialMap.entries()) {
        if (spatialId === node.id) {
          node.elementIds.push(elementId)
        }
      }
      node.children.forEach(assignElements)
    }
    assignElements(root)

    console.log(`✓ Extracted spatial hierarchy using Fragments API`)
    console.log(`  Root: ${root.type} (${root.name})`)
    console.log(`  Structure: ${countNodes(root)} nodes`)
    
    return root
  } catch (error) {
    console.warn('Failed to build from spatial tree:', error)
    return null
  }
}

/**
 * Build structure from element categories (fallback)
 */
function buildFromCategories(
  elements: ElementInfo[],
  categoryMap: Map<number, string>
): SpatialNode {
  // Group elements by category
  const categoryGroups = new Map<string, ElementInfo[]>()
  
  for (const element of elements) {
    const category = categoryMap.get(element.expressID) || element.type || 'Unknown'
    if (!categoryGroups.has(category)) {
      categoryGroups.set(category, [])
    }
    categoryGroups.get(category)!.push(element)
  }

  // Sort categories by count (descending) then name
  const sortedCategories = Array.from(categoryGroups.entries())
    .sort((a, b) => {
      // Put important categories first
      const priority = ['IfcWall', 'IfcDoor', 'IfcWindow', 'IfcSlab', 'IfcColumn', 'IfcBeam']
      const aIndex = priority.findIndex(p => a[0].toLowerCase().includes(p.toLowerCase()))
      const bIndex = priority.findIndex(p => b[0].toLowerCase().includes(p.toLowerCase()))
      
      if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex
      if (aIndex !== -1) return -1
      if (bIndex !== -1) return 1
      
      return b[1].length - a[1].length // Then by count
    })

  // Create category nodes
  const categoryNodes: SpatialNode[] = sortedCategories.map(([category, categoryElements], index) => ({
    id: -1000 - index, // Use negative IDs to avoid conflicts
    name: `${formatCategoryName(category)} (${categoryElements.length})`,
    type: 'Category' as const,
    children: [],
    elementIds: categoryElements.map(e => e.expressID),
    visible: true,
    isolated: false,
  }))

  // Create root node
  const root: SpatialNode = {
    id: -1,
    name: 'Model',
    type: 'IfcProject',
    children: categoryNodes,
    elementIds: [],
    visible: true,
    isolated: false,
  }

  console.log(`✓ Built category-based structure`)
  console.log(`  Categories: ${categoryNodes.length}`)
  console.log(`  Total elements: ${elements.length}`)

  return root
}

/**
 * Format category name for display
 */
function formatCategoryName(category: string): string {
  // Remove "Ifc" prefix and add spaces before capitals
  let name = category
  if (name.toLowerCase().startsWith('ifc')) {
    name = name.substring(3)
  }
  // Add spaces before capitals: "BuildingStorey" -> "Building Storey"
  name = name.replace(/([a-z])([A-Z])/g, '$1 $2')
  return name
}

/**
 * Determine if category is a spatial type
 */
function getSpatialType(category: string): SpatialNode['type'] | null {
  if (!category) return null
  
  const lower = category.toLowerCase()
  
  // Exact matches first
  if (lower === 'ifcproject') return 'IfcProject'
  if (lower === 'ifcsite') return 'IfcSite'
  if (lower === 'ifcbuilding') return 'IfcBuilding'
  if (lower === 'ifcbuildingstorey') return 'IfcBuildingStorey'
  if (lower === 'ifcspace') return 'IfcSpace'
  
  // Partial matches
  if (lower.includes('project')) return 'IfcProject'
  if (lower.includes('site')) return 'IfcSite'
  if (lower.includes('building') && !lower.includes('storey')) return 'IfcBuilding'
  if (lower.includes('storey') || lower.includes('floor')) return 'IfcBuildingStorey'
  if (lower.includes('space') || lower.includes('room')) return 'IfcSpace'
  
  return null
}

/**
 * Extract name from item data
 */
function extractName(itemData: any): string {
  if (!itemData || typeof itemData !== 'object') return ''

  // Try common name fields
  const nameFields = ['Name', 'name', 'LongName', 'longName', 'Tag', 'tag']
  for (const field of nameFields) {
    if (itemData[field]) {
      const value = itemData[field]
      if (typeof value === 'string') return value
      if (typeof value === 'object' && value.value) return String(value.value)
    }
  }

  return ''
}

/**
 * Count total nodes in tree
 */
function countNodes(node: SpatialNode): number {
  let count = 1
  for (const child of node.children) {
    count += countNodes(child)
  }
  return count
}

/**
 * Get all element IDs recursively from a spatial node
 */
export function getAllElementIds(node: SpatialNode): number[] {
  const ids: number[] = [...node.elementIds]
  for (const child of node.children) {
    ids.push(...getAllElementIds(child))
  }
  return ids
}

/**
 * Find spatial node by ID
 */
export function findSpatialNode(root: SpatialNode, id: number): SpatialNode | null {
  if (root.id === id) return root
  for (const child of root.children) {
    const found = findSpatialNode(child, id)
    if (found) return found
  }
  return null
}

