import * as THREE from 'three'
import type { ElementInfo, LoadedIFCModel } from './ifc-types'
import type { SpaceInfo, SpaceContext, SpaceFilterOptions } from './ifc-space-types'
import type { SpatialNode } from './spatial-structure'

// ============================================
// TYPE CHECKING FUNCTIONS
// ============================================

/**
 * Checks if an element type represents a space
 */
export function isSpaceType(typeName: string): boolean {
    const upper = typeName.toUpperCase()
    return upper.includes('SPACE') ||
        upper === 'IFCSPACE' ||
        upper.startsWith('IFCSPACE')
}

/**
 * Checks if an element type represents a wall
 */
function isWallType(typeName: string): boolean {
    const upper = typeName.toUpperCase()
    return upper.includes('WALL') ||
        upper === 'IFCWALL' ||
        upper === 'IFCWALLSTANDARDCASE' ||
        upper.startsWith('IFCWALL')
}

/**
 * Checks if an element type represents a door
 */
function isDoorType(typeName: string): boolean {
    const upper = typeName.toUpperCase()
    return upper.includes('DOOR') ||
        upper === 'IFCDOOR' ||
        upper.startsWith('IFCDOOR')
}

/**
 * Checks if an element type represents a window
 */
function isWindowType(typeName: string): boolean {
    const upper = typeName.toUpperCase()
    return upper.includes('WINDOW') ||
        upper === 'IFCWINDOW' ||
        upper.startsWith('IFCWINDOW')
}

/**
 * Checks if an element type represents furniture
 */
function isFurnitureType(typeName: string): boolean {
    const upper = typeName.toUpperCase()
    return upper.includes('FURNISHING') ||
        upper === 'IFCFURNISHINGELEMENT' ||
        upper.includes('FURNITURE') ||
        upper.includes('IFCFURNITURE')
}

// ============================================
// FILTER FUNCTION
// ============================================

/**
 * Filter spaces based on filter options
 * Uses AND logic between filter types, OR logic within each type
 */
export function filterSpaces(spaces: SpaceContext[], options: SpaceFilterOptions): SpaceContext[] {
    if (!options || Object.keys(options).length === 0) {
        return spaces
    }

    // Parse filter values
    const parseFilter = (value: string | string[] | undefined): string[] => {
        if (!value) return []
        if (Array.isArray(value)) return value.map(v => v.toLowerCase().trim())
        return value.split(',').map(v => v.toLowerCase().trim()).filter(Boolean)
    }

    const spaceTypes = parseFilter(options.spaceTypes)
    const storeys = parseFilter(options.storeys)
    const guids = parseFilter(options.guids)
    const functions = parseFilter(options.functions)

    return spaces.filter(space => {
        // Space type filter (partial match, case-insensitive)
        if (spaceTypes.length > 0) {
            const spaceType = (space.spaceType || '').toLowerCase()
            const matchesType = spaceTypes.some(t => spaceType.includes(t))
            if (!matchesType) return false
        }

        // Storey filter (partial match, case-insensitive)
        if (storeys.length > 0) {
            const storey = (space.storeyName || '').toLowerCase()
            const matchesStorey = storeys.some(s => storey.includes(s))
            if (!matchesStorey) return false
        }

        // GUID filter (exact match)
        if (guids.length > 0) {
            const guid = space.spaceId.toLowerCase()
            const matchesGuid = guids.some(g => g === guid)
            if (!matchesGuid) return false
        }

        // Function filter (partial match, case-insensitive)
        if (functions.length > 0) {
            const func = (space.spaceFunction || '').toLowerCase()
            const matchesFunction = functions.some(f => func.includes(f))
            if (!matchesFunction) return false
        }

        return true
    })
}

// ============================================
// STOREY MAP BUILDING
// ============================================

type StoreyMap = Map<number, string>

/**
 * Build a map of element ID -> storey name from spatial structure
 */
