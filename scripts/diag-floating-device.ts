/**
 * For a given door GUID, list every nearbyDevice with its bbox and the
 * minimum bbox-distance to host wall + each nearby wall + each wall part.
 * Helps identify which "device" is producing the floating yellow rect that
 * v14.A failed to filter.
 */
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import * as THREE from 'three'
import { analyzeDoors, boxDistance, getNearbyWallMeshes } from '../lib/door-analyzer'
import {
    extractDoorAnalyzerSidecarMaps,
    extractDoorHostRelationships,
    extractDoorLeafMetadata,
    extractElementStoreyElevationMap,
    extractSlabAggregateParts,
    loadIFCModelWithMetadata,
} from '../lib/ifc-loader'

function loadIfcFile(p: string): File {
    return new File([readFileSync(p)], basename(p), { type: 'application/octet-stream' })
}

async function main() {
    const arch = resolve(process.env.ARCH ?? 'Flu21_A_AR_51_ARM_0000_A-AR-0000-0001_260421.ifc')
    const elec = process.env.ELEC ?? 'Flu21_A_EL_52_ELM_0000_A-EL-2300-0001_IFC Elektro.ifc'
    const guid = process.env.GUID ?? '0eMcA5UMVHHPbTsvAupZHz'

    const archFile = loadIfcFile(arch)
    const elecFile = loadIfcFile(resolve(elec))
    const model = await loadIFCModelWithMetadata(archFile)
    const elecModel = await loadIFCModelWithMetadata(elecFile)
    const { operationTypeMap, csetStandardCHMap, wallCsetStandardCHMap, wallAggregatePartMap } =
        await extractDoorAnalyzerSidecarMaps(archFile)
    const doorLeafMetadataMap = await extractDoorLeafMetadata(archFile)
    const hostRelationshipMap = await extractDoorHostRelationships(archFile)
    const slabAggregatePartMap = await extractSlabAggregateParts(archFile)
    const storeyElevationMap = await extractElementStoreyElevationMap(archFile)

    const contexts = await analyzeDoors(
        model, elecModel, undefined,
        operationTypeMap, csetStandardCHMap, doorLeafMetadataMap,
        hostRelationshipMap, slabAggregatePartMap, wallAggregatePartMap,
        storeyElevationMap, wallCsetStandardCHMap
    )
    const ctx = contexts.find((c) => c.doorId === guid || c.doorId === guid.replace('$', '_'))
    if (!ctx) { console.error('door not found:', guid); process.exit(1) }

    const f = ctx.viewFrame
    const orig = f.origin
    console.log(`door=${ctx.doorId} hostWall=${ctx.hostWall?.expressID ?? '?'}`)
    console.log(`door bbox center w=${orig.dot(f.widthAxis).toFixed(2)} d=${orig.dot(f.semanticFacing).toFixed(2)}`)
    console.log(`nearbyDevices=${ctx.nearbyDevices.length} nearbyWalls=${ctx.nearbyWalls.length} parts=${ctx.wallAggregatePartLinks?.length ?? 0}`)

    const wallBoxes: Array<{ id: number; type: string; box: THREE.Box3 }> = []
    if (ctx.hostWall?.boundingBox) wallBoxes.push({ id: ctx.hostWall.expressID, type: 'host', box: ctx.hostWall.boundingBox })
    for (const w of ctx.nearbyWalls) {
        if (w.boundingBox) wallBoxes.push({ id: w.expressID, type: 'nearby', box: w.boundingBox })
    }
    for (const link of ctx.wallAggregatePartLinks ?? []) {
        if (link.part.boundingBox) wallBoxes.push({ id: link.part.expressID, type: `part-of-${link.parentWallExpressID}`, box: link.part.boundingBox })
    }

    for (const d of ctx.nearbyDevices) {
        if (!d.boundingBox) { console.log(`  dev eid=${d.expressID} no-bbox name="${d.name}"`); continue }
        const bb = d.boundingBox
        const localW = ((bb.min.x + bb.max.x) / 2) - orig.x
        const localD = ((bb.min.z + bb.max.z) / 2) - orig.z
        let minDist = Infinity
        let minWho = '?'
        for (const w of wallBoxes) {
            const dist = boxDistance(bb, w.box)
            if (dist < minDist) { minDist = dist; minWho = `${w.type}/${w.id}` }
        }
        const yMin = bb.min.y - orig.y
        const yMax = bb.max.y - orig.y
        console.log(`  dev eid=${d.expressID} type=${d.typeName} name="${d.name?.slice(0,32)}"  size=${(bb.max.x-bb.min.x).toFixed(2)}x${(bb.max.z-bb.min.z).toFixed(2)}x${(bb.max.y-bb.min.y).toFixed(2)}  y=[${yMin.toFixed(2)},${yMax.toFixed(2)}]  closestWall=${minWho} dist=${minDist.toFixed(3)}m`)
    }
}
main().catch((e) => { console.error(e); process.exit(1) })
