/**
 * Read a door's IFC-native `placementYAxis` (the door's local +Y axis in
 * IFC's Z-up world) by walking the IfcLocalPlacement chain via the
 * @ifc-lite parser's on-demand entity extraction.
 *
 * IFC4 LEFT/RIGHT swing handedness is defined "as viewed in the direction
 * of the positive y-axis", so the renderer needs this to detect when its
 * bbox-derived facing direction points OPPOSITE to the IFC's localY and
 * the swing arc must be mirrored.
 */

interface IfcLiteParserModule {
    parseEntityOnDemand(
        source: Uint8Array,
        entityRef: { byteOffset: number; byteLength: number; expressId: number; type: string },
    ): { expressId: number; type: string; attributes: unknown[] } | null
}

type Vec3 = [number, number, number]
type Mat3 = [Vec3, Vec3, Vec3]

const IDENT3: Mat3 = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
]

function normalize(v: Vec3): Vec3 {
    const len = Math.hypot(v[0], v[1], v[2])
    if (len < 1e-12) return [0, 0, 0]
    return [v[0] / len, v[1] / len, v[2] / len]
}

function cross(a: Vec3, b: Vec3): Vec3 {
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

function matMul(A: Mat3, B: Mat3): Mat3 {
    const C: Mat3 = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
    ]
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            let s = 0
            for (let k = 0; k < 3; k++) s += A[i][k] * B[k][j]
            C[i][j] = s
        }
    }
    return C
}

interface ParserStore {
    source: Uint8Array
    entityIndex: {
        byId: Map<number, { byteOffset: number; byteLength: number; expressId: number; type: string }>
    }
}

/** Read attribute as Vec3.  IFCDIRECTION's first attribute is `(x, y, z)`,
 *  which the parser returns as a number[] of length 2 or 3. */
function readDirection(attr: unknown): Vec3 | null {
    if (!Array.isArray(attr)) return null
    const a = attr as number[]
    return [
        typeof a[0] === 'number' ? a[0] : 0,
        typeof a[1] === 'number' ? a[1] : 0,
        typeof a[2] === 'number' ? a[2] : 0,
    ]
}

function rotFromAxis2(
    parserMod: IfcLiteParserModule,
    store: ParserStore,
    axis2Id: number,
): Mat3 {
    const ref = store.entityIndex.byId.get(axis2Id)
    if (!ref) return IDENT3
    const e = parserMod.parseEntityOnDemand(store.source, ref)
    if (!e || e.type.toUpperCase() !== 'IFCAXIS2PLACEMENT3D') return IDENT3
    const attrs = e.attributes
    // (Location, Axis, RefDirection)
    const axisId = typeof attrs[1] === 'number' ? (attrs[1] as number) : null
    const refDirId = typeof attrs[2] === 'number' ? (attrs[2] as number) : null
    let zAxis: Vec3 = [0, 0, 1]
    let xAxis: Vec3 = [1, 0, 0]
    if (axisId != null) {
        const axisRef = store.entityIndex.byId.get(axisId)
        if (axisRef) {
            const ae = parserMod.parseEntityOnDemand(store.source, axisRef)
            if (ae && ae.type.toUpperCase() === 'IFCDIRECTION') {
                const v = readDirection(ae.attributes[0])
                if (v) zAxis = v
            }
        }
    }
    if (refDirId != null) {
        const refRef = store.entityIndex.byId.get(refDirId)
        if (refRef) {
            const re = parserMod.parseEntityOnDemand(store.source, refRef)
            if (re && re.type.toUpperCase() === 'IFCDIRECTION') {
                const v = readDirection(re.attributes[0])
                if (v) xAxis = v
            }
        }
    }
    zAxis = normalize(zAxis)
    // Project xAxis onto plane ⟂ zAxis to get the actual local +X.
    const dot = xAxis[0] * zAxis[0] + xAxis[1] * zAxis[1] + xAxis[2] * zAxis[2]
    const xPerp = normalize([
        xAxis[0] - dot * zAxis[0],
        xAxis[1] - dot * zAxis[1],
        xAxis[2] - dot * zAxis[2],
    ])
    const yAxis = normalize(cross(zAxis, xPerp))
    // Columns are (xPerp, yAxis, zAxis): rotation maps local→parent.
    return [
        [xPerp[0], yAxis[0], zAxis[0]],
        [xPerp[1], yAxis[1], zAxis[1]],
        [xPerp[2], yAxis[2], zAxis[2]],
    ]
}

function composeWorldRotation(
    parserMod: IfcLiteParserModule,
    store: ParserStore,
    placementId: number,
): Mat3 {
    let R: Mat3 = IDENT3
    let cur: number | null = placementId
    let depth = 0
    while (cur != null && depth < 32) {
        const ref = store.entityIndex.byId.get(cur)
        if (!ref) break
        const e = parserMod.parseEntityOnDemand(store.source, ref)
        if (!e || e.type.toUpperCase() !== 'IFCLOCALPLACEMENT') break
        const attrs = e.attributes
        // (PlacementRelTo, RelativePlacement)
        const placementRelTo = typeof attrs[0] === 'number' ? (attrs[0] as number) : null
        const relPlacement = typeof attrs[1] === 'number' ? (attrs[1] as number) : null
        if (relPlacement == null) break
        const Rlocal = rotFromAxis2(parserMod, store, relPlacement)
        // Walking up: door_world = parent_world * child_local.  Accumulate
        // outer (parent) on the left.
        R = matMul(Rlocal, R)
        cur = placementRelTo
        depth++
    }
    return R
}

/** Read the door's local +Y axis in IFC-native (Z-up) world coords.
 *  Returns null when the placement chain can't be resolved. */
export function readDoorPlacementYAxis(
    parserMod: IfcLiteParserModule,
    store: ParserStore,
    doorExpressId: number,
): Vec3 | null {
    const R = readDoorPlacementRotation(parserMod, store, doorExpressId)
    if (!R) return null
    return normalize([R[0][1], R[1][1], R[2][1]])
}

/** Read the door's local +X axis in IFC-native (Z-up) world coords.
 *  Used together with localY to orient viewFrame.widthAxis so left/right
 *  swing handedness matches IFC. */
export function readDoorPlacementXAxis(
    parserMod: IfcLiteParserModule,
    store: ParserStore,
    doorExpressId: number,
): Vec3 | null {
    const R = readDoorPlacementRotation(parserMod, store, doorExpressId)
    if (!R) return null
    return normalize([R[0][0], R[1][0], R[2][0]])
}

function readDoorPlacementRotation(
    parserMod: IfcLiteParserModule,
    store: ParserStore,
    doorExpressId: number,
): Mat3 | null {
    const ref = store.entityIndex.byId.get(doorExpressId)
    if (!ref) return null
    const e = parserMod.parseEntityOnDemand(store.source, ref)
    if (!e) return null
    const t = e.type.toUpperCase()
    if (t !== 'IFCDOOR' && t !== 'IFCDOORSTANDARDCASE') return null
    const placementId = typeof e.attributes[5] === 'number' ? (e.attributes[5] as number) : null
    if (placementId == null) return null
    return composeWorldRotation(parserMod, store, placementId)
}
