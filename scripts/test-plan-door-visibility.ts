/**
 * Asserts that a generated plan (Grundriss) SVG shows the door fill and host-wall
 * context (surrounding structure), plus a minimum of edge geometry.
 *
 * Optional: schneller synthetischer In-Memory-Test (ohne SVG-Datei), nur wenn
 * kein IFC konfiguriert ist — z. B. für CI ohne lokale .ifc-Dateien.
 *
 * IFC: `USER_PLAN_VISIBILITY_CONFIG` — Arch-IFC, optional Elektro-IFC, `doorGuids`.
 * Ist das gesetzt, läuft **nur** die echte Pipeline; Grundriss-SVGs entsprechen
 * exakt dem angegebenen IFC für jede GUID (Ausgabe unter `test-output/...`).
 *
 * Ausführen (im Projektroot):
 *   npm run test:plan-door-visibility
 * Alternativ:
 *   node scripts/test-plan-door-visibility-runner.js
 *
 * Erzeugte Grundriss-SVGs: nur bei gesetztem IFC → `test-output/plan-door-visibility/<guid>-plan.svg`
 */
import * as assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import * as THREE from 'three'
import { analyzeDoors, loadDetailedGeometry, type DoorContext } from '../lib/door-analyzer'
import type { ElementInfo, LoadedIFCModel } from '../lib/ifc-types'
import {
    extractDoorCsetStandardCH,
    extractDoorOperationTypes,
    loadIFCModelWithMetadata,
} from '../lib/ifc-loader'
import { renderDoorPlanSVG, type SVGRenderOptions } from '../lib/svg-renderer'

const PLAN_SVG_OUTPUT_DIR = resolve(process.cwd(), 'test-output', 'plan-door-visibility')

function sanitizeFilenameSegment(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'door'
}

function savePlanSvgFile(fileName: string, svg: string): string {
    mkdirSync(PLAN_SVG_OUTPUT_DIR, { recursive: true })
    const filePath = resolve(PLAN_SVG_OUTPUT_DIR, fileName)
    writeFileSync(filePath, svg, 'utf8')
    return filePath
}

