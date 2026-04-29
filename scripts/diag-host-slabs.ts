/**
 * List every element in hostSlabsBelow / hostSlabsAbove for a given door,
 * showing expressID, GlobalId, IFC class, Name, and bounding-box extents.
 * The user claims only two slabs exist below door 3bGePh90dJJAhFC54r$rf5:
 *   - 3m4NMUdzXtJOHcsykKjAmP (Bodenplatte 001, IfcSlab)
 *   - 2c3tVIi62SGvevyFQqC4JV (Unterlagsboden,   IfcSlab)
 * so the analyzer is over-collecting. This script prints the raw list so we
 * can see the other 8 and decide what to drop.
 */
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import * as THREE from 'three'
import {
    analyzeDoors,
    type DoorContext,
} from '../lib/door-analyzer'
import {
    extractDoorAnalyzerSidecarMaps,
    extractDoorHostRelationships,
    extractDoorLeafMetadata,
    extractElementStoreyMap,
    extractSlabAggregateParts,
    loadIFCModelWithMetadata,
} from '../lib/ifc-loader'

const GUID = process.env.DOOR_GUID ?? '3bGePh90dJJAhFC54r$rf5'
const EXPECTED = new Set([
    '3m4NMUdzXtJOHcsykKjAmP',
    '2c3tVIi62SGvevyFQqC4JV',
])

function loadIfcFile(path: string): File {
    return new File([readFileSync(path)], basename(path), { type: 'application/octet-stream' })
}

function dumpSlabs(label: string, list: readonly any[], ctx: DoorContext, storeyMap: Map<number, string>, slabAggregatePartMap: Map<number, number>) {
    const up = ctx.viewFrame.upAxis
    const widthAxis = ctx.viewFrame.widthAxis
    const depthAxis = ctx.viewFrame.semanticFacing
    const originY = ctx.viewFrame.origin.dot(up)
    console.log(`\n=== ${label} (${list.length}) ===`)
    for (const el of list) {
        const bb = el.boundingBox as THREE.Box3 | undefined
        const guid = el.globalId ?? '?'
        const cls = el.ifcClassName ?? el.typeName ?? '?'
        const name = el.name ?? ''
        const partParent = slabAggregatePartMap.get(el.expressID)
        const partParentStorey = partParent != null ? storeyMap.get(partParent) : undefined
        const storey = storeyMap.get(el.expressID) ?? (partParent != null ? `(via parent ${partParent}) ${partParentStorey ?? '?'}` : '?')
        const marker = EXPECTED.has(guid) ? ' [USER-LISTED]' : partParent === 594272 ? ' [PART-OF-Unterlagsboden]' : ''
        let rangeStr = 'no-bbox'
        if (bb) {
            const corners = [
                new THREE.Vector3(bb.min.x, bb.min.y, bb.min.z),
                new THREE.Vector3(bb.max.x, bb.min.y, bb.min.z),
                new THREE.Vector3(bb.min.x, bb.max.y, bb.min.z),
                new THREE.Vector3(bb.max.x, bb.max.y, bb.min.z),
                new THREE.Vector3(bb.min.x, bb.min.y, bb.max.z),
                new THREE.Vector3(bb.max.x, bb.min.y, bb.max.z),
                new THREE.Vector3(bb.min.x, bb.max.y, bb.max.z),
                new THREE.Vector3(bb.max.x, bb.max.y, bb.max.z),
            ]
            const yvals = corners.map((c) => c.dot(up) - originY)
            const xvals = corners.map((c) => c.dot(widthAxis))
            const dvals = corners.map((c) => c.dot(depthAxis))
            rangeStr = `dy=[${Math.min(...yvals).toFixed(2)}, ${Math.max(...yvals).toFixed(2)}]`
                + `  x=[${Math.min(...xvals).toFixed(2)}, ${Math.max(...xvals).toFixed(2)}]`
                + `  d=[${Math.min(...dvals).toFixed(2)}, ${Math.max(...dvals).toFixed(2)}]`
        }
        console.log(`  eid=${el.expressID}  guid=${guid}  class=${cls}  storey="${storey}"  name="${name}"  ${rangeStr}${marker}`)
    }
}

