import * as assert from 'node:assert/strict'
import * as THREE from 'three'
import { analyzeDoors, type DoorContext } from '../lib/door-analyzer'
import type { ElementInfo, LoadedIFCModel } from '../lib/ifc-types'
import { planSvgCanvasHeight, renderDoorViews, type SVGRenderOptions } from '../lib/svg-renderer'

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
    center: THREE.Vector3,
    rotationY: number = 0
): THREE.Mesh {
    const geometry = new THREE.BoxGeometry(width, height, depth)
    if (rotationY !== 0) {
        geometry.rotateY(rotationY)
    }
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
    const boundingBox = bboxFromMesh(mesh)
    return {
        expressID,
        ifcType: -1,
        typeName,
        mesh,
        meshes: [mesh],
        boundingBox,
        globalId: `${typeName}-${expressID}`,
    }
}

function rotateHorizontalPoint(point: THREE.Vector3, rotationY: number): THREE.Vector3 {
    return point.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), rotationY)
}

async function buildContext(options?: {
    includeWall?: boolean
    wallThickness?: number
    rotationY?: number
    openingDirection?: string
    placementYAxis?: THREE.Vector3
}): Promise<DoorContext> {
    const {
        includeWall = true,
        wallThickness = 0.24,
        rotationY = 0,
        openingDirection = 'SINGLE_SWING_LEFT',
        placementYAxis,
    } = options ?? {}

    const doorCenter = new THREE.Vector3(0, 1.05, 0)
    const wallCenter = new THREE.Vector3(0, 1.5, 0)
    const localDeviceCenter = new THREE.Vector3(0.7, 1.1, 0.08)
    const rotatedDeviceCenter = rotateHorizontalPoint(
        new THREE.Vector3(localDeviceCenter.x, 0, localDeviceCenter.z),
        rotationY
    )
    const deviceCenter = new THREE.Vector3(rotatedDeviceCenter.x, localDeviceCenter.y, rotatedDeviceCenter.z)

    const doorMesh = createBoxMesh(1, 1, 2.1, 0.12, doorCenter, rotationY)
    const wallMesh = createBoxMesh(2, 40, 3, wallThickness, wallCenter, rotationY)
    const deviceMesh = createBoxMesh(3, 0.12, 0.12, 0.08, deviceCenter)

    const door = makeElement(1, 'IFCDOOR', doorMesh)
    if (placementYAxis) {
        door.placementYAxis = placementYAxis.clone().setY(0).normalize()
    }
    const elements: ElementInfo[] = [door]
    let hostWall: ElementInfo | null = null

    if (includeWall) {
        hostWall = makeElement(2, 'IFCWALL', wallMesh)
        elements.push(hostWall)
    }

    const device = makeElement(3, 'IFCELECTRICAPPLIANCE', deviceMesh)
    elements.push(device)

    const model: LoadedIFCModel = {
        group: new THREE.Group(),
        elements,
        modelID: 0,
        api: null,
    }

    ; (model as LoadedIFCModel & { fragmentsModel: { getItemsData: () => Promise<unknown[]> } }).fragmentsModel = {
        getItemsData: async () => [],
    }

    const [context] = await analyzeDoors(
        model,
        undefined,
        undefined,
        new Map([[door.expressID, openingDirection]])
    )

    assert.ok(context, 'Expected analyzeDoors to produce a door context')

    context.detailedGeometry = {
        doorMeshes: [doorMesh],
        wallMeshes: includeWall ? [wallMesh] : [],
        deviceMeshes: [deviceMesh],
    }

    return context
}

function extractPathDataByFill(svg: string, fill: string): string[] {
    const matches = svg.match(/<path\b[^>]*>/g) || []
    const result: string[] = []

    for (const tag of matches) {
        const fillMatch = tag.match(/\bfill="([^"]+)"/)
        const dMatch = tag.match(/\bd="([^"]+)"/)
        if (fillMatch?.[1] === fill && dMatch?.[1]) {
            result.push(dMatch[1])
        }
    }

    return result.sort()
}

