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
import { appendFileSync } from 'node:fs'
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

function debugLog(
    runId: string,
    hypothesisId: string,
    location: string,
    message: string,
    data: Record<string, unknown>
): void {
    const payload = {
        sessionId: '0a5c96',
        runId,
        hypothesisId,
        location,
        message,
        data,
        timestamp: Date.now(),
    }
    // #region agent log
    fetch('http://127.0.0.1:7398/ingest/5834f702-43d3-4b33-b0b3-25930b74e01f',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'0a5c96'},body:JSON.stringify(payload)}).catch(()=>{});
    // #endregion
    try {
        appendFileSync('debug-0a5c96.log', `${JSON.stringify(payload)}\n`, 'utf8')
    } catch {
        // swallow debug logging errors
    }
}

export const FIXED_PX_PER_METER = 285
export const CANVAS_PX = 1000

// Legacy renderer constants — kept identical so visual parity holds.
const STRUCTURAL_SLAB_INTRUSION_METERS = 0.10  // 10 cm into slab top/bottom face
const STOREY_CONTENT_HEIGHT_METERS = 3.5       // hard cap on visible vertical span

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
    height: CANVAS_PX,
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
        return { fill: colors.elevation.glass, fillOpacity: 0.32, layer: 4, role: 'window' }
    }
    if (ctx.nearbyDoors.some((d) => d.expressId === id)) {
        return { fill: elevationView ? colors.elevation.door.default : colors.plan.doorContext, fillOpacity: 0.5, layer: 3, role: 'nearby-door' }
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
): ProjectedSegment[] {
    const edges = extractMeshEdges(mesh)
    const out: ProjectedSegment[] = []
    const minY = canvasMinY ?? -4
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
            const clipped = clipLine2D(x1, y1, x2, y2, -4, minY, canvasW + 4, canvasH + 4)
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
    const structAboveDy = getStructuralSlabFaceDy(ctx, 'above')
    const structBelowDy = getStructuralSlabFaceDy(ctx, 'below')
    const bottomDy = structBelowDy != null
        ? structBelowDy - STRUCTURAL_SLAB_INTRUSION_METERS
        : -STRUCTURAL_SLAB_INTRUSION_METERS
    const topCapDy = bottomDy + STOREY_CONTENT_HEIGHT_METERS
    const topDy = structAboveDy != null
        ? Math.min(structAboveDy + STRUCTURAL_SLAB_INTRUSION_METERS, topCapDy)
        : topCapDy
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
    const elevationClip: WorldClip = {
        yMin: viewportBottomY - 0.02,
        yMax: viewportTopY + 0.02,
    }
    if (Math.abs(ctx.viewFrame.widthAxis[0]) > Math.abs(ctx.viewFrame.widthAxis[2])) {
        elevationClip.xMin = ctx.viewFrame.origin[0] - halfCanvasMeters - 0.1
        elevationClip.xMax = ctx.viewFrame.origin[0] + halfCanvasMeters + 0.1
    } else {
        elevationClip.zMin = ctx.viewFrame.origin[2] - halfCanvasMeters - 0.1
        elevationClip.zMax = ctx.viewFrame.origin[2] + halfCanvasMeters + 0.1
    }

    // Pixel rect for Sutherland-Hodgman polygon clipping. Top is the world
    // viewport top, projected to screen — anything above gets cut.  Bottom
    // stays on the canvas edge so a slab-below band reads to the very edge.
    const yScreenAt = (yWorld: number) => cam.scaleY * yWorld + cam.offsetY
    const screenTopWorld = yScreenAt(viewportTopY)
    const pixelClip: PixelClipRect = {
        minX: 0,
        minY: Math.max(0, Math.min(H, screenTopWorld)),
        maxX: W,
        maxY: H,
    }

    interface Group {
        layer: number
        polygons: ProjectedPolygon[]
        segments: ProjectedSegment[]
    }
    const groups: Group[] = []

    // Background wall band: full canvas (independent of storey clip).  The
    // legacy renderer paints the canvas with wall colour and then layers
    // door/slab/devices on top.  Without this our renders show white where
    // the storey content is shorter than 3.5 m, but legacy never does.
    groups.push({
        layer: 0,
        polygons: [{
            points: [
                { x: 0, y: 0 }, { x: W, y: 0 },
                { x: W, y: H }, { x: 0, y: H },
            ],
            fill: options.colors.elevation.wall,
            depth: 0,
            layer: 0,
        }],
        segments: [],
    })

    if (ctx.hostWall) {
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
    // bbox centre helper (defined locally to avoid an analyzer import).
    const bboxCenter = (b: AABB): [number, number, number] => [
        (b.min[0] + b.max[0]) / 2,
        (b.min[1] + b.max[1]) / 2,
        (b.min[2] + b.max[2]) / 2,
    ]
    // Hide nearby walls that sit behind the host wall in this elevation: the
    // host wall blocks the camera's view of anything on the opposite side, so
    // perpendicular walls / room returns in the far room must NOT render here.
    //
    //   front view: camera at +facing → wall is visible if its centre lies on
    //               the +facing side of the host-wall mid-plane (or in-plane).
    //   back view : opposite.
    //
    // Tolerance: a 5 cm dead-band around the host plane keeps walls that
    // straddle the plane (pass-through partitions, stub returns coplanar
    // with the host) visible in BOTH views.
    const facing = ctx.viewFrame.facing
    const projectFacing = (p: [number, number, number]) => p[0] * facing[0] + p[2] * facing[2]
    const hostPlaneFacing = ctx.hostWall
        ? projectFacing(bboxCenter(ctx.hostWall.bbox))
        : projectFacing(ctx.viewFrame.origin)
    const cameraSign = side === 'front' ? 1 : -1
    const isWallVisibleInElevation = (bbox: AABB): boolean => {
        const c = bboxCenter(bbox)
        const delta = projectFacing(c) - hostPlaneFacing
        // delta >  0 → wall is on +facing side
        // delta <  0 → wall is on -facing side
        // We keep walls on the camera side OR in the host plane.
        return delta * cameraSign > -0.05
    }
    for (const w of ctx.nearbyWalls) {
        if (!isWallVisibleInElevation(w.bbox)) continue
        const wbb: AABB = {
            min: [w.bbox.min[0], Math.max(w.bbox.min[1], viewportBottomY), w.bbox.min[2]],
            max: [w.bbox.max[0], Math.min(w.bbox.max[1], viewportTopY), w.bbox.max[2]],
        }
        const rect = projectBoxToElevationRect(wbb, cam, pixelClip)
        if (rect && rect.length >= 3) {
            groups.push({
                layer: 1,
                polygons: [{ points: rect, fill: options.colors.elevation.wall, depth: 0, layer: 1, expressId: w.expressId }],
                segments: [],
            })
        }
    }
    // Horizontal band rendering: a full-canvas-width strip clipped to the
    // [yMinWorld, yMaxWorld] range, painted with `fill` at the given layer,
    // with thin top/bottom strokes for the architectural-style stripe look.
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
            { x: 0, y: yMin }, { x: W, y: yMin },
            { x: W, y: yMax }, { x: 0, y: yMax },
        ]
        const segments: ProjectedSegment[] = addStrokes
            ? [
                { x1: 0, y1: yMin, x2: W, y2: yMin, color: options.colors.strokes.outline, depth: 0, layer, width: options.lineWidth },
                { x1: 0, y1: yMax, x2: W, y2: yMax, color: options.colors.strokes.outline, depth: 0, layer, width: options.lineWidth },
            ]
            : []
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
        const slabBandTopY = ctx.slabBelow
            ? ctx.slabBelow.bbox.max[1]
            : doorBottom
        drawHorizontalBand(viewportBottomY, slabBandTopY, options.colors.elevation.wall, 2, slabBelowExpressId, true)
        // Unterlagsboden / build-up parts above the structural slab.
        if (ctx.slabBelow) {
            const parts = [...ctx.slabBelowParts].sort((a, b) => a.bbox.min[1] - b.bbox.min[1])
            for (const part of parts) {
                const yLo = Math.max(part.bbox.min[1], slabBandTopY)
                const yHi = Math.min(part.bbox.max[1], viewportTopY)
                if (yHi - yLo < 0.005) continue
                drawHorizontalBand(yLo, yHi, options.colors.elevation.wall, 2, part.expressId, true)
            }
        }
    }
    // ── Top 10 cm structural slab cap (slabAbove) ───────────────────────────
    // Same idea: always paint a 10 cm band at the storey-top reference.
    // Falls back to viewportTopY when slabAbove is missing, so we never have
    // an empty top edge for storeys without a detected ceiling slab.
    {
        const slabAboveExpressId = ctx.slabAbove?.expressId ?? -1
        const slabBandBotY = ctx.slabAbove
            ? ctx.slabAbove.bbox.min[1]
            : viewportTopY - STRUCTURAL_SLAB_INTRUSION_METERS
        drawHorizontalBand(slabBandBotY, viewportTopY, options.colors.elevation.wall, 2, slabAboveExpressId, true)
        if (ctx.slabAbove) {
            const parts = [...ctx.slabAboveParts].sort((a, b) => b.bbox.max[1] - a.bbox.max[1])
            for (const part of parts) {
                const yHi = Math.min(part.bbox.max[1], slabBandBotY)
                const yLo = Math.max(part.bbox.min[1], viewportBottomY)
                if (yHi - yLo < 0.005) continue
                drawHorizontalBand(yLo, yHi, options.colors.elevation.wall, 2, part.expressId, true)
            }
        }
    }

    // Triangulated mesh path for the door, nearby doors/windows, and devices.
    // These need triangle-level fills because they have meaningful interior
    // detail (panels, glazing, frames, hardware).
    const meshes = elevationMeshSet(ctx)
    for (const { mesh, expressId } of meshes) {
        const cls = classifyMesh(mesh, ctx, true, options.colors)
        const polys = projectMeshFill(mesh, cam, cls, expressId, elevationClip, pixelClip)
        const segs = projectMeshSegments(mesh, cam, options.colors.strokes.outline, cls.layer, options.lineWidth, elevationClip, W, H, pixelClip.minY)
        if (polys.length === 0 && segs.length === 0) continue
        groups.push({ layer: cls.layer, polygons: polys, segments: segs })
    }
    groups.sort((a, b) => a.layer - b.layer)

    // Storey marker (▼ + label) at the storey-elevation reference Y, in the
    // right-side margin.  Mirrors legacy `renderStoreyMarkerSvg`:
    //   - filled black ▼ triangle pointing AT the slab top (the floor line)
    //   - storey CODE (first whitespace-separated token of the long name)
    //     placed ABOVE the triangle, right-anchored
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
            `<text x="${markerX.toFixed(2)}" y="${labelY.toFixed(2)}" text-anchor="end" font-family="${fontFamily}" font-size="${labelFont}" font-weight="600" fill="#000">${escaped}</text>`,
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
const PLAN_CUT_HEIGHT_METERS = 1.0
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

