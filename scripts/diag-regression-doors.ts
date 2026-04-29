/**
 * Quick diagnostic for the 7 doors reviewers flipped back to Valid='no':
 * print frame origin, doorMesh counts, hostWall presence, and computed offsetX.
 */
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import * as THREE from 'three'
import { analyzeDoors, getDoorMeshes, loadDetailedGeometry } from '../lib/door-analyzer'
import {
    extractDoorAnalyzerSidecarMaps,
    extractDoorHostRelationships,
    extractDoorLeafMetadata,
    extractSlabAggregateParts,
    loadIFCModelWithMetadata,
} from '../lib/ifc-loader'

const GUIDS = [
    '115x9H1L2aJvKug$_04BLq',
    '2RbYi207jBIfQRNCoEtWWW',
    '1Kb8m6mED2Hh7VZLSO5n9G',
    '2APC9GNNTuJA1gm1YZjwER',
    '2tZrsJgJHiJQvW$vB0cHiK',
    '2sQnuHBUbDIOHiIZ1NJVAa',
    '3lEa80TAemGQmDU9axYRpF',
]

function loadIfcFile(path: string): File {
    return new File([readFileSync(path)], basename(path), { type: 'application/octet-stream' })
}

async function main() {
    const arch = resolve(process.env.ARCH_IFC_PATH ?? 'Flu21_A_AR_51_ARM_0000_A-AR-0000-0001_260421.ifc')
    const archFile = loadIfcFile(arch)
    const model = await loadIFCModelWithMetadata(archFile)
    const { operationTypeMap, csetStandardCHMap, wallAggregatePartMap } = await extractDoorAnalyzerSidecarMaps(archFile)
    const doorLeafMetadataMap = await extractDoorLeafMetadata(archFile)
    const hostRelationshipMap = await extractDoorHostRelationships(archFile)
    const slabAggregatePartMap = await extractSlabAggregateParts(archFile)
    const contexts = await analyzeDoors(
        model, undefined, undefined,
        operationTypeMap, csetStandardCHMap, doorLeafMetadataMap,
        hostRelationshipMap, slabAggregatePartMap, wallAggregatePartMap
    )
    const targets = GUIDS.map((g) => contexts.find((c) => c.doorId === g)).filter(Boolean)
    await loadDetailedGeometry(targets as any, archFile, new THREE.Vector3(0, 0, 0), undefined)

    for (const ctx of targets as any[]) {
        const f = ctx.viewFrame
        const meshes = getDoorMeshes(ctx)
        const aabb = new THREE.Box3()
        for (const m of meshes) aabb.expandByObject(m)
        const d = f.origin
        console.log(`\n=== ${ctx.doorId} ===`)
        console.log(`  storey=${ctx.storeyName}`)
        console.log(`  frame.origin=(${d.x.toFixed(3)}, ${d.y.toFixed(3)}, ${d.z.toFixed(3)})`)
        console.log(`  frame.width=${f.width.toFixed(3)}  height=${f.height.toFixed(3)}  thickness=${f.thickness.toFixed(3)}`)
        console.log(`  widthAxis=(${f.widthAxis.x.toFixed(3)}, ${f.widthAxis.y.toFixed(3)}, ${f.widthAxis.z.toFixed(3)})`)
        console.log(`  semanticFacing=(${f.semanticFacing.x.toFixed(3)}, ${f.semanticFacing.y.toFixed(3)}, ${f.semanticFacing.z.toFixed(3)})`)
        console.log(`  doorMesh count=${meshes.length}`)
        if (meshes.length > 0) {
            console.log(`  doorMesh aabb: min=(${aabb.min.x.toFixed(3)}, ${aabb.min.y.toFixed(3)}, ${aabb.min.z.toFixed(3)}) max=(${aabb.max.x.toFixed(3)}, ${aabb.max.y.toFixed(3)}, ${aabb.max.z.toFixed(3)})`)
            const center = aabb.getCenter(new THREE.Vector3())
            const dx = center.clone().sub(f.origin)
            const dAlongWidth = dx.dot(f.widthAxis)
            const dAlongUp = dx.dot(f.upAxis)
            const dAlongFacing = dx.dot(f.semanticFacing)
            console.log(`  mesh center vs frame.origin: width=${dAlongWidth.toFixed(3)} up=${dAlongUp.toFixed(3)} facing=${dAlongFacing.toFixed(3)}`)
        }
        console.log(`  hostWall expressID=${ctx.hostWall?.expressID ?? 'none'}`)
        console.log(`  nearbyDoors=${ctx.nearbyDoors?.length ?? 0} nearbyWalls=${ctx.nearbyWalls?.length ?? 0}`)
        console.log(`  hostSlabsAbove=${ctx.hostSlabsAbove?.length ?? 0}  hostSlabsBelow=${ctx.hostSlabsBelow?.length ?? 0}`)
        const originY = f.origin.y
        if (ctx.hostSlabsAbove) for (const s of ctx.hostSlabsAbove) {
            const bb: any = s.boundingBox
            if (!bb) continue
            console.log(`    above: ${s.typeName || 'unknown'} id=${s.expressID} y=[${bb.min.y.toFixed(3)}..${bb.max.y.toFixed(3)}] dy_from_door=${(bb.min.y - originY).toFixed(3)}`)
        }
        if (ctx.hostSlabsBelow) for (const s of ctx.hostSlabsBelow) {
            const bb: any = s.boundingBox
            if (!bb) continue
            console.log(`    below: ${s.typeName || 'unknown'} id=${s.expressID} y=[${bb.min.y.toFixed(3)}..${bb.max.y.toFixed(3)}] dy_from_door=${(bb.max.y - originY).toFixed(3)}`)
        }
    }
}
main().catch((e) => { console.error(e); process.exit(1) })
