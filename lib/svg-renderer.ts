import * as THREE from 'three'
import type { DoorContext, DoorViewFrame } from './door-analyzer'
import { getDoorMeshes, getDoorOperationInfo, getHostSlabMeshes, getHostWallMeshes, getNearbyWallMeshes } from './door-analyzer'
import {
    INTER_WOFF2_LATIN_400_BASE64,
    INTER_WOFF2_LATIN_600_BASE64,
    INTER_WOFF2_LATIN_700_BASE64,
} from './inter-svg-font-embed-data'

export interface SVGRenderOptions {
    width?: number
    height?: number
    margin?: number // meters
    doorColor?: string
    wallColor?: string
    floorSlabColor?: string
    deviceColor?: string
    /** Fill color for glazing in Vorder-/Rückansicht only; Grundriss uses `doorColor` for those meshes. */
    glassColor?: string
    /** Opacity for glazing fills in Ansichten (0–1); ignored im Grundriss (gleiche Opacity wie übrige Türfläche). */
    glassFillOpacity?: number
    backgroundColor?: string // Background color for area outside door
    lineWidth?: number
    lineColor?: string
    showFills?: boolean
    showLegend?: boolean
    showLabels?: boolean
    /** Pixel size for all SVG title block and label text */
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

/** Default typeface for SVG text; kept in sync with `next/font` Inter in `app/layout.tsx`. */
export const DEFAULT_SVG_FONT_FAMILY = 'Inter' as const

/**
 * Embeds Inter (latin subset, wght 400/600/700) as data URLs so SVG text renders
 * the same in Airtable, <img>, and offline — no external font fetch.
 */
function svgWebFontDefs(fontFamily: string): string {
    if (fontFamily.trim() !== DEFAULT_SVG_FONT_FAMILY) {
        return ''
    }
    const b400 = INTER_WOFF2_LATIN_400_BASE64
    const b600 = INTER_WOFF2_LATIN_600_BASE64
    const b700 = INTER_WOFF2_LATIN_700_BASE64
    return `  <defs>
    <style type="text/css"><![CDATA[
@font-face{font-family:'Inter';font-style:normal;font-weight:400;font-display:swap;src:url('data:font/woff2;base64,${b400}') format('woff2');}
@font-face{font-family:'Inter';font-style:normal;font-weight:600;font-display:swap;src:url('data:font/woff2;base64,${b600}') format('woff2');}
@font-face{font-family:'Inter';font-style:normal;font-weight:700;font-display:swap;src:url('data:font/woff2;base64,${b700}') format('woff2');}
]]></style>
  </defs>
`
}

/** Plan SVG canvas height = `width × PLAN_SVG_HEIGHT_RATIO` (Grundriss is wider-than-tall, not square). */
export const PLAN_SVG_HEIGHT_RATIO = 0.5

export function planSvgCanvasHeight(canvasWidth: number): number {
    return Math.round(canvasWidth * PLAN_SVG_HEIGHT_RATIO)
}

const DEFAULT_OPTIONS: Required<SVGRenderOptions> = {
    width: 1000,
    height: 1000,
    margin: 0.5,
    doorColor: '#dedede',
    wallColor: '#e3e3e3',
    floorSlabColor: '#e3e3e3',
    deviceColor: '#fcc647',
    glassColor: '#b8d4e8',
    glassFillOpacity: 0.32,
    backgroundColor: '#fff', // Light gray background
    lineWidth: 1.5,
    lineColor: '#000000',
    showFills: true,
    showLegend: true,
    showLabels: true,
    fontSize: 22,
    fontFamily: DEFAULT_SVG_FONT_FAMILY,
    wallRevealSide: 0.12,
    wallRevealTop: 0.04,
}

function normalizeRenderOptions(options: SVGRenderOptions = {}): Required<SVGRenderOptions> {
    const merged = { ...DEFAULT_OPTIONS, ...options }
    return {
        ...merged,
        floorSlabColor: options.floorSlabColor ?? merged.wallColor,
    }
}

interface ProjectedEdge {
    x1: number
    y1: number
    x2: number
    y2: number
    color: string
    depth: number
    layer: number
    skipClip?: boolean
    strokeWidthFactor?: number
    isDashed?: boolean  // For door swing arcs (dashed line style)
}

interface ProjectedPolygon {
    points: { x: number; y: number }[]
    color: string
    depth: number
    layer: number
    skipClip?: boolean
    fillOpacity?: number
}

type PolygonCullMode = 'camera-facing' | 'none'

interface AxisBounds {
    minA: number
    maxA: number
    minB: number
    maxB: number
    minC: number
    maxC: number
}

const HOST_WALL_PERPENDICULAR_CROP_METERS = 1.0
const DOOR_EDGE_STROKE_FACTOR = 0.85
const WALL_EDGE_STROKE_FACTOR = 1.15
const DEVICE_EDGE_STROKE_FACTOR = 1.0
const CONTEXT_DOOR_EDGE_STROKE_FACTOR = 0.55
const CONTEXT_DOOR_FILL_COLOR = '#d1d5db'
const CONTEXT_DOOR_LINE_COLOR = '#6b7280'
const CONTEXT_DOOR_FILL_OPACITY = 0.32

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
 * True if the mesh looks like a thin in-plane sheet (typical glazing) vs. frame/solid leaf.
 * Uses axis-aligned bounds in world space; smallest extent must be ≤ 0.5 cm.
 */
function isLikelyGlazingPanelMesh(mesh: THREE.Mesh): boolean {
    mesh.updateMatrixWorld()
    const geom = mesh.geometry
    if (!geom.boundingBox) geom.computeBoundingBox()
    const bb = geom.boundingBox!.clone()
    bb.applyMatrix4(mesh.matrixWorld)
    const size = new THREE.Vector3()
    bb.getSize(size)
    const dMin = Math.min(size.x, size.y, size.z)
    const maxThickness = 0.005 // 0.5 cm — smallest AABB extent must not exceed this to count as glazing
    return dMin <= maxThickness
}

/**
 * Fill color and optional per-mesh opacity for projected polygons.
 * @param useGlassStyling — If false (Grundriss), glazing uses the same fill as the door; if true (Ansichten), `glassColor` / `glassFillOpacity` apply.
 */
function getMeshPolygonStyle(
    mesh: THREE.Mesh,
    expressID: number,
    context: DoorContext,
    options: Required<SVGRenderOptions>,
    useGlassStyling: boolean
): { color: string; fillOpacity?: number } {
    const isHostSlab =
        context.hostSlabsBelow.some((slab) => slab.expressID === expressID)
        || context.hostSlabsAbove.some((slab) => slab.expressID === expressID)
    if (expressID === context.door.expressID) {
        if (useGlassStyling && isLikelyGlazingPanelMesh(mesh)) {
            return { color: options.glassColor, fillOpacity: options.glassFillOpacity }
        }
        return { color: options.doorColor }
    }
    if (isHostSlab) {
        return { color: options.floorSlabColor }
    }
    if (
        (context.hostWall && expressID === context.hostWall.expressID)
        || (context.wall && expressID === context.wall.expressID)
    ) {
        return { color: options.wallColor }
    }
    return { color: options.deviceColor }
}

function hasVisibleSlabsForView(
    context: DoorContext | null,
    viewType: 'Front' | 'Back' | 'Plan' | ''
): boolean {
    if (!context || viewType === 'Plan') {
        return false
    }
    return context.hostSlabsBelow.length > 0 || context.hostSlabsAbove.length > 0
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
    layer: number = 0,
    strokeWidthFactor: number = 1
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
                    layer,
                    strokeWidthFactor,
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
                layer,
                strokeWidthFactor,
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
    layer: number = 0,
    cullMode: PolygonCullMode = 'camera-facing',
    fillOpacity?: number
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

        // Elevation fills should not disappear just because the camera flips to the
        // opposite side of a thin or single-sided mesh (common for glazing panels).
        if (cullMode === 'camera-facing' && faceNormal.dot(cameraDir) > 0.1) {
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

        const poly: ProjectedPolygon = {
            points: [
                { x: proj1.x, y: proj1.y },
                { x: proj2.x, y: proj2.y },
                { x: proj3.x, y: proj3.y }
            ],
            color,
            depth,
            layer,
        }
        if (fillOpacity !== undefined) {
            poly.fillOpacity = fillOpacity
        }
        polygons.push(poly)
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
    layer: number,
    polygonCullMode: PolygonCullMode = 'camera-facing',
    /** Grundriss: false (Glas = Türfarbe); Vorder-/Rückansicht: true */
    useGlassStyling: boolean = true,
    edgeStrokeWidthFactor: number = 1
): { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] } {
    const edges: ProjectedEdge[] = []
    const polygons: ProjectedPolygon[] = []

    for (const mesh of meshes) {
        try {
            const expressID = mesh.userData.expressID
            const { color, fillOpacity } = getMeshPolygonStyle(
                mesh,
                expressID,
                context,
                options,
                useGlassStyling
            )
            const posCount = mesh.geometry?.attributes?.position?.count || 0
            if (posCount === 0) continue

            edges.push(...extractEdges(mesh, camera, options.lineColor, width, height, clipZ, layer, edgeStrokeWidthFactor))

            if (options.showFills) {
                polygons.push(...extractPolygons(mesh, camera, color, width, height, layer, polygonCullMode, fillOpacity))
            }
        } catch (error) {
            console.warn('Failed to extract geometry from mesh:', error)
        }
    }

    return { edges, polygons }
}

function getHostContextMeshes(context: DoorContext): THREE.Mesh[] {
    return [
        ...getHostWallMeshes(context),
        ...getHostSlabMeshes(context),
    ]
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

function measureMeshesInAxes(
    meshes: THREE.Mesh[],
    axisA: THREE.Vector3,
    axisB: THREE.Vector3,
    axisC: THREE.Vector3
): AxisBounds | null {
    let minA = Infinity
    let maxA = -Infinity
    let minB = Infinity
    let maxB = -Infinity
    let minC = Infinity
    let maxC = -Infinity
    const point = new THREE.Vector3()

    for (const mesh of meshes) {
        const geometry = mesh.geometry as THREE.BufferGeometry | undefined
        const positions = geometry?.getAttribute('position')
        if (!geometry || !positions || positions.count === 0) continue

        mesh.updateMatrixWorld(true)
        const index = geometry.getIndex()
        const projectVertex = (vertexIndex: number) => {
            point
                .set(positions.getX(vertexIndex), positions.getY(vertexIndex), positions.getZ(vertexIndex))
                .applyMatrix4(mesh.matrixWorld)
            const a = point.dot(axisA)
            const b = point.dot(axisB)
            const c = point.dot(axisC)
            minA = Math.min(minA, a)
            maxA = Math.max(maxA, a)
            minB = Math.min(minB, b)
            maxB = Math.max(maxB, b)
            minC = Math.min(minC, c)
            maxC = Math.max(maxC, c)
        }

        if (index && index.count > 0) {
            for (let i = 0; i < index.count; i++) {
                projectVertex(index.getX(i))
            }
        } else {
            for (let i = 0; i < positions.count; i++) {
                projectVertex(i)
            }
        }
    }

    if (minA === Infinity) return null
    return { minA, maxA, minB, maxB, minC, maxC }
}

function getHostWallAxisBounds(
    context: DoorContext,
    axisA: THREE.Vector3,
    axisB: THREE.Vector3,
    axisC: THREE.Vector3
): AxisBounds | null {
    const wallMeshes = getHostWallMeshes(context)
    const frame = context.viewFrame
    const originDepth = frame.origin.dot(frame.semanticFacing)
    const point = new THREE.Vector3()
    let minA = Infinity
    let maxA = -Infinity
    let minB = Infinity
    let maxB = -Infinity
    let minC = Infinity
    let maxC = -Infinity

    const includePoint = (candidate: THREE.Vector3) => {
        const localDepth = candidate.dot(frame.semanticFacing) - originDepth
        if (Math.abs(localDepth) > HOST_WALL_PERPENDICULAR_CROP_METERS) {
            return
        }

        const a = candidate.dot(axisA)
        const b = candidate.dot(axisB)
        const c = candidate.dot(axisC)
        minA = Math.min(minA, a)
        maxA = Math.max(maxA, a)
        minB = Math.min(minB, b)
        maxB = Math.max(maxB, b)
        minC = Math.min(minC, c)
        maxC = Math.max(maxC, c)
    }

    for (const mesh of wallMeshes) {
        const geometry = mesh.geometry as THREE.BufferGeometry | undefined
        const positions = geometry?.getAttribute('position')
        if (!geometry || !positions || positions.count === 0) continue

        mesh.updateMatrixWorld(true)
        const index = geometry.getIndex()
        const projectVertex = (vertexIndex: number) => {
            point
                .set(positions.getX(vertexIndex), positions.getY(vertexIndex), positions.getZ(vertexIndex))
                .applyMatrix4(mesh.matrixWorld)
            includePoint(point)
        }

        if (index && index.count > 0) {
            for (let i = 0; i < index.count; i++) {
                projectVertex(index.getX(i))
            }
        } else {
            for (let i = 0; i < positions.count; i++) {
                projectVertex(i)
            }
        }
    }

    const meshBounds = minA !== Infinity
        ? { minA, maxA, minB, maxB, minC, maxC }
        : (wallMeshes.length > 0 ? measureMeshesInAxes(wallMeshes, axisA, axisB, axisC) : null)
    if (meshBounds) {
        return meshBounds
    }

    const wallBox = context.hostWall?.boundingBox
    return wallBox ? measureBoundingBoxInAxes(wallBox, axisA, axisB, axisC) : null
}

function getLocalHostWallPlanMetrics(context: DoorContext): { minDepth: number; maxDepth: number; thickness: number } | null {
    const frame = context.viewFrame
    const bounds = getHostWallAxisBounds(context, frame.widthAxis, frame.semanticFacing, frame.upAxis)
    if (!bounds) return null

    const originDepth = frame.origin.dot(frame.semanticFacing)
    const minDepth = bounds.minB - originDepth
    const maxDepth = bounds.maxB - originDepth
    return {
        minDepth,
        maxDepth,
        thickness: Math.max(maxDepth - minDepth, frame.thickness),
    }
}

function getElevationTopBandGapMeters(context: DoorContext): number | null {
    const wallMeshes = getHostWallMeshes(context)
    if (wallMeshes.length === 0) return null

    const frame = context.viewFrame
    const originWidth = frame.origin.dot(frame.widthAxis)
    const originUp = frame.origin.dot(frame.upAxis)
    const halfDoorWidth = frame.width / 2 + 0.02
    const doorTop = frame.height / 2
    const pointA = new THREE.Vector3()
    const pointB = new THREE.Vector3()
    const pointC = new THREE.Vector3()
    let minHeaderBottom = Infinity

    for (const mesh of wallMeshes) {
        const geometry = mesh.geometry as THREE.BufferGeometry | undefined
        const positions = geometry?.getAttribute('position')
        if (!geometry || !positions || positions.count === 0) continue

        mesh.updateMatrixWorld(true)
        const index = geometry.getIndex()
        const processTriangle = (i1: number, i2: number, i3: number) => {
            pointA.set(positions.getX(i1), positions.getY(i1), positions.getZ(i1)).applyMatrix4(mesh.matrixWorld)
            pointB.set(positions.getX(i2), positions.getY(i2), positions.getZ(i2)).applyMatrix4(mesh.matrixWorld)
            pointC.set(positions.getX(i3), positions.getY(i3), positions.getZ(i3)).applyMatrix4(mesh.matrixWorld)

            const localDepths = [
                pointA.dot(frame.semanticFacing) - frame.origin.dot(frame.semanticFacing),
                pointB.dot(frame.semanticFacing) - frame.origin.dot(frame.semanticFacing),
                pointC.dot(frame.semanticFacing) - frame.origin.dot(frame.semanticFacing),
            ]
            if (
                Math.min(...localDepths) > HOST_WALL_PERPENDICULAR_CROP_METERS
                || Math.max(...localDepths) < -HOST_WALL_PERPENDICULAR_CROP_METERS
            ) {
                return
            }

            const normal = pointB.clone().sub(pointA).cross(pointC.clone().sub(pointA)).normalize()
            if (Math.abs(normal.dot(frame.upAxis)) < 0.9) return

            const localWidthValues = [
                pointA.dot(frame.widthAxis) - originWidth,
                pointB.dot(frame.widthAxis) - originWidth,
                pointC.dot(frame.widthAxis) - originWidth,
            ]
            const widthMin = Math.min(...localWidthValues)
            const widthMax = Math.max(...localWidthValues)
            if (widthMax < -halfDoorWidth || widthMin > halfDoorWidth) return

            const localUpValues = [
                pointA.dot(frame.upAxis) - originUp,
                pointB.dot(frame.upAxis) - originUp,
                pointC.dot(frame.upAxis) - originUp,
            ]
            const faceBottom = Math.min(...localUpValues)
            if (faceBottom <= doorTop + 0.01) return

            minHeaderBottom = Math.min(minHeaderBottom, faceBottom)
        }

        if (index && index.count > 0) {
            for (let i = 0; i < index.count; i += 3) {
                processTriangle(index.getX(i), index.getX(i + 1), index.getX(i + 2))
            }
        } else {
            for (let i = 0; i < positions.count; i += 3) {
                processTriangle(i, i + 1, i + 2)
            }
        }
    }

    if (!Number.isFinite(minHeaderBottom)) return null
    return Math.max(0, minHeaderBottom - doorTop)
}

function getElevationTopContextGapMeters(context: DoorContext): number {
    const gaps: number[] = []
    const wallGap = getElevationTopBandGapMeters(context)
    if (wallGap !== null) {
        gaps.push(wallGap)
    }

    for (const slab of context.hostSlabsAbove) {
        const slabAboveBox = slab.boundingBox
        if (!slabAboveBox) continue
        const frame = context.viewFrame
        const slabBounds = measureBoundingBoxInAxes(
            slabAboveBox,
            frame.widthAxis,
            frame.upAxis,
            frame.semanticFacing
        )
        const doorTop = frame.origin.dot(frame.upAxis) + frame.height / 2
        const slabGap = slabBounds.minB - doorTop
        if (Number.isFinite(slabGap) && slabGap >= 0) {
            gaps.push(slabGap)
        }
    }

    return gaps.length > 0 ? Math.min(...gaps) : 0
}

function getElevationBottomContextGapMeters(context: DoorContext): number {
    const frame = context.viewFrame
    const doorBottom = frame.origin.dot(frame.upAxis) - frame.height / 2
    const slabBoundsBelow: Array<{ minB: number; maxB: number }> = []

    for (const slab of context.hostSlabsBelow) {
        const slabBelowBox = slab.boundingBox
        if (!slabBelowBox) continue
        const slabBounds = measureBoundingBoxInAxes(
            slabBelowBox,
            frame.widthAxis,
            frame.upAxis,
            frame.semanticFacing
        )
        if (!Number.isFinite(slabBounds.minB) || !Number.isFinite(slabBounds.maxB)) continue
        if (slabBounds.maxB <= doorBottom + 1e-4) {
            slabBoundsBelow.push(slabBounds)
        }
    }

    if (slabBoundsBelow.length === 0) return 0

    const STACK_TOLERANCE_METERS = 0.03
    const closestTop = Math.max(...slabBoundsBelow.map((bounds) => bounds.maxB))
    let stackBottom = doorBottom
    let cursorTop = closestTop

    while (true) {
        const contiguousLayer = slabBoundsBelow.filter(
            (bounds) => Math.abs(bounds.maxB - cursorTop) <= STACK_TOLERANCE_METERS
        )
        if (contiguousLayer.length === 0) {
            break
        }

        const nextBottom = Math.min(...contiguousLayer.map((bounds) => bounds.minB))
        if (nextBottom >= stackBottom - 1e-4) {
            break
        }

        stackBottom = nextBottom
        cursorTop = nextBottom
    }

    return Math.max(0, doorBottom - stackBottom)
}

function hostWallHasMaterialInRect(
    context: DoorContext,
    axisA: THREE.Vector3,
    axisB: THREE.Vector3,
    rect: { minA: number; maxA: number; minB: number; maxB: number }
): boolean {
    const wallMeshes = getHostWallMeshes(context)
    if (wallMeshes.length === 0) {
        return Boolean(context.hostWall?.boundingBox)
    }

    const pointA = new THREE.Vector3()
    const pointB = new THREE.Vector3()
    const pointC = new THREE.Vector3()

    const triangleOverlapsRect = (a1: number, a2: number, a3: number, b1: number, b2: number, b3: number): boolean => {
        const triMinA = Math.min(a1, a2, a3)
        const triMaxA = Math.max(a1, a2, a3)
        const triMinB = Math.min(b1, b2, b3)
        const triMaxB = Math.max(b1, b2, b3)
        return triMaxA >= rect.minA && triMinA <= rect.maxA && triMaxB >= rect.minB && triMinB <= rect.maxB
    }

    for (const mesh of wallMeshes) {
        const geometry = mesh.geometry as THREE.BufferGeometry | undefined
        const positions = geometry?.getAttribute('position')
        if (!geometry || !positions || positions.count === 0) continue

        mesh.updateMatrixWorld(true)
        const index = geometry.getIndex()

        const processTriangle = (i1: number, i2: number, i3: number): boolean => {
            pointA.set(positions.getX(i1), positions.getY(i1), positions.getZ(i1)).applyMatrix4(mesh.matrixWorld)
            pointB.set(positions.getX(i2), positions.getY(i2), positions.getZ(i2)).applyMatrix4(mesh.matrixWorld)
            pointC.set(positions.getX(i3), positions.getY(i3), positions.getZ(i3)).applyMatrix4(mesh.matrixWorld)

            const originDepth = context.viewFrame.origin.dot(context.viewFrame.semanticFacing)
            const localDepths = [
                pointA.dot(context.viewFrame.semanticFacing) - originDepth,
                pointB.dot(context.viewFrame.semanticFacing) - originDepth,
                pointC.dot(context.viewFrame.semanticFacing) - originDepth,
            ]
            if (
                Math.min(...localDepths) > HOST_WALL_PERPENDICULAR_CROP_METERS
                || Math.max(...localDepths) < -HOST_WALL_PERPENDICULAR_CROP_METERS
            ) {
                return false
            }

            return triangleOverlapsRect(
                pointA.dot(axisA),
                pointB.dot(axisA),
                pointC.dot(axisA),
                pointA.dot(axisB),
                pointB.dot(axisB),
                pointC.dot(axisB)
            )
        }

        if (index && index.count > 0) {
            for (let i = 0; i < index.count; i += 3) {
                if (processTriangle(index.getX(i), index.getX(i + 1), index.getX(i + 2))) {
                    return true
                }
            }
        } else {
            for (let i = 0; i < positions.count; i += 3) {
                if (processTriangle(i, i + 1, i + 2)) {
                    return true
                }
            }
        }
    }

    return false
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

type AxisRect = {
    minA: number
    maxA: number
    minB: number
    maxB: number
}

function rangesOverlapOrTouch(
    minA: number,
    maxA: number,
    minB: number,
    maxB: number,
    tolerance: number = 0
): boolean {
    return Math.min(maxA, maxB) >= Math.max(minA, minB) - tolerance
}

function appendProjectedFillPolygon(
    geometry: { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] },
    points3D: THREE.Vector3[],
    camera: THREE.OrthographicCamera,
    width: number,
    height: number,
    fillColor: string,
    layer: number,
    fillOpacity: number = 1
): void {
    const projected = points3D.map((point) => projectPoint(point, camera, width, height))
    const depth = projected.reduce((sum, point) => sum + point.z, 0) / projected.length

    geometry.polygons.push({
        points: projected.map((point) => ({ x: point.x, y: point.y })),
        color: fillColor,
        depth,
        layer,
        fillOpacity,
    })
}

function appendProjectedEdge(
    geometry: { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] },
    start: THREE.Vector3,
    end: THREE.Vector3,
    camera: THREE.OrthographicCamera,
    width: number,
    height: number,
    color: string,
    layer: number,
    strokeWidthFactor: number = 1
): void {
    const projectedStart = projectPoint(start, camera, width, height)
    const projectedEnd = projectPoint(end, camera, width, height)
    geometry.edges.push({
        x1: projectedStart.x,
        y1: projectedStart.y,
        x2: projectedEnd.x,
        y2: projectedEnd.y,
        color,
        depth: (projectedStart.z + projectedEnd.z) / 2,
        layer,
        strokeWidthFactor,
    })
}

function appendProjectedPolygon(
    geometry: { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] },
    points3D: THREE.Vector3[],
    camera: THREE.OrthographicCamera,
    width: number,
    height: number,
    fillColor: string,
    strokeColor: string,
    layer: number,
    fillOpacity: number = 1,
    strokeWidthFactor: number = 1
): void {
    const projected = points3D.map((point) => projectPoint(point, camera, width, height))
    const depth = projected.reduce((sum, point) => sum + point.z, 0) / projected.length

    geometry.polygons.push({
        points: projected.map((point) => ({ x: point.x, y: point.y })),
        color: fillColor,
        depth,
        layer,
        fillOpacity,
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
            strokeWidthFactor,
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

    const frame = context.viewFrame
    const wallBounds = getHostWallAxisBounds(context, frame.widthAxis, frame.upAxis, frame.semanticFacing)
    if (!wallBounds) return geometry

    const wallThickness = Math.max(wallBounds.maxC - wallBounds.minC, frame.thickness)
    const sideReveal = THREE.MathUtils.clamp(wallThickness * 0.75, 0.08, 0.18)
    const topReveal = THREE.MathUtils.clamp(wallThickness * 0.75, 0.08, 0.18)
    const halfDoorWidth = frame.width / 2
    const bottom = -frame.height / 2
    const topGap = getElevationTopBandGapMeters(context) ?? 0
    const top = frame.height / 2 + topGap
    const outerTop = top + topReveal

    const rects: THREE.Vector3[][] = []
    if (hostWallHasMaterialInRect(context, frame.widthAxis, frame.upAxis, {
        minA: frame.origin.dot(frame.widthAxis) - halfDoorWidth - sideReveal,
        maxA: frame.origin.dot(frame.widthAxis) - halfDoorWidth + 0.01,
        minB: frame.origin.dot(frame.upAxis) + bottom,
        maxB: frame.origin.dot(frame.upAxis) + top,
    })) {
        rects.push(createRectPoints3D(frame.origin, frame.widthAxis, frame.upAxis, -halfDoorWidth - sideReveal, -halfDoorWidth, bottom, outerTop))
    }
    if (hostWallHasMaterialInRect(context, frame.widthAxis, frame.upAxis, {
        minA: frame.origin.dot(frame.widthAxis) + halfDoorWidth - 0.01,
        maxA: frame.origin.dot(frame.widthAxis) + halfDoorWidth + sideReveal,
        minB: frame.origin.dot(frame.upAxis) + bottom,
        maxB: frame.origin.dot(frame.upAxis) + top,
    })) {
        rects.push(createRectPoints3D(frame.origin, frame.widthAxis, frame.upAxis, halfDoorWidth, halfDoorWidth + sideReveal, bottom, outerTop))
    }
    if (hostWallHasMaterialInRect(context, frame.widthAxis, frame.upAxis, {
        minA: frame.origin.dot(frame.widthAxis) - halfDoorWidth,
        maxA: frame.origin.dot(frame.widthAxis) + halfDoorWidth,
        minB: frame.origin.dot(frame.upAxis) + top - 0.01,
        maxB: frame.origin.dot(frame.upAxis) + outerTop,
    })) {
        rects.push(createRectPoints3D(frame.origin, frame.widthAxis, frame.upAxis, -halfDoorWidth, halfDoorWidth, top, outerTop))
    }

    for (const rect of rects) {
        appendProjectedPolygon(geometry, rect, camera, width, height, options.wallColor, options.lineColor, -1, 1, WALL_EDGE_STROKE_FACTOR)
    }

    return geometry
}

function createSemanticElevationSlabGeometry(
    context: DoorContext,
    camera: THREE.OrthographicCamera,
    width: number,
    height: number,
    options: Required<SVGRenderOptions>
): { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] } {
    const geometry = { edges: [], polygons: [] } as { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] }
    const frame = context.viewFrame
    const seenSlabIDs = new Set<number>()
    const slabRects: AxisRect[] = []
    const BAND_TOLERANCE_METERS = 0.01
    const SPAN_TOLERANCE_METERS = 0.02

    for (const slab of [...context.hostSlabsBelow, ...context.hostSlabsAbove]) {
        if (seenSlabIDs.has(slab.expressID)) continue
        seenSlabIDs.add(slab.expressID)

        const slabBox = slab.boundingBox
        if (!slabBox) continue

        const slabBounds = measureBoundingBoxInAxes(
            slabBox,
            frame.widthAxis,
            frame.upAxis,
            frame.semanticFacing
        )
        if (
            !Number.isFinite(slabBounds.minA)
            || !Number.isFinite(slabBounds.maxA)
            || !Number.isFinite(slabBounds.minB)
            || !Number.isFinite(slabBounds.maxB)
            || slabBounds.maxA <= slabBounds.minA
            || slabBounds.maxB <= slabBounds.minB
        ) {
            continue
        }

        slabRects.push({
            minA: slabBounds.minA,
            maxA: slabBounds.maxA,
            minB: slabBounds.minB,
            maxB: slabBounds.maxB,
        })
    }

    const mergedRects = slabRects
        .map((rect) => ({ ...rect }))
        .sort((a, b) => a.minB - b.minB || a.maxB - b.maxB || a.minA - b.minA)

    let changed = true
    while (changed) {
        changed = false
        for (let i = 0; i < mergedRects.length; i++) {
            for (let j = i + 1; j < mergedRects.length; j++) {
                const current = mergedRects[i]
                const candidate = mergedRects[j]
                const sameBand =
                    Math.abs(current.minB - candidate.minB) <= BAND_TOLERANCE_METERS
                    && Math.abs(current.maxB - candidate.maxB) <= BAND_TOLERANCE_METERS
                const touchingSpan = rangesOverlapOrTouch(
                    current.minA,
                    current.maxA,
                    candidate.minA,
                    candidate.maxA,
                    SPAN_TOLERANCE_METERS
                )
                if (!sameBand || !touchingSpan) continue

                current.minA = Math.min(current.minA, candidate.minA)
                current.maxA = Math.max(current.maxA, candidate.maxA)
                current.minB = Math.min(current.minB, candidate.minB)
                current.maxB = Math.max(current.maxB, candidate.maxB)
                mergedRects.splice(j, 1)
                changed = true
                break
            }
            if (changed) break
        }
    }

    const originA = frame.origin.dot(frame.widthAxis)
    const originB = frame.origin.dot(frame.upAxis)
    for (const rect of mergedRects) {
        const corners = createRectPoints3D(
            frame.origin,
            frame.widthAxis,
            frame.upAxis,
            rect.minA - originA,
            rect.maxA - originA,
            rect.minB - originB,
            rect.maxB - originB
        )

        appendProjectedFillPolygon(
            geometry,
            corners,
            camera,
            width,
            height,
            options.floorSlabColor,
            -1,
            1
        )

        appendProjectedEdge(geometry, corners[3], corners[2], camera, width, height, options.lineColor, -1, WALL_EDGE_STROKE_FACTOR)
        appendProjectedEdge(geometry, corners[0], corners[1], camera, width, height, options.lineColor, -1, WALL_EDGE_STROKE_FACTOR)
        appendProjectedEdge(geometry, corners[0], corners[3], camera, width, height, options.lineColor, -1, WALL_EDGE_STROKE_FACTOR)
        appendProjectedEdge(geometry, corners[1], corners[2], camera, width, height, options.lineColor, -1, WALL_EDGE_STROKE_FACTOR)
    }

    return geometry
}

