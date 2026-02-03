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

// Distinct, non-realistic color palette for different IFC types
const TYPE_COLOR_PALETTE = [
    { fill: '#e91e63', stroke: '#ad1457' }, // Pink
    { fill: '#9c27b0', stroke: '#6a1b9a' }, // Purple
    { fill: '#673ab7', stroke: '#4527a0' }, // Deep Purple
    { fill: '#3f51b5', stroke: '#283593' }, // Indigo
    { fill: '#2196f3', stroke: '#1565c0' }, // Blue
    { fill: '#00bcd4', stroke: '#00838f' }, // Cyan
    { fill: '#009688', stroke: '#00695c' }, // Teal
    { fill: '#4caf50', stroke: '#2e7d32' }, // Green
    { fill: '#8bc34a', stroke: '#558b2f' }, // Light Green
    { fill: '#cddc39', stroke: '#9e9d24' }, // Lime
    { fill: '#ffeb3b', stroke: '#f9a825' }, // Yellow
    { fill: '#ff9800', stroke: '#ef6c00' }, // Orange
    { fill: '#ff5722', stroke: '#d84315' }, // Deep Orange
    { fill: '#607d8b', stroke: '#37474f' }, // Blue Grey
]

// Global color map for consistent colors across spaces
const typeColorMap = new Map<string, { fill: string; stroke: string }>()
let colorIndex = 0

/**
 * Get a distinct color for an IFC type
 */
