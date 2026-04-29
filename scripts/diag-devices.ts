import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import * as THREE from 'three'
import {
    analyzeDoors,
    loadDetailedGeometry,
} from '../lib/door-analyzer'
import {
    extractDoorAnalyzerSidecarMaps,
    extractDoorHostRelationships,
    extractDoorLeafMetadata,
    extractSlabAggregateParts,
    loadIFCModelWithMetadata,
} from '../lib/ifc-loader'

const GUID = process.env.DOOR_GUID ?? '2T_SEpKv_SHf$oHH25dRMi'
function loadIfcFile(path: string): File {
    return new File([readFileSync(path)], basename(path), { type: 'application/octet-stream' })
}

async function main() {
    const arch = resolve(process.env.ARCH_IFC_PATH ?? 'Flu21_A_AR_51_ARM_0000_A-AR-0000-0001_260402.ifc')
    const elec = process.env.ELEC_IFC_PATH ? resolve(process.env.ELEC_IFC_PATH) : null
    const archFile = loadIfcFile(arch)
    const elecFile = elec ? loadIfcFile(elec) : undefined

    const model = await loadIFCModelWithMetadata(archFile)
    const secondaryModel = elecFile ? await loadIFCModelWithMetadata(elecFile) : undefined
    const { operationTypeMap, csetStandardCHMap, wallAggregatePartMap } = await extractDoorAnalyzerSidecarMaps(archFile)
    const doorLeafMetadataMap = await extractDoorLeafMetadata(archFile)
    const hostRelationshipMap = await extractDoorHostRelationships(archFile)
    const slabAggregatePartMap = await extractSlabAggregateParts(archFile)
    const contexts = await analyzeDoors(model, secondaryModel, undefined, operationTypeMap, csetStandardCHMap, doorLeafMetadataMap, hostRelationshipMap, slabAggregatePartMap, wallAggregatePartMap)
    const ctx = contexts.find((c) => c.doorId === GUID)
    if (!ctx) { console.error('not found'); process.exit(1) }
    await loadDetailedGeometry([ctx], archFile, new THREE.Vector3(0, 0, 0), elecFile)

    const frame = ctx.viewFrame
    const widthAxis = frame.widthAxis
    const upAxis = frame.upAxis
    const depthAxis = frame.semanticFacing
    const originA = frame.origin.dot(widthAxis)
    const originB = frame.origin.dot(upAxis)
    const originD = frame.origin.dot(depthAxis)

    console.log('door GUID:', GUID)
    console.log('door bbox local (widthAxis x upAxis x depthAxis):')
    if (ctx.door.boundingBox) {
        const corners: THREE.Vector3[] = []
        const b = ctx.door.boundingBox
        for (const x of [b.min.x, b.max.x])
            for (const y of [b.min.y, b.max.y])
                for (const z of [b.min.z, b.max.z])
                    corners.push(new THREE.Vector3(x, y, z))
        const xs = corners.map(c => c.dot(widthAxis))
        const ys = corners.map(c => c.dot(upAxis))
        const ds = corners.map(c => c.dot(depthAxis))
        console.log(`  x=[${(Math.min(...xs) - originA).toFixed(2)}, ${(Math.max(...xs) - originA).toFixed(2)}] y=[${(Math.min(...ys) - originB).toFixed(2)}, ${(Math.max(...ys) - originB).toFixed(2)}] d=[${(Math.min(...ds) - originD).toFixed(2)}, ${(Math.max(...ds) - originD).toFixed(2)}]`)
    }
    console.log(`\nnearbyDevices (${ctx.nearbyDevices.length}):`)
    for (const dev of ctx.nearbyDevices) {
        const bb = dev.boundingBox
        if (!bb) {
            console.log(`  eid=${dev.expressID} type=${dev.typeName} name="${dev.name}" (no bbox)`)
            continue
        }
        const corners: THREE.Vector3[] = []
        for (const x of [bb.min.x, bb.max.x])
            for (const y of [bb.min.y, bb.max.y])
                for (const z of [bb.min.z, bb.max.z])
                    corners.push(new THREE.Vector3(x, y, z))
        const xs = corners.map(c => c.dot(widthAxis))
        const ys = corners.map(c => c.dot(upAxis))
        const ds = corners.map(c => c.dot(depthAxis))
        const dx = Math.max(...xs) - Math.min(...xs)
        const dy = Math.max(...ys) - Math.min(...ys)
        const dd = Math.max(...ds) - Math.min(...ds)
        console.log(`  eid=${dev.expressID} type=${dev.typeName} name="${dev.name}"`)
        console.log(`     local x=[${(Math.min(...xs) - originA).toFixed(2)}, ${(Math.max(...xs) - originA).toFixed(2)}] y=[${(Math.min(...ys) - originB).toFixed(2)}, ${(Math.max(...ys) - originB).toFixed(2)}] d=[${(Math.min(...ds) - originD).toFixed(2)}, ${(Math.max(...ds) - originD).toFixed(2)}]`)
        console.log(`     size WxHxD = ${dx.toFixed(2)} x ${dy.toFixed(2)} x ${dd.toFixed(2)}`)
    }
}
main().catch((e) => { console.error(e); process.exit(1) })
