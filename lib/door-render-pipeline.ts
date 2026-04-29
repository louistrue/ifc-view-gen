import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import * as THREE from 'three'
import { analyzeDoors, loadDetailedGeometry, type DoorContext } from './door-analyzer'
import {
    extractDoorAnalyzerSidecarMaps,
    extractDoorHostRelationships,
    extractDoorLeafMetadata,
    extractElectricalLayerAssignments,
    extractElementStoreyElevationMap,
    extractElementStoreyMap,
    extractSlabAggregateParts,
    loadIFCModelWithMetadata,
} from './ifc-loader'
import { renderDoorViews, type SVGRenderOptions } from './svg-renderer'

export type DoorView = 'front' | 'back' | 'plan'

// Colour defaults come from `config/render-colors.json` (see DEFAULT_OPTIONS in
// svg-renderer.ts). Do NOT hardcode colour fields here — they would override
// the palette and silently undo Phases 1–5 of the colour-config rollout.
export const DEFAULT_ROUND_RENDER_OPTIONS: SVGRenderOptions = {
    width: 1000,
    height: 1000,
    margin: 0.5,
    lineWidth: 1.5,
    showLegend: false,
    showLabels: false,
    wallRevealSide: 0.12,
    wallRevealTop: 0.04,
}

export interface RenderPipelineInput {
    archIfcPath: string
    elecIfcPath?: string | null
    renderOptions?: SVGRenderOptions
}

export interface RenderedDoor {
    guid: string
    svg: Record<DoorView, string>
    context: DoorContext
}

export interface PipelineResult {
    rendered: Map<string, RenderedDoor>
    notInIfc: string[]
    renderErrors: Map<string, Error>
}

function loadIfcFile(filePath: string): File {
    const buffer = readFileSync(filePath)
    return new File([buffer], basename(filePath), { type: 'application/octet-stream' })
}

/**
 * Load the architecture IFC (plus optional electrical IFC) once, run the full
 * door-analyzer pipeline, and render the requested views for every GUID in
 * `targetGuids`. One IFC open per file — the heavy part is shared across all
 * targets.
 *
 * GUIDs that aren't IfcDoors in the analyzer output land in `result.notInIfc`.
 * Renderer exceptions are captured per GUID in `result.renderErrors` so a
 * single bad door can't abort the whole round.
 */
export async function renderDoorsFromIfc(
    input: RenderPipelineInput,
    targetGuids: Iterable<string>,
    views: readonly DoorView[] = ['front', 'back', 'plan']
): Promise<PipelineResult> {
    const { archIfcPath, elecIfcPath } = input
    const renderOptions = input.renderOptions ?? DEFAULT_ROUND_RENDER_OPTIONS

    const archFile = loadIfcFile(archIfcPath)
    const elecFile = elecIfcPath ? loadIfcFile(elecIfcPath) : undefined

    const model = await loadIFCModelWithMetadata(archFile)
    // Load the electrical IFC as a secondary model so analyzeDoors can harvest
    // nearby-device candidates from it (the AR IFC never contributes devices).
    const secondaryModel = elecFile ? await loadIFCModelWithMetadata(elecFile) : undefined
    const { operationTypeMap, csetStandardCHMap, wallCsetStandardCHMap, wallAggregatePartMap } =
        await extractDoorAnalyzerSidecarMaps(archFile)
    const doorLeafMetadataMap = await extractDoorLeafMetadata(archFile)
    const hostRelationshipMap = await extractDoorHostRelationships(archFile)
    const slabAggregatePartMap = await extractSlabAggregateParts(archFile)
    const deviceLayerMap = elecFile ? await extractElectricalLayerAssignments(elecFile) : new Map<number, string[]>()

    // Storey elevations from arch + elec. Arch entries take precedence —
    // expressIDs are file-local, so the same numeric ID in elec refers to a
    // completely unrelated element. The previous merge overwrote door
    // (arch) elevations with elec elevations whenever IDs collided, which
    // surfaced as the storey ▼ marker pointing at the WRONG storey for
    // some doors (0TwHxk1LH… case: 01OG door with storey-elevation 17.8 m
    // pulled from an elec element).
    const storeyElevationMap = new Map<number, number>()
    if (elecFile) {
        for (const [id, elev] of await extractElementStoreyElevationMap(elecFile)) {
            storeyElevationMap.set(id, elev)
        }
    }
    for (const [id, elev] of await extractElementStoreyElevationMap(archFile)) {
        storeyElevationMap.set(id, elev)
    }

    const contexts = await analyzeDoors(
        model,
        secondaryModel,
        undefined,
        operationTypeMap,
        csetStandardCHMap,
        doorLeafMetadataMap,
        hostRelationshipMap,
        slabAggregatePartMap,
        wallAggregatePartMap,
        storeyElevationMap,
        wallCsetStandardCHMap,
        deviceLayerMap
    )

    // The browser pipeline fills storeyName from the Fragments spatial tree;
    // here we extract it straight from IFCRELCONTAINEDINSPATIALSTRUCTURE so
    // elevations can draw the storey marker just like the web viewer.
    const storeyMap = await extractElementStoreyMap(archFile)
    for (const ctx of contexts) {
        if (!ctx.storeyName) {
            const name = storeyMap.get(ctx.door.expressID)
            if (name) ctx.storeyName = name
        }
        if (ctx.storeyElevation == null) {
            const elevation = storeyElevationMap.get(ctx.door.expressID)
            if (elevation != null) ctx.storeyElevation = elevation
        }
    }

    const requested = [...new Set([...targetGuids].map((g) => g.trim()).filter(Boolean))]
    const contextByGuid = new Map(contexts.map((c) => [c.doorId, c]))

    const notInIfc: string[] = []
    const matched: DoorContext[] = []
    for (const guid of requested) {
        const ctx = contextByGuid.get(guid)
        if (ctx) matched.push(ctx)
        else notInIfc.push(guid)
    }

    if (matched.length > 0) {
        await loadDetailedGeometry(matched, archFile, new THREE.Vector3(0, 0, 0), elecFile)
    }

    const rendered = new Map<string, RenderedDoor>()
    const renderErrors = new Map<string, Error>()
    const viewSet = new Set(views)

    for (const context of matched) {
        try {
            const allViews = await renderDoorViews(context, renderOptions)
            const svg = {} as Record<DoorView, string>
            if (viewSet.has('front')) svg.front = allViews.front
            if (viewSet.has('back')) svg.back = allViews.back
            if (viewSet.has('plan')) svg.plan = allViews.plan
            rendered.set(context.doorId, { guid: context.doorId, svg, context })
        } catch (err) {
            renderErrors.set(context.doorId, err instanceof Error ? err : new Error(String(err)))
        }
    }

    return { rendered, notInIfc, renderErrors }
}
