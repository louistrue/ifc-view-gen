import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import * as THREE from 'three'
import { analyzeDoors, loadDetailedGeometry, getNearbyDoorMeshes, getNearbyWindowMeshes } from '../lib/door-analyzer'
import {
    extractDoorAnalyzerSidecarMaps, extractDoorHostRelationships, extractDoorLeafMetadata,
    extractSlabAggregateParts, loadIFCModelWithMetadata,
} from '../lib/ifc-loader'
const GUID = '0OLNP8lGUkIgzNri0Tkhml'
function loadIfcFile(p: string): File { return new File([readFileSync(p)], basename(p), { type: 'application/octet-stream' }) }
async function main() {
    const arch = resolve(process.env.ARCH_IFC_PATH ?? 'Flu21_A_AR_51_ARM_0000_A-AR-0000-0001_260421.ifc')
    const archFile = loadIfcFile(arch)
    const model = await loadIFCModelWithMetadata(archFile)
    const { operationTypeMap, csetStandardCHMap, wallAggregatePartMap } = await extractDoorAnalyzerSidecarMaps(archFile)
    const leaves = await extractDoorLeafMetadata(archFile)
    const hostRels = await extractDoorHostRelationships(archFile)
    const slabParts = await extractSlabAggregateParts(archFile)
    const ctxs = await analyzeDoors(model, undefined, undefined, operationTypeMap, csetStandardCHMap, leaves, hostRels, slabParts, wallAggregatePartMap)
    const ctx = ctxs.find((c) => c.doorId === GUID)!
    await loadDetailedGeometry([ctx], archFile, new THREE.Vector3(), undefined)
    console.log('nearbyDoors:', ctx.nearbyDoors.length)
    for (const d of ctx.nearbyDoors) {
        const bkp = ctx.nearbyDoorBKP.get(d.expressID)
        const meshes = getNearbyDoorMeshes(ctx).filter(m => m.userData?.expressID === d.expressID)
        let thinCount = 0, totalVerts = 0
        for (const m of meshes) {
            const geom = m.geometry as THREE.BufferGeometry
            geom.computeBoundingBox()
            const bb = geom.boundingBox!.clone()
            m.updateMatrixWorld(true)
            bb.applyMatrix4(m.matrixWorld)
            const size = new THREE.Vector3(); bb.getSize(size)
            const dMin = Math.min(size.x, size.y, size.z)
            if (dMin <= 0.005) thinCount++
            totalVerts += geom.getAttribute('position').count
        }
        console.log(`  door eid=${d.expressID} bkp=${bkp} meshes=${meshes.length} glazingSubMeshes=${thinCount} verts=${totalVerts} bboxY=${d.boundingBox?.min.y}..${d.boundingBox?.max.y}`)
    }
    console.log('nearbyWindows:', ctx.nearbyWindows?.length ?? 0)
    for (const w of ctx.nearbyWindows ?? []) {
        console.log(`  win eid=${w.expressID} bboxY=${w.boundingBox?.min.y}..${w.boundingBox?.max.y}`)
    }
    console.log('hostWall aggregate parts:', ctx.wallAggregatePartLinks?.length ?? 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
