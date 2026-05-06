/**
 * Lean door analyzer for the ifc-lite pipeline.
 *
 * Per IfcDoor we compute:
 *   - World AABB and centre
 *   - viewFrame: width/height/thickness + axes (Y up; "normal" = wall-thickness
 *     direction, picked from the door's smallest horizontal extent — works for
 *     all axis-aligned and most rotated doors in the Flu21 set).
 *   - Host wall via `IfcRelFillsElement` → `IfcOpeningElement` → `IfcRelVoidsElement` → `IfcWall`.
 *     Falls back to the IfcWall whose AABB best contains the door volume.
 *   - Floor slab (largest IfcSlab whose AABB straddles the door's lower face)
 *     and ceiling slab (above the door head).
 *   - Plan-band neighbours: nearbyWalls / nearbyDoors / nearbyWindows / nearbyStairs
 *     within `±NEIGHBOUR_PLAN_RADIUS` of the door centre and overlapping the storey.
 *   - Electrical devices from the optional ELEC IFC, picked by bbox overlap with
 *     the door's elevation viewing volume (front + back side bands).
 *
 * All coordinates are Y-up, RTC-shifted (the same offset ifc-lite already
 * applied to the meshes), so direct comparison between primary/secondary
 * models works only when the two share the same RTC origin.  In practice the
 * AR + EL IFCs are co-located, but we surface a `secondaryRtcOffset` delta
 * so the renderer / round can warn if they ever diverge.
 */
import type { IfcLiteMesh, IfcLiteModel } from './ifclite-source'
import { readDoorPlacementYAxis } from './ifclite-placement'

export interface AABB {
    min: [number, number, number]
    max: [number, number, number]
}

export interface DoorViewFrame {
    /** World point at the door's outline centre (between leaves), Y at frame bottom. */
    origin: [number, number, number]
    /** Unit vector along door width (in plan, perpendicular to wall normal). */
    widthAxis: [number, number, number]
    /** Unit vector along door height — always (0,1,0). */
    upAxis: [number, number, number]
    /** Unit vector pointing from front of door (camera-facing for "front" view). */
    facing: [number, number, number]
    width: number
    height: number
    thickness: number
}

export interface DoorContextLite {
    door: { expressId: number; meshes: IfcLiteMesh[]; bbox: AABB }
    guid: string
    name: string
    storeyName: string | null
    storeyElevation: number | null
    viewFrame: DoorViewFrame

    hostWall: { expressId: number; meshes: IfcLiteMesh[]; bbox: AABB } | null
    slabBelow: { expressId: number; meshes: IfcLiteMesh[]; bbox: AABB } | null
    slabAbove: { expressId: number; meshes: IfcLiteMesh[]; bbox: AABB } | null
    /** IfcBuildingElementPart children of slabBelow (Unterlagsboden / floor
     *  build-up).  Rendered as separate bands on top of the structural slab
     *  in elevation views. */
    slabBelowParts: Array<{ expressId: number; meshes: IfcLiteMesh[]; bbox: AABB; guid?: string | null }>
    /** Same for slabAbove (suspended ceiling / build-up under the slab). */
    slabAboveParts: Array<{ expressId: number; meshes: IfcLiteMesh[]; bbox: AABB; guid?: string | null }>

    nearbyWalls: Array<{ expressId: number; meshes: IfcLiteMesh[]; bbox: AABB; guid?: string | null }>
    nearbyDoors: Array<{ expressId: number; meshes: IfcLiteMesh[]; bbox: AABB; cfcBkp: string | null }>
    nearbyWindows: Array<{ expressId: number; meshes: IfcLiteMesh[]; bbox: AABB }>
    nearbyDevices: Array<{
        expressId: number
        meshes: IfcLiteMesh[]
        bbox: AABB
        ifcType: string
        name: string
        modelTag: 'arch' | 'elec'
    }>

    /** Properties relevant to colouring / labels. */
    cset: {
        cfcBkp: string | null
        alTuernummer: string | null
        massDurchgangsbreite: number | null
        massDurchgangshoehe: number | null
    }
    /** IFC OperationType (e.g. "SINGLE_SWING_LEFT") read from the door instance
     *  or its IfcDoorType, used to pick the plan-view swing-arc handedness. */
    operationType: string | null
    /** Door's local +Y axis in IFC-native (Z-up) world coords, normalised.
     *  IFC4 LEFT/RIGHT swing handedness is "as viewed in the direction of
     *  the positive y-axis", so the renderer needs this to detect when its
     *  bbox-derived facing direction points OPPOSITE to IFC's localY and
     *  the swing arc must be mirrored.  null when the placement chain can't
     *  be parsed. */
    placementYAxis: [number, number, number] | null
}

export interface AnalyzeOptions {
    /** Plan-radius around the door centre for nearby element capture (metres). */
    neighbourPlanRadius?: number
    /** Vertical band in metres that "nearby" walls/devices must overlap with the door. */
    neighbourElevationOverlap?: number
}