function getNearbyDoorAxisRects(context: DoorContext): AxisRect[] {
    const frame = context.viewFrame
    const originA = frame.origin.dot(frame.widthAxis)
    const originB = frame.origin.dot(frame.upAxis)
    const seenDoorIDs = new Set<number>()
    const rects: AxisRect[] = []

    for (const nearbyDoor of context.nearbyDoors || []) {
        if (seenDoorIDs.has(nearbyDoor.expressID) || !nearbyDoor.boundingBox) {
            continue
        }
        seenDoorIDs.add(nearbyDoor.expressID)

        const bounds = measureBoundingBoxInAxes(
            nearbyDoor.boundingBox,
            frame.widthAxis,
            frame.upAxis,
            frame.semanticFacing
        )
        if (
            !Number.isFinite(bounds.minA)
            || !Number.isFinite(bounds.maxA)
            || !Number.isFinite(bounds.minB)
            || !Number.isFinite(bounds.maxB)
            || bounds.maxA <= bounds.minA
            || bounds.maxB <= bounds.minB
        ) {
            continue
        }

        rects.push({
            minA: bounds.minA - originA,
            maxA: bounds.maxA - originA,
            minB: bounds.minB - originB,
            maxB: bounds.maxB - originB,
        })
    }

    return rects
}

