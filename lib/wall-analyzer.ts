import * as THREE from 'three'
import type { ElementInfo, LoadedIFCModel } from './ifc-types'
import * as WebIFC from 'web-ifc'

export interface WallViewFrame {
    origin: THREE.Vector3
    widthAxis: THREE.Vector3
    depthAxis: THREE.Vector3
    upAxis: THREE.Vector3
    semanticFacing: THREE.Vector3
    width: number
    height: number
    thickness: number
}

export interface HostedElement {
    element: ElementInfo
    /** Category: 'window' | 'door' | 'electrical' | 'opening' | 'other' */
    category: 'window' | 'door' | 'electrical' | 'opening' | 'other'
    /** Relative position on wall (0-1 along width, 0-1 along height) */
    relativePosition?: { x: number; y: number }
}

export interface WallContext {
    wall: ElementInfo
    hostedElements: HostedElement[]
    windows: ElementInfo[]
    doors: ElementInfo[]
    electricalDevices: ElementInfo[]
    openings: ElementInfo[]
    normal: THREE.Vector3
    center: THREE.Vector3
    viewFrame: WallViewFrame
    wallId: string
    wallTypeName: string | null
    storeyName: string | null
    /** Detailed geometry from web-ifc (for high-quality SVG rendering) */
    detailedGeometry?: {
        wallMeshes: THREE.Mesh[]
        windowMeshes: THREE.Mesh[]
        doorMeshes: THREE.Mesh[]
        electricalMeshes: THREE.Mesh[]
        openingMeshes: THREE.Mesh[]
    }
}

export interface WallFilterOptions {
    wallTypes?: string | string[]
    storeys?: string | string[]
    guids?: string | string[]
}

function isWallType(typeName: string, ifcType?: number): boolean {
    const lower = typeName.toLowerCase()
    return (
        lower.includes('wall') ||
        typeName === 'IFCWALL' ||
        typeName === 'IFCWALLSTANDARDCASE' ||
        typeName.startsWith('IFCWALL') ||
        (ifcType !== undefined && (
            ifcType === WebIFC.IFCWALL ||
            ifcType === WebIFC.IFCWALLSTANDARDCASE ||
            ifcType === 65
        ))
    )
}

function isDoorType(typeName: string, ifcType?: number): boolean {
    const lower = typeName.toLowerCase()
    return (
        lower.includes('door') ||
        typeName === 'IFCDOOR' ||
        typeName.startsWith('IFCDOOR') ||
        (ifcType !== undefined && (
            ifcType === WebIFC.IFCDOOR ||
            ifcType === 64
        ))
    )
}

function isWindowType(typeName: string, ifcType?: number): boolean {
    const lower = typeName.toLowerCase()
    return (
        lower.includes('window') ||
        typeName === 'IFCWINDOW' ||
        typeName.startsWith('IFCWINDOW') ||
        (ifcType !== undefined && (
            ifcType === WebIFC.IFCWINDOW
        ))
    )
}

function isElectricalDeviceType(typeName: string): boolean {
    const lower = typeName.toLowerCase()
    return (
        lower.includes('electrical') ||
        lower.includes('electric') ||
        lower.includes('switch') ||
        lower.includes('outlet') ||
        lower.includes('socket') ||
        lower.includes('light') ||
        lower.includes('fixture') ||
        lower.includes('panel') ||
        lower.includes('distribution') ||
        typeName === 'IFCELECTRICAPPLIANCE' ||
        typeName.startsWith('IFCELECTRICAPPLIANCE') ||
        typeName === 'IFCLIGHTFIXTURE' ||
        typeName.startsWith('IFCLIGHTFIXTURE') ||
        typeName === 'IFCOUTLET' ||
        typeName.startsWith('IFCOUTLET') ||
        typeName === 'IFCSWITCHINGDEVICE' ||
        typeName.startsWith('IFCSWITCHINGDEVICE') ||
        typeName === 'IFCELECTRICDISTRIBUTIONBOARD' ||
        typeName.startsWith('IFCELECTRICDISTRIBUTIONBOARD') ||
        typeName === 'IFCFLOWTERMINAL' ||
        typeName.startsWith('IFCFLOWTERMINAL')
    )
}

