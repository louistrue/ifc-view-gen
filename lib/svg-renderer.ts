import * as THREE from 'three'
import type { DoorContext, DoorViewFrame } from './door-analyzer'
import { getDoorMeshes } from './door-analyzer'

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
    /** Wall reveal on each side as a fraction of door width (0–0.5, default 0.12 = 12 %) */
    wallRevealSide?: number
    /** Wall reveal above the door as a fraction of door height (0–0.5, default 0.04 = 4 %) */
    wallRevealTop?: number
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
    wallColor: '#5B7DB1',
    deviceColor: '#CC0000',
    backgroundColor: '#f5f5f5', // Light gray background
    lineWidth: 1.5,
    lineColor: '#000000',
    showFills: true,
    showLegend: true,
    showLabels: true,
    fontSize: 14,
    fontFamily: 'Arial',
    wallRevealSide: 0.12,
    wallRevealTop: 0.04,
}

interface ProjectedEdge {
    x1: number
    y1: number
    x2: number
    y2: number
    color: string
    depth: number
    layer: number
    isDashed?: boolean  // For door swing arcs (dashed line style)
}

interface ProjectedPolygon {
    points: { x: number; y: number }[]
    color: string
    depth: number
    layer: number
}

interface AxisBounds {
    minA: number
    maxA: number
    minB: number
    maxB: number
    minC: number
    maxC: number
}

/**
 * Setup orthographic camera for door elevation view
 */
function setupDoorCamera(
    context: DoorContext,
    options: Required<SVGRenderOptions>
): THREE.OrthographicCamera {
    const frame = context.viewFrame

    // Calculate view dimensions with margin
    // Client requested 25cm margin around door leaf
    // We use the provided margin option (default 0.5m) but ensure at least 0.25m
    const margin = Math.max(options.margin, 0.25)
    const width = frame.width + margin * 2
    const height = frame.height + margin * 2

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
    const distance = Math.max(width, height) * 1.5
    camera.position.copy(frame.origin.clone().add(frame.semanticFacing.clone().multiplyScalar(distance)))
    camera.up.copy(frame.upAxis)
    camera.lookAt(frame.origin)
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
        (context.hostWall && expressID === context.hostWall.expressID)
        || (context.wall && expressID === context.wall.expressID)
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
    clipZ: boolean = false,
    layer: number = 0
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
                    depth,
                    layer
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
                depth,
                layer
            })
        }
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
    layer: number = 0
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
            depth,
            layer
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
    clipZ: boolean,
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

            edges.push(...extractEdges(mesh, camera, options.lineColor, width, height, clipZ, layer))

            if (options.showFills) {
                polygons.push(...extractPolygons(mesh, camera, color, width, height, layer))
            }
        } catch (error) {
            console.warn('Failed to extract geometry from mesh:', error)
        }
    }

    return { edges, polygons }
}

function measureBoundingBoxInAxes(
    box: THREE.Box3,
    axisA: THREE.Vector3,
    axisB: THREE.Vector3,
    axisC: THREE.Vector3
): AxisBounds {
    const corners = [
        new THREE.Vector3(box.min.x, box.min.y, box.min.z),
        new THREE.Vector3(box.min.x, box.min.y, box.max.z),
        new THREE.Vector3(box.min.x, box.max.y, box.min.z),
        new THREE.Vector3(box.min.x, box.max.y, box.max.z),
        new THREE.Vector3(box.max.x, box.min.y, box.min.z),
        new THREE.Vector3(box.max.x, box.min.y, box.max.z),
        new THREE.Vector3(box.max.x, box.max.y, box.min.z),
        new THREE.Vector3(box.max.x, box.max.y, box.max.z),
    ]

    let minA = Infinity
    let maxA = -Infinity
    let minB = Infinity
    let maxB = -Infinity
    let minC = Infinity
    let maxC = -Infinity

    for (const corner of corners) {
        const a = corner.dot(axisA)
        const b = corner.dot(axisB)
        const c = corner.dot(axisC)
        minA = Math.min(minA, a)
        maxA = Math.max(maxA, a)
        minB = Math.min(minB, b)
        maxB = Math.max(maxB, b)
        minC = Math.min(minC, c)
        maxC = Math.max(maxC, c)
    }

    return { minA, maxA, minB, maxB, minC, maxC }
}

function createRectPoints3D(
    origin: THREE.Vector3,
    axisX: THREE.Vector3,
    axisY: THREE.Vector3,
    minX: number,
    maxX: number,
    minY: number,
    maxY: number
): THREE.Vector3[] {
    return [
        origin.clone().add(axisX.clone().multiplyScalar(minX)).add(axisY.clone().multiplyScalar(minY)),
        origin.clone().add(axisX.clone().multiplyScalar(maxX)).add(axisY.clone().multiplyScalar(minY)),
        origin.clone().add(axisX.clone().multiplyScalar(maxX)).add(axisY.clone().multiplyScalar(maxY)),
        origin.clone().add(axisX.clone().multiplyScalar(minX)).add(axisY.clone().multiplyScalar(maxY)),
    ]
}

