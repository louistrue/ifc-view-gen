import * as THREE from 'three'
import type { SpaceContext, SpaceSVGRenderOptions } from './ifc-space-types'
import type { ElementInfo } from './ifc-types'

const DEFAULT_OPTIONS: Required<SpaceSVGRenderOptions> = {
    width: 800,
    height: 600,
    margin: 1.0,
    showArea: true,
    showDimensions: true,
    showDoors: true,
    showWindows: true,
    showRoomLabel: true,
    showGrid: false,
    gridSize: 1.0,
    backgroundColor: '#f5f5f5',
    floorColor: '#ffffff',
    wallColor: '#333333',
    wallFillColor: '#666666',
    doorColor: '#0066cc',
    windowColor: '#66ccff',
    dimensionColor: '#666666',
    labelColor: '#000000',
    lineWidth: 2,
    lineColor: '#000000',
    fontSize: 14,
    fontFamily: 'Arial, sans-serif',
}

interface Bounds2D {
    minX: number
    maxX: number
    minY: number
    maxY: number
    width: number
    height: number
}

/**
 * Render a floor plan SVG for a single space
 */
export function renderSpaceFloorPlan(
    context: SpaceContext,
    options: SpaceSVGRenderOptions = {}
): string {
    const opts = { ...DEFAULT_OPTIONS, ...options }
    const {
        width,
        height,
        margin,
        showArea,
        showDimensions,
        showDoors,
        showWindows,
        showRoomLabel,
        showGrid,
        gridSize,
        floorColor,
        wallColor,
        wallFillColor,
        doorColor,
        windowColor,
        dimensionColor,
        labelColor,
        backgroundColor,
        lineWidth,
        fontSize,
        fontFamily,
    } = opts

    // Get bounding box for reference dimensions (always shown as dashed)
    const bbox = context.space.boundingBox
    if (!bbox) {
        return createErrorSVG(width, height, 'No bounding box')
    }

    const bboxSize = new THREE.Vector3()
    bbox.getSize(bboxSize)

    // Detect Y-up vs Z-up coordinate system
    // Y-up: Y is vertical (ceiling height ~2-4m), floor plan uses X-Z
    // Z-up: Z is vertical (ceiling height), floor plan uses X-Y
    const isYUp = bboxSize.y > 1.5 && bboxSize.y < 5 && bboxSize.z > bboxSize.y * 2

    // Create bounding box polygon (always rectangular, used for dimensions)
    const bboxPolygon: THREE.Vector2[] = isYUp ? [
        new THREE.Vector2(bbox.min.x, bbox.min.z),
        new THREE.Vector2(bbox.max.x, bbox.min.z),
        new THREE.Vector2(bbox.max.x, bbox.max.z),
        new THREE.Vector2(bbox.min.x, bbox.max.z),
    ] : [
        new THREE.Vector2(bbox.min.x, bbox.min.y),
        new THREE.Vector2(bbox.max.x, bbox.min.y),
        new THREE.Vector2(bbox.max.x, bbox.max.y),
        new THREE.Vector2(bbox.min.x, bbox.max.y),
    ]

    // Get real floor polygon from geometry if available
    let realPolygon = context.floorPolygon
    const hasRealGeometry = realPolygon && realPolygon.length >= 3

    // If no real geometry, use bounding box for fill
    const fillPolygon = hasRealGeometry ? realPolygon! : bboxPolygon

    // Calculate bounds from the larger of the two (usually bounding box)
    const bounds = calculatePolygonBounds(bboxPolygon)

    // Calculate scale to fit in viewport with margins
    const worldWidth = bounds.width + margin * 2
    const worldHeight = bounds.height + margin * 2

    // Reserve space for labels at bottom
    const labelReserve = showRoomLabel || showArea ? 60 : 0
    const viewHeight = height - labelReserve

    const scaleX = width / worldWidth
    const scaleY = viewHeight / worldHeight
    const scale = Math.min(scaleX, scaleY) * 0.9 // 90% to leave some padding

    // Center offset
    const scaledWidth = bounds.width * scale
    const scaledHeight = bounds.height * scale
    const offsetX = (width - scaledWidth) / 2
    const offsetY = (viewHeight - scaledHeight) / 2

    // Transform function: world coords to SVG coords
    const toSVG = (p: THREE.Vector2): { x: number; y: number } => ({
        x: (p.x - bounds.minX) * scale + offsetX,
        y: viewHeight - ((p.y - bounds.minY) * scale + offsetY), // Flip Y
    })

    // Start building SVG
    let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <pattern id="grid" width="${gridSize * scale}" height="${gridSize * scale}" patternUnits="userSpaceOnUse">
      <path d="M ${gridSize * scale} 0 L 0 0 0 ${gridSize * scale}" fill="none" stroke="#ddd" stroke-width="0.5"/>
    </pattern>
  </defs>
  <rect width="100%" height="100%" fill="${backgroundColor}"/>
`

    // Optional grid
    if (showGrid) {
        svg += `  <rect width="100%" height="${viewHeight}" fill="url(#grid)"/>\n`
    }

    // Draw floor fill (use real geometry if available, otherwise bounding box)
    const fillPath = fillPolygon.map((p, i) => {
        const svgP = toSVG(p)
        return i === 0 ? `M ${svgP.x.toFixed(2)} ${svgP.y.toFixed(2)}` : `L ${svgP.x.toFixed(2)} ${svgP.y.toFixed(2)}`
    }).join(' ') + ' Z'

    svg += `  <path d="${fillPath}" fill="${floorColor}" stroke="none"/>\n`

    // Draw bounding box with DASHED lines (always shown for reference/dimensions)
    const bboxPath = bboxPolygon.map((p, i) => {
        const svgP = toSVG(p)
        return i === 0 ? `M ${svgP.x.toFixed(2)} ${svgP.y.toFixed(2)}` : `L ${svgP.x.toFixed(2)} ${svgP.y.toFixed(2)}`
    }).join(' ') + ' Z'

    svg += `  <path d="${bboxPath}" fill="none" stroke="${wallColor}" stroke-width="${lineWidth}" stroke-dasharray="8,4" stroke-linejoin="miter"/>\n`

    // Draw real geometry outline with SOLID lines (if we have actual geometry)
    if (hasRealGeometry) {
        svg += `  <path d="${fillPath}" fill="none" stroke="${wallColor}" stroke-width="${lineWidth * 2}" stroke-linejoin="miter"/>\n`
    }

    // Draw doors
    if (showDoors && context.boundaryDoors.length > 0) {
        svg += `  <g id="doors">\n`
        for (const door of context.boundaryDoors) {
            svg += renderDoorSymbol(door, toSVG, scale, doorColor, lineWidth, bounds, fillPolygon)
        }
        svg += `  </g>\n`
    }

    // Draw windows
    if (showWindows && context.boundaryWindows.length > 0) {
        svg += `  <g id="windows">\n`
        for (const window of context.boundaryWindows) {
            svg += renderWindowSymbol(window, toSVG, scale, windowColor, lineWidth, bounds, fillPolygon)
        }
        svg += `  </g>\n`
    }

    // Draw dimensions
    if (showDimensions) {
        svg += renderDimensions(bounds, toSVG, scale, dimensionColor, fontSize, fontFamily, viewHeight)
    }

    // Add room label and area at bottom
    if (showRoomLabel || showArea) {
        const centerX = width / 2
        let currentY = viewHeight + 25

        if (showRoomLabel) {
            svg += `  <text x="${centerX}" y="${currentY}" text-anchor="middle" dominant-baseline="middle" font-family="${fontFamily}" font-size="${fontSize + 2}" font-weight="bold" fill="${labelColor}">${escapeXml(context.spaceName)}</text>\n`
            currentY += fontSize + 8
        }

        if (showArea && context.space.grossFloorArea) {
            const area = context.space.grossFloorArea.toFixed(2)
            svg += `  <text x="${centerX}" y="${currentY}" text-anchor="middle" dominant-baseline="middle" font-family="${fontFamily}" font-size="${fontSize}" fill="${dimensionColor}">${area} m²</text>\n`
        }
    }

    svg += '</svg>'
    return svg
}

/**
 * Render door symbol in floor plan
 */
function renderDoorSymbol(
    door: ElementInfo,
    toSVG: (p: THREE.Vector2) => { x: number; y: number },
    scale: number,
    color: string,
    lineWidth: number,
    bounds: Bounds2D,
    polygon: THREE.Vector2[]
): string {
    const bbox = door.boundingBox
    if (!bbox) return ''

    const center = new THREE.Vector3()
    bbox.getCenter(center)
    const size = new THREE.Vector3()
    bbox.getSize(size)

    // Door dimensions
    const doorWidth = Math.max(size.x, size.y) // Width of door opening
    const doorDepth = Math.min(size.x, size.y)  // Thickness

    // Find which wall edge the door is on
    const doorCenter2D = new THREE.Vector2(center.x, center.y)
    const { wallStart, wallEnd, wallNormal } = findNearestWallEdge(doorCenter2D, polygon)

    if (!wallStart || !wallEnd) {
        // Fallback: draw simple rectangle
        const min2D = new THREE.Vector2(bbox.min.x, bbox.min.y)
        const max2D = new THREE.Vector2(bbox.max.x, bbox.max.y)
        const svgMin = toSVG(min2D)
        const svgMax = toSVG(max2D)
        return `    <rect x="${Math.min(svgMin.x, svgMax.x).toFixed(2)}" y="${Math.min(svgMin.y, svgMax.y).toFixed(2)}" width="${Math.abs(svgMax.x - svgMin.x).toFixed(2)}" height="${Math.abs(svgMax.y - svgMin.y).toFixed(2)}" fill="${color}" fill-opacity="0.3" stroke="${color}" stroke-width="${lineWidth}"/>\n`
    }

    // Calculate door opening position on wall
    const svgCenter = toSVG(doorCenter2D)
    const scaledWidth = doorWidth * scale

    // Draw door opening (gap in wall shown as white rectangle)
    const wallDir = wallEnd.clone().sub(wallStart).normalize()
    const halfWidth = scaledWidth / 2

    // Door opening line
    const openingStart = toSVG(doorCenter2D.clone().sub(wallDir.clone().multiplyScalar(doorWidth / 2)))
    const openingEnd = toSVG(doorCenter2D.clone().add(wallDir.clone().multiplyScalar(doorWidth / 2)))

    // Draw door swing arc (90 degrees)
    const arcRadius = scaledWidth * 0.8
    const arcStartX = openingStart.x
    const arcStartY = openingStart.y
    const arcEndX = openingStart.x + wallNormal.x * arcRadius * scale
    const arcEndY = openingStart.y - wallNormal.y * arcRadius * scale  // Flip Y

    let result = ''

    // Door opening (break in wall)
    result += `    <line x1="${openingStart.x.toFixed(2)}" y1="${openingStart.y.toFixed(2)}" x2="${openingEnd.x.toFixed(2)}" y2="${openingEnd.y.toFixed(2)}" stroke="${color}" stroke-width="${lineWidth * 2}"/>\n`

    // Door leaf (closed position)
    result += `    <line x1="${openingStart.x.toFixed(2)}" y1="${openingStart.y.toFixed(2)}" x2="${arcEndX.toFixed(2)}" y2="${arcEndY.toFixed(2)}" stroke="${color}" stroke-width="${lineWidth}" stroke-dasharray="4,2"/>\n`

    // Swing arc
    const sweepFlag = 1  // clockwise
    result += `    <path d="M ${openingStart.x.toFixed(2)} ${openingStart.y.toFixed(2)} A ${arcRadius.toFixed(2)} ${arcRadius.toFixed(2)} 0 0 ${sweepFlag} ${arcEndX.toFixed(2)} ${arcEndY.toFixed(2)}" fill="none" stroke="${color}" stroke-width="${lineWidth * 0.75}" stroke-dasharray="3,2"/>\n`

    return result
}

/**
 * Render window symbol in floor plan
 */
function renderWindowSymbol(
    window: ElementInfo,
    toSVG: (p: THREE.Vector2) => { x: number; y: number },
    scale: number,
    color: string,
    lineWidth: number,
    bounds: Bounds2D,
    polygon: THREE.Vector2[]
): string {
    const bbox = window.boundingBox
    if (!bbox) return ''

    const center = new THREE.Vector3()
    bbox.getCenter(center)
    const size = new THREE.Vector3()
    bbox.getSize(size)

    // Window dimensions
    const windowWidth = Math.max(size.x, size.y)
    const windowDepth = Math.min(size.x, size.y)

    // Find which wall edge the window is on
    const windowCenter2D = new THREE.Vector2(center.x, center.y)
    const { wallStart, wallEnd, wallNormal } = findNearestWallEdge(windowCenter2D, polygon)

    if (!wallStart || !wallEnd) {
        // Fallback: draw simple rectangle
        const min2D = new THREE.Vector2(bbox.min.x, bbox.min.y)
        const max2D = new THREE.Vector2(bbox.max.x, bbox.max.y)
        const svgMin = toSVG(min2D)
        const svgMax = toSVG(max2D)
        return `    <rect x="${Math.min(svgMin.x, svgMax.x).toFixed(2)}" y="${Math.min(svgMin.y, svgMax.y).toFixed(2)}" width="${Math.abs(svgMax.x - svgMin.x).toFixed(2)}" height="${Math.abs(svgMax.y - svgMin.y).toFixed(2)}" fill="none" stroke="${color}" stroke-width="${lineWidth}"/>\n`
    }

    const wallDir = wallEnd.clone().sub(wallStart).normalize()
    const halfWidth = windowWidth / 2

    // Calculate window line endpoints
    const windowStart = toSVG(windowCenter2D.clone().sub(wallDir.clone().multiplyScalar(halfWidth)))
    const windowEnd = toSVG(windowCenter2D.clone().add(wallDir.clone().multiplyScalar(halfWidth)))

    // Standard architectural window symbol: parallel lines
    const offsetAmount = 3 // pixels
    const perpX = -wallNormal.y * offsetAmount
    const perpY = wallNormal.x * offsetAmount

    let result = ''
    // Main window line
    result += `    <line x1="${windowStart.x.toFixed(2)}" y1="${windowStart.y.toFixed(2)}" x2="${windowEnd.x.toFixed(2)}" y2="${windowEnd.y.toFixed(2)}" stroke="${color}" stroke-width="${lineWidth * 2}"/>\n`
    // Parallel lines for glass representation
    result += `    <line x1="${(windowStart.x + perpX).toFixed(2)}" y1="${(windowStart.y + perpY).toFixed(2)}" x2="${(windowEnd.x + perpX).toFixed(2)}" y2="${(windowEnd.y + perpY).toFixed(2)}" stroke="${color}" stroke-width="${lineWidth * 0.5}"/>\n`
    result += `    <line x1="${(windowStart.x - perpX).toFixed(2)}" y1="${(windowStart.y - perpY).toFixed(2)}" x2="${(windowEnd.x - perpX).toFixed(2)}" y2="${(windowEnd.y - perpY).toFixed(2)}" stroke="${color}" stroke-width="${lineWidth * 0.5}"/>\n`

    return result
}

/**
 * Find the nearest wall edge to a point
 */
function findNearestWallEdge(point: THREE.Vector2, polygon: THREE.Vector2[]): {
    wallStart: THREE.Vector2 | null
    wallEnd: THREE.Vector2 | null
    wallNormal: THREE.Vector2
    distance: number
} {
    let minDist = Infinity
    let nearestStart: THREE.Vector2 | null = null
    let nearestEnd: THREE.Vector2 | null = null
    let nearestNormal = new THREE.Vector2(0, 1)

    for (let i = 0; i < polygon.length; i++) {
        const start = polygon[i]
        const end = polygon[(i + 1) % polygon.length]

        // Distance from point to line segment
        const dist = distanceToLineSegment(point, start, end)

        if (dist < minDist) {
            minDist = dist
            nearestStart = start
            nearestEnd = end

            // Calculate wall normal (perpendicular, pointing inward)
            const wallDir = end.clone().sub(start).normalize()
            nearestNormal = new THREE.Vector2(-wallDir.y, wallDir.x)

            // Ensure normal points inward (toward polygon center)
            const polygonCenter = calculatePolygonCenter(polygon)
            const toCenter = polygonCenter.clone().sub(point)
            if (nearestNormal.dot(toCenter) < 0) {
                nearestNormal.negate()
            }
        }
    }

    return {
        wallStart: nearestStart,
        wallEnd: nearestEnd,
        wallNormal: nearestNormal,
        distance: minDist
    }
}

/**
 * Calculate distance from point to line segment
 */
function distanceToLineSegment(point: THREE.Vector2, start: THREE.Vector2, end: THREE.Vector2): number {
    const l2 = start.distanceToSquared(end)
    if (l2 === 0) return point.distanceTo(start)

    const t = Math.max(0, Math.min(1, point.clone().sub(start).dot(end.clone().sub(start)) / l2))
    const projection = start.clone().add(end.clone().sub(start).multiplyScalar(t))
    return point.distanceTo(projection)
}

/**
 * Calculate center of polygon
 */
function calculatePolygonCenter(polygon: THREE.Vector2[]): THREE.Vector2 {
    const center = new THREE.Vector2(0, 0)
    for (const p of polygon) {
        center.add(p)
    }
    center.divideScalar(polygon.length)
    return center
}

/**
 * Render dimension lines
 */
function renderDimensions(
    bounds: Bounds2D,
    toSVG: (p: THREE.Vector2) => { x: number; y: number },
    scale: number,
    color: string,
    fontSize: number,
    fontFamily: string,
    viewHeight: number
): string {
    const dimOffset = 20 // pixels offset from shape
    const tickSize = 6

    let result = `  <g id="dimensions" font-family="${fontFamily}" font-size="${fontSize - 2}" fill="${color}">\n`

    // Width dimension (bottom)
    const bottomLeft = toSVG(new THREE.Vector2(bounds.minX, bounds.minY))
    const bottomRight = toSVG(new THREE.Vector2(bounds.maxX, bounds.minY))
    const widthY = Math.min(bottomLeft.y, bottomRight.y) + dimOffset

    // Dimension line
    result += `    <line x1="${bottomLeft.x.toFixed(2)}" y1="${widthY.toFixed(2)}" x2="${bottomRight.x.toFixed(2)}" y2="${widthY.toFixed(2)}" stroke="${color}" stroke-width="1"/>\n`
    // Ticks
    result += `    <line x1="${bottomLeft.x.toFixed(2)}" y1="${(widthY - tickSize).toFixed(2)}" x2="${bottomLeft.x.toFixed(2)}" y2="${(widthY + tickSize).toFixed(2)}" stroke="${color}" stroke-width="1"/>\n`
    result += `    <line x1="${bottomRight.x.toFixed(2)}" y1="${(widthY - tickSize).toFixed(2)}" x2="${bottomRight.x.toFixed(2)}" y2="${(widthY + tickSize).toFixed(2)}" stroke="${color}" stroke-width="1"/>\n`
    // Label
    const widthLabel = bounds.width.toFixed(2) + ' m'
    result += `    <text x="${((bottomLeft.x + bottomRight.x) / 2).toFixed(2)}" y="${(widthY + fontSize).toFixed(2)}" text-anchor="middle">${widthLabel}</text>\n`

    // Height dimension (right)
    const topRight = toSVG(new THREE.Vector2(bounds.maxX, bounds.maxY))
    const dimX = Math.max(bottomRight.x, topRight.x) + dimOffset

    // Dimension line
    result += `    <line x1="${dimX.toFixed(2)}" y1="${bottomRight.y.toFixed(2)}" x2="${dimX.toFixed(2)}" y2="${topRight.y.toFixed(2)}" stroke="${color}" stroke-width="1"/>\n`
    // Ticks
    result += `    <line x1="${(dimX - tickSize).toFixed(2)}" y1="${bottomRight.y.toFixed(2)}" x2="${(dimX + tickSize).toFixed(2)}" y2="${bottomRight.y.toFixed(2)}" stroke="${color}" stroke-width="1"/>\n`
    result += `    <line x1="${(dimX - tickSize).toFixed(2)}" y1="${topRight.y.toFixed(2)}" x2="${(dimX + tickSize).toFixed(2)}" y2="${topRight.y.toFixed(2)}" stroke="${color}" stroke-width="1"/>\n`
    // Label (rotated)
    const heightLabel = bounds.height.toFixed(2) + ' m'
    const heightLabelY = (bottomRight.y + topRight.y) / 2
    result += `    <text x="${(dimX + fontSize).toFixed(2)}" y="${heightLabelY.toFixed(2)}" text-anchor="middle" transform="rotate(90, ${(dimX + fontSize).toFixed(2)}, ${heightLabelY.toFixed(2)})">${heightLabel}</text>\n`

    result += `  </g>\n`
    return result
}

/**
 * Calculate bounds of a 2D polygon
 */
function calculatePolygonBounds(polygon: THREE.Vector2[]): Bounds2D {
    let minX = Infinity, maxX = -Infinity
    let minY = Infinity, maxY = -Infinity

    for (const p of polygon) {
        minX = Math.min(minX, p.x)
        maxX = Math.max(maxX, p.x)
        minY = Math.min(minY, p.y)
        maxY = Math.max(maxY, p.y)
    }

    return {
        minX, maxX, minY, maxY,
        width: maxX - minX,
        height: maxY - minY,
    }
}

/**
 * Escape XML special characters
 */
function escapeXml(str: string): string {
    return str.replace(/[<>&'"]/g, c => ({
        '<': '&lt;',
        '>': '&gt;',
        '&': '&amp;',
        "'": '&apos;',
        '"': '&quot;'
    }[c] || c))
}

/**
 * Create error SVG placeholder
 */
function createErrorSVG(width: number, height: number, message: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="100%" height="100%" fill="#fee"/>
  <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" fill="#c00" font-family="Arial">${escapeXml(message)}</text>
</svg>`
}

/**
 * Render space views (currently just floor plan)
 */
export async function renderSpaceViews(
    context: SpaceContext,
    options: SpaceSVGRenderOptions = {}
): Promise<{ floorPlan: string }> {
    const floorPlan = renderSpaceFloorPlan(context, options)
    return { floorPlan }
}