const DEFAULT_OPTS: Required<AnalyzeOptions> = {
    // Capture a generous pool of candidate neighbours.  The renderer does
    // its own per-view 3D-AABB intersection (plan cut slab, elevation
    // depth slab) to decide what to actually draw — the analyzer just
    // makes sure every wall/door/window/device that COULD be in any of
    // the three views is in the pool.  4.5 m comfortably covers the
    // canvas-corner radius (≈ √(1.75²+1.75²) = 2.47 m) plus the host-wall
    // depth and any T-junction stubs reaching ~2 m into the back room.
    neighbourPlanRadius: 4.5,
    neighbourElevationOverlap: 0.05,
}
// Keep in sync with ifclite-renderer plan section height. We still use this
// as a floor for device candidate collection so plan always sees clip-plane
// context, while elevation-specific clipping is handled later in rendering.
const PLAN_CUT_HEIGHT_METERS = 1.85

function bboxOfMeshes(meshes: IfcLiteMesh[]): AABB | null {
    let minX = +Infinity, minY = +Infinity, minZ = +Infinity
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
    for (const mesh of meshes) {
        const pos = mesh.positions
        for (let k = 0; k < pos.length; k += 3) {
            const x = pos[k], y = pos[k + 1], z = pos[k + 2]
            if (x < minX) minX = x; if (x > maxX) maxX = x
            if (y < minY) minY = y; if (y > maxY) maxY = y
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
        }
    }
    if (!isFinite(minX)) return null
    return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] }
}

function bboxCentre(b: AABB): [number, number, number] {
    return [
        (b.min[0] + b.max[0]) / 2,
        (b.min[1] + b.max[1]) / 2,
        (b.min[2] + b.max[2]) / 2,
    ]
}

function bboxExtents(b: AABB): [number, number, number] {
    return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]]
}

function bboxesOverlap(a: AABB, b: AABB, slack = 0): boolean {
    return (
        a.min[0] - slack <= b.max[0] && a.max[0] + slack >= b.min[0]
        && a.min[1] - slack <= b.max[1] && a.max[1] + slack >= b.min[1]
        && a.min[2] - slack <= b.max[2] && a.max[2] + slack >= b.min[2]
    )
}

function planDistanceToBox(b: AABB, c: [number, number, number]): number {
    const dx = Math.max(b.min[0] - c[0], 0, c[0] - b.max[0])
    const dz = Math.max(b.min[2] - c[2], 0, c[2] - b.max[2])
    return Math.hypot(dx, dz)
}

/**
 * Build a cheap spatial index keyed by (xCell, zCell) of size `cellSize` for
 * the IFC type.  Buckets are populated with `{ expressId, bbox }`.  Used to
 * answer plan-radius queries without scanning every wall/window/etc.
 */
function buildPlanIndex(
    model: IfcLiteModel,
    type: string,
    cellSize: number
): {
    cellSize: number
    bins: Map<string, Array<{ expressId: number; bbox: AABB; meshes: IfcLiteMesh[] }>>
} {
    const ids = model.byType(type)
    const bins = new Map<string, Array<{ expressId: number; bbox: AABB; meshes: IfcLiteMesh[] }>>()
    for (const id of ids) {
        const meshes = model.meshesByExpressId.get(id)
        if (!meshes || meshes.length === 0) continue
        const bbox = bboxOfMeshes(meshes)
        if (!bbox) continue
        const ix0 = Math.floor(bbox.min[0] / cellSize)
        const iz0 = Math.floor(bbox.min[2] / cellSize)
        const ix1 = Math.floor(bbox.max[0] / cellSize)
        const iz1 = Math.floor(bbox.max[2] / cellSize)
        for (let ix = ix0; ix <= ix1; ix++) {
            for (let iz = iz0; iz <= iz1; iz++) {
                const key = `${ix},${iz}`
                const arr = bins.get(key) ?? []
                arr.push({ expressId: id, bbox, meshes })
                bins.set(key, arr)
            }
        }
    }
    return { cellSize, bins }
}

function queryPlanIndex(
    index: ReturnType<typeof buildPlanIndex>,
    centre: [number, number, number],
    radius: number
): Array<{ expressId: number; bbox: AABB; meshes: IfcLiteMesh[] }> {
    const { cellSize, bins } = index
    const ix0 = Math.floor((centre[0] - radius) / cellSize)
    const iz0 = Math.floor((centre[2] - radius) / cellSize)
    const ix1 = Math.floor((centre[0] + radius) / cellSize)
    const iz1 = Math.floor((centre[2] + radius) / cellSize)
    const seen = new Set<number>()
    const out: Array<{ expressId: number; bbox: AABB; meshes: IfcLiteMesh[] }> = []
    for (let ix = ix0; ix <= ix1; ix++) {
        for (let iz = iz0; iz <= iz1; iz++) {
            const arr = bins.get(`${ix},${iz}`)
            if (!arr) continue
            for (const item of arr) {
                if (seen.has(item.expressId)) continue
                if (planDistanceToBox(item.bbox, centre) > radius) continue
                seen.add(item.expressId)
                out.push(item)
            }
        }
    }
    return out
}

