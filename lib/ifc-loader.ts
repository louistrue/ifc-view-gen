import { IfcAPI, IFCDOOR, IFCWALL, IFCWALLSTANDARDCASE, IFCRELDEFINESBYTYPE, IFCRELDEFINESBYPROPERTIES, IFCDOORTYPE } from 'web-ifc'
import * as WebIFC from 'web-ifc'
import * as THREE from 'three'
import type { ElementInfo, LoadedIFCModel } from './ifc-types'

// Create a reverse mapping of IFC type codes to names
// accessing WebIFC properties dynamically to build the map
const IFC_TYPE_MAP = new Map<number, string>()
try {
    // Iterate over all keys in WebIFC to find numeric constants
    for (const key in WebIFC) {
        const value = (WebIFC as any)[key]
        if (typeof value === 'number') {
            IFC_TYPE_MAP.set(value, key)
        }
    }
} catch (e) {
    console.warn('Failed to build IFC type map:', e)
}

function getIfcTypeName(typeCode: number): string | undefined {
    return IFC_TYPE_MAP.get(typeCode)
}

let ifcAPI: IfcAPI | null = null

let isInitializing = false

let initPromise: Promise<void> | null = null

/**
 * Loads web-ifc library and initializes the API
 */
async function initializeIFCAPI(): Promise<IfcAPI> {
    if (ifcAPI) {
        return ifcAPI
    }

    if (isInitializing && initPromise) {
        await initPromise
        return ifcAPI!
    }

    isInitializing = true
    initPromise = (async () => {
        try {
            const ifcAPIInstance = new IfcAPI()

            // IMPORTANT: SetWasmPath expects a directory path where the wasm file is located
            // The second parameter (true) indicates this is an absolute path
            // This prevents the library from adding the origin URL again
            const wasmPath = typeof window === 'undefined'
                ? `${process.cwd()}/public/wasm/web-ifc/`
                : '/wasm/web-ifc/'
            ifcAPIInstance.SetWasmPath(wasmPath, true)

            await ifcAPIInstance.Init()
            ifcAPI = ifcAPIInstance
        } catch (error) {
            console.error('Failed to initialize web-ifc:', error)
            throw error
        } finally {
            isInitializing = false
        }
    })()

    await initPromise
    return ifcAPI!
}

/**
 * Extract door type names from IFC file using IfcRelDefinesByType relations
 * Returns a map of door expressID -> type name
 */
export async function extractDoorTypes(file: File): Promise<Map<number, string>> {
    const api = await initializeIFCAPI()
    const productTypeMap = new Map<number, string>()

    // Read file as ArrayBuffer
    const arrayBuffer = await file.arrayBuffer()
    const data = new Uint8Array(arrayBuffer)

    // Open the IFC model
    const modelID = api.OpenModel(data)
    if (modelID === -1) {
        console.error('Failed to open IFC model for type extraction')
        return productTypeMap
    }

    try {
        // Get all IfcRelDefinesByType entities
        const relDefinesByTypeIds = api.GetLineIDsWithType(modelID, IFCRELDEFINESBYTYPE)

        for (let i = 0; i < relDefinesByTypeIds.size(); i++) {
            const relId = relDefinesByTypeIds.get(i)
            const rel = api.GetLine(modelID, relId)

            if (!rel) continue

            // Get RelatingType (the type object)
            const relatingTypeRef = rel.RelatingType
            if (!relatingTypeRef?.value) continue

            // Get the type entity to extract its name
            const typeEntity = api.GetLine(modelID, relatingTypeRef.value)
            if (!typeEntity?.Name?.value) continue

            const typeName = typeEntity.Name.value

            // Check if this is a door type (IfcDoorType or IfcDoorStyle)
            const typeCategory = typeEntity.type
            const isDoorType = typeCategory === IFCDOORTYPE ||
                typeCategory === (WebIFC as any).IFCDOORSTYLE

            // Get RelatedObjects (the door occurrences)
            const relatedObjects = rel.RelatedObjects
            if (!Array.isArray(relatedObjects)) continue

            for (const objRef of relatedObjects) {
                const objId = objRef?.value
                if (typeof objId === 'number') {
                    // Check if the related object is a door
                    const obj = api.GetLine(modelID, objId)
                    if (obj?.type === IFCDOOR) {
                        productTypeMap.set(objId, typeName)
                    }
                }
            }
        }


        return productTypeMap
    } finally {
        api.CloseModel(modelID)
    }
}

/**
 * Extract door OperationType from IFC file using web-ifc
 * Returns a map of door expressID -> OperationType value
 */
export async function extractDoorOperationTypes(file: File): Promise<Map<number, string>> {
    const api = await initializeIFCAPI()
    const operationTypeMap = new Map<number, string>()

    // Read file as ArrayBuffer
    const arrayBuffer = await file.arrayBuffer()
    const data = new Uint8Array(arrayBuffer)

    // Open the IFC model
    const modelID = api.OpenModel(data)
    if (modelID === -1) {
        console.error('Failed to open IFC model for OperationType extraction')
        return operationTypeMap
    }

    try {
        // Get all door instances
        const doorIds = api.GetLineIDsWithType(modelID, IFCDOOR)

        for (let i = 0; i < doorIds.size(); i++) {
            const doorId = doorIds.get(i)
            const door = api.GetLine(modelID, doorId)

            if (!door) continue

            // Check instance OperationType first
            let operationType: string | null = null
            if (door.OperationType && door.OperationType.value && door.OperationType.value !== 'NOTDEFINED') {
                operationType = door.OperationType.value
            }

            // If not found on instance, check type via IfcRelDefinesByType
            if (!operationType) {
                const relDefinesByTypeIds = api.GetLineIDsWithType(modelID, IFCRELDEFINESBYTYPE)

                for (let j = 0; j < relDefinesByTypeIds.size(); j++) {
                    const relId = relDefinesByTypeIds.get(j)
                    const rel = api.GetLine(modelID, relId)

                    if (!rel || !rel.RelatedObjects) continue

                    const relatedObjects = Array.isArray(rel.RelatedObjects) ? rel.RelatedObjects : [rel.RelatedObjects]
                    const isRelated = relatedObjects.some((obj: any) => obj?.value === doorId)

                    if (isRelated) {
                        // Found the type relation for this door
                        const typeId = rel.RelatingType?.value
                        if (typeId) {
                            const typeEntity = api.GetLine(modelID, typeId)
                            if (typeEntity?.OperationType && typeEntity.OperationType.value && typeEntity.OperationType.value !== 'NOTDEFINED') {
                                operationType = typeEntity.OperationType.value
                                break
                            }
                        }
                    }
                }
            }

            if (operationType) {
                operationTypeMap.set(doorId, operationType)
            }
        }


        return operationTypeMap
    } finally {
        api.CloseModel(modelID)
    }
}

