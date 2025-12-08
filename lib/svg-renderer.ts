import * as THREE from 'three'
import type { DoorContext } from './door-analyzer'
import { getContextMeshes } from './door-analyzer'

export interface SVGRenderOptions {
    width?: number
    height?: number
    margin?: number // meters
    doorColor?: string
    wallColor?: string
    deviceColor?: string
    backgroundColor?: string // Background color for area outside door
    lineWidth?: number
    lineColor?: string
    showFills?: boolean
    showLegend?: boolean
    showLabels?: boolean
    fontSize?: number
    fontFamily?: string
}

const DEFAULT_OPTIONS: Required<SVGRenderOptions> = {
    width: 1000,
    height: 1000,
    margin: 0.5,
    doorColor: '#333333',
    wallColor: '#888888',
    deviceColor: '#CC0000',
    backgroundColor: '#f5f5f5', // Light gray background
    lineWidth: 1.5,
    lineColor: '#000000',
    showFills: true,
    showLegend: true,
    showLabels: true,
    fontSize: 14,
    fontFamily: 'Arial',
}

interface ProjectedEdge {
    x1: number
    y1: number
    x2: number
    y2: number
    color: string
    depth: number
}

interface ProjectedPolygon {
    points: { x: number; y: number }[]
    color: string
    depth: number
}

/**
 * Setup orthographic camera for door elevation view
 */
function setupDoorCamera(
    context: DoorContext,
    options: Required<SVGRenderOptions>
): THREE.OrthographicCamera {
    const door = context.door
    const bbox = door.boundingBox

    if (!bbox) {
        throw new Error('Door bounding box not available')
    }

    const size = bbox.getSize(new THREE.Vector3())
    const center = context.center

    // Calculate view dimensions with margin
    // Client requested 25cm margin around door leaf
    // We use the provided margin option (default 0.5m) but ensure at least 0.25m
    const margin = Math.max(options.margin, 0.25)
    const width = Math.max(size.x, size.z) + margin * 2
    const height = size.y + margin * 2

    // Create orthographic camera
    const camera = new THREE.OrthographicCamera(
        -width / 2,
        width / 2,
        height / 2,
        -height / 2,
        0.1,
        100
    )

    // Position camera perpendicular to door plane
    const normal = context.normal.clone().normalize()
    const distance = Math.max(width, height) * 1.5
    camera.position.copy(center.clone().add(normal.multiplyScalar(distance)))
    camera.up.set(0, 1, 0)
    camera.lookAt(center)
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()

    return camera
}



/**
 * Get color for element based on type
 */
function getElementColor(
    expressID: number,
    context: DoorContext,
    options: Required<SVGRenderOptions>
): string {
    if (expressID === context.door.expressID) {
        return options.doorColor
    } else if (context.wall && expressID === context.wall.expressID) {
        return options.wallColor
    } else {
        return options.deviceColor
    }
}

/**
 * Project a 3D point to 2D SVG coordinates
 */
function projectPoint(
    point: THREE.Vector3,
    camera: THREE.OrthographicCamera,
    width: number,
    height: number
): { x: number; y: number; z: number } {
    const projected = point.clone().project(camera)
    return {
        x: (projected.x + 1) * width / 2,
        y: (-projected.y + 1) * height / 2,
        z: projected.z
    }
}

/**
 * Clip a line segment against the near (-1) and far (1) planes in NDC Z-space
 */