function createSemanticElevationNearbyDoorGeometry(
    context: DoorContext,
    camera: THREE.OrthographicCamera,
    width: number,
    height: number
): { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] } {
    const geometry = { edges: [], polygons: [] } as { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] }
    const frame = context.viewFrame

    for (const rect of getNearbyDoorAxisRects(context)) {
        const outer = createRectPoints3D(
            frame.origin,
            frame.widthAxis,
            frame.upAxis,
            rect.minA,
            rect.maxA,
            rect.minB,
            rect.maxB
        )
        appendProjectedFillPolygon(
            geometry,
            outer,
            camera,
            width,
            height,
            CONTEXT_DOOR_FILL_COLOR,
            -0.25,
            CONTEXT_DOOR_FILL_OPACITY
        )
        appendProjectedEdge(geometry, outer[0], outer[1], camera, width, height, CONTEXT_DOOR_LINE_COLOR, -0.25, CONTEXT_DOOR_EDGE_STROKE_FACTOR)
        appendProjectedEdge(geometry, outer[1], outer[2], camera, width, height, CONTEXT_DOOR_LINE_COLOR, -0.25, CONTEXT_DOOR_EDGE_STROKE_FACTOR)
        appendProjectedEdge(geometry, outer[2], outer[3], camera, width, height, CONTEXT_DOOR_LINE_COLOR, -0.25, CONTEXT_DOOR_EDGE_STROKE_FACTOR)
        appendProjectedEdge(geometry, outer[3], outer[0], camera, width, height, CONTEXT_DOOR_LINE_COLOR, -0.25, CONTEXT_DOOR_EDGE_STROKE_FACTOR)

        const insetX = THREE.MathUtils.clamp((rect.maxA - rect.minA) * 0.08, 0.025, 0.06)
        const insetY = THREE.MathUtils.clamp((rect.maxB - rect.minB) * 0.05, 0.03, 0.08)
        if (rect.maxA - rect.minA > insetX * 2 && rect.maxB - rect.minB > insetY * 2) {
            const inner = createRectPoints3D(
                frame.origin,
                frame.widthAxis,
                frame.upAxis,
                rect.minA + insetX,
                rect.maxA - insetX,
                rect.minB + insetY,
                rect.maxB - insetY
            )
            appendProjectedEdge(geometry, inner[0], inner[1], camera, width, height, CONTEXT_DOOR_LINE_COLOR, -0.25, CONTEXT_DOOR_EDGE_STROKE_FACTOR)
            appendProjectedEdge(geometry, inner[1], inner[2], camera, width, height, CONTEXT_DOOR_LINE_COLOR, -0.25, CONTEXT_DOOR_EDGE_STROKE_FACTOR)
            appendProjectedEdge(geometry, inner[2], inner[3], camera, width, height, CONTEXT_DOOR_LINE_COLOR, -0.25, CONTEXT_DOOR_EDGE_STROKE_FACTOR)
            appendProjectedEdge(geometry, inner[3], inner[0], camera, width, height, CONTEXT_DOOR_LINE_COLOR, -0.25, CONTEXT_DOOR_EDGE_STROKE_FACTOR)
        }
    }

    return geometry
}

function intersectSegmentWithYPlane(a: THREE.Vector3, b: THREE.Vector3, planeY: number): THREE.Vector3 {
    const dy = b.y - a.y
    if (Math.abs(dy) < 1e-9) {
        return a.clone()
    }
    const t = (planeY - a.y) / dy
    return new THREE.Vector3(
        a.x + (b.x - a.x) * t,
        planeY,
        a.z + (b.z - a.z) * t
    )
}

/**
 * Clip a convex polygon in-place against the half-space `axis · p >= plane`
 * (for sign = +1) or `axis · p <= plane` (for sign = −1) using
 * Sutherland–Hodgman. Used to prune mesh-section polygons to the plan-view
 * corridor around the door so that long host walls don't blow up the fit
 * bounds, while still preserving the real footprint near the door.
 */
function clipPolygonAgainstAxisPlane(
    polygon: THREE.Vector3[],
    axis: THREE.Vector3,
    plane: number,
    sign: 1 | -1
): THREE.Vector3[] {
    if (polygon.length === 0) return []
    const output: THREE.Vector3[] = []
    const valueOf = (p: THREE.Vector3) => sign * (p.dot(axis) - plane)
    for (let i = 0; i < polygon.length; i++) {
        const current = polygon[i]
        const previous = polygon[(i + polygon.length - 1) % polygon.length]
        const currentInside = valueOf(current) >= 0
        const previousInside = valueOf(previous) >= 0
        if (currentInside) {
            if (!previousInside) {
                output.push(intersectSegmentWithAxisPlane(previous, current, axis, plane))
            }
            output.push(current.clone())
        } else if (previousInside) {
            output.push(intersectSegmentWithAxisPlane(previous, current, axis, plane))
        }
    }
    return output
}

function intersectSegmentWithAxisPlane(
    a: THREE.Vector3,
    b: THREE.Vector3,
    axis: THREE.Vector3,
    plane: number
): THREE.Vector3 {
    const dA = a.dot(axis)
    const dB = b.dot(axis)
    const denom = dB - dA
    if (Math.abs(denom) < 1e-9) {
        return a.clone()
    }
    const t = (plane - dA) / denom
    return new THREE.Vector3(
        a.x + (b.x - a.x) * t,
        a.y + (b.y - a.y) * t,
        a.z + (b.z - a.z) * t
    )
}

/**
 * 4-half-space corridor expressed in the door's local plan axes. Anything
 * outside this box in world space is pruned from mesh-section geometry before
 * projection so that very long walls don't inflate the viewport.
 */
interface PlanSectionCorridor {
    widthAxis: THREE.Vector3
    depthAxis: THREE.Vector3
    minWidth: number
    maxWidth: number
    minDepth: number
    maxDepth: number
}

function clipPolygonToPlanSectionCorridor(
    polygon: THREE.Vector3[],
    corridor: PlanSectionCorridor
): THREE.Vector3[] {
    let result = polygon
    result = clipPolygonAgainstAxisPlane(result, corridor.widthAxis, corridor.minWidth, 1)
    if (result.length < 3) return []
    result = clipPolygonAgainstAxisPlane(result, corridor.widthAxis, corridor.maxWidth, -1)
    if (result.length < 3) return []
    result = clipPolygonAgainstAxisPlane(result, corridor.depthAxis, corridor.minDepth, 1)
    if (result.length < 3) return []
    result = clipPolygonAgainstAxisPlane(result, corridor.depthAxis, corridor.maxDepth, -1)
    if (result.length < 3) return []
    return result
}

function clipSegmentToPlanSectionCorridor(
    a: THREE.Vector3,
    b: THREE.Vector3,
    corridor: PlanSectionCorridor
): [THREE.Vector3, THREE.Vector3] | null {
    let p1 = a.clone()
    let p2 = b.clone()
    const clipPlane = (
        axis: THREE.Vector3,
        plane: number,
        sign: 1 | -1
    ): boolean => {
        const valueOf = (p: THREE.Vector3) => sign * (p.dot(axis) - plane)
        const v1 = valueOf(p1)
        const v2 = valueOf(p2)
        if (v1 < 0 && v2 < 0) return false
        if (v1 >= 0 && v2 >= 0) return true
        const intersection = intersectSegmentWithAxisPlane(p1, p2, axis, plane)
        if (v1 < 0) p1 = intersection
        else p2 = intersection
        return true
    }
    if (!clipPlane(corridor.widthAxis, corridor.minWidth, 1)) return null
    if (!clipPlane(corridor.widthAxis, corridor.maxWidth, -1)) return null
    if (!clipPlane(corridor.depthAxis, corridor.minDepth, 1)) return null
    if (!clipPlane(corridor.depthAxis, corridor.maxDepth, -1)) return null
    return [p1, p2]
}

/**
 * Extract the 2D boundary segments where `mesh`'s triangles cross the
 * horizontal plane `y = cutY`. Near-coincident segments (shared between
 * neighbouring triangles) are coalesced by quantised-key hashing so each
 * wall-face edge is emitted exactly once. Produces the raw section outline;
 * polygon reconstruction happens separately.
 */
function extractMeshSectionSegments(
    mesh: THREE.Mesh,
    cutY: number
): Array<{ a: THREE.Vector3; b: THREE.Vector3 }> {
    const geometry = mesh.geometry as THREE.BufferGeometry | undefined
    const positions = geometry?.getAttribute('position')
    if (!geometry || !positions || positions.count === 0) return []
    mesh.updateMatrixWorld(true)
    const matrix = mesh.matrixWorld
    const index = geometry.getIndex()

    const segments = new Map<string, { a: THREE.Vector3; b: THREE.Vector3 }>()
    const keyFor = (p: THREE.Vector3) =>
        `${Math.round(p.x * 10000)}_${Math.round(p.z * 10000)}`

    const registerSegment = (a: THREE.Vector3, b: THREE.Vector3) => {
        const keyA = keyFor(a)
        const keyB = keyFor(b)
        if (keyA === keyB) return
        const orderedKey = keyA < keyB ? `${keyA}|${keyB}` : `${keyB}|${keyA}`
        if (segments.has(orderedKey)) return
        segments.set(orderedKey, { a, b })
    }

    const fetchVertex = (vertexIndex: number): THREE.Vector3 => new THREE.Vector3(
        positions.getX(vertexIndex),
        positions.getY(vertexIndex),
        positions.getZ(vertexIndex)
    ).applyMatrix4(matrix)

    const processTriangle = (i1: number, i2: number, i3: number) => {
        const verts = [fetchVertex(i1), fetchVertex(i2), fetchVertex(i3)]
        const sides = verts.map((v) => {
            if (v.y > cutY + 1e-6) return 1
            if (v.y < cutY - 1e-6) return -1
            return 0
        })
        if (!sides.some((s) => s === 1) || !sides.some((s) => s === -1)) return

        const intersections: THREE.Vector3[] = []
        for (let i = 0; i < 3; i++) {
            const curr = verts[i]
            const next = verts[(i + 1) % 3]
            const sCurr = sides[i]
            const sNext = sides[(i + 1) % 3]
            if (sCurr === 0) {
                intersections.push(new THREE.Vector3(curr.x, cutY, curr.z))
                continue
            }
            if (sCurr !== sNext && sNext !== 0) {
                intersections.push(intersectSegmentWithYPlane(curr, next, cutY))
            }
        }
        if (intersections.length < 2) return
        registerSegment(intersections[0], intersections[1])
        if (intersections.length === 3) {
            registerSegment(intersections[1], intersections[2])
        }
    }

    if (index && index.count > 0) {
        for (let i = 0; i < index.count; i += 3) {
            processTriangle(index.getX(i), index.getX(i + 1), index.getX(i + 2))
        }
    } else {
        for (let i = 0; i < positions.count; i += 3) {
            processTriangle(i, i + 1, i + 2)
        }
    }

    return [...segments.values()]
}

/**
 * Reconstruct closed polygons from an unordered set of 2D boundary segments
 * (in the horizontal plane, with `y` already flattened to the cut height).
 *
 * Segments are joined by their endpoints into adjacency chains; chains that
 * close back on themselves become polygons, while open chains are kept as
 * polylines so the outline edges are still drawn even for non-watertight
 * meshes (common in IFC exports).
 */
