import * as THREE from 'three'
import type { FragmentsModel, FragmentsModels } from '@thatopen/fragments'

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
    typeName: string
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

/**
 * Extended model info for multi-model management
 */
export interface LoadedModel {
    id: string
    fileName: string
    group: THREE.Group
    elements: ElementInfo[]
    fragmentsModel?: FragmentsModel
    fragmentsManager?: FragmentsModels
    color: string // Display color for UI
    visible: boolean
    loadedAt: Date
    elementCount: number
}
