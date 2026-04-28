/**
 * Bridge to local @ifc-lite/* packages.
 *
 * IFC-Lite is published as ESM and its WASM build expects to be initialised
 * with a Buffer (we bypass the fetch path the package's wrapper uses for
 * browsers). All other repo code is CommonJS via ts-node, so this module uses
 * dynamic `import()` against the source `dist/index.js` files in the sibling
 * `/Users/louistrue/Development/ifc-lite` checkout.
 *
 * Per-mesh geometry is copied out of WASM-owned typed-arrays before we hand
 * them back so the caller can free `IfcAPI`/`MeshCollection` immediately and
 * avoid keeping the entire model resident across long renders.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const IFC_LITE_ROOT = resolve(__dirname, '..', '..', 'ifc-lite')
const WASM_JS = `file://${resolve(IFC_LITE_ROOT, 'packages/wasm/pkg/ifc-lite.js')}`
const WASM_FILE = resolve(IFC_LITE_ROOT, 'packages/wasm/pkg/ifc-lite_bg.wasm')
const PARSER_JS = `file://${resolve(IFC_LITE_ROOT, 'packages/parser/dist/index.js')}`

export interface IfcLiteMesh {
    expressId: number
    ifcType: string
    /** xyz triplets, Y-up world coords (RTC offset already subtracted). */
    positions: Float32Array
    /** Triangle indices into `positions`. May be null if mesh is unindexed. */
    indices: Uint32Array | null
    /** Per-vertex normals (xyz triplets) aligned with `positions`. */
    normals: Float32Array
    /** Optional default colour from WASM `[r,g,b,a]` floats 0-1. */
    color: Float32Array
}

export interface IfcLiteRelationships {
    voids: Array<{ id: number; type: string; name?: string }>
    fills: Array<{ id: number; type: string; name?: string }>
    groups: Array<{ id: number; name?: string }>
    connections: Array<{ id: number; type: string; name?: string }>
}

export interface IfcLitePset {
    name: string
    properties: Record<string, string | number | boolean | null>
}

export interface IfcLiteEntityAttrs {
    globalId: string
    name: string
    description: string
    objectType: string
    tag: string
}

export interface IfcLiteSpatialEntry {
    name: string
    type: string
    expressId: number
    elevation?: number | null
    children: number[]
}

export interface IfcLiteModel {
    /** Source file path (debug only). */
    sourcePath: string
    /** Map keyed by expressId — one element may have many sub-meshes. */
    meshesByExpressId: Map<number, IfcLiteMesh[]>
    /** All meshes in original WASM order. */
    allMeshes: IfcLiteMesh[]
    /** RTC offset that was subtracted from raw IFC coords (Y-up world space). */
    rtcOffset: { x: number; y: number; z: number }
    /** ifc-lite parser store (pset/rel access). */
    store: any
    schemaVersion: string
    byType(type: string): number[]
    attrs(expressId: number): IfcLiteEntityAttrs | null
    relationships(expressId: number): IfcLiteRelationships
    psets(expressId: number): IfcLitePset[]
    /** Psets defined on the entity's IfcType (via IfcRelDefinesByType).  Some
     *  Cset_StandardCH props (BKP/CFC) live on the door type, not the
     *  instance — without this the renderer can't pick the wood/metal/wood
     *  door colour. */
    typePsets(expressId: number): IfcLitePset[]
    /** Spatial container (storey) name + elevation for an element, or null. */
    storeyOf(expressId: number): { name: string; elevation: number | null } | null
    /** IfcRelAggregates children of `expressId` (e.g. slab → IfcBuildingElementParts).
     *  Used to render Unterlagsboden / floor build-up bands on top of the
     *  structural slab in elevation views. */
    aggregatedChildren(expressId: number): number[]
    /** IFC type name (e.g. "IFCDOOR") for `expressId`, or null if unknown. */
    typeOf(expressId: number): string | null
    /** All named string/enum attributes (from IFC schema) for an entity.
     *  Used to read IfcDoor.OperationType / IfcDoorType.OperationType. */
    namedAttrs(expressId: number): Array<{ name: string; value: string }>
    /** The IfcType entity id linked to this instance via IfcRelDefinesByType,
     *  or null if none. */
    typeOfInstance(expressId: number): number | null
}

