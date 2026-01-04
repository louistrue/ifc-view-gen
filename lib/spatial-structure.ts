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
    elementIds: number[] // localIds of tracked geometry elements (for analysis)
    allElementIds: number[] // ALL localIds from model (for visibility operations)
    visible: boolean
    isolated: boolean
    boundingBox?: { min: [number, number, number]; max: [number, number, number] }
}

/**
 * Extract spatial hierarchy from Fragments model
 * 1. Try getSpatialStructure() API
 * 2. Try getItemsOfCategory() for spatial types directly
 * 3. Fall back to category-based grouping
 */
export async function extractSpatialStructure(
    fragmentsModel: FragmentsModel,
    elements: ElementInfo[]
): Promise<SpatialNode | null> {
    try {
        // Get all local IDs and their categories for both methods
        const allLocalIds = await fragmentsModel.getItemsIdsWithGeometry()
        const itemCategories = await fragmentsModel.getItemsWithGeometryCategories()

        // Create category map for geometry elements
        const categoryMap = new Map<number, string>()
        for (let i = 0; i < allLocalIds.length; i++) {
            const localId = allLocalIds[i]
            const category = itemCategories[i]
            if (category) categoryMap.set(localId, category)
        }

        // Method 1: Try Fragments' built-in spatial structure API
        let spatialTree: SpatialTreeItem | null = null
        try {
            spatialTree = await fragmentsModel.getSpatialStructure()
        } catch (e) {
            // getSpatialStructure not available
        }

        if (spatialTree && spatialTree.localId) {
            const result = await tryBuildFromSpatialTree(fragmentsModel, spatialTree, elements, categoryMap)
            if (result && result.children.length > 0) return result
        }

        // Method 2: Build from getItemsOfCategories() for spatial types
        // This works because spatial items (Project, Site, Building, Storey) don't have geometry
        // but ARE accessible via getItemsOfCategories()
        const spatialResult = await tryBuildFromSpatialCategories(fragmentsModel, elements, categoryMap)
        if (spatialResult && spatialResult.children.length > 0) {
            return spatialResult
        }

        // Method 3: Fallback to category-based grouping
        return buildFromCategories(elements, categoryMap)

    } catch (error) {
        console.error('Failed to extract spatial structure:', error)
        return buildFromCategories(elements, new Map())
    }
}

/**
 * Build spatial structure using getItemsOfCategories() for spatial types
 * This approach works because spatial items don't need geometry
 */
