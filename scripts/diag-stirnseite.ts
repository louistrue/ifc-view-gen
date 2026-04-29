import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import * as THREE from 'three'
import { analyzeDoors, loadDetailedGeometry, getHostWallMeshes, getNearbyWallMeshes } from '../lib/door-analyzer'
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
    const guid = process.env.GUID ?? '03X27dQWY$GOWvC6E9H2iM'

    const archFile = loadIfcFile(arch)
    const model = await loadIFCModelWithMetadata(archFile)
    const { operationTypeMap, csetStandardCHMap, wallCsetStandardCHMap, wallAggregatePartMap } =
        await extractDoorAnalyzerSidecarMaps(archFile)
    const doorLeafMetadataMap = await extractDoorLeafMetadata(archFile)
    const hostRelationshipMap = await extractDoorHostRelationships(archFile)
    const slabAggregatePartMap = await extractSlabAggregateParts(archFile)
    const storeyElevationMap = await extractElementStoreyElevationMap(archFile)

    const contexts = await analyzeDoors(
        model, undefined, undefined,
        operationTypeMap, csetStandardCHMap, doorLeafMetadataMap, hostRelationshipMap,
        slabAggregatePartMap, wallAggregatePartMap, storeyElevationMap, wallCsetStandardCHMap
    )
    const ctx = contexts.find((c) => c.doorId === guid || c.doorId === guid.replace('$', '_'))
    if (!ctx) {
        console.error('door not found. Tried:', guid)
        const matches = contexts.filter((c) => c.doorId.includes(guid.slice(0, 6)))
        console.error('similar:', matches.map((c) => c.doorId).slice(0, 5))
        process.exit(1)
    }
    await loadDetailedGeometry([ctx], archFile, new THREE.Vector3(0, 0, 0))

    const f = ctx.viewFrame
    console.log(`door ${ctx.doorId} hostWall eid=${ctx.hostWall?.expressID ?? '?'} hostWall type=${ctx.hostWall?.typeName ?? '?'}`)
    console.log(`door width=${f.width.toFixed(3)} height=${f.height.toFixed(3)} thickness=${f.thickness.toFixed(3)}`)
    console.log(`origin local widthAxis=${f.origin.dot(f.widthAxis).toFixed(3)} upAxis=${f.origin.dot(f.upAxis).toFixed(3)} facing=${f.origin.dot(f.semanticFacing).toFixed(3)}`)
    console.log()

    const originA = f.origin.dot(f.widthAxis)
    const originB = f.origin.dot(f.upAxis)
    const originC = f.origin.dot(f.semanticFacing)

    function meshExtent(meshes: THREE.Mesh[]): { minA: number; maxA: number; minB: number; maxB: number; minC: number; maxC: number } {
        let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity, minC = Infinity, maxC = -Infinity
        const v = new THREE.Vector3()
        for (const m of meshes) {
            m.updateMatrixWorld(true)
            const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute
            for (let i = 0; i < pos.count; i++) {
                v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(m.matrixWorld)
                const a = v.dot(f.widthAxis); const b = v.dot(f.upAxis); const c = v.dot(f.semanticFacing)
                if (a < minA) minA = a; if (a > maxA) maxA = a
                if (b < minB) minB = b; if (b > maxB) maxB = b
                if (c < minC) minC = c; if (c > maxC) maxC = c
            }
        }
        return { minA, maxA, minB, maxB, minC, maxC }
    }

    const hostWallMeshes = getHostWallMeshes(ctx)
    console.log(`hostWallMeshes count=${hostWallMeshes.length}`)
    for (const m of hostWallMeshes) {
        const ext = meshExtent([m])
        const eid = m.userData?.expressID
        const isPart = m.userData?.elementInfo?.typeName === 'IFCBUILDINGELEMENTPART'
        console.log(`  eid=${eid} ${isPart ? 'PART' : 'WALL'} A=[${(ext.minA-originA).toFixed(3)}, ${(ext.maxA-originA).toFixed(3)}] B=[${(ext.minB-originB).toFixed(3)}, ${(ext.maxB-originB).toFixed(3)}] C=[${(ext.minC-originC).toFixed(3)}, ${(ext.maxC-originC).toFixed(3)}]`)
    }

    console.log()
    console.log(`nearbyWalls count=${ctx.nearbyWalls.length}`)
    for (const w of ctx.nearbyWalls.slice(0, 8)) {
        const bb = w.boundingBox
        if (!bb) continue
        const corners = [
            new THREE.Vector3(bb.min.x, bb.min.y, bb.min.z),
            new THREE.Vector3(bb.max.x, bb.max.y, bb.max.z),
            new THREE.Vector3(bb.min.x, bb.min.y, bb.max.z),
            new THREE.Vector3(bb.max.x, bb.max.y, bb.min.z),
        ]
        let minA = Infinity, maxA = -Infinity, minC = Infinity, maxC = -Infinity
        for (const c of corners) {
            const a = c.dot(f.widthAxis); const cc = c.dot(f.semanticFacing)
            if (a < minA) minA = a; if (a > maxA) maxA = a
            if (cc < minC) minC = cc; if (cc > maxC) maxC = cc
        }
        console.log(`  wall eid=${w.expressID} type=${w.typeName} A=[${(minA-originA).toFixed(3)}, ${(maxA-originA).toFixed(3)}] C=[${(minC-originC).toFixed(3)}, ${(maxC-originC).toFixed(3)}]`)
    }

    console.log()
    console.log(`wallAggregatePartLinks count=${ctx.wallAggregatePartLinks?.length ?? 0}`)
    for (const link of (ctx.wallAggregatePartLinks ?? [])) {
        const bb = link.part.boundingBox
        if (!bb) { console.log(`  part eid=${link.part.expressID} parent=${link.parentWallExpressID} (no bbox) name="${link.part.name ?? ''}"`); continue }
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
        let minA=Infinity,maxA=-Infinity,minC=Infinity,maxC=-Infinity
        for (const c of corners) {
            const a=c.dot(f.widthAxis), cc=c.dot(f.semanticFacing)
            if(a<minA)minA=a; if(a>maxA)maxA=a; if(cc<minC)minC=cc; if(cc>maxC)maxC=cc
        }
        console.log(`  part eid=${link.part.expressID} parent=${link.parentWallExpressID} A=[${(minA-originA).toFixed(2)},${(maxA-originA).toFixed(2)}] C=[${(minC-originC).toFixed(2)},${(maxC-originC).toFixed(2)}] name="${link.part.name ?? ''}"`)
    }

    console.log()
    console.log(`nearbyDoors count=${ctx.nearbyDoors.length}`)
    for (const d of ctx.nearbyDoors.slice(0, 8)) {
        const bb = d.boundingBox
        if (!bb) continue
        const corners = [
            new THREE.Vector3(bb.min.x, bb.min.y, bb.min.z),
            new THREE.Vector3(bb.max.x, bb.max.y, bb.max.z),
            new THREE.Vector3(bb.min.x, bb.min.y, bb.max.z),
            new THREE.Vector3(bb.max.x, bb.max.y, bb.min.z),
        ]
        let minC = Infinity, maxC = -Infinity, minA = Infinity, maxA = -Infinity
        for (const c of corners) {
            const cc = c.dot(f.semanticFacing); const a = c.dot(f.widthAxis)
            if (cc < minC) minC = cc; if (cc > maxC) maxC = cc
            if (a < minA) minA = a; if (a > maxA) maxA = a
        }
        console.log(`  door eid=${d.expressID} guid=${d.globalId} A=[${(minA-originA).toFixed(3)}, ${(maxA-originA).toFixed(3)}] C=[${(minC-originC).toFixed(3)}, ${(maxC-originC).toFixed(3)}]`)
    }
}
main().catch((e) => { console.error(e); process.exit(1) })
