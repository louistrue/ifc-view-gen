/**
 * Diagnose why electrical devices that exist in the elec IFC are not surfacing
 * for a given door. Walks every elec element within DIAG_RADIUS, reports which
 * filter gate (TYPE / FURNITURE / STOREY / VBAND / RADIUS / PLANE / SCORE)
 * would drop it. Output ordered by score so the surfaced top-N is obvious.
 *
 * Env:
 *   ARCH_IFC_PATH, ELEC_IFC_PATH (required)
 *   GUID                          door to inspect (default first door in elec storey)
 *   DIAG_RADIUS                   metres for the wider scan (default 4.0)
 *   FOCUS_GUIDS                   comma-list of elec-IFC GUIDs the reviewer flagged
 *                                 (those will be highlighted with **)
 */
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import * as THREE from 'three'
import { analyzeDoors } from '../lib/door-analyzer'
import {
    extractDoorAnalyzerSidecarMaps,
    extractDoorHostRelationships,
    extractDoorLeafMetadata,
    extractElectricalLayerAssignments,
    extractElementStoreyElevationMap,
    extractSlabAggregateParts,
    loadIFCModelWithMetadata,
} from '../lib/ifc-loader'

function loadIfcFile(p: string): File {
    return new File([readFileSync(p)], basename(p), { type: 'application/octet-stream' })
}

function pad(s: string, n: number) { return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length) }

const DIAG_RADIUS = Number(process.env.DIAG_RADIUS ?? '4.0')
const FOCUS_GUIDS = new Set<string>((process.env.FOCUS_GUIDS ?? '').split(',').map((s) => s.trim()).filter(Boolean))