async function main() {
    const arch = resolve(process.env.ARCH_IFC_PATH ?? 'Flu21_A_AR_51_ARM_0000_A-AR-0000-0001_260402.ifc')
    const archFile = loadIfcFile(arch)
    const model = await loadIFCModelWithMetadata(archFile)
    const { operationTypeMap, csetStandardCHMap, wallAggregatePartMap } = await extractDoorAnalyzerSidecarMaps(archFile)
    const doorLeafMetadataMap = await extractDoorLeafMetadata(archFile)
    const hostRelationshipMap = await extractDoorHostRelationships(archFile)
    const slabAggregatePartMap = await extractSlabAggregateParts(archFile)
    const contexts = await analyzeDoors(
        model, undefined, undefined, operationTypeMap, csetStandardCHMap,
        doorLeafMetadataMap, hostRelationshipMap, slabAggregatePartMap, wallAggregatePartMap
    )
    const ctx = contexts.find((c) => c.doorId === GUID)
    if (!ctx) { console.error(`door ${GUID} not found in analyzer output`); process.exit(1) }

    const storeyMap = await extractElementStoreyMap(archFile)
    const doorStorey = storeyMap.get(ctx.door.expressID) ?? '?'
    console.log(`slabAggregatePartMap.size = ${slabAggregatePartMap.size}`)
    console.log(`hostWall = ${ctx.hostWall?.globalId ?? 'none'} (eid=${ctx.hostWall?.expressID ?? '?'})`)
    console.log(`door expressID = ${ctx.door.expressID}  storey = "${doorStorey}"`)
    const widthAxis = ctx.viewFrame.widthAxis
    const depthAxis = ctx.viewFrame.semanticFacing
    console.log(`door center  x=${ctx.viewFrame.origin.dot(widthAxis).toFixed(2)}  d=${ctx.viewFrame.origin.dot(depthAxis).toFixed(2)}  half-width=${(ctx.viewFrame.width / 2).toFixed(2)}`)
    if (ctx.hostWall?.boundingBox) {
        const bb = ctx.hostWall.boundingBox
        const corners = [
            new THREE.Vector3(bb.min.x, bb.min.y, bb.min.z),
            new THREE.Vector3(bb.max.x, bb.max.y, bb.max.z),
            new THREE.Vector3(bb.max.x, bb.min.y, bb.min.z),
            new THREE.Vector3(bb.min.x, bb.max.y, bb.min.z),
            new THREE.Vector3(bb.min.x, bb.min.y, bb.max.z),
            new THREE.Vector3(bb.max.x, bb.max.y, bb.min.z),
            new THREE.Vector3(bb.max.x, bb.min.y, bb.max.z),
            new THREE.Vector3(bb.min.x, bb.max.y, bb.max.z),
        ]
        const xs = corners.map((c) => c.dot(widthAxis))
        const ds = corners.map((c) => c.dot(depthAxis))
        console.log(`hostWall bbox: x=[${Math.min(...xs).toFixed(2)}, ${Math.max(...xs).toFixed(2)}]  d=[${Math.min(...ds).toFixed(2)}, ${Math.max(...ds).toFixed(2)}]`)
    }

    dumpSlabs('hostSlabsBelow', ctx.hostSlabsBelow as any[], ctx, storeyMap, slabAggregatePartMap)
    dumpSlabs('hostSlabsAbove', ctx.hostSlabsAbove as any[], ctx, storeyMap, slabAggregatePartMap)

    // Trace back: which of those 10 are real IfcSlabs vs aggregate parts?
    console.log('\n=== slabAggregatePartMap entries for included parts ===')
    for (const el of (ctx.hostSlabsBelow as any[])) {
        const parent = slabAggregatePartMap.get(el.expressID)
        if (parent != null) {
            console.log(`  part eid=${el.expressID} (guid=${el.globalId}) -> parent slab eid=${parent}`)
        }
    }
}

main().catch((e) => { console.error(e); process.exit(1) })
