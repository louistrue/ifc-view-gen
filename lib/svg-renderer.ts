import * as THREE from 'three'
import type { DoorContext, DoorViewFrame } from './door-analyzer'
import {
    getDoorMeshes,
    getDoorOperationInfo,
    getHostCeilingMeshes,
    getHostSlabMeshes,
    getHostWallMeshes,
    getHostAndCoplanarWallMeshes,
    getCoplanarHostWallExpressIDs,
    getNearbyDoorMeshes,
    getNearbyWindowMeshes,
    getNearbyStairMeshes,
    getNearbyWallMeshes,
    getWallAggregatePartMeshesForParent,
} from './door-analyzer'
import {
    INTER_WOFF2_LATIN_400_BASE64,
    INTER_WOFF2_LATIN_600_BASE64,
    INTER_WOFF2_LATIN_700_BASE64,
} from './inter-svg-font-embed-data'
import {
    classifyDoorBKP,
    isSafetyDevice,
    loadRenderColors,
    resolveElevationDoorColor,
    resolveWallCutColor,
    resolveWallElevationColor,
} from './color-config'

export interface SVGRenderOptions {
    width?: number
    height?: number
    margin?: number // meters
    /**
     * Grundriss (detailed mesh): fester Weltabstand um die Tür entlang Breite und
     * Öffnungsnormale — die Fit-/Clip-Zone; alles außerhalb wird beschnitten (Zoom
     * folgt nicht dem größten Element). Standard 0.5 m.
     */
    planCropMarginMeters?: number
    doorColor?: string
    wallColor?: string
    floorSlabColor?: string
    deviceColor?: string
    /** Fill color for glazing in Vorder-/Rückansicht only; Grundriss uses `doorColor` for those meshes. */
    glassColor?: string
    /** Fill for safety/alarm devices (Rauchmelder, Notleuchte, …). Classified by `isSafetyDevice` (layer + name). */
    safetyColor?: string
    /** Fill for IfcCovering.CEILING. (abgehängte Decke / suspended ceiling). Defaults to `elevation.suspendedCeiling`. */
    suspendedCeilingColor?: string
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

/**
 * Elevation rendering policy (single mode, always on):
 *   - canvas: 1000×1000 square, no title block, no legend, no labels.
 *   - scale: FIXED at `FIXED_PX_PER_METER` for every door + every view so the
 *     same wall thickness reads the same pixel width across the fleet. Picked
 *     so a 4 m slab-to-slab storey (10 cm upper slab + 3.8 m floor + 10 cm
 *     lower slab — the design max) exactly fills the picture height.
 *   - vertical: content bottom anchored to the canvas bottom. The 10 cm upper-
 *     slab and 10 cm lower-slab crop from `getElevationHostClipBounds` is
 *     always drawn in full — no overflow for storeys up to 4 m.
 *   - horizontal: door frame origin anchored to the canvas width centre so
 *     front/back/plan agree on the door's X position. Wall panels and slab
 *     strips extend to the canvas edges (no side gutter, no white border).
 *   - plan: fits bounds centred, uses its own scale, but door X still lines
 *     up with the elevations.
 */

/** Fixed drawing scale in SVG pixels per metre. 285 × 3.5 m ≈ 1000 SVG px,
 * filling the 1000 px square canvas at the 3.5 m content cap. Lateral canvas
 * window 1000/285 ≈ 3.5 m, enough to show cut-wall reveals on both sides of a
 * 2.5 m door. */
export const FIXED_PX_PER_METER = 285

/** Elevation canvas is edge-to-edge content — no pads anywhere. */
export const ELEVATION_TOP_PAD_PX = 0
export const ELEVATION_BOTTOM_PAD_PX = 0
export const ELEVATION_SIDE_PAD_PX = 0

/** Plan SVG canvas is square (1.0) to match elevation dimensions, so when the
 * three views are stacked in Airtable's grid the door anchor lines up across
 * all three at the same X. Plan content is vertically centred inside the
 * square; extra whitespace top/bottom is the trade-off. Set < 1 to crop. */
export const PLAN_SVG_HEIGHT_RATIO = 1.0

export function planSvgCanvasHeight(canvasWidth: number): number {
    return Math.round(canvasWidth * PLAN_SVG_HEIGHT_RATIO)
}

// Colour defaults are resolved once from `config/render-colors.json` (palette-
// based). The renderer still accepts per-call overrides via SVGRenderOptions;
// anything not supplied falls back to the palette value below.
const COLORS = loadRenderColors()

const DEFAULT_OPTIONS: Required<SVGRenderOptions> = {
    width: 1000,
    height: 1000,
    margin: 0.5,
    planCropMarginMeters: 0.5,
    doorColor: COLORS.elevation.door.default,
    wallColor: COLORS.elevation.wall,
    floorSlabColor: COLORS.plan.wallCut,
    deviceColor: COLORS.plan.electrical,
    glassColor: COLORS.elevation.glass,
    safetyColor: COLORS.plan.safety,
    suspendedCeilingColor: COLORS.elevation.suspendedCeiling,
    glassFillOpacity: 0.32,
    backgroundColor: '#fff',
    lineWidth: 1.5,
    lineColor: COLORS.strokes.outline,
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

/** Open mesh-section chains whose endpoints lie within this (xz) distance are closed for gray fill. */
const PLAN_OPEN_CHAIN_NEAR_CLOSE_METERS = 0.025
const DEVICE_EDGE_STROKE_FACTOR = 1.0
const CONTEXT_DOOR_EDGE_STROKE_FACTOR = 0.55
const CONTEXT_DOOR_FILL_COLOR = COLORS.plan.doorContext
const CONTEXT_DOOR_LINE_COLOR = COLORS.strokes.outline
const CONTEXT_DOOR_FILL_OPACITY = 0.32

const DEBUG_ELEVATION_COLORS =
    typeof process !== 'undefined' && process.env && process.env.DEBUG_ELEVATION_COLORS === '1'
const DEBUG_PALETTE = [
    '#e6194B', '#3cb44b', '#ffe119', '#4363d8',
    '#f58231', '#911eb4', '#42d4f4', '#f032e6',
    '#bfef45', '#fabed4', '#469990', '#9A6324',
    '#800000', '#808000', '#000075',
]

function debugColorFor(expressID: number | null | undefined): string | null {
    if (!DEBUG_ELEVATION_COLORS || typeof expressID !== 'number') return null
    return DEBUG_PALETTE[expressID % DEBUG_PALETTE.length]
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
    // Adjacent / nearby doors: glass panes still read blau; the leaf/frame
    // takes the BKP colour of THAT specific door (metal → anthrazit, wood →
    // hellbraun, unknown → default). Without this branch nearby doors fell
    // through to the synthetic rectangle path and showed as hellgrau rects.
    const isNearbyDoor = context.nearbyDoors.some((d) => d.expressID === expressID)
    if (isNearbyDoor) {
        if (useGlassStyling && isLikelyGlazingPanelMesh(mesh)) {
            return { color: options.glassColor, fillOpacity: options.glassFillOpacity }
        }
        return { color: resolveElevationDoorColor(context.nearbyDoorBKP.get(expressID)) }
    }
    if (isHostSlab) {
        const dbg = debugColorFor(expressID)
        return { color: dbg ?? options.floorSlabColor }
    }
    // Wall BKP resolver: drywall (CFC 2711) paints graubraun, default concrete /
    // masonry paints grau. `useGlassStyling === true` means we're rendering an
    // elevation view; `false` means the plan-cut view. Both views use the same
    // palette but live under different roles so the spec can diverge later.
    const resolveWallColor = (expressID: number): string => {
        const cfc = context.wallBKP?.get(expressID) ?? null
        return useGlassStyling
            ? resolveWallElevationColor(cfc)
            : resolveWallCutColor(cfc)
    }
    if (
        (context.hostWall && expressID === context.hostWall.expressID)
        || (context.wall && expressID === context.wall.expressID)
    ) {
        const dbg = debugColorFor(expressID)
        return { color: dbg ?? resolveWallColor(expressID) }
    }
    if (context.nearbyWalls?.some((w) => w.expressID === expressID)) {
        const dbg = debugColorFor(expressID)
        return { color: dbg ?? resolveWallColor(expressID) }
    }
    // IfcBuildingElementPart children of a wall (cladding, insulation, gypsum
    // board, etc.) have their own expressIDs but visually belong to the wall.
    // Without this branch they fell through to the deviceColor fallback and
    // rendered as big orange rectangles beside the door.
    if (context.wallAggregatePartLinks?.some((link) => link.part.expressID === expressID)) {
        const dbg = debugColorFor(expressID)
        return { color: dbg ?? resolveWallColor(expressID) }
    }
    if (DEBUG_ELEVATION_COLORS) {
        // Everything that falls through — the meshes we currently can't explain
        // — gets a bright magenta so any unexpected geometry stands out.
        return { color: '#ff00ff' }
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
    return (
        context.hostSlabsBelow.length > 0
        || context.hostSlabsAbove.length > 0
        || context.hostCeilings.length > 0
        || context.nearbyStairs.length > 0
    )
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

            const edgeColor = debugColorFor(expressID) ?? options.lineColor
            edges.push(...extractEdges(mesh, camera, edgeColor, width, height, clipZ, layer, edgeStrokeWidthFactor))

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

/**
 * Like `measureMeshesInAxes` but only counts vertices whose projection on
 * `axisC` falls within `[centerC - halfWidth, centerC + halfWidth]`. Used to
 * extract the TRUE cross-section of a nearby wall at the door's elevation
 * plane — vertices far in front of / behind the door (e.g. a perpendicular
 * wall extending 4 m into the back room) are excluded, so the rendered rect
 * matches the visible cut face instead of the wall's full bbox.
 */
function measureMeshesInAxesDepthBand(
    meshes: THREE.Mesh[],
    axisA: THREE.Vector3,
    axisB: THREE.Vector3,
    axisC: THREE.Vector3,
    centerC: number,
    halfWidth: number
): AxisBounds | null {
    let minA = Infinity
    let maxA = -Infinity
    let minB = Infinity
    let maxB = -Infinity
    let minC = Infinity
    let maxC = -Infinity
    const lo = centerC - halfWidth
    const hi = centerC + halfWidth
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
            const c = point.dot(axisC)
            if (c < lo || c > hi) return
            const a = point.dot(axisA)
            const b = point.dot(axisB)
            if (a < minA) minA = a
            if (a > maxA) maxA = a
            if (b < minB) minB = b
            if (b > maxB) maxB = b
            if (c < minC) minC = c
            if (c > maxC) maxC = c
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

/**
 * Pick the closest structural IfcSlab face above or below the door.
 *  - `above` returns the slab's lower face (minB) in frame-dy space (positive)
 *  - `below` returns the slab's upper face (maxB) in frame-dy space (negative)
 * Aggregate parts (IfcBuildingElementPart) represent floor build-up layers
 * (screed, isolation, topping) — they are NOT structural concrete and are
 * filtered out here so the section crop always lands on the real slab.
 */
function getStructuralSlabFaceDy(
    context: DoorContext,
    direction: 'above' | 'below'
): number | null {
    const frame = context.viewFrame
    const slabs = direction === 'above' ? context.hostSlabsAbove : context.hostSlabsBelow
    const originB = frame.origin.dot(frame.upAxis)
    let best: number | null = null
    let partFallback: number | null = null
    for (const slab of slabs) {
        if (!slab.boundingBox) continue
        const slabBounds = measureBoundingBoxInAxes(
            slab.boundingBox,
            frame.widthAxis,
            frame.upAxis,
            frame.semanticFacing
        )
        const isPart = (slab.typeName || '').toUpperCase() === 'IFCBUILDINGELEMENTPART'
        if (isPart) {
            // -1UG and similar storeys can have hostSlabsAbove/Below populated
            // ONLY with IfcBuildingElementPart parts (raised floor / cladding /
            // insulation). The structural slab face is the part-stack's outer
            // boundary toward the slab body — for 'below' that's the bottom of
            // the lowest part (where the part rests on the structural slab),
            // for 'above' the top of the highest part (where the part hangs
            // off the slab underside).
            const partFace = direction === 'above'
                ? slabBounds.maxB - originB
                : slabBounds.minB - originB
            if (!Number.isFinite(partFace)) continue
            if (partFallback == null) {
                partFallback = partFace
            } else if (direction === 'above' ? partFace > partFallback : partFace < partFallback) {
                partFallback = partFace
            }
            continue
        }
        const face = direction === 'above'
            ? slabBounds.minB - originB
            : slabBounds.maxB - originB
        if (!Number.isFinite(face)) continue
        if (best == null) {
            best = face
        } else if (direction === 'above' ? face < best : face > best) {
            best = face
        }
    }
    return best ?? partFallback
}

/** Show 10 cm of the structural slab at the top and bottom of every elevation. */
const STRUCTURAL_SLAB_INTRUSION_METERS = 0.10

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
    /** IFC expressID of the source element, used by renderers to look up BKP / colour. */
    expressID?: number
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

function appendProjectedRectPolygon(
    geometry: { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] },
    bounds: ProjectedBounds,
    fillColor: string,
    layer: number,
    fillOpacity: number = 1
): void {
    geometry.polygons.push({
        points: [
            { x: bounds.minX, y: bounds.minY },
            { x: bounds.maxX, y: bounds.minY },
            { x: bounds.maxX, y: bounds.maxY },
            { x: bounds.minX, y: bounds.maxY },
        ],
        color: fillColor,
        depth: 0,
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
    const minReveal = THREE.MathUtils.clamp(Math.max(wallThickness * 1.2, 0.22), 0.18, 0.6)
    const halfDoorWidth = frame.width / 2
    const bottom = -frame.height / 2
    const topGap = getElevationTopBandGapMeters(context) ?? 0
    const top = frame.height / 2 + topGap
    const outerTop = top + minReveal
    const originA = frame.origin.dot(frame.widthAxis)
    const originB = frame.origin.dot(frame.upAxis)
    const leftExtent = Math.max((originA - halfDoorWidth) - wallBounds.minA, 0)
    const rightExtent = Math.max(wallBounds.maxA - (originA + halfDoorWidth), 0)
    const topExtent = Math.max(wallBounds.maxB - (originB + top), 0)

    const rects: THREE.Vector3[][] = []
    if (leftExtent > 0.01) {
        const revealWidth = Math.max(leftExtent, minReveal)
        rects.push(createRectPoints3D(frame.origin, frame.widthAxis, frame.upAxis, -halfDoorWidth - revealWidth, -halfDoorWidth, bottom, outerTop))
    }
    if (rightExtent > 0.01) {
        const revealWidth = Math.max(rightExtent, minReveal)
        rects.push(createRectPoints3D(frame.origin, frame.widthAxis, frame.upAxis, halfDoorWidth, halfDoorWidth + revealWidth, bottom, outerTop))
    }
    if (topExtent > 0.01 || context.hostCeilings.length > 0 || context.hostSlabsAbove.length > 0) {
        const revealHeight = Math.max(topExtent, minReveal)
        rects.push(createRectPoints3D(frame.origin, frame.widthAxis, frame.upAxis, -halfDoorWidth, halfDoorWidth, top, top + revealHeight))
    }

    const hostWallCfc = context.hostWall ? context.wallBKP?.get(context.hostWall.expressID) ?? null : null
    const hostWallElevColor = resolveWallElevationColor(hostWallCfc) ?? options.wallColor
    for (const rect of rects) {
        appendProjectedPolygon(geometry, rect, camera, width, height, hostWallElevColor, options.lineColor, -1, 1, WALL_EDGE_STROKE_FACTOR)
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
    const slabRects: Array<AxisRect & { expressID: number }> = []
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
            expressID: slab.expressID,
        })
    }

    const mergedRects = slabRects
        .map((rect) => ({ ...rect }))
        .sort((a, b) => a.minB - b.minB || a.maxB - b.maxB || a.minA - b.minA)

    // Skip merging in debug mode so every slab renders as its own coloured rect.
    if (!DEBUG_ELEVATION_COLORS) {
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

        const debugColor = debugColorFor(rect.expressID)
        const fillColor = debugColor ?? options.floorSlabColor
        const edgeColor = debugColor ?? options.lineColor

        appendProjectedFillPolygon(
            geometry,
            corners,
            camera,
            width,
            height,
            fillColor,
            -1,
            DEBUG_ELEVATION_COLORS ? 0.55 : 1
        )

        appendProjectedEdge(geometry, corners[3], corners[2], camera, width, height, edgeColor, -1, WALL_EDGE_STROKE_FACTOR)
        appendProjectedEdge(geometry, corners[0], corners[1], camera, width, height, edgeColor, -1, WALL_EDGE_STROKE_FACTOR)
        appendProjectedEdge(geometry, corners[0], corners[3], camera, width, height, edgeColor, -1, WALL_EDGE_STROKE_FACTOR)
        appendProjectedEdge(geometry, corners[1], corners[2], camera, width, height, edgeColor, -1, WALL_EDGE_STROKE_FACTOR)
    }

    return geometry
}

function measureMeshesOrBoxInAxes(
    meshes: THREE.Mesh[],
    fallbackBox: THREE.Box3 | undefined,
    axisA: THREE.Vector3,
    axisB: THREE.Vector3,
    axisC: THREE.Vector3
): AxisBounds | null {
    return measureMeshesInAxes(meshes, axisA, axisB, axisC)
        ?? (fallbackBox ? measureBoundingBoxInAxes(fallbackBox, axisA, axisB, axisC) : null)
}

function shouldRenderHostCeilingInElevation(
    context: DoorContext,
    ceilingExpressID: number,
    isBackView: boolean
): boolean {
    const side = context.hostCeilingVisibility?.find(
        (entry) => entry.ceilingExpressID === ceilingExpressID
    )?.side

    if (side === 'front') return !isBackView
    if (side === 'back') return isBackView
    if (side === 'both' || side === 'unknown') return true

    // Legacy contexts do not carry per-covering side metadata.
    return true
}

function getHostCeilingAxisRects(context: DoorContext, isBackView: boolean): AxisRect[] {
    const frame = context.viewFrame
    const originA = frame.origin.dot(frame.widthAxis)
    const originB = frame.origin.dot(frame.upAxis)
    const ceilingMeshes = getHostCeilingMeshes(context)
    const meshQueue = [...ceilingMeshes]
    const rects: AxisRect[] = []
    const seenIDs = new Set<number>()

    // Ceilings in IFC often span multiple rooms — their raw bbox runs past
    // perpendicular walls at T-junctions. Clamp each strip to the actual
    // wall footprint along the door's widthAxis so the ceiling stops where
    // the wall does (e.g. at the T-junction that visually cuts the room).
    const footprint = getElevationWallFootprintLocalA(context)

    for (const ceiling of context.hostCeilings) {
        if (!ceiling.boundingBox || seenIDs.has(ceiling.expressID)) continue
        const visibleForView = shouldRenderHostCeilingInElevation(context, ceiling.expressID, isBackView)
        if (!visibleForView) continue
        seenIDs.add(ceiling.expressID)
        const meshes = meshQueue.filter((mesh) => mesh.userData.expressID === ceiling.expressID)
        const bounds = measureMeshesOrBoxInAxes(
            meshes,
            ceiling.boundingBox,
            frame.widthAxis,
            frame.upAxis,
            frame.semanticFacing
        )
        if (!bounds || bounds.maxA <= bounds.minA || bounds.maxB <= bounds.minB) {
            continue
        }
        let minA = bounds.minA - originA
        let maxA = bounds.maxA - originA
        if (footprint) {
            minA = Math.max(minA, footprint.minA)
            maxA = Math.min(maxA, footprint.maxA)
        }
        if (maxA <= minA) {
            continue
        }
        rects.push({
            minA,
            maxA,
            minB: bounds.minB - originB,
            maxB: bounds.maxB - originB,
        })
    }

    return rects
}

/**
 * Returns the widthAxis extent (door-local, origin-subtracted) of all
 * elements that actually back up the door in elevation: host wall, nearby
 * walls, the door itself, and nearby doors (storefront/curtain-wall cases
 * where glass panels ARE the wall). Anything outside this range is empty
 * space in the real model and should not receive wall backdrop or ceiling
 * fill — so the elevation stops cleanly at T-junctions / L-corners / the
 * far end of a storefront.
 *
 * For walls we use element bounding boxes (or a depth-filtered mesh scan
 * for the host), not raw mesh vertices — web-ifc's boolean cut for the door
 * opening leaves phantom vertices that extend well beyond the wall's real
 * footprint and would defeat the clamp.
 */
function getElevationWallFootprintLocalA(context: DoorContext): { minA: number; maxA: number } | null {
    const frame = context.viewFrame
    const widthAxis = frame.widthAxis
    const originA = frame.origin.dot(widthAxis)
    let minA = Infinity
    let maxA = -Infinity

    const includeRange = (lo: number, hi: number) => {
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) return
        if (lo < minA) minA = lo
        if (hi > maxA) maxA = hi
    }

    const boxRange = (box: THREE.Box3) =>
        measureBoundingBoxInAxes(box, widthAxis, frame.upAxis, frame.semanticFacing)

    // Element bounding boxes are tight. Raw mesh vertices are NOT —
    // web-ifc's boolean cut for the door opening leaves phantom triangles
    // that can extend many metres beyond the wall's real footprint, even
    // after a depth filter.
    if (context.hostWall?.boundingBox) {
        const b = boxRange(context.hostWall.boundingBox)
        includeRange(b.minA, b.maxA)
    }
    for (const wall of context.nearbyWalls) {
        if (!wall.boundingBox) continue
        const b = boxRange(wall.boundingBox)
        includeRange(b.minA, b.maxA)
    }
    for (const d of context.nearbyDoors ?? []) {
        if (!d.boundingBox) continue
        const b = boxRange(d.boundingBox)
        includeRange(b.minA, b.maxA)
    }
    if (context.door.boundingBox) {
        const b = boxRange(context.door.boundingBox)
        includeRange(b.minA, b.maxA)
    } else {
        const doorBounds = measureMeshesInAxes(getDoorMeshes(context), widthAxis, frame.upAxis, frame.semanticFacing)
        if (doorBounds) includeRange(doorBounds.minA, doorBounds.maxA)
    }

    if (minA === Infinity) return null
    return { minA: minA - originA, maxA: maxA - originA }
}

function getNearbyDoorAxisRects(context: DoorContext): AxisRect[] {
    const frame = context.viewFrame
    const originA = frame.origin.dot(frame.widthAxis)
    const originB = frame.origin.dot(frame.upAxis)
    const originC = frame.origin.dot(frame.semanticFacing)
    const seenDoorIDs = new Set<number>()
    const rects: AxisRect[] = []
    const nearbyDoorMeshes = getNearbyDoorMeshes(context)

    // Only show nearby doors that actually sit in (or straddle) the host
    // wall plane. A door far down a perpendicular hallway would otherwise
    // ghost onto this elevation as a translucent overlay even though
    // architecturally it's in a different wall. Test the nearby door's
    // depth CENTER (not its range) so a long wall barely clipping the
    // tolerance band cannot smuggle a hallway door through.
    const DEPTH_CENTER_TOLERANCE_METERS = Math.max(frame.thickness, 0.08) + 0.10

    for (const nearbyDoor of context.nearbyDoors || []) {
        if (seenDoorIDs.has(nearbyDoor.expressID) || !nearbyDoor.boundingBox) {
            continue
        }
        seenDoorIDs.add(nearbyDoor.expressID)

        const meshes = nearbyDoorMeshes.filter((mesh) => mesh.userData.expressID === nearbyDoor.expressID)
        const bounds = measureMeshesOrBoxInAxes(
            meshes,
            nearbyDoor.boundingBox,
            frame.widthAxis,
            frame.upAxis,
            frame.semanticFacing
        )
        if (!bounds || (
            !Number.isFinite(bounds.minA)
            || !Number.isFinite(bounds.maxA)
            || !Number.isFinite(bounds.minB)
            || !Number.isFinite(bounds.maxB)
            || bounds.maxA <= bounds.minA
            || bounds.maxB <= bounds.minB
        )) {
            continue
        }

        const depthCenter = (bounds.minC + bounds.maxC) / 2 - originC
        if (Math.abs(depthCenter) > DEPTH_CENTER_TOLERANCE_METERS) {
            continue
        }

        rects.push({
            minA: bounds.minA - originA,
            maxA: bounds.maxA - originA,
            minB: bounds.minB - originB,
            maxB: bounds.maxB - originB,
            expressID: nearbyDoor.expressID,
        })
    }

    return rects
}

function getNearbyDoorPlanRects(context: DoorContext, cutHeight: number): AxisRect[] {
    const frame = context.viewFrame
    const originA = frame.origin.dot(frame.widthAxis)
    const originB = frame.origin.dot(frame.semanticFacing)
    const tolerance = Math.max(0.08, frame.thickness)
    const nearbyDoorMeshes = getNearbyDoorMeshes(context)
    const rects: AxisRect[] = []
    const seenIDs = new Set<number>()

    for (const nearbyDoor of context.nearbyDoors || []) {
        if (!nearbyDoor.boundingBox || seenIDs.has(nearbyDoor.expressID)) continue
        seenIDs.add(nearbyDoor.expressID)
        if (nearbyDoor.boundingBox.min.y > cutHeight + tolerance || nearbyDoor.boundingBox.max.y < cutHeight - tolerance) {
            continue
        }

        const meshes = nearbyDoorMeshes.filter((mesh) => mesh.userData.expressID === nearbyDoor.expressID)
        const bounds = measureMeshesOrBoxInAxes(
            meshes,
            nearbyDoor.boundingBox,
            frame.widthAxis,
            frame.semanticFacing,
            frame.upAxis
        )
        if (!bounds || bounds.maxA <= bounds.minA || bounds.maxB <= bounds.minB) continue

        rects.push({
            minA: bounds.minA - originA,
            maxA: bounds.maxA - originA,
            minB: bounds.minB - originB,
            maxB: bounds.maxB - originB,
            expressID: nearbyDoor.expressID,
        })
    }

    return rects
}

function getNearbyWindowAxisRects(context: DoorContext): AxisRect[] {
    const frame = context.viewFrame
    const originA = frame.origin.dot(frame.widthAxis)
    const originB = frame.origin.dot(frame.upAxis)
    const seenIDs = new Set<number>()
    const rects: AxisRect[] = []
    const nearbyWindowMeshes = getNearbyWindowMeshes(context)

    for (const win of context.nearbyWindows || []) {
        if (seenIDs.has(win.expressID) || !win.boundingBox) {
            continue
        }
        seenIDs.add(win.expressID)

        const meshes = nearbyWindowMeshes.filter((mesh) => mesh.userData.expressID === win.expressID)
        const bounds = measureMeshesOrBoxInAxes(
            meshes,
            win.boundingBox,
            frame.widthAxis,
            frame.upAxis,
            frame.semanticFacing
        )
        if (!bounds || (
            !Number.isFinite(bounds.minA)
            || !Number.isFinite(bounds.maxA)
            || !Number.isFinite(bounds.minB)
            || !Number.isFinite(bounds.maxB)
            || bounds.maxA <= bounds.minA
            || bounds.maxB <= bounds.minB
        )) {
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

function getNearbyWindowPlanRects(context: DoorContext, cutHeight: number): AxisRect[] {
    const frame = context.viewFrame
    const originA = frame.origin.dot(frame.widthAxis)
    const originB = frame.origin.dot(frame.semanticFacing)
    const tolerance = Math.max(0.08, frame.thickness)
    const nearbyWindowMeshes = getNearbyWindowMeshes(context)
    const rects: AxisRect[] = []
    const seenIDs = new Set<number>()

    for (const win of context.nearbyWindows || []) {
        if (!win.boundingBox || seenIDs.has(win.expressID)) continue
        seenIDs.add(win.expressID)
        if (win.boundingBox.min.y > cutHeight + tolerance || win.boundingBox.max.y < cutHeight - tolerance) {
            continue
        }

        const meshes = nearbyWindowMeshes.filter((mesh) => mesh.userData.expressID === win.expressID)
        const bounds = measureMeshesOrBoxInAxes(
            meshes,
            win.boundingBox,
            frame.widthAxis,
            frame.semanticFacing,
            frame.upAxis
        )
        if (!bounds || bounds.maxA <= bounds.minA || bounds.maxB <= bounds.minB) continue

        rects.push({
            minA: bounds.minA - originA,
            maxA: bounds.maxA - originA,
            minB: bounds.minB - originB,
            maxB: bounds.maxB - originB,
        })
    }

    return rects
}

function getNearbyStairAxisRects(context: DoorContext): AxisRect[] {
    const frame = context.viewFrame
    const originA = frame.origin.dot(frame.widthAxis)
    const originB = frame.origin.dot(frame.upAxis)
    const stairMeshes = getNearbyStairMeshes(context)
    const rects: AxisRect[] = []
    const seenIDs = new Set<number>()

    for (const stair of context.nearbyStairs) {
        if (!stair.boundingBox || seenIDs.has(stair.expressID)) continue
        seenIDs.add(stair.expressID)
        const meshes = stairMeshes.filter((mesh) => mesh.userData.expressID === stair.expressID)
        const bounds = measureMeshesOrBoxInAxes(
            meshes,
            stair.boundingBox,
            frame.widthAxis,
            frame.upAxis,
            frame.semanticFacing
        )
        if (!bounds || bounds.maxA <= bounds.minA || bounds.maxB <= bounds.minB) continue
        rects.push({
            minA: bounds.minA - originA,
            maxA: bounds.maxA - originA,
            minB: bounds.minB - originB,
            maxB: bounds.maxB - originB,
        })
    }

    return rects
}

/**
 * Project the TRUE 3D mesh geometry of every adjacent door. Uses the same
 * sharp-edge / polygon pipeline as the current door — no synthetic outer
 * rectangle, no fake inset frame. Colour per door comes from
 * `getMeshPolygonStyle` which reads `context.nearbyDoorBKP` → palette. Glass
 * panes still fall through to `options.glassColor`.
 *
 * Falls back to a bbox rectangle (BKP-coloured, still no inset) only when a
 * door has no mesh data at all.
 */
function createSemanticElevationNearbyDoorGeometry(
    context: DoorContext,
    camera: THREE.OrthographicCamera,
    width: number,
    height: number,
    options: Required<SVGRenderOptions>
): { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] } {
    const geometry = { edges: [], polygons: [] } as { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] }
    const frame = context.viewFrame
    const nearbyDoorMeshes = getNearbyDoorMeshes(context)

    if (nearbyDoorMeshes.length > 0) {
        // `cullMode: 'none'` so single-sided glazing panels render in BOTH
        // front and back views. With 'camera-facing' their outward-facing
        // normal gets culled on whichever side faces away from the camera,
        // which is why adjacent doors rendered blue glass on one view and
        // grey frame-only on the other (0OLNP8lGUkIgzNri… case).
        const projected = collectProjectedGeometry(
            nearbyDoorMeshes,
            context,
            options,
            camera,
            width,
            height,
            false,
            -0.25,
            'none',
            true,
            DOOR_EDGE_STROKE_FACTOR
        )
        geometry.edges.push(...projected.edges)
        geometry.polygons.push(...projected.polygons)
    }

    const meshIdsWithGeometry = new Set<number>()
    for (const mesh of nearbyDoorMeshes) {
        const eid = mesh.userData?.expressID
        if (typeof eid === 'number') meshIdsWithGeometry.add(eid)
    }

    for (const rect of getNearbyDoorAxisRects(context)) {
        if (rect.expressID !== undefined && meshIdsWithGeometry.has(rect.expressID)) continue
        const fill = resolveElevationDoorColor(context.nearbyDoorBKP.get(rect.expressID ?? -1))
        const outer = createRectPoints3D(
            frame.origin,
            frame.widthAxis,
            frame.upAxis,
            rect.minA,
            rect.maxA,
            rect.minB,
            rect.maxB
        )
        appendProjectedFillPolygon(geometry, outer, camera, width, height, fill, -0.25, 1)
        appendProjectedEdge(geometry, outer[0], outer[1], camera, width, height, options.lineColor, -0.25, DOOR_EDGE_STROKE_FACTOR)
        appendProjectedEdge(geometry, outer[1], outer[2], camera, width, height, options.lineColor, -0.25, DOOR_EDGE_STROKE_FACTOR)
        appendProjectedEdge(geometry, outer[2], outer[3], camera, width, height, options.lineColor, -0.25, DOOR_EDGE_STROKE_FACTOR)
        appendProjectedEdge(geometry, outer[3], outer[0], camera, width, height, options.lineColor, -0.25, DOOR_EDGE_STROKE_FACTOR)
    }

    return geometry
}

/**
 * Plan-view adjacent doors: project the real mesh (same pipeline as the
 * current door's top-down projection). BKP-coloured per door via
 * `getMeshPolygonStyle`. Fallback bbox rectangle only if a door has no mesh.
 */
function createSemanticPlanNearbyDoorGeometry(
    context: DoorContext,
    camera: THREE.OrthographicCamera,
    width: number,
    height: number,
    cutHeight: number,
    options: Required<SVGRenderOptions>
): { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] } {
    const geometry = { edges: [], polygons: [] } as { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] }
    const frame = context.viewFrame
    const nearbyDoorMeshes = getNearbyDoorMeshes(context)

    if (nearbyDoorMeshes.length > 0) {
        const projected = collectProjectedGeometry(
            nearbyDoorMeshes,
            context,
            options,
            camera,
            width,
            height,
            true,
            -0.25,
            'camera-facing',
            false,
            DOOR_EDGE_STROKE_FACTOR
        )
        geometry.edges.push(...projected.edges)
        geometry.polygons.push(...projected.polygons)
    }

    const meshIdsWithGeometry = new Set<number>()
    for (const mesh of nearbyDoorMeshes) {
        const eid = mesh.userData?.expressID
        if (typeof eid === 'number') meshIdsWithGeometry.add(eid)
    }

    for (const rect of getNearbyDoorPlanRects(context, cutHeight)) {
        if (rect.expressID !== undefined && meshIdsWithGeometry.has(rect.expressID)) continue
        const fill = resolveElevationDoorColor(context.nearbyDoorBKP.get(rect.expressID ?? -1))
        const outer = createRectPoints3D(
            frame.origin.clone().add(frame.upAxis.clone().multiplyScalar(cutHeight - frame.origin.y)),
            frame.widthAxis,
            frame.semanticFacing,
            rect.minA,
            rect.maxA,
            rect.minB,
            rect.maxB
        )
        appendProjectedFillPolygon(geometry, outer, camera, width, height, fill, -0.25, 1)
        for (let i = 0; i < outer.length; i++) {
            appendProjectedEdge(
                geometry,
                outer[i],
                outer[(i + 1) % outer.length],
                camera,
                width,
                height,
                options.lineColor,
                -0.25,
                DOOR_EDGE_STROKE_FACTOR
            )
        }
    }

    return geometry
}

function createSemanticElevationNearbyWindowGeometry(
    _context: DoorContext,
    _camera: THREE.OrthographicCamera,
    _width: number,
    _height: number
): { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] } {
    // Intentionally empty: the AABB rect around each nearby window drew a
    // square silhouette over round window cutouts (boolean-cut openings in
    // the host wall already render as their real shape via the wall mesh's
    // sharp-edge projection). Relying on the mesh-level silhouette means a
    // round window reads as a circle, not a square with a circle inside.
    return { edges: [], polygons: [] }
}

function createSemanticPlanNearbyWindowGeometry(
    context: DoorContext,
    camera: THREE.OrthographicCamera,
    width: number,
    height: number,
    cutHeight: number
): { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] } {
    // Empty: rendering nearby windows as their AABB rect drew big squares
    // around round-window cutouts when the window's bbox happens to straddle
    // cutHeight. The wall's mesh-section already produces the actual hole
    // for windows that ARE cut at the plane (perpendicular walls); high or
    // low windows correctly disappear instead of showing a fake bbox at the
    // cut plane. Same policy as `createSemanticElevationNearbyWindowGeometry`.
    return { edges: [], polygons: [] }
}