function appendProjectedPolygon(
    geometry: { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] },
    points3D: THREE.Vector3[],
    camera: THREE.OrthographicCamera,
    width: number,
    height: number,
    fillColor: string,
    strokeColor: string,
    layer: number
): void {
    const projected = points3D.map((point) => projectPoint(point, camera, width, height))
    const depth = projected.reduce((sum, point) => sum + point.z, 0) / projected.length

    geometry.polygons.push({
        points: projected.map((point) => ({ x: point.x, y: point.y })),
        color: fillColor,
        depth,
        layer,
    })

    for (let i = 0; i < projected.length; i++) {
        const current = projected[i]
        const next = projected[(i + 1) % projected.length]
        geometry.edges.push({
            x1: current.x,
            y1: current.y,
            x2: next.x,
            y2: next.y,
            color: strokeColor,
            depth,
            layer,
        })
    }
}

function createSemanticElevationWallGeometry(
    context: DoorContext,
    camera: THREE.OrthographicCamera,
    width: number,
    height: number,
    options: Required<SVGRenderOptions>
): { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] } {
    const geometry = { edges: [], polygons: [] } as { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] }
    const wallBox = context.hostWall?.boundingBox
    if (!wallBox) return geometry

    const frame = context.viewFrame
    const wallBounds = measureBoundingBoxInAxes(wallBox, frame.widthAxis, frame.upAxis, frame.semanticFacing)
    const wallThickness = Math.max(wallBounds.maxC - wallBounds.minC, frame.thickness)
    const sideReveal = THREE.MathUtils.clamp(wallThickness * 0.75, 0.08, 0.18)
    const topReveal = THREE.MathUtils.clamp(wallThickness * 0.75, 0.08, 0.18)
    const halfDoorWidth = frame.width / 2
    const bottom = -frame.height / 2
    const top = frame.height / 2
    const outerTop = top + topReveal

    const rects = [
        createRectPoints3D(frame.origin, frame.widthAxis, frame.upAxis, -halfDoorWidth - sideReveal, -halfDoorWidth, bottom, outerTop),
        createRectPoints3D(frame.origin, frame.widthAxis, frame.upAxis, halfDoorWidth, halfDoorWidth + sideReveal, bottom, outerTop),
        createRectPoints3D(frame.origin, frame.widthAxis, frame.upAxis, -halfDoorWidth, halfDoorWidth, top, outerTop),
    ]

    for (const rect of rects) {
        appendProjectedPolygon(geometry, rect, camera, width, height, options.wallColor, options.lineColor, -1)
    }

    return geometry
}

function createSemanticPlanWallGeometry(
    context: DoorContext,
    camera: THREE.OrthographicCamera,
    width: number,
    height: number,
    options: Required<SVGRenderOptions>
): { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] } {
    const geometry = { edges: [], polygons: [] } as { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] }
    const wallBox = context.hostWall?.boundingBox
    if (!wallBox) return geometry

    const frame = context.viewFrame
    const wallBounds = measureBoundingBoxInAxes(wallBox, frame.widthAxis, frame.semanticFacing, frame.upAxis)
    const wallThickness = Math.max(wallBounds.maxB - wallBounds.minB, frame.thickness)
    const sideContext = THREE.MathUtils.clamp(wallThickness * 0.6, 0.1, 0.18)
    const halfDoorWidth = frame.width / 2
    const halfWallThickness = wallThickness / 2

    const rects = [
        createRectPoints3D(frame.origin, frame.widthAxis, frame.semanticFacing, -halfDoorWidth - sideContext, -halfDoorWidth, -halfWallThickness, halfWallThickness),
        createRectPoints3D(frame.origin, frame.widthAxis, frame.semanticFacing, halfDoorWidth, halfDoorWidth + sideContext, -halfWallThickness, halfWallThickness),
    ]

    for (const rect of rects) {
        appendProjectedPolygon(geometry, rect, camera, width, height, options.wallColor, options.lineColor, -1)
    }

    return geometry
}

function createSemanticElevationDeviceGeometry(
    context: DoorContext,
    camera: THREE.OrthographicCamera,
    width: number,
    height: number,
    options: Required<SVGRenderOptions>
): { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] } {
    const geometry = { edges: [], polygons: [] } as { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] }
    const frame = context.viewFrame
    const depthCenter = frame.origin.dot(frame.semanticFacing)

    for (const device of context.nearbyDevices) {
        const deviceBox = device.boundingBox
        if (!deviceBox) continue

        const bounds = measureBoundingBoxInAxes(deviceBox, frame.widthAxis, frame.upAxis, frame.semanticFacing)
        const rectWidth = Math.max(bounds.maxA - bounds.minA, 0.05)
        const rectHeight = Math.max(bounds.maxB - bounds.minB, 0.05)
        const centerA = (bounds.minA + bounds.maxA) / 2
        const centerB = (bounds.minB + bounds.maxB) / 2
        const center = frame.widthAxis.clone().multiplyScalar(centerA)
            .add(frame.upAxis.clone().multiplyScalar(centerB))
            .add(frame.semanticFacing.clone().multiplyScalar(depthCenter))

        const rect = createRectPoints3D(
            center,
            frame.widthAxis,
            frame.upAxis,
            -rectWidth / 2,
            rectWidth / 2,
            -rectHeight / 2,
            rectHeight / 2
        )
        appendProjectedPolygon(geometry, rect, camera, width, height, options.deviceColor, options.lineColor, 0)
    }

    return geometry
}

