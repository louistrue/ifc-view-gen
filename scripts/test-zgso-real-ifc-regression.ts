import * as assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import * as THREE from 'three'
import {
    extractDoorCsetStandardCH,
    extractDoorHostRelationships,
    extractDoorLeafMetadata,
    extractDoorOperationTypes,
    extractSlabAggregateParts,
    loadIFCModelWithMetadata,
} from '../lib/ifc-loader'
import { analyzeDoors, getDoorOperationInfo, loadDetailedGeometry, type DoorContext } from '../lib/door-analyzer'
import { renderDoorViews, type SVGRenderOptions } from '../lib/svg-renderer'

type FixAction = {
    tag: string
    priority: 'P0' | 'P1' | 'P2' | 'P3'
}

type BacklogItem = {
    guid: string
    issues: number[]
    views: string[]
    tags: string[]
    action_plan: FixAction[]
}

type BacklogFile = {
    items: BacklogItem[]
}

type FillStats = {
    pathCount: number
    rectCount: number
    totalArea: number
    bounds: { minX: number; maxX: number; minY: number; maxY: number } | null
}

type DashedLine = {
    x1: number
    y1: number
    x2: number
    y2: number
    length: number
}

type ViewMetrics = {
    wall: FillStats
    slab: FillStats
    device: FillStats
    door: FillStats
    dashedLines: DashedLine[]
    hasStoreyMarker: boolean
}

type GuidReport = {
    guid: string
    issues: number[]
    tags: string[]
    blockingTags: string[]
    hasContext: boolean
    openingDirection: string | null
    typeName: string | null
    diagnostics: DoorContext['diagnostics']
    blockingFailures: string[]
    manualReviewTags: string[]
    resolution: 'fixed' | 'not reproducible' | 'model-data limitation' | 'needs additional rule'
    viewsRequested: string[]
    renderedViews: string[]
    viewMetrics: Record<string, ViewMetrics>
}

const DEFAULT_PRIMARY = resolve(process.cwd(), 'Flu21_A_AR_51_ARM_0000_A-AR-0000-0001_260402.ifc')
const DEFAULT_SECONDARY = resolve(process.cwd(), 'Flu21_A_EL_51_ELM_0000_A-EL-2300-0001_IFC Elektro.ifc')
const DEFAULT_BACKLOG = resolve(process.cwd(), 'test-output', 'zgso-guid-review', 'full-fix-target-backlog.json')
const DEFAULT_OUTPUT_DIR = resolve(process.cwd(), 'test-output', 'zgso-real-ifc-regression')

function loadIfcFile(filePath: string): File {
    const buffer = readFileSync(filePath)
    return new File([buffer], basename(filePath), { type: 'application/octet-stream' })
}

function parseArgs(argv: string[]) {
    let primaryIfc = DEFAULT_PRIMARY
    let secondaryIfc: string | null = DEFAULT_SECONDARY
    let backlogPath = DEFAULT_BACKLOG
    let outDir = DEFAULT_OUTPUT_DIR

    for (const arg of argv) {
        if (arg.startsWith('--primary=')) {
            primaryIfc = resolve(arg.slice('--primary='.length))
        } else if (arg.startsWith('--secondary=')) {
            const value = arg.slice('--secondary='.length)
            secondaryIfc = value ? resolve(value) : null
        } else if (arg.startsWith('--backlog=')) {
            backlogPath = resolve(arg.slice('--backlog='.length))
        } else if (arg.startsWith('--out-dir=')) {
            outDir = resolve(arg.slice('--out-dir='.length))
        } else {
            throw new Error(`Unexpected argument: ${arg}`)
        }
    }

    return { primaryIfc, secondaryIfc, backlogPath, outDir }
}

function loadBacklog(backlogPath: string): BacklogItem[] {
    const raw = readFileSync(backlogPath, 'utf8')
    const parsed = JSON.parse(raw) as BacklogFile
    assert.ok(Array.isArray(parsed.items), `Invalid backlog file: ${backlogPath}`)
    return parsed.items
}

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