function reconstructPolygonsFromSegments(
    segments: Array<{ a: THREE.Vector3; b: THREE.Vector3 }>
): { closedLoops: THREE.Vector3[][]; openChains: THREE.Vector3[][] } {
    const closedLoops: THREE.Vector3[][] = []
    const openChains: THREE.Vector3[][] = []
    if (segments.length === 0) return { closedLoops, openChains }

    const EPS_SCALE = 10000
    const keyFor = (p: THREE.Vector3) => `${Math.round(p.x * EPS_SCALE)}_${Math.round(p.z * EPS_SCALE)}`

    const vertexByKey = new Map<string, number>()
    const vertexPoints: THREE.Vector3[] = []
    const adjacency: number[][] = []

    const internVertex = (p: THREE.Vector3): number => {
        const key = keyFor(p)
        const existing = vertexByKey.get(key)
        if (existing !== undefined) return existing
        const idx = vertexPoints.length
        vertexByKey.set(key, idx)
        vertexPoints.push(p.clone())
        adjacency.push([])
        return idx
    }

    // `edgeEntries` stores undirected edges; each entry records the two vertex
    // indices. Visiting an edge is tracked per entry so we never reuse it.
    const edgeEntries: Array<{ a: number; b: number; visited: boolean }> = []
    for (const seg of segments) {
        const ia = internVertex(seg.a)
        const ib = internVertex(seg.b)
        if (ia === ib) continue
        const edgeIndex = edgeEntries.length
        edgeEntries.push({ a: ia, b: ib, visited: false })
        adjacency[ia].push(edgeIndex)
        adjacency[ib].push(edgeIndex)
    }

    const otherEndpoint = (edgeIndex: number, fromVertex: number): number => {
        const entry = edgeEntries[edgeIndex]
        return entry.a === fromVertex ? entry.b : entry.a
    }

    // Walk each unvisited edge until we either return to the starting vertex
    // (closed loop) or hit a dead end (open chain).
    for (let startEdge = 0; startEdge < edgeEntries.length; startEdge++) {
        const startEntry = edgeEntries[startEdge]
        if (startEntry.visited) continue

        // Prefer starting from a vertex with odd degree — it's a dead-end in an
        // open chain and gives cleaner traversal. Otherwise any vertex works.
        let originVertex = startEntry.a
        if (adjacency[startEntry.a].length % 2 === 0 && adjacency[startEntry.b].length % 2 === 1) {
            originVertex = startEntry.b
        }
        const path: number[] = [originVertex]
        let currentVertex = originVertex
        let currentEdge = startEdge
        startEntry.visited = true
        currentVertex = otherEndpoint(currentEdge, originVertex)
        path.push(currentVertex)
        let closed = false

        while (true) {
            const candidates = adjacency[currentVertex].filter((e) => !edgeEntries[e].visited)
            if (candidates.length === 0) break
            const nextEdge = candidates[0]
            edgeEntries[nextEdge].visited = true
            const nextVertex = otherEndpoint(nextEdge, currentVertex)
            if (nextVertex === originVertex) {
                closed = true
                break
            }
            path.push(nextVertex)
            currentVertex = nextVertex
            if (path.length > edgeEntries.length + 2) break
        }

        const points = path.map((idx) => vertexPoints[idx].clone())
        if (closed && points.length >= 3) {
            closedLoops.push(points)
        } else if (points.length >= 2) {
            openChains.push(points)
        }
    }

    return { closedLoops, openChains }
}

/**
 * Render a single wall mesh as a set of filled plan-section polygons + crisp
 * outline edges, clipped to the door's plan corridor. Closed loops reconstructed
 * from the mesh section become filled polygons; open chains (non-watertight
 * regions) are emitted as outline-only polylines so the user still sees the
 * actual wall faces.
 */
function addMeshPlanSectionForWall(
    mesh: THREE.Mesh,
    cutY: number,
    corridor: PlanSectionCorridor,
    camera: THREE.OrthographicCamera,
    width: number,
    height: number,
    fillColor: string,
    strokeColor: string,
    layer: number,
    out: { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] }
): number {
    const segments = extractMeshSectionSegments(mesh, cutY)
    if (segments.length === 0) return 0
    const { closedLoops, openChains } = reconstructPolygonsFromSegments(segments)

    let emitted = 0

    for (const loop of closedLoops) {
        for (const p of loop) p.y = cutY
        const clipped = clipPolygonToPlanSectionCorridor(loop, corridor)
        if (clipped.length < 3) continue
        appendProjectedPolygon(
            out,
            clipped,
            camera,
            width,
            height,
            fillColor,
            strokeColor,
            layer,
            1,
            WALL_EDGE_STROKE_FACTOR
        )
        emitted++
    }

    // Open chains (non-watertight meshes): emit outline-only segments so the
    // wall is still visible even when a fill polygon can't be reconstructed.
    for (const chain of openChains) {
        for (let i = 0; i + 1 < chain.length; i++) {
            const clipped = clipSegmentToPlanSectionCorridor(chain[i], chain[i + 1], corridor)
            if (!clipped) continue
            const proj1 = projectPoint(clipped[0], camera, width, height)
            const proj2 = projectPoint(clipped[1], camera, width, height)
            out.edges.push({
                x1: proj1.x,
                y1: proj1.y,
                x2: proj2.x,
                y2: proj2.y,
                color: strokeColor,
                depth: (proj1.z + proj2.z) / 2,
                layer,
                strokeWidthFactor: WALL_EDGE_STROKE_FACTOR,
            })
            emitted++
        }
    }

    return emitted
}

/**
 * Section the host wall and any nearby walls at the door's plan cut plane,
 * producing real filled polygons + outline edges for plan view. Unlike
 * `createSemanticPlanWallGeometry`, this reflects the actual wall geometry —
 * L-corners, T-intersections, varying thickness, wall returns, and multiple
 * doors in the same host wall all appear correctly because they come straight
 * from the IFC mesh topology intersected with the cut plane.
 */
function createMeshPlanSectionGeometry(
    context: DoorContext,
    camera: THREE.OrthographicCamera,
    width: number,
    height: number,
    cutY: number,
    options: Required<SVGRenderOptions>
): { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] } {
    const out = { edges: [] as ProjectedEdge[], polygons: [] as ProjectedPolygon[] }
    const hostMeshes = getHostWallMeshes(context)
    const nearbyMeshes = getNearbyWallMeshes(context)
    const wallMeshes = [...hostMeshes, ...nearbyMeshes]
    if (wallMeshes.length === 0) {
        return out
    }

    // Build the plan-view corridor. Lateral extent covers the door + enough
    // room either side to show nearby walls / adjacent doors. Depth extent is
    // driven by the host wall's own thickness, padded so perpendicular walls
    // at L-corners remain visible.
    const frame = context.viewFrame
    const widthAxis = frame.widthAxis.clone().normalize()
    const depthAxis = frame.semanticFacing.clone().normalize()
    const halfDoorWidth = frame.width / 2
    const wallMetrics = getLocalHostWallPlanMetrics(context)
    const hostWallThickness = wallMetrics?.thickness ?? frame.thickness
    const lateralExtend = Math.max(frame.width, 0.9)
    const depthPadding = Math.max(hostWallThickness * 0.75, 0.45)
    const originWidth = frame.origin.dot(widthAxis)
    const originDepth = frame.origin.dot(depthAxis)
    const depthMin = (wallMetrics?.minDepth ?? -hostWallThickness / 2) - depthPadding
    const depthMax = (wallMetrics?.maxDepth ?? hostWallThickness / 2) + depthPadding

    const corridor: PlanSectionCorridor = {
        widthAxis,
        depthAxis,
        minWidth: originWidth - halfDoorWidth - lateralExtend,
        maxWidth: originWidth + halfDoorWidth + lateralExtend,
        minDepth: originDepth + depthMin,
        maxDepth: originDepth + depthMax,
    }

    for (const mesh of wallMeshes) {
        addMeshPlanSectionForWall(
            mesh,
            cutY,
            corridor,
            camera,
            width,
            height,
            options.wallColor,
            options.lineColor,
            -1,
            out
        )
    }

    return out
}

function createSemanticPlanWallGeometry(
    context: DoorContext,
    camera: THREE.OrthographicCamera,
    width: number,
    height: number,
    options: Required<SVGRenderOptions>
): { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] } {
    const geometry = { edges: [], polygons: [] } as { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] }

    const frame = context.viewFrame
    const wallMetrics = getLocalHostWallPlanMetrics(context)
    if (!wallMetrics) return geometry

    const wallThickness = wallMetrics.thickness
    const sideContext = Math.max(Math.max(options.margin, 0.25), wallThickness * 0.6)
    const halfDoorWidth = frame.width / 2

    const rects: THREE.Vector3[][] = []
    if (hostWallHasMaterialInRect(context, frame.widthAxis, frame.semanticFacing, {
        minA: frame.origin.dot(frame.widthAxis) - halfDoorWidth - sideContext,
        maxA: frame.origin.dot(frame.widthAxis) - halfDoorWidth + 0.01,
        minB: frame.origin.dot(frame.semanticFacing) + wallMetrics.minDepth,
        maxB: frame.origin.dot(frame.semanticFacing) + wallMetrics.maxDepth,
    })) {
        rects.push(createRectPoints3D(frame.origin, frame.widthAxis, frame.semanticFacing, -halfDoorWidth - sideContext, -halfDoorWidth, wallMetrics.minDepth, wallMetrics.maxDepth))
    }
    if (hostWallHasMaterialInRect(context, frame.widthAxis, frame.semanticFacing, {
        minA: frame.origin.dot(frame.widthAxis) + halfDoorWidth - 0.01,
        maxA: frame.origin.dot(frame.widthAxis) + halfDoorWidth + sideContext,
        minB: frame.origin.dot(frame.semanticFacing) + wallMetrics.minDepth,
        maxB: frame.origin.dot(frame.semanticFacing) + wallMetrics.maxDepth,
    })) {
        rects.push(createRectPoints3D(frame.origin, frame.widthAxis, frame.semanticFacing, halfDoorWidth, halfDoorWidth + sideContext, wallMetrics.minDepth, wallMetrics.maxDepth))
    }

    for (const rect of rects) {
        appendProjectedPolygon(geometry, rect, camera, width, height, options.wallColor, options.lineColor, -1, 1, WALL_EDGE_STROKE_FACTOR)
    }

    return geometry
}

function shouldRenderDeviceInElevation(
    context: DoorContext,
    deviceExpressID: number,
    isBackView: boolean
): boolean {
    const side = (context.nearbyDeviceVisibility || []).find(
        (entry) => entry.deviceExpressID === deviceExpressID
    )?.side

    if (side === 'front') {
        return !isBackView
    }
    if (side === 'back') {
        return isBackView
    }
    if (side === 'unknown') {
        return false
    }

    // Preserve previous behavior only for truly legacy contexts with no metadata.
    return true
}

function shouldRenderDeviceInPlan(
    context: DoorContext,
    deviceExpressID: number
): boolean {
    const side = (context.nearbyDeviceVisibility || []).find(
        (entry) => entry.deviceExpressID === deviceExpressID
    )?.side

    if (side === 'front' || side === 'back') {
        return true
    }
    if (side === 'unknown') {
        return false
    }

    // Preserve previous behavior only for truly legacy contexts with no metadata.
    return true
}

function hasVisibleDevicesForView(
    context: DoorContext | null,
    viewType: 'Front' | 'Back' | 'Plan' | ''
): boolean {
    if (!context) {
        return false
    }
    if (viewType === 'Plan') {
        return context.nearbyDevices.some((device) =>
            shouldRenderDeviceInPlan(context, device.expressID)
        )
    }
    if (viewType === '') {
        return context.nearbyDevices.length > 0
    }

    return context.nearbyDevices.some((device) =>
        shouldRenderDeviceInElevation(context, device.expressID, viewType === 'Back')
    )
}

function createSemanticElevationDeviceGeometry(
    context: DoorContext,
    camera: THREE.OrthographicCamera,
    width: number,
    height: number,
    options: Required<SVGRenderOptions>,
    isBackView: boolean
): { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] } {
    const geometry = { edges: [], polygons: [] } as { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] }
    const frame = context.viewFrame
    const depthCenter = frame.origin.dot(frame.semanticFacing)
    const hasWallContext = Boolean(context.hostWall || context.wall)

    for (const device of context.nearbyDevices) {
        if (!shouldRenderDeviceInElevation(context, device.expressID, isBackView)) {
            continue
        }
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

        if (hasWallContext) {
            const backdropRect = createRectPoints3D(
                center,
                frame.widthAxis,
                frame.upAxis,
                -rectWidth / 2,
                rectWidth / 2,
                -rectHeight / 2,
                rectHeight / 2
            )
            const projectedBackdrop = backdropRect.map((point) => projectPoint(point, camera, width, height))
            const backdropDepth = projectedBackdrop.reduce((sum, point) => sum + point.z, 0) / projectedBackdrop.length
            geometry.polygons.push({
                points: projectedBackdrop.map((point) => ({ x: point.x, y: point.y })),
                color: options.wallColor,
                depth: backdropDepth,
                layer: -1,
                skipClip: true,
                fillOpacity: 1,
            })
        }

        const rect = createRectPoints3D(
            center,
            frame.widthAxis,
            frame.upAxis,
            -rectWidth / 2,
            rectWidth / 2,
            -rectHeight / 2,
            rectHeight / 2
        )
        appendProjectedPolygon(geometry, rect, camera, width, height, options.deviceColor, options.lineColor, 1, 1, DEVICE_EDGE_STROKE_FACTOR)
        const lastPolygon = geometry.polygons[geometry.polygons.length - 1]
        if (lastPolygon) {
            lastPolygon.skipClip = true
        }
        for (let i = Math.max(0, geometry.edges.length - 4); i < geometry.edges.length; i++) {
            geometry.edges[i].skipClip = true
        }
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
        if (!shouldRenderDeviceInPlan(context, device.expressID)) {
            continue
        }
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
        appendProjectedPolygon(geometry, rect, camera, width, height, options.deviceColor, options.lineColor, 0, 1, DEVICE_EDGE_STROKE_FACTOR)
    }

    return geometry
}

interface ProjectedBounds {
    minX: number
    maxX: number
    minY: number
    maxY: number
}

function boundsToFitGeometry(bounds: ProjectedBounds): { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] } {
    return {
        edges: [],
        polygons: [{
            points: [
                { x: bounds.minX, y: bounds.minY },
                { x: bounds.maxX, y: bounds.minY },
                { x: bounds.maxX, y: bounds.maxY },
                { x: bounds.minX, y: bounds.maxY },
            ],
            color: 'none',
            depth: 0,
            layer: 0,
            fillOpacity: 0,
        }],
    }
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
    suppressSyntheticWallBands?: boolean
    /** When set (e.g. from front elevation), plan view uses this scale so door size matches Vorderansicht. */
    sharedDrawingScale?: number
    planDoorBounds?: ProjectedBounds
    planWallBandBounds?: { minY: number; maxY: number }
    storeyMarkerProjectedY?: number
}

function resolveSvgViewTransform(
    fitBounds: ProjectedBounds,
    options: Required<SVGRenderOptions>,
    context: DoorContext | null,
    sharedDrawingScale?: number,
    viewType: 'Front' | 'Back' | 'Plan' | '' = ''
): {
    scale: number
    offsetX: number
    offsetY: number
    viewHeight: number
} {
    // Viewport metrics depend on which view is rendered (legend rows and visible devices
    // differ between Front/Back/Plan). Passing the actual viewType keeps the precomputed
    // scale consistent with the eventual `generateSVGString` call, otherwise the elevation
    // scale can diverge from the plan scale whenever device/legend visibility changes.
    const { viewHeight, padding, availWidth, availHeight } = getSvgViewportMetrics(options, context, viewType)
    const contentWidth = fitBounds.maxX - fitBounds.minX
    const contentHeight = fitBounds.maxY - fitBounds.minY
    const naturalScale = Math.min(
        availWidth / (contentWidth || 1),
        availHeight / (contentHeight || 1)
    )
    const scale = sharedDrawingScale ?? naturalScale
    const scaledWidth = contentWidth * scale
    const scaledHeight = contentHeight * scale
    const offsetX = padding + (availWidth - scaledWidth) / 2
    const offsetY = padding + (availHeight - scaledHeight) / 2
    return { scale, offsetX, offsetY, viewHeight }
}

