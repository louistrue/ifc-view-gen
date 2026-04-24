/**
 * One-shot diagnostic: for GUID 3bGePh90dJJAhFC54r$rf5 (or any via env
 * DOOR_GUID), project every mesh category in the door context onto the
 * front-elevation camera and report which categories contribute vertices at
 * x=378.2 and x=621.8 (the phantom-edge columns).
 */
import { existsSync, readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import * as THREE from 'three'
import { analyzeDoors, getHostWallMeshes, getNearbyWallMeshes, getNearbyDoorMeshes, getNearbyWindowMeshes, getWallAggregatePartMeshesForParent, loadDetailedGeometry, type DoorContext } from '../lib/door-analyzer'
import {
    extractDoorAnalyzerSidecarMaps,
    extractDoorHostRelationships,
    extractDoorLeafMetadata,
    extractSlabAggregateParts,
    loadIFCModelWithMetadata,
} from '../lib/ifc-loader'

const GUID = process.env.DOOR_GUID ?? '3bGePh90dJJAhFC54r$rf5'

function loadIfcFile(filePath: string): File {
    const buffer = readFileSync(filePath)
    return new File([buffer], basename(filePath), { type: 'application/octet-stream' })
}

function setupFrontCamera(context: DoorContext): { camera: THREE.OrthographicCamera; w: number; h: number } {
    const frame = context.viewFrame
    const margin = 0.5
    const w = frame.width + margin * 2
    const h = frame.height + margin * 2
    const cam = new THREE.OrthographicCamera(-w / 2, w / 2, h / 2, -h / 2, 0.1, 100)
    const dist = Math.max(w, h) * 2
    cam.position.copy(frame.origin.clone().add(frame.semanticFacing.clone().multiplyScalar(dist)))
    cam.up.copy(frame.upAxis)
    cam.lookAt(frame.origin)
    cam.updateProjectionMatrix()
    cam.updateMatrixWorld()
    return { camera: cam, w, h }
}

function projectVertex(v: THREE.Vector3, cam: THREE.OrthographicCamera, w: number, h: number) {
    const p = v.clone().project(cam)
    return { x: ((p.x + 1) * w) / 2, y: ((-p.y + 1) * h) / 2 }
}

function reportCategory(name: string, meshes: THREE.Mesh[], cam: THREE.OrthographicCamera, w: number, h: number) {
    if (meshes.length === 0) {
        console.log(`  ${name}: 0 meshes`)
        return
    }
    // Find the x-range of each mesh in projected space, and depth range along facing.
    const point = new THREE.Vector3()
    for (const mesh of meshes) {
        const geom = mesh.geometry as THREE.BufferGeometry | undefined
        const pos = geom?.getAttribute('position')
        if (!geom || !pos) continue
        mesh.updateMatrixWorld(true)
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
        for (let i = 0; i < pos.count; i++) {
            point.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mesh.matrixWorld)
            const p = projectVertex(point, cam, w, h)
            if (p.x < minX) minX = p.x
            if (p.x > maxX) maxX = p.x
            if (p.y < minY) minY = p.y
            if (p.y > maxY) maxY = p.y
        }
        // Scale the projected coords from frustum-pixel (w/h are in meters) to the SVG canvas mapping.
        // In the real renderer, projected coords go through another scale pass via `resolveSvgViewTransform`.
        // We just report frustum-pixel x; the ordering is preserved.
        const eid = mesh.userData?.expressID
        // Mark if mesh spans either phantom column heuristically
        // (Columns in the actual SVG are around x=378/622 out of 1000; but our frustum coords are in meters.)
        console.log(`    ${name} eid=${eid} minX=${minX.toFixed(2)} maxX=${maxX.toFixed(2)} minY=${minY.toFixed(2)} maxY=${maxY.toFixed(2)}`)
    }
}

async function main() {
    const archPath = resolve(process.env.ARCH_IFC_PATH ?? 'Flu21_A_AR_51_ARM_0000_A-AR-0000-0001_260402.ifc')
    if (!existsSync(archPath)) throw new Error(`not found: ${archPath}`)

    const archFile = loadIfcFile(archPath)
    const model = await loadIFCModelWithMetadata(archFile)
    const { operationTypeMap, csetStandardCHMap, wallAggregatePartMap } = await extractDoorAnalyzerSidecarMaps(archFile)
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
        wallAggregatePartMap
    )

    const ctx = contexts.find((c) => c.doorId === GUID)
    if (!ctx) {
        console.error(`Door ${GUID} not found. Total contexts: ${contexts.length}`)
        process.exit(1)
    }

    await loadDetailedGeometry([ctx], archFile, new THREE.Vector3(0, 0, 0), undefined)

    const { camera, w, h } = setupFrontCamera(ctx)
    const hostEid = ctx.hostWall?.expressID ?? -1

    console.log(`\n=== Door ${GUID}`)
    console.log(`  viewFrame.width=${ctx.viewFrame.width.toFixed(3)} height=${ctx.viewFrame.height.toFixed(3)}`)
    console.log(`  hostWall eid=${hostEid} typeName=${ctx.hostWall?.typeName ?? 'n/a'}`)
    console.log(`  nearbyWalls=${ctx.nearbyWalls.length} nearbyDoors=${ctx.nearbyDoors.length} nearbyWindows=${ctx.nearbyWindows?.length ?? 0}`)
    console.log(`  wallAggregatePartLinks=${ctx.wallAggregatePartLinks.length}`)
    console.log(`  host aggregate parts: ${ctx.wallAggregatePartLinks.filter((l) => l.parentWallExpressID === hostEid).length}`)
    console.log(`  non-host aggregate parts: ${ctx.wallAggregatePartLinks.filter((l) => l.parentWallExpressID !== hostEid).length}`)

    const facing = ctx.viewFrame.semanticFacing
    const hostMeshes = getHostWallMeshes(ctx)
    const pt = new THREE.Vector3()
    let hostMin = Infinity, hostMax = -Infinity
    for (const m of hostMeshes) {
        const g = m.geometry as THREE.BufferGeometry
        const p = g?.getAttribute('position')
        if (!g || !p) continue
        m.updateMatrixWorld(true)
        for (let i = 0; i < p.count; i++) {
            pt.set(p.getX(i), p.getY(i), p.getZ(i)).applyMatrix4(m.matrixWorld)
            const d = pt.dot(facing)
            if (d < hostMin) hostMin = d
            if (d > hostMax) hostMax = d
        }
    }
    console.log(`  host wall depth along semanticFacing: min=${hostMin.toFixed(3)} max=${hostMax.toFixed(3)}`)

    console.log(`\nMesh bboxes in FRONT projection (frustum meters; phantom columns at x≈-0.05 and x≈+0.05 in meters):`)
    reportCategory('hostWall', hostMeshes, camera, w, h)
    reportCategory('nearbyWalls', getNearbyWallMeshes(ctx), camera, w, h)
    reportCategory('nearbyDoors', getNearbyDoorMeshes(ctx), camera, w, h)
    reportCategory('nearbyWindows', getNearbyWindowMeshes(ctx), camera, w, h)
    const nonHostLinks = ctx.wallAggregatePartLinks.filter((l) => l.parentWallExpressID !== hostEid)
    const nonHostParts = nonHostLinks.flatMap((l) => getWallAggregatePartMeshesForParent(ctx, l.parentWallExpressID))
    reportCategory('nonHostAggregateParts', nonHostParts, camera, w, h)
}

main().catch((err) => { console.error(err); process.exit(1) })