function buildDoorViewFrame(
    bbox: AABB,
    placementYAxis: [number, number, number] | null = null
): DoorViewFrame {
    const ext = bboxExtents(bbox)
    const centre = bboxCentre(bbox)
    // Y is up in IFC-Lite output. The two horizontal axes are X and Z.
    // The smaller of (extX, extZ) is wall thickness (door normal direction).
    let widthAxis: [number, number, number]
    let facing: [number, number, number]
    let width: number
    let thickness: number
    if (ext[0] >= ext[2]) {
        widthAxis = [1, 0, 0]
        facing = [0, 0, 1]
        width = ext[0]
        thickness = ext[2]
    } else {
        widthAxis = [0, 0, 1]
        facing = [1, 0, 0]
        width = ext[2]
        thickness = ext[0]
    }
    if (placementYAxis) {
        // Map IFC local +Y (XY in IFC world) to renderer XZ and use it to lock
        // the sign of plan facing so 90° doors do not get canonicalized to the
        // opposite viewing direction (which mirrors the full plan context).
        const pyx = placementYAxis[0]
        const pyz = placementYAxis[1]
        const pyLen = Math.hypot(pyx, pyz)
        if (pyLen > 1e-8) {
            const pnx = pyx / pyLen
            const pnz = pyz / pyLen
            const facingDotPlacement = pnx * facing[0] + pnz * facing[2]
            if (facingDotPlacement < 0) {
                facing = [-facing[0], 0, -facing[2]]
            }
            // Keep a consistent right-handed local frame when facing flips.
            widthAxis = [facing[2], 0, -facing[0]]
        }
    }
    const height = ext[1]
    // Origin: bottom centre of door bbox in plan, Y at bbox bottom.
    const origin: [number, number, number] = [centre[0], bbox.min[1], centre[2]]
    return {
        origin,
        widthAxis,
        upAxis: [0, 1, 0],
        facing,
        width,
        height,
        thickness,
    }
}

/**
 * Walk fills relationship: door → IfcOpeningElement → IfcWall (via opening's voids).
 */
function findHostWallExpressId(model: IfcLiteModel, doorId: number): number | null {
    const rels = model.relationships(doorId)
    for (const fill of rels.fills) {
        if (fill.type === 'IFCOPENINGELEMENT' || fill.type === 'IfcOpeningElement') {
            const openingRels = model.relationships(fill.id)
            for (const v of openingRels.voids) {
                if (v.type.toUpperCase() === 'IFCWALL' || v.type.toUpperCase() === 'IFCWALLSTANDARDCASE') {
                    return v.id
                }
            }
        }
    }
    return null
}

/**
 * Fallback host wall: pick the IfcWall whose AABB contains the door's plan
 * footprint with the smallest expansion, biased to walls whose bbox actually
 * intersects the door bbox in 3D.
 */
function findHostWallByBBox(
    model: IfcLiteModel,
    doorBbox: AABB,
    wallIndex: ReturnType<typeof buildPlanIndex>,
    doorViewFrame?: { widthAxis: [number, number, number] },
): number | null {
    const centre = bboxCentre(doorBbox)
    const doorY: [number, number] = [doorBbox.min[1], doorBbox.max[1]]
    // Door's expected host orientation: a host wall runs ALONG the door's
    // widthAxis (a Z-aligned door sits in a Z-running wall, etc.).  When we
    // have a viewFrame, treat orientation match as a HARD filter — a long
    // perpendicular wall touching the door's south face is not a host wall,
    // and without this filter its enormous slenderness score wins over
    // properly-oriented but barely-not-overlapping segments.
    const hostWidthAxis: 'x' | 'z' | null = doorViewFrame
        ? Math.abs(doorViewFrame.widthAxis[0]) > Math.abs(doorViewFrame.widthAxis[2]) ? 'x' : 'z'
        : null
    // bbox-to-bbox plan distance: 0 if the bboxes touch or overlap.
    const planBboxGap = (a: AABB, b: AABB): number => {
        const dx = Math.max(0, b.min[0] - a.max[0], a.min[0] - b.max[0])
        const dz = Math.max(0, b.min[2] - a.max[2], a.min[2] - b.max[2])
        return Math.hypot(dx, dz)
    }
    // Search radius: 1.5 m so segmented walls (host stops 0.2–0.5 m short
    // of the door bbox) can still be matched in the lenient pass.
    const candidates = queryPlanIndex(wallIndex, centre, 1.5)
    let best: { id: number; score: number } | null = null
    for (const cand of candidates) {
        // Y overlap mandatory — different storeys must not match.
        if (cand.bbox.max[1] < doorY[0] - 0.05) continue
        if (cand.bbox.min[1] > doorY[1] + 0.05) continue
        const cExt = bboxExtents(cand.bbox)
        const cWallAlongX = cExt[0] >= cExt[2]
        if (hostWidthAxis != null) {
            const matches = hostWidthAxis === 'x' ? cWallAlongX : !cWallAlongX
            if (!matches) continue
        }
        // Reject extremely-near-square walls (columns, piers): host walls are
        // slender — at least 4:1 long-to-thin in plan.
        const slenderness = Math.max(cExt[0], cExt[2]) / Math.max(0.05, Math.min(cExt[0], cExt[2]))
        if (slenderness < 4) continue
        const gap = planBboxGap(cand.bbox, doorBbox)
        if (gap > 0.5) continue
        // Score: prefer (low gap, then low containment expansion, then high slenderness).
        const dx = Math.max(0, doorBbox.min[0] - cand.bbox.min[0]) + Math.max(0, cand.bbox.max[0] - doorBbox.max[0])
        const dz = Math.max(0, doorBbox.min[2] - cand.bbox.min[2]) + Math.max(0, cand.bbox.max[2] - doorBbox.max[2])
        const containment = dx + dz
        const score = gap * 10 + containment * 0.05 - slenderness * 0.05
        if (!best || score < best.score) best = { id: cand.expressId, score }
    }
    return best?.id ?? null
}