/**
 * Extract a direct door -> host building element map by joining
 * IfcRelFillsElement (door -> opening) with IfcRelVoidsElement (opening -> host).
 */
export async function extractDoorHostRelationships(file: File): Promise<Map<number, number>> {
    const api = await initializeIFCAPI()
    const result = new Map<number, number>()

    const arrayBuffer = await file.arrayBuffer()
    const data = new Uint8Array(arrayBuffer)

    const modelID = api.OpenModel(data)
    if (modelID === -1) {
        console.error('Failed to open IFC model for door host extraction')
        return result
    }

    try {
        const relFillsType = (WebIFC as any).IFCRELFILLSELEMENT
        const relVoidsType = (WebIFC as any).IFCRELVOIDSELEMENT
        if (typeof relFillsType !== 'number' || typeof relVoidsType !== 'number') {
            return result
        }

        const openingToDoor = new Map<number, number>()
        const relFillsIds = api.GetLineIDsWithType(modelID, relFillsType)
        for (let i = 0; i < relFillsIds.size(); i++) {
            const rel = api.GetLine(modelID, relFillsIds.get(i))
            const openingId = rel?.RelatingOpeningElement?.value
            const doorId = rel?.RelatedBuildingElement?.value
            if (typeof openingId !== 'number' || typeof doorId !== 'number') continue

            const filledElement = api.GetLine(modelID, doorId)
            if (filledElement?.type !== IFCDOOR) continue
            openingToDoor.set(openingId, doorId)
        }

        const relVoidsIds = api.GetLineIDsWithType(modelID, relVoidsType)
        for (let i = 0; i < relVoidsIds.size(); i++) {
            const rel = api.GetLine(modelID, relVoidsIds.get(i))
            const openingId = rel?.RelatedOpeningElement?.value
            const hostId = rel?.RelatingBuildingElement?.value
            if (typeof openingId !== 'number' || typeof hostId !== 'number') continue

            const doorId = openingToDoor.get(openingId)
            if (typeof doorId !== 'number') continue
            result.set(doorId, hostId)
        }

        return result
    } finally {
        api.CloseModel(modelID)
    }
}

/**
 * Extract a child element -> parent slab map for aggregated slab geometry carriers.
 * Some authored slabs (e.g. floor build-ups / Unterlagsboden) have no own representation
 * and expose their visible geometry only through aggregated IfcBuildingElementPart children.
 */
export async function extractSlabAggregateParts(file: File): Promise<Map<number, number>> {
    const api = await initializeIFCAPI()
    const result = new Map<number, number>()

    const arrayBuffer = await file.arrayBuffer()
    const data = new Uint8Array(arrayBuffer)

    const modelID = api.OpenModel(data)
    if (modelID === -1) {
        console.error('Failed to open IFC model for slab aggregate extraction')
        return result
    }

    try {
        const relAggregatesType = (WebIFC as any).IFCRELAGGREGATES
        const ifcSlabType = (WebIFC as any).IFCSLAB
        const ifcBuildingElementPartType = (WebIFC as any).IFCBUILDINGELEMENTPART
        if (
            typeof relAggregatesType !== 'number'
            || typeof ifcSlabType !== 'number'
            || typeof ifcBuildingElementPartType !== 'number'
        ) {
            return result
        }

        const relAggregateIds = api.GetLineIDsWithType(modelID, relAggregatesType)
        for (let i = 0; i < relAggregateIds.size(); i++) {
            const rel = api.GetLine(modelID, relAggregateIds.get(i))
            const parentId = rel?.RelatingObject?.value
            const children = Array.isArray(rel?.RelatedObjects) ? rel.RelatedObjects : []
            if (typeof parentId !== 'number' || children.length === 0) continue

            const parent = api.GetLine(modelID, parentId)
            if (parent?.type !== ifcSlabType) continue

            for (const childRef of children) {
                const childId = childRef?.value
                if (typeof childId !== 'number') continue

                const child = api.GetLine(modelID, childId)
                if (child?.type === ifcBuildingElementPartType) {
                    result.set(childId, parentId)
                }
            }
        }

        return result
    } finally {
        api.CloseModel(modelID)
    }
}

export interface DoorCsetStandardCHData {
    alTuernummer: string | null
    geometryType: string | null
    massDurchgangsbreite: number | null
    massDurchgangshoehe: number | null
    massRohbreite: number | null
    massRohhoehe: number | null
    massAussenrahmenBreite: number | null
    massAussenrahmenHoehe: number | null
    symbolFluchtweg: string | null
    gebaeude: string | null
    feuerwiderstand: string | null
    bauschalldaemmmass: string | null
    festverglasung: string | null
    cfcBkpCccBcc: string | null
    isExternal: string | null
}

export interface DoorPanelMetadata {
    operation: string | null
    widthRatio: number | null
    position: string | null
}

export interface DoorLeafMetadata {
    overallWidth: number | null
    overallHeight: number | null
    quantityWidth: number | null
    quantityHeight: number | null
    panels: DoorPanelMetadata[]
}

function emptyDoorCsetStandardCHData(): DoorCsetStandardCHData {
    return {
        alTuernummer: null,
        geometryType: null,
        massDurchgangsbreite: null,
        massDurchgangshoehe: null,
        massRohbreite: null,
        massRohhoehe: null,
        massAussenrahmenBreite: null,
        massAussenrahmenHoehe: null,
        symbolFluchtweg: null,
        gebaeude: null,
        feuerwiderstand: null,
        bauschalldaemmmass: null,
        festverglasung: null,
        cfcBkpCccBcc: null,
        isExternal: null,
    }
}