// ---------------------------------------------------------------------------
// Hier einstellen: Architektur-IFC, optional Elektro-IFC, Tür-GUIDs (Ifc GlobalId).
// Pfade: z. B. `resolve(process.cwd(), 'scripts', 'Datei.ifc')` oder absolut.
//
// Wenn `architectureIfc` und `doorGuids` gesetzt sind → nur IFC-Lauf; es werden
// nur diese Grundrisse als SVG abgelegt (kein synthetisches Szenario, kein synthetic-plan.svg).
// `electricalIfc` optional (nur wenn Pfad nicht null).
//
// Ohne IFC-Konfiguration: optionaler reiner In-Memory-Synthetiktest (keine SVG-Datei),
// siehe `skipSyntheticWhenIfcConfigured` / Ablauf in `main`.
//
// Konkrete Pfade/GUIDs liegen im Objekt unten (nicht als lose Zeilen oberhalb — „Unused label“).
//
// GUID-Quellen: `resolveDoorGuidList` (unten) führt die **aktive** `doorGuids`-Zeile und
// alle Zeilen aus der **aktiven** `doorGuidsFile`-Datei zusammen (Reihenfolge: zuerst
// Array, dann Datei), **ohne Duplikate**. Kurz:
//   — nur erste `doorGuids`-Zeile + `doorGuidsFile: null` → nur Inline-Liste
//   — `doorGuids: []` + Datei-Zeile aktiv → nur Zeilen aus der Datei
//   — beides aktiv → Vereinigung aus Liste + Datei
// Datei: GlobalIds **pro Zeile** und/oder durch Leerzeichen, Komma oder Semikolon getrennt
// (eine lange Zeile geht auch). Viele Türen = langer Lauf.
// Doppelte GlobalId (z. B. zweimal in `doorGuids`) → **ein** SVG (Dedupe).
//
// `strictDoorGuids` (Standard `true`): jede gemergte GUID muss im Arch-IFC eine IfcDoor sein,
// sonst Abbruch. Für große Listen aus der Datei, von denen viele **nicht** im Modell sind:
// `strictDoorGuids: false` → fehlende GUIDs werden nur gewarnt, es werden alle **im IFC
// gefundenen** Türen aus der Liste gerendert.
//
// `useAllIfcDoors: true`: **alle** IfcDoor-Türen aus dem Arch-IFC rendern; `doorGuids` und
// `doorGuidsFile` werden für die Auswahl ignoriert (sinnvoll, wenn die Datei leer/nicht
// gespeichert ist oder die Liste unvollständig).
//
// Je zwei Zeilen: genau **eine** von `doorGuids` und genau **eine** von `doorGuidsFile`
// aktiv lassen; die andere jeweils auskommentieren. Fehlt `doorGuids` im Objekt (beide
// Zeilen auskommentiert), gilt wie `[]` — dann nur GUIDs aus der Datei (wenn vorhanden).
// ---------------------------------------------------------------------------
const USER_PLAN_VISIBILITY_CONFIG = {
    architectureIfc: resolve(process.cwd(), 'scripts', 'Flu21_A_AR_51_ARM_0000_A-AR-0000-0001_260421.ifc'),
    electricalIfc: resolve(process.cwd(), 'scripts', 'Flu21_A_EL_51_ELM_0000_A-EL-2300-0001_IFC Elektro.ifc'),

    // doorGuids: [],
    doorGuids: ['3rHkFkTPPyIhdsnM91YiTi', '1zuJJ43NYeI8ePdVq268DL', '3sP2fkpffiGAfzCmMDRKwJ', '03X27dQWY$GOWvC6E9H2iM', '2AZzgHjcdaHO3Mhd2SAf27', '3rHbqOORWCHPowI54bM3Tw', '3aVa2FUC3MGh_moACqukn5', '3I5ctHuht6Jf1kJas7307o', '17XU7kP97zGxRVilNdTZNE', '2oJ4EKhLSWJQT42l1iRIJ5', '1B_mJRygmNJe994AyR$r0Z', '145bDa1tR7GQdZeomJSxmY', '3P$pruKB0RGfzosAhci2fs', '1dar7_TIC5JA4pf8N1G4mH', '0M_OznmjBSIBte_jOekPs2', '2KzzpHCrHFH8ooxtESAPCp', '1zuJJ43NYeI8ePdVq268DL'],

    // doorGuidsFile: null,
    doorGuidsFile: resolve(process.cwd(), 'scripts', 'guid.json'),
    /**
     * Bei gesetztem Arch-IFC + GUIDs: `true` = synthetischen In-Memory-Test überspringen,
     * nur IFC rendern und SVGs schreiben. `false` = zusätzlich Synthetik testen (weiterhin keine synthetic-.svg).
     */
    skipSyntheticWhenIfcConfigured: true,
    /** `true`: jede GUID muss im Arch-IFC eine Tür sein. `false`: fehlende überspringen (Batch aus guid.json). */
    strictDoorGuids: false,
    /** `true`: alle IfcDoor des Arch-IFC als SVG; ignoriert doorGuids / doorGuidsFile für die Auswahl. */
    useAllIfcDoors: false,
}

type BBox2D = { minX: number; minY: number; maxX: number; maxY: number }

const defaultRenderOptions = (): SVGRenderOptions => ({
    width: 1000,
    height: 1000,
    margin: 0.5,
    doorColor: '#dedede',
    wallColor: '#e3e3e3',
    deviceColor: '#fcc647',
    lineColor: '#000000',
    lineWidth: 1.5,
    showFills: true,
    showLegend: false,
    showLabels: false,
    wallRevealSide: 0.12,
    wallRevealTop: 0.04,
})

function createMesh(expressID: number, geometry: THREE.BufferGeometry): THREE.Mesh {
    geometry.computeBoundingBox()
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
    mesh.userData.expressID = expressID
    return mesh
}