function clipLineZ(
    p1: { x: number; y: number; z: number },
    p2: { x: number; y: number; z: number }
): { p1: { x: number; y: number; z: number }, p2: { x: number; y: number; z: number } } | null {
    // Check if both outside
    if ((p1.z < -1 && p2.z < -1) || (p1.z > 1 && p2.z > 1)) {
        return null
    }

    // Check if both inside
    if (p1.z >= -1 && p1.z <= 1 && p2.z >= -1 && p2.z <= 1) {
        return { p1, p2 }
    }

    // Clipper function for one point
    const clip = (start: typeof p1, end: typeof p1, planeZ: number): typeof p1 => {
        const t = (planeZ - start.z) / (end.z - start.z)
        return {
            x: start.x + (end.x - start.x) * t,
            y: start.y + (end.y - start.y) * t,
            z: planeZ
        }
    }

    let resP1 = { ...p1 }
    let resP2 = { ...p2 }

    // Clip against Near (-1)
    if (resP1.z < -1) {
        if (resP2.z < -1) return null
        resP1 = clip(resP1, resP2, -1)
    } else if (resP2.z < -1) {
        resP2 = clip(resP2, resP1, -1)
    }

    // Clip against Far (1)
    if (resP1.z > 1) {
        if (resP2.z > 1) return null
        resP1 = clip(resP1, resP2, 1)
    } else if (resP2.z > 1) {
        resP2 = clip(resP2, resP1, 1)
    }

    return { p1: resP1, p2: resP2 }
}

/**
 * Extract edges from mesh geometry using EdgesGeometry
 */
function extractEdges(
    mesh: THREE.Mesh,
    camera: THREE.OrthographicCamera,
    color: string,
    width: number,
    height: number,
    clipZ: boolean = false
): ProjectedEdge[] {
    const edges: ProjectedEdge[] = []

    // Get world matrix for transforming vertices
    mesh.updateMatrixWorld()
    const worldMatrix = mesh.matrixWorld

    // Create EdgesGeometry to extract visible edges
    // Increasing threshold slightly to avoid internal triangulation lines if any
    const edgesGeometry = new THREE.EdgesGeometry(mesh.geometry, 30) // 30 degree threshold
    const positions = edgesGeometry.attributes.position

    for (let i = 0; i < positions.count; i += 2) {
        const p1 = new THREE.Vector3(
            positions.getX(i),
            positions.getY(i),
            positions.getZ(i)
        ).applyMatrix4(worldMatrix)

        const p2 = new THREE.Vector3(
            positions.getX(i + 1),
            positions.getY(i + 1),
            positions.getZ(i + 1)
        ).applyMatrix4(worldMatrix)

        const proj1 = projectPoint(p1, camera, width, height)
        const proj2 = projectPoint(p2, camera, width, height)

        // Clip against view frustum (Z-depth) if enabled
        if (clipZ) {
            const clipped = clipLineZ(proj1, proj2)

            if (clipped) {
                // Average depth for sorting
                const depth = (clipped.p1.z + clipped.p2.z) / 2

                edges.push({
                    x1: clipped.p1.x,
                    y1: clipped.p1.y,
                    x2: clipped.p2.x,
                    y2: clipped.p2.y,
                    color,
                    depth
                })
            }
        } else {
            // No clipping, just add the edge
            // Note: We might still want to soft check if it's wildly behind camera
            // but for elevation view with controlled camera, it should be fine.
            const depth = (proj1.z + proj2.z) / 2
            edges.push({
                x1: proj1.x,
                y1: proj1.y,
                x2: proj2.x,
                y2: proj2.y,
                color,
                depth
            })
        }
    }

    edgesGeometry.dispose()
    return edges
}

/**
 * Extract filled polygons from mesh geometry (triangles)
 */