function findSlabsAroundDoor(
    model: IfcLiteModel,
    doorBbox: AABB,
    slabIndex: ReturnType<typeof buildPlanIndex>,
    buildingPartIndex: ReturnType<typeof buildPlanIndex>
): {
    below: { expressId: number; meshes: IfcLiteMesh[]; bbox: AABB } | null
    above: { expressId: number; meshes: IfcLiteMesh[]; bbox: AABB } | null
    /** Other slabs stacked under door foot (Unterlagsboden, screed) — for the
     *  full floor build-up band rendering.  Sorted by Y ascending. */
    belowExtras: Array<{ expressId: number; meshes: IfcLiteMesh[]; bbox: AABB }>
    /** Other slabs stacked above door head (suspended ceiling layers etc). */
    aboveExtras: Array<{ expressId: number; meshes: IfcLiteMesh[]; bbox: AABB }>
} {
    const centre = bboxCentre(doorBbox)
    const yBottom = doorBbox.min[1]
    const yTop = doorBbox.max[1]
    // Use a generous plan radius — 2 m covers most door-adjacent floor stacks
    // including separate Unterlagsboden / screed slab tiles.
    const slabCandidates = queryPlanIndex(slabIndex, centre, 2.0)
    const partCandidates = queryPlanIndex(buildingPartIndex, centre, 2.0)
    const candidates = [...slabCandidates]
    for (const cand of partCandidates) {
        if (candidates.some((c) => c.expressId === cand.expressId)) continue
        candidates.push(cand)
    }
    let below: { expressId: number; meshes: IfcLiteMesh[]; bbox: AABB; gap: number } | null = null
    let above: { expressId: number; meshes: IfcLiteMesh[]; bbox: AABB; gap: number } | null = null
    const belowAll: Array<{ expressId: number; meshes: IfcLiteMesh[]; bbox: AABB; gap: number }> = []
    const aboveAll: Array<{ expressId: number; meshes: IfcLiteMesh[]; bbox: AABB; gap: number }> = []
    // Numerical tolerance so near-threshold meshes don't flap due to floating
    // point noise from IFC tessellation/RTC transforms.
    const GAP_EPS = 1e-6
    const BELOW_MIN_GAP = -0.15
    const BELOW_MAX_GAP = 0.50
    const ABOVE_MIN_GAP = -0.30
    const ABOVE_MAX_GAP = 1.80
    const inRange = (v: number, lo: number, hi: number) =>
        v >= lo - GAP_EPS && v <= hi + GAP_EPS
    for (const cand of candidates) {
        const gapBelow = yBottom - cand.bbox.max[1]
        // Accept slab tops in a narrow intrusion band above door bottom and a
        // wider band below it:
        //   gapBelow ∈ [-0.15, 0.50]
        // This maps to slabTop in [doorBottom + 0.15, doorBottom - 0.50].
        if (inRange(gapBelow, BELOW_MIN_GAP, BELOW_MAX_GAP)) {
            const entry = { expressId: cand.expressId, meshes: cand.meshes, bbox: cand.bbox, gap: gapBelow }
            belowAll.push(entry)
            if (!below || gapBelow < below.gap) below = entry
        }
        const gapAbove = cand.bbox.min[1] - yTop
        if (inRange(gapAbove, ABOVE_MIN_GAP, ABOVE_MAX_GAP)) {
            const entry = { expressId: cand.expressId, meshes: cand.meshes, bbox: cand.bbox, gap: gapAbove }
            aboveAll.push(entry)
            if (!above || gapAbove < above.gap) above = entry
        }
    }
    // Pick the deepest slab as the "structural" reference: greatest gap below
    // (i.e. lowest Y top). Build-up layers (Unterlagsboden, screed) sit on top
    // of that slab and we surface them as `belowExtras` so the renderer can
    // draw the full floor stack between structural slab and door foot.
    let structuralBelow = below
    if (belowAll.length > 1) {
        structuralBelow = belowAll.reduce((acc, cur) => cur.gap > acc.gap ? cur : acc, belowAll[0])
    }
    const belowExtras = belowAll
        .filter((e) => e.expressId !== (structuralBelow?.expressId ?? -1))
        .sort((a, b) => a.bbox.min[1] - b.bbox.min[1])
        .map((e) => ({ expressId: e.expressId, meshes: e.meshes, bbox: e.bbox }))
    const aboveExtras = aboveAll
        .filter((e) => e.expressId !== (above?.expressId ?? -1))
        .sort((a, b) => b.bbox.max[1] - a.bbox.max[1])
        .map((e) => ({ expressId: e.expressId, meshes: e.meshes, bbox: e.bbox }))
    return {
        below: structuralBelow
            ? { expressId: structuralBelow.expressId, meshes: structuralBelow.meshes, bbox: structuralBelow.bbox }
            : null,
        above: above ? { expressId: above.expressId, meshes: above.meshes, bbox: above.bbox } : null,
        belowExtras,
        aboveExtras,
    }
}

