import * as assert from 'node:assert/strict'
import * as THREE from 'three'
import { analyzeDoors } from '../lib/door-analyzer'
import type { DoorCsetStandardCHData, DoorLeafMetadata } from '../lib/ifc-loader'
import type { ElementInfo, LoadedIFCModel } from '../lib/ifc-types'
import { renderDoorPlanSVG, type SVGRenderOptions } from '../lib/svg-renderer'

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

function bboxFromMesh(mesh: THREE.Mesh): THREE.Box3 {
    const bbox = mesh.geometry.boundingBox?.clone()
    if (!bbox) {
        throw new Error(`Missing bounding box for mesh ${mesh.userData.expressID}`)
    }
    return bbox
}

function makeElement(expressID: number, typeName: string, mesh: THREE.Mesh): ElementInfo {
    return {
        expressID,
        ifcType: -1,
        typeName,
        mesh,
        meshes: [mesh],
        boundingBox: bboxFromMesh(mesh),
        globalId: `${typeName}-${expressID}`,
    }
}

function emptyCset(overrides: Partial<DoorCsetStandardCHData> = {}): DoorCsetStandardCHData {
    return {
        alTuernummer: null,
        geometryType: null,
        massDurchgangsbreite: null,
        massDurchgangshoehe: null,
        massRohbreite: null,
        massRohhoehe: null,
        massAussenrahmenBreite: null,
        massAussenrahmenHoehe: null,
        symbolFluchtweg: null,
        gebaeude: null,
        feuerwiderstand: null,
        bauschalldaemmmass: null,
        ...overrides,
    }
}

async function buildDoorContext(options: {
    openingDirection: string
    cset?: Partial<DoorCsetStandardCHData>
    leafMetadata?: DoorLeafMetadata
}): Promise<ReturnType<typeof analyzeDoors> extends Promise<(infer T)[]> ? T : never> {
    const doorMesh = createBoxMesh(1, 2.5, 2.5, 0.12, new THREE.Vector3(0, 1.25, 0))
    const wallMesh = createBoxMesh(2, 4, 3, 0.24, new THREE.Vector3(0, 1.5, 0))

    const door = makeElement(1, 'IFCDOOR', doorMesh)
    const wall = makeElement(2, 'IFCWALL', wallMesh)

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
        new Map([[door.expressID, options.openingDirection]]),
        new Map([[door.expressID, emptyCset(options.cset)]]),
        options.leafMetadata ? new Map([[door.expressID, options.leafMetadata]]) : undefined
    )

    assert.ok(context, 'Expected a door context')
    return context
}

function readDoorRectWidth(svg: string, fill: string): number {
    const match = svg.match(new RegExp(`<rect x="[^"]+" y="[^"]+" width="([^"]+)" height="[^"]+"\\s+fill="${fill}"`, 'm'))
    assert.ok(match?.[1], 'Expected to find rendered door rect')
    return Number.parseFloat(match[1])
}

function getLongestDashedGuide(svg: string): { x1: number; y1: number; x2: number; y2: number } | null {
    const lineMatches = svg.match(/<line\b[^>]*>/g) || []
    let bestLine: { x1: number; y1: number; x2: number; y2: number } | null = null
    let bestLength = -Infinity

    for (const lineTag of lineMatches) {
        const dash = lineTag.match(/\bstroke-dasharray="([^"]+)"/)?.[1]
        if (dash !== '4,2') continue

        const x1 = Number.parseFloat(lineTag.match(/\bx1="([^"]+)"/)?.[1] || 'NaN')
        const y1 = Number.parseFloat(lineTag.match(/\by1="([^"]+)"/)?.[1] || 'NaN')
        const x2 = Number.parseFloat(lineTag.match(/\bx2="([^"]+)"/)?.[1] || 'NaN')
        const y2 = Number.parseFloat(lineTag.match(/\by2="([^"]+)"/)?.[1] || 'NaN')
        const length = Math.hypot(x2 - x1, y2 - y1)
        if (Number.isFinite(length) && length > bestLength) {
            bestLength = length
            bestLine = { x1, y1, x2, y2 }
        }
    }

    return bestLine
}