function createBoxMesh(
    expressID: number,
    width: number,
    height: number,
    depth: number,
    center: THREE.Vector3
): THREE.Mesh {
    const geometry = new THREE.BoxGeometry(width, height, depth)
    geometry.translate(center.x, center.y, center.z)
    return createMesh(expressID, geometry)
}

function unionBoundingBox(meshes: THREE.Mesh[]): THREE.Box3 {
    const box = new THREE.Box3()
    for (const mesh of meshes) {
        const meshBox = mesh.geometry.boundingBox?.clone()
        if (!meshBox) {
            throw new Error(`Missing bounding box for mesh ${mesh.userData.expressID}`)
        }
        box.union(meshBox)
    }
    return box
}

function makeElement(expressID: number, typeName: string, meshes: THREE.Mesh[]): ElementInfo {
    return {
        expressID,
        ifcType: -1,
        typeName,
        mesh: meshes[0],
        meshes,
        boundingBox: unionBoundingBox(meshes),
        globalId: `${typeName}-${expressID}`,
    }
}

/** Minimal door-in-wall scene matching the door-host-geometry synthetic layout. */
async function buildSyntheticDoorWallContext(): Promise<DoorContext> {
    const wallThickness = 0.24
    const wallWidth = 4
    const wallHeight = 3
    const doorWidth = 1
    const doorHeight = 2.1
    const doorDepth = 0.08
    const lintelBottom = 2.32
    const frontInset = 0.04
    const openingWidth = 1.2

    const frontFace = -wallThickness / 2
    const doorCenterDepth = frontFace + frontInset + doorDepth / 2

    const doorMesh = createBoxMesh(1, doorWidth, doorHeight, doorDepth, new THREE.Vector3(0, doorHeight / 2, doorCenterDepth))
    const leftJambWidth = (wallWidth - openingWidth) / 2
    const leftJamb = createBoxMesh(2, leftJambWidth, wallHeight, wallThickness, new THREE.Vector3(-(openingWidth / 2 + leftJambWidth / 2), wallHeight / 2, 0))
    const rightJamb = createBoxMesh(2, leftJambWidth, wallHeight, wallThickness, new THREE.Vector3(openingWidth / 2 + leftJambWidth / 2, wallHeight / 2, 0))
    const lintel = createBoxMesh(2, openingWidth, wallHeight - lintelBottom, wallThickness, new THREE.Vector3(0, lintelBottom + (wallHeight - lintelBottom) / 2, 0))
    const wallMeshes = [leftJamb, rightJamb, lintel]

    const door = makeElement(1, 'IFCDOOR', [doorMesh])
    const wall = makeElement(2, 'IFCWALL', wallMeshes)

    const model: LoadedIFCModel = {
        group: new THREE.Group(),
        elements: [door, wall],
        modelID: 0,
        api: null,
    }
    ;(model as LoadedIFCModel & { fragmentsModel: { getItemsData: () => Promise<unknown[]> } }).fragmentsModel = {
        getItemsData: async () => [],
    }

    const [context] = await analyzeDoors(
        model,
        undefined,
        undefined,
        new Map([[door.expressID, 'SINGLE_SWING_LEFT']])
    )
    assert.ok(context, 'Expected analyzeDoors to produce a door context')
    context.detailedGeometry = {
        doorMeshes: [doorMesh],
        wallMeshes,
        nearbyWallMeshes: [],
        slabMeshes: [],
        ceilingMeshes: [],
        nearbyDoorMeshes: [],
        stairMeshes: [],
        deviceMeshes: [],
    }
    return context
}

function parsePointsFromPath(d: string): { x: number; y: number }[] {
    const coords = [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number.parseFloat(match[0]))
    const points: { x: number; y: number }[] = []
    for (let i = 0; i + 1 < coords.length; i += 2) {
        points.push({ x: coords[i], y: coords[i + 1] })
    }
    return points
}