function createSemanticElevationCeilingGeometry(
    context: DoorContext,
    camera: THREE.OrthographicCamera,
    width: number,
    height: number,
    options: Required<SVGRenderOptions>,
    isBackView: boolean
): { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] } {
    const geometry = { edges: [], polygons: [] } as { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] }
    const frame = context.viewFrame

    for (const rect of getHostCeilingAxisRects(context, isBackView)) {
        const corners = createRectPoints3D(
            frame.origin,
            frame.widthAxis,
            frame.upAxis,
            rect.minA,
            rect.maxA,
            rect.minB,
            rect.maxB
        )
        // Drop-ceiling hides anything behind it in elevation — including the
        // top strip of the door frame that extends into the plenum. Draw the
        // ceiling at a layer ABOVE the door mesh (door uses layer 0) with
        // opaque fill so the door's outer silhouette verticals terminate at
        // the ceiling's lower edge instead of cutting through it.
        appendProjectedFillPolygon(geometry, corners, camera, width, height, options.suspendedCeilingColor, 2, 1)
        // Only the horizontal top+bottom edges are real silhouette lines; the
        // vertical side edges are per-ceiling bbox artefacts (two IfcCoverings
        // meeting above the door) and print as phantom verticals at door-width.
        appendProjectedEdge(geometry, corners[0], corners[1], camera, width, height, options.lineColor, 2, WALL_EDGE_STROKE_FACTOR)
        appendProjectedEdge(geometry, corners[2], corners[3], camera, width, height, options.lineColor, 2, WALL_EDGE_STROKE_FACTOR)
    }

    return geometry
}

