import * as assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import * as THREE from 'three'
import {
    extractDoorCsetStandardCH,
    extractDoorOperationTypes,
    loadIFCModelWithMetadata,
} from '../lib/ifc-loader'
import { analyzeDoors, loadDetailedGeometry } from '../lib/door-analyzer'
import { renderDoorViews, type SVGRenderOptions } from '../lib/svg-renderer'

type Metrics = {
    pathCount: number
    totalArea: number
}

type DoorReport = {
    doorId: string
    openingDirection: string | null
    typeName: string | null
    front: Metrics
    back: Metrics
    areaRatio: number
    areaDelta: number
    pathDelta: number
    flagged: boolean
}

const DEFAULT_PRIMARY_CANDIDATES = [
    'Flu21_A_AR_51_ARM_0000_A-AR-0000-0001_260402.ifc',
    '01_BIMcollab_Example_ARC.ifc',
]

const DEFAULT_SECONDARY_CANDIDATES = [
    'Flu21_A_EL_51_ELM_0000_A-EL-2300-0001_IFC Elektro.ifc',
]

const DEFAULT_OUTPUT_DIR = resolve(process.cwd(), 'test-output', 'front-back-glass-fill')

function resolveExistingFile(candidates: string[]): string | null {
    for (const candidate of candidates) {
        const absolutePath = resolve(process.cwd(), candidate)
        if (existsSync(absolutePath)) {
            return absolutePath
        }
    }
    return null
}

function parseArgs(argv: string[]) {
    let primaryIfcPath: string | null = null
    let secondaryIfcPath: string | null = null
    let targetDoorId: string | null = null
    let limit = 10
    let outputDir = DEFAULT_OUTPUT_DIR

    for (const arg of argv) {
        if (arg.startsWith('--secondary=')) {
            secondaryIfcPath = resolve(arg.slice('--secondary='.length))
        } else if (arg.startsWith('--door=')) {
            targetDoorId = arg.slice('--door='.length)
        } else if (arg.startsWith('--limit=')) {
            const parsed = Number.parseInt(arg.slice('--limit='.length), 10)
            assert.ok(Number.isFinite(parsed) && parsed > 0, `Invalid --limit value: ${arg}`)
            limit = parsed
        } else if (arg.startsWith('--out-dir=')) {
            outputDir = resolve(arg.slice('--out-dir='.length))
        } else if (!primaryIfcPath) {
            primaryIfcPath = resolve(arg)
        } else if (!secondaryIfcPath) {
            secondaryIfcPath = resolve(arg)
        } else {
            throw new Error(`Unexpected argument: ${arg}`)
        }
    }

    primaryIfcPath ??= resolveExistingFile(DEFAULT_PRIMARY_CANDIDATES)
    secondaryIfcPath ??= secondaryIfcPath ?? resolveExistingFile(DEFAULT_SECONDARY_CANDIDATES)

    assert.ok(primaryIfcPath, 'No IFC file provided and no default IFC fixture found in the repo root')
    return { primaryIfcPath, secondaryIfcPath, targetDoorId, limit, outputDir }
}

function loadIfcFile(filePath: string): File {
    const buffer = readFileSync(filePath)
    return new File([buffer], basename(filePath), { type: 'application/octet-stream' })
}

function getFillGroup(svg: string): string {
    return svg.match(/<g id="fills">([\s\S]*?)<\/g>/)?.[1] ?? ''
}

function getMetricsForFill(svg: string, fill: string): Metrics {
    const fillGroup = getFillGroup(svg)
    const pathTags = fillGroup.match(/<path\b[^>]*>/g) ?? []

    let pathCount = 0
    let totalArea = 0

    for (const tag of pathTags) {
        const fillMatch = tag.match(/\bfill="([^"]+)"/)?.[1]
        if (fillMatch !== fill) continue

        const d = tag.match(/\bd="([^"]+)"/)?.[1]
        if (!d) continue

        const coords = [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number.parseFloat(match[0]))
        if (coords.length < 6 || coords.length % 2 !== 0) continue

        pathCount += 1

        let area = 0
        for (let i = 0; i < coords.length; i += 2) {
            const x1 = coords[i]
            const y1 = coords[i + 1]
            const next = (i + 2) % coords.length
            const x2 = coords[next]
            const y2 = coords[next + 1]
            area += x1 * y2 - x2 * y1
        }
        totalArea += Math.abs(area) / 2
    }

    return { pathCount, totalArea }
}

