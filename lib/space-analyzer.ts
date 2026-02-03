/**
 * Space/Room Analyzer - Extracts room outline geometry from IFCSPACE elements
 * Provides room context for visualization with fallback to bounding box outlines
 */

import * as THREE from 'three'
import type { ElementInfo } from './ifc-types'

export interface SpaceContext {
    space: ElementInfo
    name: string
    center: THREE.Vector3
    boundingBox: THREE.Box3
    // Room outline as 2D polygon (floor plan view)
    floorOutline: THREE.Vector2[]
    // Room outline as 3D polygon (for 3D visualization)
    floorOutline3D: THREE.Vector3[]
    // Source of the outline: 'geometry' or 'boundingBox'
    outlineSource: 'geometry' | 'boundingBox'
    // Floor height (Y coordinate)
    floorHeight: number
    // Room area in square meters (approximate)
    area: number
    // Associated storey name
    storeyName?: string
}

/**
 * Check if an element is a space/room
 */
function isSpaceType(typeName: string): boolean {
    const upper = typeName.toUpperCase()
    return upper === 'IFCSPACE' || upper.includes('SPACE')
}

/**
 * Extract floor outline from space geometry
 * Projects the bottom face of the space mesh to get a 2D polygon
 */
function extractFloorOutlineFromGeometry(space: ElementInfo): {
    outline: THREE.Vector2[]
    outline3D: THREE.Vector3[]
    floorHeight: number
} | null {
    const meshes = space.meshes || (space.mesh ? [space.mesh] : [])

    if (meshes.length === 0) {
        console.log(`[SpaceAnalyzer] Space ${space.expressID}: No meshes available`)
        return null
    }

    // Find the lowest Y coordinate (floor level)
    let minY = Infinity
    let allVertices: THREE.Vector3[] = []

    for (const mesh of meshes) {
        const geometry = mesh.geometry
        if (!geometry) continue

        const posAttr = geometry.attributes.position
        if (!posAttr || posAttr.count === 0) continue

        mesh.updateMatrixWorld(true)

        for (let i = 0; i < posAttr.count; i++) {
            const vertex = new THREE.Vector3(
                posAttr.getX(i),
                posAttr.getY(i),
                posAttr.getZ(i)
            )
            // Apply mesh transform if geometry is in local space
            vertex.applyMatrix4(mesh.matrixWorld)
            allVertices.push(vertex)
            minY = Math.min(minY, vertex.y)
        }
    }

    if (allVertices.length === 0 || minY === Infinity) {
        console.log(`[SpaceAnalyzer] Space ${space.expressID}: No valid vertices found`)
        return null
    }

    // Extract vertices near the floor level (within 10cm tolerance)
    const floorTolerance = 0.1 // 10cm
    const floorVertices = allVertices.filter(v => Math.abs(v.y - minY) < floorTolerance)

    if (floorVertices.length < 3) {
        console.log(`[SpaceAnalyzer] Space ${space.expressID}: Not enough floor vertices (${floorVertices.length})`)
        return null
    }

    // Project to 2D (X, Z plane) and compute convex hull for floor outline
    const points2D = floorVertices.map(v => new THREE.Vector2(v.x, v.z))
    const hull = computeConvexHull(points2D)

    if (hull.length < 3) {
        console.log(`[SpaceAnalyzer] Space ${space.expressID}: Convex hull too small (${hull.length} points)`)
        return null
    }

    // Convert back to 3D at floor height
    const outline3D = hull.map(p => new THREE.Vector3(p.x, minY, p.y))

    console.log(`[SpaceAnalyzer] Space ${space.expressID}: Extracted outline with ${hull.length} points from ${allVertices.length} total vertices`)

    return {
        outline: hull,
        outline3D,
        floorHeight: minY
    }
}

/**
 * Compute convex hull using Graham scan algorithm
 */
function computeConvexHull(points: THREE.Vector2[]): THREE.Vector2[] {
    if (points.length < 3) return points

    // Find the point with lowest Y (and leftmost if tied)
    let start = points[0]
    for (const p of points) {
        if (p.y < start.y || (p.y === start.y && p.x < start.x)) {
            start = p
        }
    }

    // Sort points by polar angle with respect to start point
    const sorted = [...points].sort((a, b) => {
        const angleA = Math.atan2(a.y - start.y, a.x - start.x)
        const angleB = Math.atan2(b.y - start.y, b.x - start.x)
        if (Math.abs(angleA - angleB) < 0.0001) {
            // Same angle, sort by distance
            const distA = a.distanceTo(start)
            const distB = b.distanceTo(start)
            return distA - distB
        }
        return angleA - angleB
    })

    // Build convex hull
    const hull: THREE.Vector2[] = []

    for (const p of sorted) {
        while (hull.length >= 2) {
            const a = hull[hull.length - 2]
            const b = hull[hull.length - 1]
            const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
            if (cross <= 0) {
                hull.pop()
            } else {
                break
            }
        }
        hull.push(p)
    }

    return hull
}