function getPathBBoxesByFill(svg: string, fill: string): BBox2D[] {
    const boxes: BBox2D[] = []
    for (const tag of svg.match(/<path\b[^>]*>/g) || []) {
        const fillValue = tag.match(/\bfill="([^"]+)"/)?.[1]
        const d = tag.match(/\bd="([^"]+)"/)?.[1]
        if (fillValue !== fill || !d) continue
        const points = parsePointsFromPath(d)
        if (points.length === 0) continue
        boxes.push({
            minX: Math.min(...points.map((p) => p.x)),
            minY: Math.min(...points.map((p) => p.y)),
            maxX: Math.max(...points.map((p) => p.x)),
            maxY: Math.max(...points.map((p) => p.y)),
        })
    }
    for (const tag of svg.match(/<rect\b[^>]*>/g) || []) {
        const fillValue = tag.match(/\bfill="([^"]+)"/)?.[1]
        const x = Number.parseFloat(tag.match(/\bx="([^"]+)"/)?.[1] ?? 'NaN')
        const y = Number.parseFloat(tag.match(/\by="([^"]+)"/)?.[1] ?? 'NaN')
        const width = Number.parseFloat(tag.match(/\bwidth="([^"]+)"/)?.[1] ?? 'NaN')
        const height = Number.parseFloat(tag.match(/\bheight="([^"]+)"/)?.[1] ?? 'NaN')
        if (fillValue !== fill || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
            continue
        }
        boxes.push({ minX: x, minY: y, maxX: x + width, maxY: y + height })
    }
    return boxes
}

function combineBoxes(boxes: BBox2D[]): BBox2D {
    assert.ok(boxes.length > 0, 'Expected at least one bounding box from plan SVG fills')
    return {
        minX: Math.min(...boxes.map((b) => b.minX)),
        minY: Math.min(...boxes.map((b) => b.minY)),
        maxX: Math.max(...boxes.map((b) => b.maxX)),
        maxY: Math.max(...boxes.map((b) => b.maxY)),
    }
}

function bboxArea(b: BBox2D): number {
    return Math.max(0, b.maxX - b.minX) * Math.max(0, b.maxY - b.minY)
}

function overlapsVertically(a: BBox2D, b: BBox2D, eps = 0): boolean {
    return Math.min(a.maxY, b.maxY) > Math.max(a.minY, b.minY) - eps
}

function overlapsHorizontally(a: BBox2D, b: BBox2D, eps = 0): boolean {
    return Math.min(a.maxX, b.maxX) > Math.max(a.minX, b.minX) - eps
}

/** Content of `<g id="...">` balancing nested groups (same idea as test-zgso-real-ifc-regression). */
function extractGroupContent(svg: string, groupId: string): string {
    const startTag = `<g id="${groupId}">`
    const startIndex = svg.indexOf(startTag)
    if (startIndex === -1) return ''

    let depth = 1
    let cursor = startIndex + startTag.length
    const contentStart = cursor

    while (cursor < svg.length) {
        const nextOpen = svg.indexOf('<g', cursor)
        const nextClose = svg.indexOf('</g>', cursor)
        if (nextClose === -1) break

        if (nextOpen !== -1 && nextOpen < nextClose) {
            depth += 1
            cursor = nextOpen + 2
            continue
        }

        depth -= 1
        if (depth === 0) {
            return svg.slice(contentStart, nextClose)
        }
        cursor = nextClose + 4
    }

    return ''
}

function countPlanEdgeLines(planSvg: string): number {
    const edges = extractGroupContent(planSvg, 'edges')
    return (edges.match(/<line\b/g) || []).length
}

type Thresholds = {
    minDoorArea: number
    minWallArea: number
    minEdgeLines: number
    /** Plan-px: zählt Kantenberührung als Überlappung (IFC: Türblatt an Pfosten). */
    overlapEps?: number
    /**
     * IFC mesh-only plans: no synthetic wall rectangles — if there is no wall-colored
     * fill, or fills do not overlap the door, still pass when #edges has enough lines.
     */
    meshOnlyPlan?: boolean
}

const defaultThresholds: Thresholds = {
    minDoorArea: 400,
    minWallArea: 2500,
    minEdgeLines: 6,
}

/**
 * Validates plan SVG: door and wall fills present, overlapping viewport band,
 * and enough stroke geometry for context.
 */
