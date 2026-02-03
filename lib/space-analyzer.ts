import * as THREE from 'three'
import type { ElementInfo, LoadedIFCModel } from './ifc-types'
import type { SpaceInfo, SpaceContext, SpaceFilterOptions } from './ifc-space-types'
import type { SpatialNode } from './spatial-structure'
import { extractSpaceProfileOutlines, extractLengthUnitScale } from './ifc-loader'
import type { IfcAPI } from 'web-ifc'

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
 * @param model - The loaded IFC model (may not have api/modelID if loaded via fragments)
 * @param spatialStructure - Optional spatial structure tree
 * @param originalFile - Optional original IFC file (needed if model.api is not available)
 */
export async function analyzeSpaces(
    model: LoadedIFCModel,
    spatialStructure?: SpatialNode | null,
    originalFile?: File
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

    // Extract profile outlines for all spaces (if model is still open)
    const spaceProfiles = new Map<number, THREE.Vector2[]>()
    try {
        console.log('[SpaceAnalyzer] Extracting space profile outlines...')

        // If model doesn't have API (fragments loader), temporarily open IFC file
        let tempApi: IfcAPI | null = null
        let tempModelID: number | null = null
        let apiToUse = model.api
        let modelIDToUse = model.modelID

        if (!apiToUse && originalFile) {
            console.log('[SpaceAnalyzer] Model API not available, temporarily opening IFC file for profile extraction...')
            try {
                const { loadIFCModelWithMetadata } = await import('./ifc-loader')
                const tempModel = await loadIFCModelWithMetadata(originalFile)
                tempApi = tempModel.api
                tempModelID = tempModel.modelID
                apiToUse = tempApi
                modelIDToUse = tempModelID
            } catch (error) {
                console.warn('[SpaceAnalyzer] Failed to open IFC file for profile extraction:', error)
            }
        }

        if (apiToUse && modelIDToUse !== undefined) {
            for (const spaceElement of spaces) {
                try {
                    const profile = await extractSpaceProfileOutlines(
                        apiToUse,
                        modelIDToUse,
                        spaceElement.expressID
                    )
                    if (profile && profile.length >= 3) {
                        spaceProfiles.set(spaceElement.expressID, profile)
                        console.log(`[SpaceAnalyzer] Extracted ${profile.length}-point profile for space ${spaceElement.expressID}`)
                    }
                } catch (error) {
                    // Profile extraction failed, will fall back to mesh/bounding box
                    console.warn(`[SpaceAnalyzer] Failed to extract profile for space ${spaceElement.expressID}:`, error)
                }
            }
            console.log(`[SpaceAnalyzer] Extracted ${spaceProfiles.size} space profiles`)

            // Clean up temporary API if we opened it
            if (tempApi && tempModelID !== null) {
                try {
                    tempApi.CloseModel(tempModelID)
                    console.log('[SpaceAnalyzer] Closed temporary IFC model')
                } catch (error) {
                    console.warn('[SpaceAnalyzer] Error closing temporary model:', error)
                }
            }
        } else {
            console.warn('[SpaceAnalyzer] No API available for profile extraction, using fallback methods')
        }
    } catch (error) {
        console.warn('[SpaceAnalyzer] Profile extraction failed (model may be closed), using fallback methods:', error)
    }

    // Analyze each space
    const spaceContexts: SpaceContext[] = []

    for (const spaceElement of spaces) {
        const context = analyzeSpace(
            spaceElement,
            walls,
            doors,
            windows,
            furniture,
            storeyMap,
            spaceProfiles.get(spaceElement.expressID)
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
    storeyMap: StoreyMap,
    profileOutline?: THREE.Vector2[]
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
    // Priority: 1) Profile outline (real geometry), 2) Mesh extraction, 3) Bounding box
    const floorPolygon = profileOutline || extractFloorPolygon(space)

    // Get storey name from spatial structure
    const storeyName = storeyMap.get(space.expressID) || null

    // Convert element to SpaceInfo
    // NOTE: IFC files can be Y-up (Y is vertical) or Z-up (Z is vertical)
    // For floor plans, we need the horizontal plane: X and Z for Y-up, X and Y for Z-up
    // We detect this by checking if Y dimension is typical ceiling height (2-4m)
    const isYUp = size.y > 1.5 && size.y < 5 && size.z > size.y * 2

    const horizontalWidth = size.x
    const horizontalDepth = isYUp ? size.z : size.y
    const verticalHeight = isYUp ? size.y : size.z

    const spaceInfo: SpaceInfo = {
        ...space,
        longName: space.productTypeName || undefined,
        objectType: space.typeName,
        centerPoint: center,
        // Calculate approximate area from bounding box using horizontal plane
        grossFloorArea: horizontalWidth * horizontalDepth,
        height: verticalHeight,
        boundingBox2D: isYUp ? {
            // Y-up: floor plan is X-Z plane
            min: new THREE.Vector2(bbox.min.x, bbox.min.z),
            max: new THREE.Vector2(bbox.max.x, bbox.max.z),
            width: size.x,
            depth: size.z,
        } : {
            // Z-up: floor plan is X-Y plane
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
        const size = new THREE.Vector3()
        bbox.getSize(size)

        // Detect Y-up vs Z-up coordinate system
        // Y-up: Y is vertical (ceiling height), floor plan uses X-Z
        // Z-up: Z is vertical (ceiling height), floor plan uses X-Y
        const isYUp = size.y > 1.5 && size.y < 5 && size.z > size.y * 2

        if (isYUp) {
            // Y-up: floor plan is X-Z plane
            return [
                new THREE.Vector2(bbox.min.x, bbox.min.z),
                new THREE.Vector2(bbox.max.x, bbox.min.z),
                new THREE.Vector2(bbox.max.x, bbox.max.z),
                new THREE.Vector2(bbox.min.x, bbox.max.z),
            ]
        } else {
            // Z-up: floor plan is X-Y plane
            return [
                new THREE.Vector2(bbox.min.x, bbox.min.y),
                new THREE.Vector2(bbox.max.x, bbox.min.y),
                new THREE.Vector2(bbox.max.x, bbox.max.y),
                new THREE.Vector2(bbox.min.x, bbox.max.y),
            ]
        }
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
export function convexHull2D(points: THREE.Vector2[]): THREE.Vector2[] {
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

export function removeDuplicatePoints(points: THREE.Vector2[]): THREE.Vector2[] {
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
 * Extract space height range from ObjectPlacement using IFC Z coordinate
 * IFC files are natively Z-up, so height is always Z coordinate
 */
function extractSpaceHeightRange(
    api: IfcAPI,
    modelID: number,
    space: ElementInfo,
    lengthUnitScale: number
): { minHeight: number; maxHeight: number } | null {
    try {
        const spaceEntity = api.GetLine(modelID, space.expressID)
        if (!spaceEntity) return null

        const objectPlacementRef = (spaceEntity as any).ObjectPlacement
        if (objectPlacementRef?.value) {
            const placement = api.GetLine(modelID, objectPlacementRef.value)
            if (placement?.RelativePlacement?.value) {
                const axisPlacement = api.GetLine(modelID, (placement as any).RelativePlacement.value)
                if (axisPlacement?.Location?.value) {
                    const location = api.GetLine(modelID, (axisPlacement as any).Location.value)
                    if (location?.Coordinates) {
                        const coords = (location as any).Coordinates
                        let coordArray: number[] = []
                        if (Array.isArray(coords)) {
                            coordArray = coords.map((c: any) => {
                                if (typeof c === 'number') return c
                                if (c && typeof c === 'object' && '_representationValue' in c) {
                                    return typeof c._representationValue === 'number' ? c._representationValue : parseFloat(c._representationValue || '0')
                                }
                                return parseFloat(c || '0')
                            })
                        }

                        if (coordArray.length >= 3) {
                            // IFC files are natively Z-up, so height is always Z coordinate (coordArray[2])
                            // Even though web-ifc converts to Y-up internally, ObjectPlacement is read directly from IFC
                            // Need to scale by lengthUnitScale to match element coordinates
                            const spaceZ = coordArray[2] * lengthUnitScale
                            // Typical room height is 2.5-4m (scaled to model units)
                            const typicalHeight = 3.0 * lengthUnitScale
                            return {
                                minHeight: spaceZ,
                                maxHeight: spaceZ + typicalHeight
                            }
                        }
                    }
                }
            }
        }
    } catch (e) {
        // Couldn't get placement, return null
    }
    return null
}

/**
 * Check if an element's bounding box intersects (is partially inside) a space polygon
 */
function isElementInSpace(
    elementBbox: { min: THREE.Vector2; max: THREE.Vector2 },
    spacePolygon: THREE.Vector2[],
    spaceBbox: { min: THREE.Vector2; max: THREE.Vector2 }
): boolean {
    if (!elementBbox || !spaceBbox) return false

    // Quick bounding box check first - if bboxes don't overlap, element can't be in space
    if (elementBbox.max.x < spaceBbox.min.x || elementBbox.min.x > spaceBbox.max.x ||
        elementBbox.max.y < spaceBbox.min.y || elementBbox.min.y > spaceBbox.max.y) {
        return false
    }

    // Get element bbox corners
    const corners = [
        new THREE.Vector2(elementBbox.min.x, elementBbox.min.y), // bottom-left
        new THREE.Vector2(elementBbox.max.x, elementBbox.min.y), // bottom-right
        new THREE.Vector2(elementBbox.max.x, elementBbox.max.y), // top-right
        new THREE.Vector2(elementBbox.min.x, elementBbox.max.y)  // top-left
    ]

    // Check if any corner of element bbox is inside the polygon
    const hasCornerInside = corners.some(corner => pointInPolygon(corner, spacePolygon))
    if (hasCornerInside) return true

    // Check if any edge of element bbox intersects any edge of polygon
    const elementEdges = [
        [corners[0], corners[1]], // bottom edge
        [corners[1], corners[2]], // right edge
        [corners[2], corners[3]], // top edge
        [corners[3], corners[0]]  // left edge
    ]

    // Check intersection with polygon edges
    for (let i = 0; i < elementEdges.length; i++) {
        const edge1 = elementEdges[i]
        for (let j = 0, k = spacePolygon.length - 1; j < spacePolygon.length; k = j++) {
            const edge2 = [spacePolygon[k], spacePolygon[j]]
            if (segmentsIntersect(edge1[0], edge1[1], edge2[0], edge2[1])) {
                return true
            }
        }
    }

    // Check if element bbox completely contains the polygon (all polygon points inside bbox)
    const allPolygonPointsInside = spacePolygon.every(point =>
        point.x >= elementBbox.min.x && point.x <= elementBbox.max.x &&
        point.y >= elementBbox.min.y && point.y <= elementBbox.max.y
    )
    if (allPolygonPointsInside && spacePolygon.length > 0) {
        return true
    }

    return false
}

/**
 * Check if two line segments intersect
 */
function segmentsIntersect(p1: THREE.Vector2, p2: THREE.Vector2, p3: THREE.Vector2, p4: THREE.Vector2): boolean {
    const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x)
    if (Math.abs(d) < 1e-10) return false // Parallel lines

    const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d
    const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d

    return t >= 0 && t <= 1 && u >= 0 && u <= 1
}

/**
 * Point-in-polygon test using ray casting algorithm
 */
function pointInPolygon(point: THREE.Vector2, polygon: THREE.Vector2[]): boolean {
    let inside = false
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = polygon[i].x, yi = polygon[i].y
        const xj = polygon[j].x, yj = polygon[j].y

        const intersect = ((yi > point.y) !== (yj > point.y)) &&
            (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi)
        if (intersect) inside = !inside
    }
    return inside
}

/**
 * Get all elements inside a space, filtered by height and polygon intersection
 * Returns elements grouped by IFC type name
 */
export function getElementsInSpace(
    spaceContext: SpaceContext,
    allElements: ElementInfo[],
    api: IfcAPI | null,
    modelID: number,
    lengthUnitScale: number,
    isYUpCoordinateSystem: boolean
): Map<string, ElementInfo[]> {
    const result = new Map<string, ElementInfo[]>()

    if (!spaceContext.floorPolygon || spaceContext.floorPolygon.length < 3) {
        return result // No valid polygon, return empty
    }

    const spacePolygon = spaceContext.floorPolygon

    // Calculate space bounding box for quick rejection
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const point of spacePolygon) {
        minX = Math.min(minX, point.x)
        maxX = Math.max(maxX, point.x)
        minY = Math.min(minY, point.y)
        maxY = Math.max(maxY, point.y)
    }
    const spaceBbox = {
        min: new THREE.Vector2(minX, minY),
        max: new THREE.Vector2(maxX, maxY)
    }

    // Get space height range (may be null if API not available)
    const spaceHeightRange = api && modelID >= 0
        ? extractSpaceHeightRange(api, modelID, spaceContext.space, lengthUnitScale)
        : null

    // Debug: Log element filtering
    console.log(`[getElementsInSpace] Space ${spaceContext.spaceId} (expressID: ${spaceContext.space.expressID}):`)
    console.log(`  Total elements to check: ${allElements.length}`)
    console.log(`  Space polygon points: ${spacePolygon.length}`)
    console.log(`  Space height range:`, spaceHeightRange)

    // Debug: Log element type distribution
    const typeCounts = new Map<string, number>()
    for (const element of allElements) {
        if (isSpaceType(element.typeName)) continue
        const type = element.typeName || 'Unknown'
        typeCounts.set(type, (typeCounts.get(type) || 0) + 1)
    }
    console.log(`  Element types in model:`, Array.from(typeCounts.entries()).map(([t, c]) => `${t}(${c})`).join(', '))

    let checkedCount = 0
    let skippedNoBbox = 0
    let skippedHeight = 0
    let skippedPolygon = 0
    let furnitureCount = 0

    // Filter elements
    for (const element of allElements) {
        // Skip spaces themselves
        if (isSpaceType(element.typeName)) continue

        // Skip if no bounding box
        if (!element.boundingBox) {
            skippedNoBbox++
            continue
        }

        checkedCount++

        // Convert element 3D bounding box to 2D floor plan coordinates
        const bbox3D = element.boundingBox
        let bbox2D: { min: THREE.Vector2; max: THREE.Vector2 } | null = null
        let heightRange: { minHeight: number; maxHeight: number } | null = null

        if (isYUpCoordinateSystem) {
            // Y-up: floor plan is X-Z plane, Y is height
            bbox2D = {
                min: new THREE.Vector2(bbox3D.min.x * lengthUnitScale, bbox3D.min.z * lengthUnitScale),
                max: new THREE.Vector2(bbox3D.max.x * lengthUnitScale, bbox3D.max.z * lengthUnitScale)
            }
            heightRange = {
                minHeight: bbox3D.min.y * lengthUnitScale,
                maxHeight: bbox3D.max.y * lengthUnitScale
            }
        } else {
            // Z-up: floor plan is X-Y plane, Z is height
            bbox2D = {
                min: new THREE.Vector2(bbox3D.min.x * lengthUnitScale, bbox3D.min.y * lengthUnitScale),
                max: new THREE.Vector2(bbox3D.max.x * lengthUnitScale, bbox3D.max.y * lengthUnitScale)
            }
            heightRange = {
                minHeight: bbox3D.min.z * lengthUnitScale,
                maxHeight: bbox3D.max.z * lengthUnitScale
            }
        }

        // HEIGHT FILTER: Only include elements that overlap vertically with the space
        if (spaceHeightRange && heightRange) {
            const heightOverlap = !(
                heightRange.maxHeight < spaceHeightRange.minHeight - 0.5 || // element below space
                heightRange.minHeight > spaceHeightRange.maxHeight + 0.5    // element above space
            )
            if (!heightOverlap) {
                skippedHeight++
                continue // Skip elements not on this floor
            }
        }

        // SPATIAL FILTER: Check if element intersects space polygon
        if (!isElementInSpace(bbox2D, spacePolygon, spaceBbox)) {
            skippedPolygon++
            continue
        }

        // Add to result grouped by type
        const typeName = element.typeName || 'Unknown'
        if (!result.has(typeName)) {
            result.set(typeName, [])
        }
        result.get(typeName)!.push(element)

        // Count furniture
        if (typeName.toUpperCase().includes('FURNISHING') || typeName.toUpperCase().includes('FURNITURE')) {
            furnitureCount++
        }
    }

    // Debug: Log filtering results
    console.log(`  Elements checked: ${checkedCount}`)
    console.log(`  Skipped (no bbox): ${skippedNoBbox}`)
    console.log(`  Skipped (height): ${skippedHeight}`)
    console.log(`  Skipped (polygon): ${skippedPolygon}`)
    console.log(`  Elements in space: ${Array.from(result.values()).reduce((sum, arr) => sum + arr.length, 0)}`)
    console.log(`  Furniture elements: ${furnitureCount}`)
    console.log(`  Element types: ${Array.from(result.keys()).join(', ')}`)

    return result
}

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
