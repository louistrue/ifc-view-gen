/**
 * Lean SVG renderer for ifc-lite door views.
 *
 * Three views per door, fixed scale, fixed anchor:
 *
 *   front (room A side) / back (room B side):
 *     - 1000×1000 SVG canvas, content edge-to-edge (no margin gutter).
 *     - World scale FIXED_PX_PER_METER = 285 — picked so a 4 m slab-to-slab
 *       storey just fills the height, and a 2.5 m door always reads the same
 *       width across all renders.
 *     - Door horizontal centre is anchored to canvas centre.
 *     - Content bottom-aligned: lowest visible Y in the elevation viewport
 *       (slab below or door bottom) sits on the canvas bottom edge.
 *     - Storey label "00EG ▼" rendered in the bottom-right corner if the
 *       door has a storey assignment.
 *
 *   plan:
 *     - 1000×1000 SVG, plan-section cut at door waist height (door bottom +
 *       1.0 m).  Wall, host wall, jambs, perpendicular walls and the door
 *       leaf foot-print appear as filled outlines; door swing arc is dashed.
 *     - Centred on door plan-centre, Y axis = world Z, X axis = world X.
 *
 * Colour selection comes from `lib/color-config.ts` so the palette stays
 * shared with the legacy renderer (same Inter palette, BKP-aware drywall and
 * door-leaf colours).
 */
import * as THREE from 'three'
import {
    DEFAULT_SVG_FONT_FAMILY,
} from './svg-renderer'
import {
    INTER_WOFF2_LATIN_400_BASE64,
    INTER_WOFF2_LATIN_600_BASE64,
    INTER_WOFF2_LATIN_700_BASE64,
} from './inter-svg-font-embed-data'
import {
    classifyDoorBKP,
    classifyWallBKP,
    isSafetyDevice,
    loadRenderColors,
    resolveElevationDoorColor,
    resolveWallCutColor,
    resolveWallElevationColor,
    type RenderColors,
} from './color-config'
import type { AABB, DoorContextLite, DoorViewFrame } from './ifclite-door-analyzer'
import type { IfcLiteMesh } from './ifclite-source'

const COLORS = loadRenderColors()

export const FIXED_PX_PER_METER = 285
// Canvas matches the legacy 1000×1000 SVG.  The PNG rasteriser upscales to
// 1400 px wide, so the *effective* zoom in the PNG is 285×1.4 = 399 px/m —
// same as legacy.  Bumping the SVG canvas to 1400 (which we tried earlier)
// breaks zoom parity because the rasteriser then ships the SVG 1:1.
export const CANVAS_PX = 1000
export const CANVAS_HEIGHT_PX = 1000

// Legacy renderer constants — kept identical so visual parity holds.
const STRUCTURAL_SLAB_INTRUSION_METERS = 0.10  // 10 cm into slab top/bottom face
const STOREY_CONTENT_HEIGHT_METERS = 3.5       // hard cap on visible vertical span
// Lateral context size on each side of the door, matched to legacy
// `getEffectiveLateralHalfMeters`: clamp(doorWidth*0.5, 0.5m, 1.5m). Beyond
// this the canvas paints the page background — the architectural border that
// frames the elevation/plan instead of bleeding model fill to the page edge.
const LATERAL_GAP_MIN_METERS = 0.5
const LATERAL_GAP_MAX_METERS = 1.5

/** Legacy parity: half-window in metres for plan + elevation lateral content,
 *  capped by the host wall's actual horizontal extent (so a perpendicular
 *  T-stub past the wall end doesn't push the window wider than the wall). */
function computeEffectiveLateralHalfMeters(ctx: DoorContextLite): number {
    const halfDoor = ctx.viewFrame.width / 2
    const lateralGap = Math.max(LATERAL_GAP_MIN_METERS, Math.min(LATERAL_GAP_MAX_METERS, ctx.viewFrame.width * 0.5))
    let localMinW = -halfDoor - lateralGap
    let localMaxW = halfDoor + lateralGap
    if (ctx.hostWall) {
        const { origin, widthAxis } = ctx.viewFrame
        const bb = ctx.hostWall.bbox
        const corners: Array<[number, number]> = [
            [bb.min[0], bb.min[2]], [bb.max[0], bb.min[2]],
            [bb.min[0], bb.max[2]], [bb.max[0], bb.max[2]],
        ]
        let wallMin = +Infinity, wallMax = -Infinity
        for (const [x, z] of corners) {
            const p = (x - origin[0]) * widthAxis[0] + (z - origin[2]) * widthAxis[2]
            if (p < wallMin) wallMin = p
            if (p > wallMax) wallMax = p
        }
        // Cap window to wall extent but never tighter than door + gap.
        localMinW = Math.min(Math.max(wallMin, -halfDoor - lateralGap), -halfDoor)
        localMaxW = Math.max(Math.min(wallMax, halfDoor + lateralGap), halfDoor)
    }
    return Math.max(Math.abs(localMinW), Math.abs(localMaxW))
}

/** Side gutter (in pixels) so model content sits inside [marginX, W-marginX]
 *  centred on the door anchor — matches the legacy elevation/plan viewport. */
function computeContentMarginX(ctx: DoorContextLite, canvasW: number): number {
    const effHalfW = computeEffectiveLateralHalfMeters(ctx)
    const visibleHalfPx = effHalfW * FIXED_PX_PER_METER
    return Math.max(0, Math.round(canvasW / 2 - visibleHalfPx))
}

export interface RenderOptions {
    width?: number
    height?: number
    lineWidth?: number
    /** Override colour palette (defaults to the shared one). */
    colors?: RenderColors
    /** Vertical fraction of canvas height the door foot is anchored at (default 0.94 — small bottom gutter for label). */
    doorFootAnchor?: number
    /** Optional debug: emit each filled polygon's expressId as data attribute. */
    emitDebugAttrs?: boolean
}

const DEFAULT_OPTS: Required<Pick<RenderOptions, 'width' | 'height' | 'lineWidth' | 'colors' | 'doorFootAnchor' | 'emitDebugAttrs'>> = {
    width: CANVAS_PX,
    height: CANVAS_HEIGHT_PX,
    lineWidth: 1.5,
    colors: COLORS,
    // Storey content fills the canvas exactly (no gutter): viewport bottom
    // anchored at canvas Y = H so the slab-above band at storey top is on-
    // canvas at storey-content cap = 3.5 m.  Storey label rides on top of the
    // slab-below fill at the very bottom — readable, mirrors the legacy.
    doorFootAnchor: 1.0,
    emitDebugAttrs: false,
}

interface ProjectedSegment {
    x1: number; y1: number; x2: number; y2: number
    color: string
    depth: number   // for sort
    layer: number
    width: number
    dashed?: boolean
}

interface ProjectedPolygon {
    points: Array<{ x: number; y: number }>
    fill: string
    fillOpacity?: number
    depth: number
    layer: number
    expressId?: number
}

interface MeshClassification {
    fill: string
    fillOpacity?: number
    layer: number
    role: 'door' | 'host-wall' | 'nearby-wall' | 'slab' | 'window' | 'nearby-door' | 'device' | 'safety' | 'other'
}

function resolvePlanNearbyDoorColor(cfcBkp: string | null, colors: RenderColors): string {
    const cat = classifyDoorBKP(cfcBkp)
    if (cat === 'context') return colors.elevation.door.byBKP.context
    return colors.plan.doorContext
}

// Layer ordering (higher number = drawn later = visually in front):
//   1 = wall fill, 2 = slab fill (covers wall at floor/ceiling band),
//   3 = nearby door fill, 4 = window/glass, 6 = current door, 7 = device,
//   8 = safety device, +10 = stroke layer of the same role.
function classifyMesh(
    mesh: IfcLiteMesh,
    ctx: DoorContextLite,
    elevationView: boolean,
    colors: RenderColors,
): MeshClassification {
    const id = mesh.expressId
    if (id === ctx.door.expressId) {
        const cat = classifyDoorBKP(ctx.cset.cfcBkp)
        const fill = elevationView
            ? resolveElevationDoorColor(ctx.cset.cfcBkp, colors)
            : colors.plan.currentDoor
        if (elevationView && isLikelyGlazingPanelMesh(mesh)) {
            return { fill: colors.elevation.glass, fillOpacity: 0.32, layer: 5, role: 'door' }
        }
        void cat
        return { fill, layer: 6, role: 'door' }
    }
    if (ctx.hostWall && id === ctx.hostWall.expressId) {
        const fill = elevationView
            ? resolveWallElevationColor(null, colors)
            : resolveWallCutColor(null, colors)
        return { fill, layer: 1, role: 'host-wall' }
    }
    if (ctx.nearbyWalls.some((w) => w.expressId === id)) {
        const fill = elevationView ? colors.elevation.wall : colors.plan.wallCut
        return { fill, layer: 1, role: 'nearby-wall' }
    }
    if ((ctx.slabBelow && ctx.slabBelow.expressId === id) || (ctx.slabAbove && ctx.slabAbove.expressId === id)) {
        return { fill: colors.elevation.wall, layer: 2, role: 'slab' }
    }
    if (ctx.nearbyWindows.some((w) => w.expressId === id)) {
        // Glass blue is reserved for the FOCAL door's own glazing — adjacent
        // windows render in the wall context colour so the eye stays on the
        // door being reviewed.
        return { fill: colors.elevation.wall, fillOpacity: 0.5, layer: 4, role: 'window' }
    }
    const nearbyDoor = ctx.nearbyDoors.find((d) => d.expressId === id)
    if (nearbyDoor) {
        // Adjacent doors color by their OWN BKP in elevation (so a metal
        // door reads metal, a wood door reads wood, regardless of focal
        // door's BKP).  Plan keeps context color by default, but CFC 2731
        // maps to `context` (hellgrau) explicitly.
        const fill = elevationView
            ? resolveElevationDoorColor(nearbyDoor.cfcBkp, colors)
            : resolvePlanNearbyDoorColor(nearbyDoor.cfcBkp, colors)
        return { fill, fillOpacity: 0.5, layer: 3, role: 'nearby-door' }
    }
    const dev = ctx.nearbyDevices.find((d) => d.expressId === id)
    if (dev) {
        const safety = isSafetyDevice(dev.name, null, colors)
        return safety
            ? { fill: colors.elevation.safety, layer: 8, role: 'safety' }
            : { fill: colors.elevation.electrical, layer: 7, role: 'device' }
    }
    return { fill: '#cccccc', layer: 2, role: 'other' }
}

function isLikelyGlazingPanelMesh(mesh: IfcLiteMesh): boolean {
    const pos = mesh.positions
    if (pos.length === 0) return false
    let minX = +Infinity, minY = +Infinity, minZ = +Infinity
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
    for (let k = 0; k < pos.length; k += 3) {
        const x = pos[k], y = pos[k + 1], z = pos[k + 2]
        if (x < minX) minX = x; if (x > maxX) maxX = x
        if (y < minY) minY = y; if (y > maxY) maxY = y
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
    }
    const extents = [maxX - minX, maxY - minY, maxZ - minZ]
    return Math.min(...extents) <= 0.005
}

/** Build a list of all meshes the elevation view should consider — for the
 * triangulated path.  Slabs and host wall are rendered as bbox rectangles
 * separately (cleaner band/wall look), so they're omitted here. */
function elevationMeshSet(ctx: DoorContextLite): Array<{ mesh: IfcLiteMesh; expressId: number }> {
    const out: Array<{ mesh: IfcLiteMesh; expressId: number }> = []
    const push = (m: IfcLiteMesh) => out.push({ mesh: m, expressId: m.expressId })
    for (const m of ctx.door.meshes) push(m)
    for (const d of ctx.nearbyDoors) for (const m of d.meshes) push(m)
    for (const w of ctx.nearbyWindows) for (const m of w.meshes) push(m)
    for (const d of ctx.nearbyDevices) for (const m of d.meshes) push(m)
    return out
}

/** Project a world-space AABB to a clean axis-aligned screen rectangle and
 * return as a single polygon. Used for elevation slab bands and host wall
 * fill — bypasses triangulation noise. */
