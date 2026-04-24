/**
 * Print door + opening + wall vertical extents for GUID 3bGePh90dJJAhFC54r$rf5
 * so we can see exactly how big the gap between door-top and wall-opening-top is.
 */
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import * as THREE from 'three'
import {
    analyzeDoors,
    getDoorMeshes,
    getHostWallMeshes,
    loadDetailedGeometry,
    type DoorContext,
} from '../lib/door-analyzer'
import {
    extractDoorAnalyzerSidecarMaps,
    extractDoorHostRelationships,
    extractDoorLeafMetadata,
    extractSlabAggregateParts,
    loadIFCModelWithMetadata,
} from '../lib/ifc-loader'

const GUID = process.env.DOOR_GUID ?? '3bGePh90dJJAhFC54r$rf5'

function loadIfcFile(path: string): File {
    return new File([readFileSync(path)], basename(path), { type: 'application/octet-stream' })
}

function meshYExtentsInFrame(mesh: THREE.Mesh, ctx: DoorContext): { min: number; max: number } {
    const up = ctx.viewFrame.upAxis
    const geom = mesh.geometry as THREE.BufferGeometry
    const pos = geom.getAttribute('position')
    let mn = Infinity, mx = -Infinity
    const p = new THREE.Vector3()
    mesh.updateMatrixWorld(true)
    for (let i = 0; i < pos.count; i++) {
        p.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mesh.matrixWorld)
        const y = p.dot(up)
        if (y < mn) mn = y
        if (y > mx) mx = y
    }
    return { min: mn, max: mx }
}

async function main() {
    const arch = resolve(process.env.ARCH_IFC_PATH ?? 'Flu21_A_AR_51_ARM_0000_A-AR-0000-0001_260402.ifc')
    const archFile = loadIfcFile(arch)
    const model = await loadIFCModelWithMetadata(archFile)
    const { operationTypeMap, csetStandardCHMap, wallAggregatePartMap } = await extractDoorAnalyzerSidecarMaps(archFile)
    const doorLeafMetadataMap = await extractDoorLeafMetadata(archFile)
    const hostRelationshipMap = await extractDoorHostRelationships(archFile)
    const slabAggregatePartMap = await extractSlabAggregateParts(archFile)
    const contexts = await analyzeDoors(
        model, undefined, undefined, operationTypeMap, csetStandardCHMap,
        doorLeafMetadataMap, hostRelationshipMap, slabAggregatePartMap, wallAggregatePartMap
    )
    const ctx = contexts.find((c) => c.doorId === GUID)
    if (!ctx) { console.error('not found'); process.exit(1) }
    await loadDetailedGeometry([ctx], archFile, new THREE.Vector3(0, 0, 0))

    const up = ctx.viewFrame.upAxis
    const originY = ctx.viewFrame.origin.dot(up)
    console.log('=== ' + GUID + ' ===')
    console.log('viewFrame.origin.y =', originY.toFixed(3))
    console.log('viewFrame.height   =', ctx.viewFrame.height.toFixed(3))
    console.log('  → door bottom    =', (originY - ctx.viewFrame.height / 2).toFixed(3))
    console.log('  → door top       =', (originY + ctx.viewFrame.height / 2).toFixed(3))

    console.log('\n=== doorMeshes vertical extents (in upAxis coordinates) ===')
    for (const m of getDoorMeshes(ctx)) {
        const r = meshYExtentsInFrame(m, ctx)
        console.log(`  eid=${m.userData?.expressID} y=[${r.min.toFixed(3)}, ${r.max.toFixed(3)}] (height ${(r.max - r.min).toFixed(3)})`)
    }
    console.log('\n=== host wall mesh vertical extents ===')
    for (const m of getHostWallMeshes(ctx)) {
        const r = meshYExtentsInFrame(m, ctx)
        console.log(`  eid=${m.userData?.expressID} y=[${r.min.toFixed(3)}, ${r.max.toFixed(3)}] (height ${(r.max - r.min).toFixed(3)})`)
    }

    // Scan the host wall mesh at x=doorCenter to find the hole's top.
    const widthAxis = ctx.viewFrame.widthAxis
    const originX = ctx.viewFrame.origin.dot(widthAxis)
    console.log('\n=== probing host wall at door centre x ===')
    for (const m of getHostWallMeshes(ctx)) {
        const geom = m.geometry as THREE.BufferGeometry
        const pos = geom.getAttribute('position')
        if (!pos) continue
        const p = new THREE.Vector3()
        m.updateMatrixWorld(true)
        let nearCenter: Array<{ x: number; y: number }> = []
        for (let i = 0; i < pos.count; i++) {
            p.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(m.matrixWorld)
            const localX = p.dot(widthAxis) - originX
            const localY = p.dot(up) - originY
            if (Math.abs(localX) < 0.05) nearCenter.push({ x: localX, y: localY })
        }
        if (nearCenter.length > 0) {
            nearCenter.sort((a, b) => a.y - b.y)
            const ys = nearCenter.map((p) => p.y)
            console.log(`  eid=${m.userData?.expressID}: ${nearCenter.length} vertices within 5cm of door center-x`)
            console.log(`    y range at centre: [${Math.min(...ys).toFixed(3)}, ${Math.max(...ys).toFixed(3)}]`)
            // Show a histogram of y values to find the hole
            const buckets = new Map<number, number>()
            for (const { y } of nearCenter) {
                const key = Math.round(y * 10) / 10
                buckets.set(key, (buckets.get(key) || 0) + 1)
            }
            console.log('    y-histogram (bin=0.1m):')
            for (const [bin, cnt] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
                console.log(`      y≈${bin.toFixed(1)}: ${cnt}`)
            }
        }
    }
}

main().catch((e) => { console.error(e); process.exit(1) })