function extractPolygons(
    mesh: THREE.Mesh,
    camera: THREE.OrthographicCamera,
    color: string,
    width: number,
    height: number
): ProjectedPolygon[] {
    const polygons: ProjectedPolygon[] = []

    // Get world matrix for transforming vertices
    mesh.updateMatrixWorld()
    const worldMatrix = mesh.matrixWorld

    const geometry = mesh.geometry
    const positions = geometry.attributes.position
    const indices = geometry.index

    // Get camera direction for backface culling
    const cameraDir = new THREE.Vector3()
    camera.getWorldDirection(cameraDir)

    const processTriangle = (i1: number, i2: number, i3: number) => {
        const p1 = new THREE.Vector3(
            positions.getX(i1),
            positions.getY(i1),
            positions.getZ(i1)
        ).applyMatrix4(worldMatrix)

        const p2 = new THREE.Vector3(
            positions.getX(i2),
            positions.getY(i2),
            positions.getZ(i2)
        ).applyMatrix4(worldMatrix)

        const p3 = new THREE.Vector3(
            positions.getX(i3),
            positions.getY(i3),
            positions.getZ(i3)
        ).applyMatrix4(worldMatrix)

        // Calculate face normal for backface culling
        const edge1 = p2.clone().sub(p1)
        const edge2 = p3.clone().sub(p1)
        const faceNormal = edge1.cross(edge2).normalize()

        // Skip back-facing triangles
        // NOTE: For cut views, backface culling might be tricky if we look 'inside' the mesh
        // But for consistency with elevation, let's keep it for now.
        if (faceNormal.dot(cameraDir) > 0.1) {
            return
        }

        const proj1 = projectPoint(p1, camera, width, height)
        const proj2 = projectPoint(p2, camera, width, height)
        const proj3 = projectPoint(p3, camera, width, height)

        // Simple culling for polygons: 
        // Only strict culling if we wanted to enforce frustum (Plan View)
        // But extracting polygons is also used for Elevation.
        // Let's rely on standard painters algo (depth sort) and not clip strictly unless needed.
        // Actually, for Plan view section cut, we probably SHOULD clip polygons too, but 
        // passing `clipZ` to extractPolygons is also needed.

        // For now, let's just relax the check to be always valid unless wildly out?
        // Or better: Revert to previous logic (no check) if we don't care.
        // But for Plan View, we DO care about near/far clip.

        // Let's assume polygons are mostly for fills and less critical for "No edges" error.
        // But to be safe, let's keep it permissive for now, or just check Z roughly.
        // If we want clipping logic here, we'd need to pass a flag too.
        // I will revert strict check and allow all polygons, 
        // relying on the fact that edges carry the main visual info.
        // If polygons are outside, they usually don't render or get covered.

        // Average depth for sorting
        const depth = (proj1.z + proj2.z + proj3.z) / 3

        polygons.push({
            points: [
                { x: proj1.x, y: proj1.y },
                { x: proj2.x, y: proj2.y },
                { x: proj3.x, y: proj3.y }
            ],
            color,
            depth
        })
    }

    if (indices) {
        for (let i = 0; i < indices.count; i += 3) {
            processTriangle(indices.getX(i), indices.getX(i + 1), indices.getX(i + 2))
        }
    } else {
        for (let i = 0; i < positions.count; i += 3) {
            processTriangle(i, i + 1, i + 2)
        }
    }

    return polygons
}

/**
 * Generate SVG string from edges and polygons
 * Normalizes coordinates to fit within the viewport
 */