function emptyDoorLeafMetadata(): DoorLeafMetadata {
    return {
        overallWidth: null,
        overallHeight: null,
        quantityWidth: null,
        quantityHeight: null,
        panels: [],
    }
}

function unwrapIfcValue(raw: any): any {
    if (raw && typeof raw === 'object' && 'value' in raw) return raw.value
    return raw
}

function normalizeIfcName(name: string): string {
    return name
        .toLowerCase()
        .replace(/ä/g, 'ae')
        .replace(/ö/g, 'oe')
        .replace(/ü/g, 'ue')
        .replace(/ß/g, 'ss')
        .replace(/[^a-z0-9]/g, '')
}

function parseIfcNumber(raw: any): number | null {
    const unwrapped = unwrapIfcValue(raw)
    if (typeof unwrapped === 'number' && Number.isFinite(unwrapped)) return unwrapped
    if (typeof unwrapped === 'string') {
        const parsed = Number.parseFloat(unwrapped.replace(',', '.').trim())
        return Number.isFinite(parsed) ? parsed : null
    }
    return null
}

function getEntityTypeName(entity: any): string {
    if (!entity) return ''
    if (typeof entity.type === 'string') return entity.type.toUpperCase()
    if (typeof entity.type === 'number') return (getIfcTypeName(entity.type) || '').toUpperCase()
    return ''
}

function getOrCreateDoorLeafMetadata(result: Map<number, DoorLeafMetadata>, doorId: number): DoorLeafMetadata {
    const existing = result.get(doorId)
    if (existing) return existing
    const created = emptyDoorLeafMetadata()
    result.set(doorId, created)
    return created
}

function appendPanelMetadata(target: DoorLeafMetadata, panelDef: any): void {
    const operationValue = unwrapIfcValue(panelDef?.PanelOperation ?? panelDef?.OperationType)
    const positionValue = unwrapIfcValue(panelDef?.PanelPosition)
    const widthRatio = parseIfcNumber(panelDef?.PanelWidth)
    const operation = typeof operationValue === 'string' && operationValue.trim()
        ? operationValue.trim().toUpperCase()
        : null
    const position = typeof positionValue === 'string' && positionValue.trim()
        ? positionValue.trim().toUpperCase()
        : null

    const duplicate = target.panels.some((panel) =>
        panel.operation === operation
        && panel.position === position
        && (
            (panel.widthRatio === null && widthRatio === null)
            || (panel.widthRatio !== null && widthRatio !== null && Math.abs(panel.widthRatio - widthRatio) < 1e-9)
        )
    )
    if (duplicate) return

    target.panels.push({
        operation,
        widthRatio,
        position,
    })
}

function applyDoorBaseQuantities(target: DoorLeafMetadata, quantitySet: any, api: IfcAPI, modelID: number): void {
    const setName = String(unwrapIfcValue(quantitySet?.Name) || '')
    if (normalizeIfcName(setName) !== 'qtodoorbasequantities') return

    const quantities = Array.isArray(quantitySet?.Quantities) ? quantitySet.Quantities : []
    for (const quantityRef of quantities) {
        const quantityId = quantityRef?.value
        if (typeof quantityId !== 'number') continue
        const quantity = api.GetLine(modelID, quantityId)
        const quantityName = normalizeIfcName(String(unwrapIfcValue(quantity?.Name) || ''))
        const value =
            parseIfcNumber(quantity?.LengthValue)
            ?? parseIfcNumber(quantity?.AreaValue)
            ?? parseIfcNumber(quantity?.VolumeValue)
            ?? parseIfcNumber(quantity?.CountValue)
            ?? parseIfcNumber(quantity?.WeightValue)
            ?? parseIfcNumber(quantity?.TimeValue)

        if (value === null) continue
        if (quantityName === 'width' && target.quantityWidth === null) {
            target.quantityWidth = value
        } else if (quantityName === 'height' && target.quantityHeight === null) {
            target.quantityHeight = value
        }
    }
}

function collectDoorLeafDefinitions(
    api: IfcAPI,
    modelID: number,
    entity: any,
    target: DoorLeafMetadata
): void {
    if (!entity) return

    const inspectDefinition = (definition: any) => {
        const typeName = getEntityTypeName(definition)
        if (typeName === 'IFCDOORPANELPROPERTIES') {
            appendPanelMetadata(target, definition)
        } else if (typeName === 'IFCELEMENTQUANTITY') {
            applyDoorBaseQuantities(target, definition, api, modelID)
        }
    }

    if (Array.isArray(entity?.HasPropertySets)) {
        for (const definitionRef of entity.HasPropertySets) {
            const definitionId = definitionRef?.value
            if (typeof definitionId !== 'number') continue
            inspectDefinition(api.GetLine(modelID, definitionId))
        }
    }

    const isDefinedBy = Array.isArray(entity?.IsDefinedBy)
        ? entity.IsDefinedBy
        : (entity?.IsDefinedBy ? [entity.IsDefinedBy] : [])
    for (const relRef of isDefinedBy) {
        const relId = relRef?.value
        if (typeof relId !== 'number') continue
        const rel = api.GetLine(modelID, relId)
        const definitionId = rel?.RelatingPropertyDefinition?.value
        if (typeof definitionId !== 'number') continue
        inspectDefinition(api.GetLine(modelID, definitionId))
    }
}

const CSET_PROP_ALIASES: Record<string, string> = {
    al00tuernummer: 'tuernummereindeutig',
    tuernummer: 'tuernummereindeutig',
    massdurchgangshoehe: 'lh',
    massrohbreite: 'rb',
    massrohebreite: 'rb',
    massrohhoehe: 'rh',
    massrohehoehe: 'rh',
    isexterior: 'isexternal',
}

