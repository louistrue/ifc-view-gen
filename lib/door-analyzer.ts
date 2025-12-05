import * as THREE from 'three'
import type { ElementInfo, LoadedIFCModel } from './ifc-types'

export interface DoorContext {
    door: ElementInfo
    wall: ElementInfo | null
    nearbyDevices: ElementInfo[]
    normal: THREE.Vector3
    center: THREE.Vector3
    doorId: string
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
        // Also check type code if available (IFCDOOR is typically type 64)
        (ifcType !== undefined && (ifcType === 64 || ifcType === 0))
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
        // Also check type code if available (IFCWALL is typically type 65)
        (ifcType !== undefined && (ifcType === 65 || ifcType === 1))
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
        lower.includes('distribution')
    )
}

/**
 * Calculate the normal vector of a door based on bounding box
 * The door face normal is along the SMALLEST horizontal dimension (thickness)
 * This is the direction we want to look FROM to see the door front
 */
function calculateDoorNormal(door: ElementInfo): THREE.Vector3 {
    if (!door.boundingBox) {
        return new THREE.Vector3(0, 0, 1)
    }

    const size = door.boundingBox.getSize(new THREE.Vector3())

    // Debug: log dimensions
    console.log(`Door ${door.expressID} bbox size: X=${size.x.toFixed(3)}, Y=${size.y.toFixed(3)}, Z=${size.z.toFixed(3)}`)

    // Y is typically height (vertical). We need to find which horizontal axis is the door thickness.
    // Door thickness is the SMALLEST horizontal dimension.
    // The viewing normal should be ALONG that axis (perpendicular to door face).

    // Compare X and Z (horizontal dimensions)
    if (size.x < size.z) {
        // X is smaller = door is thin in X direction = door face is in YZ plane
        // To see the front, look along X axis
        console.log(`Door ${door.expressID}: Normal along X (door thin in X)`)
        return new THREE.Vector3(1, 0, 0)
    } else {
        // Z is smaller = door is thin in Z direction = door face is in XY plane  
        // To see the front, look along Z axis
        console.log(`Door ${door.expressID}: Normal along Z (door thin in Z)`)
        return new THREE.Vector3(0, 0, 1)
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
        console.log(`Door ${door.expressID}: No bounding box`)
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
        console.log(`Door ${door.expressID}: Found host wall ${closestWall.expressID}`)
    } else {
        console.log(`Door ${door.expressID}: No host wall found (checked ${walls.length} walls)`)
    }

    return closestWall
}

/**
 * Find electrical devices within 1m radius of a door on both sides
 */
function findNearbyDevices(
    door: ElementInfo,
    devices: ElementInfo[],
    radius: number = 1.0
): ElementInfo[] {
    if (!door.boundingBox) return []

    const doorCenter = door.boundingBox.getCenter(new THREE.Vector3())
    const nearby: ElementInfo[] = []

    for (const device of devices) {
        if (!device.boundingBox) continue

        const deviceCenter = device.boundingBox.getCenter(new THREE.Vector3())
        const distance = doorCenter.distanceTo(deviceCenter)

        if (distance <= radius) {
            nearby.push(device)
        }
    }

    return nearby
}

/**
 * Analyze all doors in the model and find their context (walls, devices)
 */
export function analyzeDoors(model: LoadedIFCModel): DoorContext[] {
    // Separate elements by type
    const doors: ElementInfo[] = []
    const walls: ElementInfo[] = []
    const devices: ElementInfo[] = []

    for (const element of model.elements) {
        // Log first few elements to debug
        if (model.elements.indexOf(element) < 5) {
            console.log(`Element ${element.expressID}: typeName="${element.typeName}", ifcType=${element.ifcType}`)
        }

        if (isDoorType(element.typeName, element.ifcType)) {
            doors.push(element)
            console.log(`Found door: ExpressID ${element.expressID}, typeName="${element.typeName}"`)
        } else if (isWallType(element.typeName, element.ifcType)) {
            walls.push(element)
        } else if (isElectricalDeviceType(element.typeName)) {
            devices.push(element)
        }
    }

    console.log(`Found ${doors.length} doors, ${walls.length} walls, ${devices.length} electrical devices`)

    // Analyze each door
    const doorContexts: DoorContext[] = []

    for (const door of doors) {
        const wall = findHostWall(door, walls)
        const nearbyDevices = findNearbyDevices(door, devices, 1.0)

        const center = door.boundingBox
            ? door.boundingBox.getCenter(new THREE.Vector3())
            : new THREE.Vector3(0, 0, 0)

        const normal = calculateDoorNormal(door)

        doorContexts.push({
            door,
            wall,
            nearbyDevices,
            normal,
            center,
            doorId: `door_${door.expressID}`,
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

    // Skip wall meshes - they're typically entire walls, not door frames
    // Skip device meshes - they're often far from the door

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

