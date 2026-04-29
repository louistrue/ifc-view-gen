import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import * as THREE from 'three'
import { analyzeDoors, loadDetailedGeometry, type DoorContext } from '../lib/door-analyzer'
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
    console.log('hostWall:', ctx.hostWall ? { eid: ctx.hostWall.expressID, guid: ctx.hostWall.globalId } : null)
    console.log('hostSource:', (ctx as any).hostWallSource)
    console.log('wall:', (ctx as any).wall ? { eid: (ctx as any).wall.expressID } : null)
    await loadDetailedGeometry([ctx], archFile, new THREE.Vector3(0, 0, 0))
    console.log('hostWallMeshes count:', (ctx as any).detailedGeometry?.hostWallMeshes?.length ?? 0)
    console.log('wallMeshes count:', (ctx as any).detailedGeometry?.wallMeshes?.length ?? 0)

    const up = ctx.viewFrame.upAxis
    const originY = ctx.viewFrame.origin.dot(up)
    console.log('door origin y (world):', originY.toFixed(3))
    console.log('viewFrame.height:', ctx.viewFrame.height.toFixed(3))
    const hostWallMeshes = (ctx as any).detailedGeometry?.hostWallMeshes ?? []
    for (const m of hostWallMeshes) {
        const bb = m.geometry.boundingBox
        if (!bb) m.geometry.computeBoundingBox()
        const geom = m.geometry as THREE.BufferGeometry
        const pos = geom.getAttribute('position')
        let mn = Infinity, mx = -Infinity
        const p = new THREE.Vector3()
        m.updateMatrixWorld(true)
        for (let i = 0; i < pos.count; i++) {
            p.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(m.matrixWorld)
            const y = p.dot(up)
            if (y < mn) mn = y
            if (y > mx) mx = y
        }
        console.log(`  hostWallMesh eid=${m.userData?.expressID} y=[${mn.toFixed(3)}, ${mx.toFixed(3)}]`)
    }
}
main().catch((e) => { console.error(e); process.exit(1) })