/** IFC-style boolean display (IsExternal etc.): TRUE / FALSE */
function formatIfcBooleanLikeString(raw: any): string | null {
    const v = unwrapIfcValue(raw)
    if (v === true) return 'TRUE'
    if (v === false) return 'FALSE'
    if (typeof v === 'number' && Number.isFinite(v)) {
        if (v === 1) return 'TRUE'
        if (v === 0) return 'FALSE'
    }
    if (typeof v === 'string') {
        const t = v.trim()
        if (!t) return null
        const lower = t.toLowerCase().replace(/\./g, '')
        if (lower === 'true' || lower === 't' || lower === 'ja' || lower === 'yes' || lower === '1' || lower === 'wahr') return 'TRUE'
        if (lower === 'false' || lower === 'f' || lower === 'nein' || lower === 'no' || lower === '0' || lower === 'falsch') return 'FALSE'
        return t
    }
    return null
}

function applyCsetProperty(target: DoorCsetStandardCHData, propName: string, nominalValue: any): void {
    let normalized = normalizeIfcName(propName)
    normalized = CSET_PROP_ALIASES[normalized] ?? normalized
    if (normalized === 'tuernummereindeutig') {
        const value = unwrapIfcValue(nominalValue)
        if (typeof value === 'string' && value.trim()) {
            target.alTuernummer = value.trim()
        }
        return
    }
    if (normalized === 'geometrytype') {
        const value = unwrapIfcValue(nominalValue)
        if (typeof value === 'string' && value.trim()) {
            target.geometryType = value.trim()
        }
        return
    }
    if (normalized === 'massdurchgangsbreite') {
        target.massDurchgangsbreite = parseIfcNumber(nominalValue)
        return
    }
    if (normalized === 'lh') {
        target.massDurchgangshoehe = parseIfcNumber(nominalValue)
        return
    }
    if (normalized === 'rb') {
        target.massRohbreite = parseIfcNumber(nominalValue)
        return
    }
    if (normalized === 'rh') {
        target.massRohhoehe = parseIfcNumber(nominalValue)
        return
    }
    if (normalized === 'massaussenrahmenbreite') {
        target.massAussenrahmenBreite = parseIfcNumber(nominalValue)
        return
    }
    if (normalized === 'massaussenrahmenhoehe') {
        target.massAussenrahmenHoehe = parseIfcNumber(nominalValue)
        return
    }
    if (normalized === 'symbolfluchtweg') {
        const value = unwrapIfcValue(nominalValue)
        if (typeof value === 'string' && value.trim()) target.symbolFluchtweg = value.trim()
        return
    }
    if (normalized === 'gebaude' || normalized === 'gebaeude') {
        const value = unwrapIfcValue(nominalValue)
        if (typeof value === 'string' && value.trim()) target.gebaeude = value.trim()
        return
    }
    if (normalized === 'feuerwiderstand') {
        const value = unwrapIfcValue(nominalValue)
        if (typeof value === 'string' && value.trim()) target.feuerwiderstand = value.trim()
        return
    }
    if (normalized === 'bauschalldammmass' || normalized === 'bauschalldaemmmass') {
        const value = unwrapIfcValue(nominalValue)
        if (typeof value === 'string' && value.trim()) target.bauschalldaemmmass = value.trim()
        return
    }
    if (normalized === 'festverglasung') {
        const value = unwrapIfcValue(nominalValue)
        if (value == null || value === '') return
        const s = typeof value === 'string' ? value.trim() : String(value).trim()
        if (s) target.festverglasung = s
        return
    }
    if (normalized === 'cfcbkpcccbcc') {
        const value = unwrapIfcValue(nominalValue)
        if (value == null || value === '') return
        const s = typeof value === 'string' ? value.trim() : String(value).trim()
        if (s) target.cfcBkpCccBcc = s
        return
    }
    if (normalized === 'isexternal') {
        const s = formatIfcBooleanLikeString(nominalValue)
        if (s) target.isExternal = s
    }
}

/**
 * Extract Cset_StandardCH values for each door occurrence from IFC.
 * Supports direct door properties and properties assigned to door types.
 */
export async function extractDoorCsetStandardCH(file: File): Promise<Map<number, DoorCsetStandardCHData>> {
    const api = await initializeIFCAPI()
    const result = new Map<number, DoorCsetStandardCHData>()

    const arrayBuffer = await file.arrayBuffer()
    const data = new Uint8Array(arrayBuffer)

    const modelID = api.OpenModel(data)
    if (modelID === -1) {
        console.error('Failed to open IFC model for Cset_StandardCH extraction')
        return result
    }

    try {
        const doorIds = api.GetLineIDsWithType(modelID, IFCDOOR)
        const doorSet = new Set<number>()
        for (let i = 0; i < doorIds.size(); i++) {
            doorSet.add(doorIds.get(i))
        }

        // Build type -> doors map (to propagate type-level psets)
        const typeToDoors = new Map<number, number[]>()
        const relDefinesByTypeIds = api.GetLineIDsWithType(modelID, IFCRELDEFINESBYTYPE)
        for (let i = 0; i < relDefinesByTypeIds.size(); i++) {
            const rel = api.GetLine(modelID, relDefinesByTypeIds.get(i))
            if (!rel?.RelatingType?.value || !Array.isArray(rel?.RelatedObjects)) continue
            const typeId = rel.RelatingType.value as number
            for (const obj of rel.RelatedObjects) {
                const doorId = obj?.value
                if (typeof doorId !== 'number' || !doorSet.has(doorId)) continue
                const arr = typeToDoors.get(typeId) || []
                arr.push(doorId)
                typeToDoors.set(typeId, arr)
            }
        }

        const relDefinesByPropsIds = api.GetLineIDsWithType(modelID, IFCRELDEFINESBYPROPERTIES)
        for (let i = 0; i < relDefinesByPropsIds.size(); i++) {
            const rel = api.GetLine(modelID, relDefinesByPropsIds.get(i))
            const relatingPropDefId = rel?.RelatingPropertyDefinition?.value
            if (typeof relatingPropDefId !== 'number') continue

            const pset = api.GetLine(modelID, relatingPropDefId)
            const psetName = String(unwrapIfcValue(pset?.Name) || '')
            const normalizedPsetName = normalizeIfcName(psetName)
            const isRelevantPset =
                normalizedPsetName === 'csetstandardch'
                || normalizedPsetName === 'psetdoorcommon'
                || normalizedPsetName.startsWith('al00')
                || normalizedPsetName.startsWith('in01')
            if (!isRelevantPset) continue

            const hasProperties = Array.isArray(pset?.HasProperties) ? pset.HasProperties : []
            const targetDoorIds = new Set<number>()
            const relatedObjects = Array.isArray(rel?.RelatedObjects) ? rel.RelatedObjects : []
            for (const obj of relatedObjects) {
                const objId = obj?.value
                if (typeof objId !== 'number') continue
                if (doorSet.has(objId)) {
                    targetDoorIds.add(objId)
                } else {
                    const doorsForType = typeToDoors.get(objId)
                    if (doorsForType) doorsForType.forEach((id) => targetDoorIds.add(id))
                }
            }

            if (targetDoorIds.size === 0) continue

            for (const doorId of targetDoorIds) {
                const existing = result.get(doorId) || emptyDoorCsetStandardCHData()
                for (const propRef of hasProperties) {
                    const propId = propRef?.value
                    if (typeof propId !== 'number') continue
                    const prop = api.GetLine(modelID, propId)
                    const propName = String(unwrapIfcValue(prop?.Name) || '')
                    if (!propName) continue
                    applyCsetProperty(existing, propName, prop?.NominalValue)
                }
                result.set(doorId, existing)
            }
        }

        return result
    } finally {
        api.CloseModel(modelID)
    }
}