function shouldMirrorSwingForHandedness(ctx: DoorContextLite): boolean {
    const py = ctx.placementYAxis
    if (!py) return false
    const px = py[0], pz = py[2]
    const plen = Math.hypot(px, pz)
    if (plen < 1e-8) return false
    const fx = ctx.viewFrame.facing[0], fz = ctx.viewFrame.facing[2]
    const flen = Math.hypot(fx, fz)
    if (flen < 1e-8) return false
    // Same invariant as legacy renderer:
    // mirror when placementYAxis · semanticFacing > 0.
    return (px / plen) * (fx / flen) + (pz / plen) * (fz / flen) > 0
}

function shouldFlipPlanArc(ctx: DoorContextLite): boolean {
    const op = (ctx.operationType ?? '').toUpperCase()
    if (op.includes('REVERSE') || op.includes('OPPOSITE')) return true
    const py = ctx.placementYAxis
    if (!py) return false
    const px = py[0], pz = py[2]
    const plen = Math.hypot(px, pz)
    if (plen < 1e-8) return false
    const fx = ctx.viewFrame.facing[0], fz = ctx.viewFrame.facing[2]
    const flen = Math.hypot(fx, fz)
    if (flen < 1e-8) return false
    // Legacy parity: flip when placementYAxis opposes semantic facing.
    return (px / plen) * (fx / flen) + (pz / plen) * (fz / flen) < 0
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

function detectLeafCenterFromDoorMeshes(
    ctx: DoorContextLite,
    cutY: number,
    clearWidth: number
): { centerOffset: number; width: number } | null {
    const all: SectionSegment[] = []
    for (const m of ctx.door.meshes) all.push(...extractMeshSectionSegments(m, cutY))
    if (all.length === 0) return null
    const { closedLoops, openChains } = reconstructPolygons(all)
    const closedExtra: Array<Array<{ x: number; z: number }>> = []
    for (const chain of openChains) {
        const closed = tryCloseOpenChain(chain, PLAN_OPEN_CHAIN_NEAR_CLOSE_METERS)
        if (closed) closedExtra.push(closed)
    }
    const loops = [...closedLoops, ...closedExtra]
    const rawOpen = openChains.filter((chain) => !tryCloseOpenChain(chain, PLAN_OPEN_CHAIN_NEAR_CLOSE_METERS))
    const wa = ctx.viewFrame.widthAxis
    const originWidth = ctx.viewFrame.origin[0] * wa[0] + ctx.viewFrame.origin[2] * wa[2]
    const candidates: Array<{ centerOffset: number; width: number; score: number }> = []

    const pushCandidate = (pts: Array<{ x: number; z: number }>, minPts: number) => {
        if (pts.length < minPts) return
        let minA = +Infinity, maxA = -Infinity
        for (const p of pts) {
            const a = p.x * wa[0] + p.z * wa[2] - originWidth
            if (a < minA) minA = a
            if (a > maxA) maxA = a
        }
        if (!isFinite(minA) || !isFinite(maxA)) return
        const width = maxA - minA
        if (width < 0.08) return
        const centerOffset = (minA + maxA) / 2
        const score = Math.abs(width - clearWidth)
        candidates.push({ centerOffset, width, score })
    }
    for (const loop of loops) pushCandidate(loop, 3)
    // Many real-world leaf cuts are open chains (non-watertight triangulation).
    // Use them as candidates too so we still anchor to leaf edges.
    for (const chain of rawOpen) pushCandidate(chain, 2)
    // Last resort: per-segment candidates from the raw section soup.
    for (const seg of all) pushCandidate([seg.a, seg.b], 2)
    if (candidates.length === 0) return null
    candidates.sort((a, b) => a.score - b.score)
    const best = candidates[0]
    const topCandidates = candidates.slice(0, 5).map((c) => ({
        centerOffset: c.centerOffset,
        width: c.width,
        score: c.score,
    }))
    if (best.width < clearWidth * 0.55 || best.width > ctx.viewFrame.width + 0.05) return null
    debugLog('pre-fix', 'H1', 'ifclite-renderer.ts:1242', 'leaf candidate stats', {
        guid: ctx.guid,
        clearWidth,
        closedLoops: closedLoops.length,
        closedFromOpen: closedExtra.length,
        rawOpenChains: rawOpen.length,
        rawSegments: all.length,
        candidateCount: candidates.length,
        bestWidth: best.width,
        bestCenterOffset: best.centerOffset,
        topCandidates,
    })
    return { centerOffset: best.centerOffset, width: best.width }
}

function emitPlanSvg(
    ctx: DoorContextLite,
    options: Required<Pick<RenderOptions, 'width' | 'height' | 'lineWidth' | 'colors' | 'doorFootAnchor' | 'emitDebugAttrs'>>,
): string {
    const W = options.width
    const H = options.height
    const cam = buildPlanCameraNew(ctx, W, H)
    // Compute a depth (facing-axis) crop band around the door plane so perpendicular
    // walls extending into adjacent rooms get cut off ~1 m past the door (legacy
    // parity).  The arc extends further into the open side, so we widen that side.
    const halfT = ctx.viewFrame.thickness / 2
    const arcReach = halfT + ctx.viewFrame.width * Math.sin(PLAN_SWING_OPEN_RAD)
    const backPadMeters = halfT + PLAN_DEPTH_PAD_METERS
    const frontPadMeters = Math.max(arcReach, halfT + PLAN_DEPTH_PAD_METERS)
    // Map depth pads to screen pixels: door anchored at canvas Y = 0.30 H.
    // facing direction = +screen-Y, so:
    //   front band (open side) extends toward larger Y
    //   back band extends toward smaller Y
    const doorScreenY = cam.project(ctx.viewFrame.origin[0], ctx.viewFrame.origin[2]).sy
    const planClipMinY = Math.max(0, doorScreenY - backPadMeters * FIXED_PX_PER_METER)
    const planClipMaxY = Math.min(H, doorScreenY + frontPadMeters * FIXED_PX_PER_METER)
    // Cut the world at door-bottom + 1.0 m. (Legacy uses +1.8 m near the door
    // head where wall is widest; +1.0 m at the waist gives the same wall
    // section since walls are uniform between slabs.)
    const cutY = ctx.viewFrame.origin[1] + PLAN_CUT_HEIGHT_METERS
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
     *  draw order; `fill` is the polygon colour. */
    const sectionGroup = (meshes: IfcLiteMesh[], fill: string, layer: number) => {
        const all: SectionSegment[] = []
        for (const m of meshes) all.push(...extractMeshSectionSegments(m, cutY))
        if (all.length === 0) return
        const { closedLoops, openChains } = reconstructPolygons(all)
        const closedExtra: Array<Array<{ x: number; z: number }>> = []
        const remainingOpen: Array<Array<{ x: number; z: number }>> = []
        for (const chain of openChains) {
            const closed = tryCloseOpenChain(chain, PLAN_OPEN_CHAIN_NEAR_CLOSE_METERS)
            if (closed) closedExtra.push(closed)
            else remainingOpen.push(chain)
        }
        for (const loop of [...closedLoops, ...closedExtra]) {
            polys.push({ points: loop.map(projP), fill, stroke: true, layer })
        }
        // Open chains: outline only (non-watertight wall stubs).
        for (const chain of remainingOpen) {
            for (let i = 0; i + 1 < chain.length; i++) {
                const a = projP(chain[i]); const b = projP(chain[i + 1])
                segs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, layer })
            }
        }
    }

    // Wall colour resolution mirrors elevation logic.
    const wallFillFor = (cfcBkp: string | null): string =>
        resolveWallCutColor(cfcBkp, colors)

    // Host wall (cut + filled).
    if (ctx.hostWall) {
        sectionGroup(ctx.hostWall.meshes, wallFillFor(ctx.cset.cfcBkp), 1)
    }
    // Nearby walls (perpendicular, T-junction returns).
    for (const w of ctx.nearbyWalls) {
        sectionGroup(w.meshes, wallFillFor(null), 1)
    }
    // Nearby doors (faded so the focal door reads).
    for (const d of ctx.nearbyDoors) {
        sectionGroup(d.meshes, colors.plan.doorContext, 3)
    }
    // Nearby windows.
    for (const w of ctx.nearbyWindows) {
        sectionGroup(w.meshes, colors.elevation.glass, 4)
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

    // Nearby electrical/safety devices at the cut plane (only the ones that
    // straddle the cut height — typically wall-mounted alarms / switches).
    for (const dev of ctx.nearbyDevices) {
        if (dev.bbox.min[1] > cutY + 0.05 || dev.bbox.max[1] < cutY - 0.05) continue
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
        const mirrorForIfcHandedness = shouldMirrorSwingForHandedness(ctx)
        debugLog('pre-fix', 'H2-H4', 'ifclite-renderer.ts:1314', 'plan swing entry', {
            guid: ctx.guid,
            operationType: ctx.operationType,
            parsed: op,
            mirrorForIfcHandedness,
            placementYAxis: ctx.placementYAxis,
            widthAxis: ctx.viewFrame.widthAxis,
            facing: ctx.viewFrame.facing,
            frameWidth: ctx.viewFrame.width,
            frameThickness: ctx.viewFrame.thickness,
        })
        if (process.env.DEBUG_PLAN === '1') {
            console.log(`[plan ${ctx.guid}] op=${ctx.operationType} parsed=${JSON.stringify(op)} mirror=${mirrorForIfcHandedness} frameW=${ctx.viewFrame.width.toFixed(2)} clearW=${ctx.cset.massDurchgangsbreite}`)
        }
        if (op.kind === 'swing' && op.hingeSide) {
            const widthAxis2 = cam.widthAxis     // {x,z} along door width
            const flipArc = shouldFlipPlanArc(ctx)
            const openAxis2 = cam.openAxis // keep right-handed basis; flip sweep angle only
            const arcSign = flipArc ? -1 : 1
            const det2d = widthAxis2.x * openAxis2.z - widthAxis2.z * openAxis2.x
            debugLog('pre-fix', 'H5', 'ifclite-renderer.ts:1321', 'plan basis determinant', {
                guid: ctx.guid,
                widthAxis: widthAxis2,
                openAxis: openAxis2,
                det2d,
            })
            debugLog('pre-fix', 'H6', 'ifclite-renderer.ts:1323', 'plan arc flip decision', {
                guid: ctx.guid,
                flipArc,
                arcSign,
                mirrorMode: flipArc ? 'leaf-center-xy' : 'none',
                placementYAxis: ctx.placementYAxis,
                facing: ctx.viewFrame.facing,
            })
            const frameW = ctx.viewFrame.width
            const clearW = (ctx.cset.massDurchgangsbreite != null && ctx.cset.massDurchgangsbreite > 0.05)
                ? ctx.cset.massDurchgangsbreite
                : Math.max(frameW - 0.10, 0.6)
            const jambInset = Math.max((frameW - clearW) / 2, 0)  // half the frame thickness on each side
            const faceOffset = ctx.viewFrame.thickness / 2
            debugLog('pre-fix', 'H1', 'ifclite-renderer.ts:1326', 'plan swing sizing', {
                guid: ctx.guid,
                frameW,
                clearW,
                jambInset,
                usesCsetClearWidth: ctx.cset.massDurchgangsbreite != null && ctx.cset.massDurchgangsbreite > 0.05,
            })
            const drawLeaf = (hingeSide: 'left' | 'right', leafW: number, hingeOff: number, leafCenterOff: number) => {
                // Hinge in world (XZ): door centre + widthAxis * hingeOff.
                // hingeOff = ±(halfFrame - jambInset) so hinge sits at the
                // INSIDE EDGE of the jamb, not at the bbox corner.
                const hingeX = ctx.viewFrame.origin[0] + widthAxis2.x * hingeOff
                const hingeZ = ctx.viewFrame.origin[2] + widthAxis2.z * hingeOff
                // Pivot offset along openAxis (door face), faceOffset ahead of wall plane.
                const pivotX = hingeX + openAxis2.x * faceOffset
                const pivotZ = hingeZ + openAxis2.z * faceOffset
                const leafCenterX = ctx.viewFrame.origin[0] + widthAxis2.x * leafCenterOff + openAxis2.x * faceOffset
                const leafCenterZ = ctx.viewFrame.origin[2] + widthAxis2.z * leafCenterOff + openAxis2.z * faceOffset
                const startAngle = hingeSide === 'left' ? 0 : Math.PI
                const baseDelta = hingeSide === 'left' ? PLAN_SWING_OPEN_RAD : -PLAN_SWING_OPEN_RAD
                const endAngle = startAngle + baseDelta * arcSign
                const N = 24
                let prevS: Pt | null = null
                for (let i = 0; i <= N; i++) {
                    const t = i / N
                    const ang = startAngle + (endAngle - startAngle) * t
                    const openAxisSign = xAxisMirrorOnly ? -1 : 1
                    const dirX = widthAxis2.x * Math.cos(ang) + openAxis2.x * Math.sin(ang) * openAxisSign
                    const dirZ = widthAxis2.z * Math.cos(ang) + openAxis2.z * Math.sin(ang) * openAxisSign
                    const rawPx = pivotX + dirX * leafW
                    const rawPz = pivotZ + dirZ * leafW
                    const px = flipArc ? (2 * leafCenterX - rawPx) : rawPx
                    const pz = flipArc ? (2 * leafCenterZ - rawPz) : rawPz
                    const s = projP({ x: px, z: pz })
                    if (prevS) {
                        segs.push({ x1: prevS.x, y1: prevS.y, x2: s.x, y2: s.y, layer: 7, color: '#666666' })
                    }
                    prevS = s
                }
                // Leaf line: pivot → arc tip at 15° open position.
                const tipAng = endAngle
                const openAxisSign = xAxisMirrorOnly ? -1 : 1
                const tipDirX = widthAxis2.x * Math.cos(tipAng) + openAxis2.x * Math.sin(tipAng) * openAxisSign
                const tipDirZ = widthAxis2.z * Math.cos(tipAng) + openAxis2.z * Math.sin(tipAng) * openAxisSign
                const rawTipX = pivotX + tipDirX * leafW
                const rawTipZ = pivotZ + tipDirZ * leafW
                const tipX = flipArc ? (2 * leafCenterX - rawTipX) : rawTipX
                const tipZ = flipArc ? (2 * leafCenterZ - rawTipZ) : rawTipZ
                const lineStartBaseX = pivotX
                const lineStartBaseZ = pivotZ
                const lineStartX = flipArc ? (2 * leafCenterX - lineStartBaseX) : lineStartBaseX
                const lineStartZ = flipArc ? (2 * leafCenterZ - lineStartBaseZ) : lineStartBaseZ
                const hingeS = projP({ x: lineStartX, z: lineStartZ })
                const tipS = projP({ x: tipX, z: tipZ })
                debugLog('pre-fix', 'H3-H4', 'ifclite-renderer.ts:1345', 'plan swing leaf geometry', {
                    guid: ctx.guid,
                    hingeSide,
                    leafW,
                    hingeOff,
                    leafCenterOff,
                    flipArc,
                    xAxisMirrorOnly,
                    pivotWorld: { x: pivotX, z: pivotZ },
                    hingeWorld: { x: hingeX, z: hingeZ },
                    lineStartMode: 'pivot-face',
                    lineStartWorld: { x: lineStartX, z: lineStartZ },
                    tipWorld: { x: tipX, z: tipZ },
                    pivotScreen: hingeS,
                    tipScreen: tipS,
                    widthAxis: widthAxis2,
                    openAxis: openAxis2,
                })
                segs.push({ x1: hingeS.x, y1: hingeS.y, x2: tipS.x, y2: tipS.y, layer: 7, color: '#666666' })
            }
            const hingeSideResolved: 'left' | 'right' | 'both' =
                op.hingeSide === 'both'
                    ? 'both'
                    : (mirrorForIfcHandedness
                        ? (op.hingeSide === 'left' ? 'right' : 'left')
                        : op.hingeSide)
            let leafWidthForSingle = clearW
            let centerOffsetForSingle = 0
            let centeredOffsetUsed = true
            const hasSignificantFixedPanel = clearW > 0.3 && clearW < frameW - 0.1
            if (hingeSideResolved !== 'both' && hasSignificantFixedPanel) {
                const detected = detectLeafCenterFromDoorMeshes(ctx, cutY, clearW)
                if (detected) {
                    leafWidthForSingle = detected.width
                    centerOffsetForSingle = detected.centerOffset
                    centeredOffsetUsed = false
                    debugLog('pre-fix', 'H1', 'ifclite-renderer.ts:1381', 'detected asymmetric leaf', {
                        guid: ctx.guid,
                        clearW,
                        frameW,
                        detectedWidth: detected.width,
                        detectedCenterOffset: detected.centerOffset,
                    })
                } else {
                    debugLog('pre-fix', 'H1', 'ifclite-renderer.ts:1388', 'asymmetric leaf detection failed, using centered fallback', {
                        guid: ctx.guid,
                        clearW,
                        frameW,
                    })
                }
            }
            const halfClear = clearW / 2
            let hingeSideResolvedFinal: 'left' | 'right' | 'both' = hingeSideResolved
            const xAxisMirrorOnly =
                hingeSideResolvedFinal !== 'both'
                && mirrorForIfcHandedness
                && !flipArc
                && hasSignificantFixedPanel
                && !centeredOffsetUsed
            debugLog('pre-fix', 'H12', 'ifclite-renderer.ts:1394', 'x-axis mirror mode decision', {
                guid: ctx.guid,
                operationType: ctx.operationType,
                mirrorForIfcHandedness,
                flipArc,
                xAxisMirrorOnly,
                centeredOffsetUsed,
                hasSignificantFixedPanel,
            })
            if (hingeSideResolvedFinal !== 'both') {
                const rightNoMirror = op.hingeSide === 'right'
                const hingeNoMirror = rightNoMirror
                    ? centerOffsetForSingle + (leafWidthForSingle / 2)
                    : centerOffsetForSingle - (leafWidthForSingle / 2)
                const rightMirror = !rightNoMirror
                const hingeMirror = rightMirror
                    ? centerOffsetForSingle + (leafWidthForSingle / 2)
                    : centerOffsetForSingle - (leafWidthForSingle / 2)
                const halfFrame = frameW / 2
                const edgeSlackNoMirror = Math.min(
                    Math.abs((centerOffsetForSingle - leafWidthForSingle / 2) - (-halfFrame)),
                    Math.abs((centerOffsetForSingle + leafWidthForSingle / 2) - halfFrame),
                )
                const leafLeft = centerOffsetForSingle - (leafWidthForSingle / 2)
                const leafRight = centerOffsetForSingle + (leafWidthForSingle / 2)
                const leftSlack = Math.abs(leafLeft - (-halfFrame))
                const rightSlack = Math.abs(halfFrame - leafRight)
                const geometricPreferredHinge: 'left' | 'right' = leftSlack < rightSlack ? 'left' : 'right'
                const semanticResolvedHinge: 'left' | 'right' = hingeSideResolvedFinal === 'left' ? 'left' : 'right'
                const handednessConflict = geometricPreferredHinge !== semanticResolvedHinge
                if (xAxisMirrorOnly && handednessConflict) {
                    hingeSideResolvedFinal = geometricPreferredHinge
                    debugLog('pre-fix', 'H14', 'ifclite-renderer.ts:1398', 'conflict fallback: geometric hinge under x-axis mirror', {
                        guid: ctx.guid,
                        operationType: ctx.operationType,
                        previousHinge: semanticResolvedHinge,
                        overriddenHinge: hingeSideResolvedFinal,
                        geometricPreferredHinge,
                        mirrorForIfcHandedness,
                        flipArc,
                        xAxisMirrorOnly,
                    })
                }
                debugLog('pre-fix', 'H13', 'ifclite-renderer.ts:1386', 'semantic-vs-geometry handedness', {
                    guid: ctx.guid,
                    operationType: ctx.operationType,
                    mirrorForIfcHandedness,
                    flipArc,
                    geometricPreferredHinge,
                    semanticResolvedHinge,
                    handednessConflict,
                    leafLeft,
                    leafRight,
                    halfFrame,
                    leftSlack,
                    rightSlack,
                })
                debugLog('pre-fix', 'H8-H10', 'ifclite-renderer.ts:1374', 'hinge alternatives', {
                    guid: ctx.guid,
                    operationType: ctx.operationType,
                    mirrorForIfcHandedness,
                    flipArc,
                    centerOffsetForSingle,
                    leafWidthForSingle,
                    frameW,
                    selectedHingeSide: hingeSideResolved,
                    selectedHingeOffset: hingeSideResolvedFinal === 'left'
                        ? centerOffsetForSingle - (leafWidthForSingle / 2)
                        : centerOffsetForSingle + (leafWidthForSingle / 2),
                    selectedHingeSideAfterConflictPolicy: hingeSideResolvedFinal,
                    noMirror: {
                        hingeSide: rightNoMirror ? 'right' : 'left',
                        hingeOffset: hingeNoMirror,
                    },
                    mirror: {
                        hingeSide: rightMirror ? 'right' : 'left',
                        hingeOffset: hingeMirror,
                    },
                    leafEdgeSlackToFrame: edgeSlackNoMirror,
                })
            }
            debugLog('pre-fix', 'H1-H2', 'ifclite-renderer.ts:1370', 'plan swing resolved hinge', {
                guid: ctx.guid,
                inputHinge: op.hingeSide,
                resolvedHinge: hingeSideResolvedFinal,
                halfClear,
                centeredOffsetUsed,
                leafWidthForSingle,
                centerOffsetForSingle,
            })
            if (hingeSideResolvedFinal === 'both') {
                // Double swing: each leaf is half the clear width.
                drawLeaf('left', halfClear, -halfClear, -halfClear / 2)
                drawLeaf('right', halfClear, +halfClear, +halfClear / 2)
            } else {
                // Hinge at the INSIDE edge of the jamb (frame-thickness inset
                // from bbox corner), arc spans the clear width to the
                // opposite jamb's INSIDE edge.
                const hingeOff = hingeSideResolvedFinal === 'left'
                    ? centerOffsetForSingle - (leafWidthForSingle / 2)
                    : centerOffsetForSingle + (leafWidthForSingle / 2)
                drawLeaf(hingeSideResolvedFinal, leafWidthForSingle, hingeOff, centerOffsetForSingle)
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
        `<defs><clipPath id="plan-clip"><rect x="0" y="${planClipMinY.toFixed(2)}" width="${W}" height="${(planClipMaxY - planClipMinY).toFixed(2)}"/></clipPath></defs>`,
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
    return {
        front: emitElevationSvg(ctx, 'front', opts),
        back: emitElevationSvg(ctx, 'back', opts),
        plan: emitPlanSvg(ctx, opts),
    }
}
