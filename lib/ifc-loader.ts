import { IfcAPI, IFCDOOR, IFCWALL, IFCWALLSTANDARDCASE, IFCRELDEFINESBYTYPE, IFCDOORTYPE } from 'web-ifc'
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

/**
 * Extract coordinates array from IFC entity (handles web-ifc format)
 */
function extractCoordinates(coords: any): number[] {
    let coordArray: number[] = []
    if (Array.isArray(coords)) {
        coordArray = coords.map((c: any) => {
            if (typeof c === 'number') return c
            if (c && typeof c === 'object' && '_representationValue' in c) {
                return typeof c._representationValue === 'number' ? c._representationValue : parseFloat(c._representationValue || '0')
            }
            if (c && typeof c === 'object' && 'value' in c) {
                return typeof c.value === 'number' ? c.value : parseFloat(c.value || '0')
            }
            return parseFloat(c || '0')
        })
    } else if (coords && coords.value !== undefined) {
        if (Array.isArray(coords.value)) {
            coordArray = coords.value.map((c: any) => {
                if (typeof c === 'number') return c
                if (c && typeof c === 'object' && '_representationValue' in c) {
                    return typeof c._representationValue === 'number' ? c._representationValue : parseFloat(c._representationValue || '0')
                }
                return parseFloat(c || '0')
            })
        } else {
            coordArray = [parseFloat(coords.value || '0')]
        }
    } else if (coords && typeof coords === 'object') {
        if ('x' in coords || 'X' in coords) {
            coordArray = [
                typeof coords.x === 'number' ? coords.x : (typeof coords.X === 'number' ? coords.X : parseFloat(coords.x || coords.X || '0')),
                typeof coords.y === 'number' ? coords.y : (typeof coords.Y === 'number' ? coords.Y : parseFloat(coords.y || coords.Y || '0')),
                typeof coords.z === 'number' ? coords.z : (typeof coords.Z === 'number' ? coords.Z : parseFloat(coords.z || coords.Z || '0')),
            ]
        }
    }
    return coordArray
}

/**
 * Multiply two 4x4 transformation matrices (column-major order)
 */
function multiplyMatrices(a: number[], b: number[]): number[] {
    const result = new Array(16).fill(0)
    for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
            for (let k = 0; k < 4; k++) {
                result[i * 4 + j] += a[i * 4 + k] * b[k * 4 + j]
            }
        }
    }
    return result
}

/**
 * Create identity matrix
 */
function identityMatrix(): number[] {
    return [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1
    ]
}

/**
 * Create translation matrix
 */
function translationMatrix(x: number, y: number, z: number): number[] {
    return [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        x, y, z, 1
    ]
}

/**
 * Build transformation matrix from IFCAXIS2PLACEMENT3D
 */
function buildTransformFromAxisPlacement(api: IfcAPI, modelID: number, axisPlacement: any): number[] {
    // Start with identity
    let matrix = identityMatrix()

    // Get Location
    const locationRef = axisPlacement.Location
    if (locationRef?.value) {
        const location = api.GetLine(modelID, locationRef.value)
        if (location) {
            const coords = extractCoordinates((location as any).Coordinates)
            if (coords.length >= 3) {
                const tx = coords[0] || 0
                const ty = coords[1] || 0
                const tz = coords[2] || 0
                matrix = translationMatrix(tx, ty, tz)
            }
        }
    }

    // Get Axis (Z-axis) - if present, creates rotation
    const axisRef = axisPlacement.Axis
    if (axisRef?.value) {
        const axis = api.GetLine(modelID, axisRef.value)
        if (axis) {
            const axisCoords = extractCoordinates((axis as any).DirectionRatios || (axis as any).Coordinates)
            if (axisCoords.length >= 3) {
                // Normalize axis vector
                const len = Math.sqrt(axisCoords[0] ** 2 + axisCoords[1] ** 2 + axisCoords[2] ** 2)
                if (len > 1e-10) {
                    const zx = axisCoords[0] / len
                    const zy = axisCoords[1] / len
                    const zz = axisCoords[2] / len

                    // Get RefDirection (X-axis) - if present
                    const refDirRef = axisPlacement.RefDirection
                    let xx = 1, xy = 0, xz = 0
                    if (refDirRef?.value) {
                        const refDir = api.GetLine(modelID, refDirRef.value)
                        if (refDir) {
                            const refCoords = extractCoordinates((refDir as any).DirectionRatios || (refDir as any).Coordinates)
                            if (refCoords.length >= 3) {
                                const refLen = Math.sqrt(refCoords[0] ** 2 + refCoords[1] ** 2 + refCoords[2] ** 2)
                                if (refLen > 1e-10) {
                                    xx = refCoords[0] / refLen
                                    xy = refCoords[1] / refLen
                                    xz = refCoords[2] / refLen
                                }
                            }
                        }
                    } else {
                        // Default X-axis perpendicular to Z
                        if (Math.abs(zz) < 0.9) {
                            xx = 1
                            xy = 0
                            xz = 0
                        } else {
                            xx = 0
                            xy = 1
                            xz = 0
                        }
                    }

                    // Y-axis = Z cross X
                    const yx = zy * xz - zz * xy
                    const yy = zz * xx - zx * xz
                    const yz = zx * xy - zy * xx

                    // Build rotation matrix
                    const rotMatrix = [
                        xx, yx, zx, 0,
                        xy, yy, zy, 0,
                        xz, yz, zz, 0,
                        0, 0, 0, 1
                    ]

                    // Extract translation from current matrix
                    const tx = matrix[12]
                    const ty = matrix[13]
                    const tz = matrix[14]

                    // Combine rotation with translation
                    matrix = multiplyMatrices(rotMatrix, translationMatrix(tx, ty, tz))
                }
            }
        }
    }

    return matrix
}