export async function extractDoorLeafMetadata(file: File): Promise<Map<number, DoorLeafMetadata>> {
    const api = await initializeIFCAPI()
    const result = new Map<number, DoorLeafMetadata>()

    const arrayBuffer = await file.arrayBuffer()
    const data = new Uint8Array(arrayBuffer)

    const modelID = api.OpenModel(data)
    if (modelID === -1) {
        console.error('Failed to open IFC model for door leaf metadata extraction')
        return result
    }

    try {
        const doorIds = api.GetLineIDsWithType(modelID, IFCDOOR)
        const doorToType = new Map<number, number>()

        const relDefinesByTypeIds = api.GetLineIDsWithType(modelID, IFCRELDEFINESBYTYPE)
        for (let i = 0; i < relDefinesByTypeIds.size(); i++) {
            const rel = api.GetLine(modelID, relDefinesByTypeIds.get(i))
            const typeId = rel?.RelatingType?.value
            if (typeof typeId !== 'number') continue
            const relatedObjects = Array.isArray(rel?.RelatedObjects) ? rel.RelatedObjects : []
            for (const related of relatedObjects) {
                const doorId = related?.value
                if (typeof doorId === 'number') {
                    doorToType.set(doorId, typeId)
                }
            }
        }

        for (let i = 0; i < doorIds.size(); i++) {
            const doorId = doorIds.get(i)
            const door = api.GetLine(modelID, doorId)
            if (!door) continue

            const target = getOrCreateDoorLeafMetadata(result, doorId)
            target.overallWidth = parseIfcNumber(door.OverallWidth) ?? target.overallWidth
            target.overallHeight = parseIfcNumber(door.OverallHeight) ?? target.overallHeight
            collectDoorLeafDefinitions(api, modelID, door, target)

            const typeId = doorToType.get(doorId)
            if (typeof typeId === 'number') {
                const typeEntity = api.GetLine(modelID, typeId)
                collectDoorLeafDefinitions(api, modelID, typeEntity, target)
            }

            const hasUsefulData =
                target.overallWidth !== null
                || target.overallHeight !== null
                || target.quantityWidth !== null
                || target.quantityHeight !== null
                || target.panels.length > 0

            if (!hasUsefulData) {
                result.delete(doorId)
            }
        }

        return result
    } finally {
        api.CloseModel(modelID)
    }
}

/**
 * Loads an IFC file and converts it to a Three.js Group
 */
export async function loadIFCModel(file: File): Promise<THREE.Group> {
    const api = await initializeIFCAPI()

    // Read file as ArrayBuffer
    const arrayBuffer = await file.arrayBuffer()
    const data = new Uint8Array(arrayBuffer)

    // Open the IFC model
    const modelID = api.OpenModel(data)
    if (modelID === -1) {
        throw new Error('Failed to open IFC model')
    }

    try {
        const group = new THREE.Group()

        // Stream all meshes from the model
        api.StreamAllMeshes(modelID, (mesh) => {
            const placedGeometries = mesh.geometries

            for (let i = 0; i < placedGeometries.size(); i++) {
                const placedGeometry = placedGeometries.get(i)
                const geometryExpressID = placedGeometry.geometryExpressID

                // Get geometry data
                const geometry = api.GetGeometry(modelID, geometryExpressID)
                const vertexData = geometry.GetVertexData()
                const vertexDataSize = geometry.GetVertexDataSize()
                const indexData = geometry.GetIndexData()
                const indexDataSize = geometry.GetIndexDataSize()

                // Extract vertex and index arrays from WASM memory
                // web-ifc returns interleaved data: [x, y, z, nx, ny, nz] per vertex (6 floats)
                const interleavedData = api.GetVertexArray(vertexData, vertexDataSize)
                const indices = api.GetIndexArray(indexData, indexDataSize)

                // De-interleave the vertex data
                const vertexCount = interleavedData.length / 6
                const positions = new Float32Array(vertexCount * 3)
                const normals = new Float32Array(vertexCount * 3)

                for (let v = 0; v < vertexCount; v++) {
                    // Position (x, y, z)
                    positions[v * 3 + 0] = interleavedData[v * 6 + 0]
                    positions[v * 3 + 1] = interleavedData[v * 6 + 1]
                    positions[v * 3 + 2] = interleavedData[v * 6 + 2]
                    // Normal (nx, ny, nz)
                    normals[v * 3 + 0] = interleavedData[v * 6 + 3]
                    normals[v * 3 + 1] = interleavedData[v * 6 + 4]
                    normals[v * 3 + 2] = interleavedData[v * 6 + 5]
                }

                // Create Three.js BufferGeometry
                const bufferGeometry = new THREE.BufferGeometry()
                bufferGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
                bufferGeometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))

                // Create index buffer if indices exist
                if (indices.length > 0) {
                    bufferGeometry.setIndex(new THREE.BufferAttribute(indices, 1))
                }

                // Apply transformation matrix from placedGeometry
                const transformation = new THREE.Matrix4()
                transformation.fromArray(placedGeometry.flatTransformation)
                bufferGeometry.applyMatrix4(transformation)

                // Create material with color from placedGeometry
                const color = placedGeometry.color
                const material = new THREE.MeshStandardMaterial({
                    color: new THREE.Color(color.x, color.y, color.z),
                    opacity: color.w,
                    transparent: color.w < 1,
                    side: THREE.DoubleSide,
                    roughness: 0.7,
                    metalness: 0.1,
                })

                // Create mesh and add to group
                const meshObj = new THREE.Mesh(bufferGeometry, material)
                group.add(meshObj)

                // Clean up geometry
                geometry.delete()
            }
        })

        return group
    } finally {
        // Close the model to free memory
        api.CloseModel(modelID)
    }
}