/**
 * Generate floor outline from bounding box (fallback)
 */
function generateOutlineFromBoundingBox(space: ElementInfo): {
    outline: THREE.Vector2[]
    outline3D: THREE.Vector3[]
    floorHeight: number
} | null {
    const bbox = space.boundingBox
    if (!bbox) {
        console.log(`[SpaceAnalyzer] Space ${space.expressID}: No bounding box available`)
        return null
    }

    const minY = bbox.min.y

    // Create rectangle outline from bounding box
    const outline: THREE.Vector2[] = [
        new THREE.Vector2(bbox.min.x, bbox.min.z),
        new THREE.Vector2(bbox.max.x, bbox.min.z),
        new THREE.Vector2(bbox.max.x, bbox.max.z),
        new THREE.Vector2(bbox.min.x, bbox.max.z),
    ]

    const outline3D = outline.map(p => new THREE.Vector3(p.x, minY, p.y))

    const size = bbox.getSize(new THREE.Vector3())
    console.log(`[SpaceAnalyzer] Space ${space.expressID}: Generated bounding box outline ${size.x.toFixed(2)}m x ${size.z.toFixed(2)}m`)

    return {
        outline,
        outline3D,
        floorHeight: minY
    }
}

/**
 * Calculate polygon area using shoelace formula
 */
function calculatePolygonArea(points: THREE.Vector2[]): number {
    if (points.length < 3) return 0

    let area = 0
    for (let i = 0; i < points.length; i++) {
        const j = (i + 1) % points.length
        area += points[i].x * points[j].y
        area -= points[j].x * points[i].y
    }

    return Math.abs(area) / 2
}

/**
 * Storey map type for quick lookup
 */
type StoreyMap = Map<number, string>

/**
 * Build a map of element ID -> storey name from spatial structure
 */
function buildStoreyMap(spatialNode: any, map: StoreyMap = new Map(), currentStorey: string | null = null): StoreyMap {
    if (!spatialNode) return map

    let storeyName = currentStorey
    if (spatialNode.type === 'IfcBuildingStorey') {
        storeyName = spatialNode.name || `Storey ${spatialNode.id}`
    }

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

    if (spatialNode.children) {
        for (const child of spatialNode.children) {
            buildStoreyMap(child, map, storeyName)
        }
    }

    return map
}

/**
 * Analyze all spaces/rooms in the model
 * @param elements - All elements from the model
 * @param spatialStructure - Optional spatial structure for storey assignment
 */
export function analyzeSpaces(
    elements: ElementInfo[],
    spatialStructure?: any
): SpaceContext[] {
    console.log('[SpaceAnalyzer] Starting space analysis...')
    console.log(`[SpaceAnalyzer] Total elements to scan: ${elements.length}`)

    // Build storey map from spatial structure
    const storeyMap = buildStoreyMap(spatialStructure)

    // Find all IFCSPACE elements
    const spaces = elements.filter(e => isSpaceType(e.typeName))
    console.log(`[SpaceAnalyzer] Found ${spaces.length} spaces (IFCSPACE)`)

    const results: SpaceContext[] = []

    let geometrySuccessCount = 0
    let boundingBoxFallbackCount = 0
    let failedCount = 0

    for (const space of spaces) {
        // Try to extract outline from geometry first
        let outlineData = extractFloorOutlineFromGeometry(space)
        let outlineSource: 'geometry' | 'boundingBox' = 'geometry'

        if (!outlineData) {
            // Fallback to bounding box
            outlineData = generateOutlineFromBoundingBox(space)
            outlineSource = 'boundingBox'

            if (outlineData) {
                boundingBoxFallbackCount++
            }
        } else {
            geometrySuccessCount++
        }

        if (!outlineData) {
            console.warn(`[SpaceAnalyzer] Space ${space.expressID}: Failed to extract any outline`)
            failedCount++
            continue
        }

        // Calculate center and area
        const center = space.boundingBox
            ? space.boundingBox.getCenter(new THREE.Vector3())
            : new THREE.Vector3()

        const area = calculatePolygonArea(outlineData.outline)

        // Get space name (from productTypeName or typeName)
        const name = space.productTypeName || space.globalId || `Space ${space.expressID}`

        // Get storey name
        const storeyName = storeyMap.get(space.expressID)

        results.push({
            space,
            name,
            center,
            boundingBox: space.boundingBox || new THREE.Box3(),
            floorOutline: outlineData.outline,
            floorOutline3D: outlineData.outline3D,
            outlineSource,
            floorHeight: outlineData.floorHeight,
            area,
            storeyName,
        })
    }

    // Log summary
    console.log('[SpaceAnalyzer] === SPACE ANALYSIS SUMMARY ===')
    console.log(`[SpaceAnalyzer] Total spaces found: ${spaces.length}`)
    console.log(`[SpaceAnalyzer] Geometry outlines extracted: ${geometrySuccessCount}`)
    console.log(`[SpaceAnalyzer] Bounding box fallbacks: ${boundingBoxFallbackCount}`)
    console.log(`[SpaceAnalyzer] Failed to extract: ${failedCount}`)
    console.log(`[SpaceAnalyzer] Total space contexts created: ${results.length}`)
    console.log('[SpaceAnalyzer] ==============================')

    return results
}