function projectBoxToElevationRect(
    bbox: AABB,
    cam: CameraSetup,
    pixelClip: PixelClipRect,
): Pt[] | null {
    // Project the 8 corners of the AABB and take the screen-space bbox of the
    // result.  The mesh elevation projection of an AABB is always an
    // axis-aligned rectangle (orthographic camera, axis-aligned world box).
    const corners: Array<[number, number, number]> = [
        [bbox.min[0], bbox.min[1], bbox.min[2]],
        [bbox.max[0], bbox.min[1], bbox.min[2]],
        [bbox.min[0], bbox.max[1], bbox.min[2]],
        [bbox.max[0], bbox.max[1], bbox.min[2]],
        [bbox.min[0], bbox.min[1], bbox.max[2]],
        [bbox.max[0], bbox.min[1], bbox.max[2]],
        [bbox.min[0], bbox.max[1], bbox.max[2]],
        [bbox.max[0], bbox.max[1], bbox.max[2]],
    ]
    let minX = +Infinity, minY = +Infinity
    let maxX = -Infinity, maxY = -Infinity
    for (const [x, y, z] of corners) {
        const p = projectPoint(new THREE.Vector3(x, y, z), cam)
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y
    }
    if (!isFinite(minX)) return null
    const rect: Pt[] = [
        { x: minX, y: minY }, { x: maxX, y: minY },
        { x: maxX, y: maxY }, { x: minX, y: maxY },
    ]
    return clipPolygonRect(rect, pixelClip.minX, pixelClip.minY, pixelClip.maxX, pixelClip.maxY)
}

interface CameraSetup {
    /** World→view matrix: applyMatrix4 on a Vector3 yields view-space point. */
    worldToView: THREE.Matrix4
    /** view→pixel scale + translate (px = scaleX*v.x + offsetX, etc). */
    scaleX: number
    scaleY: number
    offsetX: number
    offsetY: number
    /** depth axis: positive = farther from camera. */
    depthAxisName: 'x' | 'y' | 'z'
}

/**
 * Build a camera for an elevation view (front or back).  Door X centred on
 * canvas; vertical anchor places `viewportBottomY` at canvas bottom × footAnchor.
 */
function buildElevationCamera(
    frame: DoorViewFrame,
    side: 'front' | 'back',
    viewportBottomY: number,
    canvasW: number,
    canvasH: number,
    footAnchor: number
): CameraSetup {
    // World axes: widthAxis (horizontal), upAxis = (0,1,0), facing = wall normal.
    // viewFrame.widthAxis matches the plan camera's screen-right direction.
    // The elevation camera shares this convention so plan + elevation read
    // CONSISTENTLY (a feature on the door's left reads as screen-left in both
    // views).  Mathematically: plan looks down with up=-facing, elevation
    // looks at +facing with up=+Y; both end up with camera-right = -facing×Y
    // = widthAxis.  No negation needed.
    const wA = new THREE.Vector3(...frame.widthAxis)
    const uA = new THREE.Vector3(...frame.upAxis)
    const fA = new THREE.Vector3(...frame.facing)
    const sign = side === 'front' ? 1 : -1
    const right = wA.clone().multiplyScalar(sign).normalize()
    const up = uA.clone().normalize()
    const forward = fA.clone().multiplyScalar(-sign).normalize() // camera looks toward door
    // Build worldToView: rows are basis vectors.
    const m = new THREE.Matrix4()
    m.set(
        right.x, right.y, right.z, 0,
        up.x, up.y, up.z, 0,
        forward.x, forward.y, forward.z, 0,
        0, 0, 0, 1,
    )
    // Translation: move origin to door horizontal centre at viewportBottomY.
    const originW = new THREE.Vector3(frame.origin[0], 0, frame.origin[2])
    const originV = originW.clone().applyMatrix4(m)
    // We want screenX(originV) == canvasW/2, screenY(viewportBottomY) == canvasH * footAnchor.
    const scaleX = FIXED_PX_PER_METER
    const scaleY = -FIXED_PX_PER_METER  // SVG y grows downward
    const offsetX = canvasW / 2 - scaleX * originV.x
    const offsetY = canvasH * footAnchor - scaleY * viewportBottomY
    return { worldToView: m, scaleX, scaleY, offsetX, offsetY, depthAxisName: 'z' }
}

/**
 * Build a camera for plan view (top-down).  X axis = world X, Y axis = world Z.
 */
function buildPlanCamera(
    frame: DoorViewFrame,
    canvasW: number,
    canvasH: number
): CameraSetup {
    const m = new THREE.Matrix4()
    // Rows: (1,0,0) (0,0,1) (0,1,0)  → x' = wx, y' = wz, depth = wy (up = far away)
    m.set(
        1, 0, 0, 0,
        0, 0, 1, 0,
        0, 1, 0, 0,
        0, 0, 0, 1,
    )
    const cx = frame.origin[0]
    const cz = frame.origin[2]
    const scaleX = FIXED_PX_PER_METER
    const scaleY = FIXED_PX_PER_METER  // SVG y grows downward; we map +world-z to +y
    // Centre the door plan-centre on the canvas.
    const offsetX = canvasW / 2 - scaleX * cx
    const offsetY = canvasH / 2 - scaleY * cz
    return { worldToView: m, scaleX, scaleY, offsetX, offsetY, depthAxisName: 'y' }
}

function projectPoint(p: THREE.Vector3, cam: CameraSetup): { x: number; y: number; depth: number } {
    const v = p.clone().applyMatrix4(cam.worldToView)
    return {
        x: cam.scaleX * v.x + cam.offsetX,
        y: cam.scaleY * v.y + cam.offsetY,
        depth: v.z,
    }
}

interface MeshPos { x: number; y: number; z: number }

function readMeshTriangle(mesh: IfcLiteMesh, t: number): [MeshPos, MeshPos, MeshPos] {
    const pos = mesh.positions
    let i0: number, i1: number, i2: number
    if (mesh.indices) {
        i0 = mesh.indices[t * 3]; i1 = mesh.indices[t * 3 + 1]; i2 = mesh.indices[t * 3 + 2]
    } else {
        i0 = t * 3; i1 = t * 3 + 1; i2 = t * 3 + 2
    }
    return [
        { x: pos[i0 * 3], y: pos[i0 * 3 + 1], z: pos[i0 * 3 + 2] },
        { x: pos[i1 * 3], y: pos[i1 * 3 + 1], z: pos[i1 * 3 + 2] },
        { x: pos[i2 * 3], y: pos[i2 * 3 + 1], z: pos[i2 * 3 + 2] },
    ]
}

function meshTriangleCount(mesh: IfcLiteMesh): number {
    if (mesh.indices) return Math.floor(mesh.indices.length / 3)
    return Math.floor(mesh.positions.length / 9)
}

const SHARP_THRESHOLD_DEG = 30
const SHARP_DOT_THRESHOLD = Math.cos((SHARP_THRESHOLD_DEG * Math.PI) / 180)
const POSITION_QUANT_MM = 1 // 1 mm quantization for edge dedup

