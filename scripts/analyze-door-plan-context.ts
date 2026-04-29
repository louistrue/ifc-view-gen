/**
 * Analyse: eine Fokus-Tür (IfcDoor GlobalId) im Arch-IFC plus beliebige weitere GlobalIds
 * (Wände, Vorhangfassaden, Stützen, andere Türen, …). Es wird **kein** SVG geschrieben —
 * nur Konsolen-Report, ob diese Elemente im `DoorContext` / in `loadDetailedGeometry` vorkommen
 * und wie sie zum Türrahmen liegen.
 *
 * Projektroot:
 *   npm run analyze:door-plan-context
 *   node scripts/analyze-door-plan-context-runner.js
 *
 * Laufzeit: `loadIFCModelWithMetadata` streamt die gesamte Modell-Geometrie; danach ein weiteres
 * `OpenModel` in `loadDetailedGeometry`. Tür-Metadaten (OperationType, Cset_StandardCH, Wall-Aggregate)
 * laufen in **einem** web-ifc-Open über `extractDoorAnalyzerSidecarMaps` (nicht mehr drei separate Opens).
 *
 * `[WEB-IFC]`-Meldungen von web-ifc gehen über Emscripten meist auf **stdout**; der Runner
 * `analyze-door-plan-context-runner.js` filtert stdout+stderr vor dem Laden von ts-node / IFC.
 */
