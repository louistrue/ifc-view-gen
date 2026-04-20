import * as assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'
import * as THREE from 'three'
import {
    extractDoorCsetStandardCH,
    extractDoorHostRelationships,
    extractDoorLeafMetadata,
    extractDoorOperationTypes,
    extractSlabAggregateParts,
    loadIFCModelWithMetadata,
} from '../lib/ifc-loader'
import { analyzeDoors, loadDetailedGeometry } from '../lib/door-analyzer'
import { renderDoorViews, type SVGRenderOptions } from '../lib/svg-renderer'

type IssueRecord = {
    number: number
    guid: string
    view: string | null
    title: string
    pdf: string
}

type Manifest = {
    sourceFolder: string
    generatedAt: string
    records: IssueRecord[]
}

type GroupedIssue = {
    guid: string
    records: IssueRecord[]
    viewsRequested: string[]
}

type ExportResult = {
    guid: string
    issueCount: number
    viewsRequested: string[]
    hasContext: boolean
    openingDirection: string | null
    typeName: string | null
    outputDir: string
}

const DEFAULT_PRIMARY = resolve(process.cwd(), 'Flu21_A_AR_51_ARM_0000_A-AR-0000-0001_260402.ifc')
const DEFAULT_SECONDARY = resolve(process.cwd(), 'Flu21_A_EL_51_ELM_0000_A-EL-2300-0001_IFC Elektro.ifc')
const DEFAULT_ISSUE_FOLDER = resolve(process.cwd(), 'ZGSO_2026-04-15,_05.42')
const DEFAULT_MANIFEST = resolve(DEFAULT_ISSUE_FOLDER, 'guid-manifest.json')
const DEFAULT_OUT_DIR = resolve(process.cwd(), 'test-output', 'zgso-guid-review')

function parseArgs(argv: string[]) {
    let primaryIfc = DEFAULT_PRIMARY
    let secondaryIfc: string | null = DEFAULT_SECONDARY
    let issueFolder = DEFAULT_ISSUE_FOLDER
    let manifestPath = DEFAULT_MANIFEST
    let outDir = DEFAULT_OUT_DIR

    for (const arg of argv) {
        if (arg.startsWith('--primary=')) {
            primaryIfc = resolve(arg.slice('--primary='.length))
        } else if (arg.startsWith('--secondary=')) {
            const value = arg.slice('--secondary='.length)
            secondaryIfc = value ? resolve(value) : null
        } else if (arg.startsWith('--issues=')) {
            issueFolder = resolve(arg.slice('--issues='.length))
        } else if (arg.startsWith('--manifest=')) {
            manifestPath = resolve(arg.slice('--manifest='.length))
        } else if (arg.startsWith('--out-dir=')) {
            outDir = resolve(arg.slice('--out-dir='.length))
        } else {
            throw new Error(`Unexpected argument: ${arg}`)
        }
    }

    return { primaryIfc, secondaryIfc, issueFolder, manifestPath, outDir }
}

function loadIfcFile(filePath: string): File {
    const buffer = readFileSync(filePath)
    return new File([buffer], basename(filePath), { type: 'application/octet-stream' })
}

function loadManifest(manifestPath: string): Manifest {
    const raw = readFileSync(manifestPath, 'utf8')
    const parsed = JSON.parse(raw) as Manifest
    assert.ok(Array.isArray(parsed.records), `Invalid manifest records in ${manifestPath}`)
    return parsed
}

function normalizeView(view: string | null): string | null {
    if (!view) return null
    const trimmed = view.trim().toLowerCase()
    if (!trimmed) return null
    if (trimmed === 'front' || trimmed === 'back' || trimmed === 'plan') return trimmed
    return null
}

function groupByGuid(records: IssueRecord[]): GroupedIssue[] {
    const groups = new Map<string, IssueRecord[]>()
    for (const record of records) {
        const list = groups.get(record.guid) ?? []
        list.push(record)
        groups.set(record.guid, list)
    }

    return [...groups.entries()]
        .map(([guid, guidRecords]) => {
            const viewsRequested = [...new Set(
                guidRecords
                    .map((record) => normalizeView(record.view))
                    .filter((view): view is string => Boolean(view))
            )].sort()
            return { guid, records: guidRecords.sort((a, b) => a.number - b.number), viewsRequested }
        })
        .sort((a, b) => a.guid.localeCompare(b.guid))
}

function ensureDir(path: string) {
    mkdirSync(path, { recursive: true })
}

