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

/** Escape user-derived strings for safe use in SVG text content (prevents XSS) */
function escapeSvgText(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
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
    isDashed?: boolean  // For door swing arcs (dashed line style)
}

interface ProjectedPolygon {
    points: { x: number; y: number }[]
    color: string
    depth: number
}

interface ProjectedPoint3D {
    x: number
    y: number
    z: number
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
    } else if (
        (context.hostWall && expressID === context.hostWall.expressID) ||
        (context.wall && expressID === context.wall.expressID)
    ) {
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
): ProjectedPoint3D {
    const projected = point.clone().project(camera)
    return {
        x: (projected.x + 1) * width / 2,
        y: (-projected.y + 1) * height / 2,
        z: projected.z
    }
}

/**
 * Interpolate between 2 projected points.
 */
function interpolateProjectedPoint(start: ProjectedPoint3D, end: ProjectedPoint3D, t: number): ProjectedPoint3D {
    return {
        x: start.x + (end.x - start.x) * t,
        y: start.y + (end.y - start.y) * t,
        z: start.z + (end.z - start.z) * t,
    }
}

type FrustumPlane = (point: ProjectedPoint3D) => number

const FRUSTUM_PLANES: FrustumPlane[] = [
    (point) => point.x + 1,
    (point) => 1 - point.x,
    (point) => point.y + 1,
    (point) => 1 - point.y,
    (point) => point.z + 1,
    (point) => 1 - point.z,
]

/**
 * Clip a polygon in NDC space against the orthographic frustum.
 */
function clipPolygonToFrustum(points: ProjectedPoint3D[]): ProjectedPoint3D[] {
    let clipped = points

    for (const plane of FRUSTUM_PLANES) {
        if (clipped.length === 0) {
            break
        }

        const output: ProjectedPoint3D[] = []

        for (let i = 0; i < clipped.length; i++) {
            const current = clipped[i]
            const previous = clipped[(i + clipped.length - 1) % clipped.length]
            const currentDist = plane(current)
            const previousDist = plane(previous)
            const currentInside = currentDist >= 0
            const previousInside = previousDist >= 0

            if (currentInside !== previousInside) {
                const denominator = previousDist - currentDist
                const t = Math.abs(denominator) < 1e-9 ? 0 : previousDist / denominator
                output.push(interpolateProjectedPoint(previous, current, t))
            }

            if (currentInside) {
                output.push(current)
            }
        }

        clipped = output
    }

    return clipped
}

/**
 * Clip a line segment in NDC space against the full orthographic frustum.
 */
function clipLineToFrustum(
    p1: ProjectedPoint3D,
    p2: ProjectedPoint3D
): { p1: ProjectedPoint3D, p2: ProjectedPoint3D } | null {
    const clipped = clipPolygonToFrustum([p1, p2])

    if (clipped.length < 2) {
        return null
    }

    return {
        p1: clipped[0],
        p2: clipped[clipped.length - 1],
    }
}

/**
 * Extract edges from mesh geometry by directly processing triangles
 * This works with both indexed and non-indexed geometry (Fragments uses non-indexed)
 * Only draws "sharp" edges where adjacent face normals differ significantly (>30 degrees)
 */
