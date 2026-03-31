import * as THREE from 'three'
import type { WallContext, WallViewFrame } from './wall-analyzer'
import { getWallContextMeshes } from './wall-analyzer'

export interface WallSVGRenderOptions {
    width?: number
    height?: number
    margin?: number // meters around the wall
    wallColor?: string
    windowColor?: string
    doorColor?: string
    electricalColor?: string
    backgroundColor?: string
    lineWidth?: number
    lineColor?: string
    showFills?: boolean
    showLegend?: boolean
    showLabels?: boolean
    fontSize?: number
    fontFamily?: string
}

/** Escape user-derived strings for safe use in SVG text content */
function escapeSvgText(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
}

const DEFAULT_OPTIONS: Required<WallSVGRenderOptions> = {
    width: 1200,
    height: 800,
    margin: 0.5,
    wallColor: '#5B7DB1',
    windowColor: '#7EC8E3',
    doorColor: '#8B6914',
    electricalColor: '#CC0000',
    backgroundColor: '#f5f5f5',
    lineWidth: 1.5,
    lineColor: '#000000',
    showFills: true,
    showLegend: true,
    showLabels: true,
    fontSize: 14,
    fontFamily: 'Arial',
}

interface ProjectedEdge {
    x1: number; y1: number; x2: number; y2: number
    color: string; depth: number; layer: number
}

interface ProjectedPolygon {
    points: { x: number; y: number }[]
    color: string; depth: number; layer: number
}

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

function setupWallCamera(
    context: WallContext,
    options: Required<WallSVGRenderOptions>
): THREE.OrthographicCamera {
    const frame = context.viewFrame
    const margin = Math.max(options.margin, 0.25)
    const width = frame.width + margin * 2
    const height = frame.height + margin * 2

    const camera = new THREE.OrthographicCamera(
        -width / 2, width / 2,
        height / 2, -height / 2,
        0.1, 100
    )

    const distance = Math.max(width, height) * 1.5
    camera.position.copy(frame.origin.clone().add(frame.semanticFacing.clone().multiplyScalar(distance)))
    camera.up.copy(frame.upAxis)
    camera.lookAt(frame.origin)
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()

    return camera
}

function setupWallPlanCamera(
    context: WallContext,
    options: Required<WallSVGRenderOptions>
): THREE.OrthographicCamera {
    const frame = context.viewFrame
    const margin = Math.max(options.margin, 0.25)
    const width = frame.width + margin * 2
    const depth = Math.max(frame.thickness * 4, 1.0) + margin * 2

    const camera = new THREE.OrthographicCamera(
        -width / 2, width / 2,
        depth / 2, -depth / 2,
        0.1, 100
    )

    // Look down from above
    const height = frame.height
    camera.position.copy(frame.origin.clone().add(new THREE.Vector3(0, height, 0)))
    camera.up.copy(frame.semanticFacing.clone().negate())
    camera.lookAt(frame.origin)
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()

    return camera
}

/**
 * Get color for element based on its category in the wall context
 */
function getElementColor(
    expressID: number,
    context: WallContext,
    options: Required<WallSVGRenderOptions>
): string {
    if (expressID === context.wall.expressID) return options.wallColor
    if (context.windows.some(w => w.expressID === expressID)) return options.windowColor
    if (context.doors.some(d => d.expressID === expressID)) return options.doorColor
    if (context.electricalDevices.some(e => e.expressID === expressID)) return options.electricalColor
    return options.wallColor
}

/**
 * Extract sharp edges from mesh geometry
 */