function assertPlanShowsDoorAndSurroundings(
    planSvg: string,
    doorColor: string,
    wallColor: string,
    label: string,
    thresholds: Thresholds = defaultThresholds
): void {
    assert.ok(planSvg.includes('<svg'), `${label}: expected SVG root`)
    const doorBoxes = getPathBBoxesByFill(planSvg, doorColor)
    const wallBoxes = getPathBBoxesByFill(planSvg, wallColor)
    const edgeLines = countPlanEdgeLines(planSvg)
    const meshOnly = thresholds.meshOnlyPlan === true
    const edgeFallbackMin = Math.max(thresholds.minEdgeLines, 12)

    assert.ok(doorBoxes.length > 0, `${label}: expected at least one door fill path/rect`)

    const doorBox = combineBoxes(doorBoxes)
    const doorArea = bboxArea(doorBox)

    assert.ok(
        doorArea >= thresholds.minDoorArea,
        `${label}: door fill area too small (${doorArea.toFixed(0)} < ${thresholds.minDoorArea})`
    )

    if (meshOnly && wallBoxes.length === 0) {
        assert.ok(
            edgeLines >= edgeFallbackMin,
            `${label}: mesh-only plan has no wall-colored fills; expected at least ${edgeFallbackMin} <line> in #edges, got ${edgeLines}`
        )
        return
    }

    assert.ok(wallBoxes.length > 0, `${label}: expected at least one wall fill path/rect`)

    const wallBox = combineBoxes(wallBoxes)
    const wallArea = bboxArea(wallBox)

    // Mesh-only: manchmal nur ein Haar-/Naht-Polygon in Wandfarbe (Fläche ≪ minWallArea), trotzdem
    // brauchbarer Grundriss über #edges — leichtere Kantenschwelle als bei komplett fehlender Wandfüllung.
    if (meshOnly && wallArea < thresholds.minWallArea) {
        const thinWallEdgeMin = Math.max(thresholds.minEdgeLines, 8)
        assert.ok(
            edgeLines >= thinWallEdgeMin,
            `${label}: mesh-only plan wall fill area too small (${wallArea.toFixed(0)} < ${thresholds.minWallArea}); `
                + `expected at least ${thinWallEdgeMin} <line> in #edges, got ${edgeLines}`
        )
        return
    }

    assert.ok(
        wallArea >= thresholds.minWallArea,
        `${label}: wall fill area too small (${wallArea.toFixed(0)} < ${thresholds.minWallArea})`
    )
    const eps = thresholds.overlapEps ?? 0
    const overlapOk =
        overlapsVertically(doorBox, wallBox, eps) && overlapsHorizontally(doorBox, wallBox, eps)
    if (!overlapOk && meshOnly) {
        assert.ok(
            edgeLines >= edgeFallbackMin,
            `${label}: door/wall fills do not overlap (mesh-only); expected at least ${edgeFallbackMin} <line> in #edges, got ${edgeLines} (door ${JSON.stringify(doorBox)}, wall ${JSON.stringify(wallBox)})`
        )
    } else {
        assert.ok(
            overlapOk,
            `${label}: door fill should overlap wall fill in plan (door ${JSON.stringify(doorBox)}, wall ${JSON.stringify(wallBox)})`
        )
    }

    assert.ok(
        edgeLines >= thresholds.minEdgeLines,
        `${label}: expected at least ${thresholds.minEdgeLines} <line> elements in #edges, got ${edgeLines}`
    )
}

function maybePrintHelp(argv: string[]): void {
    if (!argv.includes('--help') && !argv.includes('-h')) return
    console.log(`Plan door visibility test

  npm run test:plan-door-visibility

IFC-Pfade und Tür-GUIDs: USER_PLAN_VISIBILITY_CONFIG in dieser Datei.
Optional doorGuidsFile: Zeilen mit IfcDoor GlobalId (z. B. scripts/guid.json), mit doorGuids zusammengeführt.
strictDoorGuids: false = fehlende GUIDs überspringen, alle im IFC gefundenen Türen rendern.
useAllIfcDoors: true = alle IfcDoor des Arch-IFC rendern (ohne GUID-Liste).
Mit Arch-IFC + GUIDs: nur echte Grundriss-SVGs → test-output/plan-door-visibility/
Ohne IFC: nur kurzer In-Memory-Synthetiktest (keine SVG-Datei).`)
    process.exit(0)
}