function extractEdges(
    mesh: THREE.Mesh,
    camera: THREE.OrthographicCamera,
    color: string,
    width: number,
    height: number,
    clipToFrustum: boolean = false
): ProjectedEdge[] {
    const edges: ProjectedEdge[] = []

    // Get world matrix for transforming vertices
    mesh.updateMatrixWorld()
    const worldMatrix = mesh.matrixWorld

    const geometry = mesh.geometry
    const positions = geometry.attributes.position
    const indices = geometry.index

    const thresholdAngle = 30 // degrees - same as EdgesGeometry default
    const thresholdDot = Math.cos((thresholdAngle * Math.PI) / 180)

    // Helper to create edge key from two world-space positions
    const createEdgeKey = (p1: THREE.Vector3, p2: THREE.Vector3): string => {
        const round = (v: THREE.Vector3) =>
            `${Math.round(v.x * 1000)}_${Math.round(v.y * 1000)}_${Math.round(v.z * 1000)}`

        const key1 = round(p1)
        const key2 = round(p2)
        return key1 < key2 ? `${key1}-${key2}` : `${key2}-${key1}`
    }

    // Build a map of edges to face normals
    // Map: edge key -> array of face normals that share this edge
    const edgeToNormals = new Map<string, THREE.Vector3[]>()
    const edgeToPoints = new Map<string, [THREE.Vector3, THREE.Vector3]>()

    // Helper to process a triangle and register its edges
    const processTriangle = (i1: number, i2: number, i3: number) => {
        const p1 = new THREE.Vector3(
            positions.getX(i1), positions.getY(i1), positions.getZ(i1)
        ).applyMatrix4(worldMatrix)
        const p2 = new THREE.Vector3(
            positions.getX(i2), positions.getY(i2), positions.getZ(i2)
        ).applyMatrix4(worldMatrix)
        const p3 = new THREE.Vector3(
            positions.getX(i3), positions.getY(i3), positions.getZ(i3)
        ).applyMatrix4(worldMatrix)

        // Calculate face normal
        const edge1 = p2.clone().sub(p1)
        const edge2 = p3.clone().sub(p1)
        const normal = edge1.cross(edge2).normalize()

        // Register this normal for all 3 edges of the triangle
        const edges = [
            [p1, p2],
            [p2, p3],
            [p3, p1]
        ]

        for (const [pa, pb] of edges) {
            const key = createEdgeKey(pa, pb)
            if (!edgeToNormals.has(key)) {
                edgeToNormals.set(key, [])
                edgeToPoints.set(key, [pa, pb])
            }
            edgeToNormals.get(key)!.push(normal)
        }
    }

    // Process all triangles
    if (indices) {
        // Indexed geometry
        for (let i = 0; i < indices.count; i += 3) {
            processTriangle(indices.getX(i), indices.getX(i + 1), indices.getX(i + 2))
        }
    } else {
        // Non-indexed geometry
        for (let i = 0; i < positions.count; i += 3) {
            processTriangle(i, i + 1, i + 2)
        }
    }

    // Filter edges: only keep "sharp" edges where normals differ significantly
    const edgeList: [THREE.Vector3, THREE.Vector3][] = []

    for (const [key, normals] of edgeToNormals.entries()) {
        // If edge belongs to only one face, it's a boundary edge - always draw it
        if (normals.length === 1) {
            edgeList.push(edgeToPoints.get(key)!)
            continue
        }

        // If edge has 2+ faces, check if normals differ significantly
        // Only draw if angle between any pair of normals > threshold
        let isSharpEdge = false
        for (let i = 0; i < normals.length; i++) {
            for (let j = i + 1; j < normals.length; j++) {
                const dot = normals[i].dot(normals[j])
                if (dot < thresholdDot) {
                    isSharpEdge = true
                    break
                }
            }
            if (isSharpEdge) break
        }

        if (isSharpEdge) {
            edgeList.push(edgeToPoints.get(key)!)
        }
    }

    // Project edges to 2D and apply clipping
    for (const [p1, p2] of edgeList) {
        const proj1 = projectPoint(p1, camera, width, height)
        const proj2 = projectPoint(p2, camera, width, height)

        const clipped = clipToFrustum ? clipLineToFrustum(proj1, proj2) : { p1: proj1, p2: proj2 }
        if (!clipped) continue

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
    height: number,
    clipToFrustum: boolean = false
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

        const projectedPoints = [
            projectPoint(p1, camera, width, height),
            projectPoint(p2, camera, width, height),
            projectPoint(p3, camera, width, height),
        ]
        const clippedPoints = clipToFrustum
            ? clipPolygonToFrustum(projectedPoints)
            : projectedPoints

        if (clippedPoints.length < 3) {
            return
        }

        // Average depth for sorting
        const depth = clippedPoints.reduce((sum, point) => sum + point.z, 0) / clippedPoints.length

        polygons.push({
            points: clippedPoints.map((point) => ({ x: point.x, y: point.y })),
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

function collectProjectedGeometry(
    meshes: THREE.Mesh[],
    context: DoorContext,
    options: Required<SVGRenderOptions>,
    camera: THREE.OrthographicCamera,
    width: number,
    height: number,
    clipToFrustum: boolean
): { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] } {
    const edges: ProjectedEdge[] = []
    const polygons: ProjectedPolygon[] = []

    for (const mesh of meshes) {
        try {
            const expressID = mesh.userData.expressID
            const color = getElementColor(expressID, context, options)
            const posCount = mesh.geometry?.attributes?.position?.count || 0
            if (posCount === 0) continue

            edges.push(...extractEdges(mesh, camera, options.lineColor, width, height, clipToFrustum))

            if (options.showFills) {
                polygons.push(...extractPolygons(mesh, camera, color, width, height, clipToFrustum))
            }
        } catch (error) {
            console.warn('Failed to extract geometry from mesh:', error)
        }
    }

    return { edges, polygons }
}

function getBoundsFromProjectedGeometry(
    edges: ProjectedEdge[],
    polygons: ProjectedPolygon[]
): ProjectedBounds | null {
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

    if (minX === Infinity) {
        return null
    }

    return { minX, maxX, minY, maxY }
}

function getMeshesBoundingBox(meshes: THREE.Mesh[]): THREE.Box3 {
    const combinedBBox = new THREE.Box3()

    for (const mesh of meshes) {
        if (!mesh.geometry) continue
        ; (mesh.geometry as THREE.BufferGeometry).boundingBox = null
        mesh.geometry.computeBoundingBox()
        if (mesh.geometry.boundingBox) {
            combinedBBox.union(mesh.geometry.boundingBox)
        }
    }

    return combinedBBox
}

interface ProjectedBounds {
    minX: number
    maxX: number
    minY: number
    maxY: number
}

function clipEdgeToBounds(edge: ProjectedEdge, bounds: ProjectedBounds): ProjectedEdge | null {
    let t0 = 0
    let t1 = 1

    const dx = edge.x2 - edge.x1
    const dy = edge.y2 - edge.y1

    const clipTest = (p: number, q: number): boolean => {
        if (Math.abs(p) < 1e-9) {
            return q >= 0
        }

        const r = q / p
        if (p < 0) {
            if (r > t1) return false
            if (r > t0) t0 = r
        } else {
            if (r < t0) return false
            if (r < t1) t1 = r
        }

        return true
    }

    if (
        !clipTest(-dx, edge.x1 - bounds.minX) ||
        !clipTest(dx, bounds.maxX - edge.x1) ||
        !clipTest(-dy, edge.y1 - bounds.minY) ||
        !clipTest(dy, bounds.maxY - edge.y1)
    ) {
        return null
    }

    const x1 = edge.x1 + t0 * dx
    const y1 = edge.y1 + t0 * dy
    const x2 = edge.x1 + t1 * dx
    const y2 = edge.y1 + t1 * dy
    const z1 = edge.depth
    const z2 = edge.depth

    return {
        ...edge,
        x1,
        y1,
        x2,
        y2,
        depth: (z1 + z2) / 2,
    }
}

function clipPolygonToBounds(points: { x: number; y: number }[], bounds: ProjectedBounds): { x: number; y: number }[] {
    type Point2D = { x: number; y: number }

    const clipAgainstEdge = (
        input: Point2D[],
        inside: (point: Point2D) => boolean,
        intersect: (start: Point2D, end: Point2D) => Point2D
    ): Point2D[] => {
        if (input.length === 0) return input

        const output: Point2D[] = []
        for (let i = 0; i < input.length; i++) {
            const current = input[i]
            const previous = input[(i + input.length - 1) % input.length]
            const currentInside = inside(current)
            const previousInside = inside(previous)

            if (currentInside !== previousInside) {
                output.push(intersect(previous, current))
            }

            if (currentInside) {
                output.push(current)
            }
        }

        return output
    }

    let clipped = points

    clipped = clipAgainstEdge(
        clipped,
        (point) => point.x >= bounds.minX,
        (start, end) => {
            const t = (bounds.minX - start.x) / ((end.x - start.x) || 1)
            return { x: bounds.minX, y: start.y + (end.y - start.y) * t }
        }
    )
    clipped = clipAgainstEdge(
        clipped,
        (point) => point.x <= bounds.maxX,
        (start, end) => {
            const t = (bounds.maxX - start.x) / ((end.x - start.x) || 1)
            return { x: bounds.maxX, y: start.y + (end.y - start.y) * t }
        }
    )
    clipped = clipAgainstEdge(
        clipped,
        (point) => point.y >= bounds.minY,
        (start, end) => {
            const t = (bounds.minY - start.y) / ((end.y - start.y) || 1)
            return { x: start.x + (end.x - start.x) * t, y: bounds.minY }
        }
    )
    clipped = clipAgainstEdge(
        clipped,
        (point) => point.y <= bounds.maxY,
        (start, end) => {
            const t = (bounds.maxY - start.y) / ((end.y - start.y) || 1)
            return { x: start.x + (end.x - start.x) * t, y: bounds.maxY }
        }
    )

    return clipped
}

/**
 * Generate SVG string from edges and polygons
 * Normalizes coordinates to fit within the viewport
 */
function generateSVGString(
    edges: ProjectedEdge[],
    polygons: ProjectedPolygon[],
    options: Required<SVGRenderOptions>,
    fitGeometry?: {
        edges: ProjectedEdge[]
        polygons: ProjectedPolygon[]
    }
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
    const hasWall = activeContext ? Boolean(activeContext.hostWall || activeContext.wall) : false
    const showLegendActual = showLegend && (hasDevices || hasWall)

    // Calculate Title Block area
    // Reserve lines for text + legend if needed
    // Text takes about 2 lines (View/Type + Opening)
    // Legend takes about 1 line if shown
    const textLines = 3 // View, ID/Type, Opening
    const legendHeight = showLegendActual ? (fontSize + 10) : 0

    const titleBlockHeight = (showLabels || showLegendActual) ? (fontSize * textLines + legendHeight + 20) : 0

    // Reserve space for Vorderansicht label in plan views (arrow + text = ~60px)
    const vorderansichtReserve = (activeViewType === 'Plan') ? 100 : 0

    const viewHeight = height - titleBlockHeight - vorderansichtReserve

    const fitBounds = getBoundsFromProjectedGeometry(
        fitGeometry?.edges ?? edges,
        fitGeometry?.polygons ?? polygons
    )

    const renderEdges = fitBounds
        ? edges.map((edge) => clipEdgeToBounds(edge, fitBounds)).filter((edge): edge is ProjectedEdge => edge !== null)
        : edges
    const renderPolygons = fitBounds
        ? polygons
            .map((polygon) => {
                const clippedPoints = clipPolygonToBounds(polygon.points, fitBounds)
                return clippedPoints.length >= 3 ? { ...polygon, points: clippedPoints } : null
            })
            .filter((polygon): polygon is ProjectedPolygon => polygon !== null)
        : polygons

    let minX = fitBounds?.minX ?? Infinity
    let maxX = fitBounds?.maxX ?? -Infinity
    let minY = fitBounds?.minY ?? Infinity
    let maxY = fitBounds?.maxY ?? -Infinity

    // If nothing to draw
    if (minX === Infinity) {
        minX = 0; maxX = width; minY = 0; maxY = viewHeight;
    }


    // Calculate scale to fit in viewport with padding
    const padding = 80 // Increased from 50 to 80 pixels for more border room
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
    renderPolygons.sort((a, b) => b.depth - a.depth)

    // Sort edges by depth (back to front)
    renderEdges.sort((a, b) => b.depth - a.depth)

    let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="${backgroundColor}"/>
  <g id="fills">
`

    // Draw filled polygons first (if enabled)
    if (showFills) {
        for (const poly of renderPolygons) {
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
    let dashedCount = 0
    for (const edge of renderEdges) {
        const x1 = transformX(edge.x1)
        const y1 = transformY(edge.y1)
        const x2 = transformX(edge.x2)
        const y2 = transformY(edge.y2)
        const dashAttr = edge.isDashed ? ' stroke-dasharray="4,2"' : ''
        if (edge.isDashed) dashedCount++
        svg += `    <line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="${edge.color}" stroke-width="${lineWidth * (edge.isDashed ? 0.75 : 1)}" stroke-linecap="round"${dashAttr} opacity="${edge.isDashed ? 0.7 : 1}"/>\n`
    }


    svg += `  </g>`

    // Render "Vorderansicht" arrow for Plan view
    if (activeViewType === 'Plan') {
        // Place arrow relative to the content bounding box (scaledHeight + offsetY)
        // Add sufficient padding below the content to avoid overlap with door geometry
        const arrowY = offsetY + scaledHeight + 40 // Increased from 10px to 40px for better spacing
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

        const typeLabel = escapeSvgText(context.doorTypeName ? context.doorTypeName : context.doorId)
        const labelPrefix = context.doorTypeName ? "Typ" : "ID"
        content += `    <text x="${leftX + 250}" y="${currentY}" font-family="${fontFamily}" font-size="${fontSize}" fill="#000000">${labelPrefix}: ${typeLabel}</text>`
        currentY += fontSize * 1.5

        // 2. Opening Direction (if valid)
        if (context.openingDirection && (viewType === 'Front' || viewType === 'Back')) {
            const dirText = escapeSvgText(formatOpeningDirection(context.openingDirection))
            content += `    <text x="${leftX}" y="${currentY}" font-family="${fontFamily}" font-size="${fontSize}" fill="#000000">Öffnungsrichtung: ${dirText}</text>`
            currentY += fontSize * 1.5
        }
    }

    // 3. Legend (Conditional)
    // Only show if we have devices (total items > 1, since Door is always there)
    const hasDevices = context.nearbyDevices.length > 0
    const hasWall = Boolean(context.hostWall || context.wall)

    if (showLegend && (hasDevices || hasWall)) {
        currentY += 10 // Extra spacing for legend
        const legendSize = fontSize * 0.8

        // Group: Legend Title
        content += `    <text x="${leftX}" y="${currentY}" font-family="${fontFamily}" font-size="${legendSize}" font-weight="bold" fill="#555555">LEGENDE:</text>`

        // Legend Items
        let legendX = leftX + 80
        const items = [
            { color: options.doorColor, text: 'Tür' },
        ]

        if (hasWall) {
            items.push({ color: options.wallColor, text: 'Wand' })
        }

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
        far = viewDepth * 10 // Increase far plane to capture all geometry properly

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
 * Uses detailed geometry from web-ifc when available, falls back to bounding box
 */
export async function renderDoorElevationSVG(
    context: DoorContext,
    isBackView: boolean = false,
    options: SVGRenderOptions = {}
): Promise<string> {
    const opts = { ...DEFAULT_OPTIONS, ...options }

    const door = context.door
    const bbox = door.boundingBox
    if (!bbox) throw new Error('Door bounding box not available')

    const size = bbox.getSize(new THREE.Vector3())
    const center = context.center

    // Determine door dimensions based on normal direction
    const normal = context.normal.clone().normalize()
    const isNormalAlongX = Math.abs(normal.x) > Math.abs(normal.z)

    const doorWidth = isNormalAlongX ? size.z : size.x
    const doorHeight = size.y

    // Check if we have detailed geometry
    const hasDetailedGeometry = context.detailedGeometry && context.detailedGeometry.doorMeshes.length > 0

    if (hasDetailedGeometry) {
        return renderElevationFromMeshes(context, isBackView, opts)
    }

    // Fallback to bounding box rendering
    return renderElevationFromBoundingBox(context, isBackView, opts, doorWidth, doorHeight)
}

/**
 * Render elevation SVG from detailed mesh geometry
 */
function renderElevationFromMeshes(
    context: DoorContext,
    isBackView: boolean,
    opts: Required<SVGRenderOptions>
): string {
    const renderMeshes = getContextMeshes(context, { includeHostWall: true })
    const fitMeshes = getContextMeshes(context, { includeHostWall: false })

    if (renderMeshes.length === 0) {
        throw new Error('No meshes available for rendering')
    }

    const door = context.door
    const combinedBBox = getMeshesBoundingBox(fitMeshes)
    const hasGeometryBounds = !combinedBBox.isEmpty()
    const actualCenter = hasGeometryBounds
        ? combinedBBox.getCenter(new THREE.Vector3())
        : context.center.clone()
    const actualSize = hasGeometryBounds
        ? combinedBBox.getSize(new THREE.Vector3())
        : door.boundingBox!.getSize(new THREE.Vector3())
    const normal = context.normal.clone().normalize()

    // Determine view dimensions
    const isNormalAlongX = Math.abs(normal.x) > Math.abs(normal.z)
    const viewWidth = isNormalAlongX ? actualSize.z : actualSize.x
    const viewHeight = actualSize.y
    const margin = Math.max(opts.margin, 0.25)
    const width = viewWidth + margin * 2
    const height = viewHeight + margin * 2

    // Setup orthographic camera for elevation view
    const camera = new THREE.OrthographicCamera(
        -width / 2, width / 2, height / 2, -height / 2, 0.1, 100
    )

    const distance = Math.max(width, height) * 2
    const viewDir = isBackView ? normal.clone().negate() : normal.clone()
    camera.position.copy(actualCenter).add(viewDir.multiplyScalar(distance))
    camera.up.set(0, 1, 0)
    camera.lookAt(actualCenter)
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()

    const renderGeometry = collectProjectedGeometry(
        renderMeshes,
        context,
        opts,
        camera,
        width,
        height,
        true
    )
    const fitGeometry = collectProjectedGeometry(
        fitMeshes,
        context,
        opts,
        camera,
        width,
        height,
        true
    )


    activeContext = context
    activeViewType = isBackView ? 'Back' : 'Front'

    return generateSVGString(renderGeometry.edges, renderGeometry.polygons, opts, fitGeometry)
}

/**
 * Render elevation SVG from bounding box (fallback)
 */
function renderElevationFromBoundingBox(
    context: DoorContext,
    isBackView: boolean,
    opts: Required<SVGRenderOptions>,
    doorWidth: number,
    doorHeight: number
): string {
    const { width: svgWidth, height: svgHeight, lineWidth, lineColor, doorColor, wallColor, backgroundColor, showLabels, fontSize, fontFamily } = opts

    const padding = 60
    const labelHeight = showLabels ? 80 : 0
    const availableWidth = svgWidth - padding * 2
    const availableHeight = svgHeight - padding * 2 - labelHeight

    const marginMeters = Math.max(opts.margin, 0.25)
    const totalWidth = doorWidth + marginMeters * 2
    const totalHeight = doorHeight + marginMeters * 2

    const scale = Math.min(availableWidth / totalWidth, availableHeight / totalHeight)

    const scaledTotalWidth = totalWidth * scale
    const scaledTotalHeight = totalHeight * scale
    const scaledWidth = doorWidth * scale
    const scaledHeight = doorHeight * scale
    const offsetX = (svgWidth - scaledWidth) / 2
    const offsetY = padding + (availableHeight - scaledHeight) / 2
    const wallOffsetX = (svgWidth - scaledTotalWidth) / 2
    const wallOffsetY = padding + (availableHeight - scaledTotalHeight) / 2
    const hasWall = Boolean(context.hostWall?.boundingBox)

    activeContext = context
    activeViewType = isBackView ? 'Back' : 'Front'

    let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">
  <rect width="100%" height="100%" fill="${backgroundColor}"/>
`

    if (hasWall) {
        svg += `
  <!-- Host wall context (cropped to existing elevation window) -->
  <rect x="${wallOffsetX}" y="${wallOffsetY}" width="${scaledTotalWidth}" height="${scaledTotalHeight}"
        fill="${wallColor}" fill-opacity="0.18" stroke="${lineColor}" stroke-width="${lineWidth * 0.6}" opacity="0.6"/>
`
    }

    svg += `
  <!-- Door outline (bounding box fallback) -->
  <rect x="${offsetX}" y="${offsetY}" width="${scaledWidth}" height="${scaledHeight}" 
        fill="${doorColor}" fill-opacity="0.2" stroke="${lineColor}" stroke-width="${lineWidth * 1.5}"/>
  
  <!-- Door panel detail -->
  <rect x="${offsetX + scaledWidth * 0.08}" y="${offsetY + scaledHeight * 0.05}" 
        width="${scaledWidth * 0.84}" height="${scaledHeight * 0.9}" 
        fill="none" stroke="${lineColor}" stroke-width="${lineWidth}"/>
  
  <!-- Door handle -->
  <rect x="${isBackView ? offsetX + scaledWidth * 0.12 : offsetX + scaledWidth * 0.82}" 
        y="${offsetY + scaledHeight * 0.48}" 
        width="${scaledWidth * 0.06}" height="${scaledHeight * 0.08}" 
        fill="${lineColor}" fill-opacity="0.6"/>
`

    if (showLabels) {
        const labelY = svgHeight - 40
        svg += `
  <!-- Labels -->
  <text x="${svgWidth / 2}" y="${labelY}" text-anchor="middle" font-family="${fontFamily}" font-size="${fontSize}" fill="${lineColor}">
    ${isBackView ? 'Rückansicht' : 'Vorderansicht'} (vereinfacht)
  </text>
  <text x="${svgWidth / 2}" y="${labelY + fontSize + 4}" text-anchor="middle" font-family="${fontFamily}" font-size="${fontSize * 0.8}" fill="#666">
    ${escapeSvgText(context.doorId)}
  </text>
  <text x="${svgWidth / 2}" y="${labelY + fontSize * 2 + 8}" text-anchor="middle" font-family="${fontFamily}" font-size="${fontSize * 0.7}" fill="#888">
    ${(doorWidth * 100).toFixed(0)}cm × ${(doorHeight * 100).toFixed(0)}cm
  </text>
`
    }

    svg += `</svg>`
    return svg
}

/**
 * Render door plan (top view) to SVG
 * Uses detailed geometry from web-ifc when available, falls back to bounding box
 */
export async function renderDoorPlanSVG(
    context: DoorContext,
    options: SVGRenderOptions = {}
): Promise<string> {
    const opts = { ...DEFAULT_OPTIONS, ...options }

    const door = context.door
    const bbox = door.boundingBox
    if (!bbox) throw new Error('Door bounding box not available')

    const size = bbox.getSize(new THREE.Vector3())

    // Determine door dimensions based on normal direction
    const normal = context.normal.clone().normalize()
    const isNormalAlongX = Math.abs(normal.x) > Math.abs(normal.z)

    const doorWidth = isNormalAlongX ? size.z : size.x
    const doorThickness = isNormalAlongX ? size.x : size.z
    const doorHeight = size.y

    // Check if we have detailed geometry
    const hasDetailedGeometry = context.detailedGeometry && context.detailedGeometry.doorMeshes.length > 0

    if (hasDetailedGeometry) {
        return renderPlanFromMeshes(context, opts)
    }

    // Fallback to bounding box rendering
    return renderPlanFromBoundingBox(context, opts, doorWidth, doorThickness, doorHeight)
}

/**
 * Parse OperationType to determine swing parameters
 */
interface SwingArcParams {
    type: 'swing' | 'sliding' | 'folding' | 'none'
    hingeSide?: 'left' | 'right' | 'both'  // For swing doors
    slideDirection?: 'left' | 'right'       // For sliding doors
}

function parseOperationType(operationType: string | null): SwingArcParams {
    if (!operationType) {
        return { type: 'none' }
    }

    const upper = operationType.toUpperCase()

    // Single swing doors
    if (upper.includes('SINGLE_SWING_LEFT') || upper === 'SINGLE_SWING_LEFT') {
        return { type: 'swing', hingeSide: 'left' }
    }
    if (upper.includes('SINGLE_SWING_RIGHT') || upper === 'SINGLE_SWING_RIGHT') {
        return { type: 'swing', hingeSide: 'right' }
    }

    // Double doors
    if (upper.includes('DOUBLE_DOOR_SINGLE_SWING') || upper.includes('DOUBLE_DOOR_DOUBLE_SWING')) {
        return { type: 'swing', hingeSide: 'both' }
    }

    // Sliding doors
    if (upper.includes('SLIDING_TO_LEFT')) {
        return { type: 'sliding', slideDirection: 'left' }
    }
    if (upper.includes('SLIDING_TO_RIGHT')) {
        return { type: 'sliding', slideDirection: 'right' }
    }
    if (upper.includes('SLIDING') && !upper.includes('FOLDING')) {
        // Generic sliding door
        return { type: 'sliding', slideDirection: 'right' }
    }

    // Folding doors
    if (upper.includes('FOLDING')) {
        return { type: 'folding' }
    }

    // Default: assume swing if unknown
    if (upper.includes('SWING')) {
        return { type: 'swing', hingeSide: 'right' }
    }

    return { type: 'none' }
}

/**
 * Generate arc edges for a single door leaf
 * @param hinge3D - 3D position of the hinge
 * @param latch3D - 3D position of the latch (door closed position)
 * @param leafWidth - Width of this door leaf
 * @param swingSign - 1 for CCW (left), -1 for CW (right)
 * @param cutHeight - Y coordinate for plan view cut
 * @param camera - Camera for projection
 * @param width - SVG width
 * @param height - SVG height
 */
function generateSingleLeafArc(
    hinge3D: THREE.Vector3,
    latch3D: THREE.Vector3,
    leafWidth: number,
    swingSign: number,
    cutHeight: number,
    camera: THREE.OrthographicCamera,
    width: number,
    height: number
): ProjectedEdge[] {
    const edges: ProjectedEdge[] = []
    const color = '#666666' // Lighter color for arc

    // Calculate direction from hinge to latch (door closed position)
    const latchDir = latch3D.clone().sub(hinge3D)
    const startDir = latchDir.clone().normalize()

    // Generate arc points (90° swing)
    const arcPoints: THREE.Vector3[] = []
    const numSegments = 20

    for (let i = 0; i <= numSegments; i++) {
        const t = i / numSegments
        const angle = (Math.PI / 2) * t * swingSign
        const dir = startDir.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), angle)
        const point = hinge3D.clone().add(dir.multiplyScalar(leafWidth))
        point.y = cutHeight
        arcPoints.push(point)
    }

    // Project arc points
    for (let i = 0; i < arcPoints.length - 1; i++) {
        const proj1 = projectPoint(arcPoints[i], camera, width, height)
        const proj2 = projectPoint(arcPoints[i + 1], camera, width, height)

        edges.push({
            x1: proj1.x,
            y1: proj1.y,
            x2: proj2.x,
            y2: proj2.y,
            color,
            depth: (proj1.z + proj2.z) / 2,
            isDashed: true // Mark arc edges as dashed
        })
    }

    // Add door leaf line (from hinge to latch - door in closed position)
    const hingeProj = projectPoint(hinge3D, camera, width, height)
    const latchProj = projectPoint(latch3D, camera, width, height)

    edges.push({
        x1: hingeProj.x,
        y1: hingeProj.y,
        x2: latchProj.x,
        y2: latchProj.y,
        color: '#333333', // Darker for door leaf
        depth: (hingeProj.z + latchProj.z) / 2,
        isDashed: false // Door leaf line is solid
    })

    // Add dashed line showing door in OPEN position (90 degrees)
    const openDoorEnd = arcPoints[arcPoints.length - 1] // Last arc point = open position
    const openDoorProj = projectPoint(openDoorEnd, camera, width, height)

    edges.push({
        x1: hingeProj.x,
        y1: hingeProj.y,
        x2: openDoorProj.x,
        y2: openDoorProj.y,
        color: '#666666', // Same color as arc
        depth: (hingeProj.z + openDoorProj.z) / 2,
        isDashed: true // Dashed to indicate open position
    })

    return edges
}

/**
 * Calculate door swing arc edges for plan view
 * Returns edges that can be added to allEdges array (in camera projection space)
 * @param geometryCenter - Optional center from actual mesh geometry (for coordinate alignment)
 * @param geometrySize - Optional size from actual mesh geometry
 * @param isWidthAlongX - Whether door width runs along X-axis (affects camera orientation)
 */
function calculateSwingArcEdges(
    context: DoorContext,
    camera: THREE.OrthographicCamera,
    width: number,
    height: number,
    geometryCenter?: THREE.Vector3,
    geometrySize?: THREE.Vector3,
    isWidthAlongX?: boolean
): ProjectedEdge[] {
    const params = parseOperationType(context.openingDirection)

    if (params.type !== 'swing' || !params.hingeSide) {
        return []
    }

    const door = context.door
    const bbox = door.boundingBox
    if (!bbox) return []

    // Use geometry center/size if provided (for coordinate alignment with detailed geometry)
    const size = geometrySize || bbox.getSize(new THREE.Vector3())
    const center = geometryCenter ? geometryCenter.clone() : context.center.clone()

    // Calculate minY from geometry center and size, or fall back to bbox
    const minY = geometryCenter && geometrySize
        ? (geometryCenter.y - geometrySize.y / 2)
        : bbox.min.y

    // IFC door convention:
    // - Door width is the larger horizontal dimension (X or Z)
    // - Door thickness is the smaller horizontal dimension (the swing direction)
    // - SINGLE_SWING_LEFT: hinge on left when viewing from approach (positive normal) side
    // - SINGLE_SWING_RIGHT: hinge on right when viewing from approach side

    // Determine door orientation from ACTUAL geometry dimensions
    // Use passed parameter if provided (from renderPlanFromMeshes), otherwise calculate
    const doorIsWidthAlongX = isWidthAlongX !== undefined ? isWidthAlongX : (size.x > size.z)
    const doorWidth = doorIsWidthAlongX ? size.x : size.z
    const doorThickness = doorIsWidthAlongX ? size.z : size.x

    // Normal points along the thickness direction (perpendicular to door face)
    // This is the direction the door swings into
    const geometryNormal = doorIsWidthAlongX
        ? new THREE.Vector3(0, 0, 1)  // Door width along X, so normal along Z
        : new THREE.Vector3(1, 0, 0)  // Door width along Z, so normal along X

    // Use context.normal to determine if door faces opposite direction
    // If context.normal points opposite to geometryNormal, flip the swing
    const actualNormal = context.normal.clone().normalize()
    const normalAlignment = geometryNormal.dot(actualNormal)
    const normalFlipped = normalAlignment < 0

    const cutHeight = minY + 1.2

    const allEdges: ProjectedEdge[] = []

    if (params.hingeSide === 'both') {
        // Double door: generate arcs for both leaves
        const leafWidth = doorWidth / 2

        // Left leaf: hinge at left edge, swings CCW (positive)
        const leftHingeOffset = doorIsWidthAlongX
            ? new THREE.Vector3(-doorWidth / 2, 0, 0)
            : new THREE.Vector3(0, 0, -doorWidth / 2)
        const leftHinge3D = center.clone().add(leftHingeOffset)
        leftHinge3D.y = cutHeight
        const leftLatch3D = center.clone() // Latch at center (meeting point)
        leftLatch3D.y = cutHeight

        let leftSwingSign = 1 // CCW for left leaf
        if (normalFlipped) {
            leftSwingSign *= -1
        }
        // When camera is rotated (door width along Z), ensure arc swings UP on screen
        if (isWidthAlongX !== undefined && !isWidthAlongX) {
            leftSwingSign *= -1
        }

        const leftEdges = generateSingleLeafArc(
            leftHinge3D,
            leftLatch3D,
            leafWidth,
            leftSwingSign,
            cutHeight,
            camera,
            width,
            height
        )
        allEdges.push(...leftEdges)

        // Right leaf: hinge at right edge, swings CW (negative)
        const rightHingeOffset = doorIsWidthAlongX
            ? new THREE.Vector3(doorWidth / 2, 0, 0)
            : new THREE.Vector3(0, 0, doorWidth / 2)
        const rightHinge3D = center.clone().add(rightHingeOffset)
        rightHinge3D.y = cutHeight
        const rightLatch3D = center.clone() // Latch at center (meeting point)
        rightLatch3D.y = cutHeight

        let rightSwingSign = -1 // CW for right leaf
        if (normalFlipped) {
            rightSwingSign *= -1
        }
        // When camera is rotated (door width along Z), ensure arc swings UP on screen
        if (isWidthAlongX !== undefined && !isWidthAlongX) {
            rightSwingSign *= -1
        }

        const rightEdges = generateSingleLeafArc(
            rightHinge3D,
            rightLatch3D,
            leafWidth,
            rightSwingSign,
            cutHeight,
            camera,
            width,
            height
        )
        allEdges.push(...rightEdges)

        return allEdges
    } else {
        // Single door: generate arc for one leaf
        // Calculate hinge position in 3D space
        // IFC LEFT/RIGHT is relative to viewing from the approach (positive normal) direction
        const widthDir = new THREE.Vector3()
        if (doorIsWidthAlongX) {
            // Width along X: left is -X, right is +X (when viewing from +Z)
            widthDir.set(params.hingeSide === 'left' ? -doorWidth / 2 : doorWidth / 2, 0, 0)
        } else {
            // Width along Z: left is -Z, right is +Z (when viewing from +X)
            widthDir.set(0, 0, params.hingeSide === 'left' ? -doorWidth / 2 : doorWidth / 2)
        }

        // Hinge is at the door center + offset to the edge
        const hinge3D = center.clone().add(widthDir)
        hinge3D.y = cutHeight

        // Calculate latch position (opposite edge from hinge)
        const latchDir = widthDir.clone().negate() // Direction from center to latch
        const latch3D = center.clone().add(latchDir)
        latch3D.y = cutHeight

        // Swing direction based on hinge side (IFC convention):
        // - SINGLE_SWING_LEFT: Hinge on LEFT when viewing from approach, door swings INTO room (toward +normal)
        // - SINGLE_SWING_RIGHT: Hinge on RIGHT when viewing from approach, door swings INTO room (toward +normal)
        // When viewed from above:
        //   - LEFT hinge: door swings counter-clockwise (positive rotation) into room
        //   - RIGHT hinge: door swings clockwise (negative rotation) into room
        // Both swing toward the normal direction (into the room)
        let swingSign = params.hingeSide === 'left' ? 1 : -1

        // If the door faces the opposite direction (negative normal), flip the swing sign
        // This ensures doors always swing INTO the room regardless of which direction they face
        if (normalFlipped) {
            swingSign *= -1
        }

        // When camera is rotated (door width along Z), ensure arc swings UP on screen
        // Camera rotation changes how swing direction appears in screen space
        if (isWidthAlongX !== undefined && !isWidthAlongX) {
            // Camera is rotated 90°, so we need to flip swing to ensure it goes UP on screen
            swingSign *= -1
        }

        const edges = generateSingleLeafArc(
            hinge3D,
            latch3D,
            doorWidth,
            swingSign,
            cutHeight,
            camera,
            width,
            height
        )

        return edges
    }
}

/**
 * Render door swing arc as SVG path (for bounding box fallback)
 */
function renderSwingArcSVGForBoundingBox(
    context: DoorContext,
    offsetX: number,
    offsetY: number,
    scaledWidth: number,
    scaledThickness: number,
    options: Required<SVGRenderOptions>
): string {
    const params = parseOperationType(context.openingDirection)

    if (params.type !== 'swing' || !params.hingeSide || params.hingeSide === 'both') {
        return ''
    }

    const { lineColor, lineWidth } = options

    // Calculate hinge position (left or right edge)
    const hingeX = params.hingeSide === 'left' ? offsetX : offsetX + scaledWidth
    const hingeY = offsetY + scaledThickness / 2

    // Arc radius = door width
    const radius = scaledWidth * 0.4 // Slightly smaller for visual clarity

    // Calculate arc angles
    // Door closed: horizontal line
    // Door open: 90° arc
    const startAngle = params.hingeSide === 'left' ? Math.PI : 0 // Left hinge: start at 180°, Right: start at 0°
    const endAngle = startAngle + (Math.PI / 2) * (params.hingeSide === 'left' ? -1 : 1)

    // Calculate arc start and end points
    const startX = hingeX + Math.cos(startAngle) * radius
    const startY = hingeY + Math.sin(startAngle) * radius
    const endX = hingeX + Math.cos(endAngle) * radius
    const endY = hingeY + Math.sin(endAngle) * radius

    // SVG arc path
    const largeArcFlag = 0 // Always small arc (90°)
    const sweepFlag = params.hingeSide === 'left' ? 0 : 1 // Left = counter-clockwise, Right = clockwise

    const path = `M ${startX},${startY} A ${radius},${radius} 0 ${largeArcFlag},${sweepFlag} ${endX},${endY}`

    // Door leaf line (showing closed position)
    const doorCenterX = offsetX + scaledWidth / 2
    const doorCenterY = offsetY + scaledThickness / 2

    return `
  <g id="door-swing-arc">
    <!-- Dashed swing arc -->
    <path d="${path}" 
          stroke="${lineColor}" 
          stroke-width="${lineWidth * 0.75}" 
          stroke-dasharray="4,2" 
          fill="none"
          opacity="0.7"/>
    <!-- Door leaf line (showing closed position) -->
    <line x1="${hingeX}" y1="${hingeY}" 
          x2="${doorCenterX}" y2="${doorCenterY}" 
          stroke="${lineColor}" 
          stroke-width="${lineWidth * 0.5}" 
          opacity="0.5"/>
  </g>`
}

/**
 * Render plan SVG from detailed mesh geometry
 */
function renderPlanFromMeshes(
    context: DoorContext,
    opts: Required<SVGRenderOptions>
): string {
    const renderMeshes = getContextMeshes(context, { includeHostWall: true })
    const cropMeshes = getContextMeshes(context, { includeHostWall: false })

    if (renderMeshes.length === 0) {
        throw new Error('No meshes available for rendering')
    }

    const door = context.door
    const normal = context.normal.clone().normalize()

    const combinedBBox = getMeshesBoundingBox(cropMeshes)

    // Use actual geometry bounds, fallback to context if empty
    const hasGeometryBounds = !combinedBBox.isEmpty()
    const actualCenter = hasGeometryBounds
        ? combinedBBox.getCenter(new THREE.Vector3())
        : context.center.clone()
    const actualSize = hasGeometryBounds
        ? combinedBBox.getSize(new THREE.Vector3())
        : door.boundingBox!.getSize(new THREE.Vector3())
    const actualMinY = hasGeometryBounds ? combinedBBox.min.y : door.boundingBox!.min.y

    // For plan view, cut at 1.2m above door bottom
    const cutHeight = actualMinY + 1.2

    // Calculate view dimensions
    // For plan view, we need to show:
    // 1. The door leaf (width x thickness)
    // 2. The swing arc (radius = door width, extends perpendicular to door)
    const doorWidth = Math.max(actualSize.x, actualSize.z)  // Larger horizontal = door width
    const doorThickness = Math.min(actualSize.x, actualSize.z)  // Smaller horizontal = thickness
    const isWidthAlongX = actualSize.x > actualSize.z

    const margin = Math.max(opts.margin, 0.5) // Increased from 0.25 to 0.5m for better border spacing

    // View must show door width + margin on the width axis
    // View must show door width (arc radius) + thickness + margin on the depth axis
    // The arc swings from the hinge, so we need doorWidth in front of the door
    const viewWidth = doorWidth + margin * 2
    const viewDepth = doorWidth + doorThickness + margin * 2  // Arc radius + door + margin

    // Setup orthographic camera looking down (plan view)
    // The arc extends from the door in the normal direction
    // - If isWidthAlongX: normal is +Z, arc extends in Z
    // - If !isWidthAlongX: normal is +X, arc extends in X

    // Calculate view center that includes both door and swing arc
    // Arc extends doorWidth in the normal direction from the door
    let viewCenterX = actualCenter.x
    let viewCenterZ = actualCenter.z

    if (isWidthAlongX) {
        // Arc extends in +Z direction, offset camera Z to center the view
        viewCenterZ = actualCenter.z + doorWidth / 2
    } else {
        // Arc extends in +X direction, offset camera X to center the view
        viewCenterX = actualCenter.x + doorWidth / 2
    }

    // Camera frustum: larger dimension for width axis, arc+door for depth axis
    const frustumWidth = isWidthAlongX ? viewWidth : viewDepth
    const frustumHeight = isWidthAlongX ? viewDepth : viewWidth

    const camera = new THREE.OrthographicCamera(
        -frustumWidth / 2, frustumWidth / 2, frustumHeight / 2, -frustumHeight / 2, 0.1, 100
    )

    // Position camera above the view center
    const planCenter = new THREE.Vector3(viewCenterX, cutHeight, viewCenterZ)
    camera.position.set(planCenter.x, planCenter.y + 50, planCenter.z)

    // Set camera up vector based on door orientation to ensure door always appears horizontal
    // - If door width is along X-axis: -Z is up (door width appears horizontal)
    // - If door width is along Z-axis: -X is up (door width appears horizontal)
    if (isWidthAlongX) {
        camera.up.set(0, 0, -1) // -Z is up, door width along X appears horizontal
    } else {
        camera.up.set(-1, 0, 0) // -X is up, door width along Z appears horizontal
    }

    camera.lookAt(planCenter)
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()


    const renderGeometry = collectProjectedGeometry(
        renderMeshes,
        context,
        opts,
        camera,
        frustumWidth,
        frustumHeight,
        true
    )
    const fitGeometry = collectProjectedGeometry(
        cropMeshes,
        context,
        opts,
        camera,
        frustumWidth,
        frustumHeight,
        true
    )

    // Add door swing arc edges if OperationType is available
    // Use the ACTUAL geometry center for arc calculation to match mesh coordinates
    if (context.openingDirection) {
        const arcEdges = calculateSwingArcEdges(context, camera, frustumWidth, frustumHeight, actualCenter, actualSize, isWidthAlongX)
        renderGeometry.edges.push(...arcEdges)
        fitGeometry.edges.push(...arcEdges)
    }

    activeContext = context
    activeViewType = 'Plan'

    return generateSVGString(renderGeometry.edges, renderGeometry.polygons, opts, fitGeometry)
}

/**
 * Render plan SVG from bounding box (fallback)
 */
function renderPlanFromBoundingBox(
    context: DoorContext,
    opts: Required<SVGRenderOptions>,
    doorWidth: number,
    doorThickness: number,
    doorHeight: number
): string {
    const { width: svgWidth, height: svgHeight, lineWidth, lineColor, doorColor, wallColor, backgroundColor, showLabels, fontSize, fontFamily } = opts

    const padding = 60
    const labelHeight = showLabels ? 80 : 0
    const availableWidth = svgWidth - padding * 2
    const availableHeight = svgHeight - padding * 2 - labelHeight

    const marginMeters = Math.max(opts.margin, 0.25)
    const totalWidth = doorWidth + marginMeters * 2
    const totalDepth = doorThickness + marginMeters * 2

    const scale = Math.min(availableWidth / totalWidth, availableHeight / totalDepth)

    const scaledTotalWidth = totalWidth * scale
    const scaledWidth = doorWidth * scale
    const scaledThickness = doorThickness * scale
    const offsetX = (svgWidth - scaledWidth) / 2
    const offsetY = padding + (availableHeight - scaledThickness) / 2
    const wallOffsetX = (svgWidth - scaledTotalWidth) / 2

    let scaledWallThickness = scaledThickness
    if (context.hostWall?.boundingBox) {
        const wallSize = context.hostWall.boundingBox.getSize(new THREE.Vector3())
        const normal = context.normal.clone().normalize()
        const isNormalAlongX = Math.abs(normal.x) > Math.abs(normal.z)
        const wallThicknessMeters = isNormalAlongX ? wallSize.x : wallSize.z
        scaledWallThickness = Math.min(Math.max(wallThicknessMeters * scale, scaledThickness), totalDepth * scale)
    }
    const wallOffsetY = offsetY + (scaledThickness - scaledWallThickness) / 2

    activeContext = context
    activeViewType = 'Plan'

    const arrowY = offsetY + scaledThickness + 30
    const arrowEndY = arrowY + 25

    let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">
  <rect width="100%" height="100%" fill="${backgroundColor}"/>
  
  ${context.hostWall?.boundingBox ? `<!-- Host wall context (cropped to existing plan window) -->
  <rect x="${wallOffsetX}" y="${wallOffsetY}" width="${scaledTotalWidth}" height="${scaledWallThickness}"
        fill="${wallColor}" fill-opacity="0.2" stroke="${lineColor}" stroke-width="${lineWidth * 0.6}" opacity="0.6"/>` : ''}

  <!-- Door outline (bounding box fallback) -->
  <rect x="${offsetX}" y="${offsetY}" width="${scaledWidth}" height="${scaledThickness}" 
        fill="${doorColor}" fill-opacity="0.3" stroke="${lineColor}" stroke-width="${lineWidth * 1.5}"/>
  
  <!-- Door panel detail -->
  <line x1="${offsetX + scaledWidth * 0.1}" y1="${offsetY + scaledThickness / 2}" 
        x2="${offsetX + scaledWidth * 0.9}" y2="${offsetY + scaledThickness / 2}" 
        stroke="${lineColor}" stroke-width="${lineWidth}" stroke-dasharray="4,2"/>
  
  ${renderSwingArcSVGForBoundingBox(context, offsetX, offsetY, scaledWidth, scaledThickness, opts)}
  
  <!-- Front direction arrow -->
  <line x1="${svgWidth / 2}" y1="${arrowY}" x2="${svgWidth / 2}" y2="${arrowEndY}" 
        stroke="${lineColor}" stroke-width="${lineWidth}"/>
  <polygon points="${svgWidth / 2},${arrowEndY + 8} ${svgWidth / 2 - 5},${arrowEndY} ${svgWidth / 2 + 5},${arrowEndY}" 
           fill="${lineColor}"/>
`

    if (showLabels) {
        const labelY = svgHeight - 40
        svg += `
  <!-- Labels -->
  <text x="${svgWidth / 2}" y="${arrowEndY + 25}" text-anchor="middle" font-family="${fontFamily}" font-size="${fontSize * 0.9}" fill="${lineColor}">
    Vorderansicht
  </text>
  <text x="${svgWidth / 2}" y="${labelY}" text-anchor="middle" font-family="${fontFamily}" font-size="${fontSize}" fill="${lineColor}">
    Grundriss (vereinfacht)
  </text>
  <text x="${svgWidth / 2}" y="${labelY + fontSize + 4}" text-anchor="middle" font-family="${fontFamily}" font-size="${fontSize * 0.8}" fill="#666">
    ${escapeSvgText(context.doorId)}
  </text>
  <text x="${svgWidth / 2}" y="${labelY + fontSize * 2 + 8}" text-anchor="middle" font-family="${fontFamily}" font-size="${fontSize * 0.7}" fill="#888">
    ${(doorWidth * 100).toFixed(0)}cm × ${(doorHeight * 100).toFixed(0)}cm
  </text>
`
    }

    svg += `</svg>`
    return svg
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