async function tryBuildFromSpatialCategories(
    fragmentsModel: FragmentsModel,
    elements: ElementInfo[],
    categoryMap: Map<number, string>
): Promise<SpatialNode | null> {
    try {
        // Get spatial items by category using RegExp patterns
        // The API is getItemsOfCategories(RegExp[]) which returns { [category: string]: number[] }
        const spatialPatterns = [
            /^IFCPROJECT$/i,
            /^IFCSITE$/i,
            /^IFCBUILDING$/i,
            /^IFCBUILDINGSTOREY$/i,
            /^IFCSPACE$/i
        ]

        const spatialItems = new Map<string, number[]>()

        try {
            const result = await fragmentsModel.getItemsOfCategories(spatialPatterns)

            // Result is { [category: string]: number[] }
            for (const [category, ids] of Object.entries(result)) {
                if (ids && ids.length > 0) {
                    // Normalize category name to uppercase
                    const normalizedCategory = category.toUpperCase()
                    spatialItems.set(normalizedCategory, ids)
                }
            }
        } catch (e) {
            // getItemsOfCategories not available
        }

        // Need at least project or building
        if (!spatialItems.has('IFCPROJECT') && !spatialItems.has('IFCBUILDING')) {
            return null
        }

        // Get names for spatial items
        const allSpatialIds: number[] = []
        for (const ids of spatialItems.values()) {
            allSpatialIds.push(...ids)
        }

        let nameMap = new Map<number, string>()
        let guidMap = new Map<number, string>()

        if (allSpatialIds.length > 0) {
            try {
                const itemsData = await fragmentsModel.getItemsData(allSpatialIds, {
                    attributesDefault: true,
                    relationsDefault: { attributes: false, relations: false },
                })
                const guids = await fragmentsModel.getGuidsByLocalIds(allSpatialIds)

                for (let i = 0; i < allSpatialIds.length; i++) {
                    const localId = allSpatialIds[i]
                    const name = extractName(itemsData[i])
                    if (name) nameMap.set(localId, name)
                    const guid = guids[i]
                    if (guid) guidMap.set(localId, guid)
                }
            } catch (e) {
                console.warn('Could not get spatial item data:', e)
            }
        }

        // Build the spatial tree
        // Create Project node
        const projectIds = spatialItems.get('IFCPROJECT') || []
        const projectId = projectIds[0] || -1
        const projectName = nameMap.get(projectId) || 'Project'

        const root: SpatialNode = {
            id: projectId,
            globalId: guidMap.get(projectId),
            name: projectName,
            type: 'IfcProject',
            children: [],
            elementIds: [],
            allElementIds: [],
            visible: true,
            isolated: false,
        }

        // Create Site nodes under Project
        const siteIds = spatialItems.get('IFCSITE') || []
        for (const siteId of siteIds) {
            const site: SpatialNode = {
                id: siteId,
                globalId: guidMap.get(siteId),
                name: nameMap.get(siteId) || `Site`,
                type: 'IfcSite',
                children: [],
                elementIds: [],
                allElementIds: [],
                visible: true,
                isolated: false,
            }
            root.children.push(site)
        }

        // Create Building nodes
        const buildingIds = spatialItems.get('IFCBUILDING') || []
        for (const buildingId of buildingIds) {
            const building: SpatialNode = {
                id: buildingId,
                globalId: guidMap.get(buildingId),
                name: nameMap.get(buildingId) || `Building`,
                type: 'IfcBuilding',
                children: [],
                elementIds: [],
                allElementIds: [],
                visible: true,
                isolated: false,
            }

            // Add building to site if exists, otherwise to project
            if (root.children.length > 0) {
                root.children[0].children.push(building)
            } else {
                root.children.push(building)
            }
        }

        // Create Storey nodes under Buildings
        const storeyIds = spatialItems.get('IFCBUILDINGSTOREY') || []
        const storeys: SpatialNode[] = []

        for (const storeyId of storeyIds) {
            const storey: SpatialNode = {
                id: storeyId,
                globalId: guidMap.get(storeyId),
                name: nameMap.get(storeyId) || `Storey`,
                type: 'IfcBuildingStorey',
                children: [],
                elementIds: [],
                allElementIds: [],
                visible: true,
                isolated: false,
            }
            storeys.push(storey)
        }

        // Create a set of valid element IDs from the elements we're actually tracking
        const validElementIds = new Set(elements.map(e => e.expressID))
        
        // Get all geometry IDs from model for visibility
        const allGeometryIds = await fragmentsModel.getItemsIdsWithGeometry()
        const allGeometrySet = new Set(Array.isArray(allGeometryIds) ? allGeometryIds : Array.from(allGeometryIds))

        // Map elements to storeys using getItemsChildren
        const elementToStorey = new Map<number, number>()
        for (const storey of storeys) {
            try {
                const children = await fragmentsModel.getItemsChildren([storey.id])
                for (const childId of children) {
                    // Store ALL geometry children for visibility operations
                    if (allGeometrySet.has(childId)) {
                        storey.allElementIds.push(childId)
                    }
                    // Store tracked elements for analysis
                    if (validElementIds.has(childId)) {
                        elementToStorey.set(childId, storey.id)
                        storey.elementIds.push(childId)
                    }
                }
            } catch (e) {
                // Ignore
            }
        }

        // Add storeys to buildings
        const buildings = getAllBuildingNodes(root)
        if (buildings.length > 0) {
            // Add all storeys to first building for now
            // TODO: Map storeys to correct buildings using relations
            buildings[0].children.push(...storeys)
        } else if (root.children.length > 0 && root.children[0].type === 'IfcSite') {
            // Add to site if no building
            root.children[0].children.push(...storeys)
        } else {
            // Add directly to project
            root.children.push(...storeys)
        }

        // Elements not assigned to any storey - add them to an "Unassigned" node
        const assignedElements = new Set(elementToStorey.keys())
        const unassignedElements = elements.filter(e => !assignedElements.has(e.expressID))

        if (unassignedElements.length > 0) {
            // Create a single "Unassigned" node with all unassigned elements
            const unassignedIds = unassignedElements.map(e => e.expressID)
            const unassignedNode: SpatialNode = {
                id: -99999,
                name: `Unassigned (${unassignedElements.length})`,
                type: 'Category',
                children: [],
                elementIds: unassignedIds,
                allElementIds: unassignedIds, // Same for unassigned since they're all tracked
                visible: true,
                isolated: false,
            }

            // Add to first building if exists, otherwise to root
            const buildings = getAllBuildingNodes(root)
            if (buildings.length > 0) {
                buildings[0].children.push(unassignedNode)
            } else {
                root.children.push(unassignedNode)
            }
        }


        return root
    } catch (error) {
        console.warn('Failed to build from spatial categories:', error)
        return null
    }
}

