import * as THREE from 'three'

/**
 * IFC Type Constants for web-ifc
 * These correspond to the IFC type enumeration values used by web-ifc
 */

// Common IFC element types - web-ifc uses numeric constants
// Note: These are approximations - web-ifc may use different values
// We'll need to check the actual API at runtime

export interface ElementInfo {
    expressID: number
    ifcType: number
    typeName: string // IFC class name (e.g., "IFCDOOR", "IFCWALL")
    productTypeName?: string // Product type name from IfcRelDefinesByType (e.g., "Door Type A")
    mesh: THREE.Mesh
    meshes?: THREE.Mesh[] // All meshes for this element
    boundingBox?: THREE.Box3
    globalId?: string // IFC GlobalId (GUID) of the element
}

export interface LoadedIFCModel {
    group: THREE.Group
    elements: ElementInfo[]
    modelID: number
    api: any // IfcAPI instance
}