function createSemanticPlanDeviceGeometry(
    context: DoorContext,
    camera: THREE.OrthographicCamera,
    width: number,
    height: number,
    cutHeight: number,
    options: Required<SVGRenderOptions>
): { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] } {
    const geometry = { edges: [], polygons: [] } as { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] }
    const frame = context.viewFrame
    const depthCap = Math.max(frame.thickness * 0.9, 0.05)

    for (const device of context.nearbyDevices) {
        const deviceBox = device.boundingBox
        if (!deviceBox) continue

        const bounds = measureBoundingBoxInAxes(deviceBox, frame.widthAxis, frame.semanticFacing, frame.upAxis)
        const rectWidth = Math.max(bounds.maxA - bounds.minA, 0.05)
        const rectDepth = Math.min(Math.max(bounds.maxB - bounds.minB, 0.02), depthCap)
        const centerA = (bounds.minA + bounds.maxA) / 2
        const centerB = (bounds.minB + bounds.maxB) / 2
        const center = frame.widthAxis.clone().multiplyScalar(centerA)
            .add(frame.semanticFacing.clone().multiplyScalar(centerB))
            .add(frame.upAxis.clone().multiplyScalar(cutHeight))

        const rect = createRectPoints3D(
            center,
            frame.widthAxis,
            frame.semanticFacing,
            -rectWidth / 2,
            rectWidth / 2,
            -rectDepth / 2,
            rectDepth / 2
        )
        appendProjectedPolygon(geometry, rect, camera, width, height, options.deviceColor, options.lineColor, 0)
    }

    return geometry
}

interface ProjectedBounds {
    minX: number
    maxX: number
    minY: number
    maxY: number
}

