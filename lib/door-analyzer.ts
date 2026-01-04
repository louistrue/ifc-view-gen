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
 */
async function getDoorTypeInfo(model: LoadedIFCModel, doorExpressID: number, doorElement?: ElementInfo): Promise<{ direction: string | null, typeName: string | null }> {
    const result = { direction: null as string | null, typeName: null as string | null }

    // Check if this is a fragments model (has fragmentsModel property)
    const fragmentsModel = (model as any).fragmentsModel;

    if (fragmentsModel) {
        // Fragments model path - use already-extracted data (fast, no API calls)
        // The typeName was already extracted during model loading
        if (doorElement?.typeName) {
            result.typeName = doorElement.typeName;
        }
        // Note: Opening direction would require additional API calls to get OperationType
        // For performance, we skip this for fragments models (can be added later if needed)
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
 * Analyze all doors in the model and find their context (host wall, nearby devices, opening direction, type name)
 */
export async function analyzeDoors(model: LoadedIFCModel, secondaryModel?: LoadedIFCModel): Promise<DoorContext[]> {
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

        // CRITICAL: Ensure door bounding box and center are derived from WORLD coordinates
        // The loader might give local boxes or stale ones.
        if (door.mesh) {
            door.mesh.updateMatrixWorld(true)
            const worldBox = new THREE.Box3().setFromObject(door.mesh)
            door.boundingBox = worldBox
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
        const { direction: openingDirection, typeName: doorTypeName } = await getDoorTypeInfo(model, door.expressID, door)

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
        })
    }

    return doorContexts
}

/**
 * Get all meshes for a door context
 * Only returns the door mesh - wall geometry is typically too large to be useful
 */
export function getContextMeshes(context: DoorContext): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = []

    // Only collect door meshes - wall geometry is usually the entire wall, not useful
    const doorMeshes = collectMeshesFromElement(context.door)
    console.log(`  Door meshes: ${doorMeshes.length}`)
    meshes.push(...doorMeshes)

    // Add host wall meshes if available
    // if (context.hostWall) {
    //     const wallMeshes = collectMeshesFromElement(context.hostWall)
    //     console.log(`  Wall meshes: ${wallMeshes.length}`)
    //     meshes.push(...wallMeshes)
    // }

    // Add nearby device meshes
    for (const device of context.nearbyDevices) {
        const deviceMeshes = collectMeshesFromElement(device)
        console.log(`  Device meshes (${device.typeName}): ${deviceMeshes.length}`)
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