// ts-node in CJS mode rewrites `import()` to `require()`, which can't handle
// `file://` URLs and can't load ESM. Use the Function-constructor escape to
// keep a real dynamic import that goes through Node's ESM loader.
// eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-explicit-any
const dynamicImport = new Function('u', 'return import(u)') as (url: string) => Promise<any>

let cachedWasm: any = null

async function loadWasm(): Promise<any> {
    if (cachedWasm) return cachedWasm
    const wasm = await dynamicImport(WASM_JS)
    const wasmBuf = readFileSync(WASM_FILE)
    await wasm.default(wasmBuf)
    cachedWasm = wasm
    return wasm
}

/**
 * Filter the noisy `[IFC-LITE]` per-entity warnings ifc-lite prints to stdout.
 * Restored by the returned function.
 */
export function silenceIfcLiteChatter(): () => void {
    const origLog = console.log.bind(console)
    const origWarn = console.warn.bind(console)
    const drop = (args: unknown[]) =>
        typeof args[0] === 'string' && (args[0].startsWith('[IFC-LITE]') || args[0].startsWith('[IfcParser]') || args[0].startsWith('[parseLite]'))
    console.log = (...args: unknown[]) => { if (!drop(args)) origLog(...(args as [unknown, ...unknown[]])) }
    console.warn = (...args: unknown[]) => { if (!drop(args)) origWarn(...(args as [unknown, ...unknown[]])) }
    return () => {
        console.log = origLog
        console.warn = origWarn
    }
}

function copyMeshFromWasm(m: any): IfcLiteMesh {
    return {
        expressId: m.expressId,
        ifcType: m.ifcType,
        positions: new Float32Array(m.positions),
        indices: m.indices ? new Uint32Array(m.indices) : null,
        normals: new Float32Array(m.normals),
        color: new Float32Array(m.color),
    }
}