function getTypeColor(typeName: string): { fill: string; stroke: string } {
    if (!typeColorMap.has(typeName)) {
        typeColorMap.set(typeName, TYPE_COLOR_PALETTE[colorIndex % TYPE_COLOR_PALETTE.length])
        colorIndex++
    }
    return typeColorMap.get(typeName)!
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
 * Render a floor plan SVG for a single space with all interior elements
 * This is the new version that matches the test script output exactly
 */
export function renderSpaceFloorPlan(
    context: SpaceContext,
    options: SpaceSVGRenderOptions = {},
    elementsInSpace?: Map<string, ElementInfo[]>,
    lengthUnitScale: number = 1
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
        backgroundColor,
        fontSize,
        fontFamily,
    } = opts

    // Get profile polygon (required)
    const profilePoints = context.floorPolygon
    if (!profilePoints || profilePoints.length < 3) {
        return createErrorSVG(width, height, 'No valid profile polygon')
    }

    // Get bounding box for reference (optional)
    const bbox = context.space.boundingBox
    const bbox2D = context.space.boundingBox2D

    // Calculate bounds from ONLY profile points (room extent only, not elements)
    let minX = Infinity, maxX = -Infinity
    let minY = Infinity, maxY = -Infinity

    for (const point of profilePoints) {
        minX = Math.min(minX, point.x)
        maxX = Math.max(maxX, point.x)
        minY = Math.min(minY, point.y)
        maxY = Math.max(maxY, point.y)
    }

    // Debug: Log profile bounds vs bbox2D to identify coordinate issues
    const profileWidth = maxX - minX
    const profileHeight = maxY - minY
    if (bbox2D) {
        console.log(`[renderSpaceFloorPlan] Space ${context.spaceId}:`)
        console.log(`  Profile bounds: X[${minX.toFixed(2)}, ${maxX.toFixed(2)}] Y[${minY.toFixed(2)}, ${maxY.toFixed(2)}]`)
        console.log(`  Profile dimensions: ${profileWidth.toFixed(2)} × ${profileHeight.toFixed(2)}`)
        console.log(`  BBox2D dimensions: ${bbox2D.width.toFixed(2)} × ${bbox2D.depth.toFixed(2)}`)
        console.log(`  BBox2D bounds: X[${bbox2D.min.x.toFixed(2)}, ${bbox2D.max.x.toFixed(2)}] Y[${bbox2D.min.y.toFixed(2)}, ${bbox2D.max.y.toFixed(2)}]`)
        if (Math.abs(profileWidth - bbox2D.width) > 0.1 || Math.abs(profileHeight - bbox2D.depth) > 0.1) {
            console.warn(`  WARNING: Profile dimensions don't match bbox2D! This may cause distortion.`)
        }
    }

    // Add small padding around profile (5% of dimensions)
    const padX = (maxX - minX) * 0.05
    const padY = (maxY - minY) * 0.05
    minX -= padX
    maxX += padX
    minY -= padY
    maxY += padY

    const worldWidth = maxX - minX
    const worldHeight = maxY - minY
    const scale = Math.min(
        (width - margin * 2) / worldWidth,
        (height - margin * 2) / worldHeight
    ) * 0.9

    const offsetX = (width - worldWidth * scale) / 2
    const offsetY = (height - worldHeight * scale) / 2

    const toSVG = (p: THREE.Vector2): { x: number; y: number } => ({
        x: (p.x - minX) * scale + offsetX,
        y: height - ((p.y - minY) * scale + offsetY), // Flip Y
    })

    // Build profile path for clipPath
    const clipProfilePath = profilePoints.map((p, i) => {
        const svgP = toSVG(p)
        return i === 0 ? `M ${svgP.x.toFixed(2)} ${svgP.y.toFixed(2)}` : `L ${svgP.x.toFixed(2)} ${svgP.y.toFixed(2)}`
    }).join(' ') + ' Z'

    // Build SVG with clipPath to cut elements at room boundary
    let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <style>
      .bbox { fill: none; stroke: #ff0000; stroke-width: 2; stroke-dasharray: 8,4; opacity: 0.7; }
      .profile { fill: #e3f2fd; stroke: #1976d2; stroke-width: 3; }
      .label { font-family: ${fontFamily}; font-size: ${fontSize}px; fill: #333; }
    </style>
    <clipPath id="roomClip">
      <path d="${clipProfilePath}"/>
    </clipPath>
  </defs>
  <rect width="100%" height="100%" fill="${backgroundColor}"/>
  
  <!-- Bounding box (dashed red) -->
`

    if (bbox2D) {
        const bboxPoints = [
            new THREE.Vector2(bbox2D.min.x, bbox2D.min.y),
            new THREE.Vector2(bbox2D.max.x, bbox2D.min.y),
            new THREE.Vector2(bbox2D.max.x, bbox2D.max.y),
            new THREE.Vector2(bbox2D.min.x, bbox2D.max.y),
        ]
        const bboxPath = bboxPoints.map((p, i) => {
            const svgP = toSVG(p)
            return i === 0 ? `M ${svgP.x.toFixed(2)} ${svgP.y.toFixed(2)}` : `L ${svgP.x.toFixed(2)} ${svgP.y.toFixed(2)}`
        }).join(' ') + ' Z'
        svg += `  <path d="${bboxPath}" class="bbox"/>\n`
    }

    // Profile outline (solid blue)
    const profilePath = profilePoints.map((p, i) => {
        const svgP = toSVG(p)
        return i === 0 ? `M ${svgP.x.toFixed(2)} ${svgP.y.toFixed(2)}` : `L ${svgP.x.toFixed(2)} ${svgP.y.toFixed(2)}`
    }).join(' ') + ' Z'
    svg += `  <path d="${profilePath}" class="profile"/>\n`

    // Render interior elements - clipped to room boundary
    // Wrap in group with clipPath to cut elements at room outline
    svg += `  <g clip-path="url(#roomClip)">\n`

    if (elementsInSpace && elementsInSpace instanceof Map) {
        // Sort types by count (render most common first, they'll be in the background)
        const sortedTypes = Array.from(elementsInSpace.entries())
            .filter(([, elems]) => elems.length > 0)
            .sort((a, b) => b[1].length - a[1].length)

        for (const [typeName, typeElements] of sortedTypes) {
            const color = getTypeColor(typeName)

            // Slabs and coverings should be outline only (no fill)
            const isSlabType = typeName.toUpperCase().includes('SLAB') ||
                typeName.toUpperCase().includes('FLOOR') ||
                typeName.toUpperCase().includes('ROOF') ||
                typeName.toUpperCase().includes('COVERING')

            // Filter and limit elements
            const elementsToRender = typeElements
                .filter(elem => {
                    if (!elem.boundingBox) return false
                    const bbox = elem.boundingBox
                    const size = new THREE.Vector3()
                    bbox.getSize(size)
                    const w = Math.abs(size.x)
                    const h = Math.abs(size.y)
                    const area = w * h
                    return area > 0.3 // Minimum area threshold
                })
                .slice(0, 100) // Limit per type to keep SVG manageable

            for (const elem of elementsToRender) {
                if (elem.boundingBox) {
                    const bbox = elem.boundingBox
                    const size = new THREE.Vector3()
                    bbox.getSize(size)

                    // Extract 2D bounds from the 3D bbox and scale to match profile coordinates
                    // Profile coordinates are in IFC native units (e.g., mm), element bboxes are in meters
                    // Scale element bboxes by lengthUnitScale to match profile units
                    const ySize = Math.abs(size.y)
                    const zSize = Math.abs(size.z)
                    const isYUp = ySize < zSize // Y-up if Y range is smaller than Z range
                    const min2D = isYUp
                        ? new THREE.Vector2(bbox.min.x * lengthUnitScale, bbox.min.z * lengthUnitScale)
                        : new THREE.Vector2(bbox.min.x * lengthUnitScale, bbox.min.y * lengthUnitScale)
                    const max2D = isYUp
                        ? new THREE.Vector2(bbox.max.x * lengthUnitScale, bbox.max.z * lengthUnitScale)
                        : new THREE.Vector2(bbox.max.x * lengthUnitScale, bbox.max.y * lengthUnitScale)

                    const minP = toSVG(min2D)
                    const maxP = toSVG(max2D)
                    const w = Math.abs(maxP.x - minP.x)
                    const h = Math.abs(maxP.y - minP.y)
                    if (w > 1 && h > 1) {
                        if (isSlabType) {
                            // Slabs: outline only, no fill
                            svg += `    <rect x="${Math.min(minP.x, maxP.x).toFixed(2)}" y="${Math.min(minP.y, maxP.y).toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" fill="none" stroke="${color.stroke}" stroke-width="2" stroke-dasharray="4,2" opacity="0.8"/>\n`
                        } else {
                            // Other elements: filled
                            svg += `    <rect x="${Math.min(minP.x, maxP.x).toFixed(2)}" y="${Math.min(minP.y, maxP.y).toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" fill="${color.fill}" stroke="${color.stroke}" stroke-width="1" opacity="0.7"/>\n`
                        }
                    }
                }
            }
        }
    }

    svg += `  </g>\n`

    // Labels - Use room number format like test script: space-{expressID}-{name}
    const roomNumber = `space-${context.space.expressID}-${context.spaceName.replace(/[^a-zA-Z0-9]/g, '_')}`
    svg += `  <text x="${width / 2}" y="30" text-anchor="middle" class="label" font-weight="bold">${escapeXml(roomNumber)}</text>\n`

    // Use real profile dimensions converted to meters
    const dimWidth = profileWidth / lengthUnitScale
    const dimHeight = profileHeight / lengthUnitScale
    svg += `  <text x="${width / 2}" y="55" text-anchor="middle" class="label" font-size="14">Dimensions: ${dimWidth.toFixed(2)} × ${dimHeight.toFixed(2)} m</text>\n`

    // Compact horizontal legend at bottom with fixed spacing
    const legendY = height - 25
    let legendX = 20
    const legendFontSize = 10
    const charWidth = 7  // More accurate for sans-serif
    const iconWidth = 14
    const iconTextGap = 8
    const itemGap = 20

    // Outline legend items
    svg += `  <rect x="${legendX}" y="${legendY - 8}" width="${iconWidth}" height="8" fill="#e3f2fd" stroke="#1976d2" stroke-width="1"/>\n`
    svg += `  <text x="${legendX + iconWidth + iconTextGap}" y="${legendY}" class="label" font-size="${legendFontSize}" fill="#333">Room</text>\n`
    legendX += iconWidth + iconTextGap + (4 * charWidth) + itemGap // "Room" = 4 chars

    if (bbox2D) {
        svg += `  <rect x="${legendX}" y="${legendY - 8}" width="${iconWidth}" height="8" fill="none" stroke="#ff0000" stroke-width="1" stroke-dasharray="3,1"/>\n`
        svg += `  <text x="${legendX + iconWidth + iconTextGap}" y="${legendY}" class="label" font-size="${legendFontSize}" fill="#333">BBox</text>\n`
        legendX += iconWidth + iconTextGap + (4 * charWidth) + itemGap // "BBox" = 4 chars
    }

    // Dynamic legend for element types - horizontal, compact
    if (elementsInSpace && elementsInSpace instanceof Map) {
        const maxLegendItems = 6 // Limit legend items
        let itemCount = 0

        // Sort by count and show most common types
        const sortedTypes = Array.from(elementsInSpace.entries())
            .filter(([, elems]) => elems.length > 0)
            .sort((a, b) => b[1].length - a[1].length)

        for (const [typeName, typeElements] of sortedTypes) {
            if (itemCount >= maxLegendItems) break

            const color = getTypeColor(typeName)
            const count = typeElements.filter(e => {
                if (!e.boundingBox) return false
                const bbox = e.boundingBox
                const size = new THREE.Vector3()
                bbox.getSize(size)
                const w = Math.abs(size.x)
                const h = Math.abs(size.y)
                return w * h > 0.3
            }).length

            if (count > 0) {
                // Shorten type names
                const shortName = typeName.replace('StandardCase', '').replace('Element', '')
                const labelText = `${shortName}(${count})`
                const textWidth = labelText.length * charWidth

                // Check if this item fits
                if (legendX + iconWidth + iconTextGap + textWidth > width - 20) break

                // Check if this is a slab/covering type (outline only)
                const isOutlineType = typeName.toUpperCase().includes('SLAB') ||
                    typeName.toUpperCase().includes('FLOOR') ||
                    typeName.toUpperCase().includes('COVERING')
                if (isOutlineType) {
                    svg += `  <rect x="${legendX}" y="${legendY - 8}" width="${iconWidth}" height="8" fill="none" stroke="${color.stroke}" stroke-width="1" stroke-dasharray="2,1"/>\n`
                } else {
                    svg += `  <rect x="${legendX}" y="${legendY - 8}" width="${iconWidth}" height="8" fill="${color.fill}" stroke="${color.stroke}" stroke-width="0.5"/>\n`
                }
                svg += `  <text x="${legendX + iconWidth + iconTextGap}" y="${legendY}" class="label" font-size="9" fill="#333">${escapeXml(labelText)}</text>\n`
                legendX += iconWidth + iconTextGap + textWidth + itemGap
                itemCount++
            }
        }
    }

    svg += `</svg>`
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