function loadIfcFile(filePath: string): File {
    const buffer = readFileSync(filePath)
    return new File([buffer], basename(filePath), { type: 'application/octet-stream' })
}

function resolveConfigPath(p: string | null): string | null {
    if (p == null || p.trim() === '') return null
    return resolve(p)
}

/** GUIDs aus einer Textdatei: eine pro Zeile und/oder durch Leerzeichen, Komma oder Semikolon getrennt. */
function parseGuidTokensFromFileText(text: string): string[] {
    return text
        .split(/[\r\n,;\s]+/)
        .map((t) => t.trim())
        .filter(Boolean)
}

/** Merge inline `doorGuids` with optional newline-separated file (dedupe, order: array first). */
function resolveDoorGuidList(
    doorGuids: string[] | undefined,
    doorGuidsFile: string | null | undefined
): string[] {
    const fromArray = (doorGuids ?? []).map((g) => g.trim()).filter(Boolean)
    const filePath = resolveConfigPath(doorGuidsFile ?? null)
    let fromFile: string[] = []
    if (filePath && existsSync(filePath)) {
        try {
            const st = statSync(filePath)
            if (st.size === 0) {
                console.warn(
                    `[plan-door-visibility] doorGuidsFile ist 0 Bytes — auf Festplatte speichern oder Pfad prüfen: ${filePath}`
                )
            }
        } catch {
            /* ignore stat errors; readFileSync will throw if unreadable */
        }
        const text = readFileSync(filePath, 'utf8')
        fromFile = parseGuidTokensFromFileText(text)
    }
    const seen = new Set<string>()
    const out: string[] = []
    for (const g of [...fromArray, ...fromFile]) {
        if (seen.has(g)) continue
        seen.add(g)
        out.push(g)
    }

    const filePathForLog = resolveConfigPath(doorGuidsFile ?? null)
    if (doorGuidsFile != null && String(doorGuidsFile).trim() !== '') {
        if (!filePathForLog || !existsSync(filePathForLog)) {
            console.warn(
                `[plan-door-visibility] doorGuidsFile nicht lesbar oder fehlt: ${filePathForLog ?? doorGuidsFile}`
            )
        } else if (fromFile.length === 0) {
            console.warn(
                `[plan-door-visibility] doorGuidsFile ohne GUID-Zeilen (leer oder nur Leerzeilen): ${filePathForLog}`
            )
        }
    }
    console.log(
        `[plan-door-visibility] GUIDs nach Merge/Dedupe: ${out.length} (Array-Einträge: ${fromArray.length}, Datei-Zeilen: ${fromFile.length})`
    )

    return out
}

/** Explains why requested door GUIDs are missing (wrong IFC, typo, or non-door entity). */
function describeMissingDoorGuids(
    missing: string[],
    primaryModel: LoadedIFCModel,
    contexts: DoorContext[]
): string {
    const globalIdsOnElements = new Set(
        primaryModel.elements.map((e) => e.globalId).filter((g): g is string => Boolean(g))
    )
    const doorIds = new Set(contexts.map((c) => c.doorId))
    const parts = missing.map((g) => {
        if (!globalIdsOnElements.has(g)) {
            const tail = g.length >= 8 ? g.slice(-8) : g
            const similar = contexts
                .map((c) => c.doorId)
                .filter((id) => id !== g && id.endsWith(tail))
                .slice(0, 3)
            const hint = similar.length > 0 ? ` Did you mean one of: ${similar.join(', ')}?` : ''
            return `${g} (GlobalId not on any loaded element in this architecture IFC.${hint})`
        }
        if (!doorIds.has(g)) {
            return `${g} (element exists but is not an IfcDoor in the analyzer — wrong type or filtered out.)`
        }
        return g
    })
    return parts.join(' ')
}

