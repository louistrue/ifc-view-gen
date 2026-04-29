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

const GUID = process.env.DOOR_GUID ?? '1JhPbkgispHOTgg2cexFck'
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
    const originD = frame.origin.dot(depthAxis)
    const originB = frame.origin.dot(upAxis)

    console.log('door GUID:', GUID)
    console.log('door origin (world):', frame.origin.x.toFixed(2), frame.origin.y.toFixed(2), frame.origin.z.toFixed(2))
    console.log('widthAxis:', widthAxis.x.toFixed(3), widthAxis.y.toFixed(3), widthAxis.z.toFixed(3))
    console.log('semanticFacing (depthAxis):', depthAxis.x.toFixed(3), depthAxis.y.toFixed(3), depthAxis.z.toFixed(3))
    console.log('upAxis:', upAxis.x.toFixed(3), upAxis.y.toFixed(3), upAxis.z.toFixed(3))

    console.log('\nhostWall:', ctx.hostWall ? { eid: ctx.hostWall.expressID } : null)

    const showBox = (name: string, box: THREE.Box3 | null | undefined) => {
        if (!box) { console.log(`  ${name}: (no bbox)`); return }
        const corners: THREE.Vector3[] = []
        for (const x of [box.min.x, box.max.x])
            for (const y of [box.min.y, box.max.y])
                for (const z of [box.min.z, box.max.z])
                    corners.push(new THREE.Vector3(x, y, z))
        const xs = corners.map((c) => c.dot(widthAxis))
        const ys = corners.map((c) => c.dot(upAxis))
        const ds = corners.map((c) => c.dot(depthAxis))
        console.log(`  ${name}: local x=[${(Math.min(...xs) - originA).toFixed(2)}, ${(Math.max(...xs) - originA).toFixed(2)}] d=[${(Math.min(...ds) - originD).toFixed(2)}, ${(Math.max(...ds) - originD).toFixed(2)}] y=[${(Math.min(...ys) - originB).toFixed(2)}, ${(Math.max(...ys) - originB).toFixed(2)}]`)
    }

    console.log('\nnearbyWalls:')
    for (const w of ctx.nearbyWalls) {
        showBox(`  nearbyWall eid=${w.expressID} type=${w.typeName}`, w.boundingBox ?? null)
    }
    if (ctx.nearbyWalls.length === 0) console.log('  (none)')
}
main().catch((e) => { console.error(e); process.exit(1) })
