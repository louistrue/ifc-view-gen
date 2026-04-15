import * as THREE from 'three'
import type { ElementInfo, LoadedIFCModel } from './ifc-types'
import * as WebIFC from 'web-ifc'
import type { DoorCsetStandardCHData, DoorLeafMetadata } from './ifc-loader'

export interface DoorViewFrame {
    origin: THREE.Vector3
    widthAxis: THREE.Vector3
    depthAxis: THREE.Vector3
    upAxis: THREE.Vector3
    semanticFacing: THREE.Vector3
    width: number
    height: number
    thickness: number
}

export interface OperableDoorLeaf {
    width: number
    hingeSide: 'left' | 'right'
    hingeOffsetFromCenter: number
}

export interface OperableDoorLeaves {
    source: 'ifc-panels' | 'cset-clear-width'
    totalWidth: number
    clearWidth: number | null
    leaves: OperableDoorLeaf[]
}

export type DeviceVisibilitySide = 'front' | 'back' | 'unknown'

export interface NearbyDeviceVisibility {
    deviceExpressID: number
    side: DeviceVisibilitySide
    overlapScore: number
    signedDepth: number
    frontOverlapScore: number
    backOverlapScore: number
}

export type DoorContextHostSource = 'ifc-relation' | 'bbox-fallback' | 'none'
export type DoorContextViewFrameSource = 'analyze-door-geometry'

export interface DoorContextDiagnostics {
    hostSource: DoorContextHostSource
    relationHostExpressID: number | null
    resolvedHostExpressID: number | null
    viewFrameSource: DoorContextViewFrameSource
    detailedDoorMeshCount?: number
    detailedWallMeshCount?: number
    detailedSlabMeshCount?: number
    detailedDeviceMeshCount?: number
    detailedViewFrame?: DoorViewFrame
}

export interface DoorContext {
    door: ElementInfo
    wall: ElementInfo | null
    hostWall: ElementInfo | null
    hostSlabBelow: ElementInfo | null
    hostSlabAbove: ElementInfo | null
    hostSlabsBelow: ElementInfo[]
    hostSlabsAbove: ElementInfo[]
    nearbyDoors: ElementInfo[]
    nearbyDevices: ElementInfo[]
    nearbyDeviceVisibility: NearbyDeviceVisibility[]
    geometricNormal: THREE.Vector3
    semanticFacing: THREE.Vector3
    viewFrame: DoorViewFrame
    normal: THREE.Vector3
    center: THREE.Vector3
    doorId: string
    openingDirection: string | null
    doorTypeName: string | null
    storeyName: string | null  // Building storey name from spatial structure
    csetStandardCH?: {
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
        /** Cset_StandardCH: "CFC / BKP / CCC / BCC" (normalized IFC name cfcbkpcccbcc) */
        cfcBkpCccBcc: string | null
        isExternal: string | null
    }
    operableLeaves?: OperableDoorLeaves
    diagnostics?: DoorContextDiagnostics

    // Detailed geometry from web-ifc (for high-quality SVG rendering)
    detailedGeometry?: {
        doorMeshes: THREE.Mesh[]
        wallMeshes: THREE.Mesh[]
        slabMeshes: THREE.Mesh[]
        deviceMeshes: THREE.Mesh[]
    }
}

/** `Geschoss_Geometrietyp` für optionale Airtable-Spalten (z. B. „Geometry type“); nur wenn Geschoss und IFC-Geometrietyp gesetzt. */
export function geschossGeometrietypForAirtable(door: DoorContext): string | undefined {
    const g = door.csetStandardCH?.geometryType?.trim()
    const s = door.storeyName?.trim()
    if (s && g) return `${s}_${g}`
    return undefined
}

function unwrapIfcValue(raw: unknown): unknown {
    if (raw && typeof raw === 'object' && 'value' in (raw as Record<string, unknown>)) {
        return (raw as { value?: unknown }).value
    }
    return raw
}

function normalizeIfcPropName(name: string): string {
    return name
        .toLowerCase()
        .replace(/ä/g, 'ae')
        .replace(/ö/g, 'oe')
        .replace(/ü/g, 'ue')
        .replace(/ß/g, 'ss')
        .replace(/[^a-z0-9]/g, '')
}

function parseIfcNumber(value: unknown): number | null {
    const raw = unwrapIfcValue(value)
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw
    if (typeof raw === 'string') {
        const normalized = raw.replace(',', '.').trim()
        const parsed = Number.parseFloat(normalized)
        return Number.isFinite(parsed) ? parsed : null
    }
    return null
}