function quant(v: number): number {
    return Math.round(v * 1000 / POSITION_QUANT_MM)
}
function edgeKey(a: MeshPos, b: MeshPos): string {
    const ka = `${quant(a.x)}_${quant(a.y)}_${quant(a.z)}`
    const kb = `${quant(b.x)}_${quant(b.y)}_${quant(b.z)}`
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`
}

interface ExtractedEdge {
    a: MeshPos
    b: MeshPos
}

// Per-mesh edge extraction is the renderer's hot loop — sharpness check is
// O(n²) over normals per edge.  Cache the boundary+sharp edge list keyed on
// the mesh object identity so the second elevation view + plan view all
// reuse the work from the first.
const edgeCache = new WeakMap<IfcLiteMesh, ExtractedEdge[]>()

function extractMeshEdges(mesh: IfcLiteMesh): ExtractedEdge[] {
    const cached = edgeCache.get(mesh)
    if (cached) return cached
    const triCount = meshTriangleCount(mesh)
    if (triCount === 0) {
        edgeCache.set(mesh, [])
        return []
    }
    // Per-edge accumulator: store FIRST normal in n0, OR test each subsequent
    // normal against n0 — once any pair has dot < threshold the edge is
    // already sharp and we can stop accumulating for it.  This drops the
    // O(n²) over normals to O(n) without losing correctness for the common
    // case of edges shared by ≤ 4 triangles.
    interface EdgeAcc {
        a: MeshPos
        b: MeshPos
        n0: [number, number, number]
        sharp: boolean
        boundary: boolean
    }
    const edges = new Map<string, EdgeAcc>()
    for (let t = 0; t < triCount; t++) {
        const [p1, p2, p3] = readMeshTriangle(mesh, t)
        const ex1 = p2.x - p1.x, ey1 = p2.y - p1.y, ez1 = p2.z - p1.z
        const ex2 = p3.x - p1.x, ey2 = p3.y - p1.y, ez2 = p3.z - p1.z
        let nx = ey1 * ez2 - ez1 * ey2
        let ny = ez1 * ex2 - ex1 * ez2
        let nz = ex1 * ey2 - ey1 * ex2
        const len = Math.hypot(nx, ny, nz)
        if (len > 1e-9) { nx /= len; ny /= len; nz /= len }
        const segs: [MeshPos, MeshPos][] = [[p1, p2], [p2, p3], [p3, p1]]
        for (const [a, b] of segs) {
            const key = edgeKey(a, b)
            const acc = edges.get(key)
            if (!acc) {
                edges.set(key, { a, b, n0: [nx, ny, nz], sharp: false, boundary: true })
            } else {
                acc.boundary = false
                if (!acc.sharp) {
                    // Take |dot| so a flipped-winding triangle (n2 = -n1) on a
                    // coplanar mesh still reads as 0° fold, not 180°.  IFC
                    // geometry pipelines (and ifc-lite's WASM tessellator) are
                    // not strict about consistent winding for flat slabs and
                    // walls — without the abs() every interior triangulation
                    // edge gets stroked, drowning the silhouette in noise.
                    const dot = Math.abs(acc.n0[0] * nx + acc.n0[1] * ny + acc.n0[2] * nz)
                    if (dot < SHARP_DOT_THRESHOLD) acc.sharp = true
                }
            }
        }
    }
    const out: ExtractedEdge[] = []
    for (const acc of edges.values()) {
        if (acc.boundary || acc.sharp) out.push({ a: acc.a, b: acc.b })
    }
    edgeCache.set(mesh, out)
    return out
}

interface WorldClip {
    /** Worlds-space Y range to keep (elevation clip; min ≤ y ≤ max). */
    yMin?: number
    yMax?: number
    /** Plan thickness band: only keep triangles whose AABB straddles this Y in [yMin, yMax]. */
    planCutY?: number
    /** Plan rect: keep only positions within this XZ box (world coords). */
    xMin?: number
    xMax?: number
    zMin?: number
    zMax?: number
}

interface PixelClipRect {
    minX: number
    minY: number
    maxX: number
    maxY: number
}

function projectMeshFill(
    mesh: IfcLiteMesh,
    cam: CameraSetup,
    classification: MeshClassification,
    expressId: number,
    clip?: WorldClip,
    pixelClip?: PixelClipRect,
): ProjectedPolygon[] {
    const triCount = meshTriangleCount(mesh)
    const out: ProjectedPolygon[] = []
    for (let t = 0; t < triCount; t++) {
        const [p1, p2, p3] = readMeshTriangle(mesh, t)
        if (clip) {
            if (clip.yMin != null && p1.y < clip.yMin && p2.y < clip.yMin && p3.y < clip.yMin) continue
            if (clip.yMax != null && p1.y > clip.yMax && p2.y > clip.yMax && p3.y > clip.yMax) continue
            if (clip.planCutY != null) {
                const triMinY = Math.min(p1.y, p2.y, p3.y)
                const triMaxY = Math.max(p1.y, p2.y, p3.y)
                if (clip.planCutY < triMinY || clip.planCutY > triMaxY) continue
            }
            if (clip.xMin != null && p1.x < clip.xMin && p2.x < clip.xMin && p3.x < clip.xMin) continue
            if (clip.xMax != null && p1.x > clip.xMax && p2.x > clip.xMax && p3.x > clip.xMax) continue
            if (clip.zMin != null && p1.z < clip.zMin && p2.z < clip.zMin && p3.z < clip.zMin) continue
            if (clip.zMax != null && p1.z > clip.zMax && p2.z > clip.zMax && p3.z > clip.zMax) continue
        }
        const a = projectPoint(new THREE.Vector3(p1.x, p1.y, p1.z), cam)
        const b = projectPoint(new THREE.Vector3(p2.x, p2.y, p2.z), cam)
        const c = projectPoint(new THREE.Vector3(p3.x, p3.y, p3.z), cam)
        const area2 = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)
        if (Math.abs(area2) < 0.5) continue
        let pts: Pt[] = [{ x: a.x, y: a.y }, { x: b.x, y: b.y }, { x: c.x, y: c.y }]
        if (pixelClip) {
            // Sutherland-Hodgman polygon clip against the storey content rect.
            // Triangles may degenerate to quads/pentagons after clipping but
            // SVG <polygon> handles arbitrary-vertex convex shapes fine.
            pts = clipPolygonRect(pts, pixelClip.minX, pixelClip.minY, pixelClip.maxX, pixelClip.maxY)
            if (pts.length < 3) continue
        }
        out.push({
            points: pts,
            fill: classification.fill,
            fillOpacity: classification.fillOpacity,
            depth: (a.depth + b.depth + c.depth) / 3,
            layer: classification.layer,
            expressId,
        })
    }
    return out
}

type Pt = { x: number; y: number }

/** Sutherland-Hodgman polygon clip against an axis-aligned rect.  Returns
 * the clipped polygon (possibly empty).  Used to crop projected triangles
 * to the storey-content viewport rectangle so multi-storey wall meshes
 * don't bleed past the slab band. */
function clipPolygonRect(poly: Pt[], xmin: number, ymin: number, xmax: number, ymax: number): Pt[] {
    if (poly.length === 0) return poly
    type Side = 'left' | 'right' | 'top' | 'bottom'
    const inside = (p: Pt, side: Side): boolean => {
        if (side === 'left') return p.x >= xmin
        if (side === 'right') return p.x <= xmax
        if (side === 'top') return p.y >= ymin
        return p.y <= ymax
    }
    const intersect = (a: Pt, b: Pt, side: Side): Pt => {
        const dx = b.x - a.x, dy = b.y - a.y
        let t = 0
        if (side === 'left')   t = (xmin - a.x) / dx
        if (side === 'right')  t = (xmax - a.x) / dx
        if (side === 'top')    t = (ymin - a.y) / dy
        if (side === 'bottom') t = (ymax - a.y) / dy
        return { x: a.x + dx * t, y: a.y + dy * t }
    }
    const clipSide = (input: Pt[], side: Side): Pt[] => {
        if (input.length === 0) return input
        const out: Pt[] = []
        let prev = input[input.length - 1]
        let prevIn = inside(prev, side)
        for (const cur of input) {
            const curIn = inside(cur, side)
            if (curIn) {
                if (!prevIn) out.push(intersect(prev, cur, side))
                out.push(cur)
            } else if (prevIn) {
                out.push(intersect(prev, cur, side))
            }
            prev = cur
            prevIn = curIn
        }
        return out
    }
    let p = poly
    p = clipSide(p, 'left'); if (p.length === 0) return p
    p = clipSide(p, 'right'); if (p.length === 0) return p
    p = clipSide(p, 'top'); if (p.length === 0) return p
    p = clipSide(p, 'bottom')
    return p
}

/** Liang-Barsky line clipping against an axis-aligned 2D rect.  Returns null
 * if entirely outside, otherwise returns the clipped segment endpoints. */
function clipLine2D(
    x1: number, y1: number, x2: number, y2: number,
    xmin: number, ymin: number, xmax: number, ymax: number
): [number, number, number, number] | null {
    const dx = x2 - x1
    const dy = y2 - y1
    let t0 = 0, t1 = 1
    const p = [-dx, dx, -dy, dy]
    const q = [x1 - xmin, xmax - x1, y1 - ymin, ymax - y1]
    for (let i = 0; i < 4; i++) {
        if (p[i] === 0) {
            if (q[i] < 0) return null
        } else {
            const r = q[i] / p[i]
            if (p[i] < 0) {
                if (r > t1) return null
                if (r > t0) t0 = r
            } else {
                if (r < t0) return null
                if (r < t1) t1 = r
            }
        }
    }
    return [
        x1 + t0 * dx, y1 + t0 * dy,
        x1 + t1 * dx, y1 + t1 * dy,
    ]
}

function projectMeshSegments(
    mesh: IfcLiteMesh,
    cam: CameraSetup,
    color: string,
    layer: number,
    width: number,
    clip?: WorldClip,
    canvasW?: number,
    canvasH?: number,
    canvasMinY?: number,
    canvasMinX?: number,
    canvasMaxX?: number,
): ProjectedSegment[] {
    const edges = extractMeshEdges(mesh)
    const out: ProjectedSegment[] = []
    const minY = canvasMinY ?? -4
    const minX = canvasMinX ?? -4
    for (const { a, b } of edges) {
        if (clip) {
            if (clip.yMin != null && a.y < clip.yMin && b.y < clip.yMin) continue
            if (clip.yMax != null && a.y > clip.yMax && b.y > clip.yMax) continue
            if (clip.xMin != null && a.x < clip.xMin && b.x < clip.xMin) continue
            if (clip.xMax != null && a.x > clip.xMax && b.x > clip.xMax) continue
            if (clip.zMin != null && a.z < clip.zMin && b.z < clip.zMin) continue
            if (clip.zMax != null && a.z > clip.zMax && b.z > clip.zMax) continue
        }
        const pa = projectPoint(new THREE.Vector3(a.x, a.y, a.z), cam)
        const pb = projectPoint(new THREE.Vector3(b.x, b.y, b.z), cam)
        let x1 = pa.x, y1 = pa.y, x2 = pb.x, y2 = pb.y
        if (canvasW != null && canvasH != null) {
            const maxX = canvasMaxX ?? canvasW + 4
            const clipped = clipLine2D(x1, y1, x2, y2, minX, minY, maxX, canvasH + 4)
            if (!clipped) continue
            x1 = clipped[0]; y1 = clipped[1]; x2 = clipped[2]; y2 = clipped[3]
        }
        out.push({
            x1, y1, x2, y2,
            color, layer, width,
            depth: (pa.depth + pb.depth) / 2,
        })
    }
    return out
}

function svgWebFontDefs(family: string): string {
    if (family !== DEFAULT_SVG_FONT_FAMILY) return ''
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

function escapeSvgText(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function svgPolygon(p: ProjectedPolygon): string {
    const pts = p.points.map((pt) => `${pt.x.toFixed(2)},${pt.y.toFixed(2)}`).join(' ')
    const op = p.fillOpacity != null ? ` fill-opacity="${p.fillOpacity}"` : ''
    return `<polygon points="${pts}" fill="${p.fill}"${op} />`
}

function svgSegment(s: ProjectedSegment, baseStroke: string): string {
    const dash = s.dashed ? ' stroke-dasharray="6 4"' : ''
    return `<line x1="${s.x1.toFixed(2)}" y1="${s.y1.toFixed(2)}" x2="${s.x2.toFixed(2)}" y2="${s.y2.toFixed(2)}" stroke="${s.color || baseStroke}" stroke-width="${s.width.toFixed(2)}"${dash} />`
}

/** Distance from door bottom to the nearer face of the bracketing structural
 * slab, in metres.  Positive Y is "above"; negative Y is "below".  Returns
 * null when no slab is bound on that side. */
function getStructuralSlabFaceDy(ctx: DoorContextLite, which: 'above' | 'below'): number | null {
    const doorBottom = ctx.viewFrame.origin[1]
    if (which === 'above' && ctx.slabAbove) return ctx.slabAbove.bbox.min[1] - doorBottom
    if (which === 'below' && ctx.slabBelow) return ctx.slabBelow.bbox.max[1] - doorBottom
    return null
}

function emitElevationSvg(
    ctx: DoorContextLite,
    side: 'front' | 'back',
    options: Required<Pick<RenderOptions, 'width' | 'height' | 'lineWidth' | 'colors' | 'doorFootAnchor' | 'emitDebugAttrs'>>,
): string {
    const W = options.width
    const H = options.height
    const doorBottom = ctx.viewFrame.origin[1]

    // Storey vertical viewport (legacy parity, see svg-renderer.ts):
    //   bottomDy = slab-below.top - 10 cm intrusion (drop into slab below)
    //   topDy    = min(slab-above.bottom + 10 cm, bottomDy + 3.5 m cap)
    // Falls back to door-bottom ± 10 cm when slabs are missing.
    //
    // When findSlabsAroundDoor doesn't return a structural IFCSLAB (Flu21
    // basement: slab too far from door centre, only Bodenplatte tiles model
    // the floor), use the lowest IFCBUILDINGELEMENTPART build-up bottom as a
    // proxy for the structural-slab top so the 10 cm cap still reads.
    const structAboveDy = getStructuralSlabFaceDy(ctx, 'above')
    const structBelowDy = getStructuralSlabFaceDy(ctx, 'below')
    let buildupFloorDy: number | null = null
    if (structBelowDy == null && ctx.slabBelowParts.length > 0) {
        let minBottom = +Infinity
        for (const p of ctx.slabBelowParts) {
            if (p.bbox.min[1] < minBottom) minBottom = p.bbox.min[1]
        }
        if (minBottom < doorBottom - 0.005) buildupFloorDy = minBottom - doorBottom
    }
    const effectiveBelowDy = structBelowDy ?? buildupFloorDy
    const bottomDy = effectiveBelowDy != null
        ? effectiveBelowDy - STRUCTURAL_SLAB_INTRUSION_METERS
        : -STRUCTURAL_SLAB_INTRUSION_METERS
    const topCapDy = bottomDy + STOREY_CONTENT_HEIGHT_METERS
    const idealTopDy = structAboveDy != null
        ? Math.min(structAboveDy + STRUCTURAL_SLAB_INTRUSION_METERS, topCapDy)
        : topCapDy
    // Always reserve 10 cm of headroom above the door bbox top so the slab
    // cap band (drawn at viewportTopY) renders ABOVE the door rather than
    // inside its vertical extent.  Some doors include a transom/frame in
    // their bbox that reaches into the wall lintel — without this floor,
    // slabAbove.bbox.min[1] sits at or below door head, viewportTopY = door
    // head, and the door (layer 6) paints over the slab cap (layer 2).
    const doorHeadDy = ctx.door.bbox.max[1] - doorBottom
    const topDy = Math.max(idealTopDy, doorHeadDy + STRUCTURAL_SLAB_INTRUSION_METERS)
    const viewportBottomY = doorBottom + bottomDy
    const viewportTopY = doorBottom + topDy

    const cam = buildElevationCamera(ctx.viewFrame, side, viewportBottomY, W, H, options.doorFootAnchor)

    if (process.env.DEBUG_VIEWPORT === '1') {
        console.log(`[viewport ${side}] door=${ctx.guid} doorBottom=${doorBottom.toFixed(3)} structAboveDy=${structAboveDy} structBelowDy=${structBelowDy} bottomDy=${bottomDy.toFixed(3)} topDy=${topDy.toFixed(3)} viewport=[${viewportBottomY.toFixed(3)}, ${viewportTopY.toFixed(3)}]`)
    }

    // World-coords clip: full canvas width centered on the door anchor + Y
    // viewport.  Bbox-rect rendering clips polygons to the canvas in pixel
    // space anyway; this clip just kills triangulated meshes that fall
    // entirely outside the visible box.
    const halfCanvasMeters = (W / 2) / FIXED_PX_PER_METER
    // Depth clip — ASYMMETRIC, matching real elevation behaviour:
    //   • camera-side (in front of the door): include up to
    //     ELEVATION_DEPTH_FRONT_M past the door origin so jambs, frames,
    //     handles and devices mounted on the front of the wall still register.
    //   • far side (behind the wall): clip exactly at the host wall's far
    //     face — never leak the adjacent room's geometry into the elevation,
    //     because architecturally the wall occludes everything past it.
    //
    // A symmetric ±0.3 m crop (the previous version) effectively rendered
    // 30 cm of the OPPOSITE room into every view, which is wrong for an
    // elevation drawing.
    // Picture depth = door middle on the facing axis.  Each elevation
    // renders the half-space BETWEEN the camera and the picture depth:
    //   front: depth ∈ [doorMid, +∞)  — front room + front half of wall
    //   back : depth ∈ (-∞, doorMid]  — back room + back half of wall
    //
    // Perpendicular walls sticking out on the camera side of the host wall
    // get cut at picture depth and appear as their cross-section profile
    // (a narrow vertical strip at the wall's widthAxis position).  Walls
    // entirely in the FAR room (behind the host wall from the camera) are
    // culled — they're occluded by the host wall.
    const FAR_FACE_TOLERANCE_M = 0
    const elevationClip: WorldClip = {
        yMin: viewportBottomY - 0.02,
        yMax: viewportTopY + 0.02,
    }
    const cameraSign = side === 'front' ? 1 : -1
    const isXAligned = Math.abs(ctx.viewFrame.widthAxis[0]) > Math.abs(ctx.viewFrame.widthAxis[2])
    // When hostWall is missing (door at corner / fills+bbox both fail), fall
    // back to an inflated door bbox along the facing axis so the depth clip
    // still admits perpendicular wall returns / frame profiles within a
    // typical wall-thickness band rather than collapsing to the door's own
    // 8 cm leaf depth.
    const hostBboxForClip: AABB = ctx.hostWall?.bbox ?? (() => {
        const inflate = 0.5
        const b = ctx.door.bbox
        if (isXAligned) {
            return { min: [b.min[0], b.min[1], b.min[2] - inflate], max: [b.max[0], b.max[1], b.max[2] + inflate] }
        }
        return { min: [b.min[0] - inflate, b.min[1], b.min[2]], max: [b.max[0] + inflate, b.max[1], b.max[2]] }
    })()
    // Camera-side depth: 35 cm (0.35 m) past the door middle on the facing
    // axis.  Captures the front half of the host wall + a thin slice of the
    // camera-side room (perpendicular jamb returns, frame profile,
    // wall-mounted devices) without painting wall stubs that extend far
    // into the camera-side room.
    const DEPTH_FAR = 0.35
    if (isXAligned) {
        // Width axis = X, facing axis = Z. Width clip stays symmetric.
        elevationClip.xMin = ctx.viewFrame.origin[0] - halfCanvasMeters - 0.1
        elevationClip.xMax = ctx.viewFrame.origin[0] + halfCanvasMeters + 0.1
        const cameraDirZ = cameraSign * ctx.viewFrame.facing[2]
        const doorMidZ = ctx.viewFrame.origin[2]
        if (cameraDirZ > 0) {
            // Front camera on +Z side.  Visible: [doorMid, +∞).
            elevationClip.zMin = doorMidZ - FAR_FACE_TOLERANCE_M
            elevationClip.zMax = doorMidZ + DEPTH_FAR
        } else {
            // Back camera on -Z side.  Visible: (-∞, doorMid].
            elevationClip.zMin = doorMidZ - DEPTH_FAR
            elevationClip.zMax = doorMidZ + FAR_FACE_TOLERANCE_M
        }
    } else {
        // Width axis = Z, facing axis = X. Width clip stays symmetric.
        elevationClip.zMin = ctx.viewFrame.origin[2] - halfCanvasMeters - 0.1
        elevationClip.zMax = ctx.viewFrame.origin[2] + halfCanvasMeters + 0.1
        const cameraDirX = cameraSign * ctx.viewFrame.facing[0]
        const doorMidX = ctx.viewFrame.origin[0]
        if (cameraDirX > 0) {
            elevationClip.xMin = doorMidX - FAR_FACE_TOLERANCE_M
            elevationClip.xMax = doorMidX + DEPTH_FAR
        } else {
            elevationClip.xMin = doorMidX - DEPTH_FAR
            elevationClip.xMax = doorMidX + FAR_FACE_TOLERANCE_M
        }
    }

    // Pixel rect for Sutherland-Hodgman polygon clipping. Top is the world
    // viewport top, projected to screen — anything above gets cut.  Bottom
    // stays on the canvas edge so a slab-below band reads to the very edge.
    // Left/right gutters: keep the architectural border whitespace the legacy
    // renderer had — content is painted only inside [marginX, W-marginX].
    const yScreenAt = (yWorld: number) => cam.scaleY * yWorld + cam.offsetY
    const screenTopWorld = yScreenAt(viewportTopY)
    const screenBottomWorld = yScreenAt(viewportBottomY)
    const onCropEdge = (yPx: number) =>
        Math.abs(yPx - screenTopWorld) < 0.5 || Math.abs(yPx - screenBottomWorld) < 0.5
    const marginX = computeContentMarginX(ctx, W)
    const pixelClip: PixelClipRect = {
        minX: marginX,
        minY: Math.max(0, Math.min(H, screenTopWorld)),
        maxX: W - marginX,
        maxY: H,
    }

    interface Group {
        layer: number
        polygons: ProjectedPolygon[]
        segments: ProjectedSegment[]
    }
    const groups: Group[] = []

    // Background wall band: content area only (clipped to the side gutters
    // AND to the storey-content vertical viewport).  Without the vertical
    // clip the layer-0 fill paints a wall-grey block above the top slab cap
    // — for short storeys (basement door whose slab-above sits right on the
    // door head) the cap reads as just a black line, not a 10 cm band.  By
    // ending layer-0 at the slab-cap top edge, white page background frames
    // the band the same way the legacy renderer did.
    const layer0TopY = Math.max(0, Math.min(H, screenTopWorld))
    groups.push({
        layer: 0,
        polygons: [{
            points: [
                { x: marginX, y: layer0TopY }, { x: W - marginX, y: layer0TopY },
                { x: W - marginX, y: H }, { x: marginX, y: H },
            ],
            fill: options.colors.elevation.wall,
            depth: 0,
            layer: 0,
        }],
        segments: [],
    })

    // Visibility test: bbox must overlap the canvas widthAxis range AND the
    // storey Y viewport AND its CENTRE must lie on the camera side of the
    // host wall plane (with a small slack for elements physically IN the
    // wall, like adjacent doors / sidelights).
    //
    // Why centre-based on the depth axis (not bbox-AABB intersection): a
    // perpendicular wall in the FRONT room has bbox.min[depth] = host.max
    // (it abuts the wall).  An AABB-intersection test with +ε tolerance
    // would let it kiss into the BACK view's depth clip, painting the
    // wall on both elevations.  Centre-based correctly classifies it as
    // "in front room" → front view only.  Walls that genuinely span the
    // host plane (e.g. a corridor wall passing through) have their centre
    // inside the wall thickness → still visible in both views.
    const facingAxisIdx: 0 | 2 = isXAligned ? 2 : 0
    const widthAxisIdx: 0 | 2 = isXAligned ? 0 : 2
    const widthClipMin = isXAligned ? elevationClip.xMin : elevationClip.zMin
    const widthClipMax = isXAligned ? elevationClip.xMax : elevationClip.zMax
    const hostFacingMin = hostBboxForClip.min[facingAxisIdx]
    const hostFacingMax = hostBboxForClip.max[facingAxisIdx]
    const doorMidFacing = ctx.viewFrame.origin[facingAxisIdx]
    const inWallSlackM = 0.05
    const intersectsElevationVolume = (bbox: AABB): boolean => {
        if (bbox.max[1] < (elevationClip.yMin ?? -Infinity)) return false
        if (bbox.min[1] > (elevationClip.yMax ?? +Infinity)) return false
        if (bbox.max[widthAxisIdx] < (widthClipMin ?? -Infinity)) return false
        if (bbox.min[widthAxisIdx] > (widthClipMax ?? +Infinity)) return false
        // Bbox-AABB intersection on facing axis against the camera-side slab
        // [doorMid - slack, doorMid + DEPTH_FAR].  Elongated geometry —
        // perpendicular walls reaching deep into the room, floor build-up
        // tiles spanning the adjacent room — qualifies as long as ANY part
        // of its bbox sits within DEPTH_FAR (0.35 m) of the door middle.
        // A centre-based test would cull these because their centroid lies
        // past the bound even though real geometry is within range.
        // Front-room perpendicular walls don't leak into the back view
        // because their near face is offset by ~half the host wall thickness
        // (typically 0.10 m), so the bbox doesn't reach doorMid + slack.
        const bMin = bbox.min[facingAxisIdx]
        const bMax = bbox.max[facingAxisIdx]
        if (cameraSign > 0) {
            // Front camera: clip = [doorMid - slack, doorMid + DEPTH_FAR].
            if (bMax < doorMidFacing - inWallSlackM) return false
            if (bMin > doorMidFacing + DEPTH_FAR) return false
            return true
        }
        // Back camera: clip = [doorMid - DEPTH_FAR, doorMid + slack].
        if (bMax < doorMidFacing - DEPTH_FAR) return false
        if (bMin > doorMidFacing + inWallSlackM) return false
        return true
    }
    // Reference hostFacingMin/Max so unused-locals lint stays happy after the
    // half-space simplification — we may still want them for future tweaks.
    void hostFacingMin
    void hostFacingMax
    if (ctx.hostWall && intersectsElevationVolume(ctx.hostWall.bbox)) {
        const wallBbox: AABB = {
            min: [ctx.hostWall.bbox.min[0], Math.max(ctx.hostWall.bbox.min[1], viewportBottomY), ctx.hostWall.bbox.min[2]],
            max: [ctx.hostWall.bbox.max[0], Math.min(ctx.hostWall.bbox.max[1], viewportTopY), ctx.hostWall.bbox.max[2]],
        }
        const rect = projectBoxToElevationRect(wallBbox, cam, pixelClip)
        if (rect && rect.length >= 3) {
            const fill = ctx.cset.cfcBkp != null
                ? resolveWallElevationColor(ctx.cset.cfcBkp, options.colors)
                : options.colors.elevation.wall
            groups.push({
                layer: 1,
                polygons: [{ points: rect, fill, depth: 0, layer: 1, expressId: ctx.hostWall.expressId }],
                segments: [],
            })
        }
    }
    for (const w of ctx.nearbyWalls) {
        if (!intersectsElevationVolume(w.bbox)) continue
        const wbb: AABB = {
            min: [w.bbox.min[0], Math.max(w.bbox.min[1], viewportBottomY), w.bbox.min[2]],
            max: [w.bbox.max[0], Math.min(w.bbox.max[1], viewportTopY), w.bbox.max[2]],
        }
        const rect = projectBoxToElevationRect(wbb, cam, pixelClip)
        if (!rect || rect.length < 3) continue
        // Layer choice: camera-side perpendicular walls (bbox centre on the
        // CAMERA side of door middle by more than half the host wall
        // thickness) sit BETWEEN the camera and the focal door — they should
        // occlude it.  Layer 7 paints over the door's layer 6.  Walls
        // straddling doorMid (host wall, walls in/around the host plane)
        // stay at layer 1 so the door reads through the host wall opening.
        const wallCentreFacing = (w.bbox.min[facingAxisIdx] + w.bbox.max[facingAxisIdx]) / 2
        const cameraSideOffset = (wallCentreFacing - doorMidFacing) * cameraSign
        const isInFrontOfDoor = cameraSideOffset > 0.05
        const wallLayer = isInFrontOfDoor ? 8 : 1
        const verticalEdges: ProjectedSegment[] = []
        let minSx = +Infinity, maxSx = -Infinity, minSy = +Infinity, maxSy = -Infinity
        for (const p of rect) {
            if (p.x < minSx) minSx = p.x
            if (p.x > maxSx) maxSx = p.x
            if (p.y < minSy) minSy = p.y
            if (p.y > maxSy) maxSy = p.y
        }
        const widthPx = maxSx - minSx
        if (widthPx < W * 0.80) {
            const onLeftCrop = Math.abs(minSx - marginX) < 0.5
            const onRightCrop = Math.abs(maxSx - (W - marginX)) < 0.5
            if (!onLeftCrop) {
                verticalEdges.push({ x1: minSx, y1: minSy, x2: minSx, y2: maxSy, color: options.colors.strokes.outline, depth: 0, layer: wallLayer, width: options.lineWidth })
            }
            if (!onRightCrop) {
                verticalEdges.push({ x1: maxSx, y1: minSy, x2: maxSx, y2: maxSy, color: options.colors.strokes.outline, depth: 0, layer: wallLayer, width: options.lineWidth })
            }
            if (!onCropEdge(minSy)) {
                verticalEdges.push({ x1: minSx, y1: minSy, x2: maxSx, y2: minSy, color: options.colors.strokes.outline, depth: 0, layer: wallLayer, width: options.lineWidth })
            }
            if (!onCropEdge(maxSy)) {
                verticalEdges.push({ x1: minSx, y1: maxSy, x2: maxSx, y2: maxSy, color: options.colors.strokes.outline, depth: 0, layer: wallLayer, width: options.lineWidth })
            }
        }
        groups.push({
            layer: wallLayer,
            polygons: [{ points: rect, fill: options.colors.elevation.wall, depth: 0, layer: wallLayer, expressId: w.expressId }],
            segments: verticalEdges,
        })
    }
    // Horizontal band rendering: a full-canvas-width strip clipped to the
    // [yMinWorld, yMaxWorld] range, painted with `fill` at the given layer,
    // with thin top/bottom strokes for the architectural-style stripe look.
    // Strokes that would land EXACTLY on a crop edge (top of viewport at
    // screenTopWorld, bottom of viewport at canvasH) are suppressed — those
    // would read as solid lines drawn along the image crop, not real geometry.
    const drawHorizontalBand = (
        yMinWorld: number,
        yMaxWorld: number,
        fill: string,
        layer: number,
        expressId: number,
        addStrokes: boolean,
    ) => {
        const yTop = yScreenAt(yMaxWorld)
        const yBot = yScreenAt(yMinWorld)
        const yMin = Math.min(yTop, yBot)
        const yMax = Math.max(yTop, yBot)
        if (yMax - yMin < 0.3) return
        const rect: Pt[] = [
            { x: marginX, y: yMin }, { x: W - marginX, y: yMin },
            { x: W - marginX, y: yMax }, { x: marginX, y: yMax },
        ]
        const segments: ProjectedSegment[] = []
        if (addStrokes) {
            if (!onCropEdge(yMin)) {
                segments.push({ x1: marginX, y1: yMin, x2: W - marginX, y2: yMin, color: options.colors.strokes.outline, depth: 0, layer, width: options.lineWidth })
            }
            if (!onCropEdge(yMax)) {
                segments.push({ x1: marginX, y1: yMax, x2: W - marginX, y2: yMax, color: options.colors.strokes.outline, depth: 0, layer, width: options.lineWidth })
            }
        }
        groups.push({
            layer,
            polygons: [{ points: rect, fill, depth: 0, layer, expressId }],
            segments,
        })
    }

    // Bottom of viewport: 10 cm INTO the structural slab below
    //   = slabBelow.top - 10 cm  (i.e. show the top 10 cm of the slab body).
    // Above that, render the structural slab cap stripe (10 cm) with strokes,
    // then the Unterlagsboden parts (build-up / screed / finish) up to the
    // door foot — typically 5–20 cm of additional layers stacked on top.
    // ── Bottom 10 cm structural slab cap ────────────────────────────────────
    // Always render a 10 cm band at the bottom of the storey viewport, even
    // when the analyzer couldn't locate a slabBelow.  viewportBottomY is
    //   slabBelow.top − 0.10 m   when slab is found
    //   doorBottom    − 0.10 m   fallback
    // so the band ALWAYS sits exactly under the door foot (or the slab top
    // when known).  This guarantees the 10 cm structural-slab cap reads
    // consistently across every door, including basement entrances and
    // raised-threshold doors where the analyzer's plan-radius search misses.
    {
        const slabBelowExpressId = ctx.slabBelow?.expressId ?? -1
        // When we fell back to the buildup-derived floor, treat that Y as the
        // structural top so the 10 cm cap reads as a separate band UNDER the
        // build-up rather than smearing into it.
        const slabBandTopY = ctx.slabBelow
            ? ctx.slabBelow.bbox.max[1]
            : (buildupFloorDy != null ? doorBottom + buildupFloorDy : doorBottom)
        drawHorizontalBand(viewportBottomY, slabBandTopY, options.colors.elevation.wall, 2, slabBelowExpressId, true)
        // Unterlagsboden / build-up parts above the structural slab — render
        // even when slabBelow is null (some doors sit at storey openings where
        // the structural slab plane is interrupted).
        //
        // Depth filter: a covering or build-up tile sitting ENTIRELY on the
        // far side of the host wall (in the adjacent room) must NOT smear
        // across this elevation as a full-width band. We render only what
        // is at or in front of the cut plane on the camera side.
        const belowParts = ctx.slabBelowParts
            .filter((p) => intersectsElevationVolume(p.bbox))
            .sort((a, b) => a.bbox.min[1] - b.bbox.min[1])
        for (const part of belowParts) {
            const yLo = Math.max(part.bbox.min[1], viewportBottomY)
            const yHi = Math.min(part.bbox.max[1], viewportTopY)
            if (yHi - yLo < 0.005) continue
            drawHorizontalBand(yLo, yHi, options.colors.elevation.wall, 2, part.expressId, true)
        }
    }
    // ── Top 10 cm structural slab cap (slabAbove) ───────────────────────────
    // Same idea: always paint a 10 cm band at the storey-top reference.
    // Falls back to viewportTopY when slabAbove is missing, so we never have
    // an empty top edge for storeys without a detected ceiling slab.
    {
        const slabAboveExpressId = ctx.slabAbove?.expressId ?? -1
        // Pin the slab cap to the top of the viewport: a tall door whose
        // slabAbove sits above the 3.5 m storey-content cap would otherwise
        // place the band off-canvas (slabAbove.bbox.min[1] > viewportTopY)
        // and pixelClip culls it entirely — the elevation reads with no top
        // cap.  Clamping slabBandBotY to viewportTopY − 10 cm guarantees a
        // visible 10 cm structural-cap band even when the actual slab is
        // beyond the cap.
        const slabBandBotY = ctx.slabAbove
            ? Math.min(ctx.slabAbove.bbox.min[1], viewportTopY - STRUCTURAL_SLAB_INTRUSION_METERS)
            : viewportTopY - STRUCTURAL_SLAB_INTRUSION_METERS
        drawHorizontalBand(slabBandBotY, viewportTopY, options.colors.elevation.wall, 2, slabAboveExpressId, true)
        // Slab-above parts: render both IFCBUILDINGELEMENTPART and IFCCOVERING
        // fills so suspended ceilings / hinged slabs remain visible in
        // elevation. Keep covering bands stroke-free to avoid adding heavy
        // horizontal bars that can visually sever perpendicular wall strokes.
        const aboveParts = ctx.slabAboveParts
            .filter((p) => {
                const inVolume = intersectsElevationVolume(p.bbox)
                if (!inVolume) return false
                const isCovering = (p.meshes[0]?.ifcType?.toUpperCase() ?? '') === 'IFCCOVERING'
                if (!isCovering) return true
                // Coverings can straddle the host plane; choose a deterministic
                // side using bbox centre on the facing axis so a single element
                // doesn't render in both front/back just because it overlaps.
                const centreFacing = (p.bbox.min[facingAxisIdx] + p.bbox.max[facingAxisIdx]) / 2
                const sideGatePass = cameraSign > 0
                    ? centreFacing >= doorMidFacing
                    : centreFacing <= doorMidFacing
                return sideGatePass
            })
            .sort((a, b) => b.bbox.max[1] - a.bbox.max[1])
        for (const part of aboveParts) {
            const yHi = Math.min(part.bbox.max[1], viewportTopY)
            const yLo = Math.max(part.bbox.min[1], viewportBottomY)
            if (yHi - yLo < 0.005) continue
            const isCovering = (part.meshes[0]?.ifcType?.toUpperCase() ?? '') === 'IFCCOVERING'
            const fill = isCovering ? options.colors.elevation.suspendedCeiling : options.colors.elevation.wall
            const addStrokes = isCovering ? true : !isCovering
            const layer = isCovering ? 7 : 2
            drawHorizontalBand(yLo, yHi, fill, layer, part.expressId, addStrokes)
        }
    }

    // Triangulated mesh path for the door, nearby doors/windows, and devices.
    // These need triangle-level fills because they have meaningful interior
    // detail (panels, glazing, frames, hardware).
    const meshes: Array<{ mesh: IfcLiteMesh; expressId: number }> = []
    for (const m of ctx.door.meshes) meshes.push({ mesh: m, expressId: m.expressId })
    for (const d of ctx.nearbyDoors) {
        if (!intersectsElevationVolume(d.bbox)) continue
        for (const m of d.meshes) meshes.push({ mesh: m, expressId: m.expressId })
    }
    for (const w of ctx.nearbyWindows) {
        if (!intersectsElevationVolume(w.bbox)) continue
        for (const m of w.meshes) meshes.push({ mesh: m, expressId: m.expressId })
    }
    for (const d of ctx.nearbyDevices) {
        if (!intersectsElevationVolume(d.bbox)) continue
        for (const m of d.meshes) meshes.push({ mesh: m, expressId: m.expressId })
    }
    // Focal door is the subject of the elevation — always fully drawn in
    // BOTH views.  The depth half-space clip exists for CONTEXT (nearby walls,
    // adjacent doors, slabs, devices) so we don't paint the far room.  Applying
    // it to the focal door's own mesh produces:
    //   • asymmetric glazing — a glass panel offset to one face has all
    //     vertices on one side of doorMid, so one camera keeps it and the
    //     other culls it (front shows blue glass, back doesn't).
    //   • stray slivers over the door — side-faces of the door leaf span
    //     doorMid, partially survive the all-3-outside test, and project
    //     as thin lines on the door area.
    // Solution: render focal door with depth axis removed from the clip;
    // keep Y range and width-axis clip for the storey content / canvas crop.
    const focalDoorClip: WorldClip = {
        yMin: elevationClip.yMin,
        yMax: elevationClip.yMax,
        xMin: isXAligned ? elevationClip.xMin : undefined,
        xMax: isXAligned ? elevationClip.xMax : undefined,
        zMin: !isXAligned ? elevationClip.zMin : undefined,
        zMax: !isXAligned ? elevationClip.zMax : undefined,
    }
    for (const { mesh, expressId } of meshes) {
        const cls = classifyMesh(mesh, ctx, true, options.colors)
        const meshClip = expressId === ctx.door.expressId ? focalDoorClip : elevationClip
        const polys = projectMeshFill(mesh, cam, cls, expressId, meshClip, pixelClip)
        const segs = projectMeshSegments(mesh, cam, options.colors.strokes.outline, cls.layer, options.lineWidth, meshClip, W, H, pixelClip.minY, pixelClip.minX, pixelClip.maxX)
        if (polys.length === 0 && segs.length === 0) continue
        groups.push({ layer: cls.layer, polygons: polys, segments: segs })
    }
    groups.sort((a, b) => a.layer - b.layer)

    // Storey marker (▼ + label) at the storey-elevation reference Y, in the
    // right-side margin.  Mirrors legacy `renderStoreyMarkerSvg`:
    //   - filled black ▼ triangle pointing AT the slab top (the floor line)
    //   - storey CODE (first whitespace-separated token of the long name)
    //     centred horizontally above the triangle
    // Falls back to door-foot Y when storeyElevation is unknown.
    const labelShort = ctx.storeyName ? ctx.storeyName.split(/\s+/)[0] : ''
    const fontFamily = DEFAULT_SVG_FONT_FAMILY
    const labelFont = 22
    const storeyMarkerSvg = (() => {
        if (!labelShort) return ''
        const refWorldY = (typeof ctx.storeyElevation === 'number' && Number.isFinite(ctx.storeyElevation))
            ? ctx.storeyElevation
            : doorBottom
        const refScreenY = yScreenAt(refWorldY)
        // Clamp marker Y inside canvas with breathing room for label.
        const triHeight = 14
        const triHalfWidth = 7
        const labelGap = 8
        const minMarkerY = labelFont + labelGap + triHeight + 4
        const maxMarkerY = H - 6
        const markerY = Math.max(minMarkerY, Math.min(maxMarkerY, refScreenY))
        const markerX = W - 30
        const labelY = markerY - triHeight - labelGap
        const escaped = escapeSvgText(labelShort)
        const triPts = [
            `${(markerX - triHalfWidth).toFixed(2)},${(markerY - triHeight).toFixed(2)}`,
            `${(markerX + triHalfWidth).toFixed(2)},${(markerY - triHeight).toFixed(2)}`,
            `${markerX.toFixed(2)},${markerY.toFixed(2)}`,
        ].join(' ')
        return [
            `<g id="storey-marker">`,
            `<polygon points="${triPts}" fill="#000000"/>`,
            `<text x="${markerX.toFixed(2)}" y="${labelY.toFixed(2)}" text-anchor="middle" font-family="${fontFamily}" font-size="${labelFont}" font-weight="600" fill="#000">${escaped}</text>`,
            `</g>`,
        ].join('')
    })()

    const groupSvg = groups.map((g) => {
        const polys = g.polygons.map(svgPolygon).join('')
        const segs = g.segments.length === 0 ? '' :
            `<g stroke-linejoin="round" stroke-linecap="round">${g.segments.map((s) => svgSegment(s, options.colors.strokes.outline)).join('')}</g>`
        return `<g data-layer="${g.layer}">${polys}${segs}</g>`
    }).join('\n')

    return [
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${fontFamily}">`,
        svgWebFontDefs(fontFamily),
        `<defs><clipPath id="storey-clip"><rect x="0" y="0" width="${W}" height="${H}"/></clipPath></defs>`,
        `<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff" />`,
        `<g clip-path="url(#storey-clip)">`,
        groupSvg,
        `</g>`,
        // Storey marker is OUTSIDE the storey-clip group so it can never get
        // overdrawn by a stray wall band.  It's the topmost element.
        storeyMarkerSvg,
        `</svg>`,
    ].join('\n')
}