function extractFillGroup(svg: string): string {
    // Include both the fills group and top-level rect wall bands
    const fillsGroup = svg.match(/<g id="fills">([\s\S]*?)<\/g>/)?.[1] || ''
    const wallRects = (svg.match(/<rect\b[^>]*\/>/g) || []).join('\n')
    return fillsGroup + wallRects
}

function getWallFilledArea(svg: string, fill: string): number {
    const fillGroup = extractFillGroup(svg)
    let totalArea = 0

    // Count path polygons
    const pathTags = fillGroup.match(/<path\b[^>]*>/g) || []
    for (const tag of pathTags) {
        const fillMatch = tag.match(/\bfill="([^"]+)"/)?.[1]
        const d = tag.match(/\bd="([^"]+)"/)?.[1]
        if (fillMatch !== fill || !d) continue

        const coords = [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number.parseFloat(match[0]))
        if (coords.length < 6 || coords.length % 2 !== 0) continue

        let area = 0
        for (let i = 0; i < coords.length; i += 2) {
            const x1 = coords[i]
            const y1 = coords[i + 1]
            const nextIndex = (i + 2) % coords.length
            const x2 = coords[nextIndex]
            const y2 = coords[nextIndex + 1]
            area += x1 * y2 - x2 * y1
        }
        totalArea += Math.abs(area) / 2
    }

    // Count rect elements
    const rectTags = fillGroup.match(/<rect\b[^>]*\/>/g) || []
    for (const tag of rectTags) {
        const fillMatch = tag.match(/\bfill="([^"]+)"/)?.[1]
        const w = Number.parseFloat(tag.match(/\bwidth="([^"]+)"/)?.[1] ?? 'NaN')
        const h = Number.parseFloat(tag.match(/\bheight="([^"]+)"/)?.[1] ?? 'NaN')
        if (fillMatch === fill && Number.isFinite(w) && Number.isFinite(h)) {
            totalArea += w * h
        }
    }

    return totalArea
}

function getRenderedContentBounds(svg: string): { minX: number; maxX: number; minY: number; maxY: number } | null {
    const groups = [
        svg.match(/<g id="fills">([\s\S]*?)<\/g>/)?.[1] || '',
        svg.match(/<g id="edges">([\s\S]*?)<\/g>/)?.[1] || '',
    ]

    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity

    const pushPoint = (x: number, y: number) => {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return
        minX = Math.min(minX, x)
        maxX = Math.max(maxX, x)
        minY = Math.min(minY, y)
        maxY = Math.max(maxY, y)
    }

    for (const group of groups) {
        const tags = group.match(/<(?:path|line|rect)\b[^>]*>/g) || []
        for (const tag of tags) {
            if (tag.includes('fill-opacity="0.12"')) continue

            const pathData = tag.match(/\bd="([^"]+)"/)?.[1]
            if (pathData) {
                const coords = [...pathData.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number.parseFloat(match[0]))
                for (let i = 0; i + 1 < coords.length; i += 2) {
                    pushPoint(coords[i], coords[i + 1])
                }
            }

            const x = tag.match(/\bx="([^"]+)"/)?.[1]
            const y = tag.match(/\by="([^"]+)"/)?.[1]
            const width = tag.match(/\bwidth="([^"]+)"/)?.[1]
            const height = tag.match(/\bheight="([^"]+)"/)?.[1]
            if (x && y) {
                const x0 = Number.parseFloat(x)
                const y0 = Number.parseFloat(y)
                pushPoint(x0, y0)
                if (width && height) {
                    pushPoint(x0 + Number.parseFloat(width), y0 + Number.parseFloat(height))
                }
            }

            const x1 = tag.match(/\bx1="([^"]+)"/)?.[1]
            const y1 = tag.match(/\by1="([^"]+)"/)?.[1]
            const x2 = tag.match(/\bx2="([^"]+)"/)?.[1]
            const y2 = tag.match(/\by2="([^"]+)"/)?.[1]
            if (x1 && y1) pushPoint(Number.parseFloat(x1), Number.parseFloat(y1))
            if (x2 && y2) pushPoint(Number.parseFloat(x2), Number.parseFloat(y2))
        }
    }

    if (minX === Infinity) return null
    return { minX, maxX, minY, maxY }
}