/** IfcDoor / IfcDoorType OperationType: only the actual swing-direction enum
 *  (SINGLE_SWING_LEFT, DOUBLE_DOOR_*, …), never PredefinedType.  Many models
 *  leave OperationType $ on the instance and set it on the linked IfcDoorType
 *  via IfcRelDefinesByType — we look at both. */
function readOperationType(model: IfcLiteModel, doorId: number): string | null {
    const stripDots = (s: string) => s.replace(/^\.|\.$/g, '').trim()
    const isUseful = (v: string) => {
        if (!v || v === '$') return false
        const u = v.toUpperCase()
        if (u === 'NOTDEFINED' || u === 'USERDEFINED' || u === 'DOOR' || u === 'GATE' || u === 'TRAPDOOR') return false
        return true
    }
    // Instance attrs first (rare but possible).
    const instAttrs = model.namedAttrs(doorId)
    for (const attr of instAttrs) {
        if (attr.name !== 'OperationType') continue
        const v = stripDots(String(attr.value))
        if (isUseful(v)) return v
    }
    // Fall back to the linked IfcDoorType.
    const typeId = model.typeOfInstance(doorId)
    if (typeId != null) {
        const typeAttrs = model.namedAttrs(typeId)
        for (const attr of typeAttrs) {
            if (attr.name !== 'OperationType') continue
            const v = stripDots(String(attr.value))
            if (isUseful(v)) return v
        }
    }
    return null
}

/** Lightweight BKP-only reader used per-nearby-door for context coloring.
 *  Avoids the alTuernummer / Mass-Durchgangsbreite pulls that readCsetData
 *  does for the focal door (those aren't needed for adjacent doors). */
function readDoorBkp(model: IfcLiteModel, doorId: number): string | null {
    const allPsets = [...model.psets(doorId), ...model.typePsets(doorId)]
    for (const cset of allPsets) {
        if (cset.name !== 'Cset_StandardCH') continue
        for (const [k, v] of Object.entries(cset.properties)) {
            const norm = k.toLowerCase().replace(/[\s_/-]/g, '')
            if (norm === 'cfcbkpcccbcc') return v == null ? null : String(v)
        }
    }
    return null
}

function readCsetData(model: IfcLiteModel, doorId: number): DoorContextLite['cset'] {
    // Cset_StandardCH props can live on the door instance OR on its IfcDoorType
    // (via IfcRelDefinesByType).  The legacy renderer reads both — without the
    // type-level read every door's BKP comes back null and we fall back to
    // hellgrau, missing the wood/metal classifications.
    const allPsets = [...model.psets(doorId), ...model.typePsets(doorId)]
    const out: DoorContextLite['cset'] = {
        cfcBkp: null,
        alTuernummer: null,
        massDurchgangsbreite: null,
        massDurchgangshoehe: null,
    }
    const csets = allPsets.filter((p) => p.name === 'Cset_StandardCH')
    if (csets.length === 0) return out
    // Iterate all matching psets — a value found on either instance or type
    // wins, with instance taking precedence (read first).
    for (const cset of csets) {
        for (const [k, v] of Object.entries(cset.properties)) {
            const lk = k.toLowerCase()
            // normalize: "CFC / BKP / CCC / BCC" → "cfcbkpcccbcc" and
            // "Mass - Durchgangsbreite" → "massdurchgangsbreite"
            const norm = lk.replace(/[\s_/-]/g, '')
            if (out.cfcBkp == null && norm === 'cfcbkpcccbcc') {
                out.cfcBkp = v == null ? null : String(v)
            } else if (out.alTuernummer == null && (lk === 'altuernummer' || norm === 'altuernummer')) {
                out.alTuernummer = v == null ? null : String(v)
            } else if (out.massDurchgangsbreite == null && norm === 'massdurchgangsbreite') {
                out.massDurchgangsbreite = typeof v === 'number' ? v : v == null ? null : Number(v)
            } else if (out.massDurchgangshoehe == null && norm === 'massdurchgangshoehe') {
                out.massDurchgangshoehe = typeof v === 'number' ? v : v == null ? null : Number(v)
            }
        }
    }
    if (process.env.DEBUG_BKP === '1') {
        const allKeys = [
            ...model.psets(doorId).filter(p => p.name === 'Cset_StandardCH').map(p => `inst:${Object.keys(p.properties).join(',')}`),
            ...model.typePsets(doorId).filter(p => p.name === 'Cset_StandardCH').map(p => `type:${Object.keys(p.properties).join(',')}`),
        ]
        console.log(`[bkp ${doorId}] cfcBkp=${out.cfcBkp} keys=${allKeys.join(' | ')}`)
    }
    return out
}