function buildStoreyMap(spatialNode: SpatialNode | null, map: StoreyMap = new Map(), currentStorey: string | null = null): StoreyMap {
    if (!spatialNode) return map

    // If this is a storey node, track it
    let storeyName = currentStorey
    if (spatialNode.type === 'IfcBuildingStorey') {
        storeyName = spatialNode.name || `Storey ${spatialNode.id}`
    }

    // Map all elements in this node to the current storey
    if (storeyName && spatialNode.elementIds) {
        for (const elementId of spatialNode.elementIds) {
            map.set(elementId, storeyName)
        }
    }
    if (storeyName && spatialNode.allElementIds) {
        for (const elementId of spatialNode.allElementIds) {
            if (!map.has(elementId)) {
                map.set(elementId, storeyName)
            }
        }
    }

    // Recurse into children
    if (spatialNode.children) {
        for (const child of spatialNode.children) {
            buildStoreyMap(child, map, storeyName)
        }
    }

    return map
}

// ============================================
// MAIN ANALYSIS FUNCTION
// ============================================

/**
 * Analyze all spaces in the model and find their context
 */
export async function analyzeSpaces(
    model: LoadedIFCModel,
    spatialStructure?: SpatialNode | null
): Promise<SpaceContext[]> {
    console.log('[SpaceAnalyzer] Starting space analysis...')
    console.log('[SpaceAnalyzer] Total elements in model:', model.elements.length)

    // Build storey map from spatial structure for quick lookup
    const storeyMap = buildStoreyMap(spatialStructure || null)
    console.log('[SpaceAnalyzer] Storey map entries:', storeyMap.size)

    // Separate elements by type
    const spaces: ElementInfo[] = []
    const walls: ElementInfo[] = []
    const doors: ElementInfo[] = []
    const windows: ElementInfo[] = []
    const furniture: ElementInfo[] = []

    // Log unique type names for debugging
    const uniqueTypes = new Set<string>()

    // Process all elements
    for (const element of model.elements) {
        uniqueTypes.add(element.typeName)

        if (isSpaceType(element.typeName)) {
            spaces.push(element)
        } else if (isWallType(element.typeName)) {
            walls.push(element)
        } else if (isDoorType(element.typeName)) {
            doors.push(element)
        } else if (isWindowType(element.typeName)) {
            windows.push(element)
        } else if (isFurnitureType(element.typeName)) {
            furniture.push(element)
        }
    }

    console.log('[SpaceAnalyzer] Unique element types found:', Array.from(uniqueTypes).sort())
    console.log('[SpaceAnalyzer] Element counts:')
    console.log('  - Spaces (IFCSPACE):', spaces.length)
    console.log('  - Walls:', walls.length)
    console.log('  - Doors:', doors.length)
    console.log('  - Windows:', windows.length)
    console.log('  - Furniture:', furniture.length)

    // Analyze each space
    const spaceContexts: SpaceContext[] = []

    for (const spaceElement of spaces) {
        const context = analyzeSpace(
            spaceElement,
            walls,
            doors,
            windows,
            furniture,
            storeyMap
        )
        if (context) {
            spaceContexts.push(context)
        }
    }

    console.log('[SpaceAnalyzer] Analysis complete:')
    console.log('  - Total space contexts created:', spaceContexts.length)
    if (spaceContexts.length > 0) {
        console.log('  - First space:', spaceContexts[0].spaceName, '| Area:', spaceContexts[0].space.grossFloorArea?.toFixed(2), 'm²')
    }

    return spaceContexts
}

// ============================================
// INDIVIDUAL SPACE ANALYSIS
// ============================================

function analyzeSpace(
    space: ElementInfo,
    walls: ElementInfo[],
    doors: ElementInfo[],
    windows: ElementInfo[],
    furniture: ElementInfo[],
    storeyMap: StoreyMap
): SpaceContext | null {
    // Get space bounding box
    const bbox = space.boundingBox || calculateBoundingBox(space)
    if (!bbox) return null

    const center = new THREE.Vector3()
    bbox.getCenter(center)

    const size = new THREE.Vector3()
    bbox.getSize(size)

    // Find boundary elements
    const boundaryWalls = findBoundaryWalls(space, walls)
    const boundaryDoors = findDoorsInWalls(boundaryWalls, doors)
    const boundaryWindows = findWindowsInWalls(boundaryWalls, windows)
    const containedElements = findContainedElements(space, furniture)

    // Extract floor polygon from space geometry
    const floorPolygon = extractFloorPolygon(space)

    // Get storey name from spatial structure
    const storeyName = storeyMap.get(space.expressID) || null

    // Convert element to SpaceInfo
    const spaceInfo: SpaceInfo = {
        ...space,
        longName: space.productTypeName || undefined,
        objectType: space.typeName,
        centerPoint: center,
        // Calculate approximate area from bounding box if not available
        grossFloorArea: size.x * size.y,
        height: size.z,
        boundingBox2D: {
            min: new THREE.Vector2(bbox.min.x, bbox.min.y),
            max: new THREE.Vector2(bbox.max.x, bbox.max.y),
            width: size.x,
            depth: size.y,
        }
    }

    // Infer space function from name
    const spaceFunction = inferSpaceFunction(spaceInfo)

    return {
        space: spaceInfo,
        boundaryWalls,
        boundaryDoors,
        boundaryWindows,
        containedElements,
        floorPolygon,
        ceilingHeight: size.z,
        floorLevel: bbox.min.z,
        spaceId: space.globalId || `space-${space.expressID}`,
        spaceName: space.productTypeName || space.typeName || `Space ${space.expressID}`,
        spaceType: space.productTypeName || null,
        spaceFunction,
        storeyName,
    }
}