async function runSyntheticCase(): Promise<void> {
    const options = defaultRenderOptions()
    const context = await buildSyntheticDoorWallContext()
    const planSvg = await renderDoorPlanSVG(context, options)
    assertPlanShowsDoorAndSurroundings(planSvg, options.doorColor!, options.wallColor!, 'synthetic door+wall')
    console.log('Synthetic plan door visibility: OK (in-memory only, no SVG file)')
}

async function runIfcCasesForGuids(
    architectureIfcPath: string,
    electricalIfcPath: string | null,
    guids: string[],
    opts?: { strictMissingGuids?: boolean; useAllIfcDoors?: boolean }
): Promise<void> {
    const strictMissingGuids = opts?.strictMissingGuids !== false
    const useAllIfcDoors = opts?.useAllIfcDoors === true
    assert.ok(
        guids.length > 0 || useAllIfcDoors,
        'Expected at least one door GUID, or useAllIfcDoors: true'
    )
    assert.ok(existsSync(architectureIfcPath), `Architecture IFC not found: ${architectureIfcPath}`)
    if (electricalIfcPath) {
        assert.ok(existsSync(electricalIfcPath), `Electrical IFC not found: ${electricalIfcPath}`)
    }

    const archFile = loadIfcFile(architectureIfcPath)
    const elecFile = electricalIfcPath ? loadIfcFile(electricalIfcPath) : undefined

    const primaryModel = await loadIFCModelWithMetadata(archFile)
    const secondaryModel = elecFile ? await loadIFCModelWithMetadata(elecFile) : undefined

    const operationTypeMap = await extractDoorOperationTypes(archFile)
    const csetStandardCHMap = await extractDoorCsetStandardCH(archFile)
    const contexts = await analyzeDoors(
        primaryModel,
        secondaryModel,
        undefined,
        operationTypeMap,
        csetStandardCHMap
    )

    const normalizedGuids = useAllIfcDoors
        ? contexts.map((c) => c.doorId)
        : guids.map((g) => g.trim()).filter(Boolean)

    if (useAllIfcDoors) {
        console.log(
            `[plan-door-visibility] useAllIfcDoors: ${normalizedGuids.length} IfcDoor(s) im Arch-IFC — Auswahl aus doorGuids/Datei wird ignoriert.`
        )
    } else {
        console.log(
            `[plan-door-visibility] Anfrage: ${normalizedGuids.length} GUID(s), IfcDoor-Kontexte im Modell: ${contexts.length}.`
        )
    }

    const missing = useAllIfcDoors
        ? []
        : normalizedGuids.filter((g) => !contexts.some((c) => c.doorId === g))

    let targetGuids: string[]
    if (strictMissingGuids) {
        assert.ok(
            missing.length === 0,
            `No door context for GUID(s): ${missing.join(', ')}. Total doors in model: ${contexts.length}. `
                + describeMissingDoorGuids(missing, primaryModel, contexts)
        )
        targetGuids = normalizedGuids
    } else {
        if (missing.length > 0) {
            const head = missing.slice(0, 8).join(', ')
            const tail = missing.length > 8 ? ` … (+${missing.length - 8} weitere)` : ''
            console.warn(
                `[plan-door-visibility] ${missing.length} GUID(s) ohne IfcDoor-Kontext in diesem Arch-IFC — übersprungen.`
                    + ` Erste: ${head}${tail}`
            )
        }
        targetGuids = normalizedGuids.filter((g) => contexts.some((c) => c.doorId === g))
        assert.ok(
            targetGuids.length > 0,
            'Keine der angefragten GUIDs ist eine IfcDoor in diesem Arch-IFC (nach Filter). '
                + (missing.length > 0
                    ? describeMissingDoorGuids(missing.slice(0, 5), primaryModel, contexts)
                    : '')
        )
    }

    const selected = targetGuids
        .map((g) => contexts.find((c) => c.doorId === g)!)
        .filter(Boolean)

    console.log(`[plan-door-visibility] Rendere ${selected.length} Grundriss-SVG(s).`)

    await loadDetailedGeometry(selected, archFile, new THREE.Vector3(0, 0, 0), elecFile)

    const options = defaultRenderOptions()
    // IFC-Grundriss: Türblatt ist in der Projektion oft ein sehr schmales Rechteck
    // (Dicke << Breite); die Bounding Box aller #dedede-Füllungen bleibt klein (~15 px²
    // gemessen), während Wand und Kanten groß sind — minDoorArea daher niedriger als
    // für den synthetischen Block. Zusätzlich kann die sichtbare Wandfüll-BBox bei
    // engerem Ausschnitt klein bleiben (~600 px²), obwohl Überlappung und Kanten ok sind.
    // overlapEps: Tür- und Wandfüll-BBox können sich nur berühren (gemeinsame Kante), nicht
    // strikt überlappen — das würde sonst fälschlich scheitern.
    const relaxed: Thresholds = {
        minDoorArea: 10,
        minWallArea: 500,
        minEdgeLines: 4,
        overlapEps: 2,
        meshOnlyPlan: true,
    }

    for (const context of selected) {
        const planSvg = await renderDoorPlanSVG(context, options)
        const safeId = sanitizeFilenameSegment(context.doorId)
        const written = savePlanSvgFile(`${safeId}-plan.svg`, planSvg)
        assertPlanShowsDoorAndSurroundings(
            planSvg,
            options.doorColor!,
            options.wallColor!,
            `IFC guid=${context.doorId}`,
            relaxed
        )
        console.log(`IFC plan door visibility (${context.doorId}): OK (SVG: ${written})`)
    }
}