/**
 * Get all building nodes from spatial tree
 */
function getAllBuildingNodes(node: SpatialNode): SpatialNode[] {
    const buildings: SpatialNode[] = []
    if (node.type === 'IfcBuilding') {
        buildings.push(node)
    }
    for (const child of node.children) {
        buildings.push(...getAllBuildingNodes(child))
    }
    return buildings
}

/**
 * Find deepest spatial container (for adding unassigned elements)
 */
function findDeepestSpatialContainer(node: SpatialNode): SpatialNode | null {
    // Prefer storeys, then buildings, then sites, then project
    const storeys: SpatialNode[] = []
    const collect = (n: SpatialNode) => {
        if (n.type === 'IfcBuildingStorey') storeys.push(n)
        n.children.forEach(collect)
    }
    collect(node)

    if (storeys.length > 0) return storeys[0]

    const buildings = getAllBuildingNodes(node)
    if (buildings.length > 0) return buildings[0]

    if (node.children.length > 0 && node.children[0].type === 'IfcSite') {
        return node.children[0]
    }

    return node
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
                const guid = guids[i]
                if (guid) guidMap.set(localId, guid)
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
                allElementIds: [],
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
        const category = categoryMap.get(element.expressID) || element.typeName || 'Unknown'
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
    const categoryNodes: SpatialNode[] = sortedCategories.map(([category, categoryElements], index) => {
        const ids = categoryElements.map(e => e.expressID)
        return {
            id: -1000 - index, // Use negative IDs to avoid conflicts
            name: `${formatCategoryName(category)} (${categoryElements.length})`,
            type: 'Category' as const,
            children: [],
            elementIds: ids,
            allElementIds: ids, // Same for categories
            visible: true,
            isolated: false,
        }
    })

    // Create root node
    const root: SpatialNode = {
        id: -1,
        name: 'Model',
        type: 'IfcProject',
        children: categoryNodes,
        elementIds: [],
        allElementIds: [],
        visible: true,
        isolated: false,
    }


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
 * Get all tracked element IDs recursively from a spatial node
 */
export function getAllElementIds(node: SpatialNode): number[] {
    const ids: number[] = [...node.elementIds]
    for (const child of node.children) {
        ids.push(...getAllElementIds(child))
    }
    return ids
}

/**
 * Get ALL element IDs (including non-tracked) recursively from a spatial node
 * Use this for visibility operations to hide/show all geometry
 */
export function getAllModelElementIds(node: SpatialNode): number[] {
    const ids: number[] = [...(node.allElementIds || node.elementIds)]
    for (const child of node.children) {
        ids.push(...getAllModelElementIds(child))
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