async function main() {
    const { primaryIfc, secondaryIfc, issueFolder, manifestPath, outDir } = parseArgs(process.argv.slice(2))

    assert.ok(existsSync(primaryIfc), `Primary IFC not found: ${primaryIfc}`)
    assert.ok(!secondaryIfc || existsSync(secondaryIfc), `Secondary IFC not found: ${secondaryIfc}`)
    assert.ok(existsSync(issueFolder), `Issue folder not found: ${issueFolder}`)
    assert.ok(existsSync(manifestPath), `Manifest not found: ${manifestPath}`)

    const manifest = loadManifest(manifestPath)
    const groupedIssues = groupByGuid(manifest.records)
    assert.ok(groupedIssues.length > 0, `No GUID records found in ${manifestPath}`)

    console.log(`Loading IFC: ${primaryIfc}`)
    if (secondaryIfc) console.log(`Secondary IFC: ${secondaryIfc}`)
    console.log(`Preparing review package for ${groupedIssues.length} GUID(s)`)

    const primaryFile = loadIfcFile(primaryIfc)
    const secondaryFile = secondaryIfc ? loadIfcFile(secondaryIfc) : undefined

    const model = await loadIFCModelWithMetadata(primaryFile)
    const operationTypeMap = await extractDoorOperationTypes(primaryFile)
    const csetStandardCHMap = await extractDoorCsetStandardCH(primaryFile)
    const doorLeafMetadataMap = await extractDoorLeafMetadata(primaryFile)
    const hostRelationshipMap = await extractDoorHostRelationships(primaryFile)
    const slabAggregatePartMap = await extractSlabAggregateParts(primaryFile)
    const contexts = await analyzeDoors(
        model,
        undefined,
        undefined,
        operationTypeMap,
        csetStandardCHMap,
        doorLeafMetadataMap,
        hostRelationshipMap,
        slabAggregatePartMap
    )

    await loadDetailedGeometry(contexts, primaryFile, new THREE.Vector3(0, 0, 0), secondaryFile)
    const contextByGuid = new Map(contexts.map((context) => [context.doorId, context]))

    const renderOptions: SVGRenderOptions = {
        width: 1000,
        height: 1000,
        margin: 0.5,
        doorColor: '#dedede',
        wallColor: '#e3e3e3',
        deviceColor: '#fcc647',
        lineColor: '#000000',
        lineWidth: 1.5,
        showLegend: true,
        showLabels: true,
        wallRevealSide: 0.12,
        wallRevealTop: 0.04,
    }

    ensureDir(outDir)
    const results: ExportResult[] = []

    for (const group of groupedIssues) {
        const guidDir = resolve(outDir, group.guid)
        const issuePdfDir = resolve(guidDir, 'issue-pdfs')
        const renderDir = resolve(guidDir, 'rendered')
        ensureDir(issuePdfDir)
        ensureDir(renderDir)

        for (const record of group.records) {
            const sourcePdf = resolve(issueFolder, record.pdf)
            if (!existsSync(sourcePdf)) {
                // Surface rather than silently drop: a generated review package
                // must not look complete while issue evidence is actually missing.
                throw new Error(
                    `Issue PDF not found for GUID ${group.guid}, issue ${record.number}: ${sourcePdf}`
                )
            }
            const ext = extname(record.pdf).toLowerCase() || '.pdf'
            const viewSuffix = normalizeView(record.view) ?? 'unknown'
            const destPdf = resolve(issuePdfDir, `${record.number}-${viewSuffix}${ext}`)
            copyFileSync(sourcePdf, destPdf)
        }

        const context = contextByGuid.get(group.guid)
        if (context) {
            const views = await renderDoorViews(context, renderOptions)
            writeFileSync(resolve(renderDir, 'front.svg'), views.front)
            writeFileSync(resolve(renderDir, 'back.svg'), views.back)
            writeFileSync(resolve(renderDir, 'plan.svg'), views.plan)
        }

        const info = {
            guid: group.guid,
            hasContext: Boolean(context),
            openingDirection: context?.openingDirection ?? null,
            typeName: context?.doorTypeName ?? null,
            diagnostics: context?.diagnostics ?? null,
            issueNumbers: group.records.map((record) => record.number),
            viewsRequested: group.viewsRequested,
            issueTitles: group.records.map((record) => ({ number: record.number, title: record.title })),
        }
        writeFileSync(resolve(guidDir, 'info.json'), `${JSON.stringify(info, null, 2)}\n`)

        results.push({
            guid: group.guid,
            issueCount: group.records.length,
            viewsRequested: group.viewsRequested,
            hasContext: Boolean(context),
            openingDirection: context?.openingDirection ?? null,
            typeName: context?.doorTypeName ?? null,
            outputDir: guidDir,
        })
    }

    const summary = {
        generatedAt: new Date().toISOString(),
        primaryIfc,
        secondaryIfc,
        issueFolder,
        manifestPath,
        guidTotal: results.length,
        guidWithIfcContext: results.filter((entry) => entry.hasContext).length,
        guidMissingInIfc: results.filter((entry) => !entry.hasContext).map((entry) => entry.guid),
        results,
    }
    writeFileSync(resolve(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)

    console.log(`Exported review package to: ${outDir}`)
    console.log(`GUIDs with IFC context: ${summary.guidWithIfcContext}/${summary.guidTotal}`)
    if (summary.guidMissingInIfc.length > 0) {
        console.log(`Missing GUIDs in IFC (${summary.guidMissingInIfc.length}): ${summary.guidMissingInIfc.join(', ')}`)
    }
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
