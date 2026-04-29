import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import * as THREE from 'three'
import {
    analyzeDoors,
    getDoorMeshes,
    getHostWallMeshes,
    getNearbyDoorMeshes,
    getNearbyWallMeshes,
    loadDetailedGeometry,
} from '../lib/door-analyzer'
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

function measureMinMaxA(meshes: THREE.Mesh[], widthAxis: THREE.Vector3): { minA: number; maxA: number } | null {
    let minA = Infinity, maxA = -Infinity
    const p = new THREE.Vector3()
    for (const m of meshes) {
        const g = m.geometry as THREE.BufferGeometry | undefined
        const pos = g?.getAttribute('position')
        if (!g || !pos) continue
        m.updateMatrixWorld(true)
        const idx = g.getIndex()
        const visit = (vi: number) => {
            p.set(pos.getX(vi), pos.getY(vi), pos.getZ(vi)).applyMatrix4(m.matrixWorld)
            const a = p.dot(widthAxis)
            if (a < minA) minA = a
            if (a > maxA) maxA = a
        }
        if (idx && idx.count > 0) for (let i = 0; i < idx.count; i++) visit(idx.getX(i))
        else for (let i = 0; i < pos.count; i++) visit(i)
    }
    return minA === Infinity ? null : { minA, maxA }
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

    await loadDetailedGeometry([ctx], archFile, new THREE.Vector3(0, 0, 0))

    const frame = ctx.viewFrame
    const widthAxis = frame.widthAxis
    const originA = frame.origin.dot(widthAxis)

    const host = getHostWallMeshes(ctx)
    const nearbyW = getNearbyWallMeshes(ctx)
    const nearbyD = getNearbyDoorMeshes(ctx)
    const door = getDoorMeshes(ctx)
    console.log('host meshes:', host.length, 'nearbyWalls:', nearbyW.length, 'nearbyDoors:', nearbyD.length, 'doorMeshes:', door.length)

    const show = (name: string, meshes: THREE.Mesh[]) => {
        const b = measureMinMaxA(meshes, widthAxis)
        if (!b) { console.log(`  ${name}: (empty)`); return }
        console.log(`  ${name}: local minA=${(b.minA - originA).toFixed(2)}, maxA=${(b.maxA - originA).toFixed(2)}`)
    }
    show('host(mesh)', host)
    show('nearbyWalls(mesh)', nearbyW)
    show('nearbyDoors(mesh)', nearbyD)
    show('door(mesh)', door)

    // bbox-based version
    const showBox = (name: string, box: THREE.Box3 | null | undefined) => {
        if (!box) { console.log(`  ${name}: (no bbox)`); return }
        const corners = [
            new THREE.Vector3(box.min.x, box.min.y, box.min.z),
            new THREE.Vector3(box.min.x, box.min.y, box.max.z),
            new THREE.Vector3(box.min.x, box.max.y, box.min.z),
            new THREE.Vector3(box.min.x, box.max.y, box.max.z),
            new THREE.Vector3(box.max.x, box.min.y, box.min.z),
            new THREE.Vector3(box.max.x, box.min.y, box.max.z),
            new THREE.Vector3(box.max.x, box.max.y, box.min.z),
            new THREE.Vector3(box.max.x, box.max.y, box.max.z),
        ]
        const xs = corners.map((c) => c.dot(widthAxis))
        console.log(`  ${name}: local minA=${(Math.min(...xs) - originA).toFixed(2)}, maxA=${(Math.max(...xs) - originA).toFixed(2)}`)
    }
    showBox('door(bbox)', ctx.door.boundingBox ?? null)
    showBox('hostWall(bbox)', ctx.hostWall?.boundingBox ?? null)
    for (const w of ctx.nearbyWalls) showBox(`nearbyWall(bbox) eid=${w.expressID}`, w.boundingBox ?? null)
    for (const d of (ctx.nearbyDoors ?? [])) showBox(`nearbyDoor(bbox) eid=${d.expressID}`, d.boundingBox ?? null)

    // Project footprint extremes in both views to pixel space to see back-view clamp behavior
    const frameW = frame.width
    const margin = 0.5
    const frustumW = frameW + margin * 2
    const frustumH = frame.height + margin * 2
    const makeCam = (back: boolean) => {
        const cam = new THREE.OrthographicCamera(-frustumW/2, frustumW/2, frame.height/2 + margin, -(frame.height/2 + margin), 0.1, 100)
        const dist = Math.max(frustumW, frustumH) * 2
        const dir = back ? frame.semanticFacing.clone().negate() : frame.semanticFacing.clone()
        cam.position.copy(frame.origin).add(dir.multiplyScalar(dist))
        cam.up.copy(frame.upAxis)
        cam.lookAt(frame.origin)
        cam.updateProjectionMatrix()
        cam.updateMatrixWorld()
        return cam
    }
    const W = 1500, H = 700
    const proj = (cam: THREE.OrthographicCamera, p: THREE.Vector3) => {
        const v = p.clone().project(cam)
        return { x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H }
    }
    const frontCam = makeCam(false)
    const backCam = makeCam(true)
    const buildPt = (a: number) => frame.origin.clone().add(widthAxis.clone().multiplyScalar(a))
    console.log('\n-- front view pixel projection --')
    for (const a of [-0.80, -0.60, 0, 0.60, 1.48, 2.32]) {
        const p = buildPt(a)
        const fx = proj(frontCam, p).x
        console.log(`  widthAxis*${a.toFixed(2)} -> px=${fx.toFixed(1)}`)
    }
    console.log('-- back view pixel projection --')
    for (const a of [-0.80, -0.60, 0, 0.60, 1.48, 2.32]) {
        const p = buildPt(a)
        const bx = proj(backCam, p).x
        console.log(`  widthAxis*${a.toFixed(2)} -> px=${bx.toFixed(1)}`)
    }

    // host mesh filtered to ±1m depth band (mirrors getHostWallAxisBounds)
    let fMin = Infinity, fMax = -Infinity
    const originD = frame.origin.dot(frame.semanticFacing)
    const p = new THREE.Vector3()
    for (const m of host) {
        const g = m.geometry as THREE.BufferGeometry | undefined
        const pos = g?.getAttribute('position')
        if (!g || !pos) continue
        m.updateMatrixWorld(true)
        const idx = g.getIndex()
        const visit = (vi: number) => {
            p.set(pos.getX(vi), pos.getY(vi), pos.getZ(vi)).applyMatrix4(m.matrixWorld)
            const d = p.dot(frame.semanticFacing) - originD
            if (Math.abs(d) > 1.0) return
            const a = p.dot(widthAxis)
            if (a < fMin) fMin = a
            if (a > fMax) fMax = a
        }
        if (idx && idx.count > 0) for (let i = 0; i < idx.count; i++) visit(idx.getX(i))
        else for (let i = 0; i < pos.count; i++) visit(i)
    }
    if (Number.isFinite(fMin)) {
        console.log(`  host(mesh, ±1m depth): local minA=${(fMin - originA).toFixed(2)}, maxA=${(fMax - originA).toFixed(2)}`)
    } else {
        console.log('  host(mesh, ±1m depth): (empty)')
    }
}
main().catch((e) => { console.error(e); process.exit(1) })