async function main(): Promise<void> {
    maybePrintHelp(process.argv.slice(2))

    const archPath = resolveConfigPath(USER_PLAN_VISIBILITY_CONFIG.architectureIfc)
    const elecPath = resolveConfigPath(USER_PLAN_VISIBILITY_CONFIG.electricalIfc)
    const guidList = resolveDoorGuidList(
        USER_PLAN_VISIBILITY_CONFIG.doorGuids,
        USER_PLAN_VISIBILITY_CONFIG.doorGuidsFile
    )

    const useAllIfcDoors = USER_PLAN_VISIBILITY_CONFIG.useAllIfcDoors === true
    const hasArch = Boolean(archPath)
    const hasGuids = guidList.length > 0 || useAllIfcDoors
    const ifcConfigured = hasArch && hasGuids
    const skipSynthetic =
        ifcConfigured && USER_PLAN_VISIBILITY_CONFIG.skipSyntheticWhenIfcConfigured !== false

    if (!skipSynthetic) {
        await runSyntheticCase()
    }

    const hasElecOnly = Boolean(elecPath) && !hasArch && guidList.length === 0 && !useAllIfcDoors
    if (hasElecOnly) {
        throw new Error(
            'USER_PLAN_VISIBILITY_CONFIG: `electricalIfc` ist gesetzt, aber ohne Arch-IFC und '
                + '`doorGuids` wird Elektro nicht genutzt. Bitte `architectureIfc` und `doorGuids` ergänzen.'
        )
    }
    if (hasArch !== hasGuids) {
        throw new Error(
            'USER_PLAN_VISIBILITY_CONFIG: für IFC-Tests bitte beides setzen — '
                + '`architectureIfc` (Pfad zum Arch-IFC) und mindestens eine GUID in `doorGuids` '
                + 'und/oder Zeilen in `doorGuidsFile`, oder `useAllIfcDoors: true`. '
                + 'Oder beides leer lassen (nur synthetischer Test). '
                + `Aktuell: architectureIfc=${hasArch ? 'gesetzt' : 'leer'}, merged GUIDs=${guidList.length}, useAllIfcDoors=${useAllIfcDoors}`
        )
    }

    if (archPath && (guidList.length > 0 || useAllIfcDoors)) {
        const strictMissing =
            USER_PLAN_VISIBILITY_CONFIG.strictDoorGuids !== false
        await runIfcCasesForGuids(archPath, elecPath, guidList, {
            strictMissingGuids: strictMissing,
            useAllIfcDoors,
        })
    }

    console.log('Plan door visibility test passed.')
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