function getFillStats(svg: string, fill: string): FillStats {
    const fillGroup = extractGroupContent(svg, 'fills')
    const pathTags = fillGroup.match(/<path\b[^>]*>/g) ?? []
    const rectTags = fillGroup.match(/<rect\b[^>]*\/?>/g) ?? []

    let totalArea = 0
    let pathCount = 0
    let rectCount = 0
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity

    const includePoint = (x: number, y: number) => {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return
        minX = Math.min(minX, x)
        maxX = Math.max(maxX, x)
        minY = Math.min(minY, y)
        maxY = Math.max(maxY, y)
    }

    for (const tag of pathTags) {
        const fillMatch = tag.match(/\bfill="([^"]+)"/)?.[1]
        const d = tag.match(/\bd="([^"]+)"/)?.[1]
        if (fillMatch !== fill || !d) continue

        const coords = [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number.parseFloat(match[0]))
        if (coords.length < 6 || coords.length % 2 !== 0) continue

        pathCount += 1
        let area = 0
        for (let i = 0; i < coords.length; i += 2) {
            const x1 = coords[i]
            const y1 = coords[i + 1]
            includePoint(x1, y1)
            const next = (i + 2) % coords.length
            const x2 = coords[next]
            const y2 = coords[next + 1]
            area += x1 * y2 - x2 * y1
        }
        totalArea += Math.abs(area) / 2
    }

    for (const tag of rectTags) {
        const fillMatch = tag.match(/\bfill="([^"]+)"/)?.[1]
        const x = Number.parseFloat(tag.match(/\bx="([^"]+)"/)?.[1] ?? 'NaN')
        const y = Number.parseFloat(tag.match(/\by="([^"]+)"/)?.[1] ?? 'NaN')
        const width = Number.parseFloat(tag.match(/\bwidth="([^"]+)"/)?.[1] ?? 'NaN')
        const height = Number.parseFloat(tag.match(/\bheight="([^"]+)"/)?.[1] ?? 'NaN')
        if (fillMatch !== fill || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
            continue
        }

        rectCount += 1
        totalArea += width * height
        includePoint(x, y)
        includePoint(x + width, y + height)
    }

    return {
        pathCount,
        rectCount,
        totalArea,
        bounds: minX === Infinity ? null : { minX, maxX, minY, maxY },
    }
}

function getDashedLines(svg: string): DashedLine[] {
    const edgesGroup = extractGroupContent(svg, 'edges')
    const lineTags = edgesGroup.match(/<line\b[^>]*>/g) ?? []
    const dashed: DashedLine[] = []

    for (const tag of lineTags) {
        const dash = tag.match(/\bstroke-dasharray="([^"]+)"/)?.[1]
        if (dash !== '4,2') continue

        const x1 = Number.parseFloat(tag.match(/\bx1="([^"]+)"/)?.[1] ?? 'NaN')
        const y1 = Number.parseFloat(tag.match(/\by1="([^"]+)"/)?.[1] ?? 'NaN')
        const x2 = Number.parseFloat(tag.match(/\bx2="([^"]+)"/)?.[1] ?? 'NaN')
        const y2 = Number.parseFloat(tag.match(/\by2="([^"]+)"/)?.[1] ?? 'NaN')
        if (![x1, y1, x2, y2].every(Number.isFinite)) continue

        dashed.push({ x1, y1, x2, y2, length: Math.hypot(x2 - x1, y2 - y1) })
    }

    return dashed.sort((a, b) => b.length - a.length)
}

/**
 * Mirrors `placementYAxis · semanticFacing > 0`, matching the renderer's
 * `shouldMirrorSwingForHandedness` check. When true the rendered hinge is
 * flipped relative to the raw IFC hinge side, so any test that compares a
 * dashed guide's screen origin against the "expected" side must apply the
 * same mirror or it will flag correctly rendered doors.
 */