function lineLength(line: { x1: number; y1: number; x2: number; y2: number }): number {
    return Math.hypot(line.x2 - line.x1, line.y2 - line.y1)
}

async function main() {
    const fixedLeafContext = await buildDoorContext({
        openingDirection: 'SWING_FIXED_LEFT',
        cset: {
            massDurchgangsbreite: 1.25,
            massAussenrahmenBreite: 2.5,
        },
        leafMetadata: {
            overallWidth: 2.5,
            overallHeight: 2.5,
            quantityWidth: 2.5,
            quantityHeight: 2.5,
            panels: [
                { operation: 'SWINGING', widthRatio: 1, position: 'MIDDLE' },
            ],
        },
    })

    assert.ok(fixedLeafContext.operableLeaves, 'Expected operable leaf metadata for swing-fixed door')
    assert.equal(fixedLeafContext.operableLeaves.isOperable, true)
    assert.equal(fixedLeafContext.operableLeaves.source, 'cset-clear-width')
    assert.equal(fixedLeafContext.operableLeaves.leaves.length, 1)
    assert.equal(fixedLeafContext.operableLeaves.leaves[0].hingeSide, 'left')
    assert.ok(Math.abs(fixedLeafContext.operableLeaves.leaves[0].width - 1.25) < 1e-6)

    const renderOptions: SVGRenderOptions = {
        width: 1000,
        height: 1000,
        margin: 0.5,
        showLegend: false,
        showLabels: false,
        showFills: true,
        doorColor: '#111111',
        wallColor: '#777777',
        lineColor: '#000000',
    }
    const fallbackPlan = await renderDoorPlanSVG(fixedLeafContext, renderOptions)
    const rectWidth = readDoorRectWidth(fallbackPlan, renderOptions.doorColor!)
    const fallbackGuide = getLongestDashedGuide(fallbackPlan)
    assert.ok(fallbackGuide, 'Expected fallback renderer to include a dashed opening guide')
    const fallbackGuideLength = lineLength(fallbackGuide)
    assert.ok(Math.abs(fallbackGuideLength - rectWidth / 2) < 1.5, `Expected fallback guide length ${fallbackGuideLength.toFixed(2)} to be half the door width ${rectWidth.toFixed(2)}`)

    const nonOperableFixedContext = await buildDoorContext({
        openingDirection: 'SWING_FIXED_LEFT',
        cset: {
            massAussenrahmenBreite: 2.5,
        },
    })

    assert.equal(nonOperableFixedContext.operableLeaves.isOperable, false)
    assert.equal(nonOperableFixedContext.operableLeaves.leaves.length, 0)
    const nonOperableFixedPlan = await renderDoorPlanSVG(nonOperableFixedContext, renderOptions)
    assert.equal(getLongestDashedGuide(nonOperableFixedPlan), null, 'Fixed-labeled door without operable semantics should not render dashed guides')

    const normalSingleSwingContext = await buildDoorContext({
        openingDirection: 'SINGLE_SWING_RIGHT',
        cset: {
            massAussenrahmenBreite: 2.5,
        },
    })

    assert.equal(normalSingleSwingContext.operableLeaves.isOperable, true)
    assert.equal(normalSingleSwingContext.operableLeaves.source, 'operation-type-default')
    assert.equal(normalSingleSwingContext.operableLeaves.leaves.length, 1)
    assert.ok(Math.abs(normalSingleSwingContext.operableLeaves.leaves[0].width - 2.5) < 1e-6)
    const normalSingleSwingPlan = await renderDoorPlanSVG(normalSingleSwingContext, renderOptions)
    const normalSingleSwingGuide = getLongestDashedGuide(normalSingleSwingPlan)
    assert.ok(normalSingleSwingGuide, 'Normal single-swing door should still render a dashed guide')
    assert.ok(normalSingleSwingGuide.x1 > renderOptions.width! / 2, 'Single-swing-right guide should originate from the right hinge side')

    const asymmetricDoubleContext = await buildDoorContext({
        openingDirection: 'DOUBLE_DOOR_SINGLE_SWING',
        leafMetadata: {
            overallWidth: 2.22,
            overallHeight: 2.15,
            quantityWidth: 2.22,
            quantityHeight: 2.15,
            panels: [
                { operation: 'SWINGING', widthRatio: 0.405940594059406, position: 'LEFT' },
                { operation: 'SWINGING', widthRatio: 0.594059405940594, position: 'RIGHT' },
            ],
        },
    })

    assert.ok(asymmetricDoubleContext.operableLeaves, 'Expected operable leaves for asymmetric double door')
    assert.equal(asymmetricDoubleContext.operableLeaves.isOperable, true)
    assert.equal(asymmetricDoubleContext.operableLeaves.source, 'ifc-panels')
    assert.equal(asymmetricDoubleContext.operableLeaves.leaves.length, 2)
    assert.ok(Math.abs(asymmetricDoubleContext.operableLeaves.leaves[0].width - 0.9011881188118814) < 1e-6)
    assert.ok(Math.abs(asymmetricDoubleContext.operableLeaves.leaves[1].width - 1.3188118811881187) < 1e-6)

    const conservativeSingleSwingFallback = await buildDoorContext({
        openingDirection: 'SINGLE_SWING_LEFT',
        cset: {
            massDurchgangsbreite: 1.2,
            massAussenrahmenBreite: 2.0,
        },
    })

    assert.ok(conservativeSingleSwingFallback.operableLeaves, 'Expected conservative clear-width fallback for large single-swing width delta')
    assert.equal(conservativeSingleSwingFallback.operableLeaves.source, 'fallback-single-swing-clear-width')
    assert.equal(conservativeSingleSwingFallback.operableLeaves.leaves.length, 1)
    assert.ok(Math.abs(conservativeSingleSwingFallback.operableLeaves.leaves[0].width - 1.2) < 1e-6)

    const meshParityContext = await buildDoorContext({
        openingDirection: 'SWING_FIXED_LEFT',
        cset: {
            massDurchgangsbreite: 1.25,
            massAussenrahmenBreite: 2.5,
        },
    })
    meshParityContext.detailedGeometry = {
        doorMeshes: [createBoxMesh(1, 2.5, 2.5, 0.12, new THREE.Vector3(0, 1.25, 0))],
        wallMeshes: [],
        deviceMeshes: [],
    }
    const meshPlan = await renderDoorPlanSVG(meshParityContext, renderOptions)
    const bboxGuide = getLongestDashedGuide(fallbackPlan)
    const meshGuide = getLongestDashedGuide(meshPlan)
    assert.ok(bboxGuide, 'Bounding-box fallback should render a dashed guide')
    assert.ok(meshGuide, 'Mesh renderer should render a dashed guide')
    assert.ok(bboxGuide.x1 < renderOptions.width! / 2, 'Bounding-box fallback should keep the hinge on the left side')
    assert.ok(meshGuide.x1 < renderOptions.width! / 2, 'Mesh renderer should keep the hinge on the left side')
    const bboxGuideLength = lineLength(bboxGuide)
    const meshGuideLength = lineLength(meshGuide)
    assert.ok(bboxGuideLength < rectWidth * 0.75, 'Bounding-box fallback should shorten the guide for the operable opening only')
    assert.ok(meshGuideLength < rectWidth * 0.75, 'Mesh renderer should shorten the guide for the operable opening only')

    console.info('Operable leaf test passed.', {
        fixedLeafWidth: fixedLeafContext.operableLeaves.leaves[0].width,
        fixedWithoutSemanticsOperable: nonOperableFixedContext.operableLeaves.isOperable,
        defaultSingleSwingWidth: normalSingleSwingContext.operableLeaves.leaves[0].width,
        asymmetricLeafWidths: asymmetricDoubleContext.operableLeaves.leaves.map((leaf) => leaf.width),
        conservativeSingleSwingLeafWidth: conservativeSingleSwingFallback.operableLeaves.leaves[0].width,
        fallbackGuideLength,
    })
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
