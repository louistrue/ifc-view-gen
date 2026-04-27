/**
 * Dumps what `computePlanVisibility`-equivalent logic decides for a door's
 * nearby walls — which wall expressIDs are "plan-visible" via mesh-section
 * intersection with the lateral corridor.
 */
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import * as THREE from 'three'
import { analyzeDoors, getNearbyWallMeshes, loadDetailedGeometry } from '../lib/door-analyzer'
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

const PLAN_CUT_HEIGHT_METERS = 1.8

function extractMeshSectionSegments(mesh: THREE.Mesh, cutY: number): Array<{ a: THREE.Vector3; b: THREE.Vector3 }> {
    const segments: Array<{ a: THREE.Vector3; b: THREE.Vector3 }> = []
    mesh.updateMatrixWorld(true)
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute
    const idx = mesh.geometry.getIndex()
    const count = idx ? idx.count : pos.count
    const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3()
    for (let i = 0; i < count; i += 3) {
        const ia = idx ? idx.getX(i) : i
        const ib = idx ? idx.getX(i + 1) : i + 1
        const ic = idx ? idx.getX(i + 2) : i + 2
        va.set(pos.getX(ia), pos.getY(ia), pos.getZ(ia)).applyMatrix4(mesh.matrixWorld)
        vb.set(pos.getX(ib), pos.getY(ib), pos.getZ(ib)).applyMatrix4(mesh.matrixWorld)
        vc.set(pos.getX(ic), pos.getY(ic), pos.getZ(ic)).applyMatrix4(mesh.matrixWorld)
        const ys = [va.y, vb.y, vc.y]
        const minY = Math.min(...ys), maxY = Math.max(...ys)
        if (cutY < minY - 1e-6 || cutY > maxY + 1e-6) continue
        const verts = [va, vb, vc]
        const cross: THREE.Vector3[] = []
        for (let k = 0; k < 3; k++) {
            const p1 = verts[k], p2 = verts[(k + 1) % 3]
            if ((p1.y - cutY) * (p2.y - cutY) <= 0) {
                if (Math.abs(p1.y - p2.y) < 1e-9) {
                    cross.push(p1.clone(), p2.clone())
                } else {
                    const t = (cutY - p1.y) / (p2.y - p1.y)
                    if (t >= -1e-6 && t <= 1 + 1e-6) {
                        cross.push(new THREE.Vector3().lerpVectors(p1, p2, t))
                    }
                }
            }
        }
        if (cross.length >= 2) segments.push({ a: cross[0].clone(), b: cross[1].clone() })
    }
    return segments
}

async function main() {
    const arch = resolve(process.env.ARCH ?? 'Flu21_A_AR_51_ARM_0000_A-AR-0000-0001_260421.ifc')
    const elec = process.env.ELEC ?? 'Flu21_A_EL_52_ELM_0000_A-EL-2300-0001_IFC Elektro.ifc'
    const guid = process.env.GUID ?? '0Q6xEX6npRHwT4hPakCo_R'

    const archFile = loadIfcFile(arch)
    const elecFile = loadIfcFile(resolve(elec))
    const model = await loadIFCModelWithMetadata(archFile)
    const elecModel = await loadIFCModelWithMetadata(elecFile)
    const { operationTypeMap, csetStandardCHMap, wallCsetStandardCHMap, wallAggregatePartMap } =
        await extractDoorAnalyzerSidecarMaps(archFile)
    const doorLeafMetadataMap = await extractDoorLeafMetadata(archFile)
    const hostRelationshipMap = await extractDoorHostRelationships(archFile)
    const slabAggregatePartMap = await extractSlabAggregateParts(archFile)
    const storeyElevationMap = await extractElementStoreyElevationMap(archFile)

    const contexts = await analyzeDoors(
        model, elecModel, undefined, operationTypeMap, csetStandardCHMap,
        doorLeafMetadataMap, hostRelationshipMap, slabAggregatePartMap, wallAggregatePartMap,
        storeyElevationMap, wallCsetStandardCHMap
    )
    const ctx = contexts.find((c) => c.doorId === guid || c.doorId === guid.replace('$', '_'))
    if (!ctx) { console.error('door not found:', guid); process.exit(1) }

    await loadDetailedGeometry([ctx], archFile, new THREE.Vector3(0, 0, 0))

    const f = ctx.viewFrame
    const cutY = f.origin.y - f.height / 2 + PLAN_CUT_HEIGHT_METERS
    const originW = f.origin.dot(f.widthAxis)

    const halfDoor = f.width / 2
    const lateralGap = Math.min(Math.max(f.width * 0.5, 0.5), 1.5)
    const planCorridorHalfNoCap = halfDoor + lateralGap // raw plan corridor (uncapped)
    const FIXED_PX_PER_METER = 285
    const canvasHalf = 1000 / FIXED_PX_PER_METER / 2 // 1.754
    const myCorridorHalf = Math.min(canvasHalf, planCorridorHalfNoCap)

    console.log(`door=${ctx.doorId} hostWall=${ctx.hostWall?.expressID ?? '?'}`)
    console.log(`width=${f.width.toFixed(3)} halfDoor=${halfDoor.toFixed(3)} lateralGap=${lateralGap.toFixed(3)}`)
    console.log(`planCorridorHalf(uncapped)=${planCorridorHalfNoCap.toFixed(3)} canvasHalf=${canvasHalf.toFixed(3)} myCorridorHalf=${myCorridorHalf.toFixed(3)}`)
    console.log(`cutY=${cutY.toFixed(3)} originW=${originW.toFixed(3)}`)
    console.log(`nearbyWalls: ${ctx.nearbyWalls.map((w) => w.expressID).join(', ')}`)

    const meshes = getNearbyWallMeshes(ctx)
    const meshByID = new Map<number, THREE.Mesh[]>()
    for (const m of meshes) {
        const id = m.userData?.expressID
        if (typeof id !== 'number') continue
        const arr = meshByID.get(id) ?? []
        arr.push(m)
        meshByID.set(id, arr)
    }

    for (const wall of ctx.nearbyWalls) {
        const id = wall.expressID
        const wallMeshes = meshByID.get(id) ?? []
        if (wallMeshes.length === 0) {
            console.log(`  wall eid=${id} type=${wall.typeName} NO MESH (legacy fallback would keep)`)
            continue
        }
        let segCount = 0
        let lo = Infinity, hi = -Infinity
        let inCorridor = false
        for (const m of wallMeshes) {
            const segs = extractMeshSectionSegments(m, cutY)
            segCount += segs.length
            for (const seg of segs) {
                const a = seg.a.dot(f.widthAxis) - originW
                const b = seg.b.dot(f.widthAxis) - originW
                const segLo = Math.min(a, b), segHi = Math.max(a, b)
                if (segLo < lo) lo = segLo
                if (segHi > hi) hi = segHi
                if (segHi >= -myCorridorHalf && segLo <= myCorridorHalf) inCorridor = true
            }
        }
        const localMin = lo === Infinity ? '?' : lo.toFixed(3)
        const localMax = hi === -Infinity ? '?' : hi.toFixed(3)
        console.log(`  wall eid=${id} type=${wall.typeName} segs=${segCount} widthAxis=[${localMin}, ${localMax}] inCorridor=${inCorridor}`)
    }
}
main().catch((e) => { console.error(e); process.exit(1) })