function assertCoordinatesWithinBounds(svg: string, width: number, height: number) {
    const numberPattern = /-?\d+(?:\.\d+)?/g
    const attrPattern = /\b(?:x|y|x1|y1|x2|y2|width|height|points|d)="([^"]+)"/g
    let attrMatch: RegExpExecArray | null

    while ((attrMatch = attrPattern.exec(svg)) !== null) {
        const value = attrMatch[1]
        const numbers = value.match(numberPattern) || []
        for (const numericString of numbers) {
            const numericValue = Number.parseFloat(numericString)
            assert.ok(Number.isFinite(numericValue), `Non-finite SVG coordinate: ${numericString}`)
            assert.ok(numericValue >= -0.01, `SVG coordinate below bounds: ${numericValue}`)
            assert.ok(
                numericValue <= Math.max(width, height) + 0.01,
                `SVG coordinate above bounds: ${numericValue}`
            )
        }
    }
}

function getLongestDashedGuide(svg: string): { x1: number; y1: number; x2: number; y2: number } | null {
    const lineMatches = svg.match(/<line\b[^>]*>/g) || []
    let bestLine: { x1: number; y1: number; x2: number; y2: number } | null = null
    let bestLength = -Infinity

    for (const lineTag of lineMatches) {
        const stroke = lineTag.match(/\bstroke="([^"]+)"/)?.[1]
        const dash = lineTag.match(/\bstroke-dasharray="([^"]+)"/)?.[1]
        if (stroke !== '#666666' || dash !== '4,2') continue

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

function getLargestWallRectY(svg: string, fill: string): number | null {
    const rectTags = svg.match(/<rect\b[^>]*>/g) || []
    let bestArea = -Infinity
    let bestY: number | null = null

    for (const rectTag of rectTags) {
        const rectFill = rectTag.match(/\bfill="([^"]+)"/)?.[1]
        if (rectFill !== fill) continue

        const width = Number.parseFloat(rectTag.match(/\bwidth="([^"]+)"/)?.[1] || 'NaN')
        const height = Number.parseFloat(rectTag.match(/\bheight="([^"]+)"/)?.[1] || 'NaN')
        const y = Number.parseFloat(rectTag.match(/\by="([^"]+)"/)?.[1] || 'NaN')
        const area = width * height

        if (!Number.isFinite(area) || !Number.isFinite(y)) continue
        if (area > bestArea) {
            bestArea = area
            bestY = y
        }
    }

    return bestY
}