/**
 * Recursively get world transformation matrix from IFCLOCALPLACEMENT hierarchy
 */
function getWorldTransformMatrix(api: IfcAPI, modelID: number, placementId: number): number[] {
    if (!placementId) {
        return identityMatrix()
    }

    const placement = api.GetLine(modelID, placementId)
    if (!placement) {
        return identityMatrix()
    }

    const placementTypeName = api.GetNameFromTypeCode ? api.GetNameFromTypeCode((placement as any).type) : ''
    if (!placementTypeName.toUpperCase().includes('LOCALPLACEMENT')) {
        return identityMatrix()
    }

    // Get RelativePlacement
    const relativePlacementRef = (placement as any).RelativePlacement
    let localMatrix = identityMatrix()

    if (relativePlacementRef?.value) {
        const axisPlacement = api.GetLine(modelID, relativePlacementRef.value)
        if (axisPlacement) {
            localMatrix = buildTransformFromAxisPlacement(api, modelID, axisPlacement)
        }
    }

    // Get parent placement (PlacementRelTo)
    const placementRelToRef = (placement as any).PlacementRelTo
    let parentMatrix = identityMatrix()

    if (placementRelToRef?.value) {
        // Recursively get parent transform
        parentMatrix = getWorldTransformMatrix(api, modelID, placementRelToRef.value)
    }

    // Multiply: world = parent * local
    return multiplyMatrices(parentMatrix, localMatrix)
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
            ifcAPIInstance.SetWasmPath('/wasm/web-ifc/', true)

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
                }


                // Empty string is not valid, treat as undefined
                if (globalId === '') {
                    globalId = undefined
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

/**
 * Extract length unit scale factor from IFC file
 * IFC files can use different length units (meters, feet, inches, etc.)
 * web-ifc StreamAllMeshes outputs geometry in METERS
 * This function returns the scale factor to convert from meters to the IFC file's native unit
 * 
 * @param api - Initialized IfcAPI instance
 * @param modelID - IFC model ID
 * @returns Scale factor (1.0 for meters, 3.28084 for feet, 1000 for millimeters, etc.)
 */
export function extractLengthUnitScale(api: IfcAPI, modelID: number): number {
    let lengthUnitScale = 1.0; // Default: 1.0 (meters, no scaling needed)

    try {
        // Find IFCPROJECT to get unit assignment
        const IFCPROJECT = (WebIFC as any).IFCPROJECT || 103090709;
        const projectIds = api.GetLineIDsWithType(modelID, IFCPROJECT);
        if (projectIds.size() > 0) {
            const project = api.GetLine(modelID, projectIds.get(0));
            if (!project) return lengthUnitScale;

            const unitsInContextRef = (project as any).UnitsInContext;
            if (unitsInContextRef?.value) {
                const unitAssignment = api.GetLine(modelID, unitsInContextRef.value);
                if (!unitAssignment) return lengthUnitScale;

                const units = (unitAssignment as any).Units;
                if (Array.isArray(units)) {
                    for (const unitRef of units) {
                        if (!unitRef?.value) continue;
                        const unit = api.GetLine(modelID, unitRef.value);
                        if (!unit) continue;

                        const unitTypeName = api.GetNameFromTypeCode ? api.GetNameFromTypeCode((unit as any).type) : '';

                        // Check if this is a length unit
                        const unitType = (unit as any).UnitType?.value || (unit as any).UnitType;
                        if (unitType === '.LENGTHUNIT.' || unitType === 'LENGTHUNIT') {
                            // Check if it's a conversion-based unit (like FOOT)
                            if (unitTypeName.toUpperCase().includes('CONVERSIONBASEDUNIT')) {
                                const conversionFactorRef = (unit as any).ConversionFactor;
                                if (conversionFactorRef?.value) {
                                    const measureWithUnit = api.GetLine(modelID, conversionFactorRef.value);
                                    if (measureWithUnit) {
                                        // Get the conversion factor (e.g., 0.3048 for feet to meters)
                                        const valueComponent = (measureWithUnit as any).ValueComponent;
                                        if (valueComponent) {
                                            let factor = (valueComponent as any).value || valueComponent;
                                            if (typeof factor === 'object' && (factor as any)._representationValue !== undefined) {
                                                factor = (factor as any)._representationValue;
                                            }
                                            if (typeof factor === 'number' && factor > 0) {
                                                // factor is meters-per-unit, we need to scale from meters to this unit
                                                // So we divide by factor (or multiply by 1/factor)
                                                lengthUnitScale = 1.0 / factor;
                                                break; // Found length unit, stop searching
                                            }
                                        }
                                    }
                                }
                            } else if (unitTypeName.toUpperCase().includes('SIUNIT')) {
                                // SI unit - check prefix for scaling (MILLI, CENTI, etc.)
                                const prefix = (unit as any).Prefix?.value || (unit as any).Prefix;
                                if (prefix === '.MILLI.' || prefix === 'MILLI') {
                                    lengthUnitScale = 1000.0; // millimeters to meters
                                } else if (prefix === '.CENTI.' || prefix === 'CENTI') {
                                    lengthUnitScale = 100.0; // centimeters to meters
                                }
                                break; // Found length unit, stop searching
                            }
                        }
                    }
                }
            }
        }
    } catch (e) {
        console.warn(`[extractLengthUnitScale] Could not extract length unit from IFC file: ${e}`);
    }

    return lengthUnitScale;
}

/**
 * Extract 2D profile outline from an IFCSPACE by traversing the IFC entity hierarchy
 * Returns the actual polygon boundary points from the profile definition
 * 
 * @param api - Initialized IfcAPI instance
 * @param modelID - IFC model ID
 * @param spaceExpressID - ExpressID of the IFCSPACE entity
 * @returns Array of 2D points representing the space outline, or null if extraction fails
 */
export async function extractSpaceProfileOutlines(
    api: IfcAPI,
    modelID: number,
    spaceExpressID: number
): Promise<THREE.Vector2[] | null> {
    try {
        // Step 1: Get IFCSPACE entity
        const space = api.GetLine(modelID, spaceExpressID)
        if (!space) {
            console.warn(`[extractSpaceProfileOutlines] Space ${spaceExpressID} not found`)
            return null
        }

        // Step 2: Get Representation property (IFCPRODUCTDEFINITIONSHAPE reference)
        const representationRef = (space as any).Representation
        if (!representationRef?.value) {
            console.warn(`[extractSpaceProfileOutlines] Space ${spaceExpressID} has no Representation`)
            return null
        }

        const productDefShapeId = representationRef.value
        const productDefShape = api.GetLine(modelID, productDefShapeId)
        if (!productDefShape) {
            console.warn(`[extractSpaceProfileOutlines] ProductDefinitionShape ${productDefShapeId} not found`)
            return null
        }

        // Step 3: Get Representations array (IFCSHAPEREPRESENTATION list)
        const representationsRef = (productDefShape as any).Representations
        if (!representationsRef) {
            console.warn(`[extractSpaceProfileOutlines] ProductDefinitionShape ${productDefShapeId} has no Representations`)
            return null
        }

        // Handle both array and single value
        const representationIds: number[] = []
        if (Array.isArray(representationsRef)) {
            for (const ref of representationsRef) {
                if (ref?.value) representationIds.push(ref.value)
            }
        } else if (representationsRef?.value) {
            representationIds.push(representationsRef.value)
        }

        if (representationIds.length === 0) {
            console.warn(`[extractSpaceProfileOutlines] No representation IDs found`)
            return null
        }

        // Step 4: Find representation with SweptSolid, Brep, or GeometricCurveSet type
        // Prefer FootPrint with GeometricCurveSet (direct 2D outline)
        // Fall back to Body with SweptSolid (extruded profile)
        let shapeRepresentation: any = null
        let shapeRepId: number | null = null
        let representationType: string | null = null

        // First pass: look for FootPrint with GeometricCurveSet (preferred for 2D outlines)
        for (const repId of representationIds) {
            const rep = api.GetLine(modelID, repId)
            if (!rep) continue

            const repType = (rep as any).RepresentationType?.value || (rep as any).RepresentationType
            const repIdentifier = (rep as any).RepresentationIdentifier?.value || (rep as any).RepresentationIdentifier

            if (repIdentifier === 'FootPrint' && repType === 'GeometricCurveSet') {
                shapeRepresentation = rep
                shapeRepId = repId
                representationType = 'GeometricCurveSet'
                break
            }
        }

        // Second pass: look for Body with SweptSolid/Brep
        if (!shapeRepresentation) {
            for (const repId of representationIds) {
                const rep = api.GetLine(modelID, repId)
                if (!rep) continue

                const repType = (rep as any).RepresentationType?.value || (rep as any).RepresentationType
                const repIdentifier = (rep as any).RepresentationIdentifier?.value || (rep as any).RepresentationIdentifier

                if (
                    (repIdentifier === 'Body' || repIdentifier === 'FootPrint') &&
                    (repType === 'SweptSolid' || repType === 'Brep' || repType === 'Curve2D')
                ) {
                    shapeRepresentation = rep
                    shapeRepId = repId
                    representationType = repType
                    break
                }
            }
        }

        if (!shapeRepresentation || !shapeRepId) {
            console.warn(`[extractSpaceProfileOutlines] No suitable ShapeRepresentation found for space ${spaceExpressID}`)
            return null
        }

        // Step 5: Get Items array
        const itemsRef = (shapeRepresentation as any).Items
        if (!itemsRef) {
            console.warn(`[extractSpaceProfileOutlines] ShapeRepresentation ${shapeRepId} has no Items`)
            return null
        }

        // Handle both array and single value
        const itemIds: number[] = []
        if (Array.isArray(itemsRef)) {
            for (const ref of itemsRef) {
                if (ref?.value) itemIds.push(ref.value)
            }
        } else if (itemsRef?.value) {
            itemIds.push(itemsRef.value)
        }

        if (itemIds.length === 0) {
            console.warn(`[extractSpaceProfileOutlines] No item IDs found`)
            return null
        }

        // Step 6: Get the first item
        const itemId = itemIds[0]
        const item = api.GetLine(modelID, itemId)
        if (!item) {
            console.warn(`[extractSpaceProfileOutlines] Item ${itemId} not found`)
            return null
        }

        const itemTypeName = api.GetNameFromTypeCode ? api.GetNameFromTypeCode((item as any).type) : ''
        const itemTypeUpper = itemTypeName.toUpperCase()

        // Step 7: Extract points based on representation type
        let points: THREE.Vector2[] = []

        // Handle GeometricCurveSet (FootPrint representation with direct 2D polyline)
        if (representationType === 'GeometricCurveSet' || itemTypeUpper.includes('GEOMETRICCURVESET')) {
            // IFCGEOMETRICCURVESET -> Elements (contains IFCPOLYLINE)
            const elementsRef = (item as any).Elements
            if (!elementsRef) {
                console.warn(`[extractSpaceProfileOutlines] GeometricCurveSet ${itemId} has no Elements`)
                return null
            }

            const elementIds: number[] = []
            if (Array.isArray(elementsRef)) {
                for (const ref of elementsRef) {
                    if (ref?.value) elementIds.push(ref.value)
                }
            } else if (elementsRef?.value) {
                elementIds.push(elementsRef.value)
            }

            if (elementIds.length === 0) {
                console.warn(`[extractSpaceProfileOutlines] GeometricCurveSet ${itemId} has no element IDs`)
                return null
            }

            // Get the polyline (first element)
            const polylineId = elementIds[0]
            const polyline = api.GetLine(modelID, polylineId)
            if (!polyline) {
                console.warn(`[extractSpaceProfileOutlines] Polyline ${polylineId} not found`)
                return null
            }

            const polylineTypeName = api.GetNameFromTypeCode ? api.GetNameFromTypeCode((polyline as any).type) : ''
            const polylineTypeUpper = polylineTypeName.toUpperCase()

            if (polylineTypeUpper.includes('POLYLINE')) {
                // Extract points directly from IFCPOLYLINE
                const pointsRef = (polyline as any).Points
                if (!pointsRef) {
                    console.warn(`[extractSpaceProfileOutlines] Polyline ${polylineId} has no Points`)
                    return null
                }

                const pointIds: number[] = []
                if (Array.isArray(pointsRef)) {
                    for (const ref of pointsRef) {
                        if (ref?.value) pointIds.push(ref.value)
                    }
                } else if (pointsRef?.value) {
                    pointIds.push(pointsRef.value)
                }

                for (const pointId of pointIds) {
                    const cartPoint = api.GetLine(modelID, pointId)
                    if (!cartPoint) continue
                    const coords = extractCoordinates((cartPoint as any).Coordinates)
                    if (coords.length >= 2) {
                        points.push(new THREE.Vector2(coords[0], coords[1]))
                    }
                }

                // FootPrint polylines are already in 2D local space
                // Apply only placement transform (no profile extrusion position)
                const placementRef = (space as any).ObjectPlacement
                if (placementRef?.value) {
                    const worldMatrix = getWorldTransformMatrix(api, modelID, placementRef.value)

                    // Transform 2D FootPrint points to 3D world coordinates
                    // FootPrint is defined in the space's local XY plane
                    // We need to map: local XY → world floor plane (XZ for Y-up, XY for Z-up)
                    const transformedPoints: Array<{ x: number; y: number; z: number }> = []
                    for (const point of points) {
                        // Apply 4x4 world transform
                        // Local footprint: X=horizontal1, Y=horizontal2, Z=0 (at floor level)
                        const x3d = point.x
                        const y3d = point.y
                        const z3d = 0

                        const wx = worldMatrix[0] * x3d + worldMatrix[4] * y3d + worldMatrix[8] * z3d + worldMatrix[12]
                        const wy = worldMatrix[1] * x3d + worldMatrix[5] * y3d + worldMatrix[9] * z3d + worldMatrix[13]
                        const wz = worldMatrix[2] * x3d + worldMatrix[6] * y3d + worldMatrix[10] * z3d + worldMatrix[14]

                        transformedPoints.push({ x: wx, y: wy, z: wz })
                    }

                    // Return points projected to floor plan
                    // web-ifc's StreamAllMeshes converts IFC Z-up to Three.js Y-up:
                    // - IFC X → Three.js X (same)
                    // - IFC Y → Three.js Z (negated: web-ifc Z = -IFC Y)
                    // - IFC Z → Three.js Y
                    // FootPrint is in IFC world coordinates, so we need to apply same conversion
                    // For floor plan: use (wx, -wy) to match element coordinates
                    return transformedPoints.map(p => new THREE.Vector2(p.x, -p.y))
                }

                // No placement, return raw 2D points
                return points
            } else {
                console.warn(`[extractSpaceProfileOutlines] GeometricCurveSet element is ${polylineTypeName}, not POLYLINE`)
                return null
            }
        }

        // Handle SweptSolid (Body representation with extruded profile)
        // Step 7: Extract profile from the item
        // For IFCEXTRUDEDAREASOLID, get SweptArea property
        const sweptAreaRef = (item as any).SweptArea
        if (!sweptAreaRef?.value) {
            console.warn(`[extractSpaceProfileOutlines] Item ${itemId} has no SweptArea`)
            return null
        }

        const profileId = sweptAreaRef.value
        const profile = api.GetLine(modelID, profileId)
        if (!profile) {
            console.warn(`[extractSpaceProfileOutlines] Profile ${profileId} not found`)
            return null
        }

        // Step 8: Extract points based on profile type
        points = [] // Reuse existing variable (GeometricCurveSet branch returns early)

        const profileType = getIfcTypeName((profile as any).type) || ''
        const profileTypeUpper = profileType.toUpperCase()

        if (profileTypeUpper.includes('ARBITRARYCLOSEDPROFILEDEF')) {
            // IFCARBITRARYCLOSEDPROFILEDEF -> OuterCurve -> IFCPOLYLINE
            const outerCurveRef = (profile as any).OuterCurve
            if (!outerCurveRef?.value) {
                console.warn(`[extractSpaceProfileOutlines] Profile ${profileId} has no OuterCurve`)
                return null
            }

            const curveId = outerCurveRef.value
            const curve = api.GetLine(modelID, curveId)
            if (!curve) {
                console.warn(`[extractSpaceProfileOutlines] Curve ${curveId} not found`)
                return null
            }

            const curveType = getIfcTypeName((curve as any).type) || ''
            const curveTypeUpper = curveType.toUpperCase()

            if (curveTypeUpper.includes('POLYLINE')) {
                // IFCPOLYLINE -> Points array
                const pointsRef = (curve as any).Points
                if (!pointsRef) {
                    console.warn(`[extractSpaceProfileOutlines] Polyline ${curveId} has no Points`)
                    return null
                }

                // Handle array of point references
                const pointIds: number[] = []
                if (Array.isArray(pointsRef)) {
                    for (const ref of pointsRef) {
                        if (ref?.value) pointIds.push(ref.value)
                    }
                } else if (pointsRef?.value) {
                    pointIds.push(pointsRef.value)
                }

                // Extract coordinates from each point
                for (const pointId of pointIds) {
                    const point = api.GetLine(modelID, pointId)
                    if (!point) continue

                    const coords = (point as any).Coordinates
                    if (!coords) continue

                    // IFCCARTESIANPOINT has Coordinates array [x, y, z?]
                    // web-ifc returns coordinates as array of objects with _representationValue
                    let coordArray: number[] = []

                    if (Array.isArray(coords)) {
                        coordArray = coords.map((c: any) => {
                            if (typeof c === 'number') return c
                            if (c && typeof c === 'object' && '_representationValue' in c) {
                                return typeof c._representationValue === 'number' ? c._representationValue : parseFloat(c._representationValue || '0')
                            }
                            if (c && typeof c === 'object' && 'value' in c) {
                                return typeof c.value === 'number' ? c.value : parseFloat(c.value || '0')
                            }
                            return parseFloat(c || '0')
                        })
                    } else if (coords && (coords as any).value !== undefined) {
                        if (Array.isArray((coords as any).value)) {
                            coordArray = (coords as any).value.map((c: any) => {
                                if (typeof c === 'number') return c
                                if (c && typeof c === 'object' && '_representationValue' in c) {
                                    return typeof c._representationValue === 'number' ? c._representationValue : parseFloat(c._representationValue || '0')
                                }
                                return parseFloat(c || '0')
                            })
                        } else {
                            coordArray = [parseFloat((coords as any).value || '0')]
                        }
                    } else if (coords && typeof coords === 'object' && 'x' in coords) {
                        // Some IFC parsers return {x, y, z}
                        coordArray = [
                            typeof (coords as any).x === 'number' ? (coords as any).x : parseFloat((coords as any).x || '0'),
                            typeof (coords as any).y === 'number' ? (coords as any).y : parseFloat((coords as any).y || '0'),
                            typeof (coords as any).z === 'number' ? (coords as any).z : parseFloat((coords as any).z || '0'),
                        ]
                    }

                    if (coordArray.length >= 2) {
                        const x = coordArray[0]
                        const y = coordArray[1]
                        points.push(new THREE.Vector2(x, y))
                    }
                }
            } else if (curveTypeUpper.includes('COMPOSITECURVE')) {
                // IFCCOMPOSITECURVE -> Segments array
                const segmentsRef = (curve as any).Segments
                if (!segmentsRef) {
                    console.warn(`[extractSpaceProfileOutlines] CompositeCurve ${curveId} has no Segments`)
                    return null
                }

                // Extract points from all segments
                const segmentIds: number[] = []
                if (Array.isArray(segmentsRef)) {
                    for (const ref of segmentsRef) {
                        if (ref?.value) segmentIds.push(ref.value)
                    }
                } else if (segmentsRef?.value) {
                    segmentIds.push(segmentsRef.value)
                }

                for (const segmentId of segmentIds) {
                    const segment = api.GetLine(modelID, segmentId)
                    if (!segment) continue

                    // Get ParentCurve from segment
                    const parentCurveRef = (segment as any).ParentCurve
                    if (!parentCurveRef?.value) continue

                    const parentCurve = api.GetLine(modelID, parentCurveRef.value)
                    if (!parentCurve) continue

                    // Try to extract points from parent curve (could be polyline, trimmed curve, etc.)
                    const parentCurveType = getIfcTypeName((parentCurve as any).type) || ''
                    if (parentCurveType.toUpperCase().includes('POLYLINE')) {
                        const pointsRef = (parentCurve as any).Points
                        if (pointsRef) {
                            const pointIds: number[] = []
                            if (Array.isArray(pointsRef)) {
                                for (const ref of pointsRef) {
                                    if (ref?.value) pointIds.push(ref.value)
                                }
                            } else if (pointsRef?.value) {
                                pointIds.push(pointsRef.value)
                            }

                            for (const pointId of pointIds) {
                                const point = api.GetLine(modelID, pointId)
                                if (!point) continue

                                const coords = (point as any).Coordinates
                                if (coords) {
                                    let coordArray: number[] = []

                                    if (Array.isArray(coords)) {
                                        coordArray = coords.map((c: any) => {
                                            if (typeof c === 'number') return c
                                            if (c && typeof c === 'object' && '_representationValue' in c) {
                                                return typeof c._representationValue === 'number' ? c._representationValue : parseFloat(c._representationValue || '0')
                                            }
                                            if (c && typeof c === 'object' && 'value' in c) {
                                                return typeof c.value === 'number' ? c.value : parseFloat(c.value || '0')
                                            }
                                            return parseFloat(c || '0')
                                        })
                                    } else if (coords && (coords as any).value !== undefined) {
                                        if (Array.isArray((coords as any).value)) {
                                            coordArray = (coords as any).value.map((c: any) => {
                                                if (typeof c === 'number') return c
                                                if (c && typeof c === 'object' && '_representationValue' in c) {
                                                    return typeof c._representationValue === 'number' ? c._representationValue : parseFloat(c._representationValue || '0')
                                                }
                                                return parseFloat(c || '0')
                                            })
                                        } else {
                                            coordArray = [parseFloat((coords as any).value || '0')]
                                        }
                                    } else if (coords && typeof coords === 'object' && 'x' in coords) {
                                        coordArray = [
                                            typeof (coords as any).x === 'number' ? (coords as any).x : parseFloat((coords as any).x || '0'),
                                            typeof (coords as any).y === 'number' ? (coords as any).y : parseFloat((coords as any).y || '0'),
                                            typeof (coords as any).z === 'number' ? (coords as any).z : parseFloat((coords as any).z || '0'),
                                        ]
                                    }

                                    if (coordArray.length >= 2) {
                                        const x = coordArray[0]
                                        const y = coordArray[1]
                                        points.push(new THREE.Vector2(x, y))
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } else if (profileTypeUpper.includes('RECTANGLEPROFILEDEF')) {
            // IFCRECTANGLEPROFILEDEF -> XDim, YDim, Position
            const xDim = (profile as any).XDim?.value || (profile as any).XDim
            const yDim = (profile as any).YDim?.value || (profile as any).YDim
            const positionRef = (profile as any).Position

            let offsetX = 0
            let offsetY = 0

            if (positionRef?.value) {
                const position = api.GetLine(modelID, positionRef.value)
                if (position) {
                    const locationRef = (position as any).Location
                    if (locationRef?.value) {
                        const location = api.GetLine(modelID, locationRef.value)
                        if (location) {
                            const coords = (location as any).Coordinates
                            if (coords) {
                                let coordArray: number[] = []

                                if (Array.isArray(coords)) {
                                    coordArray = coords.map((c: any) => {
                                        if (typeof c === 'number') return c
                                        if (c && typeof c === 'object' && '_representationValue' in c) {
                                            return typeof c._representationValue === 'number' ? c._representationValue : parseFloat(c._representationValue || '0')
                                        }
                                        if (c && typeof c === 'object' && 'value' in c) {
                                            return typeof c.value === 'number' ? c.value : parseFloat(c.value || '0')
                                        }
                                        return parseFloat(c || '0')
                                    })
                                } else if (coords && (coords as any).value !== undefined) {
                                    if (Array.isArray((coords as any).value)) {
                                        coordArray = (coords as any).value.map((c: any) => {
                                            if (typeof c === 'number') return c
                                            if (c && typeof c === 'object' && '_representationValue' in c) {
                                                return typeof c._representationValue === 'number' ? c._representationValue : parseFloat(c._representationValue || '0')
                                            }
                                            return parseFloat(c || '0')
                                        })
                                    } else {
                                        coordArray = [parseFloat((coords as any).value || '0')]
                                    }
                                } else if (coords && typeof coords === 'object' && 'x' in coords) {
                                    coordArray = [
                                        typeof (coords as any).x === 'number' ? (coords as any).x : parseFloat((coords as any).x || '0'),
                                        typeof (coords as any).y === 'number' ? (coords as any).y : parseFloat((coords as any).y || '0'),
                                        typeof (coords as any).z === 'number' ? (coords as any).z : parseFloat((coords as any).z || '0'),
                                    ]
                                }

                                if (coordArray.length >= 2) {
                                    offsetX = coordArray[0]
                                    offsetY = coordArray[1]
                                }
                            }
                        }
                    }
                }
            }

            const xDimVal = typeof xDim === 'number' ? xDim : parseFloat(xDim || '0')
            const yDimVal = typeof yDim === 'number' ? yDim : parseFloat(yDim || '0')

            // Create rectangle polygon
            points = [
                new THREE.Vector2(offsetX, offsetY),
                new THREE.Vector2(offsetX + xDimVal, offsetY),
                new THREE.Vector2(offsetX + xDimVal, offsetY + yDimVal),
                new THREE.Vector2(offsetX, offsetY + yDimVal),
            ]
        } else {
            console.warn(`[extractSpaceProfileOutlines] Unsupported profile type: ${profileType}`)
            return null
        }

        if (points.length < 3) {
            console.warn(`[extractSpaceProfileOutlines] Insufficient points extracted: ${points.length}`)
            return null
        }

        // Step 9: Apply full world placement transform (same as FootPrint path)
        // Get ObjectPlacement from IFCSPACE
        const objectPlacementRef = (space as any).ObjectPlacement
        if (objectPlacementRef?.value) {
            const worldMatrix = getWorldTransformMatrix(api, modelID, objectPlacementRef.value)

            // Transform 2D profile points to 3D world coordinates
            // Profile points are in the extrusion's local XY plane (Z=0)
            // We need to map: local XY → world floor plane (XZ for Y-up, XY for Z-up)
            const transformedPoints: Array<{ x: number; y: number; z: number }> = []
            for (const point of points) {
                // Profile point is 2D (x, y) in the extrusion's XY plane
                // Treat as (x, y, 0) in local 3D space
                const x3d = point.x
                const y3d = point.y
                const z3d = 0

                // Apply 4x4 world transformation matrix
                const wx = worldMatrix[0] * x3d + worldMatrix[4] * y3d + worldMatrix[8] * z3d + worldMatrix[12]
                const wy = worldMatrix[1] * x3d + worldMatrix[5] * y3d + worldMatrix[9] * z3d + worldMatrix[13]
                const wz = worldMatrix[2] * x3d + worldMatrix[6] * y3d + worldMatrix[10] * z3d + worldMatrix[14]

                transformedPoints.push({ x: wx, y: wy, z: wz })
            }

            // Project to 2D floor plan based on coordinate system
            // web-ifc's StreamAllMeshes converts IFC Z-up to Three.js Y-up:
            // - IFC X → Three.js X (same)
            // - IFC Y → Three.js Z (negated: web-ifc Z = -IFC Y)
            // - IFC Z → Three.js Y
            // For floor plan: use (wx, -wy) to match element coordinates
            return transformedPoints.map(p => new THREE.Vector2(p.x, -p.y))
        }

        return points
    } catch (error) {
        console.error(`[extractSpaceProfileOutlines] Error extracting profile for space ${spaceExpressID}:`, error)
        return null
    }
}