function extractEdges(
    mesh: THREE.Mesh,
    camera: THREE.OrthographicCamera,
    color: string,
    width: number,
    height: number,
    layer: number = 0
): ProjectedEdge[] {
    const edges: ProjectedEdge[] = []
    mesh.updateMatrixWorld()
    const worldMatrix = mesh.matrixWorld
    const geometry = mesh.geometry
    const positions = geometry.attributes.position
    const indices = geometry.index

    const thresholdDot = Math.cos((30 * Math.PI) / 180)

    const createEdgeKey = (p1: THREE.Vector3, p2: THREE.Vector3): string => {
        const round = (v: THREE.Vector3) =>
            `${Math.round(v.x * 1000)}_${Math.round(v.y * 1000)}_${Math.round(v.z * 1000)}`
        const key1 = round(p1)
        const key2 = round(p2)
        return key1 < key2 ? `${key1}-${key2}` : `${key2}-${key1}`
    }

    const edgeToNormals = new Map<string, THREE.Vector3[]>()
    const edgeToPoints = new Map<string, [THREE.Vector3, THREE.Vector3]>()

    const processTriangle = (i1: number, i2: number, i3: number) => {
        const p1 = new THREE.Vector3(positions.getX(i1), positions.getY(i1), positions.getZ(i1)).applyMatrix4(worldMatrix)
        const p2 = new THREE.Vector3(positions.getX(i2), positions.getY(i2), positions.getZ(i2)).applyMatrix4(worldMatrix)
        const p3 = new THREE.Vector3(positions.getX(i3), positions.getY(i3), positions.getZ(i3)).applyMatrix4(worldMatrix)

        const edge1 = p2.clone().sub(p1)
        const edge2 = p3.clone().sub(p1)
        const normal = edge1.cross(edge2).normalize()

        const triEdges = [[p1, p2], [p2, p3], [p3, p1]]
        for (const [pa, pb] of triEdges) {
            const key = createEdgeKey(pa, pb)
            if (!edgeToNormals.has(key)) {
                edgeToNormals.set(key, [])
                edgeToPoints.set(key, [pa, pb])
            }
            edgeToNormals.get(key)!.push(normal)
        }
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

    const edgeList: [THREE.Vector3, THREE.Vector3][] = []
    for (const [key, normals] of edgeToNormals.entries()) {
        if (normals.length === 1) {
            edgeList.push(edgeToPoints.get(key)!)
            continue
        }
        let isSharpEdge = false
        for (let i = 0; i < normals.length; i++) {
            for (let j = i + 1; j < normals.length; j++) {
                if (normals[i].dot(normals[j]) < thresholdDot) { isSharpEdge = true; break }
            }
            if (isSharpEdge) break
        }
        if (isSharpEdge) edgeList.push(edgeToPoints.get(key)!)
    }

    for (const [p1, p2] of edgeList) {
        const proj1 = projectPoint(p1, camera, width, height)
        const proj2 = projectPoint(p2, camera, width, height)
        const depth = (proj1.z + proj2.z) / 2
        edges.push({ x1: proj1.x, y1: proj1.y, x2: proj2.x, y2: proj2.y, color, depth, layer })
    }

    return edges
}

/**
 * Extract filled polygons from mesh geometry
 */
function extractPolygons(
    mesh: THREE.Mesh,
    camera: THREE.OrthographicCamera,
    color: string,
    width: number,
    height: number,
    layer: number = 0
): ProjectedPolygon[] {
    const polygons: ProjectedPolygon[] = []
    mesh.updateMatrixWorld()
    const worldMatrix = mesh.matrixWorld
    const geometry = mesh.geometry
    const positions = geometry.attributes.position
    const indices = geometry.index

    const cameraDir = new THREE.Vector3()
    camera.getWorldDirection(cameraDir)

    const processTriangle = (i1: number, i2: number, i3: number) => {
        const p1 = new THREE.Vector3(positions.getX(i1), positions.getY(i1), positions.getZ(i1)).applyMatrix4(worldMatrix)
        const p2 = new THREE.Vector3(positions.getX(i2), positions.getY(i2), positions.getZ(i2)).applyMatrix4(worldMatrix)
        const p3 = new THREE.Vector3(positions.getX(i3), positions.getY(i3), positions.getZ(i3)).applyMatrix4(worldMatrix)

        const edge1 = p2.clone().sub(p1)
        const edge2 = p3.clone().sub(p1)
        const faceNormal = edge1.cross(edge2).normalize()
        if (faceNormal.dot(cameraDir) > 0.1) return

        const proj1 = projectPoint(p1, camera, width, height)
        const proj2 = projectPoint(p2, camera, width, height)
        const proj3 = projectPoint(p3, camera, width, height)
        const depth = (proj1.z + proj2.z + proj3.z) / 3

        polygons.push({
            points: [
                { x: proj1.x, y: proj1.y },
                { x: proj2.x, y: proj2.y },
                { x: proj3.x, y: proj3.y }
            ],
            color, depth, layer
        })
    }

    if (indices) {
        for (let i = 0; i < indices.count; i += 3) processTriangle(indices.getX(i), indices.getX(i + 1), indices.getX(i + 2))
    } else {
        for (let i = 0; i < positions.count; i += 3) processTriangle(i, i + 1, i + 2)
    }

    return polygons
}

function collectProjectedGeometry(
    meshes: THREE.Mesh[],
    context: WallContext,
    options: Required<WallSVGRenderOptions>,
    camera: THREE.OrthographicCamera,
    width: number,
    height: number,
    layer: number
): { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] } {
    const edges: ProjectedEdge[] = []
    const polygons: ProjectedPolygon[] = []

    for (const mesh of meshes) {
        try {
            const expressID = mesh.userData.expressID
            const color = getElementColor(expressID, context, options)
            const posCount = mesh.geometry?.attributes?.position?.count || 0
            if (posCount === 0) continue

            edges.push(...extractEdges(mesh, camera, options.lineColor, width, height, layer))
            if (options.showFills) {
                polygons.push(...extractPolygons(mesh, camera, color, width, height, layer))
            }
        } catch (error) {
            console.warn('Failed to extract geometry from mesh:', error)
        }
    }

    return { edges, polygons }
}