async function main() {
    const arch = resolve(process.env.ARCH_IFC_PATH ?? '')
    const elec = resolve(process.env.ELEC_IFC_PATH ?? '')
    if (!arch || !elec) throw new Error('ARCH_IFC_PATH and ELEC_IFC_PATH required')
    const guid = process.env.GUID
    if (!guid) throw new Error('GUID env var required')

    const archFile = loadIfcFile(arch)
    const elecFile = loadIfcFile(elec)
    const archModel = await loadIFCModelWithMetadata(archFile)
    const elecModel = await loadIFCModelWithMetadata(elecFile)

    const { operationTypeMap, csetStandardCHMap, wallCsetStandardCHMap, wallAggregatePartMap } =
        await extractDoorAnalyzerSidecarMaps(archFile)
    const doorLeafMetadataMap = await extractDoorLeafMetadata(archFile)
    const hostRelationshipMap = await extractDoorHostRelationships(archFile)
    const slabAggregatePartMap = await extractSlabAggregateParts(archFile)
    const archStoreyMap = await extractElementStoreyElevationMap(archFile)
    const elecStoreyMap = await extractElementStoreyElevationMap(elecFile)
    const electricalLayerMap = await extractElectricalLayerAssignments(elecFile)
    const storeyElevationMap = new Map<number, number>([...archStoreyMap, ...elecStoreyMap])

    // Run analyzer against arch+elec to get the door context (so we use the same
    // viewFrame / hostWall the renderer would use).
    const contexts = await analyzeDoors(
        archModel, elecModel, electricalLayerMap,
        operationTypeMap, csetStandardCHMap, doorLeafMetadataMap, hostRelationshipMap,
        slabAggregatePartMap, wallAggregatePartMap, storeyElevationMap, wallCsetStandardCHMap
    )

    const ctx = contexts.find((c) => c.doorId === guid || c.doorId === guid.replace(/\$/g, '_'))
    if (!ctx) {
        console.error('door not found:', guid)
        process.exit(1)
    }

    const door = ctx.door
    if (!door.boundingBox) { console.error('no bbox'); process.exit(1) }
    const doorCenter = door.boundingBox.getCenter(new THREE.Vector3())
    const widthAxis = ctx.viewFrame.widthAxis.clone().normalize()
    const upAxis = ctx.viewFrame.upAxis.clone().normalize()
    const facing = ctx.viewFrame.semanticFacing.clone().normalize()

    const measureBoxInFrame = (box: THREE.Box3) => {
        const corners = [
            new THREE.Vector3(box.min.x, box.min.y, box.min.z),
            new THREE.Vector3(box.max.x, box.min.y, box.min.z),
            new THREE.Vector3(box.min.x, box.max.y, box.min.z),
            new THREE.Vector3(box.max.x, box.max.y, box.min.z),
            new THREE.Vector3(box.min.x, box.min.y, box.max.z),
            new THREE.Vector3(box.max.x, box.min.y, box.max.z),
            new THREE.Vector3(box.min.x, box.max.y, box.max.z),
            new THREE.Vector3(box.max.x, box.max.y, box.max.z),
        ]
        let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity, minC = Infinity, maxC = -Infinity
        for (const c of corners) {
            const a = c.dot(widthAxis); const b = c.dot(upAxis); const cc = c.dot(facing)
            if (a < minA) minA = a; if (a > maxA) maxA = a
            if (b < minB) minB = b; if (b > maxB) maxB = b
            if (cc < minC) minC = cc; if (cc > maxC) maxC = cc
        }
        return { minA, maxA, minB, maxB, minC, maxC }
    }

    const doorBoundsInFrame = measureBoxInFrame(door.boundingBox)
    const doorCenterA = (doorBoundsInFrame.minA + doorBoundsInFrame.maxA) / 2
    const expandedDoorVerticalMin = doorBoundsInFrame.minB
    const expandedDoorVerticalMax = doorBoundsInFrame.maxB
    const edgeBandThreshold = Math.max(ctx.viewFrame.width * 0.18, 0.24)

    const ELECTRICAL_DEVICE_TYPES = new Set([
        'IFCELECTRICAPPLIANCE','IFCSWITCHINGDEVICE','IFCOUTLET','IFCLAMP','IFCLIGHTFIXTURE',
        'IFCELECTRICDISTRIBUTIONBOARD','IFCJUNCTIONBOX','IFCELECTRICGENERATOR','IFCFLOWTERMINAL',
    ])
    const isCurrentlyAccepted = (typeName: string) => ELECTRICAL_DEVICE_TYPES.has(typeName.toUpperCase())

    const STOREY_TOLERANCE = 1.5
    const RADIUS = 1.25
    const doorStoreyElev = ctx.storeyElevation ?? null

    const elecElems = elecModel.elements

    // Step 1: scan every elec element near the door, regardless of type
    const wider: Array<any> = []
    for (const e of elecElems) {
        if (!e.boundingBox) continue
        const center = e.boundingBox.getCenter(new THREE.Vector3())
        const distXY = Math.hypot(center.x - doorCenter.x, center.z - doorCenter.z)
        const dz = Math.abs(center.y - doorCenter.y)
        if (distXY > DIAG_RADIUS && dz > 4) continue
        const candBoundsInFrame = measureBoxInFrame(e.boundingBox)
        const candidateCenterA = (candBoundsInFrame.minA + candBoundsInFrame.maxA) / 2
        const candidateCenterB = (candBoundsInFrame.minB + candBoundsInFrame.maxB) / 2
        const candidateCenterC = (candBoundsInFrame.minC + candBoundsInFrame.maxC) / 2
        const distanceToNearestJamb = Math.min(
            Math.abs(candidateCenterA - doorBoundsInFrame.minA),
            Math.abs(candidateCenterA - doorBoundsInFrame.maxA),
        )
        const overlapsDoorVerticalBand = candBoundsInFrame.maxB > expandedDoorVerticalMin && candBoundsInFrame.minB < expandedDoorVerticalMax
        const bboxGap = e.boundingBox.distanceToPoint(doorCenter) // approximation
        // use real boxDistance: simpler — compute distance between box and box
        const reBox = door.boundingBox!
        const dx = Math.max(reBox.min.x - e.boundingBox.max.x, 0, e.boundingBox.min.x - reBox.max.x)
        const dy = Math.max(reBox.min.y - e.boundingBox.max.y, 0, e.boundingBox.min.y - reBox.max.y)
        const dz2 = Math.max(reBox.min.z - e.boundingBox.max.z, 0, e.boundingBox.min.z - reBox.max.z)
        const realBboxGap = Math.hypot(dx, dy, dz2)

        const planeGap = Math.abs(candidateCenterC - doorCenter.dot(facing))
        const score = realBboxGap + planeGap + distanceToNearestJamb * 0.35 + Math.abs(candidateCenterA - doorCenterA) * 0.02

        const upper = (e.typeName ?? '').toUpperCase()
        const isFurniture = upper.includes('FURNITURE') || upper.includes('FURNISHING')
        const typeOK = isCurrentlyAccepted(e.typeName)
        const elev = elecStoreyMap.get(e.expressID) ?? archStoreyMap.get(e.expressID)
        const passStorey = elev == null || doorStoreyElev == null || Math.abs(elev - doorStoreyElev) <= STOREY_TOLERANCE
        const passVBand = overlapsDoorVerticalBand
        const passRadius = realBboxGap <= RADIUS
        const reasons: string[] = []
        if (isFurniture) reasons.push('FURNITURE-EXCL')
        if (!typeOK) reasons.push(`TYPE(${upper})`)
        if (!passStorey) reasons.push(`STOREY(Δ=${elev != null && doorStoreyElev != null ? (elev - doorStoreyElev).toFixed(2) : '?'})`)
        if (!passVBand) reasons.push(`VBAND(B=[${candBoundsInFrame.minB.toFixed(2)},${candBoundsInFrame.maxB.toFixed(2)}] door=[${expandedDoorVerticalMin.toFixed(2)},${expandedDoorVerticalMax.toFixed(2)}])`)
        if (!passRadius) reasons.push(`RADIUS(${realBboxGap.toFixed(2)}>1.25)`)

        wider.push({
            elem: e,
            score, realBboxGap, planeGap, distanceToNearestJamb,
            isFurniture, typeOK, passStorey, passVBand, passRadius,
            reasons,
            jambDist: distanceToNearestJamb,
            cy: candidateCenterB,
            cz: candidateCenterC,
            elev,
            layers: electricalLayerMap.get(e.expressID) ?? [],
        })
    }

    wider.sort((a, b) => a.score - b.score)

    console.log(`door ${ctx.doorId} storey=${ctx.storeyName} elev=${doorStoreyElev?.toFixed(3)} viewFrame.width=${ctx.viewFrame.width.toFixed(3)} door vertical=[${expandedDoorVerticalMin.toFixed(2)},${expandedDoorVerticalMax.toFixed(2)}]`)
    console.log(`scanned ${elecElems.length} elec elements, ${wider.length} within ${DIAG_RADIUS}m or 4m vertical`)
    console.log(`actually selected by analyzer: ${ctx.nearbyDevices.length} device(s) — ${ctx.nearbyDevices.map((d) => d.globalId).join(', ')}`)
    console.log()
    console.log('Score order — first 8 lines (ALL gates passed) marked OK; others tagged with reasons')
    console.log(pad('GUID', 24), pad('TYPE', 22), pad('NAME', 30), pad('SCORE', 7), pad('GAP', 6), pad('Y(m)', 6), pad('LAYERS', 22), 'REASONS')
    let okCount = 0
    for (const w of wider) {
        const ok = w.reasons.length === 0
        const marker = ok ? (okCount < 8 ? '+' : 'x') : '.'
        if (ok) okCount++
        const star = FOCUS_GUIDS.has(w.elem.globalId) ? '** ' : '   '
        console.log(
            star + marker,
            pad(w.elem.globalId ?? '?', 24),
            pad((w.elem.typeName ?? '').slice(0, 20), 22),
            pad((w.elem.name ?? '').slice(0, 28), 30),
            pad(w.score.toFixed(2), 7),
            pad(w.realBboxGap.toFixed(2), 6),
            pad(w.cy.toFixed(2), 6),
            pad(w.layers.join('|').slice(0, 20), 22),
            w.reasons.join(' | ')
        )
    }
    console.log()
    console.log(`+ = passed analyzer & in top-8 ; x = passed analyzer but cut by score-window/limit ; . = filtered out`)
    if (FOCUS_GUIDS.size > 0) {
        console.log(`** = reviewer-flagged GUID`)
        for (const fg of FOCUS_GUIDS) {
            const found = wider.find((w) => w.elem.globalId === fg)
            if (!found) console.log(`!! reviewer GUID ${fg} NOT FOUND within scan range — check radius or model presence`)
        }
    }
}
main().catch((e) => { console.error(e); process.exit(1) })
