import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import * as THREE from 'three'
import { analyzeDoors, type DoorContext } from '../lib/door-analyzer'
import {
    extractDoorAnalyzerSidecarMaps,
    extractDoorHostRelationships,
    extractDoorLeafMetadata,
    extractSlabAggregateParts,
    loadIFCModelWithMetadata,
} from '../lib/ifc-loader'

const GUID = process.env.DOOR_GUID ?? '2wRITY5MUvJf4NdCKuXOcn'
function loadIfcFile(path: string): File {
    return new File([readFileSync(path)], basename(path), { type: 'application/octet-stream' })
}

async function main() {
    const arch = resolve(process.env.ARCH_IFC_PATH ?? 'Flu21_A_AR_51_ARM_0000_A-AR-0000-0001_260402.ifc')
    const archFile = loadIfcFile(arch)
    const model = await loadIFCModelWithMetadata(archFile)
    const { operationTypeMap, csetStandardCHMap, wallAggregatePartMap } = await extractDoorAnalyzerSidecarMaps(archFile)
    const doorLeafMetadataMap = await extractDoorLeafMetadata(archFile)
    const hostRelationshipMap = await extractDoorHostRelationships(archFile)
    const slabAggregatePartMap = await extractSlabAggregateParts(archFile)
    const contexts = await analyzeDoors(model, undefined, undefined, operationTypeMap, csetStandardCHMap, doorLeafMetadataMap, hostRelationshipMap, slabAggregatePartMap, wallAggregatePartMap)
    const ctx = contexts.find((c) => c.doorId === GUID)
    if (!ctx) { console.error('not found'); process.exit(1) }

    const frame = ctx.viewFrame
    const widthAxis = frame.widthAxis
    const depthAxis = frame.semanticFacing
    const upAxis = frame.upAxis
    const originA = frame.origin.dot(widthAxis)
    const originB = frame.origin.dot(upAxis)
    const originD = frame.origin.dot(depthAxis)
    console.log('door origin: x=', originA.toFixed(2), 'y=', originB.toFixed(2), 'd=', originD.toFixed(2))
    console.log('door frame: width=', frame.width.toFixed(2), 'height=', frame.height.toFixed(2), 'thickness=', frame.thickness.toFixed(2))
    console.log('\nhostWall:', ctx.hostWall ? { eid: ctx.hostWall.expressID, guid: ctx.hostWall.globalId } : null)
    if (ctx.hostWall?.boundingBox) {
        const bb = ctx.hostWall.boundingBox
        const corners = [
            new THREE.Vector3(bb.min.x, bb.min.y, bb.min.z),
            new THREE.Vector3(bb.max.x, bb.max.y, bb.max.z),
            new THREE.Vector3(bb.max.x, bb.min.y, bb.min.z),
            new THREE.Vector3(bb.min.x, bb.min.y, bb.max.z),
        ]
        const xs = corners.map((c) => c.dot(widthAxis))
        const ds = corners.map((c) => c.dot(depthAxis))
        const ys = corners.map((c) => c.dot(upAxis))
        console.log('  bbox: xLocal=[', (Math.min(...xs) - originA).toFixed(2), ',', (Math.max(...xs) - originA).toFixed(2), '] dLocal=[', (Math.min(...ds) - originD).toFixed(2), ',', (Math.max(...ds) - originD).toFixed(2), '] yLocal=[', (Math.min(...ys) - originB).toFixed(2), ',', (Math.max(...ys) - originB).toFixed(2), ']')
    }

    // List ALL walls within a loose radius of the door so we can see what's near
    const halfLat = 3.0  // 3m to each side
    const halfDepth = 3.0
    const nearAny: any[] = []
    for (const el of (model.elements as any[])) {
        const tn = (el.typeName || '').toUpperCase()
        if (!tn.startsWith('IFCWALL')) continue
        if (!el.boundingBox) continue
        const bb = el.boundingBox
        const corners = [
            new THREE.Vector3(bb.min.x, bb.min.y, bb.min.z),
            new THREE.Vector3(bb.max.x, bb.max.y, bb.max.z),
            new THREE.Vector3(bb.max.x, bb.min.y, bb.min.z),
            new THREE.Vector3(bb.min.x, bb.min.y, bb.max.z),
        ]
        const xs = corners.map((c) => c.dot(widthAxis) - originA)
        const ds = corners.map((c) => c.dot(depthAxis) - originD)
        const ys = corners.map((c) => c.dot(upAxis) - originB)
        const xmin = Math.min(...xs), xmax = Math.max(...xs)
        const dmin = Math.min(...ds), dmax = Math.max(...ds)
        if (xmax < -halfLat || xmin > halfLat) continue
        if (dmax < -halfDepth || dmin > halfDepth) continue
        nearAny.push({
            eid: el.expressID, guid: el.globalId, name: el.name, type: tn,
            xLocal: [xmin.toFixed(2), xmax.toFixed(2)].join(','),
            dLocal: [dmin.toFixed(2), dmax.toFixed(2)].join(','),
            yLocal: [Math.min(...ys).toFixed(2), Math.max(...ys).toFixed(2)].join(','),
        })
    }
    console.log('\nAll walls within ±3m of door (', nearAny.length, '):')
    for (const w of nearAny) {
        console.log(`  eid=${w.eid} type=${w.type} name="${w.name}" x=[${w.xLocal}] d=[${w.dLocal}] y=[${w.yLocal}]`)
    }

    console.log('\nnearbyDoors (', ctx.nearbyDoors?.length ?? 0, '):')
    for (const d of (ctx.nearbyDoors ?? [])) {
        if (!d.boundingBox) continue
        const bb = d.boundingBox
        const corners = [
            new THREE.Vector3(bb.min.x, bb.min.y, bb.min.z),
            new THREE.Vector3(bb.max.x, bb.max.y, bb.max.z),
        ]
        const xs = corners.map((c) => c.dot(widthAxis))
        const ds = corners.map((c) => c.dot(depthAxis))
        const ys = corners.map((c) => c.dot(upAxis))
        console.log(`  eid=${d.expressID} guid=${d.globalId} type=${d.typeName} name="${d.name}"`)
        console.log(`     xLocal=[${(Math.min(...xs) - originA).toFixed(2)}, ${(Math.max(...xs) - originA).toFixed(2)}]  dLocal=[${(Math.min(...ds) - originD).toFixed(2)}, ${(Math.max(...ds) - originD).toFixed(2)}]  yLocal=[${(Math.min(...ys) - originB).toFixed(2)}, ${(Math.max(...ys) - originB).toFixed(2)}]`)
    }

    console.log('\nnearbyWalls (', ctx.nearbyWalls.length, '):')
    for (const w of ctx.nearbyWalls) {
        if (!w.boundingBox) continue
        const bb = w.boundingBox
        const corners = [
            new THREE.Vector3(bb.min.x, bb.min.y, bb.min.z),
            new THREE.Vector3(bb.max.x, bb.max.y, bb.max.z),
            new THREE.Vector3(bb.max.x, bb.min.y, bb.min.z),
            new THREE.Vector3(bb.min.x, bb.min.y, bb.max.z),
        ]
        const xs = corners.map((c) => c.dot(widthAxis))
        const ds = corners.map((c) => c.dot(depthAxis))
        const ys = corners.map((c) => c.dot(upAxis))
        console.log(`  eid=${w.expressID} guid=${w.globalId} name="${w.name}"`)
        console.log(`     xLocal=[${(Math.min(...xs) - originA).toFixed(2)}, ${(Math.max(...xs) - originA).toFixed(2)}]  dLocal=[${(Math.min(...ds) - originD).toFixed(2)}, ${(Math.max(...ds) - originD).toFixed(2)}]  yLocal=[${(Math.min(...ys) - originB).toFixed(2)}, ${(Math.max(...ys) - originB).toFixed(2)}]`)
    }
}
main().catch((e) => { console.error(e); process.exit(1) })
