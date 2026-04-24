import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import * as THREE from 'three'
import {
    analyzeDoors,
    getDoorMeshes,
    getHostWallMeshes,
    getNearbyDoorMeshes,
    getNearbyWallMeshes,
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

    const doorMeshes = getDoorMeshes(ctx)
    console.log('context.door.expressID:', ctx.door.expressID)
    console.log('context.hostWall?.expressID:', ctx.hostWall?.expressID)
    console.log('hostSlabsBelow:', ctx.hostSlabsBelow.map((s) => s.expressID))
    console.log('hostSlabsAbove:', ctx.hostSlabsAbove.map((s) => s.expressID))
    console.log('\ndoorMeshes count:', doorMeshes.length)
    const idCounts = new Map<number | string, number>()
    for (const m of doorMeshes) {
        const id = m.userData?.expressID ?? 'NONE'
        idCounts.set(id, (idCounts.get(id) ?? 0) + 1)
    }
    for (const [id, count] of [...idCounts].sort((a, b) => b[1] - a[1])) {
        const isDoor = id === ctx.door.expressID
        const isHostWall = id === ctx.hostWall?.expressID
        const isSlabBelow = ctx.hostSlabsBelow.some((s) => s.expressID === id)
        const isSlabAbove = ctx.hostSlabsAbove.some((s) => s.expressID === id)
        const tag = isDoor ? 'DOOR' : isHostWall ? 'HOST_WALL' : isSlabBelow ? 'SLAB_BELOW' : isSlabAbove ? 'SLAB_ABOVE' : 'FALLBACK(orange)'
        console.log(`  expressID=${id} count=${count} -> ${tag}`)
    }

    console.log('\nhostWall meshes (via getHostWallMeshes):')
    const hostMeshes = getHostWallMeshes(ctx)
    const hostIdCounts = new Map<number | string, number>()
    for (const m of hostMeshes) {
        const id = m.userData?.expressID ?? 'NONE'
        hostIdCounts.set(id, (hostIdCounts.get(id) ?? 0) + 1)
    }
    for (const [id, count] of [...hostIdCounts].sort((a, b) => b[1] - a[1])) {
        const isHostWall = id === ctx.hostWall?.expressID
        const tag = isHostWall ? 'HOST_WALL' : 'AGGREGATE_PART (orange!)'
        console.log(`  expressID=${id} count=${count} -> ${tag}`)
    }

    console.log('\nnearbyDoor meshes (via getNearbyDoorMeshes):')
    const nearbyDoorMeshes = getNearbyDoorMeshes(ctx)
    const nearbyIds = new Map<number | string, number>()
    for (const m of nearbyDoorMeshes) {
        const id = m.userData?.expressID ?? 'NONE'
        nearbyIds.set(id, (nearbyIds.get(id) ?? 0) + 1)
    }
    const nearbyDoorIds = new Set(ctx.nearbyDoors.map((d) => d.expressID))
    for (const [id, count] of [...nearbyIds].sort((a, b) => b[1] - a[1])) {
        const isNearby = typeof id === 'number' && nearbyDoorIds.has(id)
        console.log(`  expressID=${id} count=${count} -> ${isNearby ? 'NEARBY_DOOR' : 'UNKNOWN (orange?)'}`)
    }

    console.log('\nnearbyWall meshes (via getNearbyWallMeshes):')
    const nearbyWallMeshes = getNearbyWallMeshes(ctx)
    const nearbyWIds = new Map<number | string, number>()
    for (const m of nearbyWallMeshes) {
        const id = m.userData?.expressID ?? 'NONE'
        nearbyWIds.set(id, (nearbyWIds.get(id) ?? 0) + 1)
    }
    const nearbyWallIds = new Set(ctx.nearbyWalls.map((w) => w.expressID))
    for (const [id, count] of [...nearbyWIds].sort((a, b) => b[1] - a[1])) {
        const isNearby = typeof id === 'number' && nearbyWallIds.has(id)
        console.log(`  expressID=${id} count=${count} -> ${isNearby ? 'NEARBY_WALL' : 'UNKNOWN (orange?)'}`)
    }
}
main().catch((e) => { console.error(e); process.exit(1) })
