import * as THREE from 'three'
import type { ElementInfo, LoadedIFCModel } from './ifc-types'
import * as WebIFC from 'web-ifc'

export interface DoorContext {
    door: ElementInfo
    wall: ElementInfo | null
    hostWall: ElementInfo | null
    nearbyDevices: ElementInfo[]
    normal: THREE.Vector3
    center: THREE.Vector3
    doorId: string
    openingDirection: string | null
    doorTypeName: string | null
    storeyName: string | null  // Building storey name from spatial structure

    // Detailed geometry from web-ifc (for high-quality SVG rendering)
    detailedGeometry?: {
        doorMeshes: THREE.Mesh[]
        wallMeshes: THREE.Mesh[]
        deviceMeshes: THREE.Mesh[]
    }
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
    return (
        lower.includes('wall') ||
        typeName === 'IFCWALL' ||
        typeName === 'IFCWALLSTANDARDCASE' ||
        typeName.startsWith('IFCWALL') ||
        // Check regular type code
        (ifcType !== undefined && (
            ifcType === WebIFC.IFCWALL ||
            ifcType === WebIFC.IFCWALLSTANDARDCASE ||
            ifcType === 65
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
        lower.includes('switch') ||
        lower.includes('outlet') ||
        lower.includes('socket') ||
        lower.includes('light') ||
        lower.includes('fixture') ||
        lower.includes('panel') ||
        lower.includes('distribution') ||
        typeName === 'IFCELECTRICAPPLIANCE' ||
        typeName.startsWith('IFCELECTRICAPPLIANCE')
    )
}

/**
 * Calculate the normal vector of an element based on mesh rotation (preferred) or bounding box
 * The element face normal is along the SMALLEST horizontal dimension (thickness)
 * This is the direction we want to look FROM to see the element front
 */
function calculateElementNormal(element: ElementInfo): THREE.Vector3 {
    // Prioritize world-space bounding box from Fragments getBoxes() API
    // This is the most reliable source since it's already in world space
    if (element.boundingBox) {
        const size = element.boundingBox.getSize(new THREE.Vector3())

        // Thickness is the smallest horizontal dimension (X or Z)
        // Y is height (vertical), so we compare X and Z
        if (size.x < size.z) {
            return new THREE.Vector3(1, 0, 0)
        } else {
            return new THREE.Vector3(0, 0, 1)
        }
    }

    // Fallback: Try to use mesh geometry if bounding box not available
    if (element.mesh) {
        const mesh = element.mesh
        mesh.updateMatrixWorld(true)

        if (mesh.geometry) {
            if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
            const geom = mesh.geometry
            if (geom.boundingBox) {
                const localSize = geom.boundingBox.getSize(new THREE.Vector3())

                // Determine Local Normal Axis
                // Assume Y is Up (Height). 
                // Thickness is min(X, Z).
                let localNormal = new THREE.Vector3(0, 0, 1) // Default Z
                if (localSize.x < localSize.z) {
                    localNormal.set(1, 0, 0)
                }

                // Transform Local Normal to World Normal using Mesh Rotation
                const rotationMatrix = new THREE.Matrix4().extractRotation(mesh.matrixWorld)
                const worldNormal = localNormal.applyMatrix4(rotationMatrix).normalize()

                return worldNormal
            }
        }
    }

    // Default fallback
    return new THREE.Vector3(0, 0, 1)
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

/**
 * Find electrical devices within 1m radius of a door on both sides
 */
function findNearbyDevices(
    door: ElementInfo,
    devices: ElementInfo[],
    normal: THREE.Vector3,
    radius: number = 1.0
): ElementInfo[] {
    if (!door.boundingBox) return []

    const doorCenter = door.boundingBox.getCenter(new THREE.Vector3())
    const nearby: ElementInfo[] = []

    for (const device of devices) {
        if (!device.boundingBox) continue

        const deviceCenter = device.boundingBox.getCenter(new THREE.Vector3())
        const distance = doorCenter.distanceTo(deviceCenter)

        // Check if device is roughly in the same plane as the door (wall)
        // Vector from door to device
        const toDevice = deviceCenter.clone().sub(doorCenter)

        // Project vector onto door normal (which points OUT of the wall)
        // This gives the distance perpendicular to the wall plane
        const distFromPlane = Math.abs(toDevice.dot(normal))

        // Threshold: 30cm (0.3m). Standard walls are ~10-20cm. 
        // If device is >30cm away from the plane, it's likely on a perpendicular wall.
        const isAlignedWithWallPlane = distFromPlane < 0.3

        // NEW: Check orientation match
        // Even if device is "in plane" (e.g. at corner), it might be on perpendicular wall.
        // We check if Element Normal is parallel to Door Normal.
        const deviceNormal = calculateElementNormal(device)
        const orientationDot = Math.abs(normal.dot(deviceNormal))

        // Dot product of parallel vectors is 1 (or -1). Perpendicular is 0.
        // Allow some tolerance (e.g. > 0.8 means < ~36 degrees difference)
        const isOrientationMatching = orientationDot > 0.8

        if (distance <= radius && isAlignedWithWallPlane && isOrientationMatching) {
            nearby.push(device)
        }
    }

    return nearby
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

    // Check if we have OperationType from web-ifc extraction (preferred method)
    if (operationTypeMap && operationTypeMap.has(doorExpressID)) {
        result.direction = operationTypeMap.get(doorExpressID) || null
        console.log(`[getDoorTypeInfo] Door ${doorExpressID}: Using OperationType from web-ifc map: ${result.direction}`)
    }

    // Check if this is a fragments model (has fragmentsModel property)
    const fragmentsModel = (model as any).fragmentsModel;
    console.log(`[getDoorTypeInfo] Door ${doorExpressID}: fragmentsModel=${!!fragmentsModel}, doorElement.productTypeName=${doorElement?.productTypeName}`);

    if (fragmentsModel) {
        // Fragments model path - use already-extracted data (fast, no API calls)
        // Use productTypeName (from IfcDoorType via IfcRelDefinesByType) - the real type name
        // Fall back to typeName (IFC class name) if productTypeName not available
        if (doorElement?.productTypeName) {
            result.typeName = doorElement.productTypeName;
        } else if (doorElement?.typeName) {
            result.typeName = doorElement.typeName;
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

                    // Debug: log what we got
                    console.log(`[getDoorTypeInfo] Door ${doorExpressID} data keys:`, Object.keys(data || {}));
                    console.log(`[getDoorTypeInfo] OperationType:`, data?.OperationType);
                    console.log(`[getDoorTypeInfo] IsTypedBy:`, data?.IsTypedBy);

                    // Check instance OperationType first
                    // OperationType might be stored as {value: "SINGLE_SWING_LEFT"} or just a string
                    let operationType = null;
                    if (data.OperationType) {
                        operationType = typeof data.OperationType === 'object' ? data.OperationType.value : data.OperationType;
                    }

                    if (operationType && operationType !== 'NOTDEFINED' && operationType !== '') {
                        result.direction = operationType;
                        console.log(`[getDoorTypeInfo] Found OperationType on instance: ${operationType}`);
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
                                    console.log(`[getDoorTypeInfo] Found OperationType on type: ${typeOperationType}`);
                                    break;
                                }
                            }
                        }
                    }

                    if (!result.direction) {
                        console.log(`[getDoorTypeInfo] No OperationType found for door ${doorExpressID}`);
                    }
                } else {
                    console.log(`[getDoorTypeInfo] No data returned for door ${doorExpressID}`);
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
                            result.typeName = type.Name.value
                        }

                        // Only overwrite direction if not found on instance
                        if (!result.direction && type.OperationType && type.OperationType.value) {
                            result.direction = type.OperationType.value;
                        }

                        return result;
                    }
                }
            }

            // Fallback to ElementInfo typeName
            if (!result.typeName && doorElement?.typeName) {
                result.typeName = doorElement.typeName;
            }

        } catch (e) {
            console.warn('Error getting door type info from web-ifc:', e);
            // Fallback to ElementInfo typeName
            if (doorElement?.typeName) {
                result.typeName = doorElement.typeName;
            }
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
    operationTypeMap?: Map<number, string>
): Promise<DoorContext[]> {
    // Build storey map from spatial structure for quick lookup
    const storeyMap = buildStoreyMap(spatialStructure)
    console.log(`Built storey map with ${storeyMap.size} element mappings`)

    // Separate elements by type
    const doors: ElementInfo[] = []
    const walls: ElementInfo[] = []
    const devices: ElementInfo[] = []

    // Helper to process elements from a model
    const processElements = (elements: ElementInfo[]) => {
        for (const element of elements) {
            if (isDoorType(element.typeName, element.ifcType)) {
                doors.push(element)
                // console.log(`Found door: ExpressID ${element.expressID}, typeName="${element.typeName}"`)
            } else if (isWallType(element.typeName, element.ifcType)) {
                walls.push(element)
            } else if (isElectricalDeviceType(element.typeName)) {
                devices.push(element)
            }
        }
    }

    // Process primary model
    processElements(model.elements)

    // Process secondary model if provided
    if (secondaryModel) {
        console.log(`Processing secondary model elements: ${secondaryModel.elements.length}`)
        processElements(secondaryModel.elements)
    }

    console.log(`Found ${doors.length} doors, ${walls.length} walls, ${devices.length} electrical devices`)

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

        // Default normal from door
        let normal = calculateElementNormal(door)
        const hostWall = findHostWall(door, walls, 0.3)

        // IMPROVEMENT: Use Host Wall normal if available and aligned
        // This ensures the camera aligns with the WALL plane, which is the reference for devices.
        if (hostWall) {
            const wallNormal = calculateElementNormal(hostWall)
            // Check if wall normal is roughly parallel to door normal (dot > 0.8)
            // If they are parallel (same direction OR opposite), we might want to align to wall.
            // But strict parallel check: abs(dot) > 0.8
            if (Math.abs(normal.dot(wallNormal)) > 0.8) {
                // Use Wall Normal, but ensure it points in same general direction as Door Normal
                if (normal.dot(wallNormal) < 0) {
                    normal = wallNormal.negate()
                } else {
                    normal = wallNormal
                }
            }
        }

        // Find devices using the (potentially updated) normal
        const nearbyDevices = findNearbyDevices(door, devices, normal, 1.0)

        const center = door.boundingBox
            ? door.boundingBox.getCenter(new THREE.Vector3())
            : new THREE.Vector3(0, 0, 0)

        // const normal = calculateDoorNormal(door) // Moved up

        // Use GlobalId for doorId if available, otherwise fallback to ExpressID (no prefix)
        const doorId = door.globalId || String(door.expressID)

        // Get opening direction and type name
        console.log(`[analyzeDoors] Calling getDoorTypeInfo for door ${door.expressID}, model type:`, (model as any).fragmentsModel ? 'Fragments' : 'web-ifc')
        const { direction: openingDirection, typeName: doorTypeName } = await getDoorTypeInfo(model, door.expressID, door, operationTypeMap)
        console.log(`[analyzeDoors] Got openingDirection=${openingDirection}, doorTypeName=${doorTypeName}`)

        // Get storey name from spatial structure
        const storeyName = storeyMap.get(door.expressID) || null

        doorContexts.push({
            door,
            wall: null, // Legacy field
            hostWall,
            nearbyDevices,
            normal,
            center,
            doorId,
            openingDirection,
            doorTypeName,
            storeyName,
        })
    }

    return doorContexts
}

