/**
 * IFC-Lite placement helpers.
 *
 * Reads an IfcDoor ObjectPlacement chain (IfcLocalPlacement ->
 * Axis2Placement3D/2D) and returns local +Y in IFC-native coordinates (Z-up).
 */
type Vec3 = [number, number, number]
type Basis = { x: Vec3; y: Vec3; z: Vec3 }
type ParsedEntity = { expressId: number; type: string; attributes: unknown[] }

const EPS = 1e-8
const IDENTITY_BASIS: Basis = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }

function dot(a: Vec3, b: Vec3): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function cross(a: Vec3, b: Vec3): Vec3 {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function sub(a: Vec3, b: Vec3): Vec3 {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function mul(a: Vec3, s: number): Vec3 {
    return [a[0] * s, a[1] * s, a[2] * s]
}

function normalize(v: Vec3): Vec3 | null {
    const ls = dot(v, v)
    if (ls <= EPS) return null
    const inv = 1 / Math.sqrt(ls)
    return [v[0] * inv, v[1] * inv, v[2] * inv]
}

function choosePerpendicular(v: Vec3): Vec3 {
    const seed: Vec3 = Math.abs(v[0]) < 0.75 ? [1, 0, 0] : [0, 1, 0]
    return normalize(cross(v, seed)) ?? [0, 1, 0]
}

function transformByBasis(b: Basis, v: Vec3): Vec3 {
    return [
        b.x[0] * v[0] + b.y[0] * v[1] + b.z[0] * v[2],
        b.x[1] * v[0] + b.y[1] * v[1] + b.z[1] * v[2],
        b.x[2] * v[0] + b.y[2] * v[1] + b.z[2] * v[2],
    ]
}

function multiplyBasis(parent: Basis, local: Basis): Basis {
    return {
        x: normalize(transformByBasis(parent, local.x)) ?? parent.x,
        y: normalize(transformByBasis(parent, local.y)) ?? parent.y,
        z: normalize(transformByBasis(parent, local.z)) ?? parent.z,
    }
}

function readRefId(raw: unknown): number | null {
    if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw
    return null
}

function readDirection(raw: unknown): Vec3 | null {
    if (!Array.isArray(raw)) return null
    const nums = raw
        .map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null))
        .filter((n): n is number => n != null)
    if (nums.length >= 3) return normalize([nums[0], nums[1], nums[2]])
    if (nums.length === 2) return normalize([nums[0], nums[1], 0])
    return null
}

export function readDoorPlacementYAxis(parserMod: any, store: any, doorExpressId: number): Vec3 | null {
    if (!parserMod || !store || !Number.isFinite(doorExpressId)) return null
    if (typeof parserMod.parseEntityOnDemand !== 'function') return null

    const entityCache = new Map<number, ParsedEntity | null>()
    const basisCache = new Map<number, Basis | null>()

    const parseEntity = (id: number): ParsedEntity | null => {
        if (!Number.isInteger(id) || id <= 0) return null
        if (entityCache.has(id)) return entityCache.get(id) ?? null
        try {
            const ref = store.entityIndex?.byId?.get(id) ?? store.deferredEntityIndex?.get?.(id)
            if (!ref || !store.source) {
                entityCache.set(id, null)
                return null
            }
            const parsed = parserMod.parseEntityOnDemand(store.source, ref) as ParsedEntity | null
            entityCache.set(id, parsed ?? null)
            return parsed ?? null
        } catch {
            entityCache.set(id, null)
            return null
        }
    }

    const directionFromRef = (rawRef: unknown): Vec3 | null => {
        const dirId = readRefId(rawRef)
        if (dirId == null) return readDirection(rawRef)
        const ent = parseEntity(dirId)
        if (!ent) return null
        // IfcDirection(DirectionRatios)
        if (ent.type.toUpperCase() === 'IFCDIRECTION') {
            return readDirection(ent.attributes[0])
        }
        // Some schemas wrap vectors as [TypeName, value].
        if (Array.isArray(ent.attributes[0]) && ent.attributes[0].length === 2) {
            return readDirection((ent.attributes[0] as unknown[])[1])
        }
        return null
    }

    const basisFromAxisPlacement = (axisPlacementId: number): Basis | null => {
        const ent = parseEntity(axisPlacementId)
        if (!ent) return null
        const t = ent.type.toUpperCase()

        let z: Vec3 = [0, 0, 1]
        let x: Vec3 = [1, 0, 0]
        if (t === 'IFCAXIS2PLACEMENT3D') {
            z = directionFromRef(ent.attributes[1]) ?? z
            x = directionFromRef(ent.attributes[2]) ?? x
        } else if (t === 'IFCAXIS2PLACEMENT2D') {
            // 2D placement lives in the XY plane of IFC world.
            z = [0, 0, 1]
            x = directionFromRef(ent.attributes[1]) ?? x
            x = [x[0], x[1], 0]
        } else {
            return null
        }

        const zN = normalize(z)
        if (!zN) return null
        z = zN

        let xN = normalize(sub(x, mul(z, dot(x, z))))
        if (!xN) xN = choosePerpendicular(z)
        x = xN

        let y = normalize(cross(z, x))
        if (!y) return null
        x = normalize(cross(y, z)) ?? x
        y = normalize(cross(z, x)) ?? y
        return { x, y, z }
    }

    const basisFromLocalPlacement = (placementId: number, depth = 0): Basis | null => {
        if (depth > 48) return null
        if (basisCache.has(placementId)) return basisCache.get(placementId) ?? null

        const ent = parseEntity(placementId)
        if (!ent || ent.type.toUpperCase() !== 'IFCLOCALPLACEMENT') {
            basisCache.set(placementId, null)
            return null
        }

        const parentId = readRefId(ent.attributes[0])
        const relPlacementId = readRefId(ent.attributes[1])

        const parentBasis =
            parentId != null
                ? (basisFromLocalPlacement(parentId, depth + 1) ?? IDENTITY_BASIS)
                : IDENTITY_BASIS
        const localBasis =
            relPlacementId != null
                ? (basisFromAxisPlacement(relPlacementId) ?? IDENTITY_BASIS)
                : IDENTITY_BASIS

        const combined = multiplyBasis(parentBasis, localBasis)
        basisCache.set(placementId, combined)
        return combined
    }

    // IfcProduct.ObjectPlacement is the 6th attribute (0-based index 5).
    let objectPlacementId: number | null = null
    const door = parseEntity(doorExpressId)
    if (door && Array.isArray(door.attributes) && door.attributes.length > 5) {
        objectPlacementId = readRefId(door.attributes[5])
    }

    // Extra fallback: scan door attributes for a ref that parses as IfcLocalPlacement.
    if (objectPlacementId == null && door) {
        for (const attr of door.attributes) {
            const refId = readRefId(attr)
            if (refId == null) continue
            const candidate = parseEntity(refId)
            if (candidate?.type.toUpperCase() === 'IFCLOCALPLACEMENT') {
                objectPlacementId = refId
                break
            }
        }
    }

    if (objectPlacementId == null) return null
    const basis = basisFromLocalPlacement(objectPlacementId)
    const yAxis = basis?.y ?? null
    return yAxis
}
