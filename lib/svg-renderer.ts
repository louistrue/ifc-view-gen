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
 * Setup orthographic camera for door plan view (Top View)
 */
function setupPlanCamera(
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
    const margin = Math.max(options.margin, 0.25)
    const width = Math.max(size.x, size.z) + margin * 2
    // For plan view, "height" is the depth (thickness) of the door/wall area
    // We want to see enough context around the door thickness
    const depth = Math.min(size.x, size.z) + margin * 2

    // Create orthographic camera
    // Looking down Y axis (Top View)
    const camera = new THREE.OrthographicCamera(
        -width / 2,
        width / 2,
        depth / 2,
        -depth / 2,
        0.1,
        100
    )

    // Position camera above door
    const distance = Math.max(width, depth) * 1.5
    camera.position.copy(center.clone().add(new THREE.Vector3(0, distance, 0)))
    camera.up.set(0, 0, -1) // Standard top view orientation (Z is up on screen)
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
 * Extract edges from mesh geometry using EdgesGeometry
 */
function extractEdges(
    mesh: THREE.Mesh,
    camera: THREE.OrthographicCamera,
    color: string,
    width: number,
    height: number
): ProjectedEdge[] {
    const edges: ProjectedEdge[] = []

    // Get world matrix for transforming vertices
    mesh.updateMatrixWorld()
    const worldMatrix = mesh.matrixWorld

    // Create EdgesGeometry to extract visible edges
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

        // Average depth for sorting
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
        if (faceNormal.dot(cameraDir) > 0.1) {
            return
        }

        const proj1 = projectPoint(p1, camera, width, height)
        const proj2 = projectPoint(p2, camera, width, height)
        const proj3 = projectPoint(p3, camera, width, height)

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
    const { width, height, lineWidth, showFills, backgroundColor } = options

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

    // Calculate scale to fit in viewport with padding
    const padding = 50 // pixels
    const contentWidth = maxX - minX
    const contentHeight = maxY - minY
    const availWidth = width - padding * 2
    const availHeight = height - padding * 2

    const scale = Math.min(
        availWidth / (contentWidth || 1),
        availHeight / (contentHeight || 1)
    )

    // Calculate offset to center content
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

    svg += `  </g>
</svg>`

    return svg
}

/**
 * Format opening direction enum to readable string
 */
function formatOpeningDirection(direction: string): string {
    // Map common IFC enumerations to readable text
    const map: Record<string, string> = {
        'SINGLE_SWING_LEFT': 'Left Swing',
        'SINGLE_SWING_RIGHT': 'Right Swing',
        'DOUBLE_DOOR_SINGLE_SWING': 'Double Door',
        'DOUBLE_DOOR_DOUBLE_SWING': 'Double Swing',
        'SLIDING_TO_LEFT': 'Sliding Left',
        'SLIDING_TO_RIGHT': 'Sliding Right',
        'FOLDING_TO_LEFT': 'Folding Left',
        'FOLDING_TO_RIGHT': 'Folding Right',
        'SWING_FIXED_LEFT': 'Fixed Left',
        'SWING_FIXED_RIGHT': 'Fixed Right'
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
    const { width, height, showLegend, showLabels } = options

    // Parse existing SVG to insert content before closing tag
    const closingTagIndex = svgContent.lastIndexOf('</svg>')
    if (closingTagIndex === -1) return svgContent

    let additionalContent = ''

    // Add labels
    if (showLabels) {
        const fontSize = Math.min(width, height) * 0.05
        const padding = fontSize

        // View type label
        additionalContent += `
    <text x="${padding}" y="${padding}" font-family="Arial" font-size="${fontSize}" fill="#000000">${viewType}</text>`

        // Opening direction (only for Front/Back)
        if (viewType === 'Front' || viewType === 'Back') {
            const direction = context.openingDirection
                ? formatOpeningDirection(context.openingDirection)
                : 'Unknown'

            additionalContent += `
    <text x="${width - padding}" y="${padding}" text-anchor="end" font-family="Arial" font-size="${fontSize}" fill="#000000">Opening: ${direction}</text>`
        }
    }

    // Add legend
    if (showLegend) {
        const fontSize = Math.min(width, height) * 0.03
        const padding = fontSize
        const legendY = height - padding

        let legendItems = []
        legendItems.push({ color: options.doorColor, text: 'Door' })
        // if (context.hostWall) legendItems.push({ color: options.wallColor, text: 'Wall' })
        if (context.nearbyDevices.length > 0) legendItems.push({ color: options.deviceColor, text: 'Electrical' })

        let currentX = padding
        additionalContent += `    <g id="legend">`

        for (const item of legendItems) {
            additionalContent += `
        <rect x="${currentX}" y="${legendY - fontSize}" width="${fontSize}" height="${fontSize}" fill="${item.color}"/>
        <text x="${currentX + fontSize * 1.5}" y="${legendY}" font-family="Arial" font-size="${fontSize}" fill="#000000">${item.text}</text>`
            currentX += fontSize * 6 // Spacing
        }

        additionalContent += `    </g>`
    }

    return svgContent.slice(0, closingTagIndex) + additionalContent + svgContent.slice(closingTagIndex)
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
    let camera = setupDoorCamera(context, opts)

    // For back view, invert the normal
    if (isBackView) {
        const normal = context.normal.clone().normalize()
        const center = context.center
        const distance = Math.max(
            context.door.boundingBox?.getSize(new THREE.Vector3()).x || 1,
            context.door.boundingBox?.getSize(new THREE.Vector3()).y || 1
        ) * 1.5

        camera.position.copy(center.clone().add(normal.multiplyScalar(-distance)))
        camera.lookAt(center)
        camera.updateProjectionMatrix()
        camera.updateMatrixWorld()
    }

    // Get all meshes for this door context
    const contextMeshes = getContextMeshes(context)

    if (contextMeshes.length === 0) {
        // Try to get the door mesh directly
        if (context.door.mesh) {
            contextMeshes.push(context.door.mesh)
        }
    }

    if (contextMeshes.length === 0) {
        throw new Error('No meshes found for door context')
    }

    // Collect all edges and polygons
    const allEdges: ProjectedEdge[] = []
    const allPolygons: ProjectedPolygon[] = []

    for (const mesh of contextMeshes) {
        try {
            const expressID = mesh.userData.expressID
            const color = getElementColor(expressID, context, opts)

            const posCount = mesh.geometry?.attributes?.position?.count || 0
            if (posCount === 0) {
                continue
            }

            // Extract edges
            const edges = extractEdges(mesh, camera, opts.lineColor, opts.width, opts.height)
            allEdges.push(...edges)

            // Extract polygons for fills
            if (opts.showFills) {
                const polygons = extractPolygons(mesh, camera, color, opts.width, opts.height)
                allPolygons.push(...polygons)
            }
        } catch (error) {
            console.warn(`Failed to extract edges for mesh:`, error)
            // Continue with other meshes
        }
    }

    if (allEdges.length === 0) {
        throw new Error('No edges could be extracted from meshes')
    }

    // Generate SVG
    const svg = generateSVGString(allEdges, allPolygons, opts)

    // Add legend and labels
    return addLegendAndLabels(svg, context, opts, isBackView ? 'Back' : 'Front')
}

/**
 * Render door plan (top view) to SVG
 */
export async function renderDoorPlanSVG(
    context: DoorContext,
    options: SVGRenderOptions = {}
): Promise<string> {
    const opts = { ...DEFAULT_OPTIONS, ...options }

    // Setup camera for plan view
    let camera = setupPlanCamera(context, opts)

    // Get all meshes for this door context
    const contextMeshes = getContextMeshes(context)

    if (contextMeshes.length === 0) {
        if (context.door.mesh) {
            contextMeshes.push(context.door.mesh)
        }
    }

    if (contextMeshes.length === 0) {
        throw new Error('No meshes found for door context')
    }

    // Collect all edges and polygons
    const allEdges: ProjectedEdge[] = []
    const allPolygons: ProjectedPolygon[] = []

    for (const mesh of contextMeshes) {
        try {
            const expressID = mesh.userData.expressID
            const color = getElementColor(expressID, context, opts)

            const posCount = mesh.geometry?.attributes?.position?.count || 0
            if (posCount === 0) continue

            // Extract edges
            const edges = extractEdges(mesh, camera, opts.lineColor, opts.width, opts.height)
            allEdges.push(...edges)

            // Extract polygons for fills
            if (opts.showFills) {
                const polygons = extractPolygons(mesh, camera, color, opts.width, opts.height)
                allPolygons.push(...polygons)
            }
        } catch (error) {
            console.warn(`Failed to extract edges for mesh:`, error)
        }
    }

    if (allEdges.length === 0) {
        throw new Error('No edges could be extracted from meshes')
    }

    // Generate SVG
    const svg = generateSVGString(allEdges, allPolygons, opts)

    // Add legend and labels
    return addLegendAndLabels(svg, context, opts, 'Plan')
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