function createReport(
    doorId: string,
    openingDirection: string | null,
    typeName: string | null,
    front: Metrics,
    back: Metrics
): DoorReport {
    const largerArea = Math.max(front.totalArea, back.totalArea, 1)
    const smallerArea = Math.max(Math.min(front.totalArea, back.totalArea), 1)
    const areaRatio = largerArea / smallerArea
    const areaDelta = Math.abs(front.totalArea - back.totalArea)
    const pathDelta = Math.abs(front.pathCount - back.pathCount)
    const flagged = areaRatio >= 1.2 && areaDelta >= 2500 && pathDelta >= 1

    return {
        doorId,
        openingDirection,
        typeName,
        front,
        back,
        areaRatio,
        areaDelta,
        pathDelta,
        flagged,
    }
}

function writeSvgPair(outputDir: string, prefix: string, front: string, back: string) {
    mkdirSync(outputDir, { recursive: true })
    writeFileSync(resolve(outputDir, `${prefix}-front.svg`), front)
    writeFileSync(resolve(outputDir, `${prefix}-back.svg`), back)
}

async function main() {
    const { primaryIfcPath, secondaryIfcPath, targetDoorId, limit, outputDir } = parseArgs(process.argv.slice(2))
    const primaryFile = loadIfcFile(primaryIfcPath)
    const secondaryFile = secondaryIfcPath ? loadIfcFile(secondaryIfcPath) : undefined

    console.log(`Loading IFC: ${primaryIfcPath}`)
    if (secondaryIfcPath) {
        console.log(`Secondary IFC: ${secondaryIfcPath}`)
    }

    const model = await loadIFCModelWithMetadata(primaryFile)
    const operationTypeMap = await extractDoorOperationTypes(primaryFile)
    const csetStandardCHMap = await extractDoorCsetStandardCH(primaryFile)
    const contexts = await analyzeDoors(model, undefined, undefined, operationTypeMap, csetStandardCHMap)
    await loadDetailedGeometry(contexts, primaryFile, new THREE.Vector3(0, 0, 0), secondaryFile)

    const renderOptions: SVGRenderOptions = {
        width: 1000,
        height: 1000,
        margin: 0.5,
        doorColor: '#111111',
        wallColor: '#5B7DB1',
        deviceColor: '#cc0000',
        lineColor: '#000000',
        lineWidth: 1.5,
        showLegend: true,
        showLabels: true,
        wallRevealSide: 0.12,
        wallRevealTop: 0.04,
    }

    const selectedContexts = targetDoorId
        ? contexts.filter((context) => context.doorId === targetDoorId)
        : contexts

    assert.ok(selectedContexts.length > 0, targetDoorId
        ? `No door found for --door=${targetDoorId}`
        : 'No door contexts available for testing')

    const reports: DoorReport[] = []
    const suspectOutputDir = resolve(outputDir, 'suspects')

    for (const context of selectedContexts) {
        const { front, back } = await renderDoorViews(context, renderOptions)
        const frontMetrics = getMetricsForFill(front, renderOptions.doorColor!)
        const backMetrics = getMetricsForFill(back, renderOptions.doorColor!)
        const report = createReport(
            context.doorId,
            context.openingDirection,
            context.doorTypeName,
            frontMetrics,
            backMetrics
        )

        reports.push(report)

        if (report.flagged) {
            writeSvgPair(suspectOutputDir, context.doorId, front, back)
        }
    }

    reports.sort((a, b) => b.areaRatio - a.areaRatio || b.areaDelta - a.areaDelta)

    mkdirSync(outputDir, { recursive: true })
    writeFileSync(
        resolve(outputDir, 'report.json'),
        `${JSON.stringify({
            primaryIfcPath,
            secondaryIfcPath,
            targetDoorId,
            generatedAt: new Date().toISOString(),
            reports,
        }, null, 2)}\n`
    )

    const topReports = reports.slice(0, limit)
    console.log('')
    console.log('Top front/back fill deltas:')
    for (const report of topReports) {
        console.log(JSON.stringify({
            doorId: report.doorId,
            openingDirection: report.openingDirection,
            typeName: report.typeName,
            frontPathCount: report.front.pathCount,
            backPathCount: report.back.pathCount,
            frontArea: Number(report.front.totalArea.toFixed(2)),
            backArea: Number(report.back.totalArea.toFixed(2)),
            areaRatio: Number(report.areaRatio.toFixed(3)),
            areaDelta: Number(report.areaDelta.toFixed(2)),
            flagged: report.flagged,
        }))
    }

    const flagged = reports.filter((report) => report.flagged)
    console.log('')
    console.log(`Analyzed ${reports.length} door(s)`)
    console.log(`Flagged ${flagged.length} suspect front/back fill mismatches`)
    console.log(`Wrote JSON report to ${resolve(outputDir, 'report.json')}`)
    if (flagged.length > 0) {
        console.log(`Wrote suspect SVG pairs to ${suspectOutputDir}`)
    }
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