// ============================================
// BOUNDARY DETECTION FUNCTIONS
// ============================================

function findBoundaryWalls(space: ElementInfo, walls: ElementInfo[]): ElementInfo[] {
    const spaceBbox = space.boundingBox
    if (!spaceBbox) return []

    // Expand space bbox slightly to catch walls at boundary
    const expandedBbox = spaceBbox.clone().expandByScalar(0.1)

    return walls.filter(wall => {
        const wallBbox = wall.boundingBox
        if (!wallBbox) return false
        return expandedBbox.intersectsBox(wallBbox)
    })
}

function findDoorsInWalls(walls: ElementInfo[], doors: ElementInfo[]): ElementInfo[] {
    return doors.filter(door => {
        const doorBbox = door.boundingBox
        if (!doorBbox) return false

        return walls.some(wall => {
            const wallBbox = wall.boundingBox
            if (!wallBbox) return false
            return doorBbox.intersectsBox(wallBbox)
        })
    })
}

function findWindowsInWalls(walls: ElementInfo[], windows: ElementInfo[]): ElementInfo[] {
    return windows.filter(window => {
        const windowBbox = window.boundingBox
        if (!windowBbox) return false

        return walls.some(wall => {
            const wallBbox = wall.boundingBox
            if (!wallBbox) return false
            return windowBbox.intersectsBox(wallBbox)
        })
    })
}

function findContainedElements(space: ElementInfo, furniture: ElementInfo[]): ElementInfo[] {
    const spaceBbox = space.boundingBox
    if (!spaceBbox) return []

    return furniture.filter(item => {
        const itemBbox = item.boundingBox
        if (!itemBbox) return false

        // Check if furniture center is inside space
        const center = new THREE.Vector3()
        itemBbox.getCenter(center)
        return spaceBbox.containsPoint(center)
    })
}

// ============================================
// FLOOR POLYGON EXTRACTION
// ============================================

function extractFloorPolygon(space: ElementInfo): THREE.Vector2[] {
    // Method 1: Extract from mesh geometry (bottom face)
    if (space.meshes && space.meshes.length > 0) {
        const floorPoints = extractBottomFaceVertices(space.meshes)
        if (floorPoints.length >= 3) {
            return convexHull2D(floorPoints)
        }
    }

    // Method 2: Fallback to bounding box rectangle
    const bbox = space.boundingBox
    if (bbox) {
        return [
            new THREE.Vector2(bbox.min.x, bbox.min.y),
            new THREE.Vector2(bbox.max.x, bbox.min.y),
            new THREE.Vector2(bbox.max.x, bbox.max.y),
            new THREE.Vector2(bbox.min.x, bbox.max.y),
        ]
    }

    return []
}

function extractBottomFaceVertices(meshes: THREE.Mesh[]): THREE.Vector2[] {
    const points: THREE.Vector2[] = []
    const tolerance = 0.1 // 10cm tolerance for floor level

    for (const mesh of meshes) {
        const geometry = mesh.geometry
        if (!geometry) continue

        const position = geometry.getAttribute('position')
        if (!position) continue

        // Find minimum Z (floor level)
        let minZ = Infinity
        for (let i = 0; i < position.count; i++) {
            const z = position.getZ(i)
            if (z < minZ) minZ = z
        }

        // Collect vertices at floor level
        for (let i = 0; i < position.count; i++) {
            const z = position.getZ(i)
            if (Math.abs(z - minZ) < tolerance) {
                const x = position.getX(i)
                const y = position.getY(i)

                // Apply mesh world transform
                const worldPos = new THREE.Vector3(x, y, z)
                worldPos.applyMatrix4(mesh.matrixWorld)

                points.push(new THREE.Vector2(worldPos.x, worldPos.y))
            }
        }
    }

    return points
}