/**
 * Gets the initialized IfcAPI instance (for advanced usage)
 */
export async function getIFCAPI(): Promise<IfcAPI> {
    return initializeIFCAPI()
}

/**
 * Loads an IFC file with element type tracking
 * Returns structured data with meshes and their IFC metadata
 */
export async function loadIFCModelWithMetadata(file: File): Promise<LoadedIFCModel> {
    const api = await initializeIFCAPI()

    // Read file as ArrayBuffer
    const arrayBuffer = await file.arrayBuffer()
    const data = new Uint8Array(arrayBuffer)

    // Open the IFC model
    const modelID = api.OpenModel(data)
    if (modelID === -1) {
        throw new Error('Failed to open IFC model')
    }

    const group = new THREE.Group()
    const elements: ElementInfo[] = []
    const expressIDToMeshes = new Map<number, THREE.Mesh[]>()
    const expressIDToPlacementYAxis = new Map<number, THREE.Vector3>()
    const meshToExpressID = new Map<THREE.Mesh, number>()

    // Stream all meshes from the model
    api.StreamAllMeshes(modelID, (mesh) => {
        const expressID = mesh.expressID
        const placedGeometries = mesh.geometries

        const meshesForElement: THREE.Mesh[] = []

        for (let i = 0; i < placedGeometries.size(); i++) {
            const placedGeometry = placedGeometries.get(i)
            const geometryExpressID = placedGeometry.geometryExpressID

            // Get geometry data
            const geometry = api.GetGeometry(modelID, geometryExpressID)
            const vertexData = geometry.GetVertexData()
            const vertexDataSize = geometry.GetVertexDataSize()
            const indexData = geometry.GetIndexData()
            const indexDataSize = geometry.GetIndexDataSize()

            // Extract vertex and index arrays from WASM memory
            const interleavedData = api.GetVertexArray(vertexData, vertexDataSize)
            const indices = api.GetIndexArray(indexData, indexDataSize)

            // De-interleave the vertex data
            const vertexCount = interleavedData.length / 6
            const positions = new Float32Array(vertexCount * 3)
            const normals = new Float32Array(vertexCount * 3)

            for (let v = 0; v < vertexCount; v++) {
                positions[v * 3 + 0] = interleavedData[v * 6 + 0]
                positions[v * 3 + 1] = interleavedData[v * 6 + 1]
                positions[v * 3 + 2] = interleavedData[v * 6 + 2]
                normals[v * 3 + 0] = interleavedData[v * 6 + 3]
                normals[v * 3 + 1] = interleavedData[v * 6 + 4]
                normals[v * 3 + 2] = interleavedData[v * 6 + 5]
            }

            // Create Three.js BufferGeometry
            const bufferGeometry = new THREE.BufferGeometry()
            bufferGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
            bufferGeometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))

            if (indices.length > 0) {
                bufferGeometry.setIndex(new THREE.BufferAttribute(indices, 1))
            }

            // Apply transformation matrix
            const transformation = new THREE.Matrix4()
            transformation.fromArray(placedGeometry.flatTransformation)
            const placementYAxis = new THREE.Vector3().setFromMatrixColumn(transformation, 1).setY(0)
            if (placementYAxis.lengthSq() > 1e-8 && !expressIDToPlacementYAxis.has(expressID)) {
                expressIDToPlacementYAxis.set(expressID, placementYAxis.normalize())
            }
            bufferGeometry.applyMatrix4(transformation)

            // Create material
            const color = placedGeometry.color
            const material = new THREE.MeshStandardMaterial({
                color: new THREE.Color(color.x, color.y, color.z),
                opacity: color.w,
                transparent: color.w < 1,
                side: THREE.DoubleSide,
                roughness: 0.7,
                metalness: 0.1,
            })

            // Create mesh and add to group
            const meshObj = new THREE.Mesh(bufferGeometry, material)
            meshObj.userData.expressID = expressID
            group.add(meshObj)
            meshesForElement.push(meshObj)
            meshToExpressID.set(meshObj, expressID)

            geometry.delete()
        }

        if (!expressIDToMeshes.has(expressID)) {
            expressIDToMeshes.set(expressID, [])
        }
        expressIDToMeshes.get(expressID)!.push(...meshesForElement)
    })

    // Query element types for each ExpressID
    const processedExpressIDs = new Set<number>()
    for (const [expressID, meshes] of expressIDToMeshes.entries()) {
        if (processedExpressIDs.has(expressID)) continue
        processedExpressIDs.add(expressID)

        try {
            // Get element properties
            const elementProps = api.GetLine(modelID, expressID)

            // web-ifc GetLine returns an object with type property
            // The type is a numeric code, we need to get the type name
            let ifcType = -1
            let typeName = 'Unknown'

            if (elementProps) {
                // Try to get type code
                if (typeof elementProps.type === 'number') {
                    ifcType = elementProps.type
                } else if (typeof elementProps.typeID === 'number') {
                    ifcType = elementProps.typeID
                }

                // Try to get type name from various possible properties
                if (elementProps.typeName) {
                    typeName = String(elementProps.typeName)
                } else if (typeof ifcType === 'number' && ifcType >= 0) {
                    // Reverse lookup from WebIFC constants
                    // This is robust against minification
                    const typeNameFromCode = getIfcTypeName(ifcType)
                    if (typeNameFromCode) {
                        typeName = typeNameFromCode
                    } else if (elementProps.constructor?.name && elementProps.constructor.name.length > 2) {
                        // Only use constructor name if it looks like a real name (not minified)
                        typeName = elementProps.constructor.name
                    } else {
                        // Try to get name from type code using web-ifc API if available
                        try {
                            // web-ifc might have GetNameFromTypeCode or similar
                            if (api.GetNameFromTypeCode) {
                                typeName = api.GetNameFromTypeCode(ifcType) || `Type_${ifcType}`
                            } else {
                                typeName = `Type_${ifcType}`
                            }
                        } catch {
                            typeName = `Type_${ifcType}`
                        }
                    }
                } else if (elementProps.constructor?.name) {
                    typeName = elementProps.constructor.name
                }
            }

            // Extract GlobalId (GUID) from element properties
            // web-ifc returns GlobalId as an object with a .value property
            // IFC GlobalId is typically 22 characters (base64-like encoding)
            let globalId: string | undefined = undefined
            let elementName: string | undefined = undefined
            try {
                if (elementProps) {
                    const props = elementProps as any

                    // web-ifc wraps attributes in objects with .value property
                    // Try props.GlobalId.value first (correct web-ifc pattern)
                    if (props.GlobalId?.value) {
                        globalId = String(props.GlobalId.value).trim()
                    } else if (props.GlobalId && typeof props.GlobalId === 'string') {
                        globalId = props.GlobalId.trim()
                    } else if (props.globalId?.value) {
                        globalId = String(props.globalId.value).trim()
                    } else if (props.globalId && typeof props.globalId === 'string') {
                        globalId = props.globalId.trim()
                    }

                    // Reject if it's just a number (likely ExpressID, not GUID)
                    if (globalId && /^\d+$/.test(globalId)) {
                        globalId = undefined
                    }

                    // IFC Name can be useful for UI labels
                    if (props.Name?.value) {
                        elementName = String(props.Name.value).trim()
                    } else if (props.Name && typeof props.Name === 'string') {
                        elementName = props.Name.trim()
                    } else if (props.name?.value) {
                        elementName = String(props.name.value).trim()
                    } else if (props.name && typeof props.name === 'string') {
                        elementName = props.name.trim()
                    }
                }


                // Empty string is not valid, treat as undefined
                if (globalId === '') {
                    globalId = undefined
                }
                if (elementName === '') {
                    elementName = undefined
                }
            } catch (e) {
                // GlobalId extraction failed, continue without it
                console.warn(`Failed to extract GlobalId for ExpressID ${expressID}:`, e)
            }


            // Calculate bounding box for all meshes of this element
            let bbox: THREE.Box3 | undefined = undefined
            let bboxInitialized = false
            try {
                const tempBbox = new THREE.Box3()
                meshes.forEach(mesh => {
                    try {
                        mesh.geometry.computeBoundingBox()
                        if (mesh.geometry.boundingBox) {
                            const meshBbox = mesh.geometry.boundingBox.clone()
                            meshBbox.applyMatrix4(mesh.matrixWorld)
                            if (!bboxInitialized) {
                                tempBbox.copy(meshBbox)
                                bboxInitialized = true
                            } else {
                                tempBbox.union(meshBbox)
                            }
                        }
                    } catch (e) {
                        // Skip this mesh if bounding box calculation fails
                    }
                })
                if (bboxInitialized && !tempBbox.isEmpty()) {
                    bbox = tempBbox
                }
            } catch (e) {
                // Bounding box calculation failed, but we can still create the element
                console.warn(`Failed to calculate bounding box for ExpressID ${expressID}:`, e)
            }

            // Create element info - use first mesh as representative, store all meshes
            const elementInfo: ElementInfo = {
                expressID,
                ifcType,
                typeName,
                mesh: meshes[0],
                meshes: meshes, // Store all meshes for this element
                boundingBox: (!bboxInitialized || !bbox || bbox.isEmpty()) ? undefined : bbox,
                globalId,
                name: elementName,
                placementYAxis: expressIDToPlacementYAxis.get(expressID)?.clone(),
            }

            elements.push(elementInfo)

            // Store expressID in all meshes for this element
            meshes.forEach(mesh => {
                mesh.userData.expressID = expressID
                mesh.userData.elementInfo = elementInfo
            })

        } catch (error) {
            console.warn(`Failed to get properties for ExpressID ${expressID}:`, error)

            // Try to get type name from error or fallback
            let fallbackTypeName = 'Unknown'
            let fallbackIfcType = -1

            // If error contains type info, try to extract it
            if (error && typeof error === 'object' && 'typeName' in error) {
                fallbackTypeName = String((error as any).typeName)
            }

            // Try to extract GlobalId even in error case
            let globalId: string | undefined = undefined
            try {
                if (error && typeof error === 'object' && 'GlobalId' in error) {
                    globalId = String((error as any).GlobalId)
                }
            } catch (e) {
                // GlobalId extraction failed
            }

            // Create element info - preserve what we can
            const elementInfo: ElementInfo = {
                expressID,
                ifcType: fallbackIfcType,
                typeName: fallbackTypeName,
                mesh: meshes[0],
                meshes: meshes,
                globalId,
                placementYAxis: expressIDToPlacementYAxis.get(expressID)?.clone(),
            }
            elements.push(elementInfo)

            // Store userData on meshes
            meshes.forEach(mesh => {
                mesh.userData.expressID = expressID
                mesh.userData.elementInfo = elementInfo
            })
        }
    }

    // Also try to get doors directly using web-ifc API if available
    // This is a more reliable method
    try {
        // web-ifc has GetLineIDsWithType method
        if (api.GetLineIDsWithType) {
            // Try common IFC door type codes (IFCDOOR = 64, but web-ifc might use different codes)
            const doorTypeCodes = [64, 0] // Common door type codes
            for (const typeCode of doorTypeCodes) {
                try {
                    const doorIDs = api.GetLineIDsWithType(modelID, typeCode)
                    // Mark these as doors in our elements array
                    for (let i = 0; i < doorIDs.size(); i++) {
                        const doorID = doorIDs.get(i)
                        const element = elements.find(e => e.expressID === doorID)
                        if (element && !element.typeName.toLowerCase().includes('door')) {
                            element.typeName = 'IFCDOOR'
                        }
                    }
                } catch (e) {
                    // Type code might not exist, continue
                }
            }
        }
    } catch (error) {
        console.warn('Could not use GetLineIDsWithType:', error)
    }


    return {
        group,
        elements,
        modelID,
        api,
    }
}