// Plan-view constants — kept in sync with svg-renderer.ts so visual parity holds.
const PLAN_CUT_HEIGHT_METERS = 1.85
const PLAN_SWING_OPEN_RAD = (15 * Math.PI) / 180
const PLAN_OPEN_CHAIN_NEAR_CLOSE_METERS = 0.025
/** Depth crop around the host-wall plane (metres on each side along facing
 * axis).  Legacy uses `planCropMarginMeters = 0.5 m` so perpendicular walls
 * extending into adjacent rooms get trimmed roughly 1 m past the door. */
const PLAN_DEPTH_PAD_METERS = 0.5

interface SectionSegment { a: { x: number; z: number }; b: { x: number; z: number } }

/** Intersect every triangle with the horizontal plane y = cutY and emit one
 * 2D segment (in world XZ) per crossing.  Mirrors legacy
 * `extractMeshSectionSegments`.  Triangles fully on one side are skipped;
 * triangles with two coplanar vertices register the on-plane edge if the
 * third vertex is meaningfully off-plane (≥ 5 mm).  Result is deduped by
 * canonical key. */
function extractMeshSectionSegments(mesh: IfcLiteMesh, cutY: number): SectionSegment[] {
    const triCount = meshTriangleCount(mesh)
    if (triCount === 0) return []
    const segments = new Map<string, SectionSegment>()
    const keyFor = (x: number, z: number) => `${Math.round(x * 10000)}_${Math.round(z * 10000)}`
    const register = (a: { x: number; z: number }, b: { x: number; z: number }) => {
        const ka = keyFor(a.x, a.z)
        const kb = keyFor(b.x, b.z)
        if (ka === kb) return
        const ord = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`
        if (segments.has(ord)) return
        segments.set(ord, { a, b })
    }
    const intersectY = (p: MeshPos, q: MeshPos): { x: number; z: number } => {
        const t = (cutY - p.y) / (q.y - p.y)
        return { x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t }
    }
    for (let t = 0; t < triCount; t++) {
        const v = readMeshTriangle(mesh, t)
        const sides: number[] = v.map((p) => (p.y > cutY + 1e-6 ? 1 : p.y < cutY - 1e-6 ? -1 : 0))
        if (sides.filter((s) => s === 0).length === 2) {
            const offIdx = sides.findIndex((s) => s !== 0)
            if (offIdx >= 0 && Math.abs(v[offIdx].y - cutY) < 0.005) continue
            const onPlane = v.filter((_, i) => sides[i] === 0)
            register({ x: onPlane[0].x, z: onPlane[0].z }, { x: onPlane[1].x, z: onPlane[1].z })
            continue
        }
        if (sides.every((s) => s >= 0) || sides.every((s) => s <= 0)) continue
        const inter: Array<{ x: number; z: number }> = []
        for (let i = 0; i < 3; i++) {
            const curr = v[i], next = v[(i + 1) % 3]
            const sCurr = sides[i], sNext = sides[(i + 1) % 3]
            if (sCurr === 0) { inter.push({ x: curr.x, z: curr.z }); continue }
            if (sCurr !== sNext && sNext !== 0) inter.push(intersectY(curr, next))
        }
        if (inter.length < 2) continue
        register(inter[0], inter[1])
        if (inter.length === 3) register(inter[1], inter[2])
    }
    return [...segments.values()]
}

/** Reconstruct closed loops + open chains from an unordered segment soup
 *  (mirrors legacy `reconstructPolygonsFromSegments`). */
function reconstructPolygons(
    segments: SectionSegment[]
): { closedLoops: Array<{ x: number; z: number }[]>; openChains: Array<{ x: number; z: number }[]> } {
    const closedLoops: Array<{ x: number; z: number }[]> = []
    const openChains: Array<{ x: number; z: number }[]> = []
    if (segments.length === 0) return { closedLoops, openChains }
    const keyFor = (p: { x: number; z: number }) => `${Math.round(p.x * 10000)}_${Math.round(p.z * 10000)}`
    const vertexByKey = new Map<string, number>()
    const vertexPoints: Array<{ x: number; z: number }> = []
    const adjacency: number[][] = []
    const intern = (p: { x: number; z: number }): number => {
        const key = keyFor(p)
        const existing = vertexByKey.get(key)
        if (existing !== undefined) return existing
        const idx = vertexPoints.length
        vertexByKey.set(key, idx)
        vertexPoints.push({ x: p.x, z: p.z })
        adjacency.push([])
        return idx
    }
    interface Edge { a: number; b: number; visited: boolean }
    const edges: Edge[] = []
    for (const seg of segments) {
        const ia = intern(seg.a), ib = intern(seg.b)
        if (ia === ib) continue
        const idx = edges.length
        edges.push({ a: ia, b: ib, visited: false })
        adjacency[ia].push(idx); adjacency[ib].push(idx)
    }
    const otherEnd = (e: Edge, from: number) => (e.a === from ? e.b : e.a)
    for (let i = 0; i < edges.length; i++) {
        if (edges[i].visited) continue
        const start = edges[i]
        let originVertex = start.a
        if (adjacency[start.a].length % 2 === 0 && adjacency[start.b].length % 2 === 1) {
            originVertex = start.b
        }
        const path: number[] = [originVertex]
        let curr = originVertex
        start.visited = true
        curr = otherEnd(start, originVertex)
        path.push(curr)
        let closed = false
        while (true) {
            const cands = adjacency[curr].filter((e) => !edges[e].visited)
            if (cands.length === 0) break
            const next = cands[0]
            edges[next].visited = true
            const nv = otherEnd(edges[next], curr)
            if (nv === originVertex) { closed = true; break }
            path.push(nv)
            curr = nv
            if (path.length > edges.length + 2) break
        }
        const pts = path.map((idx) => ({ ...vertexPoints[idx] }))
        if (closed && pts.length >= 3) closedLoops.push(pts)
        else if (pts.length >= 2) openChains.push(pts)
    }
    return { closedLoops, openChains }
}

/** If an open chain almost returns to its start (mesh gap), close it. */
function tryCloseOpenChain(chain: Array<{ x: number; z: number }>, eps: number): Array<{ x: number; z: number }> | null {
    if (chain.length < 4) return null
    const first = chain[0], last = chain[chain.length - 1]
    const dx = first.x - last.x, dz = first.z - last.z
    if (dx * dx + dz * dz > eps * eps) return null
    const core = chain.slice(0, -1)
    const tinySq = (eps * 0.25) ** 2
    const out: Array<{ x: number; z: number }> = []
    for (const p of core) {
        if (out.length === 0) out.push(p)
        else {
            const prev = out[out.length - 1]
            const ddx = prev.x - p.x, ddz = prev.z - p.z
            if (ddx * ddx + ddz * ddz > tinySq) out.push(p)
        }
    }
    return out.length >= 3 ? out : null
}

interface DoorOperation {
    kind: 'swing' | 'sliding' | 'fixed' | 'none'
    hingeSide: 'left' | 'right' | 'both' | null
}

/** For a door whose bbox includes a sidelight (Flu21 ST.KA.T1 / ST.ZE.T2),
 *  the leaf is one of the door's sub-meshes whose width-axis extent equals
 *  the clear opening (Mass-Durchgangsbreite).  Returns the leaf centre's
 *  offset (in metres along widthAxis) from the bbox centre, or 0 when no
 *  matching sub-mesh is found (single-panel doors). */
function findLeafCentreOffset(
    meshes: IfcLiteMesh[],
    viewFrame: DoorViewFrame,
    clearW: number,
): number {
    if (clearW <= 0.05 || meshes.length === 0) return 0
    const wax = viewFrame.widthAxis[0]
    const waz = viewFrame.widthAxis[2]
    const ox = viewFrame.origin[0]
    const oz = viewFrame.origin[2]
    const tolerance = 0.05  // 5 cm
    const candidates: Array<{ centre: number; ext: number }> = []
    for (const m of meshes) {
        const pos = m.positions
        if (pos.length < 9) continue
        let lo = +Infinity, hi = -Infinity
        for (let v = 0; v < pos.length; v += 3) {
            const proj = (pos[v] - ox) * wax + (pos[v + 2] - oz) * waz
            if (proj < lo) lo = proj
            if (proj > hi) hi = proj
        }
        const ext = hi - lo
        if (Math.abs(ext - clearW) <= tolerance) {
            candidates.push({ centre: (lo + hi) / 2, ext })
        }
    }
    if (candidates.length === 0) return 0
    // Multiple matches (top rail + threshold + transom + leaf-face) typically
    // share the same centre.  Take the median to ride out outliers.
    candidates.sort((a, b) => a.centre - b.centre)
    return candidates[Math.floor(candidates.length / 2)].centre
}

function parseOperationType(op: string | null): DoorOperation {
    if (!op) return { kind: 'none', hingeSide: null }
    const u = op.toUpperCase()
    if (u.includes('SWING_FIXED_LEFT')) return { kind: 'swing', hingeSide: 'left' }
    if (u.includes('SWING_FIXED_RIGHT')) return { kind: 'swing', hingeSide: 'right' }
    if (u.includes('SINGLE_SWING_LEFT')) return { kind: 'swing', hingeSide: 'left' }
    if (u.includes('SINGLE_SWING_RIGHT')) return { kind: 'swing', hingeSide: 'right' }
    if (u.includes('DOUBLE_SWING_LEFT')) return { kind: 'swing', hingeSide: 'left' }
    if (u.includes('DOUBLE_SWING_RIGHT')) return { kind: 'swing', hingeSide: 'right' }
    if (u.includes('DOUBLE_DOOR_SINGLE_SWING') || u.includes('DOUBLE_DOOR_DOUBLE_SWING') || u === 'DOUBLE_SWING') {
        return { kind: 'swing', hingeSide: 'both' }
    }
    if (u.includes('SLIDING')) return { kind: 'sliding', hingeSide: null }
    if (u.includes('FIXED')) return { kind: 'fixed', hingeSide: null }
    if (u.includes('SWING')) return { kind: 'swing', hingeSide: 'right' }
    return { kind: 'none', hingeSide: null }
}

interface PlanCamera {
    /** World→screen for a horizontal point. */
    project(x: number, z: number): { sx: number; sy: number }
    /** Door anchor for centering. */
    cx: number; cz: number
    /** widthAxis (right) and openAxis (-facing → screen-up). */
    widthAxis: { x: number; z: number }
    openAxis: { x: number; z: number }
}

function buildPlanCameraNew(
    ctx: DoorContextLite,
    canvasW: number,
    canvasH: number
): PlanCamera {
    const cx = ctx.viewFrame.origin[0]
    const cz = ctx.viewFrame.origin[2]
    // Camera convention (matches legacy):
    //   • camera.up = -facing  → world direction "−facing" maps to screen UP
    //   • therefore screen DOWN = +facing in world XZ
    //   • openAxis (where swing arc draws) = +facing → swing draws DOWNWARD
    //     on canvas (the room the door opens INTO is at the bottom).
    // Door is anchored near canvas y = 0.30·H so the swing arc has room to
    // sweep down before hitting the canvas bottom.
    const wa = ctx.viewFrame.widthAxis
    const fa = ctx.viewFrame.facing
    const right = { x: wa[0], z: wa[2] }
    const down = { x: fa[0], z: fa[2] }  // screen-down direction in world XZ
    const scale = FIXED_PX_PER_METER
    const offsetX = canvasW / 2
    // Door anchored vertically near canvas centre (slightly above) so the
    // back band, the door cut, and the swing arc all read inside the visible
    // crop with whitespace evenly distributed.  Matches legacy framing.
    const offsetY = canvasH * 0.45
    return {
        project(x: number, z: number) {
            const lx = x - cx, lz = z - cz
            const projRight = right.x * lx + right.z * lz
            const projDown = down.x * lx + down.z * lz
            return { sx: offsetX + projRight * scale, sy: offsetY + projDown * scale }
        },
        cx, cz,
        widthAxis: right,
        openAxis: down,  // +facing = screen-down (swing sweeps downward).
    }
}

function emitPlanSvg(
    ctx: DoorContextLite,
    options: Required<Pick<RenderOptions, 'width' | 'height' | 'lineWidth' | 'colors' | 'doorFootAnchor' | 'emitDebugAttrs'>>,
): string {
    const W = options.width
    const H = options.height
    const cam = buildPlanCameraNew(ctx, W, H)
    // Plan view volume — a 3D AABB derived from door extents, sliced thin
    // in Y at the cut height.  Anything whose bbox INTERSECTS this volume
    // is rendered.  Vertical (Y) slice is tight at cutY so floor/ceiling
    // slabs DON'T appear in plan as grey background — only walls cut at
    // door midheight register.  The screen-Y crop band stays at the
    // legacy 0.5 m pad around the door plane to match the original framing.
    const halfT = ctx.viewFrame.thickness / 2
    const arcReach = halfT + ctx.viewFrame.width * Math.sin(PLAN_SWING_OPEN_RAD)
    const backPadMeters = halfT + PLAN_DEPTH_PAD_METERS
    const frontPadMeters = Math.max(arcReach, halfT + PLAN_DEPTH_PAD_METERS)
    const doorScreenY = cam.project(ctx.viewFrame.origin[0], ctx.viewFrame.origin[2]).sy
    const planClipMinY = Math.max(0, doorScreenY - backPadMeters * FIXED_PX_PER_METER)
    const planClipMaxY = Math.min(H, doorScreenY + frontPadMeters * FIXED_PX_PER_METER)
    // Cut the world at door-bottom + 1.0 m.
    const cutY = ctx.viewFrame.origin[1] + PLAN_CUT_HEIGHT_METERS
    const planMarginX = computeContentMarginX(ctx, W)
    // World-space view volume for plan: a thin Y slab at cutY, covering
    // the same canvas footprint as the legacy clip band.  Walls intersect
    // iff their bbox straddles cutY AND overlaps the canvas footprint.
    // Slabs (floor / ceiling) sit entirely below or above cutY so they
    // never register — keeps the plan free of grey slab background.
    const halfCanvasWMeters = (W / 2) / FIXED_PX_PER_METER
    const isXAlignedDoor = Math.abs(ctx.viewFrame.widthAxis[0]) > Math.abs(ctx.viewFrame.widthAxis[2])
    const planVolume: AABB = {
        min: [
            isXAlignedDoor
                ? ctx.viewFrame.origin[0] - halfCanvasWMeters
                : ctx.viewFrame.origin[0] - frontPadMeters,
            cutY - 0.05,
            isXAlignedDoor
                ? ctx.viewFrame.origin[2] - frontPadMeters
                : ctx.viewFrame.origin[2] - halfCanvasWMeters,
        ],
        max: [
            isXAlignedDoor
                ? ctx.viewFrame.origin[0] + halfCanvasWMeters
                : ctx.viewFrame.origin[0] + frontPadMeters,
            cutY + 0.05,
            isXAlignedDoor
                ? ctx.viewFrame.origin[2] + frontPadMeters
                : ctx.viewFrame.origin[2] + halfCanvasWMeters,
        ],
    }
    const intersectsPlanVolume = (b: AABB): boolean =>
        b.max[1] >= planVolume.min[1]
        && b.min[1] <= planVolume.max[1]
        && b.max[0] >= planVolume.min[0]
        && b.min[0] <= planVolume.max[0]
        && b.max[2] >= planVolume.min[2]
        && b.min[2] <= planVolume.max[2]
    const intersectsPlanFootprint = (b: AABB): boolean =>
        b.max[0] >= planVolume.min[0]
        && b.min[0] <= planVolume.max[0]
        && b.max[2] >= planVolume.min[2]
        && b.min[2] <= planVolume.max[2]
    const colors = options.colors
    const stroke = colors.strokes.outline

    interface PolyOut { points: Pt[]; fill: string; stroke?: boolean; layer: number }
    interface SegOut { x1: number; y1: number; x2: number; y2: number; layer: number; dashed?: boolean; color?: string }
    const polys: PolyOut[] = []
    const segs: SegOut[] = []

    // 2D Liang-Barsky clip + Sutherland-Hodgman happen at SVG render time —
    // here we just project and emit.
    const projP = (p: { x: number; z: number }): Pt => {
        const s = cam.project(p.x, p.z)
        return { x: s.sx, y: s.sy }
    }

    /** Section a single mesh group (host wall, nearby wall, door, etc.) and
     *  emit closed polygon fills + open-chain stroke edges.  `layer` controls
     *  draw order; `fill` is the polygon colour.  Returns section stats so
     *  callers can decide whether they still need a bbox fallback fill. */
    const sectionGroup = (meshes: IfcLiteMesh[], fill: string, layer: number) => {
        const all: SectionSegment[] = []
        for (const m of meshes) all.push(...extractMeshSectionSegments(m, cutY))
        if (all.length === 0) {
            return { hasAnySegments: false, hasClosedLoops: false }
        }
        const { closedLoops, openChains } = reconstructPolygons(all)
        const closedExtra: Array<Array<{ x: number; z: number }>> = []
        const remainingOpen: Array<Array<{ x: number; z: number }>> = []
        for (const chain of openChains) {
            const closed = tryCloseOpenChain(chain, PLAN_OPEN_CHAIN_NEAR_CLOSE_METERS)
            if (closed) closedExtra.push(closed)
            else remainingOpen.push(chain)
        }
        const closedAll = [...closedLoops, ...closedExtra]
        for (const loop of closedAll) {
            polys.push({ points: loop.map(projP), fill, stroke: true, layer })
        }
        // Open chains: outline only (non-watertight wall stubs).
        for (const chain of remainingOpen) {
            for (let i = 0; i + 1 < chain.length; i++) {
                const a = projP(chain[i]); const b = projP(chain[i + 1])
                segs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, layer })
            }
        }
        return { hasAnySegments: true, hasClosedLoops: closedAll.length > 0 }
    }

    // Wall colour resolution mirrors elevation logic.
    const wallFillFor = (cfcBkp: string | null): string =>
        resolveWallCutColor(cfcBkp, colors)

    // Host wall (cut + filled).  Mesh-section alone often produces only an
    // open chain along the front / back wall faces because the door opening
    // breaks the loop — that's why some doors used to render the host wall
    // as a single horizontal line with no fill and no jamb edges.  Render two
    // bbox-rects flanking the door opening as a guaranteed fill, then overlay
    // the mesh-section for any extra detail.  The flanking rects' inner
    // edges naturally provide the vertical jamb lines closing the wall shape
    // at the door opening.
    if (ctx.hostWall) {
        const hwbb = ctx.hostWall.bbox
        if (hwbb.min[1] <= cutY && hwbb.max[1] >= cutY) {
            const dbb = ctx.door.bbox
            // Host wall uses neutral plan.wallCut, NEVER the door's BKP — the
            // door leaf and the wall must read as different elements.  The
            // wall's own BKP is not surfaced by the analyzer (would need a
            // per-wall pset read); using neutral here is the architecturally
            // correct default since wall fills in plan are about cut hatching,
            // not material classification.
            const fillC = wallFillFor(null)
            const wallAlongX = Math.abs(ctx.viewFrame.widthAxis[0]) > Math.abs(ctx.viewFrame.widthAxis[2])
            // Carve adjacent doors / windows that sit IN the host wall out of
            // the flanking rect along the wall's length axis.  Without this,
            // the host-wall fill paints over an adjacent opening's section
            // and the plan reads as a solid wall where there's actually
            // another door — exactly the bug user flagged on 0V8JTrpT, where
            // the right flank covered the adjacent door at midheight.
            const lengthAxis: 0 | 2 = wallAlongX ? 0 : 2
            const thickAxis: 0 | 2 = wallAlongX ? 2 : 0
            const subtractOpenings = (start: number, end: number): Array<[number, number]> => {
                let segs: Array<[number, number]> = [[start, end]]
                const isInHostWall = (b: AABB): boolean => {
                    // Adjacent must straddle the cut height AND overlap the
                    // host wall's thickness range (i.e. sit IN the wall).
                    if (b.max[1] < cutY - 0.05 || b.min[1] > cutY + 0.05) return false
                    const tMin = b.min[thickAxis], tMax = b.max[thickAxis]
                    const hMin = hwbb.min[thickAxis], hMax = hwbb.max[thickAxis]
                    return tMax >= hMin - 0.05 && tMin <= hMax + 0.05
                }
                const carve = (b: AABB) => {
                    if (!isInHostWall(b)) return
                    const aMin = b.min[lengthAxis]
                    const aMax = b.max[lengthAxis]
                    const next: Array<[number, number]> = []
                    for (const [s, e] of segs) {
                        if (aMax <= s || aMin >= e) { next.push([s, e]); continue }
                        if (aMin > s) next.push([s, aMin])
                        if (aMax < e) next.push([aMax, e])
                    }
                    segs = next
                }
                for (const d of ctx.nearbyDoors) carve(d.bbox)
                for (const w of ctx.nearbyWindows) carve(w.bbox)
                return segs.filter(([s, e]) => e - s > 0.001)
            }
            const emitFlank = (lengthRange: [number, number]) => {
                const [s, e] = lengthRange
                const r: Pt[] = wallAlongX
                    ? [
                        { x: s, z: hwbb.min[2] },
                        { x: e, z: hwbb.min[2] },
                        { x: e, z: hwbb.max[2] },
                        { x: s, z: hwbb.max[2] },
                      ].map((p) => projP(p))
                    : [
                        { x: hwbb.min[0], z: s },
                        { x: hwbb.max[0], z: s },
                        { x: hwbb.max[0], z: e },
                        { x: hwbb.min[0], z: e },
                      ].map((p) => projP(p))
                polys.push({ points: r, fill: fillC, stroke: true, layer: 1 })
            }
            const dMin = dbb.min[lengthAxis]
            const dMax = dbb.max[lengthAxis]
            const hMin = hwbb.min[lengthAxis]
            const hMax = hwbb.max[lengthAxis]
            if (dMin > hMin + 0.001) {
                for (const seg of subtractOpenings(hMin, dMin)) emitFlank(seg)
            }
            if (dMax < hMax - 0.001) {
                for (const seg of subtractOpenings(dMax, hMax)) emitFlank(seg)
            }
        }
        sectionGroup(ctx.hostWall.meshes, wallFillFor(null), 1)
    }
    // Nearby walls (perpendicular, T-junction returns). Prefer real section
    // geometry and only fall back to bbox fill when section extraction yields
    // open chains but no closed loops (sparse/non-watertight mesh). Avoid bbox
    // fallback when there is no section at all — that case caused grey blobs in
    // door/window openings under overhead wall/lintel geometry.
    for (const w of ctx.nearbyWalls) {
        if (!intersectsPlanVolume(w.bbox)) continue
        const section = sectionGroup(w.meshes, wallFillFor(null), 1)
        if (section.hasClosedLoops) continue
        if (!section.hasAnySegments) continue
        const wbb = w.bbox
        const rectPts: Pt[] = [
            { x: wbb.min[0], z: wbb.min[2] },
            { x: wbb.max[0], z: wbb.min[2] },
            { x: wbb.max[0], z: wbb.max[2] },
            { x: wbb.min[0], z: wbb.max[2] },
        ].map((p) => projP(p))
        polys.push({ points: rectPts, fill: wallFillFor(null), stroke: true, layer: 1 })
    }
    // Nearby doors (faded so the focal door reads).  Project every triangle
    // top-down (real mesh, ignoring Y) so the door's full footprint —
    // including any frame/threshold geometry below the cut — reads in plan.
    // Sectioning at cutY alone catches only the panel/glass plane (a thin
    // line); projecting the full mesh from above captures the lower frame
    // width whenever the IFC actually contains it, and degenerates to just
    // the leaf rectangle when it doesn't.  Section overlay then draws the
    // sharper cut-line on top.  Boundary/sharp mesh edges projected as plan
    // segments give the silhouette outline (real geometry — no synthesised
    // bbox-rect).
    for (const d of ctx.nearbyDoors) {
        if (!intersectsPlanVolume(d.bbox)) continue
        const nearbyPlanFill = resolvePlanNearbyDoorColor(d.cfcBkp, colors)
        for (const m of d.meshes) {
            const triCount = meshTriangleCount(m)
            for (let t = 0; t < triCount; t++) {
                const [p1, p2, p3] = readMeshTriangle(m, t)
                const a = cam.project(p1.x, p1.z)
                const b = cam.project(p2.x, p2.z)
                const c = cam.project(p3.x, p3.z)
                const area2 = (b.sx - a.sx) * (c.sy - a.sy) - (c.sx - a.sx) * (b.sy - a.sy)
                if (Math.abs(area2) < 0.5) continue
                polys.push({
                    points: [{ x: a.sx, y: a.sy }, { x: b.sx, y: b.sy }, { x: c.sx, y: c.sy }],
                    fill: nearbyPlanFill,
                    stroke: false,
                    layer: 2,
                })
            }
            // Outline: project boundary/sharp mesh edges to plan.  Vertical
            // edges (panel sides) collapse to points and are filtered out;
            // top/bottom face edges project as the door's outer rectangle.
            for (const { a, b } of extractMeshEdges(m)) {
                const sa = cam.project(a.x, a.z)
                const sb = cam.project(b.x, b.z)
                const dx = sb.sx - sa.sx
                const dy = sb.sy - sa.sy
                if (dx * dx + dy * dy < 0.25) continue  // <0.5 px = degenerate
                segs.push({ x1: sa.sx, y1: sa.sy, x2: sb.sx, y2: sb.sy, layer: 2 })
            }
        }
        sectionGroup(d.meshes, nearbyPlanFill, 3)
    }
    // Nearby windows — section in the wall context colour, never blue.
    for (const w of ctx.nearbyWindows) {
        if (!intersectsPlanVolume(w.bbox)) continue
        sectionGroup(w.meshes, colors.plan.wallCut, 4)
    }
    // Focal door section.  Always emit a bbox-rect first as the BKP-coloured
    // backdrop so the leaf reads even for glass doors (whose leaf mesh is too
    // thin to register a section line).  Then mesh-cut for sharper edges.
    {
        const bkpCat = classifyDoorBKP(ctx.cset.cfcBkp)
        const leafColor = bkpCat === 'wood'
            ? colors.elevation.door.byBKP.wood
            : (bkpCat === 'metal'
                ? colors.elevation.door.byBKP.metal
                : colors.elevation.door.default)
        const dbb = ctx.door.bbox
        const rectPts: Pt[] = [
            { x: dbb.min[0], z: dbb.min[2] },
            { x: dbb.max[0], z: dbb.min[2] },
            { x: dbb.max[0], z: dbb.max[2] },
            { x: dbb.min[0], z: dbb.max[2] },
        ].map((p) => projP(p))
        polys.push({ points: rectPts, fill: leafColor, stroke: true, layer: 5 })
        // Mesh section overlays sharper boundaries on top.
        sectionGroup(ctx.door.meshes, leafColor, 6)
    }

    // Nearby electrical/safety devices as a top projection between door bottom
    // and cut plane (not just "cut = show").
    for (const dev of ctx.nearbyDevices) {
        if (!intersectsPlanFootprint(dev.bbox)) continue
        if (dev.bbox.max[1] < ctx.viewFrame.origin[1]) continue
        if (dev.bbox.min[1] > cutY) continue
        const safety = isSafetyDevice(dev.name, null, colors)
        const fill = safety ? colors.plan.safety : colors.plan.electrical
        const dbb = dev.bbox
        const rectPts: Pt[] = [
            { x: dbb.min[0], z: dbb.min[2] },
            { x: dbb.max[0], z: dbb.min[2] },
            { x: dbb.max[0], z: dbb.max[2] },
            { x: dbb.min[0], z: dbb.max[2] },
        ].map((p) => projP(p))
        polys.push({ points: rectPts, fill, stroke: true, layer: safety ? 8 : 7 })
    }

    // Door swing arc — 15° symbolic opening (NOT a 90° arc).
    //
    // The arc must run from the HINGE JAMB to the OPPOSITE JAMB (clear-opening
    // span), NOT corner-to-corner on the door's bbox.  The bbox includes the
    // frame on both sides, so corner-to-corner produced an arc that landed
    // outside the door frame in the next room.
    //
    // Clear width preference order:
    //   1. Cset_StandardCH:Mass_Durchgangsbreite  (authored clear width)
    //   2. viewFrame.width − 0.10 m              (assume 5 cm jambs each side)
    {
        const op = parseOperationType(ctx.operationType)
        const upperOp = ctx.operationType?.toUpperCase() ?? ''
        const isSideFixedOp = upperOp.includes('SWING_FIXED_LEFT') || upperOp.includes('SWING_FIXED_RIGHT')
        const widthAxisPlan = ctx.viewFrame.widthAxis
        const widthIsZAligned = Math.abs(widthAxisPlan[2]) >= Math.abs(widthAxisPlan[0])
        if (process.env.DEBUG_PLAN === '1') {
            console.log(`[plan ${ctx.guid}] op=${ctx.operationType} parsed=${JSON.stringify(op)} frameW=${ctx.viewFrame.width.toFixed(2)} clearW=${ctx.cset.massDurchgangsbreite}`)
        }
        if (op.kind === 'swing' && op.hingeSide) {
            // IFC4 LEFT/RIGHT is "as viewed in +localY". When the renderer's
            // bbox-derived facing points OPPOSITE to IFC's localY, the
            // observer's left/right flip and we have to mirror hingeSide so
            // the rendered hinge lands on the correct jamb.
            //
            // Comparison is in the IFC's horizontal plane: renderer's facing
            // (in Y-up world's XZ plane) maps to IFC's XY plane via the
            // ifc-lite axis swap (renderer +Z ↔ IFC +Y). So we test the dot
            // product of (placementYAxis.x, placementYAxis.y) against
            // (facing.x, facing.z) — negative means 180° flip.
            const py = ctx.placementYAxis
            const facing = ctx.viewFrame.facing
            let effectiveHingeSide = op.hingeSide
            const dotCurrent = py ? py[0] * facing[0] + py[1] * facing[2] : null
            const widthAxis2 = cam.widthAxis     // {x,z} along door width
            let facingDotPlacement: number | null = null
            let shouldSwapHinge: boolean | null = null
            if (op.hingeSide !== 'both' && py) {
                facingDotPlacement = py[0] * facing[0] + py[1] * facing[2]
                shouldSwapHinge = widthIsZAligned
                    ? facingDotPlacement > 0
                    : facingDotPlacement < 0
                if (shouldSwapHinge) {
                    effectiveHingeSide = op.hingeSide === 'left' ? 'right' : 'left'
                }
            }
            // Base rule: sweep sign follows the door-width orientation family.
            // - width mainly on X: use legacy sign (dot>0 => upward in screen)
            // - width mainly on Z: inverted sign (dot>0 => downward in screen)
            // This stabilizes all tested doors without per-operation overrides.
            const sweepSign = dotCurrent != null
                ? (widthIsZAligned ? (dotCurrent > 0 ? 1 : -1) : (dotCurrent > 0 ? -1 : 1))
                : 1
            const openAxis2 = cam.openAxis       // +facing → screen-down (room arc opens into)
            const frameW = ctx.viewFrame.width
            const clearW = (ctx.cset.massDurchgangsbreite != null && ctx.cset.massDurchgangsbreite > 0.05)
                ? ctx.cset.massDurchgangsbreite
                : Math.max(frameW - 0.10, 0.6)
            const jambInset = Math.max((frameW - clearW) / 2, 0)  // half the frame thickness on each side
            const faceOffset = ctx.viewFrame.thickness / 2
            const drawLeaf = (hingeSide: 'left' | 'right', leafW: number, hingeOff: number) => {
                // Hinge in world (XZ): door centre + widthAxis * hingeOff.
                // hingeOff = ±(halfFrame - jambInset) so hinge sits at the
                // INSIDE EDGE of the jamb, not at the bbox corner.
                const hingeX = ctx.viewFrame.origin[0] + widthAxis2.x * hingeOff
                const hingeZ = ctx.viewFrame.origin[2] + widthAxis2.z * hingeOff
                // Pivot offset along openAxis (door face), faceOffset ahead of wall plane.
                const faceOffsetSigned = faceOffset * (sweepSign < 0 ? -1 : 1)
                const pivotX = hingeX + openAxis2.x * faceOffsetSigned
                const pivotZ = hingeZ + openAxis2.z * faceOffsetSigned
                const startAngle = hingeSide === 'left' ? 0 : Math.PI
                const endAngle = hingeSide === 'left' ? PLAN_SWING_OPEN_RAD : Math.PI - PLAN_SWING_OPEN_RAD
                const N = 24
                let prevS: Pt | null = null
                for (let i = 0; i <= N; i++) {
                    const t = i / N
                    const ang = startAngle + (endAngle - startAngle) * t
                    const sinTerm = Math.sin(ang) * sweepSign
                    const dirX = widthAxis2.x * Math.cos(ang) + openAxis2.x * sinTerm
                    const dirZ = widthAxis2.z * Math.cos(ang) + openAxis2.z * sinTerm
                    const px = pivotX + dirX * leafW
                    const pz = pivotZ + dirZ * leafW
                    const arcPt = projP({ x: px, z: pz })
                    if (prevS) {
                        segs.push({ x1: prevS.x, y1: prevS.y, x2: arcPt.x, y2: arcPt.y, layer: 7, color: '#666666' })
                    }
                    prevS = arcPt
                }
                // Leaf line: pivot → arc tip at 15° open position.
                const tipAng = endAngle
                const tipSin = Math.sin(tipAng) * sweepSign
                const tipDirX = widthAxis2.x * Math.cos(tipAng) + openAxis2.x * tipSin
                const tipDirZ = widthAxis2.z * Math.cos(tipAng) + openAxis2.z * tipSin
                const tipX = pivotX + tipDirX * leafW
                const tipZ = pivotZ + tipDirZ * leafW
                const hingeS = projP({ x: pivotX, z: pivotZ })
                const tipS = projP({ x: tipX, z: tipZ })
                segs.push({ x1: hingeS.x, y1: hingeS.y, x2: tipS.x, y2: tipS.y, layer: 7, color: '#666666' })
            }
            const halfClear = clearW / 2
            // Find the LEAF position within the door bbox.  For a
            // door+sidelight assembly the bbox spans BOTH panels (e.g. 2.0 m
            // bbox = 1.25 m leaf + 0.75 m sidelight + jambs), so the bbox
            // centre is NOT the leaf centre and the swing arc lands inside
            // the sidelight glass.  Walk the door's sub-meshes for one whose
            // width-axis extent ≈ clearW (Mass-Durchgangsbreite); its centre
            // is the actual leaf centre.  Falls back to bbox centre when no
            // matching sub-mesh exists (simple symmetric doors).
            const leafCentreOffset = findLeafCentreOffset(ctx.door.meshes, ctx.viewFrame, clearW)
            if (
                (upperOp.includes('SWING_FIXED_LEFT') || upperOp.includes('SWING_FIXED_RIGHT'))
                && effectiveHingeSide !== 'both'
                && Math.abs(leafCentreOffset) > Math.max(clearW * 0.05, 0.05)
            ) {
                // Side-fixed doors: if mesh-derived operable leaf center is clearly
                // off-center, trust geometry for hinge side (prevents wrong-side guide
                // when OperationType label and real leaf placement disagree).
                const inferredFromLeafCenter: 'left' | 'right' = leafCentreOffset < 0 ? 'left' : 'right'
                if (effectiveHingeSide !== inferredFromLeafCenter) {
                    effectiveHingeSide = inferredFromLeafCenter
                }
            }
            if (effectiveHingeSide === 'both') {
                drawLeaf('left', halfClear, leafCentreOffset - halfClear)
                drawLeaf('right', halfClear, leafCentreOffset + halfClear)
            } else {
                const hingeOff = leafCentreOffset + (effectiveHingeSide === 'left' ? -halfClear : +halfClear)
                drawLeaf(effectiveHingeSide, clearW, hingeOff)
            }
        }
    }

    // Sort and emit.
    polys.sort((a, b) => a.layer - b.layer)
    segs.sort((a, b) => a.layer - b.layer)

    const polySvg = polys.map((p) => {
        const pts = p.points.map((pt) => `${pt.x.toFixed(2)},${pt.y.toFixed(2)}`).join(' ')
        const strokePart = p.stroke ? ` stroke="${stroke}" stroke-width="${options.lineWidth.toFixed(2)}"` : ''
        return `<polygon points="${pts}" fill="${p.fill}"${strokePart} />`
    }).join('')

    const segSvg = segs.map((s) => {
        const c = s.color || stroke
        const dash = s.dashed ? ' stroke-dasharray="6 4"' : ''
        return `<line x1="${s.x1.toFixed(2)}" y1="${s.y1.toFixed(2)}" x2="${s.x2.toFixed(2)}" y2="${s.y2.toFixed(2)}" stroke="${c}" stroke-width="${options.lineWidth.toFixed(2)}"${dash} />`
    }).join('')

    // SVG clipPath enforces the depth crop at render time — anything drawn
    // outside the [planClipMinY, planClipMaxY] band gets cut off, matching
    // the legacy plan crop where perpendicular walls vanish past ~1 m.
    return [
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${DEFAULT_SVG_FONT_FAMILY}">`,
        svgWebFontDefs(DEFAULT_SVG_FONT_FAMILY),
        `<defs><clipPath id="plan-clip"><rect x="${planMarginX.toFixed(2)}" y="${planClipMinY.toFixed(2)}" width="${(W - 2 * planMarginX).toFixed(2)}" height="${(planClipMaxY - planClipMinY).toFixed(2)}"/></clipPath></defs>`,
        `<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff" />`,
        `<g clip-path="url(#plan-clip)" stroke-linejoin="round" stroke-linecap="round">`,
        polySvg,
        segSvg,
        `</g>`,
        `</svg>`,
    ].join('\n')
}

export function renderDoorViewsLite(
    ctx: DoorContextLite,
    options: RenderOptions = {}
): { front: string; back: string; plan: string } {
    const opts = { ...DEFAULT_OPTS, ...options }
    // Plan view keeps the 1:1 aspect (1000×1000) so the depth crop has
    // room above + below the door anchor.  Elevation uses the same square
    // canvas — 3.5 m of storey content fits inside (≈ 997 px at 285 px/m)
    // and the rasteriser upscales the SVG to 1400 px wide PNG (legacy zoom).
    const planOpts = { ...opts, height: opts.width }
    return {
        front: emitElevationSvg(ctx, 'front', opts),
        back: emitElevationSvg(ctx, 'back', opts),
        plan: emitPlanSvg(ctx, planOpts),
    }
}