function createSemanticElevationNearbyWallGeometry(
    context: DoorContext,
    camera: THREE.OrthographicCamera,
    width: number,
    height: number,
    options: Required<SVGRenderOptions>
): { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] } {
    const geometry = { edges: [], polygons: [] } as { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] }
    const frame = context.viewFrame
    const originA = frame.origin.dot(frame.widthAxis)
    const originB = frame.origin.dot(frame.upAxis)
    const originC = frame.origin.dot(frame.semanticFacing)
    // Vertical clamp still uses the door's storey band; lateral clamping is
    // handled downstream by `elevationHostClipBounds` so perpendicular walls
    // outside the door-width corridor (e.g. ±1.3 m at a niche) don't get
    // collapsed to empty rects here.
    const minB = -frame.height / 2 - getElevationBottomContextGapMeters(context) - 0.1
    const maxB = frame.height / 2 + getElevationTopContextGapMeters(context) + 0.2

    // Depth band along `semanticFacing` — vertices outside this band don't
    // contribute to the elevation cut rect. A perpendicular wall extending
    // 4 m into the back room has its far end well outside this band, so we
    // only capture the cross-section near the door plane. Band width covers a
    // typical wall thickness + a small margin for finishes/aggregate layers.
    const depthHalfWidth = Math.max(frame.thickness, 0.20) + 0.20

    const nearbyWallMeshesAll = getNearbyWallMeshes(context)
    // Coplanar nearby walls are rendered as part of the host wall (mesh fill +
    // edges); skipping them here avoids duplicate "schematic rect" overlays.
    const coplanarHostWallIDs = getCoplanarHostWallExpressIDs(context)

    // Collect strips per (label, meshes, fallbackBoundingBox). The label is
    // used only for BKP fill resolution; "meshes" / "fallbackBoundingBox"
    // drive the actual extent measurement.
    interface Strip { label: 'wall' | 'part'; expressID: number; meshes: THREE.Mesh[]; fallbackBox?: THREE.Box3 | null; bkpKey: number }
    const strips: Strip[] = []
    for (const wall of context.nearbyWalls) {
        if (coplanarHostWallIDs.has(wall.expressID)) continue
        const meshesForWall = nearbyWallMeshesAll.filter((m) => m.userData?.expressID === wall.expressID)
        strips.push({
            label: 'wall',
            expressID: wall.expressID,
            meshes: meshesForWall,
            fallbackBox: wall.boundingBox ?? null,
            bkpKey: wall.expressID,
        })
        // Aggregate parts of the nearby wall: render each part as its own
        // strip. Modellers sometimes attach perpendicular wall stubs on the
        // OPPOSITE side of the door under the same parent IfcWall — the
        // parent's bbox doesn't span those parts, so a single strip per
        // wall misses them entirely (03X27dQWY: wall 52745 at door's right
        // has parts at door's left forming the left stirnseite).
        for (const link of context.wallAggregatePartLinks ?? []) {
            if (link.parentWallExpressID !== wall.expressID) continue
            const partMeshes = nearbyWallMeshesAll.filter((m) => m.userData?.expressID === link.part.expressID)
            if (partMeshes.length === 0 && !link.part.boundingBox) continue
            strips.push({
                label: 'part',
                expressID: link.part.expressID,
                meshes: partMeshes,
                fallbackBox: link.part.boundingBox ?? null,
                bkpKey: wall.expressID,
            })
        }
    }

    for (const strip of strips) {
        let bounds: AxisBounds | null = null
        if (strip.meshes.length > 0) {
            bounds = measureMeshesInAxesDepthBand(
                strip.meshes,
                frame.widthAxis,
                frame.upAxis,
                frame.semanticFacing,
                originC,
                depthHalfWidth
            )
        }
        if (!bounds && strip.fallbackBox) {
            bounds = measureBoundingBoxInAxes(
                strip.fallbackBox,
                frame.widthAxis,
                frame.upAxis,
                frame.semanticFacing
            )
        }
        if (!bounds) continue
        const rect: AxisRect = {
            minA: bounds.minA - originA,
            maxA: bounds.maxA - originA,
            minB: Math.max(bounds.minB - originB, minB),
            maxB: Math.min(bounds.maxB - originB, maxB),
        }
        if (rect.maxA <= rect.minA || rect.maxB <= rect.minB) continue
        if (rect.maxA - rect.minA < 0.18) {
            const expand = (0.18 - (rect.maxA - rect.minA)) / 2
            rect.minA = rect.minA - expand
            rect.maxA = rect.maxA + expand
        }
        if (rect.maxB - rect.minB < 0.4) {
            const expand = (0.4 - (rect.maxB - rect.minB)) / 2
            rect.minB = Math.max(rect.minB - expand, minB)
            rect.maxB = Math.min(rect.maxB + expand, maxB)
        }
        if (rect.maxA <= rect.minA || rect.maxB <= rect.minB) continue
        const corners = createRectPoints3D(frame.origin, frame.widthAxis, frame.upAxis, rect.minA, rect.maxA, rect.minB, rect.maxB)
        const wallCfc = context.wallBKP?.get(strip.bkpKey) ?? null
        const wallFill = resolveWallElevationColor(wallCfc) ?? options.wallColor
        appendProjectedFillPolygon(geometry, corners, camera, width, height, wallFill, -0.8, 1)
        for (let i = 0; i < corners.length; i++) {
            appendProjectedEdge(geometry, corners[i], corners[(i + 1) % corners.length], camera, width, height, options.lineColor, -0.8, WALL_EDGE_STROKE_FACTOR)
        }
    }

    return geometry
}

function createSemanticElevationStairGeometry(
    context: DoorContext,
    camera: THREE.OrthographicCamera,
    width: number,
    height: number,
    options: Required<SVGRenderOptions>
): { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] } {
    const geometry = { edges: [], polygons: [] } as { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] }
    const frame = context.viewFrame

    for (const rect of getNearbyStairAxisRects(context)) {
        const corners = createRectPoints3D(
            frame.origin,
            frame.widthAxis,
            frame.upAxis,
            rect.minA,
            rect.maxA,
            rect.minB,
            rect.maxB
        )
        appendProjectedFillPolygon(geometry, corners, camera, width, height, options.floorSlabColor, -0.6, 0.18)
        for (let i = 0; i < corners.length; i++) {
            appendProjectedEdge(geometry, corners[i], corners[(i + 1) % corners.length], camera, width, height, options.lineColor, -0.6, WALL_EDGE_STROKE_FACTOR)
        }
    }

    return geometry
}