async function main() {
    const options: SVGRenderOptions = {
        width: 1000,
        height: 1000,
        margin: 0.5,
        doorColor: '#dedede',
        wallColor: '#e3e3e3',
        deviceColor: '#fcc647',
        lineColor: '#000000',
        showFills: true,
        showLegend: true,
        showLabels: true,
    }

    const withWall = await buildContext({ includeWall: true })
    const withoutWall = await buildContext({ includeWall: false })
    const withWallViews = await renderDoorViews(withWall, options)
    const withoutWallViews = await renderDoorViews(withoutWall, options)

    const planH = planSvgCanvasHeight(options.width!)
    for (const [viewName, svg] of Object.entries(withWallViews)) {
        const fillGroup = extractFillGroup(svg)
        assert.ok(fillGroup.includes(`fill="${options.wallColor!}"`), `${viewName} SVG is missing wall geometry in the drawing area`)
        assert.ok(getWallFilledArea(svg, options.wallColor!) > 1000, `${viewName} SVG should contain non-degenerate wall fill geometry`)
        assert.ok(svg.includes('Wand'), `${viewName} SVG is missing the wall legend item`)
        const canvasH = viewName === 'plan' ? planH : options.height!
        assertCoordinatesWithinBounds(svg, options.width!, canvasH)
    }

    for (const viewName of ['front', 'back', 'plan'] as const) {
        const doorPathsWithWall = extractPathDataByFill(withWallViews[viewName], options.doorColor!)
        const doorPathsWithoutWall = extractPathDataByFill(withoutWallViews[viewName], options.doorColor!)
        assert.deepEqual(
            doorPathsWithWall,
            doorPathsWithoutWall,
            `${viewName} door fill geometry changed when wall context was added`
        )

        const devicePathsWithWall = extractPathDataByFill(withWallViews[viewName], options.deviceColor!)
        const devicePathsWithoutWall = extractPathDataByFill(withoutWallViews[viewName], options.deviceColor!)
        assert.deepEqual(
            devicePathsWithWall,
            devicePathsWithoutWall,
            `${viewName} device fill geometry changed when wall context was added`
        )
    }

    const rotatedContext = await buildContext({ includeWall: false, rotationY: Math.PI / 4 })
    const expectedFacing = new THREE.Vector3(Math.SQRT1_2, 0, Math.SQRT1_2)
    const facingAlignment = Math.abs(rotatedContext.semanticFacing.clone().normalize().dot(expectedFacing))
    assert.ok(facingAlignment > 0.95, `Rotated semantic facing should follow the door axis, got ${rotatedContext.semanticFacing.toArray().join(', ')}`)

    const expectedWidthAxis = new THREE.Vector3(Math.SQRT1_2, 0, -Math.SQRT1_2)
    const widthAlignment = Math.abs(rotatedContext.viewFrame.widthAxis.clone().normalize().dot(expectedWidthAxis))
    assert.ok(widthAlignment > 0.95, `Rotated width axis should remain orthogonal to facing, got ${rotatedContext.viewFrame.widthAxis.toArray().join(', ')}`)

    // ── Plan view layout checks ───────────────────────────────────────────────
    // Default synthetic test setup opens downward. If the IFC ObjectPlacement local +Y
    // axis is reversed, the plan arc should flip upward and the wall bands should move
    // to the bottom with the door slice.

    const leftSwingCtx  = await buildContext({ includeWall: true,  openingDirection: 'SINGLE_SWING_LEFT'  })
    const rightSwingCtx = await buildContext({ includeWall: true,  openingDirection: 'SINGLE_SWING_RIGHT' })
    const bothSwingCtx  = await buildContext({ includeWall: true,  openingDirection: 'DOUBLE_SWING'       })
    const slidingCtx    = await buildContext({ includeWall: true,  openingDirection: 'SLIDING_TO_LEFT'    })
    const rot45Ctx      = await buildContext({ includeWall: true,  openingDirection: 'SINGLE_SWING_LEFT', rotationY: Math.PI / 4 })
    const upwardArcCtx  = await buildContext({
        includeWall: true,
        openingDirection: 'SINGLE_SWING_LEFT',
        placementYAxis: new THREE.Vector3(0, 0, -1),
    })

    const leftPlanViews  = await renderDoorViews(leftSwingCtx,  options)
    const rightPlanViews = await renderDoorViews(rightSwingCtx, options)
    const bothPlanViews  = await renderDoorViews(bothSwingCtx,  options)
    const slidingViews   = await renderDoorViews(slidingCtx,    options)
    const rot45Views     = await renderDoorViews(rot45Ctx,      options)
    const upwardArcViews = await renderDoorViews(upwardArcCtx,  options)

    const leftPlan   = leftPlanViews.plan
    const rightPlan  = rightPlanViews.plan
    const bothPlan   = bothPlanViews.plan
    const slidingPlan = slidingViews.plan
    const rot45Plan  = rot45Views.plan
    const upwardArcPlan = upwardArcViews.plan

    const leftGuide  = getLongestDashedGuide(leftPlan)
    const rightGuide = getLongestDashedGuide(rightPlan)
    const rotatedGuide = getLongestDashedGuide(rot45Plan)
    const upwardGuide = getLongestDashedGuide(upwardArcPlan)
    const planBounds = getRenderedContentBounds(leftPlan)

    assert.ok(leftGuide,  'Left swing plan should include a dashed open-position guide')
    assert.ok(rightGuide, 'Right swing plan should include a dashed open-position guide')
    assert.equal(rotatedGuide, null, 'Rotated plan should not render a symbolic swing guide')
    assert.ok(upwardGuide, 'IFC-reversed placement should still include a dashed open-position guide')
    assert.ok(planBounds, 'Plan view should contain rendered geometry')
    assert.ok(planBounds.maxX - planBounds.minX > 250, 'Plan view geometry should occupy a substantial width')
    // Plan uses the same scale as Vorderansicht (renderDoorViews); the slice is shallow in screen Y.
    assert.ok(planBounds.maxY - planBounds.minY > 20, 'Plan view geometry should have non-degenerate vertical extent')

    // Hinge origin side
    assert.ok(leftGuide.x1  < options.width! / 2, 'Left swing guide should originate from the left hinge side')
    assert.ok(rightGuide.x1 > options.width! / 2, 'Right swing guide should originate from the right hinge side')

    // Default synthetic setup opens downward: y2 > y1.
    assert.ok(leftGuide.y2  > leftGuide.y1,  'Left swing arc should open downward (into room)')
    assert.ok(rightGuide.y2 > rightGuide.y1, 'Right swing arc should open downward (into room)')
    assert.ok(upwardGuide.y2 < upwardGuide.y1, 'IFC-reversed placement should flip the plan arc upward')

    // Wall bands exist for all plan views
    for (const [label, planSvg] of [
        ['left-swing plan', leftPlan],
        ['right-swing plan', rightPlan],
        ['double-swing plan', bothPlan],
        ['sliding plan', slidingPlan],
        ['rotated-45 plan', rot45Plan],
        ['upward-arc plan', upwardArcPlan],
    ] as [string, string][]) {
        assertCoordinatesWithinBounds(planSvg, options.width!, planH)
        assert.ok(
            planSvg.includes(`fill="${options.wallColor!}"`),
            `${label}: wall bands should be present`
        )
    }

    // Plan wall bands sit at offsetY (semantic door back vs opening side). Absolute Y shifts when
    // scale matches Vorderansicht; compare default vs flipped arc instead of fixed pixels.
    const wallBandY = getLargestWallRectY(leftPlan, options.wallColor!)
    const upwardWallBandY = getLargestWallRectY(upwardArcPlan, options.wallColor!)
    if (wallBandY !== null && upwardWallBandY !== null) {
        assert.ok(
            wallBandY < upwardWallBandY - 20,
            `Default plan wall bands should be above flipped-arc bands (got y=${wallBandY} vs ${upwardWallBandY})`
        )
    }

    // The old plan tests (legacy)
    const leftGuide2  = getLongestDashedGuide((await renderDoorViews(await buildContext({ includeWall: false, openingDirection: 'SINGLE_SWING_LEFT'  }), options)).plan)
    const rightGuide2 = getLongestDashedGuide((await renderDoorViews(await buildContext({ includeWall: false, openingDirection: 'SINGLE_SWING_RIGHT' }), options)).plan)
    assert.ok(leftGuide2,  'No-wall left swing plan should include a dashed guide')
    assert.ok(rightGuide2, 'No-wall right swing plan should include a dashed guide')

    const thickWallContext = await buildContext({ includeWall: true, wallThickness: 0.6 })
    const thickWallViews = await renderDoorViews(thickWallContext, options)
    for (const [viewName, svg] of Object.entries(thickWallViews)) {
        const canvasH = viewName === 'plan' ? planH : options.height!
        assertCoordinatesWithinBounds(svg, options.width!, canvasH)
    }

    // Write fixtures for visual inspection
    const { writeFileSync, mkdirSync } = await import('node:fs')
    const dir = 'test-output/door-wall-context'
    mkdirSync(dir, { recursive: true })
    for (const [view, svg] of Object.entries(withWallViews)) {
        writeFileSync(`${dir}/with-wall-${view}.svg`, svg)
    }
    for (const [view, svg] of Object.entries(withoutWallViews)) {
        writeFileSync(`${dir}/without-wall-${view}.svg`, svg)
    }
    // Plan-specific fixtures
    writeFileSync(`${dir}/plan-left-swing.svg`, leftPlan)
    writeFileSync(`${dir}/plan-right-swing.svg`, rightPlan)
    writeFileSync(`${dir}/plan-double-swing.svg`, bothPlan)
    writeFileSync(`${dir}/plan-sliding.svg`, slidingPlan)
    writeFileSync(`${dir}/plan-rotated-45.svg`, rot45Plan)
    writeFileSync(`${dir}/plan-upward-arc.svg`, upwardArcPlan)

    console.log('Door wall context regression test passed')
}

main().catch((error) => {
    console.error(error)
    process.exitCode = 1
})
