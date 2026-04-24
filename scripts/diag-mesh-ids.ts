import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import * as THREE from 'three'
import { analyzeDoors, loadDetailedGeometry, getNearbyDoorMeshes } from '../lib/door-analyzer'
import { extractDoorAnalyzerSidecarMaps, extractDoorHostRelationships, extractDoorLeafMetadata, extractSlabAggregateParts, loadIFCModelWithMetadata } from '../lib/ifc-loader'
function loadIfcFile(p: string): File { return new File([readFileSync(p)], basename(p), { type: 'application/octet-stream' }) }
async function main() {
    const arch = resolve('Flu21_A_AR_51_ARM_0000_A-AR-0000-0001_260421.ifc')
    const f = loadIfcFile(arch)
    const model = await loadIFCModelWithMetadata(f)
    const { operationTypeMap, csetStandardCHMap, wallAggregatePartMap } = await extractDoorAnalyzerSidecarMaps(f)
    const leaves = await extractDoorLeafMetadata(f)
    const hostRels = await extractDoorHostRelationships(f)
    const slabParts = await extractSlabAggregateParts(f)
    const ctxs = await analyzeDoors(model, undefined, undefined, operationTypeMap, csetStandardCHMap, leaves, hostRels, slabParts, wallAggregatePartMap)
    const ctx = ctxs.find((c) => c.doorId === '0OLNP8lGUkIgzNri0Tkhml')!
    await loadDetailedGeometry([ctx], f, new THREE.Vector3(), undefined)
    const meshes = getNearbyDoorMeshes(ctx)
    console.log(`Total nearby door meshes: ${meshes.length}`)
    const expected = new Set(ctx.nearbyDoors.map(d => d.expressID))
    console.log(`Expected parent IDs: ${[...expected].join(', ')}`)
    for (const m of meshes) {
        const id = m.userData?.expressID
        const match = expected.has(id)
        m.updateMatrixWorld(true)
        const bb = m.geometry.boundingBox || (m.geometry.computeBoundingBox(), m.geometry.boundingBox)!
        const sz = new THREE.Vector3(); bb.clone().applyMatrix4(m.matrixWorld).getSize(sz)
        const thin = Math.min(sz.x, sz.y, sz.z) <= 0.005
        console.log(`  mesh expressID=${id} match=${match} thin=${thin} size=(${sz.x.toFixed(3)},${sz.y.toFixed(3)},${sz.z.toFixed(3)})`)
    }
}
main().catch((e) => { console.error(e); process.exit(1) })