function getBoundsFromProjectedGeometry(
    edges: ProjectedEdge[],
    polygons: ProjectedPolygon[]
): ProjectedBounds | null {
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity

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
        !clipTest(-dx, edge.x1 - bounds.minX)
        || !clipTest(dx, bounds.maxX - edge.x1)
        || !clipTest(-dy, edge.y1 - bounds.minY)
        || !clipTest(dy, bounds.maxY - edge.y1)
    ) {
        return null
    }

    return {
        ...edge,
        x1: edge.x1 + t0 * dx,
        y1: edge.y1 + t0 * dy,
        x2: edge.x1 + t1 * dx,
        y2: edge.y1 + t1 * dy,
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

interface RenderMeta {
    context: DoorContext | null
    viewType: string
    planArcFlip: boolean
}

interface WallRevealRect {
    x: number
    y: number
    width: number
    height: number
}

function getRevealBandSize(totalSize: number, revealRatio: number, minSize: number): number {
    const clampedReveal = THREE.MathUtils.clamp(revealRatio, 0, 0.5)
    const rawSize = totalSize * clampedReveal
    if (rawSize <= 0) {
        return 0
    }
    return Math.max(rawSize, minSize)
}

function getWallRevealRects(params: {
    bounds: { minX: number; maxX: number; minY: number; maxY: number }
    offsetX: number
    offsetY: number
    scaledWidth: number
    scaledHeight: number
    wallRevealSide: number
    wallRevealTop: number
    viewType: string
    wallThicknessPx?: number
    planArcFlip?: boolean
}): WallRevealRect[] {
    const {
        bounds,
        offsetX,
        offsetY,
        scaledWidth,
        scaledHeight,
        wallRevealSide,
        wallRevealTop,
        viewType,
        wallThicknessPx,
        planArcFlip = false,
    } = params

    const bandW = getRevealBandSize(scaledWidth, wallRevealSide, 10)
    const bandH = getRevealBandSize(scaledHeight, wallRevealTop, 8)
    const leftX = Math.max(bounds.minX, offsetX - bandW)
    const rightXStart = offsetX + scaledWidth
    const rightXEnd = Math.min(bounds.maxX, rightXStart + bandW)
    const topY = Math.max(bounds.minY, offsetY - bandH)
    const bottomY = Math.min(bounds.maxY, offsetY + scaledHeight)
    const rects: WallRevealRect[] = []

    if (viewType !== 'Plan') {
        if (offsetX - leftX > 0.5) {
            rects.push({ x: leftX, y: topY, width: offsetX - leftX, height: bottomY - topY })
        }
        if (rightXEnd - rightXStart > 0.5) {
            rects.push({ x: rightXStart, y: topY, width: rightXEnd - rightXStart, height: bottomY - topY })
        }
        if (bandH > 0 && offsetY - topY > 0.5) {
            rects.push({ x: leftX, y: topY, width: rightXEnd - leftX, height: offsetY - topY })
        }
        return rects
    }

    if (bandW <= 0) {
        return rects
    }

    const wallThickness = wallThicknessPx ?? Math.max(scaledHeight * 0.08, 12)
    const planBandH = Math.min(
        wallThickness * (1 + THREE.MathUtils.clamp(wallRevealSide, 0, 0.5)),
        scaledHeight
    )
    const planBandY = planArcFlip
        ? offsetY + scaledHeight - planBandH
        : offsetY

    if (offsetX - leftX > 0.5) {
        rects.push({ x: leftX, y: planBandY, width: offsetX - leftX, height: planBandH })
    }
    if (rightXEnd - rightXStart > 0.5) {
        rects.push({ x: rightXStart, y: planBandY, width: rightXEnd - rightXStart, height: planBandH })
    }

    return rects
}

function renderWallRevealSvg(
    rects: WallRevealRect[],
    wallColor: string,
    lineColor: string,
    lineWidth: number
): string {
    if (rects.length === 0) {
        return ''
    }

    const opacity = 0.65
    const strokeWidth = (lineWidth * 0.75).toFixed(2)

    return rects.map((rect) =>
        `  <rect x="${rect.x.toFixed(2)}" y="${rect.y.toFixed(2)}" width="${rect.width.toFixed(2)}" height="${rect.height.toFixed(2)}" fill="${wallColor}" fill-opacity="${opacity}" stroke="${lineColor}" stroke-width="${strokeWidth}"/>`
    ).join('\n') + '\n'
}

/**
 * Generate SVG string from edges and polygons
 * Normalizes coordinates to fit within the viewport
 */
function generateSVGString(
    edges: ProjectedEdge[],
    polygons: ProjectedPolygon[],
    options: Required<SVGRenderOptions>,
    fitGeometry?: { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] },
    renderMeta: RenderMeta = { context: null, viewType: '', planArcFlip: false }
): string {
    const {
        width,
        height,
        lineWidth,
        showFills,
        backgroundColor,
        wallColor,
        fontSize,
        showLegend,
        showLabels,
        wallRevealSide,
        wallRevealTop,
    } = options

    const hasDevices = renderMeta.context ? renderMeta.context.nearbyDevices.length > 0 : false
    const hasWall = renderMeta.context ? Boolean(renderMeta.context.hostWall || renderMeta.context.wall) : false
    const showLegendActual = showLegend && (hasDevices || hasWall)

    // Calculate Title Block area
    // Reserve lines for text + legend if needed
    // Text takes about 2 lines (View/Type + Opening)
    // Legend takes about 1 line if shown
    const textLines = 3 // View, ID/Type, Opening
    const legendHeight = showLegendActual ? (fontSize + 10) : 0

    const titleBlockHeight = (showLabels || showLegendActual) ? (fontSize * textLines + legendHeight + 20) : 0

    // No Vorderansicht annotation rendered, so no extra space needed
    const vorderansichtReserve = 0

    const viewHeight = height - titleBlockHeight - vorderansichtReserve

    const fitBounds = getBoundsFromProjectedGeometry(
        fitGeometry?.edges ?? edges,
        fitGeometry?.polygons ?? polygons
    )

    const renderEdges = fitBounds
        ? edges
            .map((edge) => edge.layer < 0 ? edge : clipEdgeToBounds(edge, fitBounds))
            .filter((edge): edge is ProjectedEdge => edge !== null)
        : edges
    const renderPolygons = fitBounds
        ? polygons
            .map((polygon) => {
                if (polygon.layer < 0) return polygon
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

    // Draw lower-priority layers first, then depth-sort within a layer.
    renderPolygons.sort((a, b) => a.layer - b.layer || b.depth - a.depth)

    renderEdges.sort((a, b) => a.layer - b.layer || b.depth - a.depth)

    // Build 2D canvas-space wall bands.
    // These are placed relative to offsetX/offsetY/scaledWidth/scaledHeight which come from
    // the ACTUAL projected door bounds (fitBounds), so they are guaranteed to sit just outside
    // the door geometry and can never be covered by door fills.
    const wallBandsSvg = showFills && hasWall
        ? renderWallRevealSvg(
            getWallRevealRects({
                bounds: { minX: 0, maxX: width, minY: 0, maxY: viewHeight },
                offsetX,
                offsetY,
                scaledWidth,
                scaledHeight,
                wallRevealSide,
                wallRevealTop,
                viewType: renderMeta.viewType,
                wallThicknessPx: renderMeta.context?.viewFrame
                    ? Math.max(renderMeta.context.viewFrame.thickness * scale, 12)
                    : undefined,
                planArcFlip: renderMeta.planArcFlip,
            }),
            wallColor,
            options.lineColor,
            lineWidth
        )
        : ''

    let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="${backgroundColor}"/>
${wallBandsSvg}  <g id="fills">
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

    // "Vorderansicht" arrow intentionally omitted – not needed on generated pictures

    // Render Title Block
    if (titleBlockHeight > 0) {
        svg += renderTitleBlock(width, height, titleBlockHeight, options, renderMeta.context, renderMeta.viewType)
    }

    svg += `\n</svg>`

    return svg
}

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
    const frame = context.viewFrame

    // Calculate view dimensions with margin
    const margin = Math.max(options.margin, 0.25)
    const width = frame.width + margin * 2
    const depth = frame.thickness + margin * 2

    // Create orthographic camera properties
    let left = -width / 2
    let right = width / 2
    let top = depth / 2
    let bottom = -depth / 2
    let near = 0.1
    let far = 100
    let camPosition = frame.origin.clone().add(frame.upAxis.clone().multiplyScalar(Math.max(width, depth) * 1.5))

    // If cutHeight is provided, we position camera exactly there and look down
    if (cutHeight !== undefined && viewDepth !== undefined) {
        // Position at cut height
        camPosition.copy(frame.origin.clone())
        camPosition.y = cutHeight

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

    const upVector = frame.semanticFacing.clone().negate()
    camera.up.copy(upVector)

    camera.lookAt(frame.origin.clone().sub(frame.upAxis))

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
    const { width: doorWidth, height: doorHeight } = context.viewFrame

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
    const renderMeshes = getDoorMeshes(context)
    if (renderMeshes.length === 0) {
        throw new Error('No meshes available for rendering')
    }

    const frame = context.viewFrame
    const margin = Math.max(opts.margin, 0.25)
    const width = frame.width + margin * 2
    const height = frame.height + margin * 2

    const camera = new THREE.OrthographicCamera(
        -width / 2, width / 2, height / 2, -height / 2, 0.1, 100
    )

    const distance = Math.max(width, height) * 2
    const viewDir = isBackView
        ? frame.semanticFacing.clone().negate()
        : frame.semanticFacing.clone()
    camera.position.copy(frame.origin).add(viewDir.multiplyScalar(distance))
    camera.up.copy(frame.upAxis)
    camera.lookAt(frame.origin)
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()

    const renderGeometry = collectProjectedGeometry(renderMeshes, context, opts, camera, width, height, false, 0)
    const deviceGeometry = createSemanticElevationDeviceGeometry(context, camera, width, height, opts)
    renderGeometry.edges.push(...deviceGeometry.edges)
    renderGeometry.polygons.push(...deviceGeometry.polygons)
    const fitGeometry = {
        edges: [...renderGeometry.edges],
        polygons: [...renderGeometry.polygons],
    }

    return generateSVGString(
        renderGeometry.edges,
        renderGeometry.polygons,
        opts,
        fitGeometry,
        {
            context,
            viewType: isBackView ? 'Back' : 'Front',
            planArcFlip: false,
        }
    )
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

    const scaledWidth = doorWidth * scale
    const scaledHeight = doorHeight * scale
    const offsetX = (svgWidth - scaledWidth) / 2
    const offsetY = padding + (availableHeight - scaledHeight) / 2
    const hasWall = Boolean(context.hostWall?.boundingBox)
    const wallRevealSvg = hasWall
        ? renderWallRevealSvg(
            getWallRevealRects({
                bounds: {
                    minX: padding,
                    maxX: svgWidth - padding,
                    minY: padding,
                    maxY: padding + availableHeight,
                },
                offsetX,
                offsetY,
                scaledWidth,
                scaledHeight,
                wallRevealSide: opts.wallRevealSide,
                wallRevealTop: opts.wallRevealTop,
                viewType: isBackView ? 'Back' : 'Front',
            }),
            wallColor,
            lineColor,
            lineWidth
        )
        : ''

    let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">
  <rect width="100%" height="100%" fill="${backgroundColor}"/>
${wallRevealSvg}  
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
    const { width: doorWidth, thickness: doorThickness, height: doorHeight } = context.viewFrame

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

function shouldFlipPlanArc(context: DoorContext, frame: DoorViewFrame): boolean {
    const placementYAxis = context.door.placementYAxis?.clone().setY(0)
    if (!placementYAxis || placementYAxis.lengthSq() < 1e-8) {
        return false
    }

    placementYAxis.normalize()
    return placementYAxis.dot(frame.semanticFacing) < 0
}

function shouldRenderPlanSwing(frame: DoorViewFrame): boolean {
    const axisAligned = (axis: THREE.Vector3): boolean => {
        const horizontal = axis.clone().setY(0)
        if (horizontal.lengthSq() < 1e-8) return false
        horizontal.normalize()
        return Math.max(Math.abs(horizontal.x), Math.abs(horizontal.z)) >= 0.98
    }

    // For non-orthogonal/rotated doors, the generic symbolic swing arc is often misleading.
    // Keep the door slice and wall context, but suppress swing graphics.
    return axisAligned(frame.widthAxis) && axisAligned(frame.semanticFacing)
}

/**
 * Generate arc edges for a single door leaf
 */
function generateSingleLeafArc(
    hinge3D: THREE.Vector3,
    leafWidth: number,
    startAngle: number,
    endAngle: number,
    cutHeight: number,
    widthAxis: THREE.Vector3,
    openAxis: THREE.Vector3,
    camera: THREE.OrthographicCamera,
    width: number,
    height: number
): ProjectedEdge[] {
    const edges: ProjectedEdge[] = []
    const color = '#666666' // Lighter color for arc

    const startDir = widthAxis.clone().multiplyScalar(Math.cos(startAngle))
        .add(openAxis.clone().multiplyScalar(Math.sin(startAngle)))
        .normalize()
    const latch3D = hinge3D.clone().add(startDir.clone().multiplyScalar(leafWidth))

    const arcPoints: THREE.Vector3[] = []
    const numSegments = 20

    for (let i = 0; i <= numSegments; i++) {
        const t = i / numSegments
        const angle = startAngle + (endAngle - startAngle) * t
        const dir = widthAxis.clone().multiplyScalar(Math.cos(angle))
            .add(openAxis.clone().multiplyScalar(Math.sin(angle)))
            .normalize()
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
            layer: 0,
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
        layer: 0,
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
        layer: 0,
        isDashed: true // Dashed to indicate open position
    })

    return edges
}

/**
 * Calculate door swing arc edges for plan view
 * Returns edges that can be added to allEdges array (in camera projection space)
 */
function calculateSwingArcEdges(
    context: DoorContext,
    frame: DoorViewFrame,
    camera: THREE.OrthographicCamera,
    width: number,
    height: number,
    cutHeight: number,
    flipArc = false
): ProjectedEdge[] {
    const params = parseOperationType(context.openingDirection)

    if (params.type !== 'swing' || !params.hingeSide) {
        return []
    }

    const center = frame.origin.clone()
    const widthAxis = frame.widthAxis.clone()
    // Arc direction: when flipArc=false (default) the arc opens toward the semantic-facing
    // side (downward in SVG, conventional floor-plan).  When flipArc=true the arc opens
    // in the opposite direction (upward in SVG) – useful for IFC models where the door
    // normal points toward the room instead of the corridor.
    const openAxis = flipArc ? frame.semanticFacing.clone().negate() : frame.semanticFacing.clone()
    const allEdges: ProjectedEdge[] = []

    if (params.hingeSide === 'both') {
        const leafWidth = frame.width / 2
        const leftHinge3D = center.clone().add(widthAxis.clone().multiplyScalar(-frame.width / 2))
        leftHinge3D.y = cutHeight

        const leftEdges = generateSingleLeafArc(
            leftHinge3D,
            leafWidth,
            0,
            Math.PI / 2,
            cutHeight,
            widthAxis,
            openAxis,
            camera,
            width,
            height
        )
        allEdges.push(...leftEdges)

        const rightHinge3D = center.clone().add(widthAxis.clone().multiplyScalar(frame.width / 2))
        rightHinge3D.y = cutHeight

        const rightEdges = generateSingleLeafArc(
            rightHinge3D,
            leafWidth,
            Math.PI,
            Math.PI / 2,
            cutHeight,
            widthAxis,
            openAxis,
            camera,
            width,
            height
        )
        allEdges.push(...rightEdges)

        return allEdges
    }

    const isLeftHinge = params.hingeSide === 'left'
    const hinge3D = center.clone().add(widthAxis.clone().multiplyScalar(isLeftHinge ? -frame.width / 2 : frame.width / 2))
    hinge3D.y = cutHeight

    return generateSingleLeafArc(
        hinge3D,
        frame.width,
        isLeftHinge ? 0 : Math.PI,
        Math.PI / 2,
        cutHeight,
        widthAxis,
        openAxis,
        camera,
        width,
        height
    )
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
 * Build four projected edges that form the door cross-section rectangle in plan view.
 * This ensures the door body is always visible even when web-ifc mesh edges are
 * degenerate or missing at the cut height.
 */
function buildDoorCrossSectionEdges(
    frame: DoorViewFrame,
    camera: THREE.OrthographicCamera,
    frustumWidth: number,
    frustumHeight: number,
    cutHeight: number,
    opts: Required<SVGRenderOptions>
): ProjectedEdge[] {
    const hw = frame.width / 2
    const ht = frame.thickness / 2
    const w = frame.widthAxis
    const f = frame.semanticFacing

    const corners = [
        frame.origin.clone().sub(w.clone().multiplyScalar(hw)).sub(f.clone().multiplyScalar(ht)),
        frame.origin.clone().add(w.clone().multiplyScalar(hw)).sub(f.clone().multiplyScalar(ht)),
        frame.origin.clone().add(w.clone().multiplyScalar(hw)).add(f.clone().multiplyScalar(ht)),
        frame.origin.clone().sub(w.clone().multiplyScalar(hw)).add(f.clone().multiplyScalar(ht)),
    ].map(p => { p.y = cutHeight; return p })

    const edges: ProjectedEdge[] = []
    for (let i = 0; i < 4; i++) {
        const a = projectPoint(corners[i], camera, frustumWidth, frustumHeight)
        const b = projectPoint(corners[(i + 1) % 4], camera, frustumWidth, frustumHeight)
        edges.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, color: opts.doorColor, depth: 0, layer: 0 })
    }
    return edges
}

function buildDoorCrossSectionFallbackGeometry(
    frame: DoorViewFrame,
    camera: THREE.OrthographicCamera,
    frustumWidth: number,
    frustumHeight: number,
    cutHeight: number,
    opts: Required<SVGRenderOptions>
): { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] } {
    const hw = frame.width / 2
    const ht = frame.thickness / 2
    const w = frame.widthAxis
    const f = frame.semanticFacing
    const corners = [
        frame.origin.clone().sub(w.clone().multiplyScalar(hw)).sub(f.clone().multiplyScalar(ht)),
        frame.origin.clone().add(w.clone().multiplyScalar(hw)).sub(f.clone().multiplyScalar(ht)),
        frame.origin.clone().add(w.clone().multiplyScalar(hw)).add(f.clone().multiplyScalar(ht)),
        frame.origin.clone().sub(w.clone().multiplyScalar(hw)).add(f.clone().multiplyScalar(ht)),
    ].map(p => { p.y = cutHeight; return p })

    const projected = corners.map((point) => projectPoint(point, camera, frustumWidth, frustumHeight))
    const depth = projected.reduce((sum, point) => sum + point.z, 0) / projected.length

    const edges: ProjectedEdge[] = []
    const polygons: ProjectedPolygon[] = [{
        points: projected.map((point) => ({ x: point.x, y: point.y })),
        color: opts.doorColor,
        depth,
        layer: 0,
    }]

    // Add a simple inset panel outline so the fallback reads more like a door than a plain slab.
    const insetW = Math.max(frame.width * 0.12, 0.03)
    const insetT = Math.max(frame.thickness * 0.22, 0.01)
    if (frame.width > insetW * 2 && frame.thickness > insetT * 2) {
        const innerCorners = [
            frame.origin.clone().sub(w.clone().multiplyScalar(hw - insetW)).sub(f.clone().multiplyScalar(ht - insetT)),
            frame.origin.clone().add(w.clone().multiplyScalar(hw - insetW)).sub(f.clone().multiplyScalar(ht - insetT)),
            frame.origin.clone().add(w.clone().multiplyScalar(hw - insetW)).add(f.clone().multiplyScalar(ht - insetT)),
            frame.origin.clone().sub(w.clone().multiplyScalar(hw - insetW)).add(f.clone().multiplyScalar(ht - insetT)),
        ].map(p => { p.y = cutHeight; return p })

        for (let i = 0; i < 4; i++) {
            const a = projectPoint(innerCorners[i], camera, frustumWidth, frustumHeight)
            const b = projectPoint(innerCorners[(i + 1) % 4], camera, frustumWidth, frustumHeight)
            edges.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, color: opts.lineColor, depth, layer: 0 })
        }
    }

    return { edges, polygons }
}