// ============================================
// SPACE FUNCTION INFERENCE
// ============================================

function inferSpaceFunction(space: SpaceInfo): string | null {
    const name = (space.longName || space.productTypeName || space.typeName || '').toLowerCase()
    const type = (space.objectType || '').toLowerCase()
    const combined = `${name} ${type}`

    const keywords: Record<string, string[]> = {
        'OFFICE': ['office', 'workspace', 'workstation', 'büro', 'arbeitsplatz'],
        'MEETING': ['meeting', 'conference', 'huddle', 'besprechung', 'konferenz'],
        'BATHROOM': ['bathroom', 'restroom', 'toilet', 'wc', 'lavatory', 'bad', 'toilette', 'sanitär'],
        'KITCHEN': ['kitchen', 'kitchenette', 'pantry', 'break room', 'küche', 'teeküche'],
        'STORAGE': ['storage', 'closet', 'store', 'archive', 'lager', 'abstellraum'],
        'CORRIDOR': ['corridor', 'hallway', 'passage', 'flur', 'gang'],
        'LOBBY': ['lobby', 'foyer', 'entrance', 'reception', 'empfang', 'eingang'],
        'STAIRWELL': ['stair', 'stairwell', 'staircase', 'treppe', 'treppenhaus'],
        'ELEVATOR': ['elevator', 'lift', 'aufzug', 'fahrstuhl'],
        'MECHANICAL': ['mechanical', 'hvac', 'plant', 'technik', 'haustechnik'],
        'ELECTRICAL': ['electrical', 'elec room', 'elektro'],
        'SERVER': ['server', 'data center', 'it room', 'edv'],
        'BEDROOM': ['bedroom', 'schlafzimmer', 'zimmer'],
        'LIVING': ['living', 'wohnzimmer', 'wohnen'],
        'DINING': ['dining', 'esszimmer', 'essen'],
        'GARAGE': ['garage', 'parking', 'carport'],
        'BALCONY': ['balcony', 'balkon'],
        'TERRACE': ['terrace', 'terrasse', 'patio'],
    }

    for (const [func, terms] of Object.entries(keywords)) {
        if (terms.some(term => combined.includes(term))) {
            return func
        }
    }

    return null
}

// ============================================
// HELPER FUNCTIONS
// ============================================

function calculateBoundingBox(element: ElementInfo): THREE.Box3 | null {
    if (element.boundingBox) return element.boundingBox

    if (element.meshes && element.meshes.length > 0) {
        const bbox = new THREE.Box3()
        for (const mesh of element.meshes) {
            bbox.expandByObject(mesh)
        }
        return bbox
    }

    if (element.mesh) {
        const bbox = new THREE.Box3()
        bbox.setFromObject(element.mesh)
        return bbox
    }

    return null
}

/**
 * Convex hull algorithm for 2D points (Graham scan)
 */
function convexHull2D(points: THREE.Vector2[]): THREE.Vector2[] {
    if (points.length < 3) return points

    // Remove duplicate points
    const uniquePoints = removeDuplicatePoints(points)
    if (uniquePoints.length < 3) return uniquePoints

    // Sort points by x, then y
    const sorted = [...uniquePoints].sort((a, b) =>
        a.x === b.x ? a.y - b.y : a.x - b.x
    )

    const cross = (o: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2) =>
        (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)

    // Build lower hull
    const lower: THREE.Vector2[] = []
    for (const p of sorted) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
            lower.pop()
        }
        lower.push(p)
    }

    // Build upper hull
    const upper: THREE.Vector2[] = []
    for (const p of sorted.reverse()) {
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
            upper.pop()
        }
        upper.push(p)
    }

    // Remove last point of each half because it's repeated
    lower.pop()
    upper.pop()

    return lower.concat(upper)
}