function isOpeningType(typeName: string): boolean {
    const lower = typeName.toLowerCase()
    return (
        lower.includes('opening') ||
        typeName === 'IFCOPENINGELEMENT' ||
        typeName.startsWith('IFCOPENINGELEMENT')
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
    let xx = 0, xz = 0, zz = 0
    const p1 = new THREE.Vector3(), p2 = new THREE.Vector3(), p3 = new THREE.Vector3()
    const edge1 = new THREE.Vector3(), edge2 = new THREE.Vector3(), faceNormal = new THREE.Vector3()
    const horizontal = new THREE.Vector2()

    const accumulateTriangle = (
        a: number, b: number, c: number,
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

    let axisX = 1, axisZ = 0
    if (Math.abs(xz) > 1e-8 || Math.abs(lambda - zz) > 1e-8) {
        axisX = lambda - zz
        axisZ = xz
    } else if (zz > xx) {
        axisX = 0
        axisZ = 1
    }

    const axis = new THREE.Vector3(axisX, 0, axisZ).normalize()
    if (!Number.isFinite(axis.x) || !Number.isFinite(axis.z) || axis.lengthSq() < 0.5) return null
    if (fallbackGuess && axis.dot(fallbackGuess) < 0) axis.negate()
    return axis
}

function calculateElementNormal(element: ElementInfo): THREE.Vector3 {
    const cached = elementNormalCache.get(element)
    if (cached) return cached.clone()

    const fallbackGuess = getBoundingBoxNormalGuess(element)
    const meshes = element.meshes && element.meshes.length > 0
        ? element.meshes
        : element.mesh ? [element.mesh] : []

    const geometryNormal = estimateNormalFromMeshes(meshes, fallbackGuess)
    if (geometryNormal) {
        elementNormalCache.set(element, geometryNormal.clone())
        return geometryNormal
    }

    const fallback = fallbackGuess ?? new THREE.Vector3(0, 0, 1)
    elementNormalCache.set(element, fallback.clone())
    return fallback
}

function collectMeshesFromElement(element: ElementInfo): THREE.Mesh[] {
    if (element.meshes && element.meshes.length > 0) return [...element.meshes]
    if (element.mesh) return [element.mesh]
    return []
}

function measureMeshesInFrame(
    meshes: THREE.Mesh[],
    widthAxis: THREE.Vector3,
    depthAxis: THREE.Vector3,
    upAxis: THREE.Vector3
): { origin: THREE.Vector3; width: number; thickness: number; height: number } | null {
    let minWidth = Infinity, maxWidth = -Infinity
    let minDepth = Infinity, maxDepth = -Infinity
    let minHeight = Infinity, maxHeight = -Infinity
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
                .set(positions.getX(vertexIndex), positions.getY(vertexIndex), positions.getZ(vertexIndex))
                .applyMatrix4(mesh.matrixWorld)
            minWidth = Math.min(minWidth, worldPoint.dot(widthAxis))
            maxWidth = Math.max(maxWidth, worldPoint.dot(widthAxis))
            minDepth = Math.min(minDepth, worldPoint.dot(depthAxis))
            maxDepth = Math.max(maxDepth, worldPoint.dot(depthAxis))
            minHeight = Math.min(minHeight, worldPoint.dot(upAxis))
            maxHeight = Math.max(maxHeight, worldPoint.dot(upAxis))
        }

        if (index && index.count > 0) {
            for (let i = 0; i < index.count; i++) projectVertex(index.getX(i))
        } else {
            for (let i = 0; i < positions.count; i++) projectVertex(i)
        }
    }

    if (minWidth === Infinity) return null

    const origin = widthAxis.clone().multiplyScalar((minWidth + maxWidth) / 2)
        .add(depthAxis.clone().multiplyScalar((minDepth + maxDepth) / 2))
        .add(upAxis.clone().multiplyScalar((minHeight + maxHeight) / 2))

    return {
        origin,
        width: maxWidth - minWidth,
        thickness: maxDepth - minDepth,
        height: maxHeight - minHeight,
    }
}