function getViewportClipBounds(
    fitGeometry: { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] },
    options: Required<SVGRenderOptions>,
    context: DoorContext | null,
    sharedDrawingScale?: number,
    viewType: 'Front' | 'Back' | 'Plan' | '' = ''
): ProjectedBounds | null {
    const fitBounds = getBoundsFromProjectedGeometry(fitGeometry.edges, fitGeometry.polygons)
    if (!fitBounds) return null

    const { scale, offsetX, offsetY, viewHeight } = resolveSvgViewTransform(
        fitBounds,
        options,
        context,
        sharedDrawingScale,
        viewType
    )

    return {
        minX: fitBounds.minX - offsetX / scale,
        maxX: fitBounds.minX + (options.width - offsetX) / scale,
        minY: fitBounds.minY - offsetY / scale,
        maxY: fitBounds.minY + (viewHeight - offsetY) / scale,
    }
}

function clipProjectedGeometryToBounds(
    geometry: { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] },
    bounds: ProjectedBounds | null
): { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] } {
    if (!bounds) {
        return {
            edges: geometry.edges.map((edge) => ({ ...edge, skipClip: true })),
            polygons: geometry.polygons.map((polygon) => ({ ...polygon, skipClip: true })),
        }
    }

    const edges: ProjectedEdge[] = []
    for (const edge of geometry.edges) {
        const clippedEdge = clipEdgeToBounds(edge, bounds)
        if (clippedEdge) {
            edges.push({ ...clippedEdge, skipClip: true })
        }
    }

    const polygons: ProjectedPolygon[] = []
    for (const polygon of geometry.polygons) {
        const clippedPoints = clipPolygonToBounds(polygon.points, bounds)
        if (clippedPoints.length >= 3) {
            polygons.push({ ...polygon, points: clippedPoints, skipClip: true })
        }
    }

    return { edges, polygons }
}

function getElevationHostClipBounds(
    context: DoorContext,
    fitGeometry: { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] },
    options: Required<SVGRenderOptions>,
    camera: THREE.OrthographicCamera,
    width: number,
    height: number,
    viewType: 'Front' | 'Back' = 'Front'
): ProjectedBounds | null {
    const bounds = getViewportClipBounds(fitGeometry, options, context, undefined, viewType)
    if (!bounds) return null

    const frame = context.viewFrame
    const topGap = getElevationTopContextGapMeters(context)
    const topReveal = THREE.MathUtils.clamp(frame.thickness * 0.75, 0.08, 0.18)
    const topPoint = frame.origin.clone().add(
        frame.upAxis.clone().multiplyScalar(frame.height / 2 + topGap + topReveal)
    )
    const projectedTop = projectPoint(topPoint, camera, width, height)
    bounds.minY = Math.min(bounds.minY, projectedTop.y)
    const bottomGap = getElevationBottomContextGapMeters(context)
    const bottomReveal = THREE.MathUtils.clamp(frame.thickness * 0.75, 0.08, 0.18)
    const bottomPoint = frame.origin.clone().add(
        frame.upAxis.clone().multiplyScalar(-frame.height / 2 - bottomGap - bottomReveal)
    )
    const projectedBottom = projectPoint(bottomPoint, camera, width, height)
    bounds.maxY = Math.max(bounds.maxY, projectedBottom.y)
    return bounds
}

function projectElevationDoorBounds(
    frame: DoorViewFrame,
    camera: THREE.OrthographicCamera,
    width: number,
    height: number
): ProjectedBounds {
    const halfW = frame.width / 2
    const halfH = frame.height / 2
    const corners = [
        frame.origin.clone().add(frame.widthAxis.clone().multiplyScalar(-halfW)).add(frame.upAxis.clone().multiplyScalar(-halfH)),
        frame.origin.clone().add(frame.widthAxis.clone().multiplyScalar(halfW)).add(frame.upAxis.clone().multiplyScalar(-halfH)),
        frame.origin.clone().add(frame.widthAxis.clone().multiplyScalar(halfW)).add(frame.upAxis.clone().multiplyScalar(halfH)),
        frame.origin.clone().add(frame.widthAxis.clone().multiplyScalar(-halfW)).add(frame.upAxis.clone().multiplyScalar(halfH)),
    ]
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const corner of corners) {
        const projected = projectPoint(corner, camera, width, height)
        minX = Math.min(minX, projected.x)
        maxX = Math.max(maxX, projected.x)
        minY = Math.min(minY, projected.y)
        maxY = Math.max(maxY, projected.y)
    }
    return { minX, maxX, minY, maxY }
}

function getStoreyMarkerLabel(context: DoorContext | null, viewType: string): string | null {
    if (!context || (viewType !== 'Front' && viewType !== 'Back')) {
        return null
    }

    const label = context.storeyName?.trim()
    if (!label) return null
    return label.length > 4 ? label.slice(0, 4) : label
}

function getStoreyMarkerLevelOffsetMeters(context: DoorContext): number {
    const frame = context.viewFrame
    const originB = frame.origin.dot(frame.upAxis)
    let topmostBelowSlab = -Infinity

    for (const slab of context.hostSlabsBelow) {
        if (!slab.boundingBox) continue
        const slabBounds = measureBoundingBoxInAxes(
            slab.boundingBox,
            frame.widthAxis,
            frame.upAxis,
            frame.semanticFacing
        )
        if (Number.isFinite(slabBounds.maxB)) {
            topmostBelowSlab = Math.max(topmostBelowSlab, slabBounds.maxB - originB)
        }
    }

    if (topmostBelowSlab > -Infinity) {
        return topmostBelowSlab
    }

    if (context.hostWall?.boundingBox) {
        const wallBounds = measureBoundingBoxInAxes(
            context.hostWall.boundingBox,
            frame.widthAxis,
            frame.upAxis,
            frame.semanticFacing
        )
        if (Number.isFinite(wallBounds.minB)) {
            // The wall bottom is a reasonable proxy for the slab top when the wall only
            // spans one storey (typical case: wall bottom ≈ slab top, 0.2–0.4 m below
            // the door opening). For walls that span multiple storeys or reach a
            // foundation, `wallBounds.minB` can be several meters below the door which
            // would push the storey marker to the canvas edge, producing a misleading
            // symbol. Clamp the wall-derived offset to the door-bottom fallback when it
            // extends further than MAX_WALL_BELOW_DOOR_METERS below the door opening.
            const doorBottomOffset = -frame.height / 2
            const wallOffset = wallBounds.minB - originB
            const MAX_WALL_BELOW_DOOR_METERS = 0.5
            if (wallOffset < doorBottomOffset - MAX_WALL_BELOW_DOOR_METERS) {
                return doorBottomOffset
            }
            return Math.min(wallOffset, doorBottomOffset)
        }
    }

    return -frame.height / 2
}

function projectStoreyMarkerLevelY(
    context: DoorContext,
    camera: THREE.OrthographicCamera,
    width: number,
    height: number
): number {
    const markerPoint = context.viewFrame.origin.clone().add(
        context.viewFrame.upAxis.clone().multiplyScalar(getStoreyMarkerLevelOffsetMeters(context))
    )
    return projectPoint(markerPoint, camera, width, height).y
}

function renderStoreyMarkerSvg(
    anchorX: number,
    anchorY: number,
    label: string,
    fontSize: number,
    fontFamily: string,
    maxWidth: number
): string {
    const triangleWidth = Math.max(fontSize, 12)
    const triangleHeight = Math.max(fontSize * 0.9, 10)
    // Text oberhalb des nach unten zeigenden Dreiecks (oberhalb der oberen Kante)
    const textY = anchorY - triangleHeight - 8
    const labelWidthEstimate = Math.max(label.length * fontSize * 0.58, triangleWidth)
    const safeHalfWidth = labelWidthEstimate / 2 + 6
    const minAnchorX = safeHalfWidth
    const maxAnchorX = Math.max(safeHalfWidth, maxWidth - safeHalfWidth)
    const clampedAnchorX = Math.min(Math.max(anchorX, minAnchorX), maxAnchorX)
    const escapedLabel = escapeSvgText(label)
    const points = [
        `${(clampedAnchorX - triangleWidth / 2).toFixed(2)},${(anchorY - triangleHeight).toFixed(2)}`,
        `${(clampedAnchorX + triangleWidth / 2).toFixed(2)},${(anchorY - triangleHeight).toFixed(2)}`,
        `${clampedAnchorX.toFixed(2)},${anchorY.toFixed(2)}`,
    ].join(' ')

    return `
  <g id="storey-marker">
    <polygon points="${points}" fill="#000000"/>
    <text x="${clampedAnchorX.toFixed(2)}" y="${textY.toFixed(2)}" text-anchor="middle" font-family="${fontFamily}" font-size="${fontSize}" fill="#000000">${escapedLabel}</text>
  </g>`
}

function resolveStoreyMarkerPlacement(
    contentLeft: number,
    contentRight: number,
    contentTop: number,
    contentBottom: number,
    canvasWidth: number,
    viewHeight: number,
    fontSize: number
): { x: number; y: number } {
    const leftSpace = Math.max(contentLeft, 0)
    const rightSpace = Math.max(canvasWidth - contentRight, 0)
    const preferRight = rightSpace >= leftSpace
    const sidePadding = Math.max(fontSize * 1.6, 28)
    const x = preferRight
        ? contentRight + Math.max(rightSpace / 2, sidePadding)
        : contentLeft - Math.max(leftSpace / 2, sidePadding)
    const y = THREE.MathUtils.clamp(
        contentTop + (contentBottom - contentTop) * 0.72,
        fontSize + 28,
        viewHeight - (fontSize + 18)
    )
    return { x, y }
}

function getSvgViewportMetrics(
    options: Required<SVGRenderOptions>,
    context: DoorContext | null,
    viewType: 'Front' | 'Back' | 'Plan' | '' = ''
): {
    titleBlockHeight: number
    viewHeight: number
    padding: number
    availWidth: number
    availHeight: number
} {
    const hasDevices = hasVisibleDevicesForView(context, viewType)
    const hasWall = context ? Boolean(context.hostWall || context.wall) : false
    const hasSlabs = hasVisibleSlabsForView(context, viewType)
    const showLegendActual = options.showLegend && (hasDevices || hasWall || hasSlabs)
    const lineStep = options.fontSize * 1.5
    const labelLines = options.showLabels ? 2 : 0
    const legendLines = showLegendActual ? 1 : 0
    const rowCount = labelLines + legendLines
    const titleBlockHeight = rowCount > 0
        ? Math.ceil(30 + options.fontSize + Math.max(0, rowCount - 1) * lineStep)
        : 0
    const viewHeight = options.height - titleBlockHeight
    const padding = 80
    const availWidth = options.width - padding * 2
    const availHeight = viewHeight - padding * 2
    return { titleBlockHeight, viewHeight, padding, availWidth, availHeight }
}

function createElevationOrthographicCamera(
    frame: DoorViewFrame,
    margin: number,
    isBackView: boolean
): { camera: THREE.OrthographicCamera; frustumWidth: number; frustumHeight: number } {
    const frustumWidth = frame.width + margin * 2
    const frustumHeight = frame.height + margin * 2
    const camera = new THREE.OrthographicCamera(
        -frustumWidth / 2, frustumWidth / 2, frustumHeight / 2, -frustumHeight / 2, 0.1, 100
    )
    const distance = Math.max(frustumWidth, frustumHeight) * 2
    const viewDir = isBackView
        ? frame.semanticFacing.clone().negate()
        : frame.semanticFacing.clone()
    camera.position.copy(frame.origin).add(viewDir.multiplyScalar(distance))
    camera.up.copy(frame.upAxis)
    camera.lookAt(frame.origin)
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()
    return { camera, frustumWidth, frustumHeight }
}

/** Fit geometry for front elevation — same camera as Vorderansicht for scale alignment with plan. */
function collectFrontElevationFitGeometry(
    context: DoorContext,
    opts: Required<SVGRenderOptions>
): { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] } | null {
    const frame = context.viewFrame
    const margin = Math.max(opts.margin, 0.25)
    const { camera, frustumWidth, frustumHeight } = createElevationOrthographicCamera(frame, margin, false)
    const fitGeometry = boundsToFitGeometry(
        projectElevationDoorBounds(frame, camera, frustumWidth, frustumHeight)
    )
    const elevationHostClipBounds = getElevationHostClipBounds(
        context,
        fitGeometry,
        opts,
        camera,
        frustumWidth,
        frustumHeight,
        'Front'
    )
    return elevationHostClipBounds ? boundsToFitGeometry(elevationHostClipBounds) : fitGeometry
}

function computeFrontElevationScale(context: DoorContext, opts: Required<SVGRenderOptions>): number | undefined {
    const fit = collectFrontElevationFitGeometry(context, opts)
    if (!fit) {
        return undefined
    }
    const fitBounds = getBoundsFromProjectedGeometry(fit.edges, fit.polygons)
    if (!fitBounds) {
        return undefined
    }
    const { availWidth, availHeight } = getSvgViewportMetrics(opts, context, 'Front')
    const contentWidth = fitBounds.maxX - fitBounds.minX
    const contentHeight = fitBounds.maxY - fitBounds.minY
    return Math.min(availWidth / (contentWidth || 1), availHeight / (contentHeight || 1))
}

interface WallRevealRect {
    x: number
    y: number
    width: number
    height: number
    strokeTop?: boolean
    strokeBottom?: boolean
    strokeLeft?: boolean
    strokeRight?: boolean
}

interface WallBandMask {
    includeLeft: boolean
    includeRight: boolean
    includeTop: boolean
}