function shouldMirrorExpectedHingeSide(context: DoorContext): boolean {
    const info = getDoorOperationInfo(context.openingDirection)
    if (!info.swingCapable || (info.hingeSide !== 'left' && info.hingeSide !== 'right')) {
        return false
    }
    const placementYAxis = context.door.placementYAxis?.clone().setY(0)
    if (!placementYAxis || placementYAxis.lengthSq() < 1e-8) return false
    placementYAxis.normalize()
    const facing = context.viewFrame.semanticFacing.clone().setY(0)
    if (facing.lengthSq() < 1e-8) return false
    facing.normalize()
    return placementYAxis.dot(facing) > 0
}

function getExpectedSingleHingeSide(context: DoorContext): 'left' | 'right' | null {
    let hingeSide: 'left' | 'right' | null = null
    if (context.operableLeaves?.leaves.length === 1) {
        hingeSide = context.operableLeaves.leaves[0].hingeSide
    } else {
        const info = getDoorOperationInfo(context.openingDirection)
        hingeSide = info.hingeSide === 'left' || info.hingeSide === 'right' ? info.hingeSide : null
    }
    if (!hingeSide) return null
    return shouldMirrorExpectedHingeSide(context)
        ? (hingeSide === 'left' ? 'right' : 'left')
        : hingeSide
}

function evaluateBlockingTag(tag: string, context: DoorContext, viewMetrics: Record<string, ViewMetrics>, viewsRequested: string[]): string[] {
    const failures: string[] = []
    const relevantViews = viewsRequested.length > 0 ? viewsRequested : ['front', 'back', 'plan']
    const getMetrics = (view: string) => viewMetrics[view]

    if (tag === 'missing_walls' || tag === 'missing_cut_walls_perpendicular' || tag === 'context_wrong_general' || tag === 'door_context_wrong_or_missing') {
        const missingViews = relevantViews.filter((view) => {
            const metrics = getMetrics(view)
            return metrics && metrics.wall.totalArea < (view === 'plan' ? 1500 : 2500)
        })
        if (missingViews.length > 0) {
            failures.push(`${tag}: insufficient wall/context fill in ${missingViews.join(', ')}`)
        }
    }

    if (tag === 'opening_line_wrong_direction') {
        const planMetrics = getMetrics('plan')
        const longestDashed = planMetrics?.dashedLines[0]
        if (!longestDashed) {
            failures.push(`${tag}: plan dashed opening guide missing`)
        } else {
            const expectedHinge = getExpectedSingleHingeSide(context)
            if (expectedHinge === 'left' && longestDashed.x1 >= 500) {
                failures.push(`${tag}: expected left hinge origin, got x1=${longestDashed.x1.toFixed(1)}`)
            }
            if (expectedHinge === 'right' && longestDashed.x1 <= 500) {
                failures.push(`${tag}: expected right hinge origin, got x1=${longestDashed.x1.toFixed(1)}`)
            }
        }
    }

    if (tag === 'opening_line_too_big' || tag === 'opening_line_wrong_position_or_size') {
        const planMetrics = getMetrics('plan')
        const longestDashed = planMetrics?.dashedLines[0]
        const doorBounds = planMetrics?.door.bounds
        if (!longestDashed || !doorBounds) {
            failures.push(`${tag}: insufficient plan geometry for dashed-guide sizing`)
        } else {
            const doorWidth = doorBounds.maxX - doorBounds.minX
            if (longestDashed.length > doorWidth * 1.05) {
                failures.push(`${tag}: dashed guide too large (${longestDashed.length.toFixed(1)} > ${doorWidth.toFixed(1)})`)
            }
        }
    }

    if (tag === 'ceiling_missing' || tag === 'floor_structure_missing') {
        const elevationViews = relevantViews.filter((view) => view === 'front' || view === 'back')
        const missingViews = elevationViews.filter((view) => {
            const metrics = getMetrics(view)
            return metrics && metrics.slab.totalArea < 1200
        })
        if (elevationViews.length > 0 && missingViews.length === elevationViews.length) {
            failures.push(`${tag}: slab/ceiling context missing in ${elevationViews.join(', ')}`)
        }
    }

    if (tag === 'electrical_missing_or_wrong') {
        const visibleViews = relevantViews.filter((view) => {
            const metrics = getMetrics(view)
            return metrics && metrics.device.totalArea >= 80
        })
        if (visibleViews.length === 0 && context.nearbyDevices.length > 0) {
            failures.push(`${tag}: no electrical symbol rendered despite nearby devices`)
        }
    }

    return failures
}