import { existsSync, readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import * as THREE from 'three'
import { analyzeDoors, loadDetailedGeometry, type DoorContext } from '../lib/door-analyzer'
import type { ElementInfo, LoadedIFCModel } from '../lib/ifc-types'
import { extractDoorAnalyzerSidecarMaps, loadIFCModelWithMetadata } from '../lib/ifc-loader'

// ---------------------------------------------------------------------------
const USER_CONFIG = {
    architectureIfc: resolve(process.cwd(), 'scripts', 'Flu21_A_AR_51_ARM_0000_A-AR-0000-0001_260421.ifc'),
    electricalIfc: null as string | null,
    /** IfcDoor GlobalId der analysierten Tür */
    doorGlobalId: '1deFxoCcbbI816DRLMaWcI',
    /**
     * Weitere Ifc-GlobalIds (Wand, IfcCurtainWall, IfcColumn, zweite Tür, …).
     * Syntax: echtes JS-String-Array in eckigen Klammern, z. B. `['id1', 'id2']`.
     * Leer `[]` = nur Fokus-Tür-Kontext aus dem Analyzer.
     */
    contextGlobalIds: ['0s0PXharsgJeKPvcdf6erO', '3d7r6XkNwYHgjXFdfRtTDk','24ZK5Kd$iSlTIK1E7fSV_c','2Io_r4YzqivdpTaeWbuCbo','0n82oJe7ufHhKPd2bxBMNc','2eJ_etSquFJl6TcF8eMKc2','3Nm1Y8KYRwwKq3UWH7AvGm'],
}

// ---------------------------------------------------------------------------

function maybePrintHelp(argv: string[]): void {
    if (!argv.includes('--help') && !argv.includes('-h')) return
    console.log(`Door plan context analysis

  npm run analyze:door-plan-context

Edit USER_CONFIG in scripts/analyze-door-plan-context.ts:
  architectureIfc, doorGlobalId, contextGlobalIds[]`)
    process.exit(0)
}

function loadIfcFile(filePath: string): File {
    const buffer = readFileSync(filePath)
    return new File([buffer], basename(filePath), { type: 'application/octet-stream' })
}

function findElementByGlobalId(model: LoadedIFCModel, globalId: string): ElementInfo | undefined {
    const g = globalId.trim()
    return model.elements.find((e) => e.globalId?.trim() === g)
}

function findDoorContext(contexts: DoorContext[], doorGlobalId: string): DoorContext | undefined {
    const g = doorGlobalId.trim()
    return contexts.find(
        (c) => c.doorId === g || (c.door.globalId && c.door.globalId.trim() === g)
    )
}

function boxCenter(box: THREE.Box3 | undefined): THREE.Vector3 | null {
    if (!box) return null
    return box.getCenter(new THREE.Vector3())
}

function distance3(a: THREE.Vector3, b: THREE.Vector3): number {
    return a.distanceTo(b)
}

function summarizeContextMembership(ctx: DoorContext, el: ElementInfo): string {
    const parts: string[] = []
    if (ctx.hostWall?.expressID === el.expressID) parts.push('hostWall')
    if (ctx.wallAggregatePartLinks.some((l) => l.part.expressID === el.expressID)) {
        parts.push('wallAggregatePartLinks')
    }
    if (ctx.nearbyWalls.some((w) => w.expressID === el.expressID)) parts.push('nearbyWalls')
    if (ctx.nearbyDoors.some((d) => d.expressID === el.expressID)) parts.push('nearbyDoors')
    if (ctx.nearbyWindows?.some((w) => w.expressID === el.expressID)) parts.push('nearbyWindows')
    if (ctx.nearbyStairs.some((s) => s.expressID === el.expressID)) parts.push('nearbyStairs')
    if (ctx.nearbyDevices.some((d) => d.expressID === el.expressID)) parts.push('nearbyDevices')
    if (ctx.door.expressID === el.expressID) parts.push('(focal door)')
    return parts.length > 0 ? parts.join(', ') : '(not in DoorContext lists)'
}

function elementInDoorContextLists(ctx: DoorContext, el: ElementInfo): boolean {
    return (
        ctx.hostWall?.expressID === el.expressID
        || ctx.wallAggregatePartLinks.some((l) => l.part.expressID === el.expressID)
        || ctx.nearbyWalls.some((w) => w.expressID === el.expressID)
        || ctx.nearbyDoors.some((d) => d.expressID === el.expressID)
        || (ctx.nearbyWindows?.some((w) => w.expressID === el.expressID) ?? false)
        || ctx.nearbyStairs.some((s) => s.expressID === el.expressID)
        || ctx.nearbyDevices.some((d) => d.expressID === el.expressID)
    )
}

/** Kurzer Hinweis zu Typ / Distanz — nicht widersprüchlich zu „DoorContext“. */
function pipelineHint(ctx: DoorContext, el: ElementInfo, distCenterM: number): string {
    const t = el.typeName.trim().toUpperCase()
    if (t === 'IFCBUILDINGELEMENTPART') {
        const link = ctx.wallAggregatePartLinks.find((l) => l.part.expressID === el.expressID)
        if (link) {
            return `IfcBuildingElementPart unter IfcRelAggregates an Wand expressID=${link.parentWallExpressID} — im DoorContext als wallAggregatePartLinks; Geometrie in detailedGeometry.wallAggregatePartMeshes (Plan-Schnitt mit Host-/Nearby-Wänden).`
        }
        return 'IfcBuildingElementPart ohne RelAggregates→IfcWall/IfcWallStandardCase/IfcCurtainWall in diesem Modell, oder Elternwand ist weder hostWall noch nearbyWalls — dann kein Tür-Plan-Kontext.'
    }

    if (elementInDoorContextLists(ctx, el)) {
        const parts: string[] = [
            'Bereits im DoorContext — der Abstand „Tür-BBox-Mitte ↔ Element-BBox-Mitte“ ist kein Ausschlusskriterium (lange Wände, Tür seitlich an der Wand).',
        ]
        if (ctx.hostWall?.expressID === el.expressID && Number.isFinite(distCenterM)) {
            parts.push(`Hostwand: Mittenabstand ~${distCenterM.toFixed(2)} m ist üblich.`)
        }
        return parts.join(' ')
    }

    const bits: string[] = []
    if (Number.isFinite(distCenterM) && distCenterM > 2) {
        bits.push(
            `BBox-Mittenabstand ~${distCenterM.toFixed(2)} m — findNearbyWalls nutzt schmale Bänder (~±1,6 m quer / ±1,2 m tief zur Türebene); große Mitten-Distanz spricht oft dafür, dass kein Treffer in nearbyWalls erfolgt (sofern nicht hostWall).`
        )
    }
    if (t === 'IFCWINDOW' || t.startsWith('IFCWINDOW')) {
        bits.push(
            'IfcWindow: Kontext über nearbyWindows (gleicher Plan-Band wie nearbyWalls) + detailedGeometry.nearbyWindowMeshes nach loadDetailedGeometry.'
        )
    }
    if (t === 'IFCCOLUMN' || t === 'IFCMEMBER' || t === 'IFCBUILDINGELEMENTPROXY') {
        bits.push(`${el.typeName}: im Analyzer keine nearbyWall / kein dedizierter Plan-Kontext wie bei Wänden.`)
    }
    return bits.join(' ') || 'Nicht in hostWall / nearbyWalls / nearbyDoors / nearbyWindows — Typ oder räumliche Filter (lib/door-analyzer).'
}

function meshCountForExpressId(ctx: DoorContext, expressID: number): number {
    const dg = ctx.detailedGeometry
    if (!dg) return 0
    const all = [
        ...dg.doorMeshes,
        ...dg.wallMeshes,
        ...dg.nearbyWallMeshes,
        ...dg.wallAggregatePartMeshes,
        ...dg.nearbyDoorMeshes,
        ...dg.nearbyWindowMeshes,
        ...dg.slabMeshes,
        ...dg.ceilingMeshes,
        ...dg.stairMeshes,
        ...dg.deviceMeshes,
    ]
    return all.filter((m) => m.userData?.expressID === expressID).length
}

async function main(): Promise<void> {
    maybePrintHelp(process.argv.slice(2))

    const archPath = resolve(USER_CONFIG.architectureIfc)
    if (!existsSync(archPath)) {
        console.error(`IFC not found: ${archPath}`)
        process.exit(1)
    }

    const elecPath = USER_CONFIG.electricalIfc ? resolve(USER_CONFIG.electricalIfc) : null
    if (elecPath && !existsSync(elecPath)) {
        console.error(`Electrical IFC not found: ${elecPath}`)
        process.exit(1)
    }

    const archFile = loadIfcFile(archPath)
    const elecFile = elecPath ? loadIfcFile(elecPath) : undefined

    const primaryModel = await loadIFCModelWithMetadata(archFile)
    const secondaryModel = elecFile ? await loadIFCModelWithMetadata(elecFile) : undefined

    const { operationTypeMap, csetStandardCHMap, wallAggregatePartMap } = await extractDoorAnalyzerSidecarMaps(archFile)
    const contexts = await analyzeDoors(
        primaryModel,
        secondaryModel,
        undefined,
        operationTypeMap,
        csetStandardCHMap,
        undefined,
        undefined,
        undefined,
        wallAggregatePartMap
    )

    const doorGid = USER_CONFIG.doorGlobalId.trim()
    const ctx = findDoorContext(contexts, doorGid)
    if (!ctx) {
        console.error(
            `No IfcDoor context for GlobalId "${doorGid}". Loaded doors: ${contexts.length}.`
                + ' Check GUID / primary model.'
        )
        process.exit(1)
    }

    console.log('=== Focal door ===')
    console.log(`  doorId:          ${ctx.doorId}`)
    console.log(`  expressID:       ${ctx.door.expressID}`)
    console.log(`  typeName:        ${ctx.door.typeName}`)
    console.log(`  name:            ${ctx.door.name ?? '(none)'}`)
    console.log(`  hostWall:        ${ctx.hostWall ? `${ctx.hostWall.typeName} expressID=${ctx.hostWall.expressID} gid=${ctx.hostWall.globalId ?? '?'}` : '(null)'}`)
    console.log(`  nearbyWalls:     ${ctx.nearbyWalls.length}`)
    ctx.nearbyWalls.slice(0, 20).forEach((w, i) => {
        console.log(`    [${i}] ${w.typeName} eid=${w.expressID} gid=${w.globalId ?? '?'}`)
    })
    if (ctx.nearbyWalls.length > 20) console.log(`    … +${ctx.nearbyWalls.length - 20} more`)
    console.log(`  nearbyDoors:     ${ctx.nearbyDoors.length}`)
    ctx.nearbyDoors.slice(0, 15).forEach((d, i) => {
        console.log(`    [${i}] eid=${d.expressID} gid=${d.globalId ?? '?'}`)
    })
    if (ctx.nearbyDoors.length > 15) console.log(`    … +${ctx.nearbyDoors.length - 15} more`)
    console.log(`  nearbyWindows:   ${ctx.nearbyWindows?.length ?? 0}`)
    ;(ctx.nearbyWindows ?? []).slice(0, 15).forEach((w, i) => {
        console.log(`    [${i}] ${w.typeName} eid=${w.expressID} gid=${w.globalId ?? '?'}`)
    })
    if ((ctx.nearbyWindows?.length ?? 0) > 15) {
        console.log(`    … +${(ctx.nearbyWindows?.length ?? 0) - 15} more`)
    }
    console.log(`  wallAggregatePartLinks: ${ctx.wallAggregatePartLinks.length}`)
    ctx.wallAggregatePartLinks.slice(0, 15).forEach((l, i) => {
        console.log(
            `    [${i}] part eid=${l.part.expressID} gid=${l.part.globalId ?? '?'} → parent wall eid=${l.parentWallExpressID}`
        )
    })
    if (ctx.wallAggregatePartLinks.length > 15) {
        console.log(`    … +${ctx.wallAggregatePartLinks.length - 15} more`)
    }

    await loadDetailedGeometry([ctx], archFile, new THREE.Vector3(0, 0, 0), elecFile)

    const dg = ctx.detailedGeometry
    console.log('\n=== After loadDetailedGeometry (mesh counts) ===')
    if (!dg) {
        console.log('  (no detailedGeometry)')
    } else {
        console.log(`  doorMeshes:         ${dg.doorMeshes.length}`)
        console.log(`  wallMeshes (host):  ${dg.wallMeshes.length}`)
        console.log(`  nearbyWallMeshes:   ${dg.nearbyWallMeshes.length}`)
        console.log(`  wallAggregatePartMeshes: ${dg.wallAggregatePartMeshes.length}`)
        console.log(`  nearbyDoorMeshes:   ${dg.nearbyDoorMeshes.length}`)
        console.log(`  nearbyWindowMeshes: ${dg.nearbyWindowMeshes.length}`)
        console.log(`  slabMeshes:         ${dg.slabMeshes.length}`)
        console.log(`  ceilingMeshes:      ${dg.ceilingMeshes.length}`)
        console.log(`  stairMeshes:        ${dg.stairMeshes.length}`)
        console.log(`  deviceMeshes:       ${dg.deviceMeshes.length}`)
    }

    const doorCenter = boxCenter(ctx.door.boundingBox)
    const extra = USER_CONFIG.contextGlobalIds.map((s) => s.trim()).filter(Boolean)

    if (extra.length === 0) {
        console.log('\n(No contextGlobalIds — set USER_CONFIG.contextGlobalIds to compare specific GUIDs.)')
        console.log('Done.')
        return
    }

    console.log('\n=== Your context GlobalIds vs focal door ===')
    for (const gid of extra) {
        const el = findElementByGlobalId(primaryModel, gid)
        if (!el) {
            console.log(`\n  "${gid}" → NOT FOUND in primary model elements`)
            continue
        }
        const elCenter = boxCenter(el.boundingBox)
        const dist = doorCenter && elCenter ? distance3(doorCenter, elCenter) : NaN
        const membership = summarizeContextMembership(ctx, el)
        const meshesLoaded = meshCountForExpressId(ctx, el.expressID)

        console.log(`\n  "${gid}"`)
        console.log(`    expressID:     ${el.expressID}`)
        console.log(`    typeName:      ${el.typeName}`)
        console.log(`    name:          ${el.name ?? '(none)'}`)
        console.log(`    dist centers:  ${Number.isFinite(dist) ? `${dist.toFixed(3)} m` : 'n/a'}`)
        console.log(`    DoorContext:   ${membership}`)
        console.log(`    meshes in ctx: ${meshesLoaded} (userData.expressID match in detailedGeometry sets)`)
        console.log(`    hint:          ${pipelineHint(ctx, el, dist)}`)
    }

    console.log('\nDone.')
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