/**
 * Create SVG path for a room outline
 */
export function createRoomOutlineSVG(
    space: SpaceContext,
    options: {
        strokeColor?: string
        strokeWidth?: number
        fillColor?: string
        fillOpacity?: number
        showLabel?: boolean
        fontSize?: number
    } = {}
): string {
    const {
        strokeColor = '#2196F3',
        strokeWidth = 2,
        fillColor = '#2196F3',
        fillOpacity = 0.1,
        showLabel = true,
        fontSize = 12
    } = options

    const outline = space.floorOutline
    if (outline.length < 3) return ''

    // Create SVG path
    const pathData = outline.map((p, i) =>
        `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`
    ).join(' ') + ' Z'

    let svg = `<path d="${pathData}"
        stroke="${strokeColor}"
        stroke-width="${strokeWidth}"
        fill="${fillColor}"
        fill-opacity="${fillOpacity}"
        class="room-outline"
        data-room-id="${space.space.expressID}"
        data-room-name="${space.name}"
        data-outline-source="${space.outlineSource}"/>`

    if (showLabel) {
        // Calculate center of polygon for label placement
        const cx = outline.reduce((sum, p) => sum + p.x, 0) / outline.length
        const cy = outline.reduce((sum, p) => sum + p.y, 0) / outline.length

        svg += `<text
            x="${cx.toFixed(2)}"
            y="${cy.toFixed(2)}"
            font-size="${fontSize}"
            fill="${strokeColor}"
            text-anchor="middle"
            dominant-baseline="middle"
            class="room-label">${space.name}</text>`

        // Add area label
        svg += `<text
            x="${cx.toFixed(2)}"
            y="${(cy + fontSize * 1.2).toFixed(2)}"
            font-size="${fontSize * 0.8}"
            fill="#666"
            text-anchor="middle"
            dominant-baseline="middle"
            class="room-area">${space.area.toFixed(1)} m²</text>`
    }

    return svg
}

/**
 * Create THREE.js LineLoop for visualizing room outline in 3D
 */
export function createRoomOutline3D(
    space: SpaceContext,
    options: {
        color?: number
        linewidth?: number
        height?: number // Optional height offset above floor
    } = {}
): THREE.LineLoop {
    const {
        color = 0x2196F3,
        linewidth = 2,
        height = 0.01 // Slight offset to avoid z-fighting
    } = options

    const points = space.floorOutline3D.map(p =>
        new THREE.Vector3(p.x, p.y + height, p.z)
    )

    const geometry = new THREE.BufferGeometry().setFromPoints(points)
    const material = new THREE.LineBasicMaterial({
        color,
        linewidth,
        transparent: true,
        opacity: 0.8
    })

    const line = new THREE.LineLoop(geometry, material)
    line.userData.spaceId = space.space.expressID
    line.userData.spaceName = space.name
    line.name = `RoomOutline_${space.space.expressID}`

    return line
}

/**
 * Filter spaces by storey
 */
export function filterSpacesByStorey(
    spaces: SpaceContext[],
    storeyName: string
): SpaceContext[] {
    const lowerStorey = storeyName.toLowerCase()
    return spaces.filter(s =>
        s.storeyName && s.storeyName.toLowerCase().includes(lowerStorey)
    )
}

/**
 * Get all unique storey names from spaces
 */
export function getStoreyNames(spaces: SpaceContext[]): string[] {
    const names = new Set<string>()
    for (const space of spaces) {
        if (space.storeyName) {
            names.add(space.storeyName)
        }
    }
    return Array.from(names).sort()
}