function classifyResolution(report: Omit<GuidReport, 'resolution'>): GuidReport['resolution'] {
    const allTags = [...report.tags, ...report.blockingTags, ...report.manualReviewTags]
    const hasTag = (pattern: RegExp) => allTags.some((tag) => pattern.test(tag))

    // Known model-data / non-reproducible cases must short-circuit before the
    // `needs additional rule` fallback, otherwise every context-backed blocking
    // failure gets flagged as a renderer gap even when the backlog already marks
    // it as a model-data limitation.
    if (hasTag(/not[_ -]?reproducible/i)) return 'not reproducible'
    if (hasTag(/model[_ -]?data|ifc[_ -]?data|source[_ -]?model/i)) return 'model-data limitation'
    if (!report.hasContext) return 'model-data limitation'
    if (report.blockingFailures.length === 0 && report.manualReviewTags.length === 0) return 'fixed'
    return 'needs additional rule'
}

function renderMarkdownSummary(reports: GuidReport[]): string {
    const counts = {
        fixed: reports.filter((report) => report.resolution === 'fixed').length,
        notReproducible: reports.filter((report) => report.resolution === 'not reproducible').length,
        modelDataLimitation: reports.filter((report) => report.resolution === 'model-data limitation').length,
        needsAdditionalRule: reports.filter((report) => report.resolution === 'needs additional rule').length,
    }

    const lines = [
        '# ZGSO Real IFC Regression Report',
        '',
        `- GUIDs analyzed: **${reports.length}**`,
        `- Fixed: **${counts.fixed}**`,
        `- Not reproducible: **${counts.notReproducible}**`,
        `- Model-data limitation: **${counts.modelDataLimitation}**`,
        `- Needs additional rule: **${counts.needsAdditionalRule}**`,
        '',
        '## GUID Results',
    ]

    for (const report of reports) {
        const failureText = report.blockingFailures.length > 0
            ? report.blockingFailures.join(' | ')
            : 'none'
        lines.push(`- \`${report.guid}\` | resolution=${report.resolution} | blockingFailures=${failureText}`)
    }

    return `${lines.join('\n')}\n`
}