export async function loadIfcLiteModel(path: string): Promise<IfcLiteModel> {
    const restoreLog = silenceIfcLiteChatter()
    try {
        const wasm = await loadWasm()
        const parserMod = await dynamicImport(PARSER_JS)
        const ifcText = readFileSync(path, 'utf8')

        const api = new wasm.IfcAPI()
        const meshCollection = api.parseMeshes(ifcText)
        const rtcOffset = {
            x: meshCollection.rtcOffsetX,
            y: meshCollection.rtcOffsetY,
            z: meshCollection.rtcOffsetZ,
        }

        const allMeshes: IfcLiteMesh[] = []
        const meshesByExpressId = new Map<number, IfcLiteMesh[]>()
        for (let i = 0; i < meshCollection.length; i++) {
            const raw = meshCollection.get(i)
            const copy = copyMeshFromWasm(raw)
            allMeshes.push(copy)
            const list = meshesByExpressId.get(copy.expressId) ?? []
            list.push(copy)
            meshesByExpressId.set(copy.expressId, list)
            raw.free?.()
        }
        meshCollection.free?.()
        api.free?.()

        // 2. parseColumnar for relationships/psets/spatial. Re-read the file
        //    as ArrayBuffer (the columnar parser wants raw bytes).
        const arrBuf = readFileSync(path).buffer.slice(0)
        const parser = new parserMod.IfcParser()
        const store = await parser.parseColumnar(arrBuf)

        // Build a containment map: element expressId → spatial container
        // expressId by walking IFCRELCONTAINEDINSPATIALSTRUCTURE.
        const containerByElement = new Map<number, number>()
        const relIds = store.entityIndex.byType.get('IFCRELCONTAINEDINSPATIALSTRUCTURE') ?? []
        for (const relId of relIds) {
            const attrs = parserMod.extractAllEntityAttributes(store, relId)
            // The relationship attributes don't expose RelatedElements/RelatingStructure.
            // Fall back to the structured relationship graph stored on the store.
        }
        // Fallback: walk the relationship graph on the store.
        try {
            const relsByRelating: Map<number, number[]> | undefined = store.relationships?.byRelating
            const relsByRelated: Map<number, number[]> | undefined = store.relationships?.byRelated
            // Best effort: the columnar relationships index uses different
            // shapes per parser version. We use the spatial hierarchy below.
            void relsByRelating
            void relsByRelated
        } catch {
            /* ignore */
        }

        // Build storey map from spatialHierarchy. Schema (per @ifc-lite/data):
        //   elementToStorey: Map<elementId, storeyId>
        //   storeyElevations: Map<storeyId, number>
        //   project: SpatialNode tree — walk to map storeyId → SpatialNode for the name.
        const storeyOfElement = new Map<number, { name: string; elevation: number | null }>()
        const sh = store.spatialHierarchy
        if (sh) {
            const storeyNodeById = new Map<number, { name: string; elevation: number | null }>()
            // IfcTypeEnum.IfcBuildingStorey = 4 in @ifc-lite/data.
            // Some parser versions stash an int enum here; others a string.
            const walkNode = (node: any) => {
                if (!node) return
                const t = node.type
                const isStorey =
                    t === 4
                    || t === 'IfcBuildingStorey'
                    || t === 'IFCBUILDINGSTOREY'
                if (isStorey) {
                    let storeyName = ''
                    if (typeof node.name === 'string') storeyName = node.name
                    else if (typeof node.longName === 'string' && node.longName) storeyName = node.longName
                    // Some parser versions use an entity-attribute lookup. Fall back
                    // to the columnar parser's on-demand attrs so we capture stories
                    // whose name was elided from the SpatialNode itself.
                    if (!storeyName) {
                        try {
                            const a = parserMod.extractEntityAttributesOnDemand(store, node.expressId)
                            if (a?.name) storeyName = a.name
                        } catch { /* ignore */ }
                    }
                    storeyNodeById.set(node.expressId, {
                        name: storeyName,
                        elevation: typeof node.elevation === 'number' ? node.elevation : null,
                    })
                }
                if (Array.isArray(node.children)) for (const c of node.children) walkNode(c)
            }
            if (sh.project) walkNode(sh.project)
            // elementToStorey may be a Map (preferred) or undefined.
            const e2s: Map<number, number> | undefined = sh.elementToStorey
            if (e2s instanceof Map) {
                for (const [elemId, storeyId] of e2s.entries()) {
                    let info = storeyNodeById.get(storeyId)
                    if (!info && sh.storeyElevations instanceof Map) {
                        info = { name: '', elevation: sh.storeyElevations.get(storeyId) ?? null }
                    }
                    if (info) storeyOfElement.set(elemId, info)
                }
            } else if (sh.byStorey instanceof Map) {
                for (const [storeyId, elementIds] of sh.byStorey.entries()) {
                    const info = storeyNodeById.get(storeyId) ?? { name: '', elevation: null }
                    for (const id of elementIds) storeyOfElement.set(id, info)
                }
            }
        }

        const byType = (type: string): number[] => store.entityIndex.byType.get(type.toUpperCase()) ?? []

        const attrsCache = new Map<number, IfcLiteEntityAttrs | null>()
        const attrs = (expressId: number): IfcLiteEntityAttrs | null => {
            if (attrsCache.has(expressId)) return attrsCache.get(expressId)!
            try {
                const out = parserMod.extractEntityAttributesOnDemand(store, expressId) as IfcLiteEntityAttrs
                attrsCache.set(expressId, out ?? null)
                return out ?? null
            } catch {
                attrsCache.set(expressId, null)
                return null
            }
        }

        const relationships = (expressId: number): IfcLiteRelationships => {
            try {
                const r = parserMod.extractRelationshipsOnDemand(store, expressId) as IfcLiteRelationships
                return r ?? { voids: [], fills: [], groups: [], connections: [] }
            } catch {
                return { voids: [], fills: [], groups: [], connections: [] }
            }
        }

        const flattenPsetArr = (arr: Array<any>): IfcLitePset[] => arr.map((p: any) => {
            const props: Record<string, string | number | boolean | null> = {}
            for (const prop of p.properties) {
                // Newer @ifc-lite/parser returns `{ name, type, value }` where
                // `value` is a `PropertyValue { type: PropertyValueType, value: primitive }`.
                // Older returned `{ name, value: primitive }`.  Normalize both.
                let raw: unknown = prop?.value
                if (raw && typeof raw === 'object' && 'value' in (raw as Record<string, unknown>)) {
                    raw = (raw as { value: unknown }).value
                }
                if (raw == null) props[prop.name] = null
                else if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
                    props[prop.name] = raw
                } else {
                    props[prop.name] = String(raw)
                }
            }
            return { name: p.name, properties: props }
        })

        const psets = (expressId: number): IfcLitePset[] => {
            try {
                return flattenPsetArr(parserMod.extractPropertiesOnDemand(store, expressId))
            } catch {
                return []
            }
        }

        const typePsets = (expressId: number): IfcLitePset[] => {
            try {
                const info = parserMod.extractTypePropertiesOnDemand(store, expressId) as
                    | { typeName: string; typeId: number; properties: Array<{ name: string; properties: Array<{ name: string; type: number; value: { type: string; value: unknown } }> }> }
                    | null
                if (!info) return []
                return flattenPsetArr(info.properties)
            } catch {
                return []
            }
        }

        const storeyOf = (expressId: number): { name: string; elevation: number | null } | null =>
            storeyOfElement.get(expressId) ?? null

        // Pre-build aggregate children map by walking IFCRELAGGREGATES.
        // RelationshipType.Aggregates = 2 (see @ifc-lite/data types).
        const aggregateChildrenMap = new Map<number, number[]>()
        try {
            const rels: any = store.relationships
            const relAggregateIds = (store.entityIndex.byType.get('IFCRELAGGREGATES') ?? []) as number[]
            for (const relId of relAggregateIds) {
                // Try to resolve via raw byte-level attrs (fast path) — read
                // RelatingObject / RelatedObjects from extractAllEntityAttributes.
                // The columnar parser exposes the rel graph already; prefer it.
                if (rels && typeof rels.getRelated === 'function') {
                    // Iterate forward from each potential parent later — skip
                    break
                }
            }
            // Build by scanning each candidate slab's forward edges for type=2.
            // Cheaper: walk the RELAGGREGATES entities and read their attributes.
            // The relationship-graph approach iterates per-source which is what
            // we want when we know slab ids. Build a flat parent→children map
            // by walking the relationship graph for every entity that appears
            // as a source.
            // Implementation note: we don't have direct access to a sources iterator,
            // so we resolve on-demand below via aggregatedChildren().
            void relAggregateIds
        } catch { /* best-effort */ }

        const aggregatedChildren = (expressId: number): number[] => {
            // Cache miss: ask the relationship graph (forward = children of source).
            const cached = aggregateChildrenMap.get(expressId)
            if (cached) return cached
            try {
                const rels: any = store.relationships
                if (rels && typeof rels.getRelated === 'function') {
                    // RelationshipType.Aggregates = 2 in @ifc-lite/data.
                    const out: number[] = rels.getRelated(expressId, 2, 'forward') ?? []
                    aggregateChildrenMap.set(expressId, out)
                    return out
                }
            } catch { /* ignore */ }
            aggregateChildrenMap.set(expressId, [])
            return []
        }

        const typeOf = (expressId: number): string | null => {
            const ref = store.entityIndex.byId.get(expressId)
            return ref?.type ?? null
        }

        const namedAttrs = (expressId: number): Array<{ name: string; value: string }> => {
            try {
                return parserMod.extractAllEntityAttributes(store, expressId) ?? []
            } catch {
                return []
            }
        }

        const typeOfInstance = (expressId: number): number | null => {
            try {
                // RelationshipType.DefinesByType = 11 (see @ifc-lite/data types).
                const rels: any = store.relationships
                if (rels && typeof rels.getRelated === 'function') {
                    // inverse: the type entity points at the instance, so we walk
                    // inverse from instance to type.
                    const types = rels.getRelated(expressId, 11, 'inverse') ?? []
                    if (types.length > 0) return types[0]
                }
            } catch { /* ignore */ }
            return null
        }

        return {
            sourcePath: path,
            meshesByExpressId,
            allMeshes,
            rtcOffset,
            store,
            schemaVersion: store.schemaVersion,
            byType,
            attrs,
            relationships,
            psets,
            typePsets,
            storeyOf,
            aggregatedChildren,
            typeOf,
            namedAttrs,
            typeOfInstance,
        }
    } finally {
        restoreLog()
    }
}

/**
 * Compute axis-aligned bounding box (Y-up world space) over all positions of
 * all meshes for the given expressId. Returns null if no meshes are found.
 */
export function aabbOfExpressId(
    model: IfcLiteModel,
    expressId: number
): { min: [number, number, number]; max: [number, number, number] } | null {
    const meshes = model.meshesByExpressId.get(expressId)
    if (!meshes || meshes.length === 0) return null
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
