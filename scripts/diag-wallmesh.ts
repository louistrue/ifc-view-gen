import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import * as THREE from 'three'
import {
    analyzeDoors,
    getHostWallMeshes,
    loadDetailedGeometry,
} from '../lib/door-analyzer'
import {
    extractDoorAnalyzerSidecarMaps,
    extractDoorHostRelationships,
    extractDoorLeafMetadata,
    extractSlabAggregateParts,
    loadIFCModelWithMetadata,
} from '../lib/ifc-loader'
function loadIfcFile(p: string): File { return new File([readFileSync(p)], basename(p), { type: 'application/octet-stream' }) }
async function main() {
    const arch = resolve('Flu21_A_AR_51_ARM_0000_A-AR-0000-0001_260402.ifc')
    const archFile = loadIfcFile(arch)
    const model = await loadIFCModelWithMetadata(archFile)
    const { operationTypeMap, csetStandardCHMap, wallAggregatePartMap } = await extractDoorAnalyzerSidecarMaps(archFile)
    const doorLeafMetadataMap = await extractDoorLeafMetadata(archFile)
    const hostRelationshipMap = await extractDoorHostRelationships(archFile)
    const slabAggregatePartMap = await extractSlabAggregateParts(archFile)
    const contexts = await analyzeDoors(model, undefined, undefined, operationTypeMap, csetStandardCHMap, doorLeafMetadataMap, hostRelationshipMap, slabAggregatePartMap, wallAggregatePartMap)
    const ctx = contexts.find(c => c.doorId === '0rcDhkErfjJ9px01Ab_sgY')!
    await loadDetailedGeometry([ctx], archFile, new THREE.Vector3(), undefined)
    const meshes = getHostWallMeshes(ctx)
    console.log('host wall mesh count:', meshes.length)
    const frame = ctx.viewFrame
    const widthAxis = frame.widthAxis
    const originA = frame.origin.dot(widthAxis)
    let minA = Infinity, maxA = -Infinity
    for (const mesh of meshes) {
        mesh.updateMatrixWorld(true)
        const positions = mesh.geometry.attributes.position
        for (let i = 0; i < positions.count; i++) {
            const v = new THREE.Vector3(positions.getX(i), positions.getY(i), positions.getZ(i)).applyMatrix4(mesh.matrixWorld)
            const a = v.dot(widthAxis)
            if (a < minA) minA = a; if (a > maxA) maxA = a
        }
    }
    console.log('host wall mesh vertex range along widthAxis (local):', (minA - originA).toFixed(2), 'to', (maxA - originA).toFixed(2), 'm')
    console.log('host wall bbox xLocal:', ctx.hostWall?.boundingBox ? 'present' : 'missing')
    if (ctx.hostWall?.boundingBox) {
        const bb = ctx.hostWall.boundingBox
        const xs: number[] = []
        for (const x of [bb.min.x, bb.max.x]) for (const y of [bb.min.y, bb.max.y]) for (const z of [bb.min.z, bb.max.z])
            xs.push(new THREE.Vector3(x, y, z).dot(widthAxis) - originA)
        console.log('host wall bbox xLocal range:', Math.min(...xs).toFixed(2), 'to', Math.max(...xs).toFixed(2), 'm')
    }
}
main().catch(e => { console.error(e); process.exit(1) })
