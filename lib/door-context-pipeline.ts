import * as THREE from 'three'
import {
    extractDoorCsetStandardCH,
    extractDoorLeafMetadata,
    extractDoorOperationTypes,
    loadIFCModelWithMetadata,
    type DoorCsetStandardCHData,
    type DoorLeafMetadata,
} from './ifc-loader'
import { analyzeDoors, loadDetailedGeometry, type DoorContext } from './door-analyzer'
import type { LoadedIFCModel } from './ifc-types'

type OffsettableModel = Pick<LoadedIFCModel, 'group' | 'elements'>

export function inferModelCenterOffset(model: LoadedIFCModel): THREE.Vector3 {
    return new THREE.Box3().setFromObject(model.group).getCenter(new THREE.Vector3())
}

export function applyModelOffset(
    model: OffsettableModel | undefined,
    offset: THREE.Vector3,
    includeGroup = true
): void {
    if (!model || offset.lengthSq() === 0) return

    if (includeGroup) {
        model.group.position.sub(offset)
    }

    for (const element of model.elements ?? []) {
        if (element.boundingBox) {
            element.boundingBox.min.sub(offset)
            element.boundingBox.max.sub(offset)
        }
        if (element.meshes) {
            for (const mesh of element.meshes) {
                if (mesh.geometry) {
                    mesh.geometry = mesh.geometry.clone()
                    mesh.geometry.translate(-offset.x, -offset.y, -offset.z)
                }
            }
        }
        if (element.mesh?.geometry) {
            element.mesh.geometry = element.mesh.geometry.clone()
            element.mesh.geometry.translate(-offset.x, -offset.y, -offset.z)
        }
    }
}

export async function loadAnalysisModelWithOffset(
    file: File,
    options: {
        modelCenterOffset?: THREE.Vector3
        includeGroup?: boolean
    } = {}
): Promise<{ model: LoadedIFCModel; modelCenterOffset: THREE.Vector3 }> {
    const model = await loadIFCModelWithMetadata(file)
    const modelCenterOffset = options.modelCenterOffset?.clone() ?? inferModelCenterOffset(model)
    applyModelOffset(model, modelCenterOffset, options.includeGroup ?? true)
    return { model, modelCenterOffset }
}

export async function buildDoorContextsFromIfcState(args: {
    primaryFile: File
    primaryModel: LoadedIFCModel
    secondaryFile?: File
    secondaryModel?: LoadedIFCModel
    spatialStructure?: unknown
    detailedGeometryOffset?: THREE.Vector3
}): Promise<{
    contexts: DoorContext[]
    operationTypeMap: Map<number, string>
    csetStandardCHMap: Map<number, DoorCsetStandardCHData>
    doorLeafMetadataMap: Map<number, DoorLeafMetadata>
}> {
    const [operationTypeMap, csetStandardCHMap, doorLeafMetadataMap] = await Promise.all([
        extractDoorOperationTypes(args.primaryFile),
        extractDoorCsetStandardCH(args.primaryFile),
        extractDoorLeafMetadata(args.primaryFile),
    ])

    const contexts = await analyzeDoors(
        args.primaryModel,
        args.secondaryModel,
        args.spatialStructure,
        operationTypeMap,
        csetStandardCHMap,
        doorLeafMetadataMap
    )

    if (contexts.length > 0) {
        try {
            await loadDetailedGeometry(
                contexts,
                args.primaryFile,
                args.detailedGeometryOffset ?? new THREE.Vector3(),
                args.secondaryFile
            )
        } catch (error) {
            console.warn('Failed to load detailed geometry, SVG will use simplified rendering:', error)
        }
    }

    return {
        contexts,
        operationTypeMap,
        csetStandardCHMap,
        doorLeafMetadataMap,
    }
}