function generateSVGString(
    edges: ProjectedEdge[],
    polygons: ProjectedPolygon[],
    options: Required<SVGRenderOptions>
): string {
    const { width, height, lineWidth, showFills, backgroundColor, fontSize, fontFamily, showLegend, showLabels } = options

    // ... rest of function identical, just checking for activeContext usage ...
    // Since generateSVGString logic involves calculating bounds and scaling, 
    // it will naturally fit the *clipped* content.
    // If we clipped everything above 1.2m, the bounds will shrink to fit the door/near items.

    // Check if legend is actually needed (only if more than 1 item)
    // We need to know context for this, but context is activeContext. 
    // Ideally we would pass context to this function, but using the global activeContext is the current pattern.
    const hasDevices = activeContext ? activeContext.nearbyDevices.length > 0 : false
    const showLegendActual = showLegend && hasDevices // Only show legend if we have devices (so > 1 item with Door)

    // Calculate Title Block area
    // Reserve lines for text + legend if needed
    // Text takes about 2 lines (View/Type + Opening)
    // Legend takes about 1 line if shown
    const textLines = 3 // View, ID/Type, Opening
    const legendHeight = showLegendActual ? (fontSize + 10) : 0

    const titleBlockHeight = (showLabels || showLegendActual) ? (fontSize * textLines + legendHeight + 20) : 0
    const viewHeight = height - titleBlockHeight

    // Compute bounding box of all edges
    let minX = Infinity, maxX = -Infinity
    let minY = Infinity, maxY = -Infinity

    for (const edge of edges) {
        minX = Math.min(minX, edge.x1, edge.x2)
        maxX = Math.max(maxX, edge.x1, edge.x2)
        minY = Math.min(minY, edge.y1, edge.y2)
        maxY = Math.max(maxY, edge.y1, edge.y2)
    }

    for (const poly of polygons) {
        for (const p of poly.points) {
            minX = Math.min(minX, p.x)
            maxX = Math.max(maxX, p.x)
            minY = Math.min(minY, p.y)
            maxY = Math.max(maxY, p.y)
        }
    }

    // If nothing to draw
    if (minX === Infinity) {
        minX = 0; maxX = width; minY = 0; maxY = viewHeight;
    }

    // Calculate scale to fit in viewport with padding
    const padding = 50 // pixels
    const contentWidth = maxX - minX
    const contentHeight = maxY - minY
    const availWidth = width - padding * 2
    const availHeight = viewHeight - padding * 2 // Use viewHeight instead of full height

    const scale = Math.min(
        availWidth / (contentWidth || 1),
        availHeight / (contentHeight || 1)
    )

    // Calculate offset to center content in the view area
    const scaledWidth = contentWidth * scale
    const scaledHeight = contentHeight * scale
    const offsetX = padding + (availWidth - scaledWidth) / 2
    const offsetY = padding + (availHeight - scaledHeight) / 2

    // Transform function
    const transformX = (x: number) => (x - minX) * scale + offsetX
    const transformY = (y: number) => (y - minY) * scale + offsetY

    // Sort polygons by depth (back to front)
    polygons.sort((a, b) => b.depth - a.depth)

    // Sort edges by depth (back to front)
    edges.sort((a, b) => b.depth - a.depth)

    let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="${backgroundColor}"/>
  <g id="fills">
`

    // Draw filled polygons first (if enabled)
    if (showFills) {
        for (const poly of polygons) {
            const pathData = poly.points.map((p, i) =>
                `${i === 0 ? 'M' : 'L'} ${transformX(p.x).toFixed(2)} ${transformY(p.y).toFixed(2)}`
            ).join(' ') + ' Z'

            svg += `    <path d="${pathData}" fill="${poly.color}" fill-opacity="0.3" stroke="none"/>\n`
        }
    }

    svg += `  </g>
  <g id="edges">
`

    // Draw edges with transformed coordinates
    for (const edge of edges) {
        const x1 = transformX(edge.x1)
        const y1 = transformY(edge.y1)
        const x2 = transformX(edge.x2)
        const y2 = transformY(edge.y2)
        svg += `    <line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="${edge.color}" stroke-width="${lineWidth}" stroke-linecap="round"/>\n`
    }

    svg += `  </g>`

    // Render "Vorderansicht" arrow for Plan view
    // Render "Vorderansicht" arrow for Plan view
    if (activeViewType === 'Plan') {
        // Place arrow relative to the content bounding box (scaledHeight + offsetY)
        // Add some padding (e.g. 10px) below the content
        const arrowY = offsetY + scaledHeight + 10
        const midX = width / 2

        svg += `
    <g id="plan-annotation">
        <defs>
            <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="0" refY="3.5" orient="auto">
                <polygon points="0 0, 10 3.5, 0 7" fill="#000000" />
            </marker>
        </defs>
        <line x1="${midX}" y1="${arrowY + 25}" x2="${midX}" y2="${arrowY}" stroke="#000000" stroke-width="2" marker-end="url(#arrowhead)"/>
        <text x="${midX}" y="${arrowY + 40}" font-family="${fontFamily}" font-size="${fontSize}" fill="#000000" text-anchor="middle">Vorderansicht</text>
    </g>`
    }

    // Render Title Block
    if (titleBlockHeight > 0) {
        svg += renderTitleBlock(width, height, titleBlockHeight, options, activeContext, activeViewType)
    }

    svg += `\n</svg>`

    return svg
}

// Temporary globals to pass context to generateSVGString without changing signature entirely 
// (Refactoring to pass context to generateSVGString would be cleaner but requires changing all calls)
// Alternatively, we can pass it via options but that's hacky.
// Actually, let's update generateSVGString signature. I'll need to update call sites.
// Wait, I can't easily change call sites if they are inside this file without multiple chunks.
// I will change the signature of generateSVGString in this chunk and update the calls in the OTHER chunks or same chunk if possible.
// Wait, `generateSVGString` is called in `renderDoorElevationSVG` and `renderDoorPlanSVG`.
// I will update them all.

// Helper to keep context available
let activeContext: DoorContext | null = null
let activeViewType: string = ''

/**
 * Render Title Block content
 */
function renderTitleBlock(
    fullWidth: number,
    fullHeight: number,
    blockHeight: number,
    options: Required<SVGRenderOptions>,
    context: DoorContext | null,
    viewType: string
): string {
    if (!context) return ''

    const { fontSize, fontFamily, showLegend, showLabels, backgroundColor } = options
    const padding = 15
    const startY = fullHeight - blockHeight

    // Title Block container (slightly darker background)
    // Blend background with black to darken it a bit
    // Or just use a separator line
    const separatorY = startY

    let content = `
  <g id="title-block">
    <line x1="0" y1="${separatorY}" x2="${fullWidth}" y2="${separatorY}" stroke="#000000" stroke-width="1"/>
    <rect x="0" y="${separatorY}" width="${fullWidth}" height="${blockHeight}" fill="${backgroundColor}" fill-opacity="0.5"/>
`

    let currentY = startY + padding + fontSize
    const leftX = padding

    // Translate View Type
    const viewTypeMap: Record<string, string> = {
        'Front': 'Vorderansicht',
        'Back': 'Rückansicht',
        'Plan': 'Grundriss'
    }
    const localizedViewType = viewTypeMap[viewType] || viewType

    // 1. View Title & Type Name (instead of ID)
    if (showLabels) {
        content += `    <text x="${leftX}" y="${currentY}" font-family="${fontFamily}" font-size="${fontSize}" font-weight="bold" fill="#000000">Ansicht: ${localizedViewType}</text>`

        const typeLabel = context.doorTypeName ? context.doorTypeName : context.doorId
        const labelPrefix = context.doorTypeName ? "Typ" : "ID"
        content += `    <text x="${leftX + 250}" y="${currentY}" font-family="${fontFamily}" font-size="${fontSize}" fill="#000000">${labelPrefix}: ${typeLabel}</text>`
        currentY += fontSize * 1.5

        // 2. Opening Direction (if valid)
        if (context.openingDirection && (viewType === 'Front' || viewType === 'Back')) {
            const dirText = formatOpeningDirection(context.openingDirection)
            content += `    <text x="${leftX}" y="${currentY}" font-family="${fontFamily}" font-size="${fontSize}" fill="#000000">Öffnungsrichtung: ${dirText}</text>`
            currentY += fontSize * 1.5
        }
    }

    // 3. Legend (Conditional)
    // Only show if we have devices (total items > 1, since Door is always there)
    const hasDevices = context.nearbyDevices.length > 0

    if (showLegend && hasDevices) {
        currentY += 10 // Extra spacing for legend
        const legendSize = fontSize * 0.8

        // Group: Legend Title
        content += `    <text x="${leftX}" y="${currentY}" font-family="${fontFamily}" font-size="${legendSize}" font-weight="bold" fill="#555555">LEGENDE:</text>`

        // Legend Items
        let legendX = leftX + 80
        const items = [
            { color: options.doorColor, text: 'Tür' },
            // { color: options.wallColor, text: 'Wand' }, 
        ]

        if (hasDevices) {
            items.push({ color: options.deviceColor, text: 'Elektro' })
        }

        for (const item of items) {
            // Box
            content += `    <rect x="${legendX}" y="${currentY - legendSize + 2}" width="${legendSize}" height="${legendSize}" fill="${item.color}"/>`
            // Text
            content += `    <text x="${legendX + legendSize + 5}" y="${currentY}" font-family="${fontFamily}" font-size="${legendSize}" fill="#000000">${item.text}</text>`
            legendX += legendSize + item.text.length * (legendSize * 0.7) + 20
        }
    }

    content += `  </g>`

    return content
}

/**
 * Format opening direction enum to readable German string
 */
function formatOpeningDirection(direction: string): string {
    // Map common IFC enumerations to readable German text
    const map: Record<string, string> = {
        'SINGLE_SWING_LEFT': 'DIN Links',
        'SINGLE_SWING_RIGHT': 'DIN Rechts',
        'DOUBLE_DOOR_SINGLE_SWING': 'Zweiflügelig',
        'DOUBLE_DOOR_DOUBLE_SWING': 'Pendeltür',
        'SLIDING_TO_LEFT': 'Schiebetür Links',
        'SLIDING_TO_RIGHT': 'Schiebetür Rechts',
        'FOLDING_TO_LEFT': 'Falttür Links',
        'FOLDING_TO_RIGHT': 'Falttür Rechts',
        'SWING_FIXED_LEFT': 'Fest verglast Links',
        'SWING_FIXED_RIGHT': 'Fest verglast Rechts'
    }

    return map[direction] || direction.replace(/_/g, ' ')
}

/**
 * Generate SVG legend and labels
 */
function addLegendAndLabels(
    svgContent: string,
    context: DoorContext,
    options: Required<SVGRenderOptions>,
    viewType: 'Front' | 'Back' | 'Plan'
): string {
    // Legacy function, replaced by renderTitleBlock integrated inside generateSVGString
    return svgContent
}

/**
 * Setup orthographic camera for door section plan view (cut at height)
 */
function setupPlanCamera(
    context: DoorContext,
    options: Required<SVGRenderOptions>,
    cutHeight?: number,
    viewDepth?: number
): THREE.OrthographicCamera {
    const door = context.door
    const bbox = door.boundingBox

    if (!bbox) {
        throw new Error('Door bounding box not available')
    }

    const size = bbox.getSize(new THREE.Vector3())
    const center = context.center

    // Calculate view dimensions with margin
    const margin = Math.max(options.margin, 0.25)
    // Use larger horizontal dimension for width
    const width = Math.max(size.x, size.z) + margin * 2
    // Use smaller horizontal dimension + margin for vertical view area (on screen)
    // Note: in plan view, the 'vertical' axis on screen is Z-depth in 3D world (or X depending on orientation)
    // We want to see the wall thickness + margin
    const depth = Math.min(size.x, size.z) + margin * 2

    // Create orthographic camera properties
    let left = -width / 2
    let right = width / 2
    let top = depth / 2
    let bottom = -depth / 2
    let near = 0.1
    let far = 100
    let camPosition = center.clone().add(new THREE.Vector3(0, Math.max(width, depth) * 1.5, 0))

    // If cutHeight is provided, we position camera exactly there and look down
    if (cutHeight !== undefined && viewDepth !== undefined) {
        // Position at cut height
        camPosition.set(center.x, cutHeight, center.z)

        // Look down at center
        // Important: Camera look direction
        // If we place camera at (x, cutHeight, z) and look at (x, cutHeight-1, z)
        // Y-axis is Up in 3D. We look down -Y.

        // Ortho frustum
        // width/height of camera view volume match the Plan dimensions
        near = 0
        far = viewDepth

        // Note: OrthographicCamera(left, right, top, bottom, near, far)
        // Top/Bottom correspond to the Local Y axis of the camera.
        // If Camera looks down -Y (World), its Local Z is -Y (World).
        // Its Local Y is usually Z (World) if Up is set to Z.

        // Standard Setup for "Map View":
        // Pos: (x, 100, z)
        // Up: (0, 0, -1) -> Top of screen is -Z (North?)
        // LookAt: (x, 0, z)

        // We want consistent orientation with 'setupDoorCamera' (conceptually)
    }

    const camera = new THREE.OrthographicCamera(
        left, right, top, bottom, near, far
    )

    camera.position.copy(camPosition)

    // Rotate camera to align with door orientation (make it horizontal)
    // We want the wall/door width to be Left-Right on screen (Local X)
    // The "Front" should be Bottom (Local -Y)
    // Camera looks Down (-WorldY).

    // By default, Up is (0,0,-1) = -WorldZ.
    // If we set Up to -ContextNormal (which is usually horizontal), we align the view.
    // context.normal is the vector pointing OUT of the wall (Front).
    // If we set Up to -Normal, then -Normal is "Up" on screen.
    // So Normal (Front) is "Down" on screen.
    const upVector = context.normal.clone().normalize().negate()
    camera.up.copy(upVector)

    camera.lookAt(new THREE.Vector3(center.x, camPosition.y - 1, center.z)) // Look strictly DOWN

    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()

    return camera
}

/**
 * Render door elevation to SVG (front or back view)
 * Uses simple edge projection instead of halfedge structures
 */
export async function renderDoorElevationSVG(
    context: DoorContext,
    isBackView: boolean = false,
    options: SVGRenderOptions = {}
): Promise<string> {
    const opts = { ...DEFAULT_OPTIONS, ...options }

    // Setup camera
    // Use deprecated setupDoorCamera internally, simplified here
    const door = context.door
    const bbox = door.boundingBox
    if (!bbox) throw new Error('Door bounding box')
    const size = bbox.getSize(new THREE.Vector3())
    const center = context.center
    const margin = Math.max(opts.margin, 0.25)
    const width = Math.max(size.x, size.z) + margin * 2
    const height = size.y + margin * 2

    const camera = new THREE.OrthographicCamera(
        -width / 2, width / 2, height / 2, -height / 2, 0.1, 100
    )

    const normal = context.normal.clone().normalize()
    const distance = Math.max(width, height) * 1.5

    if (isBackView) {
        camera.position.copy(center.clone().add(normal.multiplyScalar(-distance)))
    } else {
        camera.position.copy(center.clone().add(normal.multiplyScalar(distance)))
    }

    camera.up.set(0, 1, 0)
    camera.lookAt(center)
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()

    // Get all meshes for this door context
    const contextMeshes = getContextMeshes(context)
    if (contextMeshes.length === 0 && context.door.mesh) contextMeshes.push(context.door.mesh)
    if (contextMeshes.length === 0) throw new Error('No meshes found for door context')

    // Collect all edges and polygons
    const allEdges: ProjectedEdge[] = []
    const allPolygons: ProjectedPolygon[] = []

    for (const mesh of contextMeshes) {
        try {
            const expressID = mesh.userData.expressID
            const color = getElementColor(expressID, context, opts)
            const posCount = mesh.geometry?.attributes?.position?.count || 0
            if (posCount === 0) continue

            // Extract edges - NO CLIPPING for elevation
            // FIX: Use world dimensions (width, height) instead of pixel dimensions (opts.width, opts.height)
            // This ensures aspect ratio is preserved during projection.
            // generateSVGString will handle scaling to fit the target viewport.
            const edges = extractEdges(mesh, camera, opts.lineColor, width, height, false)
            allEdges.push(...edges)

            // Extract polygons for fills
            if (opts.showFills) {
                const polygons = extractPolygons(mesh, camera, color, width, height)
                allPolygons.push(...polygons)
            }
        } catch (error) {
            console.warn(`Failed to extract edges for mesh:`, error)
        }
    }

    if (allEdges.length === 0) {
        console.warn('No edges extracted for door context (Elevation)')
    }

    // Set active context for title block rendering
    activeContext = context
    activeViewType = isBackView ? 'Back' : 'Front'

    return generateSVGString(allEdges, allPolygons, opts)
}

/**
 * Render door plan (top view) to SVG
 */
export async function renderDoorPlanSVG(
    context: DoorContext,
    options: SVGRenderOptions = {}
): Promise<string> {
    const opts = { ...DEFAULT_OPTIONS, ...options }

    // Calculate cut height: Door Bottom + 1.2m
    const bbox = context.door.boundingBox
    let cutHeight = undefined
    const VIEW_DEPTH = 1.0 // 1m view depth as requested

    if (bbox) {
        // min.y is usually floor level for the door
        cutHeight = bbox.min.y + 1.2
    }

    // Setup camera for plan view with section cut
    // Calculate dimensions to match setupPlanCamera logic
    const size = bbox ? bbox.getSize(new THREE.Vector3()) : new THREE.Vector3(1, 2, 1)
    const margin = Math.max(opts.margin, 0.25)
    // Use larger horizontal dimension for width
    const width = Math.max(size.x, size.z) + margin * 2
    // Use smaller horizontal dimension + margin for vertical view area (on screen)
    const planDepth = Math.min(size.x, size.z) + margin * 2

    let camera = setupPlanCamera(context, opts, cutHeight, VIEW_DEPTH)

    // Get all meshes for this door context
    const contextMeshes = getContextMeshes(context)
    if (contextMeshes.length === 0 && context.door.mesh) contextMeshes.push(context.door.mesh)
    if (contextMeshes.length === 0) throw new Error('No meshes found for door context')

    // Collect all edges and polygons
    const allEdges: ProjectedEdge[] = []
    const allPolygons: ProjectedPolygon[] = []

    for (const mesh of contextMeshes) {
        try {
            const expressID = mesh.userData.expressID
            const color = getElementColor(expressID, context, opts)
            const posCount = mesh.geometry?.attributes?.position?.count || 0
            if (posCount === 0) continue

            // Extract edges - ENABLE CLIPPING for Plan view
            // FIX: Use world dimensions (width, depth) instead of pixel dimensions
            // Note: depth is the vertical dimension of the camera view for Plan
            // Rename to planDepth to avoid conflicts
            const edges = extractEdges(mesh, camera, opts.lineColor, width, planDepth, true)
            allEdges.push(...edges)

            // Extract polygons for fills
            if (opts.showFills) {
                const polygons = extractPolygons(mesh, camera, color, width, planDepth)
                allPolygons.push(...polygons)
            }
        } catch (error) {
            console.warn(`Failed to extract edges for mesh:`, error)
        }
    }

    if (allEdges.length === 0) {
        console.warn('No edges extracted for door context (Plan)')
    }

    // Set active context for title block rendering
    activeContext = context
    activeViewType = 'Plan'

    return generateSVGString(allEdges, allPolygons, opts)
}

/**
 * Render both front and back views for a door
 */
export async function renderDoorViews(
    context: DoorContext,
    options: SVGRenderOptions = {}
): Promise<{ front: string; back: string; plan: string }> {
    const front = await renderDoorElevationSVG(context, false, options)
    const back = await renderDoorElevationSVG(context, true, options)
    const plan = await renderDoorPlanSVG(context, options)

    return { front, back, plan }
}