function getBoundsFromGeometry(
    edges: ProjectedEdge[],
    polygons: ProjectedPolygon[]
): { minX: number; maxX: number; minY: number; maxY: number } | null {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity

    for (const edge of edges) {
        minX = Math.min(minX, edge.x1, edge.x2)
        maxX = Math.max(maxX, edge.x1, edge.x2)
        minY = Math.min(minY, edge.y1, edge.y2)
        maxY = Math.max(maxY, edge.y1, edge.y2)
    }
    for (const polygon of polygons) {
        for (const point of polygon.points) {
            minX = Math.min(minX, point.x)
            maxX = Math.max(maxX, point.x)
            minY = Math.min(minY, point.y)
            maxY = Math.max(maxY, point.y)
        }
    }

    if (minX === Infinity) return null
    return { minX, maxX, minY, maxY }
}

/**
 * Render legend showing element color coding
 */
function renderLegend(
    context: WallContext,
    options: Required<WallSVGRenderOptions>,
    y: number,
    width: number
): string {
    const items: { color: string; label: string }[] = [
        { color: options.wallColor, label: 'Wall' },
    ]

    if (context.windows.length > 0) items.push({ color: options.windowColor, label: `Windows (${context.windows.length})` })
    if (context.doors.length > 0) items.push({ color: options.doorColor, label: `Doors (${context.doors.length})` })
    if (context.electricalDevices.length > 0) items.push({ color: options.electricalColor, label: `Electrical (${context.electricalDevices.length})` })

    if (items.length <= 1) return ''

    const itemWidth = 120
    const totalWidth = items.length * itemWidth
    const startX = (width - totalWidth) / 2

    let svg = ''
    items.forEach((item, i) => {
        const x = startX + i * itemWidth
        svg += `  <rect x="${x}" y="${y}" width="12" height="12" fill="${item.color}" fill-opacity="0.6" stroke="${options.lineColor}" stroke-width="0.5"/>\n`
        svg += `  <text x="${x + 16}" y="${y + 10}" fill="${options.lineColor}" font-size="${options.fontSize - 2}" font-family="${options.fontFamily}">${escapeSvgText(item.label)}</text>\n`
    })

    return svg
}

/**
 * Render title block with wall info
 */
function renderTitleBlock(
    context: WallContext,
    options: Required<WallSVGRenderOptions>,
    viewType: string,
    fullWidth: number,
    fullHeight: number,
    blockHeight: number
): string {
    const { fontSize, fontFamily, lineColor } = options
    const y0 = fullHeight - blockHeight

    let svg = `  <line x1="0" y1="${y0}" x2="${fullWidth}" y2="${y0}" stroke="${lineColor}" stroke-width="0.5" opacity="0.3"/>\n`

    const lineH = fontSize + 4
    let textY = y0 + lineH

    // View type
    svg += `  <text x="${fullWidth / 2}" y="${textY}" text-anchor="middle" fill="${lineColor}" font-size="${fontSize}" font-family="${fontFamily}" font-weight="bold">${escapeSvgText(viewType)}</text>\n`
    textY += lineH

    // Wall name/type
    const wallLabel = context.wall.name || context.wallTypeName || context.wallId
    svg += `  <text x="${fullWidth / 2}" y="${textY}" text-anchor="middle" fill="${lineColor}" font-size="${fontSize - 1}" font-family="${fontFamily}">${escapeSvgText(wallLabel)}</text>\n`
    textY += lineH

    // Component summary
    const parts: string[] = []
    if (context.windows.length > 0) parts.push(`${context.windows.length} window${context.windows.length > 1 ? 's' : ''}`)
    if (context.doors.length > 0) parts.push(`${context.doors.length} door${context.doors.length > 1 ? 's' : ''}`)
    if (context.electricalDevices.length > 0) parts.push(`${context.electricalDevices.length} electrical`)

    if (parts.length > 0) {
        svg += `  <text x="${fullWidth / 2}" y="${textY}" text-anchor="middle" fill="${lineColor}" font-size="${fontSize - 2}" font-family="${fontFamily}" opacity="0.7">${escapeSvgText(parts.join(' | '))}</text>\n`
        textY += lineH
    }

    // Legend
    if (options.showLegend) {
        svg += renderLegend(context, options, textY, fullWidth)
    }

    return svg
}

/**
 * Generate SVG from projected geometry
 */