/**
 * Render plan SVG from detailed mesh geometry
 */
function renderPlanFromMeshes(
    context: DoorContext,
    opts: Required<SVGRenderOptions>
): string {
    const renderMeshes = getDoorMeshes(context)
    if (renderMeshes.length === 0) {
        throw new Error('No meshes available for rendering')
    }

    const frame = context.viewFrame
    const cutHeight = frame.origin.y - frame.height / 2 + 1.2
    const margin = Math.max(opts.margin, 0.5)
    const frustumWidth = frame.width + margin * 2
    const frustumHeight = frame.width * 2 + frame.thickness + margin * 2

    const camera = new THREE.OrthographicCamera(
        -frustumWidth / 2, frustumWidth / 2, frustumHeight / 2, -frustumHeight / 2, 0.1, 100
    )

    const planUp = frame.semanticFacing.clone().negate()
    const planCenter = frame.origin.clone()
    camera.position.copy(planCenter).add(frame.upAxis.clone().multiplyScalar(50))
    camera.up.copy(planUp)
    camera.lookAt(planCenter)
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()

    const showPlanSwing = shouldRenderPlanSwing(frame)
    const flipArc = showPlanSwing ? shouldFlipPlanArc(context, frame) : false

    const renderGeometry = collectProjectedGeometry(renderMeshes, context, opts, camera, frustumWidth, frustumHeight, true, 0)
    const deviceGeometry = createSemanticPlanDeviceGeometry(context, camera, frustumWidth, frustumHeight, cutHeight, opts)
    renderGeometry.edges.push(...deviceGeometry.edges)
    renderGeometry.polygons.push(...deviceGeometry.polygons)

    // Synthetic door cross-section rectangle – always added so the door is visible
    // even when the web-ifc mesh produces degenerate edges at cut height.
    const syntheticEdges = buildDoorCrossSectionEdges(frame, camera, frustumWidth, frustumHeight, cutHeight, opts)
    renderGeometry.edges.push(...syntheticEdges)

    const hasDetailedDoorFill = renderGeometry.polygons.some((polygon) => polygon.color === opts.doorColor)
    if (!hasDetailedDoorFill) {
        const fallbackGeometry = buildDoorCrossSectionFallbackGeometry(frame, camera, frustumWidth, frustumHeight, cutHeight, opts)
        renderGeometry.polygons.push(...fallbackGeometry.polygons)
        renderGeometry.edges.push(...fallbackGeometry.edges)
    }

    if (showPlanSwing && context.openingDirection) {
        const arcEdges = calculateSwingArcEdges(context, frame, camera, frustumWidth, frustumHeight, cutHeight, flipArc)
        renderGeometry.edges.push(...arcEdges)
    }

    // Compute fitGeometry analytically from frame data.
    // Using projected mesh geometry for fitBounds is unreliable: web-ifc meshes viewed from above
    // often produce degenerate edges, and arc edges may be at different positions than the door mesh.
    // Instead, project the semantic corners of the door + arc envelope directly.
    const arcParams = context.openingDirection ? parseOperationType(context.openingDirection) : null
    const hasSwingArc = showPlanSwing && arcParams?.type === 'swing' && !!arcParams.hingeSide
    const halfW = frame.width / 2
    // openAxisFit must match the arc direction so the fit bounds contain both the door and the arc.
    const openAxisFit = flipArc ? frame.semanticFacing.clone().negate() : frame.semanticFacing.clone()
    const arcReach = hasSwingArc ? frame.width : frame.thickness / 2

    const fitPoint = (p: THREE.Vector3): ProjectedEdge => {
        const proj = projectPoint(p, camera, frustumWidth, frustumHeight)
        return { x1: proj.x, y1: proj.y, x2: proj.x, y2: proj.y, color: 'none', depth: 0, layer: 0 }
    }

    const fitGeometry = {
        edges: [
            // Door outline corners (back and front)
            fitPoint(frame.origin.clone().sub(frame.widthAxis.clone().multiplyScalar(halfW)).sub(frame.semanticFacing.clone().multiplyScalar(frame.thickness / 2))),
            fitPoint(frame.origin.clone().add(frame.widthAxis.clone().multiplyScalar(halfW)).sub(frame.semanticFacing.clone().multiplyScalar(frame.thickness / 2))),
            fitPoint(frame.origin.clone().sub(frame.widthAxis.clone().multiplyScalar(halfW)).add(frame.semanticFacing.clone().multiplyScalar(frame.thickness / 2))),
            fitPoint(frame.origin.clone().add(frame.widthAxis.clone().multiplyScalar(halfW)).add(frame.semanticFacing.clone().multiplyScalar(frame.thickness / 2))),
            // Arc envelope corners (full reach in openAxisFit direction)
            fitPoint(frame.origin.clone().sub(frame.widthAxis.clone().multiplyScalar(halfW)).add(openAxisFit.clone().multiplyScalar(arcReach))),
            fitPoint(frame.origin.clone().add(frame.widthAxis.clone().multiplyScalar(halfW)).add(openAxisFit.clone().multiplyScalar(arcReach))),
            ...deviceGeometry.edges,
        ],
        polygons: [...deviceGeometry.polygons],
    }

    return generateSVGString(
        renderGeometry.edges,
        renderGeometry.polygons,
        opts,
        fitGeometry,
        {
            context,
            viewType: 'Plan',
            planArcFlip: flipArc,
        }
    )
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

    const scaledWidth = doorWidth * scale
    const scaledThickness = doorThickness * scale
    const offsetX = (svgWidth - scaledWidth) / 2
    const offsetY = padding + (availableHeight - scaledThickness) / 2
    const hasWall = Boolean(context.hostWall?.boundingBox)
    const wallRevealSvg = hasWall
        ? renderWallRevealSvg(
            getWallRevealRects({
                bounds: {
                    minX: padding,
                    maxX: svgWidth - padding,
                    minY: padding,
                    maxY: padding + availableHeight,
                },
                offsetX,
                offsetY,
                scaledWidth,
                scaledHeight: scaledThickness,
                wallRevealSide: opts.wallRevealSide,
                wallRevealTop: opts.wallRevealTop,
                viewType: 'Plan',
                wallThicknessPx: Math.max(scaledThickness, 12),
                planArcFlip: false,
            }),
            wallColor,
            lineColor,
            lineWidth
        )
        : ''

    const arrowY = offsetY + scaledThickness + 30
    const arrowEndY = arrowY + 25

    let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">
  <rect width="100%" height="100%" fill="${backgroundColor}"/>
${wallRevealSvg}

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