function getElevationWallBandMask(context: DoorContext | null, viewType: string): WallBandMask {
    if (!context || (viewType !== 'Front' && viewType !== 'Back')) {
        return { includeLeft: true, includeRight: true, includeTop: true }
    }

    const frame = context.viewFrame
    const wallBounds = getHostWallAxisBounds(context, frame.widthAxis, frame.upAxis, frame.semanticFacing)
    if (!wallBounds) {
        return { includeLeft: false, includeRight: false, includeTop: false }
    }
    return { includeLeft: true, includeRight: true, includeTop: true }
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
    planBandY?: number
    planBandHeight?: number
    topBandBottomY?: number
    includeLeft?: boolean
    includeRight?: boolean
    includeTop?: boolean
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
        planBandY,
        planBandHeight,
        topBandBottomY,
        includeLeft = true,
        includeRight = true,
        includeTop = true,
    } = params

    const bandW = getRevealBandSize(scaledWidth, wallRevealSide, 10)
    const bandH = getRevealBandSize(scaledHeight, wallRevealTop, 8)
    const leftX = bounds.minX
    const rightXStart = offsetX + scaledWidth
    const rightXEnd = bounds.maxX
    const topY = Math.max(bounds.minY, offsetY - bandH)
    const bottomY = Math.min(bounds.maxY, offsetY + scaledHeight)
    const rects: WallRevealRect[] = []

    if (viewType !== 'Plan') {
        const topBandBottom = THREE.MathUtils.clamp(topBandBottomY ?? offsetY, bounds.minY, bounds.maxY)
        const actualTopY = bounds.minY
        const clampedOffsetX = THREE.MathUtils.clamp(offsetX, bounds.minX, bounds.maxX)
        const clampedRightXStart = THREE.MathUtils.clamp(rightXStart, bounds.minX, bounds.maxX)
        const clampedBottomY = THREE.MathUtils.clamp(bottomY, bounds.minY, bounds.maxY)
        if (includeLeft && clampedOffsetX - leftX > 0.5 && clampedBottomY - actualTopY > 0.5) {
            rects.push({ x: leftX, y: actualTopY, width: clampedOffsetX - leftX, height: clampedBottomY - actualTopY })
        }
        if (includeRight && rightXEnd - clampedRightXStart > 0.5 && clampedBottomY - actualTopY > 0.5) {
            rects.push({ x: clampedRightXStart, y: actualTopY, width: rightXEnd - clampedRightXStart, height: clampedBottomY - actualTopY })
        }
        if (includeTop && bandH > 0 && topBandBottom - actualTopY > 0.5) {
            rects.push({ x: leftX, y: actualTopY, width: rightXEnd - leftX, height: topBandBottom - actualTopY })
        }
        return rects
    }

    if (rightXStart <= leftX && rightXEnd <= rightXStart) {
        return rects
    }

    const wallThickness = wallThicknessPx ?? Math.max(scaledHeight * 0.08, 12)
    const computedPlanBandH = Math.min(
        wallThickness * (1 + THREE.MathUtils.clamp(wallRevealSide, 0, 0.5)),
        Math.max(scaledHeight, wallThickness)
    )
    const actualPlanBandH = planBandHeight ?? computedPlanBandH
    const unclampedPlanBandY = planBandY
        ?? (planArcFlip ? offsetY + scaledHeight - actualPlanBandH : offsetY)
    const actualPlanBandY = THREE.MathUtils.clamp(
        unclampedPlanBandY,
        bounds.minY,
        Math.max(bounds.minY, bounds.maxY - actualPlanBandH)
    )

    if (offsetX - leftX > 0.5) {
        rects.push({
            x: leftX,
            y: actualPlanBandY,
            width: offsetX - leftX,
            height: actualPlanBandH,
            strokeTop: true,
            strokeBottom: true,
            strokeLeft: false,
            strokeRight: true,
        })
    }
    if (rightXEnd - rightXStart > 0.5) {
        rects.push({
            x: rightXStart,
            y: actualPlanBandY,
            width: rightXEnd - rightXStart,
            height: actualPlanBandH,
            strokeTop: true,
            strokeBottom: true,
            strokeLeft: true,
            strokeRight: false,
        })
    }

    return rects
}