function createProjectedElevationWallBackdropGeometry(
    frame: DoorViewFrame,
    camera: THREE.OrthographicCamera,
    width: number,
    height: number,
    clipBounds: ProjectedBounds | null,
    options: Required<SVGRenderOptions>,
    footprintLocalA: { minA: number; maxA: number } | null = null,
    wallColorOverride?: string
): { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] } {
    const geometry = { edges: [], polygons: [] } as { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] }
    if (!clipBounds) return geometry

    // Left/right backdrop panels span the entire clip-band height. The
    // slab/ceiling strips (drawn at depth -1) layer on top, so letting the
    // backdrop extend to clipBounds.minY / clipBounds.maxY never visibly
    // conflicts with the slab band — it just closes the "white gap" above
    // the host wall where nearby walls get dropped by the back-view
    // occlusion filter.
    const wallMinY = clipBounds.minY
    const wallMaxY = clipBounds.maxY

    // Clamp the backdrop's horizontal extent to the real wall footprint along
    // the door's widthAxis. This stops the fill at T-junctions / L-corners /
    // the end of a storefront instead of bleeding across the whole clip band
    // into open space that has no actual wall behind it.
    let wallMinX = clipBounds.minX
    let wallMaxX = clipBounds.maxX
    if (footprintLocalA) {
        const leftPt = frame.origin.clone().add(frame.widthAxis.clone().multiplyScalar(footprintLocalA.minA))
        const rightPt = frame.origin.clone().add(frame.widthAxis.clone().multiplyScalar(footprintLocalA.maxA))
        const leftPx = projectPoint(leftPt, camera, width, height).x
        const rightPx = projectPoint(rightPt, camera, width, height).x
        wallMinX = Math.max(clipBounds.minX, Math.min(leftPx, rightPx))
        wallMaxX = Math.min(clipBounds.maxX, Math.max(leftPx, rightPx))
    }

    const doorBounds = projectElevationDoorBounds(frame, camera, width, height)
    // If the door pokes outside the wall footprint (shouldn't normally, but be
    // defensive), keep the top/bottom header/footer panels aligned with the
    // door itself rather than collapsing them.
    const doorMinX = Math.min(Math.max(doorBounds.minX, wallMinX), wallMaxX)
    const doorMaxX = Math.min(Math.max(doorBounds.maxX, wallMinX), wallMaxX)
    const panels: ProjectedBounds[] = [
        { minX: wallMinX, maxX: doorMinX, minY: wallMinY, maxY: wallMaxY },
        { minX: doorMaxX, maxX: wallMaxX, minY: wallMinY, maxY: wallMaxY },
        { minX: doorMinX, maxX: doorMaxX, minY: clipBounds.minY, maxY: doorBounds.minY },
        { minX: doorMinX, maxX: doorMaxX, minY: doorBounds.maxY, maxY: clipBounds.maxY },
    ]

    // Panels are in world metres (not pixels) — the previous `< 1` skip
    // threshold silently dropped any panel shorter than 1 metre, which meant
    // the top-header and bottom-footer panels (often 0.2–0.6 m tall) never
    // drew. Use 1 cm instead so only truly degenerate rects are skipped.
    const MIN_PANEL_DIM_METERS = 0.01
    const wallColor = wallColorOverride ?? options.wallColor
    for (const panel of panels) {
        if (panel.maxX - panel.minX < MIN_PANEL_DIM_METERS || panel.maxY - panel.minY < MIN_PANEL_DIM_METERS) continue
        appendProjectedRectPolygon(geometry, panel, wallColor, -1.5, 1)
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
        // When exactly two vertices lie on the cut plane, the shared edge IS the section
        // edge — but only if the triangle's THIRD vertex is meaningfully off the plane.
        // For features whose geometry only TANGENTIALLY touches cutY (e.g. a maintenance
        // opening / revisionsöffnung whose bottom edge sits at 1.80 m without actually
        // crossing it), the on-plane edge is just a tangent and shouldn't be drawn as a
        // section. Require ≥ 5 mm out-of-plane to suppress those phantoms.
        if (sides.filter((s) => s === 0).length === 2) {
            const offPlaneIdx = sides.findIndex((s) => s !== 0)
            if (offPlaneIdx >= 0) {
                const offPlaneDistance = Math.abs(verts[offPlaneIdx].y - cutY)
                if (offPlaneDistance < 0.005) return
            }
            const onPlane = verts.filter((_, i) => sides[i] === 0)
            registerSegment(
                new THREE.Vector3(onPlane[0].x, cutY, onPlane[0].z),
                new THREE.Vector3(onPlane[1].x, cutY, onPlane[1].z)
            )
            return
        }
        // Skip triangles that lie entirely on one side of the plane (no intersection).
        if (sides.every((s) => s >= 0) || sides.every((s) => s <= 0)) return

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

function xzDistanceSquared(a: THREE.Vector3, b: THREE.Vector3): number {
    const dx = a.x - b.x
    const dz = a.z - b.z
    return dx * dx + dz * dz
}

/**
 * If an open boundary chain almost returns to its start (IFC mesh gaps / float noise),
 * treat it as a closed loop for plan fill. Requires at least four vertices so that
 * after dropping the redundant end we still have a triangle (same style as
 * {@link reconstructPolygonsFromSegments} closed loops: no duplicate first vertex).
 */
function tryPromoteNearlyClosedOpenChain(chain: THREE.Vector3[], epsM: number): THREE.Vector3[] | null {
    if (chain.length < 4) return null
    const first = chain[0]
    const last = chain[chain.length - 1]
    const epsSq = epsM * epsM
    if (xzDistanceSquared(first, last) > epsSq) return null

    const core = chain.slice(0, -1).map((p) => {
        const q = p.clone()
        q.y = first.y
        return q
    })
    const deduped: THREE.Vector3[] = []
    const tinySq = (epsM * 0.25) ** 2
    for (const p of core) {
        if (deduped.length === 0 || xzDistanceSquared(deduped[deduped.length - 1], p) > tinySq) {
            deduped.push(p)
        }
    }
    if (deduped.length < 3) return null
    return deduped
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
 * Render a group of wall meshes (e.g. host wall + its IfcBuildingElementPart
 * cladding/insulation parts) as one combined plan-section. Segments from every
 * mesh are MERGED before reconstruction so the seams between parts close into
 * proper filled polygons instead of fragmenting into outline-only edges (the
 * "missing cutted buildingelementpart walls" failure for -1UG).
 */
function addMeshPlanSectionForWallGroup(
    meshes: THREE.Mesh[],
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
    const segments: Array<{ a: THREE.Vector3; b: THREE.Vector3 }> = []
    for (const mesh of meshes) {
        segments.push(...extractMeshSectionSegments(mesh, cutY))
    }
    if (segments.length === 0) return 0
    const { closedLoops, openChains } = reconstructPolygonsFromSegments(segments)

    const promotedClosed: THREE.Vector3[][] = []
    const remainingOpen: THREE.Vector3[][] = []
    for (const chain of openChains) {
        const promoted = tryPromoteNearlyClosedOpenChain(chain, PLAN_OPEN_CHAIN_NEAR_CLOSE_METERS)
        if (promoted) promotedClosed.push(promoted)
        else remainingOpen.push(chain)
    }

    let emitted = 0

    for (const loop of [...closedLoops, ...promotedClosed]) {
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
    for (const chain of remainingOpen) {
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

    // Corridor: depth stays bounded to a narrow band around the host-wall
    // plane (otherwise the section would include geometry metres away from
    // the door along semanticFacing), but width is unbounded so the wall
    // extends as far as the mesh reaches. The SVG viewBox is the only
    // lateral crop — no synthetic closing line inside the drawing area.
    const frame = context.viewFrame
    const widthAxis = frame.widthAxis.clone().normalize()
    const depthAxis = frame.semanticFacing.clone().normalize()
    const halfT = frame.thickness / 2
    const planPad = Math.max(options.planCropMarginMeters, 0)
    const wallMetrics = getLocalHostWallPlanMetrics(context)
    const hostWallThickness = wallMetrics?.thickness ?? frame.thickness
    const depthHalfSpan = Math.max(halfT, hostWallThickness / 2) + planPad
    const relDepthMin = -depthHalfSpan
    const relDepthMax = depthHalfSpan
    const originDepth = frame.origin.dot(depthAxis)

    // Lateral clamp: shared with elevation via `getSharedLateralExtentLocal`,
    // which derives the visible widthAxis range from the host wall's mesh-
    // cut at cutY. When the host wall stops short of lateralGap, both views
    // clip at the wall's actual end so context stays consistent.
    const halfDoorWidth = frame.width / 2
    const lateralGap = THREE.MathUtils.clamp(frame.width * 0.5, 0.5, 1.5)
    const sharedExtent = getSharedLateralExtentLocal(context)
    let lateralMinLocal: number
    let lateralMaxLocal: number
    if (sharedExtent) {
        lateralMinLocal = Math.min(Math.max(sharedExtent.minLocal, -halfDoorWidth - lateralGap), -halfDoorWidth)
        lateralMaxLocal = Math.max(Math.min(sharedExtent.maxLocal, halfDoorWidth + lateralGap), halfDoorWidth)
    } else {
        lateralMinLocal = -halfDoorWidth - lateralGap
        lateralMaxLocal = halfDoorWidth + lateralGap
    }
    const originWidth = frame.origin.dot(widthAxis)
    const corridor: PlanSectionCorridor = {
        widthAxis,
        depthAxis,
        minWidth: originWidth + lateralMinLocal,
        maxWidth: originWidth + lateralMaxLocal,
        minDepth: originDepth + relDepthMin,
        maxDepth: originDepth + relDepthMax,
    }

    // Plan wall rendering is mesh-only — no bbox under-fill, no synthetic
    // rects. Closed-loop reconstruction merges segments from the host wall
    // AND its IfcBuildingElementPart cladding/insulation parts so seams
    // between parts collapse into one continuous fill polygon (otherwise the
    // -1UG cladding cuts dropped to outline-only and the wall read as thin
    // lines). Each wall + its parts forms one group; nearby walls each form
    // their own group so independent cuts don't merge across rooms.
    const hostWallCfc = context.hostWall ? context.wallBKP?.get(context.hostWall.expressID) ?? null : null
    const hostWallCutColor = resolveWallCutColor(hostWallCfc) ?? options.wallColor

    const groups: THREE.Mesh[][] = []
    if (hostMeshes.length > 0) groups.push(hostMeshes)
    if (nearbyMeshes.length > 0) {
        // Group nearby meshes per parent wall via expressID so each adjacent
        // wall's parts merge with itself but not with another wall.
        const byParent = new Map<number, THREE.Mesh[]>()
        const orphan: THREE.Mesh[] = []
        for (const mesh of nearbyMeshes) {
            const id = mesh.userData?.expressID
            if (typeof id !== 'number') { orphan.push(mesh); continue }
            const arr = byParent.get(id) ?? []
            arr.push(mesh)
            byParent.set(id, arr)
        }
        for (const meshes of byParent.values()) groups.push(meshes)
        if (orphan.length > 0) groups.push(orphan)
    }

    for (const meshes of groups) {
        addMeshPlanSectionForWallGroup(
            meshes,
            cutY,
            corridor,
            camera,
            width,
            height,
            hostWallCutColor,
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

    const hostWallCfcPlan = context.hostWall ? context.wallBKP?.get(context.hostWall.expressID) ?? null : null
    const hostWallPlanColor = resolveWallCutColor(hostWallCfcPlan) ?? options.wallColor
    for (const rect of rects) {
        appendProjectedPolygon(geometry, rect, camera, width, height, hostWallPlanColor, options.lineColor, -1, 1, WALL_EDGE_STROKE_FACTOR)
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

const PLAN_CUT_HEIGHT_METERS = 1.8

/**
 * Single source of truth for the lateral (widthAxis) crop window shared by
 * plan + elevation. Runs the host wall's mesh-section at cutY and returns
 * the widthAxis extent of the resulting segments in coordinates LOCAL to
 * frame.origin. The corridor clamps both views to this same extent so the
 * door anchor's visible context width is identical in plan and elevation
 * (eliminates the "Kontext ist nicht gleich breit" misalignment when the
 * two views are stacked).
 *
 * Returns null when the host wall has no triangles crossing cutY (sparse
 * mesh) — callers fall back to the door-anchored lateralGap.
 */
function getSharedLateralExtentLocal(
    context: DoorContext
): { minLocal: number; maxLocal: number } | null {
    const frame = context.viewFrame
    const cutY = frame.origin.y - frame.height / 2 + PLAN_CUT_HEIGHT_METERS
    const originW = frame.origin.dot(frame.widthAxis)
    // Combine all segments from the host wall + its aggregate parts and run
    // the same reconstruction the plan view does — then take the widthAxis
    // extent of the reconstructed CLOSED LOOPS only. Loops are the wall's
    // actual visible cut at cutY; raw segments include phantom triangle
    // edges from boolean-cut artefacts and aggregate parts that extend past
    // the rendered footprint. Falls back to all segments if no closed loops
    // emerge (sparse meshes).
    const allSegs: Array<{ a: THREE.Vector3; b: THREE.Vector3 }> = []
    // Include coplanar nearby walls so the corridor extent reflects the FULL
    // wall in storefront / curtain-wall layouts where the door is hosted by
    // a tiny stub (03X27dQWY: 8 cm host stub plus 40 m coplanar wall).
    for (const mesh of getHostAndCoplanarWallMeshes(context)) {
        allSegs.push(...extractMeshSectionSegments(mesh, cutY))
    }
    if (allSegs.length === 0) return null
    const { closedLoops, openChains } = reconstructPolygonsFromSegments(allSegs)
    let minLocal = Infinity
    let maxLocal = -Infinity
    const collect = (pts: THREE.Vector3[]) => {
        for (const p of pts) {
            const w = p.dot(frame.widthAxis) - originW
            if (w < minLocal) minLocal = w
            if (w > maxLocal) maxLocal = w
        }
    }
    if (closedLoops.length > 0) {
        for (const loop of closedLoops) collect(loop)
    } else {
        for (const chain of openChains) collect(chain)
    }
    if (minLocal === Infinity) return null
    if (process.env.DEBUG_SHARED_LATERAL === '1') {
        console.log(`[shared] door=${context.doorId} closedLoops=${closedLoops.length} openChains=${openChains.length} extent=[${minLocal.toFixed(3)}, ${maxLocal.toFixed(3)}]`)
    }
    return { minLocal, maxLocal }
}

function deviceVisibleInPlan(context: DoorContext, device: THREE.Box3): boolean {
    const frame = context.viewFrame
    const cutHeight = frame.origin.y - frame.height / 2 + PLAN_CUT_HEIGHT_METERS
    // Standard architectural convention: anything whose lowest point sits at
    // or below the cut plane projects into the plan. A ceiling light at
    // y=2.5 m has min.y > cut and is (correctly) omitted; a wall switch,
    // outlet, or low appliance is kept regardless of whether it spans the
    // cut line.
    return device.min.y <= cutHeight + 0.02
}

function shouldRenderDeviceInPlan(
    context: DoorContext,
    deviceExpressID: number
): boolean {
    const device = context.nearbyDevices.find((entry) => entry.expressID === deviceExpressID)
    if (!device?.boundingBox || !context.door.boundingBox) {
        return false
    }

    const side = (context.nearbyDeviceVisibility || []).find(
        (entry) => entry.deviceExpressID === deviceExpressID
    )?.side

    if (side === 'front' || side === 'back') {
        return deviceVisibleInPlan(context, device.boundingBox)
    }
    if (side === 'unknown') {
        return false
    }

    // Preserve previous behavior only for truly legacy contexts with no metadata.
    return deviceVisibleInPlan(context, device.boundingBox)
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
    const hostWallCfcForDevices = context.hostWall ? context.wallBKP?.get(context.hostWall.expressID) ?? null : null
    const hostWallElevColorForDevices = resolveWallElevationColor(hostWallCfcForDevices) ?? options.wallColor
    const allDeviceMeshes = context.detailedGeometry?.deviceMeshes ?? []

    for (const device of context.nearbyDevices) {
        if (!shouldRenderDeviceInElevation(context, device.expressID, isBackView)) {
            continue
        }
        const deviceFill = isSafetyDevice(device.name, context.deviceLayers?.get(device.expressID) ?? null) ? options.safetyColor : options.deviceColor

        // Real mesh path: project the IFC geometry as-is. Honest size from the
        // model — Gegensprechanlage panel renders as ~20×25cm because that's
        // the bbox in the elec IFC, intercom-mounted-on-jamb shows the actual
        // panel footprint, not a thinned re-projection of the world bbox.
        const deviceMeshes = allDeviceMeshes.filter((m) => m.userData?.expressID === device.expressID)
        const hasMesh = deviceMeshes.length > 0 && deviceMeshes.some(
            (m) => (m.geometry?.attributes?.position?.count ?? 0) > 0
        )

        if (hasMesh) {
            // 1) Project the mesh
            const projected = collectProjectedGeometry(
                deviceMeshes,
                context,
                options,
                camera,
                width,
                height,
                false,
                1,
                'camera-facing',
                false,
                DEVICE_EDGE_STROKE_FACTOR
            )
            // 2) Compute the projected 2D bbox in screen coords for the wall-color
            // backdrop. Backdrop is a flat rect occluding the host-wall fill so the
            // device edges read clearly.
            if (hasWallContext && projected.polygons.length > 0) {
                let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
                let depthSum = 0, depthCount = 0
                for (const poly of projected.polygons) {
                    for (const pt of poly.points) {
                        if (pt.x < minX) minX = pt.x
                        if (pt.x > maxX) maxX = pt.x
                        if (pt.y < minY) minY = pt.y
                        if (pt.y > maxY) maxY = pt.y
                    }
                    depthSum += poly.depth
                    depthCount++
                }
                if (depthCount > 0 && maxX - minX > 0.5 && maxY - minY > 0.5) {
                    geometry.polygons.push({
                        points: [
                            { x: minX, y: minY },
                            { x: maxX, y: minY },
                            { x: maxX, y: maxY },
                            { x: minX, y: maxY },
                        ],
                        color: hostWallElevColorForDevices,
                        depth: depthSum / depthCount + 0.001,
                        layer: -1,
                        skipClip: true,
                        fillOpacity: 1,
                    })
                }
            }
            // 3) Override device polygon fill, mark skipClip so wall-clip
            // bounds don't crop devices on the corridor edge.
            for (const poly of projected.polygons) {
                poly.color = deviceFill
                poly.fillOpacity = 1
                poly.skipClip = true
            }
            geometry.polygons.push(...projected.polygons)

            // Silhouette outline: 2D convex hull of all projected vertices.
            // This gives the device's outer outline without showing internal
            // mesh seams (button details, recessed features). Plan keeps the
            // full mesh edges (the cut requires the inner line work).
            const allPoints: { x: number; y: number }[] = []
            for (const poly of projected.polygons) {
                for (const pt of poly.points) allPoints.push(pt)
            }
            const hull = convexHull2D(allPoints)
            if (hull.length >= 2) {
                let depthSum = 0, depthCount = 0, layerVal = 1
                for (const poly of projected.polygons) {
                    depthSum += poly.depth
                    depthCount++
                    layerVal = poly.layer ?? layerVal
                }
                const depth = depthCount > 0 ? depthSum / depthCount - 0.001 : -1
                for (let i = 0; i < hull.length; i++) {
                    const a = hull[i]
                    const b = hull[(i + 1) % hull.length]
                    geometry.edges.push({
                        x1: a.x, y1: a.y, x2: b.x, y2: b.y,
                        color: options.lineColor,
                        depth,
                        layer: layerVal,
                        skipClip: true,
                        strokeWidthFactor: DEVICE_EDGE_STROKE_FACTOR,
                    })
                }
            }
            continue
        }

        // Fallback: no mesh available — synthesize a rect from the bbox so the
        // device still shows up. Same logic as before v12.
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
                color: hostWallElevColorForDevices,
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
        appendProjectedPolygon(geometry, rect, camera, width, height, deviceFill, options.lineColor, 1, 1, DEVICE_EDGE_STROKE_FACTOR)
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
    const allDeviceMeshes = context.detailedGeometry?.deviceMeshes ?? []

    for (const device of context.nearbyDevices) {
        if (!shouldRenderDeviceInPlan(context, device.expressID)) {
            continue
        }
        const deviceFill = isSafetyDevice(device.name, context.deviceLayers?.get(device.expressID) ?? null) ? options.safetyColor : options.deviceColor

        // Plan view is a horizontal cut at cutHeight. We honour the real mesh
        // by projecting the mesh edges/polygons (orthographic top-down camera
        // already in place). Mesh extent in the up-axis doesn't affect the
        // horizontal projection, so the cut-height is implicitly satisfied.
        const deviceMeshes = allDeviceMeshes.filter((m) => m.userData?.expressID === device.expressID)
        const hasMesh = deviceMeshes.length > 0 && deviceMeshes.some(
            (m) => (m.geometry?.attributes?.position?.count ?? 0) > 0
        )
        if (hasMesh) {
            const projected = collectProjectedGeometry(
                deviceMeshes,
                context,
                options,
                camera,
                width,
                height,
                false,
                0,
                'camera-facing',
                false,
                DEVICE_EDGE_STROKE_FACTOR
            )
            for (const poly of projected.polygons) {
                poly.color = deviceFill
                poly.fillOpacity = 1
            }
            for (const edge of projected.edges) {
                edge.color = options.lineColor
            }
            geometry.polygons.push(...projected.polygons)
            geometry.edges.push(...projected.edges)
            continue
        }

        // Fallback: synthesize a rect from bbox.
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
        appendProjectedPolygon(geometry, rect, camera, width, height, deviceFill, options.lineColor, 0, 1, DEVICE_EDGE_STROKE_FACTOR)
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

interface EdgeClipResult {
    edge: ProjectedEdge
    /** True iff the edge was modified by clipping (one or both endpoints moved
     * because the edge crossed the bounds). False if the edge was already
     * fully inside bounds — including the degenerate case of a vertical edge
     * that natively lives exactly at minX/maxX, which must NOT be confused
     * with a "closing line" clip artifact. */
    clippedLaterally: boolean
}

function clipEdgeToBounds(edge: ProjectedEdge, bounds: ProjectedBounds): ProjectedEdge | null {
    const result = clipEdgeToBoundsResult(edge, bounds)
    return result?.edge ?? null
}

/**
 * 2D convex hull (Andrew's monotone chain). Returns hull vertices in CCW
 * order. Used by the elevation device renderer to draw the device silhouette
 * outline from the projected mesh vertices, hiding internal mesh seams
 * (buttons, recesses) while keeping the outer outline. Empty / degenerate
 * inputs return as-is.
 */
function convexHull2D(points: { x: number; y: number }[]): { x: number; y: number }[] {
    if (points.length < 3) return [...points]
    const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
    const cross = (
        O: { x: number; y: number },
        A: { x: number; y: number },
        B: { x: number; y: number }
    ) => (A.x - O.x) * (B.y - O.y) - (A.y - O.y) * (B.x - O.x)
    const lower: { x: number; y: number }[] = []
    for (const p of sorted) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
        lower.push(p)
    }
    const upper: { x: number; y: number }[] = []
    for (let i = sorted.length - 1; i >= 0; i--) {
        const p = sorted[i]
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
        upper.push(p)
    }
    return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}

function clipEdgeToBoundsResult(edge: ProjectedEdge, bounds: ProjectedBounds): EdgeClipResult | null {
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

    // Track whether each lateral test moved t0/t1 (i.e., the edge crossed the
    // lateral bound). The vertical (y) tests don't matter for "closing line"
    // detection — that artifact only appears at minX/maxX.
    const t0Before = t0
    const t1Before = t1
    const lateralOk = clipTest(-dx, edge.x1 - bounds.minX) && clipTest(dx, bounds.maxX - edge.x1)
    const clippedLaterally = lateralOk && (t0 > t0Before + 1e-9 || t1 < t1Before - 1e-9)
    if (!lateralOk) return null
    if (
        !clipTest(-dy, edge.y1 - bounds.minY)
        || !clipTest(dy, bounds.maxY - edge.y1)
    ) {
        return null
    }

    return {
        edge: {
            ...edge,
            x1: edge.x1 + t0 * dx,
            y1: edge.y1 + t0 * dy,
            x2: edge.x1 + t1 * dx,
            y2: edge.y1 + t1 * dy,
        },
        clippedLaterally,
    }
}

/**
 * Subtract `rect` from `edge`: returns 0–2 segments of the original edge that
 * fall OUTSIDE the rect. Edges entirely inside the rect produce []; edges
 * that don't touch the rect produce the input edge unchanged. Used to occlude
 * background mesh edges (e.g. host wall jamb verticals continuing through
 * the floor build-up below the door bottom) by foreground polygon AABBs
 * (slab/ceiling/perpendicular wall rects). Mirrors the user's mental model
 * for the elevation: lines "behind" a foreground element are hidden.
 */
function subtractRectFromEdge(edge: ProjectedEdge, rect: ProjectedBounds): ProjectedEdge[] {
    const dx = edge.x2 - edge.x1
    const dy = edge.y2 - edge.y1

    let t0 = 0
    let t1 = 1

    const test = (p: number, q: number): boolean => {
        if (Math.abs(p) < 1e-9) return q >= 0
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
        !test(-dx, edge.x1 - rect.minX)
        || !test(dx, rect.maxX - edge.x1)
        || !test(-dy, edge.y1 - rect.minY)
        || !test(dy, rect.maxY - edge.y1)
    ) {
        return [edge]
    }

    const out: ProjectedEdge[] = []
    const TOL = 1e-3
    if (t0 > TOL) {
        out.push({
            ...edge,
            x2: edge.x1 + t0 * dx,
            y2: edge.y1 + t0 * dy,
        })
    }
    if (t1 < 1 - TOL) {
        out.push({
            ...edge,
            x1: edge.x1 + t1 * dx,
            y1: edge.y1 + t1 * dy,
        })
    }
    return out
}

function getPolygonAABB(points: { x: number; y: number }[]): ProjectedBounds | null {
    if (points.length === 0) return null
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const p of points) {
        if (p.x < minX) minX = p.x
        if (p.x > maxX) maxX = p.x
        if (p.y < minY) minY = p.y
        if (p.y > maxY) maxY = p.y
    }
    if (maxX - minX < 1e-3 || maxY - minY < 1e-3) return null
    return { minX, maxX, minY, maxY }
}

function occludeEdgesByPolygons(
    edges: ProjectedEdge[],
    occluderPolygons: ProjectedPolygon[]
): ProjectedEdge[] {
    if (edges.length === 0 || occluderPolygons.length === 0) return edges
    const rects: ProjectedBounds[] = []
    for (const poly of occluderPolygons) {
        const aabb = getPolygonAABB(poly.points)
        if (aabb) rects.push(aabb)
    }
    if (rects.length === 0) return edges
    let working = edges
    for (const rect of rects) {
        const next: ProjectedEdge[] = []
        for (const edge of working) {
            for (const seg of subtractRectFromEdge(edge, rect)) {
                next.push(seg)
            }
        }
        working = next
    }
    return working
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
    /** Door frame origin projected into the current view (x, y). Used in fixed-scale
     * mode to anchor the door to the canvas centre so front/back/plan agree on its
     * horizontal (and elevation-vertical) position. */
    doorAnchor?: { x: number; y: number }
}

/**
 * Pick the drawing scale + offsets for a view.
 *
 * Elevations: scale is fit-to-HEIGHT per door so the slab-to-slab clip band
 * (10 cm upper slab + floor + 10 cm lower slab) always fills the available
 * picture height exactly. Content top sits at `topPad` (narrow breathing
 * strip) and content bottom lands on the title-block separator. The door
 * frame origin is anchored to the canvas horizontal centre so front/back/
 * plan all agree on the door's X.
 *
 * Plan: fit-to-bounds centred, either inheriting the front's scale via
 * `sharedDrawingScale` (legacy plumbing — ignored when a doorAnchor is
 * provided) or computing its own natural fit. Door X still anchors to canvas
 * centre.
 */
function computeViewTransform(
    fitBounds: ProjectedBounds,
    options: Required<SVGRenderOptions>,
    context: DoorContext | null,
    sharedDrawingScale: number | undefined,
    viewType: 'Front' | 'Back' | 'Plan' | '',
    doorAnchor: { x: number; y: number } | undefined
): {
    scale: number
    offsetX: number
    offsetY: number
    viewHeight: number
} {
    const metrics = getSvgViewportMetrics(options, context, viewType)
    const { viewHeight, sidePad, topPad, availWidth, availHeight } = metrics
    const contentWidth = fitBounds.maxX - fitBounds.minX
    const contentHeight = fitBounds.maxY - fitBounds.minY

    if (viewType === 'Plan') {
        // Plan: natural fit-to-bounds (min of width/height ratios), centred.
        const naturalScale = Math.min(
            availWidth / (contentWidth || 1),
            availHeight / (contentHeight || 1)
        )
        const scale = sharedDrawingScale ?? naturalScale
        const scaledWidth = contentWidth * scale
        const scaledHeight = contentHeight * scale
        const offsetX = doorAnchor
            ? options.width / 2 - (doorAnchor.x - fitBounds.minX) * scale
            : sidePad + (availWidth - scaledWidth) / 2
        const offsetY = topPad + (availHeight - scaledHeight) / 2
        return { scale, offsetX, offsetY, viewHeight }
    }

    // Elevations: FIXED scale (same px/m for every door), content BOTTOM
    // anchored to the title-block separator, door horizontally centred. Scale
    // picked so 4 m slab-to-slab content fits availHeight exactly; shorter
    // storeys show the real IFC geometry only — nothing fake added above.
    const scale = FIXED_PX_PER_METER
    const offsetX = doorAnchor
        ? options.width / 2 - (doorAnchor.x - fitBounds.minX) * scale
        : sidePad + (availWidth - contentWidth * scale) / 2
    const offsetY = topPad + availHeight - contentHeight * scale
    return { scale, offsetX, offsetY, viewHeight }
}

function resolveSvgViewTransform(
    fitBounds: ProjectedBounds,
    options: Required<SVGRenderOptions>,
    context: DoorContext | null,
    sharedDrawingScale?: number,
    viewType: 'Front' | 'Back' | 'Plan' | '' = '',
    doorAnchor?: { x: number; y: number }
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
    return computeViewTransform(fitBounds, options, context, sharedDrawingScale, viewType, doorAnchor)
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

    // "Closing line" artifact: when an edge crossed the lateral crop and got
    // clipped down to a vertical segment lying ON the crop boundary, that
    // segment is a clip artifact (not real wall geometry) and shouldn't draw
    // as a vertical line at the corridor edge.
    //
    // CRITICAL: a perpendicular-wall edge that natively lives at exactly
    // minX/maxX (e.g. the back face of a wall whose end aligns with the
    // corridor) must NOT be dropped — that edge IS real geometry, and dropping
    // it produces "missing wall" reports. We distinguish artifact from real
    // geometry by tracking whether clipping moved the edge's endpoints.
    const BOUNDARY_EPS = 0.001
    const isOnLateralBoundary = (e: ProjectedEdge): boolean => {
        if (Math.abs(e.x1 - e.x2) > BOUNDARY_EPS) return false
        const onMinX =
            Math.abs(e.x1 - bounds.minX) < BOUNDARY_EPS
            && Math.abs(e.x2 - bounds.minX) < BOUNDARY_EPS
        const onMaxX =
            Math.abs(e.x1 - bounds.maxX) < BOUNDARY_EPS
            && Math.abs(e.x2 - bounds.maxX) < BOUNDARY_EPS
        return onMinX || onMaxX
    }

    const edges: ProjectedEdge[] = []
    for (const edge of geometry.edges) {
        const clipResult = clipEdgeToBoundsResult(edge, bounds)
        if (!clipResult) continue
        // Drop only if the edge lies on the lateral boundary AND clipping
        // moved it there (artifact from cropping content that originally
        // extended past the crop). Native vertical edges at the boundary
        // — perpendicular wall back faces, frame returns aligned to the
        // corridor end — pass through.
        if (clipResult.clippedLaterally && isOnLateralBoundary(clipResult.edge)) continue
        edges.push({ ...clipResult.edge, skipClip: true })
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
    // Recenter the horizontal viewport slice on the door anchor. `getViewportClipBounds`
    // centers the 4 m canvas window on the raw fit midpoint, but nearby geometry
    // (long walls, distant slabs) can push that midpoint far from the door, leaving
    // the door outside the canvas after the lateral intersect below. Anchoring the
    // viewport on the door guarantees the door stays inside the rendered window.
    const doorAnchorProjected = projectPoint(frame.origin, camera, width, height)
    const canvasWidthMeters = options.width / FIXED_PX_PER_METER
    bounds.minX = doorAnchorProjected.x - canvasWidthMeters / 2
    bounds.maxX = doorAnchorProjected.x + canvasWidthMeters / 2
    // Section-crop policy: 10 cm into the STRUCTURAL slab below (top face
    // minus 10 cm) at bottom, 10 cm into the STRUCTURAL slab above (underside
    // plus 10 cm) at top. `getStructuralSlabFaceDy` skips
    // IFCBUILDINGELEMENTPART (floor build-up / Unterlagsboden) so the
    // reference is the real concrete slab, not the finish layer. Falls back
    // to a 10 cm reveal below the door threshold when no structural slab is
    // detected for this door's storey.
    const structAboveDy = getStructuralSlabFaceDy(context, 'above')
    const structBelowDy = getStructuralSlabFaceDy(context, 'below')
    const bottomDy = structBelowDy != null
        ? structBelowDy - STRUCTURAL_SLAB_INTRUSION_METERS
        : -frame.height / 2 - STRUCTURAL_SLAB_INTRUSION_METERS
    // Total content capped at 3.5 m above the bottom reference so edge storeys
    // (1 UG basement, 4 OG roof deck) with no slab above — or a slab further
    // than 3.5 m — still produce a consistent canvas fill.
    const STOREY_CONTENT_HEIGHT_METERS = 3.5
    const topCapDy = bottomDy + STOREY_CONTENT_HEIGHT_METERS
    let topDy = structAboveDy != null
        ? Math.min(structAboveDy + STRUCTURAL_SLAB_INTRUSION_METERS, topCapDy)
        : topCapDy

    const topPoint = frame.origin.clone().add(frame.upAxis.clone().multiplyScalar(topDy))
    const bottomPoint = frame.origin.clone().add(frame.upAxis.clone().multiplyScalar(bottomDy))
    const projectedTop = projectPoint(topPoint, camera, width, height)
    const projectedBottom = projectPoint(bottomPoint, camera, width, height)
    // Clamp the elevation clip to the door's own storey band. Without this,
    // slabs/walls from adjacent storeys expand the fit bounds and leak into
    // the view as horizontal strips spanning the full width. Reset the
    // vertical extent to exactly [storey top, storey bottom] so mesh and
    // semantic geometry from neighbouring storeys gets clipped away.
    bounds.minY = Math.min(projectedTop.y, projectedBottom.y)
    bounds.maxY = Math.max(projectedTop.y, projectedBottom.y)

    // Lateral clamp shared with plan corridor — `getSharedLateralExtentLocal`
    // returns the host wall's mesh-cut widthAxis extent at cutY, exactly
    // what plan visibly renders. Both views clip to that so a perpendicular
    // T-junction stub past the host wall's end (the "bottom-left context"
    // case) gets cropped from both. Fall back to door-anchored lateralGap
    // when no mesh section is available, capped at lateralGap so very long
    // partitions still bound the elevation.
    const halfDoorWidth = frame.width / 2
    const lateralGap = THREE.MathUtils.clamp(frame.width * 0.5, 0.5, 1.5)
    const sharedExtent = getSharedLateralExtentLocal(context)
    let localMinW: number
    let localMaxW: number
    if (sharedExtent) {
        localMinW = Math.min(Math.max(sharedExtent.minLocal, -halfDoorWidth - lateralGap), -halfDoorWidth)
        localMaxW = Math.max(Math.min(sharedExtent.maxLocal, halfDoorWidth + lateralGap), halfDoorWidth)
    } else {
        localMinW = -halfDoorWidth - lateralGap
        localMaxW = halfDoorWidth + lateralGap
    }
    const leftPoint = frame.origin.clone().add(frame.widthAxis.clone().multiplyScalar(localMinW))
    const rightPoint = frame.origin.clone().add(frame.widthAxis.clone().multiplyScalar(localMaxW))
    const projectedLeft = projectPoint(leftPoint, camera, width, height)
    const projectedRight = projectPoint(rightPoint, camera, width, height)
    const lateralMin = Math.min(projectedLeft.x, projectedRight.x)
    const lateralMax = Math.max(projectedLeft.x, projectedRight.x)
    bounds.minX = Math.max(bounds.minX, lateralMin)
    bounds.maxX = Math.min(bounds.maxX, lateralMax)
    if (bounds.minX >= bounds.maxX) {
        bounds.minX = lateralMin
        bounds.maxX = lateralMax
    }
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

    // Prefer the IfcBuildingStorey's own Elevation attribute — that's the "0.00"
    // level for the storey, which is what the marker should point at. Slab tops
    // sit above this (e.g. +0.17 for a 17 cm buildup) so using the slab shifts
    // the tick up by the buildup thickness.
    if (typeof context.storeyElevation === 'number' && Number.isFinite(context.storeyElevation)) {
        return context.storeyElevation - originB
    }

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
    const offset = getStoreyMarkerLevelOffsetMeters(context)
    const markerPoint = context.viewFrame.origin.clone().add(
        context.viewFrame.upAxis.clone().multiplyScalar(offset)
    )
    const projected = projectPoint(markerPoint, camera, width, height)
    if (process.env.DEBUG_MARKER === '1') {
        const originB = context.viewFrame.origin.dot(context.viewFrame.upAxis)
        console.log(`[marker] door=${context.doorId} storey=${context.storeyName} storeyElevation=${context.storeyElevation} originB=${originB.toFixed(3)} offset=${offset.toFixed(3)} markerWorld.y=${markerPoint.y.toFixed(2)}`)
    }
    return projected.y
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
    sidePad: number
    topPad: number
    bottomPad: number
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
    const sidePad = ELEVATION_SIDE_PAD_PX
    const topPad = ELEVATION_TOP_PAD_PX
    const bottomPad = ELEVATION_BOTTOM_PAD_PX
    // `padding` kept for legacy call sites (unused after refactor but preserved
    // to avoid signature churn).
    const padding = Math.max(sidePad, topPad, bottomPad)
    const availWidth = options.width - sidePad * 2
    const availHeight = viewHeight - topPad - bottomPad
    return { titleBlockHeight, viewHeight, padding, sidePad, topPad, bottomPad, availWidth, availHeight }
}

function createElevationOrthographicCamera(
    frame: DoorViewFrame,
    margin: number,
    isBackView: boolean,
    verticalExtensions: { top?: number; bottom?: number } = {}
): { camera: THREE.OrthographicCamera; frustumWidth: number; frustumHeight: number } {
    const frustumWidth = frame.width + margin * 2
    const topExt = Math.max(verticalExtensions.top ?? 0, margin)
    const botExt = Math.max(verticalExtensions.bottom ?? 0, margin)
    const frustumHeight = frame.height + topExt + botExt
    // Asymmetric frustum so the door stays centered on its own mid-point even
    // when we extend further up (upper slab) than down (lower slab) or vice
    // versa — avoids the renderer mis-centring the door vertically.
    const camera = new THREE.OrthographicCamera(
        -frustumWidth / 2,
        frustumWidth / 2,
        frame.height / 2 + topExt,
        -(frame.height / 2 + botExt),
        0.1,
        100
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
    const structAboveDy = getStructuralSlabFaceDy(context, 'above')
    const structBelowDy = getStructuralSlabFaceDy(context, 'below')
    const bottomDy = structBelowDy != null
        ? structBelowDy - STRUCTURAL_SLAB_INTRUSION_METERS
        : -frame.height / 2 - STRUCTURAL_SLAB_INTRUSION_METERS
    const topCapDy = bottomDy + 3.5
    const topDy = structAboveDy != null
        ? Math.min(structAboveDy + STRUCTURAL_SLAB_INTRUSION_METERS, topCapDy)
        : topCapDy
    const topExt = Math.max(topDy - frame.height / 2, 0)
    const botExt = Math.max(-bottomDy - frame.height / 2, 0)
    const { camera, frustumWidth, frustumHeight } = createElevationOrthographicCamera(
        frame,
        margin,
        false,
        { top: topExt, bottom: botExt }
    )
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

function computeFrontElevationScale(_context: DoorContext, _opts: Required<SVGRenderOptions>): number | undefined {
    // The front elevation always renders at FIXED_PX_PER_METER (see
    // `computeViewTransform` for non-Plan views). Plan must match so the door
    // sits at exactly the same canvas size — otherwise stacking plan above
    // elevation left-aligned shows the door drifting (especially in -1 UG
    // where the storey-clip content height makes natural-fit ≠ FIXED).
    return FIXED_PX_PER_METER
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

    const rawViewType = String(renderMeta.viewType ?? '')
    const currentViewType: 'Front' | 'Back' | 'Plan' | '' = rawViewType === ''
        ? ''
        : rawViewType.toLowerCase() === 'plan'
            ? 'Plan'
            : rawViewType.toLowerCase() === 'back'
                ? 'Back'
                : rawViewType.toLowerCase() === 'front'
                    ? 'Front'
                    : (renderMeta.viewType as 'Front' | 'Back' | 'Plan' | '')
    const isPlanView = currentViewType === 'Plan'
    const hasDevices = hasVisibleDevicesForView(renderMeta.context, currentViewType)
    const hasWall = renderMeta.context ? Boolean(renderMeta.context.hostWall || renderMeta.context.wall) : false
    const hasSlabs = hasVisibleSlabsForView(renderMeta.context, currentViewType)
    const showLegendActual = showLegend && (hasDevices || hasWall || hasSlabs)

    const { titleBlockHeight, viewHeight } = getSvgViewportMetrics(
        options,
        renderMeta.context,
        currentViewType
    )

    const fitBounds =
        getBoundsFromProjectedGeometry(fitGeometry?.edges ?? edges, fitGeometry?.polygons ?? polygons)
        ?? getBoundsFromProjectedGeometry(edges, polygons)

    // In elevation, layer < 0 draws contextual fills behind the door; those layers must
    // skip fitBounds clipping so host backdrops can extend. In plan, nearby door/window
    // rects use the same negative layer for depth only — skipping clip leaves them in
    // projected metres while the transform is anchored to the tight door+arc fit, which
    // blows up final SVG coordinates. Plan: clip unless explicitly skipClip (e.g. walls
    // already clipped to the viewport in projected space).
    const bypassFitBoundsClip = (layer: number, skipClip?: boolean): boolean => {
        if (skipClip) return true
        if (isPlanView) return false
        return layer < 0
    }

    const renderEdges = fitBounds
        ? edges
            .map((edge) => bypassFitBoundsClip(edge.layer, edge.skipClip) ? edge : clipEdgeToBounds(edge, fitBounds))
            .filter((edge): edge is ProjectedEdge => edge !== null)
        : edges
    const renderPolygons = fitBounds
        ? polygons
            .map((polygon) => {
                if (bypassFitBoundsClip(polygon.layer, polygon.skipClip)) return polygon
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

    const { scale, offsetX, offsetY } = computeViewTransform(
        { minX, maxX, minY, maxY },
        options,
        renderMeta.context,
        renderMeta.sharedDrawingScale,
        currentViewType,
        renderMeta.doorAnchor
    )

    const scaledWidth = contentWidth * scale
    const scaledHeight = contentHeight * scale

    // Transform function
    const transformX = (x: number) => (x - minX) * scale + offsetX
    const transformY = (y: number) => (y - minY) * scale + offsetY

    // Draw lower-priority layers first, then depth-sort within a layer.
    renderPolygons.sort((a, b) => a.layer - b.layer || b.depth - a.depth)

    renderEdges.sort((a, b) => a.layer - b.layer || b.depth - a.depth)

    const planDoorOffsetX = isPlanView && renderMeta.planDoorBounds
        ? transformX(renderMeta.planDoorBounds.minX)
        : offsetX
    const planDoorOffsetY = isPlanView && renderMeta.planDoorBounds
        ? transformY(renderMeta.planDoorBounds.minY)
        : offsetY
    const planDoorScaledWidth = isPlanView && renderMeta.planDoorBounds
        ? (renderMeta.planDoorBounds.maxX - renderMeta.planDoorBounds.minX) * scale
        : scaledWidth
    const planDoorScaledHeight = isPlanView && renderMeta.planDoorBounds
        ? (renderMeta.planDoorBounds.maxY - renderMeta.planDoorBounds.minY) * scale
        : scaledHeight
    const planWallBandY = isPlanView && renderMeta.planWallBandBounds
        ? transformY(renderMeta.planWallBandBounds.minY)
        : undefined
    const planWallBandHeight = isPlanView && renderMeta.planWallBandBounds
        ? (renderMeta.planWallBandBounds.maxY - renderMeta.planWallBandBounds.minY) * scale
        : (renderMeta.context?.viewFrame ? Math.max(renderMeta.context.viewFrame.thickness * scale, 12) : undefined)

    // Synthetic wall reveal rectangles removed — elevation/plan now show only
    // IFC-derived mesh/semantic wall geometry so the drawing matches the model.
    const wallBandsSvg = ''

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

    const storeyMarkerLabel = getStoreyMarkerLabel(renderMeta.context, currentViewType)
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
        svg += renderTitleBlock(width, height, titleBlockHeight, options, renderMeta.context, currentViewType)
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
            const legendHostCfc = context?.hostWall ? context.wallBKP?.get(context.hostWall.expressID) ?? null : null
            const legendWallColor = viewType === 'Plan'
                ? resolveWallCutColor(legendHostCfc) ?? options.wallColor
                : resolveWallElevationColor(legendHostCfc) ?? options.wallColor
            items.push({ color: legendWallColor, text: 'Wand' })
        }
        if (hasSlabs && (!hasWall || options.floorSlabColor !== options.wallColor)) {
            items.push({ color: options.floorSlabColor, text: 'Decke' })
        }

        if (hasDevices) {
            const visibleDevices = context?.nearbyDevices ?? []
            const isSafe = (d: { expressID: number; name?: string | null }) =>
                isSafetyDevice(d.name ?? null, context?.deviceLayers?.get(d.expressID) ?? null)
            const hasElectrical = visibleDevices.some((d) => !isSafe(d))
            const hasSafety = visibleDevices.some((d) => isSafe(d))
            if (hasElectrical) items.push({ color: options.deviceColor, text: 'Elektro' })
            if (hasSafety) items.push({ color: options.safetyColor, text: 'Sicherheit' })
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
    // Elevation door-leaf colour depends on the door's BKP / material class
    // (CFC 2720 → anthrazit, 2730 → hellbraun, unknown → hellgrau). Caller
    // overrides via `options.doorColor` still win.
    const bkpDoorColor = resolveElevationDoorColor(context.csetStandardCH?.cfcBkpCccBcc)
    const opts = normalizeRenderOptions({ doorColor: bkpDoorColor, ...options })
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
 * Identify which door sub-meshes are the operable leaf(s). Heuristic:
 * measure each mesh's elevation-plane footprint (width-axis × up-axis area).
 * The mesh with the largest footprint is a leaf, and so is any other mesh
 * whose area is within 20 % of it (handles double-door cases). Everything
 * else — frame, transom, header, glazing above the leaf — is returned
 * elsewhere and recoloured as wall.
 */
function pickDoorLeafMeshes(
    doorMeshes: readonly THREE.Mesh[],
    frame: DoorViewFrame
): Set<THREE.Mesh> {
    const widthAxis = frame.widthAxis
    const upAxis = frame.upAxis
    type Entry = { mesh: THREE.Mesh; area: number }
    const entries: Entry[] = []
    for (const mesh of doorMeshes) {
        const geometry = mesh.geometry as THREE.BufferGeometry | undefined
        if (!geometry) continue
        if (!geometry.boundingBox) geometry.computeBoundingBox()
        const local = geometry.boundingBox
        if (!local) continue
        mesh.updateMatrixWorld()
        let minW = Infinity, maxW = -Infinity, minU = Infinity, maxU = -Infinity
        for (const corner of box3Corners(local)) {
            corner.applyMatrix4(mesh.matrixWorld)
            const w = corner.dot(widthAxis)
            const u = corner.dot(upAxis)
            if (w < minW) minW = w
            if (w > maxW) maxW = w
            if (u < minU) minU = u
            if (u > maxU) maxU = u
        }
        const area = Math.max(0, maxW - minW) * Math.max(0, maxU - minU)
        if (area > 0) entries.push({ mesh, area })
    }
    if (entries.length === 0) return new Set()
    entries.sort((a, b) => b.area - a.area)
    const topArea = entries[0].area
    const leafThreshold = topArea * 0.8
    const leaves = new Set<THREE.Mesh>()
    for (const entry of entries) {
        if (entry.area >= leafThreshold) leaves.add(entry.mesh)
        else break
    }
    return leaves
}

/**
 * Collect projected door geometry: edges for every sub-mesh (unchanged, keeps
 * the full silhouette), but fills for non-leaf meshes are recoloured with
 * `options.wallColor` so that the frame / transom / header read as
 * continuous wall around the operable leaf in elevation.
 */
function collectDoorMeshGeometry(
    doorMeshes: readonly THREE.Mesh[],
    leafMeshes: ReadonlySet<THREE.Mesh>,
    context: DoorContext,
    options: Required<SVGRenderOptions>,
    camera: THREE.OrthographicCamera,
    width: number,
    height: number
): { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] } {
    const edges: ProjectedEdge[] = []
    const polygons: ProjectedPolygon[] = []

    // Fills: every door sub-mesh (frame, leaf, glazing…) projects its real
    // footprint so the door reads as a continuous shape in the door-colour.
    // Frame / header / jamb sub-meshes paint anthrazit (metal frame) when
    // the door is metal or has no BKP, since real-world frames around glass
    // / steel doors are metal. Wood-BKP doors get a wood frame too — typical
    // residential / interior construction is wood-on-wood, not wood leaf in
    // a metal frame. Glazing keeps glass colour. Leaf keeps the BKP-resolved
    // doorColor.
    // Edges: web-ifc splits the door into several sub-meshes and each one
    // contributes its own silhouette rectangle, which layered on top of each
    // other looked like multiple schematic frame outlines. Instead, draw ONE
    // outer silhouette (union of all door meshes, via a frame-axis-aligned
    // rect from the real projected footprint) + the leaf silhouette inside.
    const doorBKPCategory = classifyDoorBKP(context.csetStandardCH?.cfcBkpCccBcc)
    const frameColor = doorBKPCategory === 'wood'
        ? COLORS.elevation.door.byBKP.wood
        : COLORS.elevation.door.byBKP.metal
    for (const mesh of doorMeshes) {
        const expressID = mesh.userData.expressID
        const style = getMeshPolygonStyle(mesh, expressID, context, options, true)
        const isGlazing = isLikelyGlazingPanelMesh(mesh)
        const isLeaf = leafMeshes.has(mesh)
        let color = style.color
        const fillOpacity = style.fillOpacity ?? 1
        if (!isGlazing && !isLeaf && expressID === context.door.expressID) {
            color = frameColor
        }
        const posCount = mesh.geometry?.attributes?.position?.count || 0
        if (posCount === 0) continue
        if (options.showFills) {
            polygons.push(...extractPolygons(mesh, camera, color, width, height, 0, 'none', fillOpacity))
        }
        // Leaf AND glazing edges are drawn in detail so each glass panel
        // (side-light, transom, vision light) reads with its own frame, not
        // just as a blue fill. Everything else (frame, header, jambs) is
        // rolled into the single outer silhouette below.
        const drawEdges = leafMeshes.has(mesh) || isLikelyGlazingPanelMesh(mesh)
        if (drawEdges) {
            const edgeColor = debugColorFor(expressID) ?? options.lineColor
            edges.push(...extractEdges(mesh, camera, edgeColor, width, height, false, 0, DOOR_EDGE_STROKE_FACTOR))
        }
    }

    const frame = context.viewFrame
    const outerBounds = measureMeshesInAxes(
        doorMeshes as THREE.Mesh[],
        frame.widthAxis,
        frame.upAxis,
        frame.semanticFacing
    )
    if (outerBounds
        && Number.isFinite(outerBounds.minA) && Number.isFinite(outerBounds.maxA)
        && Number.isFinite(outerBounds.minB) && Number.isFinite(outerBounds.maxB)
        && outerBounds.maxA > outerBounds.minA
        && outerBounds.maxB > outerBounds.minB
    ) {
        const originA = frame.origin.dot(frame.widthAxis)
        const originB = frame.origin.dot(frame.upAxis)
        const corners = createRectPoints3D(
            frame.origin,
            frame.widthAxis,
            frame.upAxis,
            outerBounds.minA - originA,
            outerBounds.maxA - originA,
            outerBounds.minB - originB,
            outerBounds.maxB - originB
        )
        const outerEdgeColor = debugColorFor(context.door.expressID) ?? options.lineColor
        const outerGeom = { edges, polygons }
        appendProjectedEdge(outerGeom, corners[0], corners[1], camera, width, height, outerEdgeColor, 0, DOOR_EDGE_STROKE_FACTOR)
        appendProjectedEdge(outerGeom, corners[1], corners[2], camera, width, height, outerEdgeColor, 0, DOOR_EDGE_STROKE_FACTOR)
        appendProjectedEdge(outerGeom, corners[2], corners[3], camera, width, height, outerEdgeColor, 0, DOOR_EDGE_STROKE_FACTOR)
        appendProjectedEdge(outerGeom, corners[3], corners[0], camera, width, height, outerEdgeColor, 0, DOOR_EDGE_STROKE_FACTOR)
    }

    return { edges, polygons }
}

/**
 * Project every vertex of `meshes` onto `axis` and return the depth range.
 * Returns `null` if no vertex data was available.
 */
function projectMeshesOntoAxis(
    meshes: readonly THREE.Mesh[],
    axis: THREE.Vector3
): { min: number; max: number } | null {
    let min = Infinity
    let max = -Infinity
    const point = new THREE.Vector3()
    for (const mesh of meshes) {
        const geometry = mesh.geometry as THREE.BufferGeometry | undefined
        const positions = geometry?.getAttribute?.('position')
        if (!geometry || !positions || positions.count === 0) continue
        mesh.updateMatrixWorld(true)
        for (let i = 0; i < positions.count; i++) {
            point
                .set(positions.getX(i), positions.getY(i), positions.getZ(i))
                .applyMatrix4(mesh.matrixWorld)
            const d = point.dot(axis)
            if (d < min) min = d
            if (d > max) max = d
        }
    }
    return Number.isFinite(min) ? { min, max } : null
}

/** World-space corners of a bounding box. */
function box3Corners(bb: THREE.Box3): THREE.Vector3[] {
    return [
        new THREE.Vector3(bb.min.x, bb.min.y, bb.min.z),
        new THREE.Vector3(bb.max.x, bb.min.y, bb.min.z),
        new THREE.Vector3(bb.min.x, bb.max.y, bb.min.z),
        new THREE.Vector3(bb.max.x, bb.max.y, bb.min.z),
        new THREE.Vector3(bb.min.x, bb.min.y, bb.max.z),
        new THREE.Vector3(bb.max.x, bb.min.y, bb.max.z),
        new THREE.Vector3(bb.min.x, bb.max.y, bb.max.z),
        new THREE.Vector3(bb.max.x, bb.max.y, bb.max.z),
    ]
}

/**
 * Compute the host wall's plane: a unit normal vector and its half-thickness
 * along that normal. Derived by clustering the area-weighted face normals of
 * every triangle in the host-wall mesh — a far more reliable basis for
 * occlusion reasoning than `semanticFacing`, which is door-semantic and can
 * project the wall's length (not its thickness) onto the facing axis.
 *
 * The returned `normal` is signed so that `normal · semanticFacing > 0` when
 * possible. When the mesh is degenerate or the wall has no dominant flat
 * pair of faces, returns `null`.
 */
function computeHostWallPlane(
    hostWallMeshes: readonly THREE.Mesh[],
    semanticFacing: THREE.Vector3
): { normal: THREE.Vector3; halfThickness: number } | null {
    const buckets: Array<{ normal: THREE.Vector3; area: number }> = []
    const p1 = new THREE.Vector3()
    const p2 = new THREE.Vector3()
    const p3 = new THREE.Vector3()
    const ab = new THREE.Vector3()
    const ac = new THREE.Vector3()
    const cross = new THREE.Vector3()

    for (const mesh of hostWallMeshes) {
        const geometry = mesh.geometry as THREE.BufferGeometry | undefined
        const positions = geometry?.getAttribute?.('position')
        if (!geometry || !positions) continue
        mesh.updateMatrixWorld(true)
        const matrix = mesh.matrixWorld
        const index = geometry.getIndex()
        const triangleCount = index ? index.count / 3 : positions.count / 3

        for (let t = 0; t < triangleCount; t++) {
            const i0 = index ? index.getX(t * 3) : t * 3
            const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1
            const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2
            p1.set(positions.getX(i0), positions.getY(i0), positions.getZ(i0)).applyMatrix4(matrix)
            p2.set(positions.getX(i1), positions.getY(i1), positions.getZ(i1)).applyMatrix4(matrix)
            p3.set(positions.getX(i2), positions.getY(i2), positions.getZ(i2)).applyMatrix4(matrix)
            ab.subVectors(p2, p1)
            ac.subVectors(p3, p1)
            cross.crossVectors(ab, ac)
            const area2 = cross.length()
            if (area2 < 1e-8) continue
            const area = area2 / 2
            cross.divideScalar(area2)
            // Fold antiparallel normals together so front and back faces of
            // the wall reinforce each other instead of cancelling out.
            if (cross.x < 0 || (cross.x === 0 && cross.y < 0) || (cross.x === 0 && cross.y === 0 && cross.z < 0)) {
                cross.multiplyScalar(-1)
            }
            // Merge with an existing bucket if almost aligned (< 5°).
            let merged = false
            for (const bucket of buckets) {
                if (bucket.normal.dot(cross) > 0.9962) {
                    const total = bucket.area + area
                    bucket.normal.multiplyScalar(bucket.area)
                    bucket.normal.addScaledVector(cross, area)
                    bucket.normal.multiplyScalar(1 / total)
                    bucket.normal.normalize()
                    bucket.area = total
                    merged = true
                    break
                }
            }
            if (!merged) buckets.push({ normal: cross.clone(), area })
        }
    }

    if (buckets.length === 0) return null
    buckets.sort((a, b) => b.area - a.area)
    const dominant = buckets[0].normal.clone().normalize()
    // Sign so the normal roughly agrees with semanticFacing (keeps "front"
    // intuition when the analyzer's semantic face direction is reasonable).
    if (dominant.dot(semanticFacing) < 0) dominant.multiplyScalar(-1)

    // Project every host-wall vertex onto the normal to determine thickness.
    const depths = projectMeshesOntoAxis(hostWallMeshes, dominant)
    const halfThickness = depths ? (depths.max - depths.min) / 2 : 0

    return { normal: dominant, halfThickness }
}

/**
 * Return a shallow-cloned DoorContext with every "nearby" element / mesh
 * list filtered to exclude items on the far side of the host wall from the
 * camera. Uses a plane through `viewFrame.origin` with the true host-wall
 * normal so perpendicular walls, adjacent doors in the same wall, and
 * elements that genuinely sit in front of the wall are preserved correctly.
 * Elements straddling the plane (coplanar walls, sibling doors in the host
 * wall) are ALWAYS kept — visible from either side. Plan view is untouched.
 */
function filterContextForElevationOcclusion(
    context: DoorContext,
    isBackView: boolean
): DoorContext {
    const hostWallMeshes = getHostWallMeshes(context)
    if (hostWallMeshes.length === 0) return context

    // Plane normal comes from the host wall's own mesh only — aggregate parts
    // (cladding layers at different offsets) would pollute the thickness
    // measurement. Fall back to the full list if the primary mesh is missing.
    const primaryHostMeshes: readonly THREE.Mesh[] =
        context.hostWall?.meshes?.length
            ? context.hostWall.meshes
            : context.hostWall?.mesh
                ? [context.hostWall.mesh]
                : hostWallMeshes
    const plane = computeHostWallPlane(primaryHostMeshes, context.viewFrame.semanticFacing)
    if (!plane) return context

    let normal = plane.normal
    let halfThickness = plane.halfThickness
    // If the host wall's dominant face is not roughly aligned with the door's
    // facing direction, the "host wall" is almost certainly misclassified —
    // e.g. for a storefront / curtain-wall door the nearest wall we picked is
    // actually perpendicular to the door. Using its widthAxis-aligned normal
    // to split occlusion would drop the sibling panels that really sit in the
    // same assembly (and that stay visible on the same side). Fall back to
    // the door's semanticFacing so the occlusion split follows the door's
    // real front/back rooms.
    if (Math.abs(normal.dot(context.viewFrame.semanticFacing)) < 0.5) {
        normal = context.viewFrame.semanticFacing.clone().normalize()
        // Use the door's own thickness as the straddle-band half-width; we
        // can't trust the misclassified wall's projection along a different
        // axis here.
        halfThickness = Math.max(context.viewFrame.thickness / 2, 0.02)
    }
    const planeD = context.viewFrame.origin.dot(normal)
    // Keep everything within ± (plane half-thickness + 2 cm) of the plane on
    // the "straddles" band — that's where the wall itself, its aggregate
    // parts, and sibling doors embedded in the same wall live. 2 cm padding
    // handles mesh-tessellation jitter.
    const tol = Math.max(halfThickness, 0.01) + 0.02

    const DEBUG = typeof process !== 'undefined' && process.env?.DEBUG_HALFSPACE === '1'
    if (DEBUG) {
        console.log(
            `  [halfspace] view=${isBackView ? 'back' : 'front'} normal=(${normal.x.toFixed(3)},${normal.y.toFixed(3)},${normal.z.toFixed(3)}) planeD=${planeD.toFixed(3)} halfThickness=${plane.halfThickness.toFixed(3)} tol=${tol.toFixed(3)} dotSemantic=${normal.dot(context.viewFrame.semanticFacing).toFixed(3)}`
        )
    }

    /**
     * Classify a bbox against the wall plane.
     *  -1 / +1 = mostly on that side, drop on the opposite view.
     *   0     = truly straddling (wall aggregate, door sub-mesh) — keep both.
     *
     * We use the bbox CENTER as the dominant side: an element that attaches to
     * the host wall and extends 2 m into one room (e.g. a Promat beam above
     * the door) is architecturally on that side, not straddling. The bbox
     * would touch the plane at its attachment face, which previously forced
     * "straddles" and showed the element on both elevations. Keep the
     * straddle band tight so only geometry that genuinely lives inside the
     * wall (aggregate parts / door frame) falls through as 0.
     */
    const classifyBbox = (bbox: THREE.Box3 | null | undefined): number | null => {
        if (!bbox) return null
        let sideMin = Infinity
        let sideMax = -Infinity
        for (const corner of box3Corners(bbox)) {
            const s = corner.dot(normal) - planeD
            if (s < sideMin) sideMin = s
            if (s > sideMax) sideMax = s
        }
        if (!Number.isFinite(sideMin)) return null
        const center = (sideMin + sideMax) / 2
        if (center > +tol) return +1
        if (center < -tol) return -1
        return 0
    }

    // Front view (Vorderansicht) has the camera on the +normal side, so it
    // drops the -normal side. Back view drops the +normal side. Straddlers
    // (0) are always kept.
    const frontKeepsNormalSide = !isBackView
    const sideToDrop = frontKeepsNormalSide ? -1 : 1

    const isOccludedBbox = (bbox: THREE.Box3 | null | undefined): boolean => {
        const cls = classifyBbox(bbox)
        return cls === sideToDrop
    }

    const isOccludedMesh = (mesh: THREE.Mesh): boolean => {
        const geometry = mesh.geometry as THREE.BufferGeometry | undefined
        if (!geometry) return false
        if (!geometry.boundingBox) geometry.computeBoundingBox()
        const local = geometry.boundingBox
        if (!local) return false
        mesh.updateMatrixWorld(true)
        return isOccludedBbox(local.clone().applyMatrix4(mesh.matrixWorld))
    }

    const isOccludedElement = (el: { boundingBox?: THREE.Box3 | null }): boolean =>
        isOccludedBbox(el.boundingBox ?? null)

    const filterElements = <T extends { boundingBox?: THREE.Box3 | null; expressID?: number; typeName?: string }>(
        arr: T[],
        label: string
    ): T[] => {
        const kept: T[] = []
        for (const el of arr) {
            const cls = classifyBbox(el.boundingBox ?? null)
            const drop = cls === sideToDrop
            if (DEBUG && el.boundingBox) {
                let mn = Infinity, mx = -Infinity
                for (const c of box3Corners(el.boundingBox)) {
                    const s = c.dot(normal) - planeD
                    if (s < mn) mn = s
                    if (s > mx) mx = s
                }
                const side = cls === -1 ? '-1' : cls === 1 ? '+1' : ' 0'
                console.log(`    ${label} eid=${el.expressID} type=${el.typeName} side=${side} range=[${mn.toFixed(3)},${mx.toFixed(3)}]${drop ? '  -> DROP' : ''}`)
            }
            if (!drop) kept.push(el)
        }
        return kept
    }

    const hostWallExpressID = context.hostWall?.expressID
    const filteredLinks = context.wallAggregatePartLinks.filter((link) => {
        // Host wall aggregate parts are part of the host wall drawing — keep them.
        if (hostWallExpressID !== undefined && link.parentWallExpressID === hostWallExpressID) return true
        return !isOccludedElement(link.part)
    })
    const allowedPartIds = new Set(filteredLinks.map((l) => l.part.expressID))

    // Walls need band-intersection classification instead of center-based:
    // a perpendicular cut-wall at the door jamb has its bbox CENTRE deep into
    // one room but its bbox STRADDLES the host wall plane (min near -tol, max
    // far on one side). Dropping by center hides the cut face from the view
    // "behind" it. By testing whether the bbox touches the straddle band, we
    // keep genuine cut walls on both views while still dropping parallel
    // walls that live fully behind/in front of the host wall plane (the
    // 00u5qp… tan-rect case).
    // Band-intersection drop: a cut wall/door at the door jamb has its bbox
    // CENTRE deep into one room but its bbox STRADDLES the host wall plane
    // (min near -tol, max far on one side). Dropping by centre hides the cut
    // face from the view "behind" it. Testing whether the bbox touches the
    // straddle band keeps genuine cut elements on both views while still
    // dropping parallel elements that live fully behind/in front of the host
    // wall plane.
    const isElementOccluded = (bbox: THREE.Box3 | null | undefined): boolean => {
        if (!bbox) return false
        let sideMin = Infinity
        let sideMax = -Infinity
        for (const corner of box3Corners(bbox)) {
            const s = corner.dot(normal) - planeD
            if (s < sideMin) sideMin = s
            if (s > sideMax) sideMax = s
        }
        if (!Number.isFinite(sideMin)) return false
        // Strict straddle: the bbox must span CLEARLY past both sides of the
        // band, not merely touch one edge. The previous loose check (any
        // overlap with the band) kept doors fully in the back room whose
        // near-face barely poked into the band — they appeared as adjacent
        // doors in elevation even though they're "behind" the cut plane.
        const trulyStraddles = sideMin < -tol && sideMax > +tol
        if (trulyStraddles) return false
        const center = (sideMin + sideMax) / 2
        const side = center > +tol ? +1 : center < -tol ? -1 : 0
        return side === sideToDrop
    }
    const filteredWalls = context.nearbyWalls.filter((w) => !isElementOccluded(w.boundingBox ?? null))
    // Adjacent doors need band-intersection too: a cut-door embedded in the
    // host wall has a thin glazing sub-mesh entirely on one side of the
    // plane. With centre-based per-mesh filtering the glazing gets dropped
    // from the opposite view and the door reads as solid wall-colour on one
    // side and glass-colour on the other (0OLNP8lGUkIgzNri… case).
    // BUT: an "adjacent door" must actually be NEAR the host wall plane.
    // Doors deep in the room (e.g. 0TwHxk1LH at depth 1.6 m off plane)
    // pass the half-space test (camera side) but architecturally belong to
    // a different wall — projecting their meshes from inside the room
    // creates a "ghost" door overlay (3wtKbl_FJ case). Require the bbox
    // centre to be within ~door-thickness of the host plane.
    const NEARBY_DOOR_DEPTH_TOLERANCE = Math.max(context.viewFrame.thickness, 0.08) + 0.10
    const isFarFromWallPlane = (bbox: THREE.Box3 | null | undefined): boolean => {
        if (!bbox) return false
        let mn = Infinity, mx = -Infinity
        for (const corner of box3Corners(bbox)) {
            const s = corner.dot(normal) - planeD
            if (s < mn) mn = s
            if (s > mx) mx = s
        }
        if (!Number.isFinite(mn)) return false
        const center = (mn + mx) / 2
        return Math.abs(center) > NEARBY_DOOR_DEPTH_TOLERANCE
    }
    const filteredNearbyDoors = context.nearbyDoors.filter((d) => {
        if (isElementOccluded(d.boundingBox ?? null)) return false
        if (isFarFromWallPlane(d.boundingBox ?? null)) return false
        return true
    })
    // Devices straddling the host wall plane (mounted in/at the door jamb)
    // belong on both views — surface socket on one side, J-box flush in the
    // wall, etc. Centre-based filter drops them from one view; band-
    // intersection keeps them on both ('fehlende elektro-elemente' fix).
    const filteredNearbyDevices = context.nearbyDevices.filter((d) => !isElementOccluded(d.boundingBox ?? null))

    const filteredContext: DoorContext = {
        ...context,
        nearbyDoors: filteredNearbyDoors,
        nearbyWindows: context.nearbyWindows ? filterElements(context.nearbyWindows, 'nearbyWindow') : context.nearbyWindows,
        nearbyWalls: filteredWalls,
        nearbyStairs: filterElements(context.nearbyStairs, 'nearbyStair'),
        nearbyDevices: filteredNearbyDevices,
        wallAggregatePartLinks: filteredLinks,
    }

    if (context.detailedGeometry) {
        const filterMeshes = (meshes: THREE.Mesh[]): THREE.Mesh[] =>
            meshes.filter((m) => !isOccludedMesh(m))
        filteredContext.detailedGeometry = {
            ...context.detailedGeometry,
            // Drop nearby-wall meshes whose parent wall was filtered out by
            // the band-intersection test above, so we don't render phantom
            // parallel walls living behind/in front of the host wall plane.
            nearbyWallMeshes: (() => {
                const keptIds = new Set(filteredWalls.map((w) => w.expressID))
                return context.detailedGeometry.nearbyWallMeshes.filter((m) => {
                    const id = m.userData?.expressID
                    return typeof id === 'number' && keptIds.has(id)
                })
            })(),
            // Keep ALL sub-meshes of kept adjacent doors — a thin glazing
            // panel's own bbox can classify as -1/+1 even when the parent
            // door straddles, and dropping it leaves the door with no glass
            // colour on one of the two views.
            nearbyDoorMeshes: (() => {
                const keptIds = new Set(filteredNearbyDoors.map((d) => d.expressID))
                return context.detailedGeometry.nearbyDoorMeshes.filter((m) => {
                    const id = m.userData?.expressID
                    return typeof id === 'number' && keptIds.has(id)
                })
            })(),
            nearbyWindowMeshes: filterMeshes(context.detailedGeometry.nearbyWindowMeshes),
            stairMeshes: filterMeshes(context.detailedGeometry.stairMeshes),
            deviceMeshes: filterMeshes(context.detailedGeometry.deviceMeshes),
            wallAggregatePartMeshes: context.detailedGeometry.wallAggregatePartMeshes.filter((m) => {
                const partId = m.userData?.expressID
                // Keep parts the link-filter already accepted; this also preserves host
                // wall aggregate parts because they stay in `filteredLinks`.
                return typeof partId === 'number' && allowedPartIds.has(partId)
            }),
        }
    }

    return filteredContext
}

/**
 * Render elevation SVG from detailed mesh geometry
 */
function renderElevationFromMeshes(
    rawContext: DoorContext,
    isBackView: boolean,
    opts: Required<SVGRenderOptions>
): string {
    // Hide everything strictly behind the host wall along the camera axis so
    // elevations match the 3D model (no phantom edges, no walls "through" the
    // host wall). Plan view uses `rawContext` via its own entry point.
    const context = filterContextForElevationOcclusion(rawContext, isBackView)
    const doorMeshes = getDoorMeshes(context)
    if (doorMeshes.length === 0) {
        throw new Error('No meshes available for rendering')
    }

    const frame = context.viewFrame
    const margin = Math.max(opts.margin, 0.25)
    // Camera frustum must enclose the same content window as the clip bounds:
    // 10 cm into the structural slab below (top face minus 10 cm) and 10 cm
    // into the structural slab above (underside plus 10 cm), capped at 3.5 m.
    const structAboveDyForCamera = getStructuralSlabFaceDy(context, 'above')
    const structBelowDyForCamera = getStructuralSlabFaceDy(context, 'below')
    const bottomDyForCamera = structBelowDyForCamera != null
        ? structBelowDyForCamera - STRUCTURAL_SLAB_INTRUSION_METERS
        : -frame.height / 2 - STRUCTURAL_SLAB_INTRUSION_METERS
    const topCapDyForCamera = bottomDyForCamera + 3.5
    const topDyForCamera = structAboveDyForCamera != null
        ? Math.min(structAboveDyForCamera + STRUCTURAL_SLAB_INTRUSION_METERS, topCapDyForCamera)
        : topCapDyForCamera
    const topExtFromSlab = Math.max(topDyForCamera - frame.height / 2, 0)
    const botExtFromSlab = Math.max(-bottomDyForCamera - frame.height / 2, 0)
    const { camera, frustumWidth, frustumHeight } = createElevationOrthographicCamera(
        frame,
        margin,
        isBackView,
        { top: topExtFromSlab, bottom: botExtFromSlab }
    )

    // Classify door sub-meshes as "leaf" vs "frame / transom / header" by their
    // elevation-plane footprint. In reality, looking at the door head-on, the
    // operable leaf is a rectangular slab with the largest uninterrupted area;
    // the frame + transom around it visually merge with the wall. We recolour
    // every non-leaf door sub-mesh with wallColor so the elevation reads as
    // continuous wall around the leaf (matching what the architect sees in 3D).
    const leafMeshes = pickDoorLeafMeshes(doorMeshes, frame)
    const renderGeometry = collectDoorMeshGeometry(
        doorMeshes,
        leafMeshes,
        context,
        opts,
        camera,
        frustumWidth,
        frustumHeight
    )
    const nearbyDoorGeometry = createSemanticElevationNearbyDoorGeometry(
        context,
        camera,
        frustumWidth,
        frustumHeight,
        opts
    )
    const nearbyWindowGeometry = createSemanticElevationNearbyWindowGeometry(
        context,
        camera,
        frustumWidth,
        frustumHeight
    )
    const nearbyWallGeometry = createSemanticElevationNearbyWallGeometry(
        context,
        camera,
        frustumWidth,
        frustumHeight,
        opts
    )
    const slabGeometryRaw = createSemanticElevationSlabGeometry(context, camera, frustumWidth, frustumHeight, opts)
    const ceilingGeometryRaw = createSemanticElevationCeilingGeometry(context, camera, frustumWidth, frustumHeight, opts, isBackView)
    const stairGeometryRaw = createSemanticElevationStairGeometry(context, camera, frustumWidth, frustumHeight, opts)
    const fitGeometry = boundsToFitGeometry(
        projectElevationDoorBounds(frame, camera, frustumWidth, frustumHeight)
    )
    fitGeometry.edges.push(
        ...nearbyDoorGeometry.edges,
        ...nearbyWindowGeometry.edges,
        ...nearbyWallGeometry.edges,
        ...slabGeometryRaw.edges,
        ...ceilingGeometryRaw.edges,
        ...stairGeometryRaw.edges
    )
    fitGeometry.polygons.push(
        ...nearbyDoorGeometry.polygons,
        ...nearbyWindowGeometry.polygons,
        ...nearbyWallGeometry.polygons,
        ...slabGeometryRaw.polygons,
        ...ceilingGeometryRaw.polygons,
        ...stairGeometryRaw.polygons
    )
    const elevationViewType: 'Front' | 'Back' = isBackView ? 'Back' : 'Front'
    const elevationHostClipBounds = getElevationHostClipBounds(context, fitGeometry, opts, camera, frustumWidth, frustumHeight, elevationViewType)
    const scaleFitGeometry = elevationHostClipBounds ? boundsToFitGeometry(elevationHostClipBounds) : fitGeometry
    const scaleFitBounds = getBoundsFromProjectedGeometry(scaleFitGeometry.edges, scaleFitGeometry.polygons)
    const sharedDrawingScale = scaleFitBounds
        ? resolveSvgViewTransform(scaleFitBounds, opts, context, undefined, elevationViewType).scale
        : undefined
    // TEMP DIAGNOSTIC — DEBUG_EDGE_COLORS=1 recolours edges by source so we
    // can see which pipeline stage contributed each stroke. Polygon fills are
    // left untouched. Remove once the elevation is clean.
    const DEBUG = typeof process !== 'undefined' && process.env?.DEBUG_EDGE_COLORS === '1'
    const tagEdges = <T extends { edges: ProjectedEdge[]; polygons: ProjectedPolygon[] }>(
        g: T,
        color: string
    ): T => {
        if (!DEBUG) return g
        return { ...g, edges: g.edges.map((e) => ({ ...e, color })) }
    }

    if (context.hostWall || context.wall) {
        const hostWallCfcForBackdrop = context.hostWall
            ? context.wallBKP?.get(context.hostWall.expressID) ?? null
            : null
        const backdropWallGeometry = tagEdges(createProjectedElevationWallBackdropGeometry(
            frame,
            camera,
            frustumWidth,
            frustumHeight,
            elevationHostClipBounds,
            opts,
            getElevationWallFootprintLocalA(context),
            resolveWallElevationColor(hostWallCfcForBackdrop)
        ), '#a855f7') // purple = host wall backdrop
        renderGeometry.edges.push(...backdropWallGeometry.edges)
        renderGeometry.polygons.push(...backdropWallGeometry.polygons)
    }
    // Host-wall mesh projection: keep fills AND edges. Edges go through
    // `extractEdges`' 30° sharp-edge filter, which drops the coplanar seams
    // web-ifc's door-opening boolean cut produces at the jamb x-coordinates.
    // Keeping silhouette edges is what makes a T-junction perpendicular wall
    // visible in elevation (its end-face rectangle). Includes coplanar
    // nearby walls so storefront layouts render as one continuous wall.
    const wallMeshes = getHostAndCoplanarWallMeshes(context)
    const wallProjected = wallMeshes.length > 0
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
        : { edges: [] as ProjectedEdge[], polygons: [] as ProjectedPolygon[] }
    // Compute foreground geometries first so we can occlude wall mesh edges
    // by them. The user's mental model: cut at the door plane, show what's
    // at the cut + within view depth, hide things further behind. So lines
    // from the host wall that fall inside the projected footprint of a
    // foreground polygon (slab/ceiling/perpendicular wall) are hidden — the
    // foreground element "covers" the wall there. Devices/safety symbols are
    // pushed AFTER (and remain on top) since they're the only background
    // elements the user explicitly wants visible through walls.
    const clippedNearbyWallGeometry = tagEdges(clipProjectedGeometryToBounds(
        nearbyWallGeometry,
        elevationHostClipBounds
    ), '#3b82f6') // blue = nearby walls
    const slabGeometryClipped = clipProjectedGeometryToBounds(slabGeometryRaw, elevationHostClipBounds)
    const ceilingGeometryClipped = clipProjectedGeometryToBounds(ceilingGeometryRaw, elevationHostClipBounds)
    const wallEdgeOccluders: ProjectedPolygon[] = [
        ...slabGeometryClipped.polygons,
        ...ceilingGeometryClipped.polygons,
        ...clippedNearbyWallGeometry.polygons,
        // Door + storefront polygons occlude wall mesh edges within the door
        // opening. Without this, boolean-cut seams from the IFC's door hole
        // (mesh edge at door head, jamb returns) project as horizontal /
        // vertical "ghost lines" over the door area (03X27dQWY storefront
        // case — horizontal red line spanning the canvas at door-head height).
        ...renderGeometry.polygons,
    ]
    // Force host-wall fills to full opacity — elevation shows solid geometry,
    // not a translucent ghosting of the mesh.
    const wallGeometry = tagEdges(
        {
            edges: occludeEdgesByPolygons(wallProjected.edges, wallEdgeOccluders),
            polygons: wallProjected.polygons.map((p) => ({ ...p, fillOpacity: 1 })),
        },
        '#ef4444'
    )
    // Ceiling-only occlusion: ceiling edges that pass BEHIND the host wall
    // (or the nearby perpendicular wall meshes) must not "ghost" through the
    // wall fill (1mRZBdiTM, 03X27dQWY case — pink horizontal ceiling lines
    // showing across the wall above the door head). SLAB edges are NOT
    // occluded — the slab top line at floor level is the architectural floor
    // reference and must stay visible as a continuous horizontal across the
    // entire view, even where the wall fill is in front of it (Unterlagsboden
    // visibility requirement).
    const ceilingEdgeOccluders: ProjectedPolygon[] = [
        ...wallProjected.polygons,
        ...clippedNearbyWallGeometry.polygons,
    ]
    const slabGeometry = tagEdges(slabGeometryClipped, '#eab308') // yellow = slab
    // Side-filtered host-ceiling edges are the actual cut lines we want to see
    // on the elevation. Host-wall polygons overlap those lines by definition,
    // so using them as occluders removes the legitimate IfcCovering section.
    const ceilingEdgesAfterOcclusion = ceilingGeometryClipped.edges
    const ceilingGeometry = tagEdges({
        edges: ceilingEdgesAfterOcclusion,
        polygons: ceilingGeometryClipped.polygons,
    }, '#ec4899') // pink = ceiling
    // Semantic wall geometry (synthetic opening outlines / lintel lines) removed —
    // user wants only real 3D mesh silhouettes in elevation, no artificial lines.
    renderGeometry.edges.push(...wallGeometry.edges)
    renderGeometry.polygons.push(...wallGeometry.polygons)
    renderGeometry.edges.push(...clippedNearbyWallGeometry.edges)
    renderGeometry.polygons.push(...clippedNearbyWallGeometry.polygons)
    renderGeometry.edges.push(...slabGeometry.edges)
    renderGeometry.polygons.push(...slabGeometry.polygons)
    renderGeometry.edges.push(...ceilingGeometry.edges)
    renderGeometry.polygons.push(...ceilingGeometry.polygons)
    const stairGeometry = tagEdges(clipProjectedGeometryToBounds(stairGeometryRaw, elevationHostClipBounds), '#6366f1') // indigo = stair
    renderGeometry.edges.push(...stairGeometry.edges)
    renderGeometry.polygons.push(...stairGeometry.polygons)
    const clippedNearbyDoorGeometry = tagEdges(clipProjectedGeometryToBounds(
        nearbyDoorGeometry,
        elevationHostClipBounds
    ), '#22c55e') // green = nearby doors
    renderGeometry.edges.push(...clippedNearbyDoorGeometry.edges)
    renderGeometry.polygons.push(...clippedNearbyDoorGeometry.polygons)
    const clippedNearbyWindowGeometry = tagEdges(clipProjectedGeometryToBounds(
        nearbyWindowGeometry,
        elevationHostClipBounds
    ), '#14b8a6') // teal = nearby windows
    renderGeometry.edges.push(...clippedNearbyWindowGeometry.edges)
    renderGeometry.polygons.push(...clippedNearbyWindowGeometry.polygons)
    const deviceGeometry = clipProjectedGeometryToBounds(
        createSemanticElevationDeviceGeometry(
            context,
            camera,
            frustumWidth,
            frustumHeight,
            opts,
            isBackView
        ),
        elevationHostClipBounds
    )
    renderGeometry.edges.push(...deviceGeometry.edges)
    renderGeometry.polygons.push(...deviceGeometry.polygons)

    const doorAnchorProjected = projectPoint(frame.origin, camera, frustumWidth, frustumHeight)
    const doorAnchor = { x: doorAnchorProjected.x, y: doorAnchorProjected.y }

    return generateSVGString(
        renderGeometry.edges,
        renderGeometry.polygons,
        opts,
        elevationHostClipBounds ? boundsToFitGeometry(elevationHostClipBounds) : fitGeometry,
        {
            context,
            viewType: isBackView ? 'Back' : 'Front',
            planArcFlip: false,
            // Synthetic wall bands are fully disabled now; keep the flag true for clarity.
            suppressSyntheticWallBands: true,
            storeyMarkerProjectedY: projectStoreyMarkerLevelY(context, camera, frustumWidth, frustumHeight),
            ...(sharedDrawingScale !== undefined ? { sharedDrawingScale } : {}),
            doorAnchor,
        }
    )
}

function renderFallbackContextWindowSvg(
    x: number,
    y: number,
    width: number,
    height: number,
    lineWidth: number
): string {
    return `
  <rect x="${x}" y="${y}" width="${width}" height="${height}"
        fill="${CONTEXT_DOOR_FILL_COLOR}" fill-opacity="${CONTEXT_DOOR_FILL_OPACITY}"
        stroke="${CONTEXT_DOOR_LINE_COLOR}" stroke-width="${lineWidth * CONTEXT_DOOR_EDGE_STROKE_FACTOR}"/>`
}

/**
 * Last-resort SVG for a nearby door in the bounding-box-only fallback path.
 * Used only when no mesh geometry was loaded for the door. BKP-coloured fill;
 * no fake inset frame (that was synthetic proxy geometry — we show the real
 * silhouette everywhere we have one).
 */
function renderFallbackContextDoorSvg(
    x: number,
    y: number,
    width: number,
    height: number,
    lineWidth: number,
    fillColor: string = CONTEXT_DOOR_FILL_COLOR,
    strokeColor: string = CONTEXT_DOOR_LINE_COLOR
): string {
    return `
  <rect x="${x}" y="${y}" width="${width}" height="${height}"
        fill="${fillColor}" fill-opacity="1"
        stroke="${strokeColor}" stroke-width="${lineWidth * DOOR_EDGE_STROKE_FACTOR}"/>`
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
    const nearbyWindowRects = getNearbyWindowAxisRects(context)
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
    // Synthetic wall reveal removed — bbox fallback used to draw rectangles
    // flanking the door to hint at a surrounding wall, but those invented
    // rectangles do not correspond to any IFC mesh. Doors without detailed
    // geometry now render as their bounding box only, which is honest.
    const wallRevealSvg = ''

    const nearbyDoorsSvg = nearbyDoorRects
        .map((rect) => {
            const rectX = contentOffsetX + (rect.minA - contentMinA) * scale
            const rectY = contentOffsetY + (contentMaxB - rect.maxB) * scale
            const rectWidth = (rect.maxA - rect.minA) * scale
            const rectHeight = (rect.maxB - rect.minB) * scale
            if (rectX + rectWidth < padding || rectX > svgWidth - padding || rectY + rectHeight < padding || rectY > padding + availableHeight) {
                return ''
            }
            const bkpFill = resolveElevationDoorColor(context.nearbyDoorBKP.get(rect.expressID ?? -1))
            return renderFallbackContextDoorSvg(
                rectX,
                rectY,
                rectWidth,
                rectHeight,
                lineWidth,
                bkpFill,
                lineColor
            )
        })
        .filter(Boolean)
        .join('\n')

    const nearbyWindowsSvg = nearbyWindowRects
        .map((rect) => {
            const rectX = contentOffsetX + (rect.minA - contentMinA) * scale
            const rectY = contentOffsetY + (contentMaxB - rect.maxB) * scale
            const rectWidth = (rect.maxA - rect.minA) * scale
            const rectHeight = (rect.maxB - rect.minB) * scale
            if (rectX + rectWidth < padding || rectX > svgWidth - padding || rectY + rectHeight < padding || rectY > padding + availableHeight) {
                return ''
            }
            return renderFallbackContextWindowSvg(rectX, rectY, rectWidth, rectHeight, lineWidth)
        })
        .filter(Boolean)
        .join('\n')

    const fontDefs = svgWebFontDefs(opts.fontFamily)
    let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">
${fontDefs}  <rect width="100%" height="100%" fill="${backgroundColor}"/>
${wallRevealSvg}
${nearbyDoorsSvg}
${nearbyWindowsSvg}
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
    // Plan door leaf follows the same BKP classification as elevation, so a
    // metal door reads anthrazit in all three views (spec says "fully
    // consistent colours"). Caller overrides via options.doorColor still win.
    const bkpDoorColor = resolveElevationDoorColor(context.csetStandardCH?.cfcBkpCccBcc)
    const merged = normalizeRenderOptions({ doorColor: bkpDoorColor, ...options })
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
    swingRadius: number
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
    // IFC hingeSide LEFT/RIGHT is defined relative to IFC's local +X axis, which is
    // derived from placementYAxis (local +Y) and world +Z (local +Z is always up for
    // a vertical door). Using the right-hand rule, IFC local +X = placementYAxis × up.
    // The renderer's widthAxis = up × semanticFacing. Expanding the dot product via the
    // vector identity (a×b)·(c×d) = (a·c)(b·d) - (a·d)(b·c) gives
    //   ifcLocalX · widthAxis = -placementYAxis · semanticFacing
    // so the two axes point in OPPOSITE directions exactly when
    // `placementYAxis · semanticFacing > 0`. In that case the resolved
    // `hingeOffsetFromCenter` (which is computed in widthAxis units) has the wrong
    // sign and must be mirrored to honour IFC handedness.
    return placementYAxis.dot(context.viewFrame.semanticFacing) > 0
}

function mirrorResolvedSwingLeaves(leaves: ResolvedSwingLeaf[]): ResolvedSwingLeaf[] {
    return leaves.map((leaf) => ({
        width: leaf.width,
        swingRadius: leaf.swingRadius,
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
    const upperOperation = context.openingDirection?.toUpperCase() || ''
    if (upperOperation.includes('REVERSE') || upperOperation.includes('OPPOSITE')) {
        return true
    }

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

function detectLeafCenterFromMeshes(
    context: DoorContext,
    frame: DoorViewFrame,
    expectedLeafWidth: number
): { centerOffset: number; width: number } | null {
    const meshes = context.detailedGeometry?.doorMeshes
    if (!meshes || meshes.length === 0) return null
    if (!Number.isFinite(expectedLeafWidth) || expectedLeafWidth <= 0.05) return null

    const widthAxis = frame.widthAxis.clone().normalize()
    const origin = frame.origin
    const halfFrame = frame.width / 2 + 0.05

    type Candidate = { centerOffset: number; width: number; score: number }
    const candidates: Candidate[] = []

    for (const mesh of meshes) {
        mesh.updateMatrixWorld()
        const geo = (mesh as any).geometry as THREE.BufferGeometry | undefined
        if (!geo) continue
        geo.computeBoundingBox()
        const bbox = geo.boundingBox
        if (!bbox) continue

        let minAxis = Infinity
        let maxAxis = -Infinity
        const corners = [
            new THREE.Vector3(bbox.min.x, bbox.min.y, bbox.min.z),
            new THREE.Vector3(bbox.max.x, bbox.min.y, bbox.min.z),
            new THREE.Vector3(bbox.min.x, bbox.max.y, bbox.min.z),
            new THREE.Vector3(bbox.max.x, bbox.max.y, bbox.min.z),
            new THREE.Vector3(bbox.min.x, bbox.min.y, bbox.max.z),
            new THREE.Vector3(bbox.max.x, bbox.min.y, bbox.max.z),
            new THREE.Vector3(bbox.min.x, bbox.max.y, bbox.max.z),
            new THREE.Vector3(bbox.max.x, bbox.max.y, bbox.max.z),
        ]
        for (const corner of corners) {
            corner.applyMatrix4(mesh.matrixWorld)
            const offset = corner.clone().sub(origin).dot(widthAxis)
            if (offset < minAxis) minAxis = offset
            if (offset > maxAxis) maxAxis = offset
        }
        if (!Number.isFinite(minAxis) || !Number.isFinite(maxAxis)) continue
        const width = maxAxis - minAxis
        const centerOffset = (minAxis + maxAxis) / 2
        if (width <= 0.1 || width > halfFrame * 2) continue
        if (Math.abs(centerOffset) > halfFrame) continue

        const widthDelta = Math.abs(width - expectedLeafWidth)
        if (widthDelta > expectedLeafWidth * 0.35) continue
        candidates.push({ centerOffset, width, score: widthDelta })
    }

    if (candidates.length === 0) return null
    candidates.sort((a, b) => a.score - b.score)

    const grouped: { centerOffset: number; width: number; count: number }[] = []
    for (const c of candidates) {
        const match = grouped.find(
            (g) => Math.abs(g.centerOffset - c.centerOffset) < 0.1 && Math.abs(g.width - c.width) < 0.1
        )
        if (match) {
            match.count += 1
        } else {
            grouped.push({ centerOffset: c.centerOffset, width: c.width, count: 1 })
        }
    }
    grouped.sort((a, b) => b.count - a.count)
    const best = grouped[0]
    return { centerOffset: best.centerOffset, width: best.width }
}

function resolveSwingLeavesForWidth(context: DoorContext, totalWidth: number, frame?: DoorViewFrame): ResolvedSwingLeaf[] {
    const params = parseOperationType(context.openingDirection)
    if (params.type !== 'swing' || !params.hingeSide || totalWidth <= 0) {
        return []
    }

    const operableLeaves = context.operableLeaves
    if (operableLeaves?.leaves.length) {
        const scale = operableLeaves.totalWidth > 1e-6 ? totalWidth / operableLeaves.totalWidth : 1
        let leaves = operableLeaves.leaves
            .map((leaf) => ({
                width: leaf.width * scale,
                swingRadius: leaf.width * scale,
                hingeSide: leaf.hingeSide,
                hingeOffsetFromCenter: leaf.hingeOffsetFromCenter * scale,
            }))
            .filter((leaf) => Number.isFinite(leaf.width) && leaf.width > 0.01)

        // If the door has a fixed panel (clearWidth < totalWidth) and we have a single-leaf
        // result, the IFC cset-clear-width metadata cannot reveal which side the fixed panel
        // is on and defaults to a centered opening. In that case, detect the leaf position
        // directly from the door mesh geometry (which is already in the renderer's widthAxis
        // frame, so the IFC→renderer handedness mirror is NOT applied to the detected offset).
        const usingScaledFrame = operableLeaves.totalWidth > 1e-6
            && Math.abs(operableLeaves.totalWidth - totalWidth) < 0.2
        const clearWidth = operableLeaves.clearWidth
        const hasSignificantFixedPanel = clearWidth !== null
            && Number.isFinite(clearWidth)
            && clearWidth > 0.3
            && clearWidth < operableLeaves.totalWidth - 0.1
        if (
            frame
            && usingScaledFrame
            && hasSignificantFixedPanel
            && leaves.length === 1
            && operableLeaves.source === 'cset-clear-width'
        ) {
            const detected = detectLeafCenterFromMeshes(context, frame, clearWidth as number)
            if (detected) {
                const originalLeaf = operableLeaves.leaves[0]
                const scaleFactor = operableLeaves.totalWidth > 1e-6 ? totalWidth / operableLeaves.totalWidth : 1
                const leafWidth = detected.width * scaleFactor
                const detectedCenter = detected.centerOffset * scaleFactor
                const mirror = shouldMirrorSwingForHandedness(context)
                const effectiveHingeSide: 'left' | 'right' = mirror
                    ? (originalLeaf.hingeSide === 'left' ? 'right' : 'left')
                    : originalLeaf.hingeSide
                const hingeOffsetFromCenter = effectiveHingeSide === 'left'
                    ? detectedCenter - leafWidth / 2
                    : detectedCenter + leafWidth / 2
                return [{
                    width: leafWidth,
                    swingRadius: leafWidth,
                    hingeSide: effectiveHingeSide,
                    hingeOffsetFromCenter,
                }]
            }
        }

        if (leaves.length > 0) {
            return shouldMirrorSwingForHandedness(context) ? mirrorResolvedSwingLeaves(leaves) : leaves
        }
    }

    if (params.hingeSide === 'both') {
        return [
            { width: totalWidth / 2, swingRadius: totalWidth / 2, hingeSide: 'left', hingeOffsetFromCenter: -totalWidth / 2 },
            { width: totalWidth / 2, swingRadius: totalWidth / 2, hingeSide: 'right', hingeOffsetFromCenter: totalWidth / 2 },
        ]
    }

    const leaves = [
        {
            width: totalWidth,
            swingRadius: totalWidth,
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
        swingRadius: leaf.swingRadius,
        hingeSide: leaf.hingeSide === 'left' ? 'right' : 'left',
        hingeOffsetFromCenter: -leaf.hingeOffsetFromCenter,
    }))
}

function getPlanSwingReach(context: DoorContext, frame: DoorViewFrame): number {
    const leaves = resolveSwingLeavesForWidth(context, frame.width, frame)
    if (leaves.length === 0) return frame.thickness / 2
    const faceOffset = frame.thickness / 2
    return faceOffset + Math.max(...leaves.map((leaf) => leaf.swingRadius * Math.sin(PLAN_SWING_OPEN_RAD)))
}

/**
 * Generate arc edges for a single door leaf
 */
function generateSingleLeafArc(
    hinge3D: THREE.Vector3,
    swingRadius: number,
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
        const point = pivot3D.clone().add(dir.multiplyScalar(swingRadius))
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
        isDashed: false,
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
        resolveSwingLeavesForWidth(context, frame.width, frame),
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
                leaf.swingRadius,
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
        const radius = leaf.swingRadius
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
    const cutHeight = frame.origin.y - frame.height / 2 + PLAN_CUT_HEIGHT_METERS
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
    const planCropM = Math.max(opts.planCropMarginMeters, 0)

    const projectPlanRect = (depthMin: number, depthMax: number, widthHalfLocal: number): ProjectedBounds => {
        const corners = [
            frame.origin.clone().add(frame.widthAxis.clone().multiplyScalar(-widthHalfLocal)).add(frame.semanticFacing.clone().multiplyScalar(depthMin)),
            frame.origin.clone().add(frame.widthAxis.clone().multiplyScalar(widthHalfLocal)).add(frame.semanticFacing.clone().multiplyScalar(depthMin)),
            frame.origin.clone().add(frame.widthAxis.clone().multiplyScalar(widthHalfLocal)).add(frame.semanticFacing.clone().multiplyScalar(depthMax)),
            frame.origin.clone().add(frame.widthAxis.clone().multiplyScalar(-widthHalfLocal)).add(frame.semanticFacing.clone().multiplyScalar(depthMax)),
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

    const arcParams = context.openingDirection ? parseOperationType(context.openingDirection) : null
    const hasSwingArc = showPlanSwing && arcParams?.type === 'swing' && !!arcParams.hingeSide
    const openAxisFit = flipArc ? frame.semanticFacing.clone().negate() : frame.semanticFacing.clone()
    const arcReach = hasSwingArc ? getPlanSwingReach(context, frame) : frame.thickness / 2

    const fitPoint = (p: THREE.Vector3): ProjectedEdge => {
        const proj = projectPoint(p, camera, frustumWidth, frustumHeight)
        return { x1: proj.x, y1: proj.y, x2: proj.x, y2: proj.y, color: 'none', depth: 0, layer: 0 }
    }

    const fitW = halfW + planCropM
    const fitD = halfT + planCropM
    const fitGeometry = {
        edges: [
            fitPoint(frame.origin.clone().add(frame.widthAxis.clone().multiplyScalar(-fitW)).add(frame.semanticFacing.clone().multiplyScalar(-fitD))),
            fitPoint(frame.origin.clone().add(frame.widthAxis.clone().multiplyScalar(fitW)).add(frame.semanticFacing.clone().multiplyScalar(-fitD))),
            fitPoint(frame.origin.clone().add(frame.widthAxis.clone().multiplyScalar(fitW)).add(frame.semanticFacing.clone().multiplyScalar(fitD))),
            fitPoint(frame.origin.clone().add(frame.widthAxis.clone().multiplyScalar(-fitW)).add(frame.semanticFacing.clone().multiplyScalar(fitD))),
            fitPoint(frame.origin.clone().sub(frame.widthAxis.clone().multiplyScalar(fitW)).add(openAxisFit.clone().multiplyScalar(arcReach))),
            fitPoint(frame.origin.clone().add(frame.widthAxis.clone().multiplyScalar(fitW)).add(openAxisFit.clone().multiplyScalar(arcReach))),
        ],
        polygons: [],
    }

    let planViewportClip = getViewportClipBounds(fitGeometry, opts, context, sharedDrawingScale, 'Plan')
    // Tighten the viewport clip to the SAME shared lateral extent used by
    // the wall-section corridor + elevation clip, so nearby doors / windows
    // / devices outside the host wall's visible cut are dropped.
    if (planViewportClip) {
        const sharedExtent = getSharedLateralExtentLocal(context)
        const planLateralGap = THREE.MathUtils.clamp(frame.width * 0.5, 0.5, 1.5)
        const planHalfDoor = frame.width / 2
        let planLatMin: number
        let planLatMax: number
        if (sharedExtent) {
            planLatMin = Math.min(Math.max(sharedExtent.minLocal, -planHalfDoor - planLateralGap), -planHalfDoor)
            planLatMax = Math.max(Math.min(sharedExtent.maxLocal, planHalfDoor + planLateralGap), planHalfDoor)
        } else {
            planLatMin = -planHalfDoor - planLateralGap
            planLatMax = planHalfDoor + planLateralGap
        }
        const widthAxisN = frame.widthAxis.clone().normalize()
        const leftPt = frame.origin.clone().add(widthAxisN.clone().multiplyScalar(planLatMin))
        const rightPt = frame.origin.clone().add(widthAxisN.clone().multiplyScalar(planLatMax))
        const leftProj = projectPoint(leftPt, camera, frustumWidth, frustumHeight).x
        const rightProj = projectPoint(rightPt, camera, frustumWidth, frustumHeight).x
        // Depth-axis (perpendicular to wall) clip: same idea as lateral —
        // anything outside the wall thickness band (+ swing arc on the open
        // side) is in another room and shouldn't appear. 1zXqD3S6hGHA3…
        // case: an adjacent door body sat below the wall band in plan and
        // bled into open space because plan only clipped horizontally.
        const depthBackPad = halfT + planCropM
        const depthFrontPad = hasSwingArc
            ? Math.max(arcReach, halfT + planCropM)
            : halfT + planCropM
        const facing = frame.semanticFacing.clone().normalize()
        const opening = openAxisFit.clone().normalize()
        const backPt = frame.origin.clone().add(facing.clone().multiplyScalar(-depthBackPad))
        const frontPt = frame.origin.clone().add(opening.clone().multiplyScalar(depthFrontPad))
        const backProj = projectPoint(backPt, camera, frustumWidth, frustumHeight).y
        const frontProj = projectPoint(frontPt, camera, frustumWidth, frustumHeight).y
        planViewportClip = {
            minX: Math.max(planViewportClip.minX, Math.min(leftProj, rightProj)),
            maxX: Math.min(planViewportClip.maxX, Math.max(leftProj, rightProj)),
            minY: Math.max(planViewportClip.minY, Math.min(backProj, frontProj)),
            maxY: Math.min(planViewportClip.maxY, Math.max(backProj, frontProj)),
        }
    }

    // Plan door rendering: same frame-vs-leaf split as elevation so the
    // frame paints its BKP colour (anthrazit for metal/default, hellbraun
    // for wood) and the leaf paints its BKP colour. Wood door = wood leaf +
    // wood frame; metal/glass door = anthrazit frame around the glass leaf.
    const planLeafMeshes = new Set(pickDoorLeafMeshes(doorMeshes, frame))
    const planDoorBKP = classifyDoorBKP(context.csetStandardCH?.cfcBkpCccBcc)
    const planFrameColor = planDoorBKP === 'wood'
        ? COLORS.elevation.door.byBKP.wood
        : COLORS.elevation.door.byBKP.metal
    const renderGeometry = { edges: [] as ProjectedEdge[], polygons: [] as ProjectedPolygon[] }
    for (const mesh of doorMeshes) {
        const expressID = mesh.userData.expressID
        const style = getMeshPolygonStyle(mesh, expressID, context, opts, false)
        let color = style.color
        const fillOpacity = style.fillOpacity ?? 1
        if (
            expressID === context.door.expressID
            && !planLeafMeshes.has(mesh)
            && !isLikelyGlazingPanelMesh(mesh)
        ) {
            color = planFrameColor
        }
        const posCount = mesh.geometry?.attributes?.position?.count || 0
        if (posCount === 0) continue
        if (opts.showFills) {
            renderGeometry.polygons.push(
                ...extractPolygons(mesh, camera, color, frustumWidth, frustumHeight, 0, 'camera-facing', fillOpacity)
            )
        }
        renderGeometry.edges.push(
            ...extractEdges(mesh, camera, opts.lineColor, frustumWidth, frustumHeight, true, 0, DOOR_EDGE_STROKE_FACTOR)
        )
    }
    const deviceGeometry = createSemanticPlanDeviceGeometry(context, camera, frustumWidth, frustumHeight, cutHeight, opts)
    const nearbyDoorGeometryRaw = createSemanticPlanNearbyDoorGeometry(context, camera, frustumWidth, frustumHeight, cutHeight, opts)
    const nearbyWindowGeometryRaw = createSemanticPlanNearbyWindowGeometry(context, camera, frustumWidth, frustumHeight, cutHeight)
    const nearbyDoorGeometry = planViewportClip
        ? clipProjectedGeometryToBounds(nearbyDoorGeometryRaw, planViewportClip)
        : nearbyDoorGeometryRaw
    const nearbyWindowGeometry = planViewportClip
        ? clipProjectedGeometryToBounds(nearbyWindowGeometryRaw, planViewportClip)
        : nearbyWindowGeometryRaw
    renderGeometry.edges.push(...deviceGeometry.edges)
    renderGeometry.polygons.push(...deviceGeometry.polygons)
    renderGeometry.edges.push(...nearbyDoorGeometry.edges)
    renderGeometry.polygons.push(...nearbyDoorGeometry.polygons)
    renderGeometry.edges.push(...nearbyWindowGeometry.edges)
    renderGeometry.polygons.push(...nearbyWindowGeometry.polygons)

    if (showPlanSwing && context.openingDirection) {
        const arcEdges = calculateSwingArcEdges(context, frame, camera, frustumWidth, frustumHeight, cutHeight, flipArc)
        renderGeometry.edges.push(...arcEdges)
    }

    const planDoorBounds = projectPlanRect(-halfT, halfT, halfW)
    const planWallBandBounds = projectPlanRect(-halfT - planCropM, halfT + planCropM, halfW + planCropM)

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
    const realWallMeshCount = getHostWallMeshes(context).length + getNearbyWallMeshes(context).length
    const hasMeshSection = meshPlanSectionGeometry.polygons.length > 0
        || meshPlanSectionGeometry.edges.some((edge) => edge.color !== 'none')

    // fitGeometry + planViewportClip are computed above (before nearby geometry) so semantic
    // nearby doors/windows can be clipped to the same projected window as the host wall mesh.

    // Prefer the real mesh-based section when it produced geometry. If wall meshes exist but
    // planar sectioning yields nothing (common with Fragments instancing vs web-ifc cut plane),
    // use semantic stubs — do not keep an empty mesh shell just because realWallMeshCount > 0.
    const planWallGeometry = hasMeshSection
        ? meshPlanSectionGeometry
        : createSemanticPlanWallGeometry(context, camera, frustumWidth, frustumHeight, opts)

    // Walls in plan are no longer clipped to a viewport rectangle — polygons
    // that extend past the plan "fit box" used to get closed by a synthetic
    // vertical jamb, which showed up as a dark line terminating the wall on
    // one side. The SVG viewBox itself still clips anything off-canvas, which
    // is the picture border the spec asks for.
    const hostGeometry = planWallGeometry
    renderGeometry.edges.push(...hostGeometry.edges)
    renderGeometry.polygons.push(...hostGeometry.polygons)
    const hasPlanWallGeometry = hostGeometry.edges.length > 0 || hostGeometry.polygons.length > 0

    const doorAnchorProjected = projectPoint(frame.origin, camera, frustumWidth, frustumHeight)
    const doorAnchor = { x: doorAnchorProjected.x, y: doorAnchorProjected.y }

    return generateSVGString(
        renderGeometry.edges,
        renderGeometry.polygons,
        opts,
        fitGeometry,
        {
            context,
            viewType: 'Plan',
            planArcFlip: flipArc,
            suppressSyntheticWallBands: true,
            planDoorBounds,
            planWallBandBounds: { minY: planWallBandBounds.minY, maxY: planWallBandBounds.maxY },
            ...(sharedDrawingScale !== undefined ? { sharedDrawingScale } : {}),
            doorAnchor,
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
    const arrowY = offsetY + scaledThickness + 30
    const arrowEndY = arrowY + 25

    const fontDefs = svgWebFontDefs(opts.fontFamily)
    let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">
${fontDefs}  <rect width="100%" height="100%" fill="${backgroundColor}"/>

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
