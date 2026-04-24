/**
 * Dump nearby-wall geometry info for a door GUID:
 *  - element bbox extent along widthAxis / upAxis / semanticFacing
 *  - mesh-vertex extent in those axes, full and depth-band filtered
 *  - mesh count, vertex count
 */
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import * as THREE from 'three'
import { analyzeDoors, getNearbyWallMeshes, loadDetailedGeometry } from '../lib/door-analyzer'
import {
    extractDoorAnalyzerSidecarMaps,
    extractDoorHostRelationships,
    extractDoorLeafMetadata,
    extractSlabAggregateParts,
    loadIFCModelWithMetadata,
} from '../lib/ifc-loader'

const GUID = process.argv[2] ?? process.env.DOOR_GUID ?? ''
if (!GUID) {
    console.error('usage: node scripts/diag-wall-cut-runner.js <GUID>')
    process.exit(1)
}

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
    const ctx = contexts.find((c) => c.doorId === GUID)
    if (!ctx) { console.error('door not found:', GUID); process.exit(1) }
    await loadDetailedGeometry([ctx], archFile, new THREE.Vector3(0, 0, 0), undefined)

    const f = ctx.viewFrame
    const originA = f.origin.dot(f.widthAxis)
    const originB = f.origin.dot(f.upAxis)
    const originC = f.origin.dot(f.semanticFacing)
    const depthHalfWidth = Math.max(f.thickness, 0.20) + 0.20

    const allMeshes = getNearbyWallMeshes(ctx)
    console.log(`GUID=${GUID}`)
    console.log(`  viewFrame thickness=${f.thickness.toFixed(3)}  depthHalfWidth=${depthHalfWidth.toFixed(3)}`)
    console.log(`  originC=${originC.toFixed(3)}`)
    console.log(`  nearbyWalls=${ctx.nearbyWalls.length}  totalNearbyWallMeshes=${allMeshes.length}`)

    for (const wall of ctx.nearbyWalls) {
        const meshesForWall = allMeshes.filter((m) => m.userData?.expressID === wall.expressID)
        console.log(`\n  --- wall eid=${wall.expressID} type=${wall.typeName ?? '?'} meshes=${meshesForWall.length} ---`)
        if (wall.boundingBox) {
            const bb = wall.boundingBox
            const corners: THREE.Vector3[] = []
            for (const xi of [bb.min.x, bb.max.x]) for (const yi of [bb.min.y, bb.max.y]) for (const zi of [bb.min.z, bb.max.z]) {
                corners.push(new THREE.Vector3(xi, yi, zi))
            }
            let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity, minC = Infinity, maxC = -Infinity
            for (const c of corners) {
                const a = c.dot(f.widthAxis), b = c.dot(f.upAxis), cc = c.dot(f.semanticFacing)
                if (a < minA) minA = a; if (a > maxA) maxA = a
                if (b < minB) minB = b; if (b > maxB) maxB = b
                if (cc < minC) minC = cc; if (cc > maxC) maxC = cc
            }
            console.log(`    bbox A=[${(minA - originA).toFixed(3)}, ${(maxA - originA).toFixed(3)}] widthAxisSpan=${(maxA - minA).toFixed(3)}m`)
            console.log(`    bbox B=[${(minB - originB).toFixed(3)}, ${(maxB - originB).toFixed(3)}] upAxisSpan=${(maxB - minB).toFixed(3)}m`)
            console.log(`    bbox C=[${(minC - originC).toFixed(3)}, ${(maxC - originC).toFixed(3)}] semanticFacingSpan=${(maxC - minC).toFixed(3)}m`)
        }

        // Full mesh vertex extent
        let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity, minC = Infinity, maxC = -Infinity
        let vertexCount = 0
        const tmp = new THREE.Vector3()
        for (const mesh of meshesForWall) {
            const geom = mesh.geometry as THREE.BufferGeometry | undefined
            const pos = geom?.getAttribute('position')
            if (!pos) continue
            mesh.updateMatrixWorld(true)
            for (let i = 0; i < pos.count; i++) {
                tmp.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mesh.matrixWorld)
                const a = tmp.dot(f.widthAxis), b = tmp.dot(f.upAxis), c = tmp.dot(f.semanticFacing)
                if (a < minA) minA = a; if (a > maxA) maxA = a
                if (b < minB) minB = b; if (b > maxB) maxB = b
                if (c < minC) minC = c; if (c > maxC) maxC = c
                vertexCount++
            }
        }
        if (vertexCount === 0) { console.log('    NO vertices'); continue }
        console.log(`    mesh-full vertices=${vertexCount}`)
        console.log(`    mesh-full A=[${(minA - originA).toFixed(3)}, ${(maxA - originA).toFixed(3)}] widthAxisSpan=${(maxA - minA).toFixed(3)}m`)
        console.log(`    mesh-full B=[${(minB - originB).toFixed(3)}, ${(maxB - originB).toFixed(3)}] upAxisSpan=${(maxB - minB).toFixed(3)}m`)
        console.log(`    mesh-full C=[${(minC - originC).toFixed(3)}, ${(maxC - originC).toFixed(3)}] semanticFacingSpan=${(maxC - minC).toFixed(3)}m`)

        // Depth-band filtered
        let bMinA = Infinity, bMaxA = -Infinity, bMinB = Infinity, bMaxB = -Infinity, bMinC = Infinity, bMaxC = -Infinity
        let bCount = 0
        const lo = originC - depthHalfWidth, hi = originC + depthHalfWidth
        for (const mesh of meshesForWall) {
            const geom = mesh.geometry as THREE.BufferGeometry | undefined
            const pos = geom?.getAttribute('position')
            if (!pos) continue
            mesh.updateMatrixWorld(true)
            for (let i = 0; i < pos.count; i++) {
                tmp.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mesh.matrixWorld)
                const c = tmp.dot(f.semanticFacing)
                if (c < lo || c > hi) continue
                const a = tmp.dot(f.widthAxis), b = tmp.dot(f.upAxis)
                if (a < bMinA) bMinA = a; if (a > bMaxA) bMaxA = a
                if (b < bMinB) bMinB = b; if (b > bMaxB) bMaxB = b
                if (c < bMinC) bMinC = c; if (c > bMaxC) bMaxC = c
                bCount++
            }
        }
        if (bCount === 0) { console.log('    depth-band: NO vertices in band'); continue }
        console.log(`    depth-band vertices=${bCount} (band=±${depthHalfWidth.toFixed(3)}m around originC)`)
        console.log(`    depth-band A=[${(bMinA - originA).toFixed(3)}, ${(bMaxA - originA).toFixed(3)}] widthAxisSpan=${(bMaxA - bMinA).toFixed(3)}m`)
        console.log(`    depth-band B=[${(bMinB - originB).toFixed(3)}, ${(bMaxB - originB).toFixed(3)}] upAxisSpan=${(bMaxB - bMinB).toFixed(3)}m`)
        console.log(`    depth-band C=[${(bMinC - originC).toFixed(3)}, ${(bMaxC - originC).toFixed(3)}] semanticFacingSpan=${(bMaxC - bMinC).toFixed(3)}m`)
    }
}
main().catch((e) => { console.error(e); process.exit(1) })