/**
 * Get all meshes for a door context
 * Prefers detailed geometry from web-ifc if available, falls back to Fragments geometry
 */
export function getContextMeshes(context: DoorContext): THREE.Mesh[] {
    // Use detailed geometry if available (from web-ifc, high quality)
    if (context.detailedGeometry) {
        const { doorMeshes, wallMeshes, deviceMeshes } = context.detailedGeometry
        const totalVerts = [...doorMeshes, ...deviceMeshes].reduce(
            (sum, m) => sum + (m.geometry?.attributes?.position?.count || 0), 0
        )
        console.log(`[getContextMeshes] Door ${context.doorId}: using DETAILED geometry (${doorMeshes.length} door meshes, ${totalVerts} verts)`)

        // Return door meshes + device meshes (not wall - too large for SVG)
        return [...doorMeshes, ...deviceMeshes]
    }

    // Fallback to Fragments geometry (simplified)
    const meshes: THREE.Mesh[] = []
    const doorMeshes = collectMeshesFromElement(context.door)
    console.log(`[getContextMeshes] Door ${context.doorId}: using FRAGMENTS geometry (${doorMeshes.length} meshes, simplified)`)

    for (const mesh of doorMeshes) {
        const posCount = mesh.geometry?.attributes?.position?.count || 0
        console.log(`  - Mesh: positions=${posCount}`)
    }

    meshes.push(...doorMeshes)

    for (const device of context.nearbyDevices) {
        const deviceMeshes = collectMeshesFromElement(device)
        meshes.push(...deviceMeshes)
    }

    return meshes
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
    modelCenterOffset: THREE.Vector3
): Promise<void> {
    // Dynamically import to avoid circular dependencies
    const { extractDetailedGeometry } = await import('./ifc-loader')

    // Collect all unique expressIDs we need geometry for
    const doorIDs = new Set<number>()
    const wallIDs = new Set<number>()
    const deviceIDs = new Set<number>()

    for (const context of doorContexts) {
        doorIDs.add(context.door.expressID)
        if (context.hostWall) {
            wallIDs.add(context.hostWall.expressID)
        }
        for (const device of context.nearbyDevices) {
            deviceIDs.add(device.expressID)
        }
    }

    console.log(`[loadDetailedGeometry] Extracting geometry for ${doorIDs.size} doors, ${wallIDs.size} walls, ${deviceIDs.size} devices`)
    console.log(`[loadDetailedGeometry] Centering offset to apply: (${modelCenterOffset.x.toFixed(2)}, ${modelCenterOffset.y.toFixed(2)}, ${modelCenterOffset.z.toFixed(2)})`)

    // Extract all geometry in one pass
    const allIDs = [...doorIDs, ...wallIDs, ...deviceIDs]
    const geometryMap = await extractDetailedGeometry(file, allIDs)

    // Apply centering offset to all extracted meshes
    let meshCount = 0
    for (const meshes of geometryMap.values()) {
        for (const mesh of meshes) {
            if (mesh.geometry) {
                mesh.geometry.translate(-modelCenterOffset.x, -modelCenterOffset.y, -modelCenterOffset.z)
                meshCount++
            }
        }
    }
    console.log(`[loadDetailedGeometry] Applied centering offset to ${meshCount} meshes`)

    // Populate each door context with its geometry
    for (const context of doorContexts) {
        const doorMeshes = geometryMap.get(context.door.expressID) || []
        const wallMeshes = context.hostWall
            ? (geometryMap.get(context.hostWall.expressID) || [])
            : []
        const deviceMeshes: THREE.Mesh[] = []
        for (const device of context.nearbyDevices) {
            const meshes = geometryMap.get(device.expressID) || []
            deviceMeshes.push(...meshes)
        }

        context.detailedGeometry = {
            doorMeshes,
            wallMeshes,
            deviceMeshes,
        }
    }

    console.log(`[loadDetailedGeometry] Complete`)
}