function buildWallViewFrame(wall: ElementInfo, semanticFacing: THREE.Vector3): WallViewFrame {
    const upAxis = new THREE.Vector3(0, 1, 0)
    const depthAxis = semanticFacing.clone().setY(0).normalize()
    const widthAxis = new THREE.Vector3().crossVectors(upAxis, depthAxis).normalize()

    const meshes = collectMeshesFromElement(wall)
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

    const boundingBox = wall.boundingBox ?? new THREE.Box3()
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

/**
 * Find elements hosted in a wall (doors, windows, electrical devices) by proximity
 */
function findHostedElements(
    wall: ElementInfo,
    wallNormal: THREE.Vector3,
    allElements: { doors: ElementInfo[]; windows: ElementInfo[]; electricalDevices: ElementInfo[]; openings: ElementInfo[] },
    threshold: number = 0.3
): HostedElement[] {
    if (!wall.boundingBox) return []

    const wallCenter = wall.boundingBox.getCenter(new THREE.Vector3())
    const wallBox = wall.boundingBox.clone().expandByScalar(threshold)
    const hosted: HostedElement[] = []

    const checkElement = (element: ElementInfo, category: HostedElement['category']) => {
        if (!element.boundingBox) return
        if (!wallBox.intersectsBox(element.boundingBox)) return

        // Check alignment with wall plane
        const elemCenter = element.boundingBox.getCenter(new THREE.Vector3())
        const toElem = elemCenter.clone().sub(wallCenter)
        const distFromPlane = Math.abs(toElem.dot(wallNormal))

        // For doors/windows: they should be within the wall thickness
        // For electrical: more lenient (can be surface-mounted)
        const maxDist = category === 'electrical' ? 0.5 : threshold

        if (distFromPlane <= maxDist) {
            hosted.push({ element, category })
        }
    }

    for (const door of allElements.doors) checkElement(door, 'door')
    for (const window of allElements.windows) checkElement(window, 'window')
    for (const device of allElements.electricalDevices) checkElement(device, 'electrical')
    for (const opening of allElements.openings) checkElement(opening, 'opening')

    return hosted
}

/**
 * Build a map of element ID -> storey name from spatial structure
 */
type StoreyMap = Map<number, string>

function buildStoreyMap(spatialNode: any, map: StoreyMap = new Map(), currentStorey: string | null = null): StoreyMap {
    if (!spatialNode) return map

    let storeyName = currentStorey
    if (spatialNode.type === 'IfcBuildingStorey') {
        storeyName = spatialNode.name || `Storey ${spatialNode.id}`
    }

    if (storeyName && spatialNode.elementIds) {
        for (const elementId of spatialNode.elementIds) {
            map.set(elementId, storeyName)
        }
    }
    if (storeyName && spatialNode.allElementIds) {
        for (const elementId of spatialNode.allElementIds) {
            if (!map.has(elementId)) map.set(elementId, storeyName)
        }
    }

    if (spatialNode.children) {
        for (const child of spatialNode.children) {
            buildStoreyMap(child, map, storeyName)
        }
    }

    return map
}

/**
 * Get the wall type name via fragments or web-ifc
 */
async function getWallTypeName(
    model: LoadedIFCModel,
    wallExpressID: number,
    wallElement?: ElementInfo
): Promise<string | null> {
    // Use productTypeName if already extracted
    if (wallElement?.productTypeName) return wallElement.productTypeName

    const fragmentsModel = (model as any).fragmentsModel
    if (fragmentsModel) {
        try {
            const wallData = await fragmentsModel.getItemsData([wallExpressID], {
                attributesDefault: true,
                relations: {
                    IsTypedBy: {
                        attributes: true,
                        relations: { RelatingType: { attributes: true, relations: false } },
                    },
                },
                relationsDefault: { attributes: false, relations: false },
            })
            const data = wallData?.[0] as any
            if (data?.IsTypedBy && Array.isArray(data.IsTypedBy)) {
                for (const rel of data.IsTypedBy) {
                    const relatingType = rel?.RelatingType
                    if (relatingType?.Name) {
                        const name = typeof relatingType.Name === 'object'
                            ? relatingType.Name.value
                            : relatingType.Name
                        if (name && typeof name === 'string') return name
                    }
                }
            }
        } catch (e) {
            console.warn(`Failed to get wall type name for ${wallExpressID}:`, e)
        }
    }

    return wallElement?.name || null
}

/**
 * Analyze all walls in the model and find their hosted elements
 */
export async function analyzeWalls(
    model: LoadedIFCModel,
    secondaryModel?: LoadedIFCModel,
    spatialStructure?: any
): Promise<WallContext[]> {
    const storeyMap = buildStoreyMap(spatialStructure)

    const walls: ElementInfo[] = []
    const doors: ElementInfo[] = []
    const windows: ElementInfo[] = []
    const electricalDevices: ElementInfo[] = []
    const openings: ElementInfo[] = []

    const processElements = (elements: ElementInfo[]) => {
        for (const element of elements) {
            if (isWallType(element.typeName, element.ifcType)) {
                walls.push(element)
            } else if (isDoorType(element.typeName, element.ifcType)) {
                doors.push(element)
            } else if (isWindowType(element.typeName, element.ifcType)) {
                windows.push(element)
            } else if (isElectricalDeviceType(element.typeName)) {
                electricalDevices.push(element)
            } else if (isOpeningType(element.typeName)) {
                openings.push(element)
            }
        }
    }

    processElements(model.elements)
    if (secondaryModel) processElements(secondaryModel.elements)

    const allHostable = { doors, windows, electricalDevices, openings }
    const wallContexts: WallContext[] = []

    for (const wall of walls) {
        // Only analyze walls from primary model
        if (!model.elements.includes(wall)) continue
        if (!wall.boundingBox) continue

        const wallNormal = calculateElementNormal(wall)
        const semanticFacing = wallNormal.clone()
        const viewFrame = buildWallViewFrame(wall, semanticFacing)
        const center = wall.boundingBox.getCenter(new THREE.Vector3())
        const wallId = wall.globalId || String(wall.expressID)

        const hostedElements = findHostedElements(wall, wallNormal, allHostable)
        const hostedWindows = hostedElements.filter(h => h.category === 'window').map(h => h.element)
        const hostedDoors = hostedElements.filter(h => h.category === 'door').map(h => h.element)
        const hostedElectrical = hostedElements.filter(h => h.category === 'electrical').map(h => h.element)
        const hostedOpenings = hostedElements.filter(h => h.category === 'opening').map(h => h.element)

        // Skip walls with no hosted elements (user wants to see walls WITH components)
        if (hostedElements.length === 0) continue

        const wallTypeName = await getWallTypeName(model, wall.expressID, wall)
        const storeyName = storeyMap.get(wall.expressID) || null

        wallContexts.push({
            wall,
            hostedElements,
            windows: hostedWindows,
            doors: hostedDoors,
            electricalDevices: hostedElectrical,
            openings: hostedOpenings,
            normal: wallNormal,
            center,
            viewFrame,
            wallId,
            wallTypeName,
            storeyName,
        })
    }

    return wallContexts
}

/**
 * Filter walls based on filter options
 */
export function filterWalls(walls: WallContext[], options: WallFilterOptions): WallContext[] {
    if (!options || Object.keys(options).length === 0) return walls

    const parseFilter = (value: string | string[] | undefined): string[] => {
        if (!value) return []
        if (Array.isArray(value)) return value.map(v => v.toLowerCase().trim())
        return value.split(',').map(v => v.toLowerCase().trim()).filter(Boolean)
    }

    const wallTypes = parseFilter(options.wallTypes)
    const storeys = parseFilter(options.storeys)
    const guids = parseFilter(options.guids)

    return walls.filter(wall => {
        if (wallTypes.length > 0) {
            const wallType = (wall.wallTypeName || '').toLowerCase()
            if (!wallTypes.some(t => wallType.includes(t))) return false
        }
        if (storeys.length > 0) {
            const storey = (wall.storeyName || '').toLowerCase()
            if (!storeys.some(s => storey.includes(s))) return false
        }
        if (guids.length > 0) {
            const guid = wall.wallId.toLowerCase()
            if (!guids.some(g => g === guid)) return false
        }
        return true
    })
}

/**
 * Get all meshes for rendering a wall context
 */
export function getWallContextMeshes(
    context: WallContext,
    options: { includeWindows?: boolean; includeDoors?: boolean; includeElectrical?: boolean } = {}
): THREE.Mesh[] {
    const { includeWindows = true, includeDoors = true, includeElectrical = true } = options

    if (context.detailedGeometry) {
        const meshes = [...context.detailedGeometry.wallMeshes]
        if (includeWindows) meshes.push(...context.detailedGeometry.windowMeshes)
        if (includeDoors) meshes.push(...context.detailedGeometry.doorMeshes)
        if (includeElectrical) meshes.push(...context.detailedGeometry.electricalMeshes)
        return meshes
    }

    const meshes: THREE.Mesh[] = [...collectMeshesFromElement(context.wall)]
    if (includeWindows) {
        for (const w of context.windows) meshes.push(...collectMeshesFromElement(w))
    }
    if (includeDoors) {
        for (const d of context.doors) meshes.push(...collectMeshesFromElement(d))
    }
    if (includeElectrical) {
        for (const e of context.electricalDevices) meshes.push(...collectMeshesFromElement(e))
    }
    return meshes
}

/**
 * Load detailed geometry for wall contexts from the IFC file using web-ifc
 */
export async function loadWallDetailedGeometry(
    wallContexts: WallContext[],
    file: File,
    modelCenterOffset: THREE.Vector3
): Promise<void> {
    const { extractDetailedGeometry } = await import('./ifc-loader')

    const wallIDs = new Set<number>()
    const windowIDs = new Set<number>()
    const doorIDs = new Set<number>()
    const electricalIDs = new Set<number>()
    const openingIDs = new Set<number>()

    for (const context of wallContexts) {
        wallIDs.add(context.wall.expressID)
        for (const w of context.windows) windowIDs.add(w.expressID)
        for (const d of context.doors) doorIDs.add(d.expressID)
        for (const e of context.electricalDevices) electricalIDs.add(e.expressID)
        for (const o of context.openings) openingIDs.add(o.expressID)
    }

    const allIDs = [...wallIDs, ...windowIDs, ...doorIDs, ...electricalIDs, ...openingIDs]
    const geometryMap = await extractDetailedGeometry(file, allIDs)

    // Apply centering offset
    for (const meshes of geometryMap.values()) {
        for (const mesh of meshes) {
            if (mesh.geometry) {
                mesh.geometry.translate(-modelCenterOffset.x, -modelCenterOffset.y, -modelCenterOffset.z)
            }
        }
    }

    // Populate each wall context
    for (const context of wallContexts) {
        const wallMeshes = geometryMap.get(context.wall.expressID) || []
        const windowMeshes: THREE.Mesh[] = []
        const doorMeshes: THREE.Mesh[] = []
        const electricalMeshes: THREE.Mesh[] = []
        const openingMeshes: THREE.Mesh[] = []

        for (const w of context.windows) windowMeshes.push(...(geometryMap.get(w.expressID) || []))
        for (const d of context.doors) doorMeshes.push(...(geometryMap.get(d.expressID) || []))
        for (const e of context.electricalDevices) electricalMeshes.push(...(geometryMap.get(e.expressID) || []))
        for (const o of context.openings) openingMeshes.push(...(geometryMap.get(o.expressID) || []))

        context.detailedGeometry = {
            wallMeshes,
            windowMeshes,
            doorMeshes,
            electricalMeshes,
            openingMeshes,
        }
    }
}