export interface DoorAnalyzerCaches {
    wallIndex: ReturnType<typeof buildPlanIndex>
    slabIndex: ReturnType<typeof buildPlanIndex>
    /** Plan-radius index for IFCBUILDINGELEMENTPART entities — Unterlagsboden,
     *  Estrich/Chape, Dämmung, finish layers etc.  In Flu21 these aren't
     *  aggregated under the structural slab; they're standalone elements
     *  whose horizontal mesh sits on top of (or hanging below) the slab. */
    buildingPartIndex: ReturnType<typeof buildPlanIndex>
    /** Plan-radius index for IFCCOVERING entities — floor finishes, ceiling
     *  finishes (suspended ceilings).  Same modelling pattern as
     *  buildingPartIndex; needed for the floor-stack rendering. */
    coveringIndex: ReturnType<typeof buildPlanIndex>
    doorIndex: ReturnType<typeof buildPlanIndex>
    windowIndex: ReturnType<typeof buildPlanIndex>
    elecIndices: Map<string, ReturnType<typeof buildPlanIndex>> | null
}

/** Build per-model spatial caches once per round (expensive: ~50ms / model). */
export function buildAnalyzerCaches(model: IfcLiteModel, elec: IfcLiteModel | null): DoorAnalyzerCaches {
    const wallIndex = buildPlanIndex(model, 'IFCWALL', 1.5)
    // Some IFC4 walls are flagged as IFCWALLSTANDARDCASE — merge.
    const wallStdIds = model.byType('IFCWALLSTANDARDCASE')
    if (wallStdIds.length > 0) {
        const stdIndex = buildPlanIndex(model, 'IFCWALLSTANDARDCASE', 1.5)
        for (const [k, arr] of stdIndex.bins) {
            const merged = wallIndex.bins.get(k) ?? []
            wallIndex.bins.set(k, [...merged, ...arr])
        }
    }
    const slabIndex = buildPlanIndex(model, 'IFCSLAB', 2.0)
    const buildingPartIndex = buildPlanIndex(model, 'IFCBUILDINGELEMENTPART', 1.5)
    const coveringIndex = buildPlanIndex(model, 'IFCCOVERING', 1.5)
    const doorIndex = buildPlanIndex(model, 'IFCDOOR', 1.0)
    const windowIndex = buildPlanIndex(model, 'IFCWINDOW', 1.0)
    const elecIndices = elec ? new Map<string, ReturnType<typeof buildPlanIndex>>() : null
    if (elec && elecIndices) {
        for (const t of [
            'IFCELECTRICAPPLIANCE',
            'IFCOUTLET',
            'IFCLAMP',
            'IFCFLOWFITTING',
            'IFCFLOWTERMINAL',
            'IFCFLOWSEGMENT',
            'IFCDISCRETEACCESSORY',
            'IFCSWITCHINGDEVICE',
            'IFCSENSOR',
        ]) {
            elecIndices.set(t, buildPlanIndex(elec, t, 1.0))
        }
    }
    return { wallIndex, slabIndex, buildingPartIndex, coveringIndex, doorIndex, windowIndex, elecIndices }
}