function generateWallSVG(
    edges: ProjectedEdge[],
    polygons: ProjectedPolygon[],
    context: WallContext,
    viewType: string,
    options: Required<WallSVGRenderOptions>
): string {
    const { width, height, lineWidth, showFills, backgroundColor, fontSize, showLabels, showLegend } = options

    const titleBlockHeight = (showLabels || showLegend) ? (fontSize * 4 + 40) : 0
    const viewHeight = height - titleBlockHeight

    const bounds = getBoundsFromGeometry(edges, polygons)
    let minX = bounds?.minX ?? 0
    let maxX = bounds?.maxX ?? width
    let minY = bounds?.minY ?? 0
    let maxY = bounds?.maxY ?? viewHeight

    const padding = 80
    const contentWidth = maxX - minX
    const contentHeight = maxY - minY
    const availWidth = width - padding * 2
    const availHeight = viewHeight - padding * 2

    const scale = Math.min(
        availWidth / (contentWidth || 1),
        availHeight / (contentHeight || 1)
    )

    const scaledWidth = contentWidth * scale
    const scaledHeight = contentHeight * scale
    const offsetX = padding + (availWidth - scaledWidth) / 2
    const offsetY = padding + (availHeight - scaledHeight) / 2

    const transformX = (x: number) => (x - minX) * scale + offsetX
    const transformY = (y: number) => (y - minY) * scale + offsetY

    polygons.sort((a, b) => a.layer - b.layer || b.depth - a.depth)
    edges.sort((a, b) => a.layer - b.layer || b.depth - a.depth)

    let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="${backgroundColor}"/>
  <g id="fills">
`

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

    for (const edge of edges) {
        const x1 = transformX(edge.x1)
        const y1 = transformY(edge.y1)
        const x2 = transformX(edge.x2)
        const y2 = transformY(edge.y2)
        svg += `    <line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="${edge.color}" stroke-width="${lineWidth}" stroke-linecap="round"/>\n`
    }

    svg += `  </g>`

    if (titleBlockHeight > 0) {
        svg += '\n'
        svg += renderTitleBlock(context, options, viewType, width, height, titleBlockHeight)
    }

    svg += `\n</svg>`
    return svg
}

/**
 * Render wall elevation SVG (front view)
 */
export async function renderWallElevationSVG(
    context: WallContext,
    backView: boolean = false,
    userOptions: WallSVGRenderOptions = {}
): Promise<string> {
    const options = { ...DEFAULT_OPTIONS, ...userOptions }

    // Get all meshes
    const meshes = getWallContextMeshes(context)
    if (meshes.length === 0) {
        return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="${options.width}" height="${options.height}"><text x="50%" y="50%" text-anchor="middle" fill="#666">No geometry available</text></svg>`
    }

    const camera = setupWallCamera(context, options)
    if (backView) {
        // Flip camera to back side
        const frame = context.viewFrame
        const distance = Math.max(frame.width, frame.height) * 1.5
        camera.position.copy(frame.origin.clone().sub(frame.semanticFacing.clone().multiplyScalar(distance)))
        camera.lookAt(frame.origin)
        camera.updateProjectionMatrix()
        camera.updateMatrixWorld()
    }

    const { edges, polygons } = collectProjectedGeometry(meshes, context, options, camera, options.width, options.height, 0)

    if (edges.length === 0 && polygons.length === 0) {
        return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="${options.width}" height="${options.height}"><text x="50%" y="50%" text-anchor="middle" fill="#666">No visible geometry</text></svg>`
    }

    const viewType = backView ? 'Wall Elevation (Back)' : 'Wall Elevation (Front)'
    return generateWallSVG(edges, polygons, context, viewType, options)
}

/**
 * Render wall plan SVG (top-down view)
 */
export async function renderWallPlanSVG(
    context: WallContext,
    userOptions: WallSVGRenderOptions = {}
): Promise<string> {
    const options = { ...DEFAULT_OPTIONS, ...userOptions }

    const meshes = getWallContextMeshes(context)
    if (meshes.length === 0) {
        return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="${options.width}" height="${options.height}"><text x="50%" y="50%" text-anchor="middle" fill="#666">No geometry available</text></svg>`
    }

    const camera = setupWallPlanCamera(context, options)
    const { edges, polygons } = collectProjectedGeometry(meshes, context, options, camera, options.width, options.height, 0)

    if (edges.length === 0 && polygons.length === 0) {
        return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="${options.width}" height="${options.height}"><text x="50%" y="50%" text-anchor="middle" fill="#666">No visible geometry</text></svg>`
    }

    return generateWallSVG(edges, polygons, context, 'Wall Plan', options)
}

/**
 * Render all wall views (front elevation, back elevation, plan)
 */
export async function renderWallViews(
    context: WallContext,
    options: WallSVGRenderOptions = {}
): Promise<{ front: string; back: string; plan: string }> {
    const front = await renderWallElevationSVG(context, false, options)
    const back = await renderWallElevationSVG(context, true, options)
    const plan = await renderWallPlanSVG(context, options)
    return { front, back, plan }
}
