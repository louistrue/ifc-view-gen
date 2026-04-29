import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import * as THREE from 'three'
import { analyzeDoors, loadDetailedGeometry, getNearbyWallMeshes } from '../lib/door-analyzer'
import {
    extractDoorAnalyzerSidecarMaps,
    extractDoorHostRelationships,
    extractDoorLeafMetadata,
    extractElementStoreyElevationMap,
    extractElementStoreyMap,
    extractSlabAggregateParts,
    loadIFCModelWithMetadata,
} from '../lib/ifc-loader'

function loadIfcFile(p: string): File {
    return new File([readFileSync(p)], basename(p), { type: 'application/octet-stream' })
}

async function main() {
    const arch = resolve(process.env.ARCH ?? 'Flu21_A_AR_51_ARM_0000_A-AR-0000-0001_260421.ifc')
    const guid = process.env.GUID ?? '0TwHxk1LHcHfwGMcoYgLi_'

    const archFile = loadIfcFile(arch)
    const model = await loadIFCModelWithMetadata(archFile)
    const { operationTypeMap, csetStandardCHMap, wallCsetStandardCHMap, wallAggregatePartMap } =
        await extractDoorAnalyzerSidecarMaps(archFile)
    const doorLeafMetadataMap = await extractDoorLeafMetadata(archFile)
    const hostRelationshipMap = await extractDoorHostRelationships(archFile)
    const slabAggregatePartMap = await extractSlabAggregateParts(archFile)

    const contexts = await analyzeDoors(
        model,
        undefined,
        undefined,
        operationTypeMap,
        csetStandardCHMap,
        doorLeafMetadataMap,
        hostRelationshipMap,
        slabAggregatePartMap,
        wallAggregatePartMap,
        new Map(),
        wallCsetStandardCHMap
    )
    const ctx = contexts.find((c) => c.doorId === guid)
    if (!ctx) { console.error('door not found'); process.exit(1) }
    await loadDetailedGeometry([ctx], archFile, new THREE.Vector3(0, 0, 0))

    const f = ctx.viewFrame
    console.log(`door origin local: (${f.origin.x.toFixed(3)}, ${f.origin.y.toFixed(3)}, ${f.origin.z.toFixed(3)})`)
    console.log(`widthAxis: (${f.widthAxis.x.toFixed(3)}, ${f.widthAxis.y.toFixed(3)}, ${f.widthAxis.z.toFixed(3)})`)
    console.log(`upAxis: (${f.upAxis.x.toFixed(3)}, ${f.upAxis.y.toFixed(3)}, ${f.upAxis.z.toFixed(3)})`)
    console.log(`semanticFacing: (${f.semanticFacing.x.toFixed(3)}, ${f.semanticFacing.y.toFixed(3)}, ${f.semanticFacing.z.toFixed(3)})`)
    console.log(`door width=${f.width.toFixed(3)} height=${f.height.toFixed(3)} thickness=${f.thickness.toFixed(3)}`)
    console.log(`hostWall eid=${ctx.hostWall?.expressID ?? 'null'} bbox=`, ctx.hostWall?.boundingBox)

    const originA = f.origin.dot(f.widthAxis)
    const originC = f.origin.dot(f.semanticFacing)
    const depthHalf = Math.max(f.thickness, 0.20) + 0.20
    console.log(`originA=${originA.toFixed(3)} originC=${originC.toFixed(3)} depthHalf=${depthHalf.toFixed(3)}`)
    console.log()

    const nearbyMeshes = getNearbyWallMeshes(ctx)
    console.log(`nearbyWalls.length=${ctx.nearbyWalls.length} nearbyWallMeshes=${nearbyMeshes.length}`)
    for (const w of ctx.nearbyWalls) {
        const mesh = nearbyMeshes.filter((m) => m.userData?.expressID === w.expressID)
        console.log(`  wall eid=${w.expressID} type=${w.typeName} meshes=${mesh.length}`)
        if (mesh.length === 0) {
            if (w.boundingBox) {
                const bb = w.boundingBox
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
                let minA = Infinity, maxA = -Infinity, minC = Infinity, maxC = -Infinity
                for (const c of corners) {
                    const a = c.dot(f.widthAxis); const cc = c.dot(f.semanticFacing)
                    if (a < minA) minA = a; if (a > maxA) maxA = a
                    if (cc < minC) minC = cc; if (cc > maxC) maxC = cc
                }
                const localA = `[${(minA-originA).toFixed(3)}, ${(maxA-originA).toFixed(3)}]`
                const localC = `[${(minC-originC).toFixed(3)}, ${(maxC-originC).toFixed(3)}]`
                console.log(`    bbox-only widthAxis local=${localA} depth local=${localC}`)
            }
            continue
        }
        // Mesh-band measurement
        let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity, minC = Infinity, maxC = -Infinity
        const v = new THREE.Vector3()
        for (const m of mesh) {
            m.updateMatrixWorld(true)
            const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute
            for (let i = 0; i < pos.count; i++) {
                v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(m.matrixWorld)
                const cc = v.dot(f.semanticFacing) - originC
                if (Math.abs(cc) > depthHalf) continue
                const a = v.dot(f.widthAxis)
                const b = v.dot(f.upAxis)
                const cd = v.dot(f.semanticFacing)
                if (a < minA) minA = a
                if (a > maxA) maxA = a
                if (b < minB) minB = b
                if (b > maxB) maxB = b
                if (cd < minC) minC = cd
                if (cd > maxC) maxC = cd
            }
        }
        if (minA === Infinity) {
            console.log(`    no vertices in depth band`)
            continue
        }
        const localA = `[${(minA-originA).toFixed(3)}, ${(maxA-originA).toFixed(3)}]`
        const localB = `[${(minB-f.origin.dot(f.upAxis)).toFixed(3)}, ${(maxB-f.origin.dot(f.upAxis)).toFixed(3)}]`
        const localC = `[${(minC-originC).toFixed(3)}, ${(maxC-originC).toFixed(3)}]`
        console.log(`    mesh-band widthAxis local=${localA} up local=${localB} depth local=${localC}`)
    }
}
main().catch((e) => { console.error(e); process.exit(1) })