export function analyzeDoor(
    model: IfcLiteModel,
    doorId: number,
    caches: DoorAnalyzerCaches,
    elec: IfcLiteModel | null = null,
    options: AnalyzeOptions = {}
): DoorContextLite | null {
    const opts = { ...DEFAULT_OPTS, ...options }
    const meshes = model.meshesByExpressId.get(doorId)
    if (!meshes || meshes.length === 0) return null
    const bbox = bboxOfMeshes(meshes)
    if (!bbox) return null
    const attrs = model.attrs(doorId)
    const guid = attrs?.globalId ?? `expressId-${doorId}`
    const name = attrs?.name ?? ''
    const storey = model.storeyOf(doorId)
    const placementYAxis = readDoorPlacementYAxis(model.parserMod, model.store, doorId)
    const viewFrame = buildDoorViewFrame(bbox, placementYAxis)

    const relationHostWallId = findHostWallExpressId(model, doorId)
    const bboxFallbackHostWallId = findHostWallByBBox(model, bbox, caches.wallIndex, viewFrame)
    let hostWallId = relationHostWallId
    if (hostWallId == null) {
        hostWallId = bboxFallbackHostWallId
    }
    let hostWall: DoorContextLite['hostWall'] = null
    if (hostWallId != null) {
        const wMeshes = model.meshesByExpressId.get(hostWallId)
        if (wMeshes && wMeshes.length > 0) {
            const wBbox = bboxOfMeshes(wMeshes)
            if (wBbox) hostWall = { expressId: hostWallId, meshes: wMeshes, bbox: wBbox }
        }
    }

    const slabs = findSlabsAroundDoor(model, bbox, caches.slabIndex, caches.buildingPartIndex)
    const centre = bboxCentre(bbox)

    const collectParts = (slabId: number | null | undefined): Array<{ expressId: number; meshes: IfcLiteMesh[]; bbox: AABB }> => {
        if (slabId == null) return []
        const out: Array<{ expressId: number; meshes: IfcLiteMesh[]; bbox: AABB }> = []
        for (const childId of model.aggregatedChildren(slabId)) {
            const childType = (model.typeOf(childId) ?? '').toUpperCase()
            if (childType !== 'IFCBUILDINGELEMENTPART') continue
            const meshes = model.meshesByExpressId.get(childId)
            if (!meshes || meshes.length === 0) continue
            const partBbox = bboxOfMeshes(meshes)
            if (!partBbox) continue
            out.push({ expressId: childId, meshes, bbox: partBbox })
        }
        return out
    }
    // Floor / ceiling stack parts come from FOUR places, in priority order:
    //   1. IfcRelAggregates children of the structural slab
    //      (rare in Flu21, but other authors model build-up that way)
    //   2. Other IFCSLABs stacked above/below structural in plan radius
    //   3. IFCBUILDINGELEMENTPART entities (Chapes/Unterlagsboden, Dämmung,
    //      Bodenbeläge) — Flu21's modelling pattern.  Standalone, NOT
    //      aggregated under the slab.
    //   4. IFCCOVERING entities (floor finish, suspended ceiling)
    //
    // The render code stacks them as horizontal bands on top of the
    // structural slab cap, so seeing all four types is essential.
    const aggParts = (id: number | null | undefined) =>
        id == null ? [] : collectParts(id)
    /** Pick standalone build-up parts whose bbox-Y range falls inside
     *  [yLo, yHi] and whose plan footprint is within `radius` of the door. */
    const collectBuildupParts = (
        index: ReturnType<typeof buildPlanIndex>,
        yLo: number,
        yHi: number,
        radius: number,
    ): Array<{ expressId: number; meshes: IfcLiteMesh[]; bbox: AABB }> => {
        const out: Array<{ expressId: number; meshes: IfcLiteMesh[]; bbox: AABB }> = []
        for (const cand of queryPlanIndex(index, centre, radius)) {
            // Use overlap instead of midpoint so thin layers touching the band
            // edge are still collected (e.g. 00GW... around -0.60/-0.55).
            const yPass = cand.bbox.max[1] >= yLo - 0.005 && cand.bbox.min[1] <= yHi + 0.005
            if (!yPass) continue
            out.push({ expressId: cand.expressId, meshes: cand.meshes, bbox: cand.bbox })
        }
        return out
    }
    // Below stack: structural top → door foot (typically 0–25 cm of build-up).
    const belowYLo = slabs.below ? slabs.below.bbox.max[1] - 0.01 : bbox.min[1] - 0.50
    const belowYHi = bbox.min[1] + 0.05
    const belowBuildup = [
        ...collectBuildupParts(caches.buildingPartIndex, belowYLo, belowYHi, 1.6),
        ...collectBuildupParts(caches.coveringIndex, belowYLo, belowYHi, 1.6),
    ]
    // Above stack: door head → slab-above bottom (suspended ceiling, finish).
    // Include ceiling build-up layers that can sit up to ~30 cm below door head.
    // This captures thin suspended layers like 00GW... that were previously
    // excluded by the narrow -0.05 m band.
    const aboveYLo = bbox.max[1] - 0.30
    const aboveYHi = slabs.above ? slabs.above.bbox.min[1] + 0.01 : bbox.max[1] + 1.5
    const aboveBuildup = [
        ...collectBuildupParts(caches.buildingPartIndex, aboveYLo, aboveYHi, 1.6),
        ...collectBuildupParts(caches.coveringIndex, aboveYLo, aboveYHi, 1.6),
    ]
    const slabBelowParts = [
        ...aggParts(slabs.below?.expressId),
        ...slabs.belowExtras,
        ...belowBuildup,
    ]
    const slabAboveParts = [
        ...aggParts(slabs.above?.expressId),
        ...slabs.aboveExtras,
        ...aboveBuildup,
    ]
    if (process.env.DEBUG_PARTS === '1') {
        console.log(`[parts] door=${doorId} slabBelow=${slabs.below?.expressId ?? 'none'} top=${slabs.below?.bbox.max[1].toFixed(3) ?? 'none'} doorBottom=${bbox.min[1].toFixed(3)} belowParts=${slabBelowParts.length} (extras=${slabs.belowExtras.length} buildup=${belowBuildup.length}) slabAbove=${slabs.above?.expressId ?? 'none'} aboveBot=${slabs.above?.bbox.min[1].toFixed(3) ?? 'none'} doorTop=${bbox.max[1].toFixed(3)} aboveParts=${slabAboveParts.length}`)
        for (const p of belowBuildup) {
            console.log(`  below buildup #${p.expressId} Y[${p.bbox.min[1].toFixed(3)}, ${p.bbox.max[1].toFixed(3)}]`)
        }
    }

    const radius = opts.neighbourPlanRadius
    const planCutY = viewFrame.origin[1] + PLAN_CUT_HEIGHT_METERS
    const filterY = (cand: { bbox: AABB }) =>
        cand.bbox.max[1] >= bbox.min[1] - opts.neighbourElevationOverlap
        && cand.bbox.min[1] <= bbox.max[1] + opts.neighbourElevationOverlap
    // Some storeys model architectural wall skins/splits as IFCBUILDINGELEMENTPART
    // instead of IFCWALL/IFCWALLSTANDARDCASE. Include only "wall-like" parts:
    // - must cross the plan cut band
    // - must be vertically tall
    // - must have one reasonably thin horizontal axis (wall thickness proxy)
    // This keeps floor/ceiling build-up layers out of nearbyWalls.
    const isWallLikeBuildingPart = (cand: { bbox: AABB }): boolean => {
        const cutTol = 0.08
        if (cand.bbox.max[1] < planCutY - cutTol) return false
        if (cand.bbox.min[1] > planCutY + cutTol) return false
        const [sx, sy, sz] = bboxExtents(cand.bbox)
        const horizMin = Math.min(sx, sz)
        const horizMax = Math.max(sx, sz)
        if (sy < 1.0) return false
        if (horizMin > 0.7) return false
        if (horizMax < 0.5) return false
        return true
    }
    // Device candidate pool must support ALL views:
    //   - plan needs devices from door bottom up to clip plane
    //   - elevation needs context above the plan cut (e.g. BMA/KNX near ceiling)
    // Keep this broad and let each renderer apply its own final clip.
    const elevationDeviceTopY = bbox.max[1] + 1.0
    const deviceCandidateTopY = Math.max(planCutY, elevationDeviceTopY)
    const filterDeviceCandidateBandY = (cand: { bbox: AABB }) =>
        cand.bbox.max[1] >= bbox.min[1] - 0.1
        && cand.bbox.min[1] <= deviceCandidateTopY

    const nearbyWallsFromWallTypes = queryPlanIndex(caches.wallIndex, centre, radius)
        .filter((c) => c.expressId !== hostWallId)
        .filter(filterY)
        .map((c) => ({
            expressId: c.expressId,
            meshes: c.meshes,
            bbox: c.bbox,
            guid: model.attrs(c.expressId)?.globalId ?? null,
        }))
    const nearbyWallsFromWallLikeParts = queryPlanIndex(caches.buildingPartIndex, centre, radius)
        .filter((c) => c.expressId !== hostWallId)
        .filter(filterY)
        .filter(isWallLikeBuildingPart)
        .map((c) => ({
            expressId: c.expressId,
            meshes: c.meshes,
            bbox: c.bbox,
            guid: model.attrs(c.expressId)?.globalId ?? null,
        }))
    const nearbyWalls = [...nearbyWallsFromWallTypes]
    for (const part of nearbyWallsFromWallLikeParts) {
        if (nearbyWalls.some((w) => w.expressId === part.expressId)) continue
        nearbyWalls.push(part)
    }
    const nearbyDoors = queryPlanIndex(caches.doorIndex, centre, radius)
        .filter((c) => c.expressId !== doorId)
        .filter(filterY)
        .map((c) => ({
            expressId: c.expressId,
            meshes: c.meshes,
            bbox: c.bbox,
            cfcBkp: readDoorBkp(model, c.expressId),
        }))

    const nearbyWindows = queryPlanIndex(caches.windowIndex, centre, radius)
        .filter(filterY)
        .map((c) => ({ expressId: c.expressId, meshes: c.meshes, bbox: c.bbox }))

    const nearbyDevices: DoorContextLite['nearbyDevices'] = []
    const elecIndices = caches.elecIndices
    if (elec && elecIndices) {
        for (const [t, idx] of elecIndices.entries()) {
            const found = queryPlanIndex(idx, centre, radius).filter(filterDeviceCandidateBandY)
            for (const item of found) {
                const a = elec.attrs(item.expressId)
                nearbyDevices.push({
                    expressId: item.expressId,
                    meshes: item.meshes,
                    bbox: item.bbox,
                    ifcType: t.replace('IFC', 'Ifc'),
                    name: a?.name ?? '',
                    modelTag: 'elec',
                })
            }
        }
    }

    return {
        door: { expressId: doorId, meshes, bbox },
        guid,
        name,
        storeyName: storey?.name ?? null,
        storeyElevation: storey?.elevation ?? null,
        viewFrame,
        hostWall,
        slabBelow: slabs.below,
        slabAbove: slabs.above,
        slabBelowParts,
        slabAboveParts,
        nearbyWalls,
        nearbyDoors,
        nearbyWindows,
        nearbyDevices,
        cset: readCsetData(model, doorId),
        operationType: readOperationType(model, doorId),
        placementYAxis,
    }
}