function removeDuplicatePoints(points: THREE.Vector2[]): THREE.Vector2[] {
    const seen = new Set<string>()
    const unique: THREE.Vector2[] = []

    for (const p of points) {
        const key = `${Math.round(p.x * 1000)}_${Math.round(p.y * 1000)}`
        if (!seen.has(key)) {
            seen.add(key)
            unique.push(p)
        }
    }

    return unique
}

// ============================================
// MESH COLLECTION FOR SVG RENDERING
// ============================================

/**
 * Get all meshes for a space context for SVG rendering
 */
export function getSpaceContextMeshes(context: SpaceContext): THREE.Mesh[] {
    // Use detailed geometry if available
    if (context.detailedGeometry) {
        const { floorMeshes, wallMeshes, doorMeshes, windowMeshes } = context.detailedGeometry
        return [...floorMeshes, ...wallMeshes, ...doorMeshes, ...windowMeshes]
    }

    // Fallback to collecting meshes from elements
    const meshes: THREE.Mesh[] = []

    // Add space mesh(es)
    if (context.space.meshes) {
        meshes.push(...context.space.meshes)
    } else if (context.space.mesh) {
        meshes.push(context.space.mesh)
    }

    // Add wall meshes
    for (const wall of context.boundaryWalls) {
        if (wall.meshes) {
            meshes.push(...wall.meshes)
        } else if (wall.mesh) {
            meshes.push(wall.mesh)
        }
    }

    // Add door meshes
    for (const door of context.boundaryDoors) {
        if (door.meshes) {
            meshes.push(...door.meshes)
        } else if (door.mesh) {
            meshes.push(door.mesh)
        }
    }

    // Add window meshes
    for (const window of context.boundaryWindows) {
        if (window.meshes) {
            meshes.push(...window.meshes)
        } else if (window.mesh) {
            meshes.push(window.mesh)
        }
    }

    return meshes
}

/**
 * Load detailed geometry for space contexts from the IFC file using web-ifc
 */
export async function loadSpaceDetailedGeometry(
    spaceContexts: SpaceContext[],
    file: File,
    modelCenterOffset: THREE.Vector3
): Promise<void> {
    // Dynamically import to avoid circular dependencies
    const { extractDetailedGeometry } = await import('./ifc-loader')

    // Collect all unique expressIDs we need geometry for
    const spaceIDs = new Set<number>()
    const wallIDs = new Set<number>()
    const doorIDs = new Set<number>()
    const windowIDs = new Set<number>()

    for (const context of spaceContexts) {
        spaceIDs.add(context.space.expressID)
        for (const wall of context.boundaryWalls) {
            wallIDs.add(wall.expressID)
        }
        for (const door of context.boundaryDoors) {
            doorIDs.add(door.expressID)
        }
        for (const window of context.boundaryWindows) {
            windowIDs.add(window.expressID)
        }
    }

    // Extract all geometry in one pass
    const allIDs = [...spaceIDs, ...wallIDs, ...doorIDs, ...windowIDs]
    const geometryMap = await extractDetailedGeometry(file, allIDs)

    // Apply centering offset to all extracted meshes
    for (const meshes of geometryMap.values()) {
        for (const mesh of meshes) {
            if (mesh.geometry) {
                mesh.geometry.translate(-modelCenterOffset.x, -modelCenterOffset.y, -modelCenterOffset.z)
            }
        }
    }

    // Populate each space context with its geometry
    for (const context of spaceContexts) {
        const floorMeshes = geometryMap.get(context.space.expressID) || []
        const wallMeshes: THREE.Mesh[] = []
        const doorMeshes: THREE.Mesh[] = []
        const windowMeshes: THREE.Mesh[] = []

        for (const wall of context.boundaryWalls) {
            const meshes = geometryMap.get(wall.expressID) || []
            wallMeshes.push(...meshes)
        }
        for (const door of context.boundaryDoors) {
            const meshes = geometryMap.get(door.expressID) || []
            doorMeshes.push(...meshes)
        }
        for (const window of context.boundaryWindows) {
            const meshes = geometryMap.get(window.expressID) || []
            windowMeshes.push(...meshes)
        }

        context.detailedGeometry = {
            floorMeshes,
            wallMeshes,
            doorMeshes,
            windowMeshes,
            furnitureMeshes: [],
        }
    }
}