function renderWallRevealSvg(
    rects: WallRevealRect[],
    wallColor: string,
    lineColor: string,
    lineWidth: number,
    asPaths: boolean = false
): string {
    if (rects.length === 0) {
        return ''
    }

    const opacity = 1
    const strokeWidth = (lineWidth * WALL_EDGE_STROKE_FACTOR).toFixed(2)

    return rects.map((rect) => {
        if (asPaths) {
            const fillPath = `  <path d="M ${rect.x.toFixed(2)} ${rect.y.toFixed(2)} L ${(rect.x + rect.width).toFixed(2)} ${rect.y.toFixed(2)} L ${(rect.x + rect.width).toFixed(2)} ${(rect.y + rect.height).toFixed(2)} L ${rect.x.toFixed(2)} ${(rect.y + rect.height).toFixed(2)} Z" fill="${wallColor}" fill-opacity="${opacity}" stroke="none"/>`
            const hasSelectiveStroke =
                rect.strokeTop !== undefined
                || rect.strokeBottom !== undefined
                || rect.strokeLeft !== undefined
                || rect.strokeRight !== undefined
            if (!hasSelectiveStroke) {
                return fillPath
            }
            const strokeSegments: string[] = []
            if (rect.strokeTop) {
                strokeSegments.push(`  <line x1="${rect.x.toFixed(2)}" y1="${rect.y.toFixed(2)}" x2="${(rect.x + rect.width).toFixed(2)}" y2="${rect.y.toFixed(2)}" stroke="${lineColor}" stroke-width="${strokeWidth}"/>`)
            }
            if (rect.strokeBottom) {
                strokeSegments.push(`  <line x1="${rect.x.toFixed(2)}" y1="${(rect.y + rect.height).toFixed(2)}" x2="${(rect.x + rect.width).toFixed(2)}" y2="${(rect.y + rect.height).toFixed(2)}" stroke="${lineColor}" stroke-width="${strokeWidth}"/>`)
            }
            if (rect.strokeLeft) {
                strokeSegments.push(`  <line x1="${rect.x.toFixed(2)}" y1="${rect.y.toFixed(2)}" x2="${rect.x.toFixed(2)}" y2="${(rect.y + rect.height).toFixed(2)}" stroke="${lineColor}" stroke-width="${strokeWidth}"/>`)
            }
            if (rect.strokeRight) {
                strokeSegments.push(`  <line x1="${(rect.x + rect.width).toFixed(2)}" y1="${rect.y.toFixed(2)}" x2="${(rect.x + rect.width).toFixed(2)}" y2="${(rect.y + rect.height).toFixed(2)}" stroke="${lineColor}" stroke-width="${strokeWidth}"/>`)
            }
            return `${fillPath}\n${strokeSegments.join('\n')}`
        }
        return `  <rect x="${rect.x.toFixed(2)}" y="${rect.y.toFixed(2)}" width="${rect.width.toFixed(2)}" height="${rect.height.toFixed(2)}" fill="${wallColor}" fill-opacity="${opacity}" stroke="${lineColor}" stroke-width="${strokeWidth}"/>`
    }).join('\n') + '\n'
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

    const currentViewType = renderMeta.viewType as 'Front' | 'Back' | 'Plan' | ''
    const hasDevices = hasVisibleDevicesForView(renderMeta.context, currentViewType)
    const hasWall = renderMeta.context ? Boolean(renderMeta.context.hostWall || renderMeta.context.wall) : false
    const hasSlabs = hasVisibleSlabsForView(renderMeta.context, currentViewType)
    const showLegendActual = showLegend && (hasDevices || hasWall || hasSlabs)

    const { titleBlockHeight, viewHeight, padding, availWidth, availHeight } = getSvgViewportMetrics(
        options,
        renderMeta.context,
        renderMeta.viewType as 'Front' | 'Back' | 'Plan' | ''
    )

    const fitBounds = getBoundsFromProjectedGeometry(
        fitGeometry?.edges ?? edges,
        fitGeometry?.polygons ?? polygons
    )

    const renderEdges = fitBounds
        ? edges
            .map((edge) => (edge.layer < 0 || edge.skipClip) ? edge : clipEdgeToBounds(edge, fitBounds))
            .filter((edge): edge is ProjectedEdge => edge !== null)
        : edges
    const renderPolygons = fitBounds
        ? polygons
            .map((polygon) => {
                if (polygon.layer < 0 || polygon.skipClip) return polygon
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


    const contentWidth = maxX - minX
    const contentHeight = maxY - minY

    const naturalScale = Math.min(
        availWidth / (contentWidth || 1),
        availHeight / (contentHeight || 1)
    )
    const scale = renderMeta.sharedDrawingScale ?? naturalScale

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

    const planDoorOffsetX = renderMeta.viewType === 'Plan' && renderMeta.planDoorBounds
        ? transformX(renderMeta.planDoorBounds.minX)
        : offsetX
    const planDoorOffsetY = renderMeta.viewType === 'Plan' && renderMeta.planDoorBounds
        ? transformY(renderMeta.planDoorBounds.minY)
        : offsetY
    const planDoorScaledWidth = renderMeta.viewType === 'Plan' && renderMeta.planDoorBounds
        ? (renderMeta.planDoorBounds.maxX - renderMeta.planDoorBounds.minX) * scale
        : scaledWidth
    const planDoorScaledHeight = renderMeta.viewType === 'Plan' && renderMeta.planDoorBounds
        ? (renderMeta.planDoorBounds.maxY - renderMeta.planDoorBounds.minY) * scale
        : scaledHeight
    const planWallBandY = renderMeta.viewType === 'Plan' && renderMeta.planWallBandBounds
        ? transformY(renderMeta.planWallBandBounds.minY)
        : undefined
    const planWallBandHeight = renderMeta.viewType === 'Plan' && renderMeta.planWallBandBounds
        ? (renderMeta.planWallBandBounds.maxY - renderMeta.planWallBandBounds.minY) * scale
        : (renderMeta.context?.viewFrame ? Math.max(renderMeta.context.viewFrame.thickness * scale, 12) : undefined)

    const wallBandsSvg = showFills && hasWall && !renderMeta.suppressSyntheticWallBands
        ? (() => {
            const elevationMask = getElevationWallBandMask(renderMeta.context, renderMeta.viewType)
            return renderWallRevealSvg(
            getWallRevealRects({
                wallThicknessPx: renderMeta.context?.viewFrame
                    ? Math.max(renderMeta.context.viewFrame.thickness * scale, 12)
                    : undefined,
                bounds: { minX: 0, maxX: width, minY: 0, maxY: viewHeight },
                offsetX: planDoorOffsetX,
                offsetY: planDoorOffsetY,
                scaledWidth: planDoorScaledWidth,
                scaledHeight: planDoorScaledHeight,
                wallRevealSide,
                wallRevealTop,
                viewType: renderMeta.viewType,
                planBandY: planWallBandY,
                planBandHeight: planWallBandHeight,
                planArcFlip: renderMeta.planArcFlip,
                topBandBottomY: renderMeta.viewType === 'Front' || renderMeta.viewType === 'Back'
                    ? planDoorOffsetY
                    : undefined,
                includeLeft: elevationMask.includeLeft,
                includeRight: elevationMask.includeRight,
                includeTop: elevationMask.includeTop,
            }),
            wallColor,
            options.lineColor,
            lineWidth,
            true
        )
        })()
        : ''

    const fontDefs = svgWebFontDefs(options.fontFamily)
    const drawingClipDefs = `  <defs>
    <clipPath id="drawing-clip">
      <rect x="0" y="0" width="${width}" height="${viewHeight}"/>
    </clipPath>
  </defs>
`
    let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
${fontDefs}${drawingClipDefs}  <rect width="100%" height="100%" fill="${backgroundColor}"/>
  <g id="fills">
  <g clip-path="url(#drawing-clip)">
${wallBandsSvg}
`

    // Draw filled polygons first (if enabled)
    if (showFills) {
        for (const poly of renderPolygons) {
            const pathData = poly.points.map((p, i) =>
                `${i === 0 ? 'M' : 'L'} ${transformX(p.x).toFixed(2)} ${transformY(p.y).toFixed(2)}`
            ).join(' ') + ' Z'

            svg += `    <path d="${pathData}" fill="${poly.color}" fill-opacity="${poly.fillOpacity ?? 0.3}" stroke="none"/>\n`
        }
    }

    svg += `  </g>
  </g>
  <g id="edges">
  <g clip-path="url(#drawing-clip)">
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
        const strokeWidth = lineWidth * (edge.strokeWidthFactor ?? (edge.isDashed ? 0.75 : 1))
        svg += `    <line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="${edge.color}" stroke-width="${strokeWidth}" stroke-linecap="round"${dashAttr} opacity="${edge.isDashed ? 0.7 : 1}"/>\n`
    }


    svg += `  </g>
  </g>`

    // "Vorderansicht" arrow intentionally omitted – not needed on generated pictures

    const storeyMarkerLabel = getStoreyMarkerLabel(renderMeta.context, renderMeta.viewType)
    if (storeyMarkerLabel) {
        const markerLevelY = renderMeta.storeyMarkerProjectedY !== undefined
            ? transformY(renderMeta.storeyMarkerProjectedY)
            : undefined
        const { x: markerX, y: markerY } = resolveStoreyMarkerPlacement(
            offsetX,
            offsetX + scaledWidth,
            markerLevelY ?? offsetY,
            markerLevelY ?? (offsetY + scaledHeight),
            width,
            viewHeight,
            fontSize
        )
        svg += renderStoreyMarkerSvg(markerX, markerY, storeyMarkerLabel, fontSize, options.fontFamily, width)
    }

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

    const {
        fontSize,
        fontFamily,
        showLegend,
        showLabels,
        backgroundColor,
    } = options
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
    /** Vertikaler Abstand zwischen aufeinanderfolgenden Textzeilen (eine Zeile = nächste Baseline). */
    const lineStep = fontSize * 1.5

    // Translate View Type
    const viewTypeMap: Record<string, string> = {
        'Front': 'Vorderansicht',
        'Back': 'Rückansicht',
        'Plan': 'Grundriss'
    }
    const localizedViewType = viewTypeMap[viewType] || viewType

    // 1. View Title (Typ-/ID-Zeile bewusst weggelassen)
    if (showLabels) {
        content += `    <text x="${leftX}" y="${currentY}" font-family="${fontFamily}" font-size="${fontSize}" font-weight="bold" fill="#000000">${localizedViewType}</text>`
        currentY += lineStep

        // 2. Opening Direction (if valid) — links wie Anschriftstitel
        if (context.openingDirection && (viewType === 'Front' || viewType === 'Back')) {
            const dirText = escapeSvgText(formatOpeningDirection(context.openingDirection))
            content += `    <text x="${leftX}" y="${currentY}" font-family="${fontFamily}" font-size="${fontSize}" fill="#000000">Öffnungsrichtung: ${dirText}</text>`
            currentY += lineStep
        }
    }

    const hasDevices = hasVisibleDevicesForView(context, viewType as 'Front' | 'Back' | 'Plan')
    const hasWall = Boolean(context.hostWall || context.wall)
    const hasSlabs = hasVisibleSlabsForView(context, viewType as 'Front' | 'Back' | 'Plan')

    if (showLegend && (hasDevices || hasWall || hasSlabs)) {
        currentY += showLabels ? lineStep * 0.15 : lineStep

        // Nur Farbfelder + Bezeichnungen (ohne „LEGENDE:“-Titel), links wie Anschriftstitel
        let legendX = leftX
        const items = [
            { color: options.doorColor, text: 'Tür' },
        ]
        if (viewType !== 'Plan') {
            items.push({ color: options.glassColor, text: 'Glas' })
        }

        if (hasWall) {
            items.push({ color: options.wallColor, text: 'Wand' })
        }
        if (hasSlabs && (!hasWall || options.floorSlabColor !== options.wallColor)) {
            items.push({ color: options.floorSlabColor, text: 'Decke' })
        }

        if (hasDevices) {
            items.push({ color: options.deviceColor, text: 'Elektro' })
        }

        for (const item of items) {
            // Box (swatch matches text cap height visually)
            content += `    <rect x="${legendX}" y="${currentY - fontSize + 2}" width="${fontSize}" height="${fontSize}" fill="${item.color}"/>`
            // Text
            content += `    <text x="${legendX + fontSize + 5}" y="${currentY}" font-family="${fontFamily}" font-size="${fontSize}" fill="#000000">${item.text}</text>`
            legendX += fontSize + item.text.length * (fontSize * 0.7) + 20
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
    const opts = normalizeRenderOptions(options)
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
    const doorMeshes = getDoorMeshes(context)
    if (doorMeshes.length === 0) {
        throw new Error('No meshes available for rendering')
    }

    const frame = context.viewFrame
    const margin = Math.max(opts.margin, 0.25)
    const { camera, frustumWidth, frustumHeight } = createElevationOrthographicCamera(frame, margin, isBackView)

    const renderGeometry = collectProjectedGeometry(
        doorMeshes,
        context,
        opts,
        camera,
        frustumWidth,
        frustumHeight,
        false,
        0,
        'none',
        true,
        DOOR_EDGE_STROKE_FACTOR
    )
    const fitGeometry = boundsToFitGeometry(
        projectElevationDoorBounds(frame, camera, frustumWidth, frustumHeight)
    )
    const fitBounds = getBoundsFromProjectedGeometry(fitGeometry.edges, fitGeometry.polygons)
    const nearbyDoorGeometry = createSemanticElevationNearbyDoorGeometry(
        context,
        camera,
        frustumWidth,
        frustumHeight
    )
    const elevationViewType: 'Front' | 'Back' = isBackView ? 'Back' : 'Front'
    const elevationHostClipBounds = getElevationHostClipBounds(context, fitGeometry, opts, camera, frustumWidth, frustumHeight, elevationViewType)
    const scaleFitGeometry = elevationHostClipBounds ? boundsToFitGeometry(elevationHostClipBounds) : fitGeometry
    const scaleFitBounds = getBoundsFromProjectedGeometry(scaleFitGeometry.edges, scaleFitGeometry.polygons)
    const sharedDrawingScale = scaleFitBounds
        ? resolveSvgViewTransform(scaleFitBounds, opts, context, undefined, elevationViewType).scale
        : undefined
    const wallMeshes = getHostWallMeshes(context)
    const wallGeometry = wallMeshes.length > 0
        ? clipProjectedGeometryToBounds(
            collectProjectedGeometry(
                wallMeshes,
                context,
                opts,
                camera,
                frustumWidth,
                frustumHeight,
                false,
                -1,
                'none',
                true,
                WALL_EDGE_STROKE_FACTOR
            ),
            elevationHostClipBounds
        )
        : { edges: [], polygons: [] }
    const semanticWallGeometry = clipProjectedGeometryToBounds(
        createSemanticElevationWallGeometry(context, camera, frustumWidth, frustumHeight, opts),
        elevationHostClipBounds
    )
    renderGeometry.edges.push(...wallGeometry.edges)
    renderGeometry.polygons.push(...wallGeometry.polygons)
    // Always merge semantic wall bands. They keep host context readable even when mesh projection
    // exists but collapses into extremely small fills or misses reveals near the opening.
    renderGeometry.edges.push(...semanticWallGeometry.edges)
    renderGeometry.polygons.push(...semanticWallGeometry.polygons)
    const hasElevationWallGeometry =
        wallGeometry.polygons.some((polygon) => polygon.color === opts.wallColor)
        || semanticWallGeometry.polygons.some((polygon) => polygon.color === opts.wallColor)
    const slabGeometry = clipProjectedGeometryToBounds(
        createSemanticElevationSlabGeometry(context, camera, frustumWidth, frustumHeight, opts),
        elevationHostClipBounds
    )
    renderGeometry.edges.push(...slabGeometry.edges)
    renderGeometry.polygons.push(...slabGeometry.polygons)
    const clippedNearbyDoorGeometry = clipProjectedGeometryToBounds(
        nearbyDoorGeometry,
        elevationHostClipBounds
    )
    renderGeometry.edges.push(...clippedNearbyDoorGeometry.edges)
    renderGeometry.polygons.push(...clippedNearbyDoorGeometry.polygons)
    const deviceGeometry = createSemanticElevationDeviceGeometry(
        context,
        camera,
        frustumWidth,
        frustumHeight,
        opts,
        isBackView
    )
    renderGeometry.edges.push(...deviceGeometry.edges)
    renderGeometry.polygons.push(...deviceGeometry.polygons)

    return generateSVGString(
        renderGeometry.edges,
        renderGeometry.polygons,
        opts,
        elevationHostClipBounds ? boundsToFitGeometry(elevationHostClipBounds) : fitGeometry,
        {
            context,
            viewType: isBackView ? 'Back' : 'Front',
            planArcFlip: false,
            suppressSyntheticWallBands: hasElevationWallGeometry,
            storeyMarkerProjectedY: projectStoreyMarkerLevelY(context, camera, frustumWidth, frustumHeight),
            ...(sharedDrawingScale !== undefined ? { sharedDrawingScale } : {}),
        }
    )
}

function renderFallbackContextDoorSvg(
    x: number,
    y: number,
    width: number,
    height: number,
    lineWidth: number
): string {
    const insetX = Math.min(width * 0.08, 14)
    const insetY = Math.min(height * 0.05, 14)
    return `
  <rect x="${x}" y="${y}" width="${width}" height="${height}"
        fill="${CONTEXT_DOOR_FILL_COLOR}" fill-opacity="${CONTEXT_DOOR_FILL_OPACITY}"
        stroke="${CONTEXT_DOOR_LINE_COLOR}" stroke-width="${lineWidth * CONTEXT_DOOR_EDGE_STROKE_FACTOR}"/>
  <rect x="${x + insetX}" y="${y + insetY}"
        width="${Math.max(0, width - insetX * 2)}" height="${Math.max(0, height - insetY * 2)}"
        fill="none" stroke="${CONTEXT_DOOR_LINE_COLOR}" stroke-width="${Math.max(0.8, lineWidth * CONTEXT_DOOR_EDGE_STROKE_FACTOR)}"/>`
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
    const labelHeight = showLabels ? fontSize * 3 + 48 : 0
    const availableWidth = svgWidth - padding * 2
    const availableHeight = svgHeight - padding * 2 - labelHeight

    const marginMeters = Math.max(opts.margin, 0.25)
    const nearbyDoorRects = getNearbyDoorAxisRects(context)
    const contentMinA = -doorWidth / 2
    const contentMaxA = doorWidth / 2
    const contentMinB = -doorHeight / 2
    const contentMaxB = doorHeight / 2
    const totalWidth = doorWidth + marginMeters * 2
    const totalHeight = doorHeight + marginMeters * 2

    const scale = Math.min(availableWidth / totalWidth, availableHeight / totalHeight)

    const scaledWidth = doorWidth * scale
    const scaledHeight = doorHeight * scale
    const contentOffsetX = padding + (availableWidth - doorWidth * scale) / 2
    const contentOffsetY = padding + (availableHeight - doorHeight * scale) / 2
    const offsetX = contentOffsetX
    const offsetY = contentOffsetY
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
                topBandBottomY: offsetY,
            }),
            wallColor,
            lineColor,
            lineWidth,
            true
        )
        : ''

    const nearbyDoorsSvg = nearbyDoorRects
        .map((rect) => {
            const rectX = contentOffsetX + (rect.minA - contentMinA) * scale
            const rectY = contentOffsetY + (contentMaxB - rect.maxB) * scale
            const rectWidth = (rect.maxA - rect.minA) * scale
            const rectHeight = (rect.maxB - rect.minB) * scale
            if (rectX + rectWidth < padding || rectX > svgWidth - padding || rectY + rectHeight < padding || rectY > padding + availableHeight) {
                return ''
            }
            return renderFallbackContextDoorSvg(
                rectX,
                rectY,
                rectWidth,
                rectHeight,
                lineWidth
            )
        })
        .filter(Boolean)
        .join('\n')

    const fontDefs = svgWebFontDefs(opts.fontFamily)
    let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">
${fontDefs}  <rect width="100%" height="100%" fill="${backgroundColor}"/>
${wallRevealSvg}
${nearbyDoorsSvg}
  <!-- Door outline (bounding box fallback) -->
  <rect x="${offsetX}" y="${offsetY}" width="${scaledWidth}" height="${scaledHeight}" 
        fill="${doorColor}" fill-opacity="1" stroke="${lineColor}" stroke-width="${lineWidth * DOOR_EDGE_STROKE_FACTOR}"/>
  
  <!-- Door panel detail -->
  <rect x="${offsetX + scaledWidth * 0.08}" y="${offsetY + scaledHeight * 0.05}" 
        width="${scaledWidth * 0.84}" height="${scaledHeight * 0.9}" 
        fill="none" stroke="${lineColor}" stroke-width="${lineWidth}"/>
  
  <!-- Door handle -->
  <rect x="${isBackView ? offsetX + scaledWidth * 0.12 : offsetX + scaledWidth * 0.82}" 
        y="${offsetY + scaledHeight * 0.48}" 
        width="${scaledWidth * 0.06}" height="${scaledHeight * 0.08}" 
        fill="${lineColor}" fill-opacity="1"/>
`

    const storeyMarkerLabel = getStoreyMarkerLabel(context, isBackView ? 'Back' : 'Front')
    if (storeyMarkerLabel) {
        const markerLevelY = contentOffsetY + (contentMaxB - getStoreyMarkerLevelOffsetMeters(context)) * scale
        const { x: markerX, y: markerY } = resolveStoreyMarkerPlacement(
            offsetX,
            offsetX + scaledWidth,
            markerLevelY,
            markerLevelY,
            svgWidth,
            svgHeight - labelHeight,
            fontSize
        )
        svg += renderStoreyMarkerSvg(markerX, markerY, storeyMarkerLabel, fontSize, fontFamily, svgWidth)
    }

    if (showLabels) {
        const labelY = svgHeight - (fontSize * 3 + 24)
        svg += `
  <!-- Labels -->
  <text x="${svgWidth / 2}" y="${labelY}" text-anchor="middle" font-family="${fontFamily}" font-size="${fontSize}" fill="${lineColor}">
    ${isBackView ? 'Rückansicht' : 'Vorderansicht'} (vereinfacht)
  </text>
  <text x="${svgWidth / 2}" y="${labelY + fontSize + 4}" text-anchor="middle" font-family="${fontFamily}" font-size="${fontSize}" fill="#666">
    ${escapeSvgText(context.doorId)}
  </text>
  <text x="${svgWidth / 2}" y="${labelY + fontSize * 2 + 8}" text-anchor="middle" font-family="${fontFamily}" font-size="${fontSize}" fill="#888">
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
    options: SVGRenderOptions = {},
    /** When rendering with `renderDoorViews`, pass front elevation scale so plan matches Vorderansicht. */
    sharedScaleFromFront?: number
): Promise<string> {
    const merged = normalizeRenderOptions(options)
    const opts: Required<SVGRenderOptions> = {
        ...merged,
        height: planSvgCanvasHeight(merged.width),
    }
    const { width: doorWidth, thickness: doorThickness, height: doorHeight } = context.viewFrame

    // Check if we have detailed geometry
    const hasDetailedGeometry = context.detailedGeometry && context.detailedGeometry.doorMeshes.length > 0

    if (hasDetailedGeometry) {
        return renderPlanFromMeshes(context, opts, sharedScaleFromFront)
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

interface ResolvedSwingLeaf {
    width: number
    hingeSide: 'left' | 'right'
    hingeOffsetFromCenter: number
}

/**
 * Decide whether a door's resolved swing leaves need a left↔right mirror to honour
 * IFC handedness. IFC defines LEFT/RIGHT "as viewed in the direction of the positive
 * local Y-axis" (= `placementYAxis`). The renderer's `widthAxis` is derived from
 * `semanticFacing` via `cross(worldUp, semanticFacing)`. Because `semanticFacing`
 * can be guessed with either sign from bounding-box / mesh-normal heuristics, the
 * renderer's local-X and IFC's local-X may disagree by 180°.
 *
 * When `placementYAxis` and `semanticFacing` point the same way (dot > 0), the
 * renderer's `widthAxis` is opposite to IFC's local +X, so hingeSide LEFT/RIGHT
 * need to be swapped. When they point opposite ways, axes already agree and no
 * mirror is required. When `placementYAxis` is unavailable, preserve historical
 * behaviour (no mirror).
 *
 * This applies to ALL swing-capable operations (SINGLE_SWING_LEFT/RIGHT,
 * DOUBLE_SWING*, DOUBLE_DOOR_*, SWING_FIXED_LEFT/RIGHT), because the coordinate
 * ambiguity is independent of which operation type is in use.
 */
function shouldMirrorSwingForHandedness(context: DoorContext): boolean {
    const info = getDoorOperationInfo(context.openingDirection)
    if (!info.swingCapable || !info.hingeSide) {
        return false
    }

    const placementYAxis = context.door.placementYAxis?.clone().setY(0)
    if (!placementYAxis || placementYAxis.lengthSq() < 1e-8) {
        return false
    }

    placementYAxis.normalize()
    return placementYAxis.dot(context.viewFrame.semanticFacing) > 0
}

function mirrorResolvedSwingLeaves(leaves: ResolvedSwingLeaf[]): ResolvedSwingLeaf[] {
    return leaves.map((leaf) => ({
        width: leaf.width,
        hingeSide: leaf.hingeSide === 'left' ? 'right' : 'left',
        hingeOffsetFromCenter: -leaf.hingeOffsetFromCenter,
    }))
}
/** Opening angle (radians) for symbolic plan swing graphics. */
const PLAN_SWING_OPEN_RAD = (15 * Math.PI) / 180

function parseOperationType(operationType: string | null): SwingArcParams {
    const info = getDoorOperationInfo(operationType)
    if (info.kind === 'swing' || info.kind === 'fixed') {
        return info.hingeSide ? { type: 'swing', hingeSide: info.hingeSide } : { type: 'none' }
    }
    if (info.kind === 'sliding') {
        return { type: 'sliding', slideDirection: info.slideDirection ?? 'right' }
    }
    if (info.kind === 'folding') {
        return { type: 'folding' }
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

function resolveSwingLeavesForWidth(context: DoorContext, totalWidth: number): ResolvedSwingLeaf[] {
    const params = parseOperationType(context.openingDirection)
    if (params.type !== 'swing' || !params.hingeSide || totalWidth <= 0) {
        return []
    }

    const operableLeaves = context.operableLeaves
    if (operableLeaves?.leaves.length) {
        const scale = operableLeaves.totalWidth > 1e-6 ? totalWidth / operableLeaves.totalWidth : 1
        const leaves = operableLeaves.leaves
            .map((leaf) => ({
                width: leaf.width * scale,
                hingeSide: leaf.hingeSide,
                hingeOffsetFromCenter: leaf.hingeOffsetFromCenter * scale,
            }))
            .filter((leaf) => Number.isFinite(leaf.width) && leaf.width > 0.01)
        if (leaves.length > 0) {
            return shouldMirrorSwingForHandedness(context) ? mirrorResolvedSwingLeaves(leaves) : leaves
        }
    }

    if (params.hingeSide === 'both') {
        return [
            { width: totalWidth / 2, hingeSide: 'left', hingeOffsetFromCenter: -totalWidth / 2 },
            { width: totalWidth / 2, hingeSide: 'right', hingeOffsetFromCenter: totalWidth / 2 },
        ]
    }

    const leaves = [
        {
            width: totalWidth,
            hingeSide: params.hingeSide,
            hingeOffsetFromCenter: params.hingeSide === 'left' ? -totalWidth / 2 : totalWidth / 2,
        },
    ]
    return shouldMirrorSwingForHandedness(context) ? mirrorResolvedSwingLeaves(leaves) : leaves
}

function normalizeSwingLeavesForScreen(
    leaves: ResolvedSwingLeaf[],
    frame: DoorViewFrame,
    camera: THREE.OrthographicCamera,
    width: number,
    height: number,
    cutHeight: number
): ResolvedSwingLeaf[] {
    const center = frame.origin.clone()
    center.y = cutHeight
    const positive = center.clone().add(frame.widthAxis.clone().multiplyScalar(Math.max(frame.width * 0.25, 0.1)))
    const negative = center.clone().add(frame.widthAxis.clone().multiplyScalar(-Math.max(frame.width * 0.25, 0.1)))
    const positiveProj = projectPoint(positive, camera, width, height)
    const negativeProj = projectPoint(negative, camera, width, height)
    const isMirrored = positiveProj.x < negativeProj.x

    if (!isMirrored) {
        return leaves
    }

    return leaves.map((leaf) => ({
        width: leaf.width,
        hingeSide: leaf.hingeSide === 'left' ? 'right' : 'left',
        hingeOffsetFromCenter: -leaf.hingeOffsetFromCenter,
    }))
}

function getPlanSwingReach(context: DoorContext, frame: DoorViewFrame): number {
    const leaves = resolveSwingLeavesForWidth(context, frame.width)
    if (leaves.length === 0) return frame.thickness / 2
    const faceOffset = frame.thickness / 2
    return faceOffset + Math.max(...leaves.map((leaf) => leaf.width * Math.sin(PLAN_SWING_OPEN_RAD)))
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
    faceOffset: number,
    camera: THREE.OrthographicCamera,
    width: number,
    height: number
): ProjectedEdge[] {
    const edges: ProjectedEdge[] = []
    const color = '#666666' // Lighter color for arc
    const pivot3D = hinge3D.clone().add(openAxis.clone().multiplyScalar(faceOffset))

    const startDir = widthAxis.clone().multiplyScalar(Math.cos(startAngle))
        .add(openAxis.clone().multiplyScalar(Math.sin(startAngle)))
        .normalize()

    const arcPoints: THREE.Vector3[] = []
    const numSegments = 20

    for (let i = 0; i <= numSegments; i++) {
        const t = i / numSegments
        const angle = startAngle + (endAngle - startAngle) * t
        const dir = widthAxis.clone().multiplyScalar(Math.cos(angle))
            .add(openAxis.clone().multiplyScalar(Math.sin(angle)))
            .normalize()
        const point = pivot3D.clone().add(dir.multiplyScalar(leafWidth))
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
            isDashed: false,
            strokeWidthFactor: DOOR_EDGE_STROKE_FACTOR,
        })
    }

    const hingeProj = projectPoint(pivot3D, camera, width, height)

    // Add a line showing the door in OPEN position (plan swing angle)
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
        isDashed: true,
        strokeWidthFactor: DOOR_EDGE_STROKE_FACTOR,
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
    const faceOffset = frame.thickness / 2
    const allEdges: ProjectedEdge[] = []
    const leaves = normalizeSwingLeavesForScreen(
        resolveSwingLeavesForWidth(context, frame.width),
        frame,
        camera,
        width,
        height,
        cutHeight
    )
    for (const leaf of leaves) {
        const hinge3D = center.clone().add(widthAxis.clone().multiplyScalar(leaf.hingeOffsetFromCenter))
        hinge3D.y = cutHeight
        allEdges.push(
            ...generateSingleLeafArc(
                hinge3D,
                leaf.width,
                leaf.hingeSide === 'left' ? 0 : Math.PI,
                leaf.hingeSide === 'left' ? PLAN_SWING_OPEN_RAD : Math.PI - PLAN_SWING_OPEN_RAD,
                cutHeight,
                widthAxis,
                openAxis,
                faceOffset,
                camera,
                width,
                height
            )
        )
    }
    return allEdges
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
    options: Required<SVGRenderOptions>,
    flipArc = false
): string {
    const leaves = resolveSwingLeavesForWidth(context, scaledWidth)
    if (leaves.length === 0) {
        return ''
    }

    const { lineColor, lineWidth } = options
    const hingeY = offsetY + (flipArc ? 0 : scaledThickness)
    const screenLeaves = normalizeSwingLeavesForScreen(
        leaves,
        context.viewFrame,
        new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10),
        options.width,
        planSvgCanvasHeight(options.width),
        0
    )

    const segments = screenLeaves.map((leaf) => {
        const hingeX = offsetX + scaledWidth / 2 + leaf.hingeOffsetFromCenter
        const radius = leaf.width
        const startAngle = leaf.hingeSide === 'left' ? Math.PI : 0
        const endAngle = startAngle + PLAN_SWING_OPEN_RAD * (leaf.hingeSide === 'left' ? -1 : 1)
        const startX = hingeX + Math.cos(startAngle) * radius
        const startY = hingeY + Math.sin(startAngle) * radius
        const endX = hingeX + Math.cos(endAngle) * radius
        const endY = hingeY + Math.sin(endAngle) * radius
        const sweepFlag = leaf.hingeSide === 'left' ? 0 : 1
        return `
    <path d="M ${startX},${startY} A ${radius},${radius} 0 0,${sweepFlag} ${endX},${endY}" 
          stroke="${lineColor}" 
          stroke-width="${lineWidth * DOOR_EDGE_STROKE_FACTOR}" 
          fill="none"
          opacity="0.7"/>
    <line x1="${hingeX}" y1="${hingeY}" 
          x2="${endX}" y2="${endY}" 
          stroke="${lineColor}" 
          stroke-width="${lineWidth * DOOR_EDGE_STROKE_FACTOR}" 
          stroke-dasharray="4,2"
          opacity="0.7"/>`
    }).join('\n')

    return `
  <g id="door-swing-arc">
${segments}
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
        edges.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, color: opts.doorColor, depth: 0, layer: 0, strokeWidthFactor: DOOR_EDGE_STROKE_FACTOR })
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

    return { edges, polygons }
}

/**
 * Render plan SVG from detailed mesh geometry
 */
function renderPlanFromMeshes(
    context: DoorContext,
    opts: Required<SVGRenderOptions>,
    sharedDrawingScale?: number
): string {
    const doorMeshes = getDoorMeshes(context)
    if (doorMeshes.length === 0) {
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
    const halfW = frame.width / 2
    const halfT = frame.thickness / 2

    const projectPlanBounds = (depthMin: number, depthMax: number): ProjectedBounds => {
        const corners = [
            frame.origin.clone().add(frame.widthAxis.clone().multiplyScalar(-halfW)).add(frame.semanticFacing.clone().multiplyScalar(depthMin)),
            frame.origin.clone().add(frame.widthAxis.clone().multiplyScalar(halfW)).add(frame.semanticFacing.clone().multiplyScalar(depthMin)),
            frame.origin.clone().add(frame.widthAxis.clone().multiplyScalar(halfW)).add(frame.semanticFacing.clone().multiplyScalar(depthMax)),
            frame.origin.clone().add(frame.widthAxis.clone().multiplyScalar(-halfW)).add(frame.semanticFacing.clone().multiplyScalar(depthMax)),
        ]
        let minX = Infinity
        let maxX = -Infinity
        let minY = Infinity
        let maxY = -Infinity
        for (const corner of corners) {
            corner.y = cutHeight
            const projected = projectPoint(corner, camera, frustumWidth, frustumHeight)
            minX = Math.min(minX, projected.x)
            maxX = Math.max(maxX, projected.x)
            minY = Math.min(minY, projected.y)
            maxY = Math.max(maxY, projected.y)
        }
        return { minX, maxX, minY, maxY }
    }

    const renderGeometry = collectProjectedGeometry(
        doorMeshes,
        context,
        opts,
        camera,
        frustumWidth,
        frustumHeight,
        true,
        0,
        'camera-facing',
        false,
        DOOR_EDGE_STROKE_FACTOR
    )
    const deviceGeometry = createSemanticPlanDeviceGeometry(context, camera, frustumWidth, frustumHeight, cutHeight, opts)
    renderGeometry.edges.push(...deviceGeometry.edges)
    renderGeometry.polygons.push(...deviceGeometry.polygons)

    if (showPlanSwing && context.openingDirection) {
        const arcEdges = calculateSwingArcEdges(context, frame, camera, frustumWidth, frustumHeight, cutHeight, flipArc)
        renderGeometry.edges.push(...arcEdges)
    }

    const planDoorBounds = projectPlanBounds(-halfT, halfT)
    const planWallMetrics = getLocalHostWallPlanMetrics(context)
    const planWallBandBounds = projectPlanBounds(
        planWallMetrics?.minDepth ?? -halfT,
        planWallMetrics?.maxDepth ?? halfT
    )

    // Section the host wall and any nearby walls at the cut plane. This draws
    // the real wall footprint — including perpendicular walls at L-corners,
    // partitions at T-intersections, and varying thicknesses — instead of the
    // two synthetic rectangular stubs that the semantic fallback produces.
    const meshPlanSectionGeometry = createMeshPlanSectionGeometry(
        context,
        camera,
        frustumWidth,
        frustumHeight,
        cutHeight,
        opts
    )
    const hasMeshSection = meshPlanSectionGeometry.polygons.length > 0
        || meshPlanSectionGeometry.edges.some((edge) => edge.color !== 'none')

    // Compute fitGeometry analytically from frame data.
    // Using projected mesh geometry for fitBounds is unreliable: web-ifc meshes viewed from above
    // often produce degenerate edges, and arc edges may be at different positions than the door mesh.
    // Instead, project the semantic corners of the door + arc envelope directly.
    const arcParams = context.openingDirection ? parseOperationType(context.openingDirection) : null
    const hasSwingArc = showPlanSwing && arcParams?.type === 'swing' && !!arcParams.hingeSide
    // openAxisFit must match the arc direction so the fit bounds contain both the door and the arc.
    const openAxisFit = flipArc ? frame.semanticFacing.clone().negate() : frame.semanticFacing.clone()
    const arcReach = hasSwingArc ? getPlanSwingReach(context, frame) : frame.thickness / 2

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
    // Prefer the real mesh-based section; fall back to the synthetic two-stub
    // drawing only when no wall meshes are available (e.g. Fragments-only
    // pipeline without detailed geometry, or no host wall at all).
    const planWallGeometry = hasMeshSection
        ? meshPlanSectionGeometry
        : createSemanticPlanWallGeometry(context, camera, frustumWidth, frustumHeight, opts)

    // Expand fit bounds to include every vertex of the wall-section geometry so
    // the plan viewport doesn't crop nearby walls / returns.
    if (hasMeshSection) {
        for (const polygon of planWallGeometry.polygons) {
            for (const point of polygon.points) {
                fitGeometry.edges.push({
                    x1: point.x, y1: point.y, x2: point.x, y2: point.y,
                    color: 'none', depth: 0, layer: 0,
                })
            }
        }
    }

    const hostGeometry = (planWallGeometry.edges.length > 0 || planWallGeometry.polygons.length > 0)
        ? clipProjectedGeometryToBounds(
            planWallGeometry,
            getViewportClipBounds(fitGeometry, opts, context, sharedDrawingScale, 'Plan')
        )
        : { edges: [], polygons: [] }
    renderGeometry.edges.push(...hostGeometry.edges)
    renderGeometry.polygons.push(...hostGeometry.polygons)
    const hasPlanWallGeometry = hostGeometry.edges.length > 0 || hostGeometry.polygons.length > 0

    return generateSVGString(
        renderGeometry.edges,
        renderGeometry.polygons,
        opts,
        fitGeometry,
        {
            context,
            viewType: 'Plan',
            planArcFlip: flipArc,
            suppressSyntheticWallBands: hasPlanWallGeometry,
            planDoorBounds,
            planWallBandBounds: { minY: planWallBandBounds.minY, maxY: planWallBandBounds.maxY },
            ...(sharedDrawingScale !== undefined ? { sharedDrawingScale } : {}),
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
    const labelHeight = showLabels ? fontSize * 4 + 72 : 0
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
    const planWallMetrics = getLocalHostWallPlanMetrics(context)
    const scalePxPerMeter = scaledThickness / Math.max(doorThickness, 1e-6)
    const wallThicknessPx = planWallMetrics
        ? Math.max(planWallMetrics.thickness * scalePxPerMeter, 12)
        : Math.max(scaledThickness, 12)
    const doorMinDepth = -doorThickness / 2
    const planBandY = planWallMetrics
        ? offsetY + (planWallMetrics.minDepth - doorMinDepth) * scalePxPerMeter
        : offsetY
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
                wallThicknessPx,
                planBandY,
                planBandHeight: wallThicknessPx,
                planArcFlip: false,
            }),
            wallColor,
            lineColor,
            lineWidth
        )
        : ''

    const arrowY = offsetY + scaledThickness + 30
    const arrowEndY = arrowY + 25

    const fontDefs = svgWebFontDefs(opts.fontFamily)
    let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">
${fontDefs}  <rect width="100%" height="100%" fill="${backgroundColor}"/>
${wallRevealSvg}

  <!-- Door outline (bounding box fallback) -->
  <rect x="${offsetX}" y="${offsetY}" width="${scaledWidth}" height="${scaledThickness}" 
        fill="${doorColor}" fill-opacity="1" stroke="${lineColor}" stroke-width="${lineWidth * DOOR_EDGE_STROKE_FACTOR}"/>
  
  ${renderSwingArcSVGForBoundingBox(
      context,
      offsetX,
      offsetY,
      scaledWidth,
      scaledThickness,
      opts,
      shouldRenderPlanSwing(context.viewFrame) ? shouldFlipPlanArc(context, context.viewFrame) : false
  )}
  
  <!-- Front direction arrow -->
  <line x1="${svgWidth / 2}" y1="${arrowY}" x2="${svgWidth / 2}" y2="${arrowEndY}" 
        stroke="${lineColor}" stroke-width="${lineWidth}"/>
  <polygon points="${svgWidth / 2},${arrowEndY + 8} ${svgWidth / 2 - 5},${arrowEndY} ${svgWidth / 2 + 5},${arrowEndY}" 
           fill="${lineColor}"/>
`

    if (showLabels) {
        const labelY = svgHeight - (fontSize * 3 + 24)
        svg += `
  <!-- Labels -->
  <text x="${svgWidth / 2}" y="${arrowEndY + 25}" text-anchor="middle" font-family="${fontFamily}" font-size="${fontSize}" fill="${lineColor}">
    Vorderansicht
  </text>
  <text x="${svgWidth / 2}" y="${labelY}" text-anchor="middle" font-family="${fontFamily}" font-size="${fontSize}" fill="${lineColor}">
    Grundriss (vereinfacht)
  </text>
  <text x="${svgWidth / 2}" y="${labelY + fontSize + 4}" text-anchor="middle" font-family="${fontFamily}" font-size="${fontSize}" fill="#666">
    ${escapeSvgText(context.doorId)}
  </text>
  <text x="${svgWidth / 2}" y="${labelY + fontSize * 2 + 8}" text-anchor="middle" font-family="${fontFamily}" font-size="${fontSize}" fill="#888">
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
    const opts = normalizeRenderOptions(options)
    const sharedScaleFromFront =
        context.detailedGeometry && context.detailedGeometry.doorMeshes.length > 0
            ? computeFrontElevationScale(context, opts)
            : undefined

    const front = await renderDoorElevationSVG(context, false, options)
    const back = await renderDoorElevationSVG(context, true, options)
    const plan = await renderDoorPlanSVG(context, options, sharedScaleFromFront)

    return { front, back, plan }
}