/**
 * Closes an IFC model and frees memory
 */
export function closeIFCModel(modelID: number): void {
    if (ifcAPI) {
        ifcAPI.CloseModel(modelID)
    }
}

/**
 * Extract detailed geometry for specific elements from an IFC file
 * This is used for SVG generation where we need full 1:1 geometry
 * 
 * @param file - The IFC file to read from
 * @param expressIDs - Array of expressIDs to extract geometry for
 * @returns Map of expressID to THREE.Mesh[] with detailed geometry
 */
export async function extractDetailedGeometry(
    file: File,
    expressIDs: number[]
): Promise<Map<number, THREE.Mesh[]>> {
    const api = await initializeIFCAPI()

    // Read file as ArrayBuffer
    const arrayBuffer = await file.arrayBuffer()
    const data = new Uint8Array(arrayBuffer)

    // Open the IFC model
    const modelID = api.OpenModel(data)
    if (modelID === -1) {
        throw new Error('Failed to open IFC model for geometry extraction')
    }

    const targetIDs = new Set(expressIDs)
    const result = new Map<number, THREE.Mesh[]>()

    // Initialize empty arrays for all requested IDs
    for (const id of expressIDs) {
        result.set(id, [])
    }

    try {
        // Stream all meshes and filter for requested expressIDs
        api.StreamAllMeshes(modelID, (mesh) => {
            const expressID = mesh.expressID

            if (!targetIDs.has(expressID)) {
                return // Skip elements we don't need
            }

            const meshes = result.get(expressID) || []
            const placedGeometries = mesh.geometries

            for (let i = 0; i < placedGeometries.size(); i++) {
                const placedGeometry = placedGeometries.get(i)
                const geometryExpressID = placedGeometry.geometryExpressID

                // Get geometry data from web-ifc (detailed, full resolution)
                const geometry = api.GetGeometry(modelID, geometryExpressID)
                const vertexData = geometry.GetVertexData()
                const vertexDataSize = geometry.GetVertexDataSize()
                const indexData = geometry.GetIndexData()
                const indexDataSize = geometry.GetIndexDataSize()

                // Extract vertex and index arrays from WASM memory
                const interleavedData = api.GetVertexArray(vertexData, vertexDataSize)
                const indices = api.GetIndexArray(indexData, indexDataSize)

                // De-interleave the vertex data (web-ifc uses [x,y,z,nx,ny,nz] per vertex)
                const vertexCount = interleavedData.length / 6
                const positions = new Float32Array(vertexCount * 3)
                const normals = new Float32Array(vertexCount * 3)

                for (let v = 0; v < vertexCount; v++) {
                    positions[v * 3 + 0] = interleavedData[v * 6 + 0]
                    positions[v * 3 + 1] = interleavedData[v * 6 + 1]
                    positions[v * 3 + 2] = interleavedData[v * 6 + 2]
                    normals[v * 3 + 0] = interleavedData[v * 6 + 3]
                    normals[v * 3 + 1] = interleavedData[v * 6 + 4]
                    normals[v * 3 + 2] = interleavedData[v * 6 + 5]
                }

                // Create Three.js BufferGeometry
                const bufferGeometry = new THREE.BufferGeometry()
                bufferGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
                bufferGeometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))

                if (indices.length > 0) {
                    bufferGeometry.setIndex(new THREE.BufferAttribute(indices, 1))
                }

                // Apply transformation matrix (places geometry in world space)
                const transformation = new THREE.Matrix4()
                transformation.fromArray(placedGeometry.flatTransformation)
                bufferGeometry.applyMatrix4(transformation)

                // Create mesh with userData for identification
                const meshObj = new THREE.Mesh(bufferGeometry, new THREE.MeshBasicMaterial())
                meshObj.userData.expressID = expressID
                meshObj.userData.geometryExpressID = geometryExpressID
                meshObj.userData.vertexCount = vertexCount

                meshes.push(meshObj)

                // Clean up geometry in WASM memory
                geometry.delete()
            }

            result.set(expressID, meshes)
        })

        // Log extraction results
        let totalMeshes = 0
        let totalVertices = 0
        for (const [id, meshes] of result) {
            if (meshes.length > 0) {
                const verts = meshes.reduce((sum, m) => sum + (m.userData.vertexCount || 0), 0)
                totalMeshes += meshes.length
                totalVertices += verts
            }
        }

        return result
    } finally {
        // Close the model to free memory
        api.CloseModel(modelID)
    }
}