type CsetStandardCH = {
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

function emptyCsetStandardCH(): CsetStandardCH {
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
function formatIfcBooleanLikeString(raw: unknown): string | null {
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

function setCsetProperty(target: CsetStandardCH, propertyName: string, rawValue: unknown) {
    let normalized = normalizeIfcPropName(propertyName)
    normalized = CSET_PROP_ALIASES[normalized] ?? normalized

    if (normalized === 'tuernummereindeutig') {
        const value = unwrapIfcValue(rawValue)
        if (typeof value === 'string' && value.trim()) {
            target.alTuernummer = value.trim()
        }
    } else if (normalized === 'geometrytype') {
        const value = unwrapIfcValue(rawValue)
        if (typeof value === 'string' && value.trim()) {
            target.geometryType = value.trim()
        }
    } else if (normalized === 'massdurchgangsbreite') {
        target.massDurchgangsbreite = parseIfcNumber(rawValue)
    } else if (normalized === 'lh') {
        target.massDurchgangshoehe = parseIfcNumber(rawValue)
    } else if (normalized === 'rb') {
        target.massRohbreite = parseIfcNumber(rawValue)
    } else if (normalized === 'rh') {
        target.massRohhoehe = parseIfcNumber(rawValue)
    } else if (normalized === 'massaussenrahmenbreite') {
        target.massAussenrahmenBreite = parseIfcNumber(rawValue)
    } else if (normalized === 'massaussenrahmenhoehe') {
        target.massAussenrahmenHoehe = parseIfcNumber(rawValue)
    } else if (normalized === 'symbolfluchtweg') {
        const value = unwrapIfcValue(rawValue)
        if (typeof value === 'string' && value.trim()) target.symbolFluchtweg = value.trim()
    } else if (normalized === 'gebaude' || normalized === 'gebaeude') {
        const value = unwrapIfcValue(rawValue)
        if (typeof value === 'string' && value.trim()) target.gebaeude = value.trim()
    } else if (normalized === 'feuerwiderstand') {
        const value = unwrapIfcValue(rawValue)
        if (typeof value === 'string' && value.trim()) target.feuerwiderstand = value.trim()
    } else if (normalized === 'bauschalldammmass' || normalized === 'bauschalldaemmmass') {
        const value = unwrapIfcValue(rawValue)
        if (typeof value === 'string' && value.trim()) target.bauschalldaemmmass = value.trim()
    } else if (normalized === 'festverglasung') {
        const value = unwrapIfcValue(rawValue)
        if (value == null || value === '') return
        const s = typeof value === 'string' ? value.trim() : String(value).trim()
        if (s) target.festverglasung = s
    } else if (normalized === 'cfcbkpcccbcc') {
        const value = unwrapIfcValue(rawValue)
        if (value == null || value === '') return
        const s = typeof value === 'string' ? value.trim() : String(value).trim()
        if (s) target.cfcBkpCccBcc = s
    } else if (normalized === 'isexternal') {
        const s = formatIfcBooleanLikeString(rawValue)
        if (s) target.isExternal = s
    }
}

function hasCsetValues(data: CsetStandardCH): boolean {
    return data.alTuernummer !== null
        || data.geometryType !== null
        || data.massDurchgangsbreite !== null
        || data.massDurchgangshoehe !== null
        || data.massRohbreite !== null
        || data.massRohhoehe !== null
        || data.massAussenrahmenBreite !== null
        || data.massAussenrahmenHoehe !== null
        || data.symbolFluchtweg !== null
        || data.gebaeude !== null
        || data.feuerwiderstand !== null
        || data.bauschalldaemmmass !== null
        || data.festverglasung !== null
        || data.cfcBkpCccBcc !== null
        || data.isExternal !== null
}

type DoorOperationInfo = {
    kind: 'swing' | 'sliding' | 'folding' | 'fixed' | 'none'
    hingeSide: 'left' | 'right' | 'both' | null
    fixedSide: 'left' | 'right' | null
    swingCapable: boolean
    fixedLabeled: boolean
    slideDirection: 'left' | 'right' | null
}

export function getDoorOperationInfo(operationType: string | null): DoorOperationInfo {
    if (!operationType) {
        return {
            kind: 'none',
            hingeSide: null,
            fixedSide: null,
            swingCapable: false,
            fixedLabeled: false,
            slideDirection: null,
        }
    }

    const upper = operationType.toUpperCase()
    if (upper.includes('SWING_FIXED_LEFT')) {
        return { kind: 'fixed', hingeSide: 'left', fixedSide: 'right', swingCapable: true, fixedLabeled: true, slideDirection: null }
    }
    if (upper.includes('SWING_FIXED_RIGHT')) {
        return { kind: 'fixed', hingeSide: 'right', fixedSide: 'left', swingCapable: true, fixedLabeled: true, slideDirection: null }
    }
    if (upper.includes('SINGLE_SWING_LEFT') || upper === 'SINGLE_SWING_LEFT') {
        return { kind: 'swing', hingeSide: 'left', fixedSide: null, swingCapable: true, fixedLabeled: false, slideDirection: null }
    }
    if (upper.includes('SINGLE_SWING_RIGHT') || upper === 'SINGLE_SWING_RIGHT') {
        return { kind: 'swing', hingeSide: 'right', fixedSide: null, swingCapable: true, fixedLabeled: false, slideDirection: null }
    }
    if (upper.includes('DOUBLE_DOOR_SINGLE_SWING') || upper.includes('DOUBLE_DOOR_DOUBLE_SWING') || upper === 'DOUBLE_SWING') {
        return { kind: 'swing', hingeSide: 'both', fixedSide: null, swingCapable: true, fixedLabeled: false, slideDirection: null }
    }
    if (upper.includes('SLIDING_TO_LEFT')) {
        return { kind: 'sliding', hingeSide: null, fixedSide: null, swingCapable: false, fixedLabeled: false, slideDirection: 'left' }
    }
    if (upper.includes('SLIDING_TO_RIGHT')) {
        return { kind: 'sliding', hingeSide: null, fixedSide: null, swingCapable: false, fixedLabeled: false, slideDirection: 'right' }
    }
    if (upper.includes('SLIDING') && !upper.includes('FOLDING')) {
        return { kind: 'sliding', hingeSide: null, fixedSide: null, swingCapable: false, fixedLabeled: false, slideDirection: 'right' }
    }
    if (upper.includes('FOLDING')) {
        return { kind: 'folding', hingeSide: null, fixedSide: null, swingCapable: false, fixedLabeled: false, slideDirection: null }
    }
    if (upper.includes('FIXED')) {
        return { kind: 'fixed', hingeSide: null, fixedSide: null, swingCapable: false, fixedLabeled: true, slideDirection: null }
    }
    if (upper.includes('SWING')) {
        return { kind: 'swing', hingeSide: 'right', fixedSide: null, swingCapable: true, fixedLabeled: false, slideDirection: null }
    }
    return { kind: 'none', hingeSide: null, fixedSide: null, swingCapable: false, fixedLabeled: false, slideDirection: null }
}

function resolveOperableLeaves(
    openingDirection: string | null,
    csetStandardCH: CsetStandardCH | null,
    leafMetadata: DoorLeafMetadata | undefined,
    frameWidth: number
): OperableDoorLeaves | undefined {
    const operation = getDoorOperationInfo(openingDirection)

    const totalWidth =
        leafMetadata?.overallWidth
        ?? leafMetadata?.quantityWidth
        ?? csetStandardCH?.massAussenrahmenBreite
        ?? frameWidth
    const safeTotalWidth = Number.isFinite(totalWidth) && totalWidth > 0 ? totalWidth : frameWidth
    const clearWidth = csetStandardCH?.massDurchgangsbreite ?? null

    if (!Number.isFinite(safeTotalWidth) || safeTotalWidth <= 0 || !operation.swingCapable || !operation.hingeSide) {
        return undefined
    }

    const singleLeafHingeSide = operation.hingeSide === 'both' ? null : operation.hingeSide
    const operableSpanWidth =
        clearWidth !== null
        && Number.isFinite(clearWidth)
        && clearWidth > 0.01
        && clearWidth < safeTotalWidth - 0.01
            ? clearWidth
            : safeTotalWidth
    const fixedRemainder = Math.max(safeTotalWidth - operableSpanWidth, 0)

    const buildLeavesResult = (
        source: OperableDoorLeaves['source'],
        leaves: OperableDoorLeaf[]
    ): OperableDoorLeaves | undefined => {
        const filtered = leaves.filter((leaf) => Number.isFinite(leaf.width) && leaf.width > 0.01)
        if (filtered.length === 0) return undefined
        return {
            source,
            totalWidth: safeTotalWidth,
            clearWidth,
            leaves: filtered,
        }
    }

    const getOpeningCenterOffset = (panelPosition?: string | null): number => {
        if (operation.fixedSide === 'left') {
            return fixedRemainder / 2
        }
        if (operation.fixedSide === 'right') {
            return -fixedRemainder / 2
        }
        if (panelPosition === 'RIGHT') {
            return fixedRemainder / 2
        }
        if (panelPosition === 'LEFT') {
            return -fixedRemainder / 2
        }
        return 0
    }

    const buildSingleLeaf = (
        source: OperableDoorLeaves['source'],
        width: number,
        panelPosition?: string | null,
        openingSpanWidth = operableSpanWidth
    ): OperableDoorLeaves | undefined => {
        if (!singleLeafHingeSide) return undefined
        const openingCenterOffset = getOpeningCenterOffset(panelPosition)
        const openingLeftEdge = openingCenterOffset - openingSpanWidth / 2
        const openingRightEdge = openingCenterOffset + openingSpanWidth / 2
        return buildLeavesResult(source, [{
            width: Math.min(width, openingSpanWidth),
            hingeSide: singleLeafHingeSide,
            hingeOffsetFromCenter: singleLeafHingeSide === 'left' ? openingLeftEdge : openingRightEdge,
        }])
    }

    const panels = (leafMetadata?.panels || []).filter((panel) => {
        if (!panel.operation) return true
        return !panel.operation.includes('FIXED')
    })

    const getPanelWidth = (position?: string | null): number | null => {
        const panel = panels.find((candidate) =>
            (!position || candidate.position === position)
            && candidate.widthRatio !== null
            && candidate.widthRatio !== undefined
            && candidate.widthRatio > 0.01
            && candidate.widthRatio < 0.999
        )
        return panel?.widthRatio ? safeTotalWidth * panel.widthRatio : null
    }

    if (operation.hingeSide === 'both') {
        const leftPanel = panels.find((panel) => panel.position === 'LEFT')
        const rightPanel = panels.find((panel) => panel.position === 'RIGHT')
        if (leftPanel?.widthRatio && rightPanel?.widthRatio) {
            const totalRatio = leftPanel.widthRatio + rightPanel.widthRatio
            const leftWidth = operableSpanWidth * (leftPanel.widthRatio / totalRatio)
            const rightWidth = operableSpanWidth * (rightPanel.widthRatio / totalRatio)
            return buildLeavesResult('ifc-panels', [
                { width: leftWidth, hingeSide: 'left', hingeOffsetFromCenter: -operableSpanWidth / 2 },
                { width: rightWidth, hingeSide: 'right', hingeOffsetFromCenter: operableSpanWidth / 2 },
            ])
        }
        return buildLeavesResult('cset-clear-width', [
            { width: operableSpanWidth / 2, hingeSide: 'left', hingeOffsetFromCenter: -operableSpanWidth / 2 },
            { width: operableSpanWidth / 2, hingeSide: 'right', hingeOffsetFromCenter: operableSpanWidth / 2 },
        ])
    }

    const preferredPanel = operation.fixedSide === 'left'
        ? panels.find((panel) => panel.position === 'RIGHT')
        : operation.fixedSide === 'right'
            ? panels.find((panel) => panel.position === 'LEFT')
            : panels.find((panel) => panel.position === 'MIDDLE')
                || panels.find((panel) =>
                    panel.position === (singleLeafHingeSide === 'left' ? 'LEFT' : 'RIGHT')
                )
                || panels.find((panel) =>
                    panel.widthRatio !== null
                    && panel.widthRatio !== undefined
                    && panel.widthRatio > 0.01
                    && panel.widthRatio < 0.999
                )
                || panels[0]
    const panelWidth = preferredPanel?.widthRatio !== null && preferredPanel?.widthRatio !== undefined
        ? safeTotalWidth * preferredPanel.widthRatio
        : null
    const asymmetricPanelPosition = (
        preferredPanel?.position === 'LEFT' || preferredPanel?.position === 'RIGHT'
    ) && panelWidth && panelWidth < safeTotalWidth - 0.01
        ? preferredPanel.position
        : null
    if (panelWidth && panelWidth > 0.01 && panelWidth < safeTotalWidth - 0.01) {
        return buildSingleLeaf('ifc-panels', panelWidth, asymmetricPanelPosition, panelWidth)
    }

    const upper = openingDirection?.toUpperCase() || ''
    if (
        clearWidth !== null
        && clearWidth > 0.01
        && clearWidth < safeTotalWidth - 0.05
        && (
            upper.includes('SWING_FIXED_LEFT')
            || upper.includes('SWING_FIXED_RIGHT')
            || operation.fixedSide !== null
        )
    ) {
        return buildSingleLeaf('cset-clear-width', clearWidth, operation.fixedSide ? asymmetricPanelPosition : null, clearWidth)
    }

    return buildSingleLeaf('cset-clear-width', safeTotalWidth, operation.fixedSide ? asymmetricPanelPosition : null, safeTotalWidth)
}

async function getDoorCsetStandardCH(
    model: LoadedIFCModel,
    doorExpressID: number
): Promise<CsetStandardCH | null> {
    const result = emptyCsetStandardCH()
    const fragmentsModel = (model as any).fragmentsModel

    if (fragmentsModel) {
        try {
            const doorData = await fragmentsModel.getItemsData([doorExpressID], {
                attributesDefault: true,
                relations: {
                    IsDefinedBy: {
                        attributes: true,
                        relations: {
                            RelatingPropertyDefinition: {
                                attributes: true,
                                relations: {
                                    HasProperties: { attributes: true, relations: false },
                                },
                            },
                        },
                    },
                },
                relationsDefault: { attributes: false, relations: false },
            })

            const data = doorData?.[0] as Record<string, unknown> | undefined
            const isDefinedBy = data?.IsDefinedBy
            if (Array.isArray(isDefinedBy)) {
                for (const rel of isDefinedBy) {
                    const relObj = rel as Record<string, unknown> | null
                    const pset = relObj?.RelatingPropertyDefinition as Record<string, unknown> | undefined
                    const psetName = String(unwrapIfcValue(pset?.Name) ?? '')
                    const normalizedPsetName = normalizeIfcPropName(psetName)
                    const isRelevantPset =
                        normalizedPsetName === 'csetstandardch'
                        || normalizedPsetName === 'psetdoorcommon'
                        || normalizedPsetName.startsWith('al00')
                        || normalizedPsetName.startsWith('in01')
                    if (!isRelevantPset) continue

                    const hasProperties = pset?.HasProperties
                    if (!Array.isArray(hasProperties)) continue

                    for (const prop of hasProperties) {
                        const propObj = prop as Record<string, unknown> | null
                        const propName = String(unwrapIfcValue(propObj?.Name) ?? '')
                        if (!propName) continue
                        setCsetProperty(result, propName, propObj?.NominalValue)
                    }
                }
            }
        } catch (e) {
            console.warn(`Failed to read Cset_StandardCH for door ${doorExpressID} (fragments path):`, e)
        }
    } else {
        try {
            const api = model.api
            const modelID = model.modelID
            const door = api.GetLine(modelID, doorExpressID)
            const isDefinedBy = door?.IsDefinedBy
            const rels = Array.isArray(isDefinedBy) ? isDefinedBy : (isDefinedBy ? [isDefinedBy] : [])

            for (const relRef of rels) {
                const relId = relRef?.value
                if (typeof relId !== 'number') continue
                const rel = api.GetLine(modelID, relId)
                const psetRef = rel?.RelatingPropertyDefinition
                const psetId = psetRef?.value
                if (typeof psetId !== 'number') continue
                const pset = api.GetLine(modelID, psetId)
                const psetName = String(unwrapIfcValue(pset?.Name) ?? '')
                const normalizedPsetName = normalizeIfcPropName(psetName)
                const isRelevantPset =
                    normalizedPsetName === 'csetstandardch'
                    || normalizedPsetName === 'psetdoorcommon'
                    || normalizedPsetName.startsWith('al00')
                    || normalizedPsetName.startsWith('in01')
                if (!isRelevantPset) continue

                const hasProperties = pset?.HasProperties
                const props = Array.isArray(hasProperties) ? hasProperties : []
                for (const propRef of props) {
                    const propId = propRef?.value
                    if (typeof propId !== 'number') continue
                    const prop = api.GetLine(modelID, propId)
                    const propName = String(unwrapIfcValue(prop?.Name) ?? '')
                    if (!propName) continue
                    setCsetProperty(result, propName, prop?.NominalValue)
                }
            }
        } catch (e) {
            console.warn(`Failed to read Cset_StandardCH for door ${doorExpressID} (web-ifc path):`, e)
        }
    }

    return hasCsetValues(result) ? result : null
}

/**
 * Filter options for door filtering
 */
export interface DoorFilterOptions {
    /** Filter by door type names (comma-separated or array) */
    doorTypes?: string | string[]
    /** Filter by building storey names (comma-separated or array) */
    storeys?: string | string[]
    /** Filter by specific door GUIDs (comma-separated or array) */
    guids?: string | string[]
}

/**
 * Filter doors based on filter options
 * Uses AND logic between filter types, OR logic within each type
 */
export function filterDoors(doors: DoorContext[], options: DoorFilterOptions): DoorContext[] {
    if (!options || Object.keys(options).length === 0) {
        return doors
    }

    // Parse filter values
    const parseFilter = (value: string | string[] | undefined): string[] => {
        if (!value) return []
        if (Array.isArray(value)) return value.map(v => v.toLowerCase().trim())
        return value.split(',').map(v => v.toLowerCase().trim()).filter(Boolean)
    }

    const doorTypes = parseFilter(options.doorTypes)
    const storeys = parseFilter(options.storeys)
    const guids = parseFilter(options.guids)

    return doors.filter(door => {
        // Door type filter (partial match, case-insensitive)
        if (doorTypes.length > 0) {
            const doorType = (door.doorTypeName || '').toLowerCase()
            const matchesType = doorTypes.some(t => doorType.includes(t))
            if (!matchesType) return false
        }

        // Storey filter (partial match, case-insensitive)
        if (storeys.length > 0) {
            const storey = (door.storeyName || '').toLowerCase()
            const matchesStorey = storeys.some(s => storey.includes(s))
            if (!matchesStorey) return false
        }

        // GUID filter (exact match)
        if (guids.length > 0) {
            const guid = door.doorId.toLowerCase()
            const matchesGuid = guids.some(g => g === guid)
            if (!matchesGuid) return false
        }

        return true
    })
}

/**
 * Checks if an element type represents a door
 */
function isDoorType(typeName: string, ifcType?: number): boolean {
    const lower = typeName.toLowerCase()
    return (
        lower.includes('door') ||
        typeName === 'IFCDOOR' ||
        typeName.startsWith('IFCDOOR') ||
        // Check regular type code
        (ifcType !== undefined && (
            ifcType === WebIFC.IFCDOOR ||
            ifcType === 64
        ))
    )
}

/**
 * Checks if an element type represents a wall
 */
function isWallType(typeName: string, ifcType?: number): boolean {
    const lower = typeName.toLowerCase()
    const ifcCurtainWall = (WebIFC as any).IFCCURTAINWALL
    const matchesIfcType = ifcType !== undefined && (
        ifcType === WebIFC.IFCWALL
        || ifcType === WebIFC.IFCWALLSTANDARDCASE
        || ifcType === 65
        || (typeof ifcCurtainWall === 'number' && ifcType === ifcCurtainWall)
    )
    return (
        lower.includes('wall') ||
        lower.includes('curtainwall') ||
        typeName === 'IFCWALL' ||
        typeName === 'IFCWALLSTANDARDCASE' ||
        typeName === 'IFCCURTAINWALL' ||
        typeName.startsWith('IFCWALL') ||
        matchesIfcType
    )
}

function isSlabType(typeName: string, ifcType?: number): boolean {
    const lower = typeName.toLowerCase()
    return (
        lower.includes('slab') ||
        typeName === 'IFCSLAB' ||
        typeName.startsWith('IFCSLAB') ||
        (ifcType !== undefined && (
            ifcType === (WebIFC as any).IFCSLAB
            || ifcType === 152
        ))
    )
}

/**
 * Checks if an element type represents an electrical device
 */
function isElectricalDeviceType(typeName: string): boolean {
    const lower = typeName.toLowerCase()
    return (
        lower.includes('electrical') ||
        lower.includes('electric') ||
        lower.includes('cable') ||
        lower.includes('conduit') ||
        lower.includes('carrier') ||
        lower.includes('junction') ||
        lower.includes('distributionflow') ||
        lower.includes('switch') ||
        lower.includes('outlet') ||
        lower.includes('socket') ||
        lower.includes('light') ||
        lower.includes('fixture') ||
        lower.includes('panel') ||
        lower.includes('distribution') ||
        typeName === 'IFCFLOWTERMINAL' ||
        typeName === 'IFCSWITCHINGDEVICE' ||
        typeName === 'IFCOUTLET' ||
        typeName === 'IFCLIGHTFIXTURE' ||
        typeName === 'IFCFLOWSEGMENT' ||
        typeName === 'IFCFLOWCONTROLLER' ||
        typeName === 'IFCDISTRIBUTIONCONTROLELEMENT' ||
        typeName === 'IFCDISTRIBUTIONFLOWELEMENT' ||
        typeName === 'IFCELECTRICDISTRIBUTIONBOARD' ||
        typeName === 'IFCJUNCTIONBOX' ||
        typeName === 'IFCCABLECARRIERSEGMENT' ||
        typeName === 'IFCCABLESEGMENT' ||
        typeName === 'IFCELECTRICAPPLIANCE' ||
        typeName.startsWith('IFCELECTRICAPPLIANCE')
    )
}

const elementNormalCache = new WeakMap<ElementInfo, THREE.Vector3>()

function getBoundingBoxNormalGuess(element: ElementInfo): THREE.Vector3 | null {
    if (element.boundingBox) {
        const size = element.boundingBox.getSize(new THREE.Vector3())
        return size.x < size.z
            ? new THREE.Vector3(1, 0, 0)
            : new THREE.Vector3(0, 0, 1)
    }

    if (element.mesh?.geometry) {
        if (!element.mesh.geometry.boundingBox) element.mesh.geometry.computeBoundingBox()
        if (element.mesh.geometry.boundingBox) {
            const size = element.mesh.geometry.boundingBox.getSize(new THREE.Vector3())
            return size.x < size.z
                ? new THREE.Vector3(1, 0, 0)
                : new THREE.Vector3(0, 0, 1)
        }
    }

    return null
}

function estimateNormalFromMeshes(meshes: THREE.Mesh[], fallbackGuess: THREE.Vector3 | null): THREE.Vector3 | null {
    let xx = 0
    let xz = 0
    let zz = 0

    const p1 = new THREE.Vector3()
    const p2 = new THREE.Vector3()
    const p3 = new THREE.Vector3()
    const edge1 = new THREE.Vector3()
    const edge2 = new THREE.Vector3()
    const faceNormal = new THREE.Vector3()
    const horizontal = new THREE.Vector2()

    const accumulateTriangle = (
        a: number,
        b: number,
        c: number,
        positions: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
        worldMatrix: THREE.Matrix4
    ) => {
        p1.set(positions.getX(a), positions.getY(a), positions.getZ(a)).applyMatrix4(worldMatrix)
        p2.set(positions.getX(b), positions.getY(b), positions.getZ(b)).applyMatrix4(worldMatrix)
        p3.set(positions.getX(c), positions.getY(c), positions.getZ(c)).applyMatrix4(worldMatrix)

        edge1.subVectors(p2, p1)
        edge2.subVectors(p3, p1)
        faceNormal.crossVectors(edge1, edge2)

        const doubledArea = faceNormal.length()
        if (doubledArea < 1e-8) return

        faceNormal.divideScalar(doubledArea)
        horizontal.set(faceNormal.x, faceNormal.z)
        const horizontalLength = horizontal.length()
        if (horizontalLength < 1e-4) return

        horizontal.divideScalar(horizontalLength)
        const weight = doubledArea * (1 - Math.abs(faceNormal.y))
        xx += weight * horizontal.x * horizontal.x
        xz += weight * horizontal.x * horizontal.y
        zz += weight * horizontal.y * horizontal.y
    }

    for (const mesh of meshes) {
        const geometry = mesh.geometry as THREE.BufferGeometry | undefined
        const positions = geometry?.attributes?.position
        if (!positions || positions.count < 3) continue

        mesh.updateMatrixWorld(true)
        const worldMatrix = mesh.matrixWorld
        const indices = geometry.index

        if (indices) {
            for (let i = 0; i < indices.count; i += 3) {
                accumulateTriangle(indices.getX(i), indices.getX(i + 1), indices.getX(i + 2), positions, worldMatrix)
            }
        } else {
            for (let i = 0; i < positions.count; i += 3) {
                accumulateTriangle(i, i + 1, i + 2, positions, worldMatrix)
            }
        }
    }

    const trace = xx + zz
    if (trace < 1e-8) return null

    const det = xx * zz - xz * xz
    const disc = Math.sqrt(Math.max((trace * trace) / 4 - det, 0))
    const lambda = trace / 2 + disc

    let axisX = 1
    let axisZ = 0
    if (Math.abs(xz) > 1e-8 || Math.abs(lambda - zz) > 1e-8) {
        axisX = lambda - zz
        axisZ = xz
    } else if (zz > xx) {
        axisX = 0
        axisZ = 1
    }

    const axis = new THREE.Vector3(axisX, 0, axisZ).normalize()
    if (!Number.isFinite(axis.x) || !Number.isFinite(axis.z) || axis.lengthSq() < 0.5) {
        return null
    }

    if (fallbackGuess && axis.dot(fallbackGuess) < 0) {
        axis.negate()
    }

    return axis
}

/**
 * Calculate the horizontal normal vector of an element from mesh geometry when possible.
 * The element face normal is along the SMALLEST horizontal dimension (thickness)
 */
function calculateElementNormal(element: ElementInfo): THREE.Vector3 {
    const cached = elementNormalCache.get(element)
    if (cached) {
        return cached.clone()
    }

    const fallbackGuess = getBoundingBoxNormalGuess(element)
    const meshes = element.meshes && element.meshes.length > 0
        ? element.meshes
        : element.mesh
            ? [element.mesh]
            : []

    const geometryNormal = estimateNormalFromMeshes(meshes, fallbackGuess)
    if (geometryNormal) {
        elementNormalCache.set(element, geometryNormal.clone())
        return geometryNormal
    }

    const fallback = fallbackGuess ?? new THREE.Vector3(0, 0, 1)
    elementNormalCache.set(element, fallback.clone())
    return fallback
}

function boxDistance(a: THREE.Box3, b: THREE.Box3): number {
    const dx = Math.max(0, a.min.x - b.max.x, b.min.x - a.max.x)
    const dy = Math.max(0, a.min.y - b.max.y, b.min.y - a.max.y)
    const dz = Math.max(0, a.min.z - b.max.z, b.min.z - a.max.z)
    return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function boxPlaneDistance(referenceCenter: THREE.Vector3, box: THREE.Box3, axis: THREE.Vector3): number {
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

    let minProjection = Infinity
    let maxProjection = -Infinity
    for (const corner of corners) {
        const projection = corner.clone().sub(referenceCenter).dot(axis)
        minProjection = Math.min(minProjection, projection)
        maxProjection = Math.max(maxProjection, projection)
    }

    if (minProjection <= 0 && maxProjection >= 0) {
        return 0
    }
    return Math.min(Math.abs(minProjection), Math.abs(maxProjection))
}

function measureBoxInFrame(
    box: THREE.Box3,
    axisA: THREE.Vector3,
    axisB: THREE.Vector3
): { minA: number; maxA: number; minB: number; maxB: number } {
    let minA = Infinity
    let maxA = -Infinity
    let minB = Infinity
    let maxB = -Infinity

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

    for (const corner of corners) {
        const a = corner.dot(axisA)
        const b = corner.dot(axisB)
        minA = Math.min(minA, a)
        maxA = Math.max(maxA, a)
        minB = Math.min(minB, b)
        maxB = Math.max(maxB, b)
    }

    return { minA, maxA, minB, maxB }
}

function rangesOverlap(minA: number, maxA: number, minB: number, maxB: number): boolean {
    return Math.min(maxA, maxB) >= Math.max(minA, minB)
}

function measureBoxAlongAxis(box: THREE.Box3, axis: THREE.Vector3): { min: number; max: number } {
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

    let min = Infinity
    let max = -Infinity
    for (const corner of corners) {
        const projection = corner.dot(axis)
        min = Math.min(min, projection)
        max = Math.max(max, projection)
    }
    return { min, max }
}

function getIntervalOverlapLength(
    minA: number,
    maxA: number,
    minB: number,
    maxB: number
): number {
    return Math.max(0, Math.min(maxA, maxB) - Math.max(minA, minB))
}

function classifyNearbyDeviceVisibility(
    device: ElementInfo,
    hostWall: ElementInfo | null,
    viewFrame: DoorViewFrame
): NearbyDeviceVisibility {
    const fallback: NearbyDeviceVisibility = {
        deviceExpressID: device.expressID,
        side: 'unknown',
        overlapScore: 0,
        signedDepth: 0,
        frontOverlapScore: 0,
        backOverlapScore: 0,
    }

    const deviceBox = device.boundingBox
    const wallBox = hostWall?.boundingBox
    if (!deviceBox) {
        return fallback
    }

    const facingAxis = viewFrame.semanticFacing.clone().normalize()
    const deviceInterval = measureBoxAlongAxis(deviceBox, facingAxis)
    const deviceMid = (deviceInterval.min + deviceInterval.max) / 2
    const deviceDepth = Math.max(deviceInterval.max - deviceInterval.min, 0.02)

    if (!wallBox) {
        const signedDepth = deviceMid - viewFrame.origin.dot(facingAxis)
        const depthDecisionThreshold = Math.max(0.02, Math.min(viewFrame.thickness, deviceDepth) * 0.25)
        const side: DeviceVisibilitySide =
            signedDepth > depthDecisionThreshold
                ? 'front'
                : signedDepth < -depthDecisionThreshold
                    ? 'back'
                    : 'unknown'

        return {
            deviceExpressID: device.expressID,
            side,
            overlapScore: 0,
            signedDepth,
            frontOverlapScore: 0,
            backOverlapScore: 0,
        }
    }

    const wallInterval = measureBoxAlongAxis(wallBox, facingAxis)
    const wallDepth = wallInterval.max - wallInterval.min
    if (!Number.isFinite(wallDepth) || wallDepth <= 1e-4) {
        return fallback
    }

    const faceBandDepth = THREE.MathUtils.clamp(wallDepth * 0.35, 0.06, 0.18)
    const frontBand = {
        min: wallInterval.max - faceBandDepth,
        max: wallInterval.max,
    }
    const backBand = {
        min: wallInterval.min,
        max: wallInterval.min + faceBandDepth,
    }
    const frontOverlapScore = getIntervalOverlapLength(
        deviceInterval.min,
        deviceInterval.max,
        frontBand.min,
        frontBand.max
    )
    const backOverlapScore = getIntervalOverlapLength(
        deviceInterval.min,
        deviceInterval.max,
        backBand.min,
        backBand.max
    )

    const wallMid = (wallInterval.min + wallInterval.max) / 2
    const signedDepth = deviceMid - wallMid
    const overlapScore = Math.max(frontOverlapScore, backOverlapScore)
    const overlapDelta = Math.abs(frontOverlapScore - backOverlapScore)
    const overlapDecisionThreshold = Math.max(0.015, faceBandDepth * 0.12)
    const depthDecisionThreshold = Math.max(0.02, wallDepth * 0.08)

    let side: DeviceVisibilitySide = 'unknown'
    if (overlapScore > 0 && overlapDelta > overlapDecisionThreshold) {
        side = frontOverlapScore > backOverlapScore ? 'front' : 'back'
    } else if (signedDepth > depthDecisionThreshold) {
        side = 'front'
    } else if (signedDepth < -depthDecisionThreshold) {
        side = 'back'
    }

    return {
        deviceExpressID: device.expressID,
        side,
        overlapScore,
        signedDepth,
        frontOverlapScore,
        backOverlapScore,
    }
}

function measureMeshesInFrame(
    meshes: THREE.Mesh[],
    widthAxis: THREE.Vector3,
    depthAxis: THREE.Vector3,
    upAxis: THREE.Vector3
): { origin: THREE.Vector3; width: number; thickness: number; height: number } | null {
    let minWidth = Infinity
    let maxWidth = -Infinity
    let minDepth = Infinity
    let maxDepth = -Infinity
    let minHeight = Infinity
    let maxHeight = -Infinity
    const worldPoint = new THREE.Vector3()

    for (const mesh of meshes) {
        const geometry = mesh.geometry as THREE.BufferGeometry | undefined
        if (!geometry) continue
        const positions = geometry.getAttribute('position')
        if (!positions || positions.count === 0) continue

        mesh.updateMatrixWorld(true)
        const index = geometry.getIndex()
        const projectVertex = (vertexIndex: number) => {
            worldPoint
                .set(
                    positions.getX(vertexIndex),
                    positions.getY(vertexIndex),
                    positions.getZ(vertexIndex)
                )
                .applyMatrix4(mesh.matrixWorld)
            const widthProjection = worldPoint.dot(widthAxis)
            const depthProjection = worldPoint.dot(depthAxis)
            const heightProjection = worldPoint.dot(upAxis)

            minWidth = Math.min(minWidth, widthProjection)
            maxWidth = Math.max(maxWidth, widthProjection)
            minDepth = Math.min(minDepth, depthProjection)
            maxDepth = Math.max(maxDepth, depthProjection)
            minHeight = Math.min(minHeight, heightProjection)
            maxHeight = Math.max(maxHeight, heightProjection)
        }

        if (index && index.count > 0) {
            for (let i = 0; i < index.count; i++) {
                projectVertex(index.getX(i))
            }
            continue
        }

        for (let i = 0; i < positions.count; i++) {
            projectVertex(i)
        }
    }

    if (minWidth === Infinity) {
        return null
    }

    const widthCenter = (minWidth + maxWidth) / 2
    const depthCenter = (minDepth + maxDepth) / 2
    const heightCenter = (minHeight + maxHeight) / 2

    const origin = widthAxis.clone().multiplyScalar(widthCenter)
        .add(depthAxis.clone().multiplyScalar(depthCenter))
        .add(upAxis.clone().multiplyScalar(heightCenter))

    return {
        origin,
        width: maxWidth - minWidth,
        thickness: maxDepth - minDepth,
        height: maxHeight - minHeight,
    }
}

function buildViewFrameFromGeometry(
    meshes: THREE.Mesh[],
    fallbackBox: THREE.Box3 | null,
    semanticFacing: THREE.Vector3
): DoorViewFrame {
    const upAxis = new THREE.Vector3(0, 1, 0)
    const depthAxis = semanticFacing.clone().setY(0).normalize()
    const widthAxis = new THREE.Vector3().crossVectors(upAxis, depthAxis).normalize()
    const measured = measureMeshesInFrame(meshes, widthAxis, depthAxis, upAxis)

    if (measured) {
        return {
            origin: measured.origin,
            widthAxis,
            depthAxis,
            upAxis,
            semanticFacing: depthAxis.clone(),
            width: measured.width,
            height: measured.height,
            thickness: measured.thickness,
        }
    }

    const boundingBox = fallbackBox ?? new THREE.Box3()
    const size = boundingBox.getSize(new THREE.Vector3())
    const origin = boundingBox.getCenter(new THREE.Vector3())
    const isDepthAlongX = Math.abs(depthAxis.x) >= Math.abs(depthAxis.z)

    return {
        origin,
        widthAxis,
        depthAxis,
        upAxis,
        semanticFacing: depthAxis.clone(),
        width: isDepthAlongX ? size.z : size.x,
        height: size.y,
        thickness: isDepthAlongX ? size.x : size.z,
    }
}

function buildDoorViewFrame(door: ElementInfo, semanticFacing: THREE.Vector3): DoorViewFrame {
    const fallbackBox = door.boundingBox ?? new THREE.Box3().setFromObject(door.mesh)
    return buildViewFrameFromGeometry(collectMeshesFromElement(door), fallbackBox, semanticFacing)
}

function cloneDoorViewFrame(frame: DoorViewFrame): DoorViewFrame {
    return {
        origin: frame.origin.clone(),
        widthAxis: frame.widthAxis.clone(),
        depthAxis: frame.depthAxis.clone(),
        upAxis: frame.upAxis.clone(),
        semanticFacing: frame.semanticFacing.clone(),
        width: frame.width,
        height: frame.height,
        thickness: frame.thickness,
    }
}

/**
 * Find the host wall for a door by checking if door bounding box intersects wall
 */
function findHostWall(
    door: ElementInfo,
    walls: ElementInfo[],
    threshold: number = 0.3 // meters - how far outside wall bbox door can be
): ElementInfo | null {
    if (!door.boundingBox) {
        // console.log(`Door ${door.expressID}: No bounding box`)
        return null
    }

    const doorCenter = door.boundingBox.getCenter(new THREE.Vector3())
    const doorSize = door.boundingBox.getSize(new THREE.Vector3())

    // Expand door bounding box slightly for intersection test
    const expandedDoorBbox = door.boundingBox.clone()
    expandedDoorBbox.expandByScalar(threshold)

    let closestWall: ElementInfo | null = null
    let bestOverlapScore = 0

    for (const wall of walls) {
        if (!wall.boundingBox) continue

        // Check if door intersects with wall bounding box
        if (!expandedDoorBbox.intersectsBox(wall.boundingBox)) continue

        const wallCenter = wall.boundingBox.getCenter(new THREE.Vector3())
        const wallSize = wall.boundingBox.getSize(new THREE.Vector3())

        // Calculate overlap volume/area
        const intersection = expandedDoorBbox.clone().intersect(wall.boundingBox)
        const intersectionSize = intersection.getSize(new THREE.Vector3())
        const overlapScore = intersectionSize.x * intersectionSize.y * intersectionSize.z

        // Also check that wall is reasonably sized (not too small)
        const wallVolume = wallSize.x * wallSize.y * wallSize.z
        const isReasonableWall = wallVolume > doorSize.x * doorSize.y * doorSize.z * 0.1

        if (isReasonableWall && overlapScore > bestOverlapScore) {
            bestOverlapScore = overlapScore
            closestWall = wall
        }
    }

    if (closestWall) {
        // console.log(`Door ${door.expressID}: Found host wall ${closestWall.expressID}`)
    } else {
        // console.log(`Door ${door.expressID}: No host wall found (checked ${walls.length} walls)`)
    }

    return closestWall
}

const HOST_CONTEXT_PERPENDICULAR_CROP_METERS = 1.0

function findHostSlabs(
    door: ElementInfo,
    hostWall: ElementInfo | null,
    slabs: ElementInfo[],
    viewFrame: DoorViewFrame
): {
    below: ElementInfo | null
    above: ElementInfo | null
    belowAll: ElementInfo[]
    aboveAll: ElementInfo[]
} {
    const doorBox = door.boundingBox
    if (!doorBox || slabs.length === 0) {
        return { below: null, above: null, belowAll: [], aboveAll: [] }
    }

    const widthAxis = viewFrame.widthAxis.clone().normalize()
    const depthAxis = viewFrame.semanticFacing.clone().normalize()
    const upAxis = viewFrame.upAxis.clone().normalize()
    const doorWidth = measureBoxAlongAxis(doorBox, widthAxis)
    const doorHeight = measureBoxAlongAxis(doorBox, upAxis)
    const originDepth = viewFrame.origin.dot(depthAxis)
    const hostDepth = hostWall?.boundingBox
        ? measureBoxAlongAxis(hostWall.boundingBox, depthAxis)
        : {
            min: originDepth - Math.max(viewFrame.thickness / 2, 0.12),
            max: originDepth + Math.max(viewFrame.thickness / 2, 0.12),
        }
    const widthPadding = Math.max(viewFrame.width * 0.12, 0.08)
    const depthPadding = Math.max(viewFrame.thickness * 0.2, 0.08)

    type Candidate = { element: ElementInfo; gap: number; overlapScore: number }
    const belowCandidates: Candidate[] = []
    const aboveCandidates: Candidate[] = []

    for (const slab of slabs) {
        const slabBox = slab.boundingBox
        if (!slabBox) continue

        const slabWidth = measureBoxAlongAxis(slabBox, widthAxis)
        const slabDepth = measureBoxAlongAxis(slabBox, depthAxis)
        const slabHeight = measureBoxAlongAxis(slabBox, upAxis)
        const localDepthMin = slabDepth.min - originDepth
        const localDepthMax = slabDepth.max - originDepth
        if (
            localDepthMin > HOST_CONTEXT_PERPENDICULAR_CROP_METERS
            || localDepthMax < -HOST_CONTEXT_PERPENDICULAR_CROP_METERS
        ) {
            continue
        }

        const widthOverlap = getIntervalOverlapLength(
            slabWidth.min,
            slabWidth.max,
            doorWidth.min - widthPadding,
            doorWidth.max + widthPadding
        )
        if (widthOverlap <= 0.02) continue

        const depthOverlap = getIntervalOverlapLength(
            slabDepth.min,
            slabDepth.max,
            hostDepth.min - depthPadding,
            hostDepth.max + depthPadding
        )
        if (depthOverlap <= 0.005) continue

        const overlapScore = widthOverlap + depthOverlap
        const belowGap = doorHeight.min - slabHeight.max
        if (belowGap >= -0.06) {
            belowCandidates.push({ element: slab, gap: belowGap, overlapScore })
        }

        const aboveGap = slabHeight.min - doorHeight.max
        if (aboveGap >= -0.06) {
            aboveCandidates.push({ element: slab, gap: aboveGap, overlapScore })
        }
    }

    const sortCandidates = (a: Candidate, b: Candidate) =>
        a.gap - b.gap
        || b.overlapScore - a.overlapScore
        || a.element.expressID - b.element.expressID

    belowCandidates.sort(sortCandidates)
    aboveCandidates.sort(sortCandidates)

    return {
        below: belowCandidates[0]?.element ?? null,
        above: aboveCandidates[0]?.element ?? null,
        belowAll: belowCandidates.map((candidate) => candidate.element),
        aboveAll: aboveCandidates.map((candidate) => candidate.element),
    }
}

/**
 * Find electrical devices within 1m radius of a door on both sides
 */
function findNearbyDevices(
    door: ElementInfo,
    devices: ElementInfo[],
    normal: THREE.Vector3,
    hostWall: ElementInfo | null,
    viewFrame: DoorViewFrame,
    radius: number = 1.25,
    limit: number = 8
): ElementInfo[] {
    if (!door.boundingBox) return []

    const doorCenter = door.boundingBox.getCenter(new THREE.Vector3())
    const hostWallBox = hostWall?.boundingBox ?? null
    const widthAxis = viewFrame.widthAxis.clone().normalize()
    const upAxis = viewFrame.upAxis.clone().normalize()
    const doorBoundsInFrame = measureBoxInFrame(door.boundingBox, widthAxis, upAxis)
    const doorCenterA = (doorBoundsInFrame.minA + doorBoundsInFrame.maxA) / 2
    const expandedDoorVerticalMin = doorBoundsInFrame.minB - 0.15
    const expandedDoorVerticalMax = doorBoundsInFrame.maxB + 0.15
    const edgeBandThreshold = Math.max(viewFrame.width * 0.18, 0.24)

    const filtered = devices
        .filter((device) => device.boundingBox)
        .map((device) => {
            const candidateBox = device.boundingBox!
            const candidateCenter = candidateBox.getCenter(new THREE.Vector3())
            const candidateSize = candidateBox.getSize(new THREE.Vector3())
            const candidateBoundsInFrame = measureBoxInFrame(candidateBox, widthAxis, upAxis)
            const candidateCenterA = (candidateBoundsInFrame.minA + candidateBoundsInFrame.maxA) / 2
            const distanceToNearestJamb = Math.min(
                Math.abs(candidateCenterA - doorBoundsInFrame.minA),
                Math.abs(candidateCenterA - doorBoundsInFrame.maxA),
            )
            const overlapsDoorVerticalBand = rangesOverlap(
                candidateBoundsInFrame.minB,
                candidateBoundsInFrame.maxB,
                expandedDoorVerticalMin,
                expandedDoorVerticalMax
            )
            const bboxGap = boxDistance(door.boundingBox!, candidateBox)
            const planeGap = boxPlaneDistance(doorCenter, candidateBox, normal)
            const centerDistance = doorCenter.distanceTo(candidateCenter)
            const halfDepthOnNormal =
                0.5 * (
                    Math.abs(normal.x) * candidateSize.x +
                    Math.abs(normal.y) * candidateSize.y +
                    Math.abs(normal.z) * candidateSize.z
                )
            const intersectsHostWall = Boolean(hostWallBox?.intersectsBox(candidateBox))
            const inSameWallPlane = planeGap <= Math.max(0.6, halfDepthOnNormal + 0.2)
            const nearDoorJamb = distanceToNearestJamb <= edgeBandThreshold
            const withinExtendedDoorBand = Math.abs(candidateCenterA - doorCenterA) <= Math.max(viewFrame.width * 0.6, 0.5)
            const shouldKeep =
                overlapsDoorVerticalBand && (
                    (bboxGap <= radius && inSameWallPlane && (nearDoorJamb || intersectsHostWall || withinExtendedDoorBand))
                    || (intersectsHostWall && (nearDoorJamb || withinExtendedDoorBand) && bboxGap <= Math.max(radius * 1.5, 2.0) && planeGap <= Math.max(0.8, halfDepthOnNormal + 0.35))
                )

            return {
                device,
                bboxGap,
                planeGap,
                centerDistance,
                distanceToNearestJamb,
                score: bboxGap + planeGap + distanceToNearestJamb * 0.35 + Math.abs(candidateCenterA - doorCenterA) * 0.02,
                shouldKeep,
            }
        })
        .filter((entry) => entry.shouldKeep)
        .sort((a, b) =>
            a.score - b.score
            || a.bboxGap - b.bboxGap
            || a.distanceToNearestJamb - b.distanceToNearestJamb
            || a.planeGap - b.planeGap
            || a.centerDistance - b.centerDistance
        )

    const selected: typeof filtered = []
    if (filtered.length > 0) {
        selected.push(filtered[0])
        const bestScore = filtered[0].score

        for (let i = 1; i < filtered.length; i++) {
            const current = filtered[i]
            const previous = selected[selected.length - 1]
            const scoreDelta = current.score - previous.score
            const fromBest = current.score - bestScore
            if (scoreDelta > 0.32 || fromBest > 0.45) {
                break
            }
            selected.push(current)
        }
    }

    return selected
        .slice(0, limit)
        .map((entry) => entry.device)
}

function findNearbyDoors(
    targetContext: DoorContext,
    allContexts: DoorContext[],
    limit: number = 2
): ElementInfo[] {
    const hostWallID = targetContext.hostWall?.expressID
    const targetBox = targetContext.door.boundingBox
    if (typeof hostWallID !== 'number' || !targetBox) {
        return []
    }

    const widthAxis = targetContext.viewFrame.widthAxis.clone().normalize()
    const upAxis = targetContext.viewFrame.upAxis.clone().normalize()
    const depthAxis = targetContext.viewFrame.semanticFacing.clone().normalize()
    const targetBounds = measureBoxInFrame(targetBox, widthAxis, upAxis)
    const targetDepth = measureBoxAlongAxis(targetBox, depthAxis)
    const targetHeight = Math.max(targetBounds.maxB - targetBounds.minB, 0.01)
    const targetCenterA = (targetBounds.minA + targetBounds.maxA) / 2
    const verticalPadding = Math.max(targetHeight * 0.15, 0.12)
    const minVerticalOverlap = Math.max(targetHeight * 0.4, 0.4)
    const maxHorizontalGap = Math.max(targetContext.viewFrame.width * 2.5, 2.5)

    return allContexts
        .filter((candidateContext) =>
            candidateContext !== targetContext
            && candidateContext.hostWall?.expressID === hostWallID
            && Boolean(candidateContext.door.boundingBox)
        )
        .map((candidateContext) => {
            const candidateBox = candidateContext.door.boundingBox!
            const candidateBounds = measureBoxInFrame(candidateBox, widthAxis, upAxis)
            const candidateDepth = measureBoxAlongAxis(candidateBox, depthAxis)
            const candidateCenterA = (candidateBounds.minA + candidateBounds.maxA) / 2
            const verticalOverlap = getIntervalOverlapLength(
                candidateBounds.minB,
                candidateBounds.maxB,
                targetBounds.minB - verticalPadding,
                targetBounds.maxB + verticalPadding
            )
            const horizontalGap = Math.max(
                candidateBounds.minA - targetBounds.maxA,
                targetBounds.minA - candidateBounds.maxA,
                0
            )
            const depthOverlap = getIntervalOverlapLength(
                candidateDepth.min,
                candidateDepth.max,
                targetDepth.min - 0.25,
                targetDepth.max + 0.25
            )

            return {
                door: candidateContext.door,
                verticalOverlap,
                horizontalGap,
                centerDistance: Math.abs(candidateCenterA - targetCenterA),
                depthOverlap,
            }
        })
        .filter((entry) =>
            entry.verticalOverlap >= minVerticalOverlap
            && entry.horizontalGap <= maxHorizontalGap
            && entry.depthOverlap > 0.01
        )
        .sort((a, b) =>
            a.horizontalGap - b.horizontalGap
            || a.centerDistance - b.centerDistance
            || b.verticalOverlap - a.verticalOverlap
            || a.door.expressID - b.door.expressID
        )
        .slice(0, limit)
        .map((entry) => entry.door)
}

/**
 * Get the opening direction and type name of a door from its type
 * Works with both web-ifc models and fragments models
 * @param operationTypeMap - Optional map of door expressID -> OperationType (from web-ifc extraction)
 */
async function getDoorTypeInfo(
    model: LoadedIFCModel,
    doorExpressID: number,
    doorElement?: ElementInfo,
    operationTypeMap?: Map<number, string>
): Promise<{ direction: string | null, typeName: string | null }> {
    const result = { direction: null as string | null, typeName: null as string | null }
    const isIfcClassName = (value: string | null): boolean => {
        return !!value && /^ifc[a-z0-9_]*$/i.test(value.trim())
    }

    // Check if we have OperationType from web-ifc extraction (preferred method)
    if (operationTypeMap && operationTypeMap.has(doorExpressID)) {
        result.direction = operationTypeMap.get(doorExpressID) || null
    }

    // Check if this is a fragments model (has fragmentsModel property)
    const fragmentsModel = (model as any).fragmentsModel;

    if (fragmentsModel) {
        // Fragments model path - use already-extracted data (fast, no API calls)
        // Use productTypeName (from IfcDoorType via IfcRelDefinesByType) only.
        // Do NOT fall back to IFC class names (e.g. IFCDOOR) for UI type filters.
        if (doorElement?.productTypeName) {
            result.typeName = doorElement.productTypeName;
        }

        // Extract OperationType for swing arc rendering (only if not already set from web-ifc map)
        // We need to query the door element data to get OperationType
        if (!result.direction) {
            try {
                const doorData = await fragmentsModel.getItemsData([doorExpressID], {
                    attributesDefault: true,
                    relations: {
                        IsTypedBy: { attributes: true, relations: { RelatingType: { attributes: true, relations: false } } },
                    },
                    relationsDefault: { attributes: false, relations: false },
                });

                if (doorData && doorData.length > 0) {
                    const data = doorData[0] as any;

                    // Check instance OperationType first
                    // OperationType might be stored as {value: "SINGLE_SWING_LEFT"} or just a string
                    let operationType = null;
                    if (data.OperationType) {
                        operationType = typeof data.OperationType === 'object' ? data.OperationType.value : data.OperationType;
                    }

                    if (operationType && operationType !== 'NOTDEFINED' && operationType !== '') {
                        result.direction = operationType;
                    }

                    // Check type OperationType if not found on instance
                    if (!result.direction && data.IsTypedBy && Array.isArray(data.IsTypedBy)) {
                        for (const rel of data.IsTypedBy) {
                            const relatingType = rel?.RelatingType;
                            if (relatingType) {
                                let typeOperationType = null;
                                if (relatingType.OperationType) {
                                    typeOperationType = typeof relatingType.OperationType === 'object'
                                        ? relatingType.OperationType.value
                                        : relatingType.OperationType;
                                }

                                if (typeOperationType && typeOperationType !== 'NOTDEFINED' && typeOperationType !== '') {
                                    result.direction = typeOperationType;
                                    break;
                                }
                            }
                        }
                    }

                }
            } catch (e) {
                console.warn(`Failed to extract OperationType for door ${doorExpressID}:`, e);
            }
        }
    } else {
        // Web-ifc model path (original implementation)
        try {
            const api = model.api
            const modelID = model.modelID

            // Check instance first
            const door = api.GetLine(modelID, doorExpressID);
            if (door.OperationType && door.OperationType.value && door.OperationType.value !== 'NOTDEFINED') {
                result.direction = door.OperationType.value;
            }

            // Check type
            // Get all IfcRelDefinesByType
            const relLines = api.GetLineIDsWithType(modelID, WebIFC.IFCRELDEFINESBYTYPE);

            for (let i = 0; i < relLines.size(); i++) {
                const relID = relLines.get(i);
                const rel = api.GetLine(modelID, relID);

                if (!rel.RelatedObjects) continue;

                const relatedIds = Array.isArray(rel.RelatedObjects) ? rel.RelatedObjects : [rel.RelatedObjects];

                for (const related of relatedIds) {
                    if (related.value === doorExpressID) {
                        // Found the type relation
                        const typeID = rel.RelatingType.value;
                        const type = api.GetLine(modelID, typeID);

                        if (type.Name && type.Name.value) {
                            const candidateTypeName = String(type.Name.value)
                            if (!isIfcClassName(candidateTypeName)) {
                                result.typeName = candidateTypeName
                            }
                        }

                        // Only overwrite direction if not found on instance
                        if (!result.direction && type.OperationType && type.OperationType.value) {
                            result.direction = type.OperationType.value;
                        }

                        return result;
                    }
                }
            }
        } catch (e) {
            console.warn('Error getting door type info from web-ifc:', e);
        }
    }

    return result;
}

/**
 * Storey map type for quick lookup
 */
type StoreyMap = Map<number, string>

/**
 * Build a map of element ID -> storey name from spatial structure
 */
function buildStoreyMap(spatialNode: any, map: StoreyMap = new Map(), currentStorey: string | null = null): StoreyMap {
    if (!spatialNode) return map

    // If this is a storey node, track it
    let storeyName = currentStorey
    if (spatialNode.type === 'IfcBuildingStorey') {
        storeyName = spatialNode.name || `Storey ${spatialNode.id}`
    }

    // Map all elements in this node to the current storey
    if (storeyName && spatialNode.elementIds) {
        for (const elementId of spatialNode.elementIds) {
            map.set(elementId, storeyName)
        }
    }
    if (storeyName && spatialNode.allElementIds) {
        for (const elementId of spatialNode.allElementIds) {
            if (!map.has(elementId)) {
                map.set(elementId, storeyName)
            }
        }
    }

    // Recurse into children
    if (spatialNode.children) {
        for (const child of spatialNode.children) {
            buildStoreyMap(child, map, storeyName)
        }
    }

    return map
}

/**
 * Analyze all doors in the model and find their context (host wall, nearby devices, opening direction, type name, storey)
 * @param operationTypeMap - Optional map of door expressID -> OperationType (from web-ifc extraction)
 */
export async function analyzeDoors(
    model: LoadedIFCModel,
    secondaryModel?: LoadedIFCModel,
    spatialStructure?: any,
    operationTypeMap?: Map<number, string>,
    csetStandardCHMap?: Map<number, DoorCsetStandardCHData>,
    doorLeafMetadataMap?: Map<number, DoorLeafMetadata>,
    hostRelationshipMap?: Map<number, number>,
    slabAggregatePartMap?: Map<number, number>
): Promise<DoorContext[]> {
    // Build storey map from spatial structure for quick lookup
    const storeyMap = buildStoreyMap(spatialStructure)

    // Separate elements by type
    const doors: ElementInfo[] = []
    const walls: ElementInfo[] = []
    const slabs: ElementInfo[] = []
    const devices: ElementInfo[] = []

    // Helper to process elements from a model
    const processElements = (elements: ElementInfo[]) => {
        for (const element of elements) {
            if (isDoorType(element.typeName, element.ifcType)) {
                doors.push(element)
                // console.log(`Found door: ExpressID ${element.expressID}, typeName="${element.typeName}"`)
            } else if (isWallType(element.typeName, element.ifcType)) {
                walls.push(element)
            } else if (
                isSlabType(element.typeName, element.ifcType)
                || slabAggregatePartMap?.has(element.expressID)
            ) {
                slabs.push(element)
            } else if (isElectricalDeviceType(element.typeName)) {
                devices.push(element)
            }
        }
    }

    // Process primary model
    processElements(model.elements)

    // Process secondary model if provided
    if (secondaryModel) {
        processElements(secondaryModel.elements)
    }

    const wallByExpressID = new Map<number, ElementInfo>()
    for (const wall of walls) {
        wallByExpressID.set(wall.expressID, wall)
    }

    // Analyze each door
    const doorContexts: DoorContext[] = []

    for (const door of doors) {
        // Only analyse if door comes from primary model (or should we support doors in secondary? Assumption: doors are in AR model)
        // Check if door belongs to primary model elements
        const isPrimaryDoor = model.elements.includes(door)
        if (!isPrimaryDoor) continue

        // NOTE: Do NOT recompute boundingBox here!
        // The bounding box from fragments-loader.ts is correct (world-space from Fragments API)
        // and has been adjusted for model centering in IFCViewer.tsx.
        // Recomputing from mesh.setFromObject would give wrong results because
        // element meshes are separate from the main Fragments group.

        if (!door.boundingBox) {
            console.warn(`Door ${door.expressID} has no bounding box, skipping`)
            continue
        }

        // Keep geometric wall-plane alignment separate from semantic export facing.
        const doorNormal = calculateElementNormal(door)
        let geometricNormal = doorNormal.clone()
        const relationHostID = hostRelationshipMap?.get(door.expressID)
        const relationHostWall = typeof relationHostID === 'number' ? wallByExpressID.get(relationHostID) ?? null : null
        const fallbackHostWall = relationHostWall ? null : findHostWall(door, walls, 0.3)
        const hostWall = relationHostWall ?? fallbackHostWall
        const hostSource: DoorContextHostSource = relationHostWall
            ? 'ifc-relation'
            : fallbackHostWall
                ? 'bbox-fallback'
                : 'none'

        if (hostWall) {
            const wallNormal = calculateElementNormal(hostWall)
            if (Math.abs(doorNormal.dot(wallNormal)) > 0.8) {
                if (doorNormal.dot(wallNormal) < 0) {
                    geometricNormal = wallNormal.negate()
                } else {
                    geometricNormal = wallNormal
                }
            }
        }

        const semanticFacing = doorNormal.clone()
        const viewFrame = buildDoorViewFrame(door, semanticFacing)
        const {
            below: hostSlabBelow,
            above: hostSlabAbove,
            belowAll: hostSlabsBelow,
            aboveAll: hostSlabsAbove,
        } = findHostSlabs(door, hostWall, slabs, viewFrame)
        const nearbyDevices = findNearbyDevices(door, devices, geometricNormal, hostWall, viewFrame)
        const nearbyDeviceVisibility = nearbyDevices.map((device) =>
            classifyNearbyDeviceVisibility(device, hostWall, viewFrame)
        )

        const center = door.boundingBox
            ? door.boundingBox.getCenter(new THREE.Vector3())
            : new THREE.Vector3(0, 0, 0)

        const doorId = door.globalId || String(door.expressID)

        // Get opening direction and type name
        const { direction: openingDirection, typeName: baseDoorTypeName } = await getDoorTypeInfo(model, door.expressID, door, operationTypeMap)
        const csetStandardCH = csetStandardCHMap?.get(door.expressID) || await getDoorCsetStandardCH(model, door.expressID)
        const operableLeaves = resolveOperableLeaves(
            openingDirection,
            csetStandardCH,
            doorLeafMetadataMap?.get(door.expressID),
            viewFrame.width
        )
        // UI TYPE filter should use AL00_Tuernummer first.
        const doorTypeName =
            csetStandardCH?.alTuernummer
            || csetStandardCH?.geometryType
            || baseDoorTypeName

        // Get storey name from spatial structure
        const storeyName = storeyMap.get(door.expressID) || null

        doorContexts.push({
            door,
            wall: null, // Legacy field
            hostWall,
            hostSlabBelow,
            hostSlabAbove,
            hostSlabsBelow,
            hostSlabsAbove,
            nearbyDoors: [],
            nearbyDevices,
            nearbyDeviceVisibility,
            geometricNormal,
            semanticFacing,
            viewFrame,
            normal: geometricNormal.clone(),
            center,
            doorId,
            openingDirection,
            doorTypeName,
            storeyName,
            csetStandardCH: csetStandardCH || undefined,
            operableLeaves,
            diagnostics: {
                hostSource,
                relationHostExpressID: typeof relationHostID === 'number' ? relationHostID : null,
                resolvedHostExpressID: hostWall?.expressID ?? null,
                viewFrameSource: 'analyze-door-geometry',
            },
        })
    }

    for (const context of doorContexts) {
        context.nearbyDoors = findNearbyDoors(context, doorContexts)
    }

    return doorContexts
}

/**
 * Get all meshes for a door context
 * Prefers detailed geometry from web-ifc if available, falls back to Fragments geometry
 */
export function getContextMeshes(context: DoorContext): THREE.Mesh[] {
    return getDoorMeshes(context, { includeNearbyDevices: true, includeHostWall: false })
}

export function getDoorMeshes(
    context: DoorContext,
    options: { includeNearbyDevices?: boolean; includeHostWall?: boolean; includeHostSlabs?: boolean } = {}
): THREE.Mesh[] {
    const { includeNearbyDevices = false, includeHostWall = false, includeHostSlabs = false } = options

    // Use detailed geometry if available (from web-ifc, high quality)
    if (context.detailedGeometry) {
        const meshes = [...context.detailedGeometry.doorMeshes]
        if (includeHostWall) {
            meshes.push(...context.detailedGeometry.wallMeshes)
        }
        if (includeHostSlabs) {
            meshes.push(...context.detailedGeometry.slabMeshes)
        }
        if (includeNearbyDevices) {
            meshes.push(...context.detailedGeometry.deviceMeshes)
        }
        return meshes
    }

    const meshes: THREE.Mesh[] = []
    meshes.push(...collectMeshesFromElement(context.door))

    if (includeHostWall && context.hostWall) {
        meshes.push(...collectMeshesFromElement(context.hostWall))
    }
    if (includeHostSlabs) {
        const seenSlabIDs = new Set<number>()
        for (const slab of [...context.hostSlabsBelow, ...context.hostSlabsAbove]) {
            if (seenSlabIDs.has(slab.expressID)) continue
            seenSlabIDs.add(slab.expressID)
            meshes.push(...collectMeshesFromElement(slab))
        }
    }

    if (includeNearbyDevices) {
        for (const device of context.nearbyDevices) {
            meshes.push(...collectMeshesFromElement(device))
        }
    }

    return meshes
}

export function getHostWallMeshes(context: DoorContext): THREE.Mesh[] {
    return getDoorMeshes(context, { includeHostWall: true }).filter(
        (mesh) => (
            mesh.userData.expressID === context.hostWall?.expressID
            || mesh.userData.elementInfo?.expressID === context.hostWall?.expressID
        )
    )
}

export function getHostSlabMeshes(context: DoorContext): THREE.Mesh[] {
    const slabIDs = new Set<number>()
    for (const slab of [...context.hostSlabsBelow, ...context.hostSlabsAbove]) {
        slabIDs.add(slab.expressID)
    }
    if (slabIDs.size === 0) return []

    return getDoorMeshes(context, { includeHostSlabs: true }).filter(
        (mesh) => slabIDs.has(mesh.userData.expressID)
    )
}

/**
 * Collect meshes from an element - traverse scene to find all meshes with matching expressID
 */
function collectMeshesFromElement(element: ElementInfo): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = []
    const expressID = element.expressID

    // If element has stored meshes from loading, use those
    if (element.meshes && element.meshes.length > 0) {
        meshes.push(...element.meshes)
        return meshes
    }

    // Find the root of the scene graph
    let root: THREE.Object3D | null = element.mesh
    while (root && root.parent) {
        root = root.parent
    }

    // Traverse and collect all meshes with matching expressID
    if (root) {
        root.traverse((obj) => {
            if (obj instanceof THREE.Mesh) {
                // Check various places where expressID might be stored
                if (obj.userData.expressID === expressID ||
                    obj.userData.elementInfo?.expressID === expressID) {
                    meshes.push(obj)
                }
            }
        })
    }

    // Fallback: just use the element's direct mesh
    if (meshes.length === 0 && element.mesh) {
        meshes.push(element.mesh)
    }

    return meshes
}

/**
 * Load detailed geometry for door contexts from the IFC file using web-ifc
 * This provides high-quality 1:1 geometry for SVG generation
 * 
 * @param doorContexts - Array of door contexts to populate with geometry
 * @param file - The original IFC file
 * @param modelCenterOffset - The centering offset applied to the model (to align geometry)
 */
export async function loadDetailedGeometry(
    doorContexts: DoorContext[],
    file: File,
    modelCenterOffset: THREE.Vector3,
    secondaryFile?: File
): Promise<void> {
    // Dynamically import to avoid circular dependencies
    const { extractDetailedGeometry } = await import('./ifc-loader')

    // Collect all unique expressIDs we need geometry for
    const doorIDs = new Set<number>()
    const wallIDs = new Set<number>()
    const slabIDs = new Set<number>()
    const deviceIDs = new Set<number>()

    for (const context of doorContexts) {
        doorIDs.add(context.door.expressID)
        if (context.hostWall) {
            wallIDs.add(context.hostWall.expressID)
        }
        for (const slab of [...context.hostSlabsBelow, ...context.hostSlabsAbove]) {
            slabIDs.add(slab.expressID)
        }
        for (const device of context.nearbyDevices) {
            deviceIDs.add(device.expressID)
        }
    }


    const applyCenterOffset = (geometryMap: Map<number, THREE.Mesh[]>) => {
        for (const meshes of geometryMap.values()) {
            for (const mesh of meshes) {
                if (mesh.geometry) {
                    mesh.geometry.translate(-modelCenterOffset.x, -modelCenterOffset.y, -modelCenterOffset.z)
                }
            }
        }
    }

    // Extract all geometry in one pass
    const allIDs = [...doorIDs, ...wallIDs, ...slabIDs, ...deviceIDs]
    const geometryMap = await extractDetailedGeometry(file, allIDs)
    applyCenterOffset(geometryMap)

    if (secondaryFile && deviceIDs.size > 0) {
        const missingDeviceIDs = [...deviceIDs].filter((expressID) => (geometryMap.get(expressID)?.length ?? 0) === 0)
        if (missingDeviceIDs.length > 0) {
            const secondaryGeometryMap = await extractDetailedGeometry(secondaryFile, missingDeviceIDs)
            applyCenterOffset(secondaryGeometryMap)
            for (const [expressID, meshes] of secondaryGeometryMap.entries()) {
                if (meshes.length > 0) {
                    geometryMap.set(expressID, meshes)
                }
            }
        }
    }

    // Populate each door context with its geometry
    for (const context of doorContexts) {
        const doorMeshes = geometryMap.get(context.door.expressID) || []
        const wallMeshes = context.hostWall
            ? (geometryMap.get(context.hostWall.expressID) || [])
            : []
        const slabMeshes: THREE.Mesh[] = []
        const seenSlabIDs = new Set<number>()
        for (const slab of [...context.hostSlabsBelow, ...context.hostSlabsAbove]) {
            if (seenSlabIDs.has(slab.expressID)) continue
            seenSlabIDs.add(slab.expressID)
            slabMeshes.push(...(geometryMap.get(slab.expressID) || []))
        }
        const deviceMeshes: THREE.Mesh[] = []
        for (const device of context.nearbyDevices) {
            const meshes = geometryMap.get(device.expressID) || []
            deviceMeshes.push(...meshes)
        }

        context.detailedGeometry = {
            doorMeshes,
            wallMeshes,
            slabMeshes,
            deviceMeshes,
        }

        context.diagnostics = {
            ...context.diagnostics,
            detailedDoorMeshCount: doorMeshes.length,
            detailedWallMeshCount: wallMeshes.length,
            detailedSlabMeshCount: slabMeshes.length,
            detailedDeviceMeshCount: deviceMeshes.length,
        }
        if (doorMeshes.length > 0) {
            const fallbackBox = context.door.boundingBox ?? new THREE.Box3().setFromObject(context.door.mesh)
            context.diagnostics.detailedViewFrame = cloneDoorViewFrame(
                buildViewFrameFromGeometry(doorMeshes, fallbackBox, context.semanticFacing)
            )
        }
    }

}