async function main() {
    const { primaryIfc, secondaryIfc, backlogPath, outDir } = parseArgs(process.argv.slice(2))
    assert.ok(existsSync(primaryIfc), `Primary IFC not found: ${primaryIfc}`)
    assert.ok(!secondaryIfc || existsSync(secondaryIfc), `Secondary IFC not found: ${secondaryIfc}`)
    assert.ok(existsSync(backlogPath), `Backlog file not found: ${backlogPath}`)

    const primaryFile = loadIfcFile(primaryIfc)
    const secondaryFile = secondaryIfc ? loadIfcFile(secondaryIfc) : undefined
    const backlog = loadBacklog(backlogPath)

    console.log(`Loading primary IFC: ${primaryIfc}`)
    if (secondaryIfc) {
        console.log(`Loading secondary IFC: ${secondaryIfc}`)
    }
    console.log(`Running regression against ${backlog.length} GUID backlog items`)

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
        wallColor: '#5B7DB1',
        floorSlabColor: '#6EAF72',
        deviceColor: '#CC7A00',
        lineColor: '#000000',
        lineWidth: 1.5,
        showLegend: true,
        showLabels: true,
    }

    mkdirSync(outDir, { recursive: true })
    const failedSvgDir = resolve(outDir, 'failed-svgs')
    mkdirSync(failedSvgDir, { recursive: true })

    const reports: GuidReport[] = []
    for (const item of backlog) {
        const context = contextByGuid.get(item.guid)
        const blockingTags = item.action_plan
            .filter((entry) => entry.priority === 'P0' || entry.priority === 'P1')
            .map((entry) => entry.tag)
        const manualReviewTags = item.action_plan
            .filter((entry) => entry.priority === 'P2' || entry.priority === 'P3')
            .map((entry) => entry.tag)

        const viewMetrics: Record<string, ViewMetrics> = {}
        const renderedViews: string[] = []
        let blockingFailures: string[] = []

        if (context) {
            const views = await renderDoorViews(context, renderOptions)
            for (const [viewName, svg] of Object.entries(views)) {
                renderedViews.push(viewName)
                viewMetrics[viewName] = {
                    wall: getFillStats(svg, renderOptions.wallColor!),
                    slab: getFillStats(svg, renderOptions.floorSlabColor!),
                    device: getFillStats(svg, renderOptions.deviceColor!),
                    door: getFillStats(svg, renderOptions.doorColor!),
                    dashedLines: getDashedLines(svg),
                    hasStoreyMarker: svg.includes('id="storey-marker"'),
                }
            }

            for (const tag of blockingTags) {
                blockingFailures.push(...evaluateBlockingTag(tag, context, viewMetrics, item.views))
            }

            if (blockingFailures.length > 0) {
                const views = await renderDoorViews(context, renderOptions)
                writeFileSync(resolve(failedSvgDir, `${item.guid}-front.svg`), views.front)
                writeFileSync(resolve(failedSvgDir, `${item.guid}-back.svg`), views.back)
                writeFileSync(resolve(failedSvgDir, `${item.guid}-plan.svg`), views.plan)
            }
        } else if (blockingTags.length > 0) {
            blockingFailures = blockingTags.map((tag) => `${tag}: no IFC door context found for GUID`)
        }

        const reportWithoutResolution = {
            guid: item.guid,
            issues: item.issues,
            tags: item.tags,
            blockingTags,
            hasContext: Boolean(context),
            openingDirection: context?.openingDirection ?? null,
            typeName: context?.doorTypeName ?? null,
            diagnostics: context?.diagnostics,
            blockingFailures,
            manualReviewTags,
            viewsRequested: item.views,
            renderedViews,
            viewMetrics,
        }

        reports.push({
            ...reportWithoutResolution,
            resolution: classifyResolution(reportWithoutResolution),
        })
    }

    reports.sort((a, b) => a.guid.localeCompare(b.guid))
    const summary = {
        generatedAt: new Date().toISOString(),
        primaryIfc,
        secondaryIfc,
        backlogPath,
        guidTotal: reports.length,
        blockingFailures: reports.filter((report) => report.blockingFailures.length > 0).length,
        reports,
    }

    writeFileSync(resolve(outDir, 'report.json'), `${JSON.stringify(summary, null, 2)}\n`)
    writeFileSync(resolve(outDir, 'report.md'), renderMarkdownSummary(reports))

    const rendererFailingReports = reports.filter(
        (report) => report.blockingFailures.length > 0 && report.resolution !== 'model-data limitation'
    )
    const modelDataReports = reports.filter(
        (report) => report.blockingFailures.length > 0 && report.resolution === 'model-data limitation'
    )
    console.log(`Analyzed ${reports.length} GUID(s)`)
    console.log(`Blocking renderer failures: ${rendererFailingReports.length}`)
    console.log(`Model-data limitations with blocking tags: ${modelDataReports.length}`)
    console.log(`Wrote JSON report to ${resolve(outDir, 'report.json')}`)
    console.log(`Wrote Markdown report to ${resolve(outDir, 'report.md')}`)

    if (rendererFailingReports.length > 0) {
        console.log(`Failed SVG snapshots written to ${failedSvgDir}`)
        process.exit(1)
    }
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