/**
 * Extract detailed geometry for doors and their context (walls, devices)
 * Used for high-quality SVG generation
 */
export async function extractDoorContextGeometry(
    file: File,
    doorExpressIDs: number[],
    wallExpressIDs: number[],
    deviceExpressIDs: number[]
): Promise<{
    doors: Map<number, THREE.Mesh[]>
    walls: Map<number, THREE.Mesh[]>
    devices: Map<number, THREE.Mesh[]>
}> {
    // Combine all IDs for a single pass through the file
    const allIDs = [...doorExpressIDs, ...wallExpressIDs, ...deviceExpressIDs]
    const allGeometry = await extractDetailedGeometry(file, allIDs)

    // Split results by category
    const doors = new Map<number, THREE.Mesh[]>()
    const walls = new Map<number, THREE.Mesh[]>()
    const devices = new Map<number, THREE.Mesh[]>()

    const doorSet = new Set(doorExpressIDs)
    const wallSet = new Set(wallExpressIDs)
    const deviceSet = new Set(deviceExpressIDs)

    for (const [id, meshes] of allGeometry) {
        if (doorSet.has(id)) {
            doors.set(id, meshes)
        } else if (wallSet.has(id)) {
            walls.set(id, meshes)
        } else if (deviceSet.has(id)) {
            devices.set(id, meshes)
        }
    }

    return { doors, walls, devices }
}

