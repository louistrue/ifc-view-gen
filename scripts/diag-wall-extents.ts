import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import * as THREE from 'three'
import { analyzeDoors, getNearbyWallMeshes, loadDetailedGeometry, boxDistance } from '../lib/door-analyzer'
import {
    extractDoorAnalyzerSidecarMaps, extractDoorHostRelationships,
    extractDoorLeafMetadata, extractElementStoreyElevationMap,
    extractSlabAggregateParts, loadIFCModelWithMetadata,
} from '../lib/ifc-loader'

function loadFile(p: string): File { return new File([readFileSync(p)], basename(p), { type: 'application/octet-stream' }) }

async function main() {
    const arch = resolve(process.env.ARCH ?? 'Flu21_A_AR_51_ARM_0000_A-AR-0000-0001_260421.ifc')
    const elec = process.env.ELEC ?? 'Flu21_A_EL_52_ELM_0000_A-EL-2300-0001_IFC Elektro.ifc'
    const guid = process.env.GUID ?? '03Ah7HRzUIIeuVgQx_ZYlw'
    const archFile = loadFile(arch); const elecFile = loadFile(resolve(elec))
    const model = await loadIFCModelWithMetadata(archFile)
    const elecModel = await loadIFCModelWithMetadata(elecFile)
    const { operationTypeMap, csetStandardCHMap, wallCsetStandardCHMap, wallAggregatePartMap } = await extractDoorAnalyzerSidecarMaps(archFile)
    const doorLeafMetadataMap = await extractDoorLeafMetadata(archFile)
    const hostRelationshipMap = await extractDoorHostRelationships(archFile)
    const slabAggregatePartMap = await extractSlabAggregateParts(archFile)
    const storeyElevationMap = await extractElementStoreyElevationMap(archFile)
    const contexts = await analyzeDoors(model, elecModel, undefined, operationTypeMap, csetStandardCHMap, doorLeafMetadataMap, hostRelationshipMap, slabAggregatePartMap, wallAggregatePartMap, storeyElevationMap, wallCsetStandardCHMap)
    const ctx = contexts.find((c) => c.doorId === guid || c.doorId === guid.replace('$', '_'))
    if (!ctx) { console.error('door not found', guid); process.exit(1) }
    await loadDetailedGeometry([ctx], archFile, new THREE.Vector3(0, 0, 0))

    const f = ctx.viewFrame
    const facing = f.semanticFacing
    const widthAxis = f.widthAxis
    const upAxis = f.upAxis
    const originDepth = f.origin.dot(facing)
    const originWidth = f.origin.dot(widthAxis)

    console.log(`door=${ctx.doorId} hostWall=${ctx.hostWall?.expressID}`)
    console.log(`door X (widthAxis)=${originWidth.toFixed(2)} depth (semanticFacing)=${originDepth.toFixed(2)} thickness=${f.thickness.toFixed(2)}`)
    if (ctx.hostWall?.boundingBox) {
        const corners = box3Corners(ctx.hostWall.boundingBox)
        const ds = corners.map((c) => c.dot(facing) - originDepth)
        console.log(`hostWall depth from door plane: [${Math.min(...ds).toFixed(3)}, ${Math.max(...ds).toFixed(3)}]`)
    }

    console.log('\n=== wallAggregatePartLinks ===')
    for (const link of (ctx.wallAggregatePartLinks ?? [])) {
        const bb = link.part.boundingBox
        if (!bb) { console.log(`  part eid=${link.part.expressID} parent=${link.parentWallExpressID} no-bbox`); continue }
        const corners = box3Corners(bb)
        const wValues = corners.map((c) => c.dot(widthAxis) - originWidth)
        const dValues = corners.map((c) => c.dot(facing) - originDepth)
        console.log(`  part eid=${link.part.expressID} parent=${link.parentWallExpressID} `
          + `widthAxis=[${Math.min(...wValues).toFixed(2)}, ${Math.max(...wValues).toFixed(2)}] depth=[${Math.min(...dValues).toFixed(2)}, ${Math.max(...dValues).toFixed(2)}]`)
    }
    console.log('\n=== nearbyWalls ===')
    for (const w of ctx.nearbyWalls) {
        const bb = w.boundingBox
        if (!bb) { console.log(`  eid=${w.expressID} no-bbox`); continue }
        const corners = box3Corners(bb)
        const wValues = corners.map((c) => c.dot(widthAxis) - originWidth)
        const dValues = corners.map((c) => c.dot(facing) - originDepth)
        const wExt = Math.max(...wValues) - Math.min(...wValues)
        const dExt = Math.max(...dValues) - Math.min(...dValues)
        console.log(`  eid=${w.expressID} type=${w.typeName} `
          + `widthAxis=[${Math.min(...wValues).toFixed(2)}, ${Math.max(...wValues).toFixed(2)}] (ext=${wExt.toFixed(2)}) `
          + `depth=[${Math.min(...dValues).toFixed(2)}, ${Math.max(...dValues).toFixed(2)}] (ext=${dExt.toFixed(2)})`)
    }
}

function box3Corners(bb: THREE.Box3): THREE.Vector3[] {
    return [
        new THREE.Vector3(bb.min.x, bb.min.y, bb.min.z),
        new THREE.Vector3(bb.max.x, bb.min.y, bb.min.z),
        new THREE.Vector3(bb.min.x, bb.max.y, bb.min.z),
        new THREE.Vector3(bb.max.x, bb.max.y, bb.min.z),
        new THREE.Vector3(bb.min.x, bb.min.y, bb.max.z),
        new THREE.Vector3(bb.max.x, bb.min.y, bb.max.z),
        new THREE.Vector3(bb.min.x, bb.max.y, bb.max.z),
        new THREE.Vector3(bb.max.x, bb.max.y, bb.max.z),
    ]
}

main().catch((e) => { console.error(e); process.exit(1) })
