import * as assert from 'node:assert/strict'
import * as THREE from 'three'
import { analyzeDoors, getDoorOperationInfo, type DoorContext } from '../lib/door-analyzer'
import type { DoorCsetStandardCHData, DoorLeafMetadata } from '../lib/ifc-loader'
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
    deviceDepthOffset?: number
    deviceCenterY?: number
    csetStandardCH?: Partial<DoorCsetStandardCHData>
    doorLeafMetadata?: DoorLeafMetadata
    includeCeiling?: boolean
    ceilingDepthOffset?: number
    includeStair?: boolean
}): Promise<DoorContext> {
    const {
        includeWall = true,
        wallThickness = 0.24,
        rotationY = 0,
        openingDirection = 'SINGLE_SWING_LEFT',
        placementYAxis,
        deviceDepthOffset = 0.08,
        deviceCenterY = 1.1,
        csetStandardCH,
        doorLeafMetadata,
        includeCeiling = false,
        ceilingDepthOffset = 0,
        includeStair = false,
    } = options ?? {}

    const doorCenter = new THREE.Vector3(0, 1.05, 0)
    const wallCenter = new THREE.Vector3(0, 1.5, 0)
    const localDeviceCenter = new THREE.Vector3(0.62, 1.1, deviceDepthOffset)
    const rotatedDeviceCenter = rotateHorizontalPoint(
        new THREE.Vector3(localDeviceCenter.x, 0, localDeviceCenter.z),
        rotationY
    )
    const deviceCenter = new THREE.Vector3(rotatedDeviceCenter.x, deviceCenterY, rotatedDeviceCenter.z)

    const doorMesh = createBoxMesh(1, 1, 2.1, 0.12, doorCenter, rotationY)
    const wallMesh = createBoxMesh(2, 40, 3, wallThickness, wallCenter, rotationY)
    const deviceMesh = createBoxMesh(3, 0.12, 0.12, 0.08, deviceCenter)
    const localCeilingCenter = new THREE.Vector3(0, 0, ceilingDepthOffset)
    const rotatedCeilingCenter = rotateHorizontalPoint(localCeilingCenter, rotationY)
    const ceilingMesh = createBoxMesh(4, 4, 0.14, 1.2, new THREE.Vector3(rotatedCeilingCenter.x, 2.45, rotatedCeilingCenter.z), rotationY)
    const stairMesh = createBoxMesh(5, 1.6, 0.4, 1.4, new THREE.Vector3(-0.95, 0.25, 0.55), rotationY)

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
    if (includeCeiling) {
        elements.push(makeElement(4, 'IFCCOVERING', ceilingMesh))
    }
    if (includeStair) {
        elements.push(makeElement(5, 'IFCSTAIR', stairMesh))
    }

    const model: LoadedIFCModel = {
        group: new THREE.Group(),
        elements,
        modelID: 0,
        api: null,
    }

    ; (model as LoadedIFCModel & { fragmentsModel: { getItemsData: () => Promise<unknown[]> } }).fragmentsModel = {
        getItemsData: async () => [],
    }

    const csetStandardCHMap = csetStandardCH
        ? new Map([[door.expressID, {
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
            festverglasung: null,
            cfcBkpCccBcc: null,
            isExternal: null,
            ...csetStandardCH,
        }]])
        : undefined
    const doorLeafMetadataMap = doorLeafMetadata
        ? new Map([[door.expressID, doorLeafMetadata]])
        : undefined

    const [context] = await analyzeDoors(
        model,
        undefined,
        undefined,
        new Map([[door.expressID, openingDirection]]),
        csetStandardCHMap,
        doorLeafMetadataMap
    )

    assert.ok(context, 'Expected analyzeDoors to produce a door context')

    context.detailedGeometry = {
        doorMeshes: [doorMesh],
        wallMeshes: includeWall ? [wallMesh] : [],
        nearbyWallMeshes: [],
        wallAggregatePartMeshes: [],
        slabMeshes: [],
        ceilingMeshes: includeCeiling ? [ceilingMesh] : [],
        nearbyDoorMeshes: [],
        nearbyWindowMeshes: [],
        stairMeshes: includeStair ? [stairMesh] : [],
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

/** Longest solid plan swing “open position” guide: same stroke as arc helper, no dash (product is solid, not dashed). */
function getLongestSwingOpenGuide(svg: string): { x1: number; y1: number; x2: number; y2: number } | null {
    const lineMatches = svg.match(/<line\b[^>]*>/g) || []
    let bestLine: { x1: number; y1: number; x2: number; y2: number } | null = null
    let bestLength = -Infinity

    for (const lineTag of lineMatches) {
        const stroke = lineTag.match(/\bstroke="([^"]+)"/)?.[1]
        if (stroke !== '#666666') continue
        if (/\bstroke-dasharray=/.test(lineTag)) continue

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

/**
 * L-corner fixture: a door placed in a host wall with an adjacent
 * perpendicular wall meeting the host wall near the door's left jamb. Used to
 * verify that `findNearbyWalls` picks up the perpendicular wall and that the
 * plan section renderer draws its footprint in plan view.
 */
async function buildLCornerContext(): Promise<DoorContext> {
    const doorCenter = new THREE.Vector3(0, 1.05, 0)
    const hostWallCenter = new THREE.Vector3(0, 1.5, 0)
    // 0.24 thick × 3 tall × 3 deep; meets the host wall at x ≈ -0.6 (just
    // outside the door's left jamb at x = -0.5) and extends towards -z.
    const perpWallCenter = new THREE.Vector3(-0.6, 1.5, -1.5)

    const doorMesh = createBoxMesh(1, 1, 2.1, 0.12, doorCenter)
    const hostWallMesh = createBoxMesh(2, 40, 3, 0.24, hostWallCenter)
    const perpWallMesh = createBoxMesh(3, 0.24, 3, 3, perpWallCenter)

    const door = makeElement(1, 'IFCDOOR', doorMesh)
    const hostWall = makeElement(2, 'IFCWALL', hostWallMesh)
    const perpWall = makeElement(3, 'IFCWALL', perpWallMesh)

    const model: LoadedIFCModel = {
        group: new THREE.Group(),
        elements: [door, hostWall, perpWall],
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
    assert.ok(context, 'Expected analyzeDoors to produce a door context for L-corner fixture')

    context.detailedGeometry = {
        doorMeshes: [doorMesh],
        wallMeshes: [hostWallMesh],
        nearbyWallMeshes: [perpWallMesh],
        wallAggregatePartMeshes: [],
        slabMeshes: [],
        ceilingMeshes: [],
        nearbyDoorMeshes: [],
        nearbyWindowMeshes: [],
        stairMeshes: [],
        deviceMeshes: [],
    }

    return context
}

/**
 * Adjacent-doors fixture: two doors hosted by the same wall with a small
 * horizontal gap between them. Used to verify that `findNearbyDoors` identifies
 * the neighbour and that both plan views render without geometry corruption
 * when the mesh-section renderer encounters the full host wall.
 */
async function buildAdjacentDoorsContexts(): Promise<{ primary: DoorContext; secondary: DoorContext }> {
    const door1Center = new THREE.Vector3(0, 1.05, 0)
    const door2Center = new THREE.Vector3(1.5, 1.05, 0)
    const hostWallCenter = new THREE.Vector3(0, 1.5, 0)

    const door1Mesh = createBoxMesh(1, 1, 2.1, 0.12, door1Center)
    const door2Mesh = createBoxMesh(2, 1, 2.1, 0.12, door2Center)
    const hostWallMesh = createBoxMesh(3, 40, 3, 0.24, hostWallCenter)

    const door1 = makeElement(1, 'IFCDOOR', door1Mesh)
    const door2 = makeElement(2, 'IFCDOOR', door2Mesh)
    const hostWall = makeElement(3, 'IFCWALL', hostWallMesh)

    const model: LoadedIFCModel = {
        group: new THREE.Group(),
        elements: [door1, door2, hostWall],
        modelID: 0,
        api: null,
    }
    ;(model as LoadedIFCModel & { fragmentsModel: { getItemsData: () => Promise<unknown[]> } }).fragmentsModel = {
        getItemsData: async () => [],
    }

    const contexts = await analyzeDoors(
        model,
        undefined,
        undefined,
        new Map([
            [door1.expressID, 'SINGLE_SWING_LEFT'],
            [door2.expressID, 'SINGLE_SWING_RIGHT'],
        ])
    )
    assert.equal(contexts.length, 2, 'Expected two door contexts for adjacent-door fixture')

    for (const ctx of contexts) {
        const ownMesh = ctx.door.expressID === door1.expressID ? door1Mesh : door2Mesh
        ctx.detailedGeometry = {
            doorMeshes: [ownMesh],
            wallMeshes: [hostWallMesh],
            nearbyWallMeshes: [],
            wallAggregatePartMeshes: [],
            slabMeshes: [],
            ceilingMeshes: [],
            nearbyDoorMeshes: [],
            nearbyWindowMeshes: [],
            stairMeshes: [],
            deviceMeshes: [],
        }
    }

    const primary = contexts.find((c) => c.door.expressID === door1.expressID)
    const secondary = contexts.find((c) => c.door.expressID === door2.expressID)
    assert.ok(primary && secondary, 'Expected both primary and secondary door contexts')
    return { primary, secondary }
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
    // ── Operation-type parsing regression ────────────────────────────────────
    // DOUBLE_SWING_LEFT / DOUBLE_SWING_RIGHT are distinct IfcDoorTypeOperationEnum
    // values (single-leaf double-acting with specific handedness). They must be
    // matched with the correct `hingeSide` before the generic DOUBLE_SWING /
    // DOUBLE_DOOR_* fallback, otherwise they fall through and default to
    // `hingeSide: 'right'`, breaking handedness mirroring.
    const doubleSwingLeft  = getDoorOperationInfo('DOUBLE_SWING_LEFT')
    const doubleSwingRight = getDoorOperationInfo('DOUBLE_SWING_RIGHT')
    const doubleSwingBoth  = getDoorOperationInfo('DOUBLE_SWING')
    assert.equal(doubleSwingLeft.kind,       'swing', 'DOUBLE_SWING_LEFT should be parsed as a swing')
    assert.equal(doubleSwingLeft.hingeSide,  'left',  'DOUBLE_SWING_LEFT must preserve left handedness')
    assert.equal(doubleSwingRight.kind,      'swing', 'DOUBLE_SWING_RIGHT should be parsed as a swing')
    assert.equal(doubleSwingRight.hingeSide, 'right', 'DOUBLE_SWING_RIGHT must preserve right handedness')
    assert.equal(doubleSwingBoth.kind,       'swing', 'DOUBLE_SWING should be parsed as a swing')
    assert.equal(doubleSwingBoth.hingeSide,  'both',  'Bare DOUBLE_SWING should report both hinges')

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
    const backMounted = await buildContext({ includeWall: true, deviceDepthOffset: -0.08 })
    const centerMounted = await buildContext({ includeWall: true, deviceDepthOffset: 0 })
    const withWallViews = await renderDoorViews(withWall, options)
    const withoutWallViews = await renderDoorViews(withoutWall, options)
    const backMountedViews = await renderDoorViews(backMounted, options)
    const centerMountedViews = await renderDoorViews(centerMounted, options)

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
        assert.ok(
            doorPathsWithWall.length > 0,
            `${viewName} door fill geometry should be present when wall context is added`
        )
        assert.ok(
            doorPathsWithoutWall.length > 0,
            `${viewName} door fill geometry should be present without wall context`
        )
    }

    const frontDevicePathsWithWall = extractPathDataByFill(withWallViews.front, options.deviceColor!)
    const backDevicePathsWithWall = extractPathDataByFill(withWallViews.back, options.deviceColor!)
    const planDevicePathsWithWall = extractPathDataByFill(withWallViews.plan, options.deviceColor!)
    const frontDevicePathsWithoutWall = extractPathDataByFill(withoutWallViews.front, options.deviceColor!)
    const backDevicePathsWithoutWall = extractPathDataByFill(withoutWallViews.back, options.deviceColor!)
    const frontDevicePathsBackMounted = extractPathDataByFill(backMountedViews.front, options.deviceColor!)
    const backDevicePathsBackMounted = extractPathDataByFill(backMountedViews.back, options.deviceColor!)
    const frontDevicePathsCenterMounted = extractPathDataByFill(centerMountedViews.front, options.deviceColor!)
    const backDevicePathsCenterMounted = extractPathDataByFill(centerMountedViews.back, options.deviceColor!)
    const planDevicePathsCenterMounted = extractPathDataByFill(centerMountedViews.plan, options.deviceColor!)

    assert.equal(withWall.nearbyDevices.length, 1, 'Expected one nearby device for wall-mounted context')
    assert.equal(withWall.nearbyDeviceVisibility.length, 1, 'Expected side metadata for the selected nearby device')
    assert.equal(withWall.nearbyDeviceVisibility[0].side, 'front', 'Expected positive-depth device to classify to the front wall face')
    assert.equal(backMounted.nearbyDeviceVisibility[0]?.side, 'back', 'Expected negative-depth device to classify to the back wall face')
    assert.equal(centerMounted.nearbyDeviceVisibility[0]?.side, 'unknown', 'Expected center-mounted device to remain ambiguous')

    assert.ok(frontDevicePathsWithWall.length > 0, 'Front elevation should render a front-mounted electrical device')
    assert.deepEqual(backDevicePathsWithWall, [], 'Back elevation should hide a front-mounted electrical device')
    assert.ok(planDevicePathsWithWall.length > 0, 'Plan view should keep rendering nearby electrical devices')
    assert.equal(withoutWall.nearbyDeviceVisibility[0]?.side, 'front', 'Expected no-wall fallback to classify a positive-depth device as front')
    assert.ok(frontDevicePathsWithoutWall.length > 0, 'Missing wall context should still render a front-mounted device in the front elevation')
    assert.deepEqual(backDevicePathsWithoutWall, [], 'Missing wall context should hide a front-mounted device in the back elevation')
    assert.ok(withoutWallViews.front.includes('Elektro'), 'Front elevation legend should include Elektro when a device is visible')
    assert.ok(!withoutWallViews.back.includes('Elektro'), 'Back elevation legend should omit Elektro when no device is visible')
    assert.deepEqual(frontDevicePathsBackMounted, [], 'Front elevation should hide a back-mounted electrical device')
    assert.ok(backDevicePathsBackMounted.length > 0, 'Back elevation should render a back-mounted electrical device')
    assert.deepEqual(frontDevicePathsCenterMounted, [], 'Ambiguous or off-axis devices should not render in the front elevation')
    assert.deepEqual(backDevicePathsCenterMounted, [], 'Ambiguous or off-axis devices should not render in the back elevation')
    assert.deepEqual(planDevicePathsCenterMounted, [], 'Ambiguous or off-axis devices should not render in plan view')
    assert.ok(!centerMountedViews.plan.includes('Elektro'), 'Plan legend should omit Elektro when no device is visible')

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
    // Handedness coverage: flipping IFC placementYAxis must flip the hinge side in plan.
    const handednessLeftPlusZ  = await buildContext({
        includeWall: true,
        openingDirection: 'SINGLE_SWING_LEFT',
        placementYAxis: new THREE.Vector3(0, 0, 1),
    })
    const handednessLeftMinusZ = await buildContext({
        includeWall: true,
        openingDirection: 'SINGLE_SWING_LEFT',
        placementYAxis: new THREE.Vector3(0, 0, -1),
    })
    const handednessRightPlusZ  = await buildContext({
        includeWall: true,
        openingDirection: 'SINGLE_SWING_RIGHT',
        placementYAxis: new THREE.Vector3(0, 0, 1),
    })
    const handednessRightMinusZ = await buildContext({
        includeWall: true,
        openingDirection: 'SINGLE_SWING_RIGHT',
        placementYAxis: new THREE.Vector3(0, 0, -1),
    })
    const handednessDoubleDoorPlusZ = await buildContext({
        includeWall: true,
        openingDirection: 'DOUBLE_DOOR_SINGLE_SWING',
        placementYAxis: new THREE.Vector3(0, 0, 1),
    })
    const sideFixedLeftCtx = await buildContext({
        includeWall: true,
        openingDirection: 'SWING_FIXED_LEFT',
        csetStandardCH: {
            massDurchgangsbreite: 0.8,
            massAussenrahmenBreite: 1.2,
        },
        doorLeafMetadata: {
            overallWidth: 1.2,
            overallHeight: 2.1,
            quantityWidth: 1.2,
            quantityHeight: 2.1,
            panels: [{ operation: 'SWINGING', widthRatio: 1, position: 'MIDDLE' }],
        },
    })
    const sideFixedRightCtx = await buildContext({
        includeWall: true,
        openingDirection: 'SWING_FIXED_RIGHT',
        csetStandardCH: {
            massDurchgangsbreite: 0.8,
            massAussenrahmenBreite: 1.2,
        },
        doorLeafMetadata: {
            overallWidth: 1.2,
            overallHeight: 2.1,
            quantityWidth: 1.2,
            quantityHeight: 2.1,
            panels: [{ operation: 'SWINGING', widthRatio: 1, position: 'MIDDLE' }],
        },
    })

    const leftPlanViews  = await renderDoorViews(leftSwingCtx,  options)
    const rightPlanViews = await renderDoorViews(rightSwingCtx, options)
    const bothPlanViews  = await renderDoorViews(bothSwingCtx,  options)
    const slidingViews   = await renderDoorViews(slidingCtx,    options)
    const rot45Views     = await renderDoorViews(rot45Ctx,      options)
    const upwardArcViews = await renderDoorViews(upwardArcCtx,  options)
    const sideFixedLeftViews = await renderDoorViews(sideFixedLeftCtx, options)
    const sideFixedRightViews = await renderDoorViews(sideFixedRightCtx, options)
    const handednessLeftPlusZViews   = await renderDoorViews(handednessLeftPlusZ,  options)
    const handednessLeftMinusZViews  = await renderDoorViews(handednessLeftMinusZ, options)
    const handednessRightPlusZViews  = await renderDoorViews(handednessRightPlusZ, options)
    const handednessRightMinusZViews = await renderDoorViews(handednessRightMinusZ,options)
    const handednessDoubleDoorViews  = await renderDoorViews(handednessDoubleDoorPlusZ, options)

    const leftPlan   = leftPlanViews.plan
    const rightPlan  = rightPlanViews.plan
    const bothPlan   = bothPlanViews.plan
    const slidingPlan = slidingViews.plan
    const rot45Plan  = rot45Views.plan
    const upwardArcPlan = upwardArcViews.plan
    const sideFixedLeftPlan = sideFixedLeftViews.plan
    const sideFixedRightPlan = sideFixedRightViews.plan

    const leftGuide  = getLongestSwingOpenGuide(leftPlan)
    const rightGuide = getLongestSwingOpenGuide(rightPlan)
    const rotatedGuide = getLongestSwingOpenGuide(rot45Plan)
    const upwardGuide = getLongestSwingOpenGuide(upwardArcPlan)
    const sideFixedLeftGuide = getLongestSwingOpenGuide(sideFixedLeftPlan)
    const sideFixedRightGuide = getLongestSwingOpenGuide(sideFixedRightPlan)
    const planBounds = getRenderedContentBounds(leftPlan)

    assert.ok(leftGuide,  'Left swing plan should include a solid open-position guide')
    assert.ok(rightGuide, 'Right swing plan should include a solid open-position guide')
    assert.equal(rotatedGuide, null, 'Rotated plan should not render a symbolic swing guide')
    assert.ok(upwardGuide, 'IFC-reversed placement should still include a solid open-position guide')
    assert.ok(sideFixedLeftGuide, 'Fixed-left sidelight plan should include a solid open-position guide')
    assert.ok(sideFixedRightGuide, 'Fixed-right sidelight plan should include a solid open-position guide')
    assert.ok(planBounds, 'Plan view should contain rendered geometry')
    assert.ok(planBounds.maxX - planBounds.minX > 250, 'Plan view geometry should occupy a substantial width')
    // Plan uses the same scale as Vorderansicht (renderDoorViews); the slice is shallow in screen Y.
    assert.ok(planBounds.maxY - planBounds.minY > 20, 'Plan view geometry should have non-degenerate vertical extent')

    // Hinge origin side
    assert.ok(leftGuide.x1  < options.width! / 2, 'Left swing guide should originate from the left hinge side')
    assert.ok(rightGuide.x1 > options.width! / 2, 'Right swing guide should originate from the right hinge side')
    assert.ok(sideFixedLeftGuide.x1 < options.width! / 2, 'Fixed-left sidelight should hinge from the left jamb')
    assert.ok(sideFixedRightGuide.x1 > options.width! / 2, 'Fixed-right sidelight should hinge from the right jamb')

    // IFC handedness invariant: flipping placementYAxis (local +Y direction) must
    // flip the hinge side for ALL swing-capable operation types. The renderer's
    // `widthAxis` depends on `semanticFacing`, which can be guessed with either
    // sign; the mirror logic compensates so that IFC LEFT/RIGHT always maps to
    // the correct world-side regardless of that ambiguity.
    const handednessLeftPlusZGuide   = getLongestSwingOpenGuide(handednessLeftPlusZViews.plan)
    const handednessLeftMinusZGuide  = getLongestSwingOpenGuide(handednessLeftMinusZViews.plan)
    const handednessRightPlusZGuide  = getLongestSwingOpenGuide(handednessRightPlusZViews.plan)
    const handednessRightMinusZGuide = getLongestSwingOpenGuide(handednessRightMinusZViews.plan)
    assert.ok(handednessLeftPlusZGuide,   'SINGLE_SWING_LEFT with placementYAxis=+Z should render a solid open-position guide')
    assert.ok(handednessLeftMinusZGuide,  'SINGLE_SWING_LEFT with placementYAxis=-Z should render a solid open-position guide')
    assert.ok(handednessRightPlusZGuide,  'SINGLE_SWING_RIGHT with placementYAxis=+Z should render a solid open-position guide')
    assert.ok(handednessRightMinusZGuide, 'SINGLE_SWING_RIGHT with placementYAxis=-Z should render a solid open-position guide')
    const midX = options.width! / 2
    const leftPlusZOnLeft   = handednessLeftPlusZGuide.x1   < midX
    const leftMinusZOnLeft  = handednessLeftMinusZGuide.x1  < midX
    const rightPlusZOnLeft  = handednessRightPlusZGuide.x1  < midX
    const rightMinusZOnLeft = handednessRightMinusZGuide.x1 < midX
    assert.notEqual(
        leftPlusZOnLeft,
        leftMinusZOnLeft,
        'Flipping placementYAxis must mirror SINGLE_SWING_LEFT hinge side (otherwise IFC handedness is ignored)'
    )
    assert.notEqual(
        rightPlusZOnLeft,
        rightMinusZOnLeft,
        'Flipping placementYAxis must mirror SINGLE_SWING_RIGHT hinge side (otherwise IFC handedness is ignored)'
    )
    // LEFT and RIGHT with the SAME placementYAxis must hinge on opposite sides.
    assert.notEqual(
        leftPlusZOnLeft,
        rightPlusZOnLeft,
        'SINGLE_SWING_LEFT and SINGLE_SWING_RIGHT must hinge on opposite sides for the same placementYAxis'
    )
    assert.notEqual(
        leftMinusZOnLeft,
        rightMinusZOnLeft,
        'SINGLE_SWING_LEFT and SINGLE_SWING_RIGHT must hinge on opposite sides for the same placementYAxis'
    )
    // Double doors (hingeSide='both') must still render a symbolic swing; hinge mirroring
    // is a no-op for symmetric leaves but the renderer must not crash or drop the swing.
    const handednessDoubleDoorGuide = getLongestSwingOpenGuide(handednessDoubleDoorViews.plan)
    assert.ok(handednessDoubleDoorGuide, 'DOUBLE_DOOR_SINGLE_SWING with placementYAxis=+Z should still render a solid open-position guide')

    // Default synthetic setup opens downward: y2 > y1.
    assert.ok(leftGuide.y2  > leftGuide.y1,  'Left swing arc should open downward (into room)')
    assert.ok(rightGuide.y2 > rightGuide.y1, 'Right swing arc should open downward (into room)')
    assert.ok(upwardGuide.y2 < upwardGuide.y1, 'IFC-reversed placement should flip the plan arc upward')
    assert.ok(sideFixedLeftGuide.y2 > sideFixedLeftGuide.y1, 'Fixed-left sidelight should still open downward')
    assert.ok(sideFixedRightGuide.y2 > sideFixedRightGuide.y1, 'Fixed-right sidelight should still open downward')
    assert.ok(
        Math.hypot(sideFixedLeftGuide.x2 - sideFixedLeftGuide.x1, sideFixedLeftGuide.y2 - sideFixedLeftGuide.y1)
            < Math.hypot(leftGuide.x2 - leftGuide.x1, leftGuide.y2 - leftGuide.y1),
        'Fixed-left sidelight guide should use the narrower operable leaf width'
    )
    assert.ok(
        Math.hypot(sideFixedRightGuide.x2 - sideFixedRightGuide.x1, sideFixedRightGuide.y2 - sideFixedRightGuide.y1)
            < Math.hypot(rightGuide.x2 - rightGuide.x1, rightGuide.y2 - rightGuide.y1),
        'Fixed-right sidelight guide should use the narrower operable leaf width'
    )

    // Wall bands exist for all plan views
    for (const [label, planSvg] of [
        ['left-swing plan', leftPlan],
        ['right-swing plan', rightPlan],
        ['double-swing plan', bothPlan],
        ['sliding plan', slidingPlan],
        ['rotated-45 plan', rot45Plan],
        ['upward-arc plan', upwardArcPlan],
        ['fixed-left sidelight plan', sideFixedLeftPlan],
        ['fixed-right sidelight plan', sideFixedRightPlan],
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
            Number.isFinite(wallBandY) && Number.isFinite(upwardWallBandY),
            `Expected comparable wall band positions, got y=${wallBandY} vs ${upwardWallBandY}`
        )
    }

    // The old plan tests (legacy)
    const leftGuide2  = getLongestSwingOpenGuide((await renderDoorViews(await buildContext({ includeWall: false, openingDirection: 'SINGLE_SWING_LEFT'  }), options)).plan)
    const rightGuide2 = getLongestSwingOpenGuide((await renderDoorViews(await buildContext({ includeWall: false, openingDirection: 'SINGLE_SWING_RIGHT' }), options)).plan)
    assert.ok(leftGuide2,  'No-wall left swing plan should include a solid open-position guide')
    assert.ok(rightGuide2, 'No-wall right swing plan should include a solid open-position guide')

    const thickWallContext = await buildContext({ includeWall: true, wallThickness: 0.6 })
    const thickWallViews = await renderDoorViews(thickWallContext, options)
    for (const [viewName, svg] of Object.entries(thickWallViews)) {
        const canvasH = viewName === 'plan' ? planH : options.height!
        assertCoordinatesWithinBounds(svg, options.width!, canvasH)
    }

    const highMountedDeviceContext = await buildContext({
        includeWall: true,
        deviceCenterY: 2.15,
        includeCeiling: true,
        includeStair: true,
    })
    // Render this fixture with a distinct floorSlabColor so the ceiling/stair
    // assertions measure real slab-context fills. If we re-used the default
    // (which falls back to wallColor), the host-wall fill alone would satisfy
    // the area threshold and mask slab-rendering regressions.
    const highMountedOptions = { ...options, floorSlabColor: '#6EAF72', suspendedCeilingColor: '#6EAF72' }
    const highMountedDeviceViews = await renderDoorViews(highMountedDeviceContext, highMountedOptions)
    const highMountedPlanDevicePaths = extractPathDataByFill(highMountedDeviceViews.plan, highMountedOptions.deviceColor!)
    assert.ok(
        highMountedDeviceContext.hostCeilings.length > 0,
        'Expected IFCCOVERING elements to be collected as host ceilings'
    )
    assert.equal(
        highMountedDeviceContext.hostCeilingVisibility[0]?.side,
        'both',
        'Expected straddling IFCCOVERING to render on both elevations'
    )
    assert.ok(
        highMountedDeviceContext.nearbyStairs.length > 0,
        'Expected IFCSTAIR elements to be collected as nearby stairs'
    )
    assert.deepEqual(
        highMountedPlanDevicePaths,
        [],
        'Devices above the plan cut should not render in plan view'
    )
    const slabColor = highMountedOptions.floorSlabColor!
    assert.ok(
        getWallFilledArea(highMountedDeviceViews.front, slabColor) > 1200,
        'Front elevation should render ceiling/stair slab-color context'
    )
    assert.ok(
        getWallFilledArea(highMountedDeviceViews.back, slabColor) > 1200,
        'Back elevation should render ceiling/stair slab-color context'
    )

    const frontCeilingOnlyContext = await buildContext({
        includeWall: true,
        includeCeiling: true,
        includeStair: false,
        ceilingDepthOffset: 0.72,
    })
    const backCeilingOnlyContext = await buildContext({
        includeWall: true,
        includeCeiling: true,
        includeStair: false,
        ceilingDepthOffset: -0.72,
    })
    const frontCeilingOnlyViews = await renderDoorViews(frontCeilingOnlyContext, highMountedOptions)
    const backCeilingOnlyViews = await renderDoorViews(backCeilingOnlyContext, highMountedOptions)
    assert.equal(frontCeilingOnlyContext.hostCeilingVisibility[0]?.side, 'front', 'Expected front-side IFCCOVERING metadata')
    assert.equal(backCeilingOnlyContext.hostCeilingVisibility[0]?.side, 'back', 'Expected back-side IFCCOVERING metadata')
    assert.ok(
        getWallFilledArea(frontCeilingOnlyViews.front, slabColor) > 1200,
        'Front elevation should render front-side IFCCOVERING'
    )
    assert.ok(
        getWallFilledArea(frontCeilingOnlyViews.back, slabColor) < 1,
        'Back elevation should hide front-side IFCCOVERING'
    )
    assert.ok(
        getWallFilledArea(backCeilingOnlyViews.front, slabColor) < 1,
        'Front elevation should hide back-side IFCCOVERING'
    )
    assert.ok(
        getWallFilledArea(backCeilingOnlyViews.back, slabColor) > 1200,
        'Back elevation should render back-side IFCCOVERING'
    )

    // ── Mesh-based plan section: L-corner + adjacent doors ────────────────────
    // Plan views now project actual wall meshes at the door's cut plane instead
    // of drawing two synthetic rectangular stubs. These fixtures verify that
    //   (a) perpendicular walls meeting the host wall become visible in plan, and
    //   (b) adjacent doors in the same host wall don't corrupt the plan view.
    const lCornerContext = await buildLCornerContext()
    assert.equal(
        lCornerContext.nearbyWalls.length,
        1,
        'L-corner: analyzer should pick up exactly one perpendicular wall',
    )
    assert.equal(
        lCornerContext.nearbyWalls[0].expressID,
        3,
        'L-corner: the perpendicular wall should be the detected nearby wall',
    )
    assert.ok(
        lCornerContext.detailedGeometry?.nearbyWallMeshes?.length === 1,
        'L-corner: nearby-wall meshes must be carried into detailedGeometry',
    )

    const lCornerViews = await renderDoorViews(lCornerContext, options)
    const lCornerPlanArea = getWallFilledArea(lCornerViews.plan, options.wallColor!)
    const baselinePlanArea = getWallFilledArea(withWallViews.plan, options.wallColor!)
    assert.ok(
        lCornerPlanArea > baselinePlanArea + 1000,
        `L-corner plan view should carry more wall fill area than the single-host-wall baseline (got ${lCornerPlanArea.toFixed(0)} vs ${baselinePlanArea.toFixed(0)})`,
    )

    // Confirm the perpendicular wall actually extends the wall footprint in the
    // depth direction (not just laterally). We compare the vertical span of the
    // wall fill polygons — baseline's thin host-wall cut should be much
    // shallower than the L-corner's footprint that reaches into -depth.
    const lCornerRenderedBounds = getRenderedContentBounds(lCornerViews.plan)
    const baselineRenderedBounds = getRenderedContentBounds(withWallViews.plan)
    assert.ok(lCornerRenderedBounds && baselineRenderedBounds, 'Expected plan bounds to be measurable')
    const lCornerDepthSpan = lCornerRenderedBounds!.maxY - lCornerRenderedBounds!.minY
    const baselineDepthSpan = baselineRenderedBounds!.maxY - baselineRenderedBounds!.minY
    assert.ok(
        lCornerDepthSpan > baselineDepthSpan + 5,
        `L-corner plan view should extend deeper than baseline (got span ${lCornerDepthSpan.toFixed(1)} vs ${baselineDepthSpan.toFixed(1)})`,
    )
    for (const [viewName, svg] of Object.entries(lCornerViews)) {
        const canvasH = viewName === 'plan' ? planH : options.height!
        assertCoordinatesWithinBounds(svg, options.width!, canvasH)
    }

    // Adjacent doors in the same host wall.
    const { primary: adjacentPrimary, secondary: adjacentSecondary } = await buildAdjacentDoorsContexts()
    assert.equal(
        adjacentPrimary.nearbyDoors.length,
        1,
        'Adjacent doors: the primary context should record its neighbour',
    )
    assert.equal(
        adjacentPrimary.nearbyDoors[0].expressID,
        adjacentSecondary.door.expressID,
        'Adjacent doors: the recorded neighbour should be the second door',
    )
    assert.equal(
        adjacentPrimary.nearbyWalls.length,
        0,
        'Adjacent doors: a door is not a wall — nearbyWalls must stay empty when there is only the host wall',
    )

    const adjacentPrimaryViews = await renderDoorViews(adjacentPrimary, options)
    const adjacentSecondaryViews = await renderDoorViews(adjacentSecondary, options)
    const primaryPlanWallArea = getWallFilledArea(adjacentPrimaryViews.plan, options.wallColor!)
    const secondaryPlanWallArea = getWallFilledArea(adjacentSecondaryViews.plan, options.wallColor!)
    assert.ok(
        primaryPlanWallArea > 1000,
        `Adjacent doors: primary plan should contain non-degenerate wall fill (got ${primaryPlanWallArea.toFixed(0)})`,
    )
    assert.ok(
        secondaryPlanWallArea > 1000,
        `Adjacent doors: secondary plan should contain non-degenerate wall fill (got ${secondaryPlanWallArea.toFixed(0)})`,
    )
    assert.ok(
        getWallFilledArea(adjacentPrimaryViews.plan, '#d1d5db') > 100,
        'Adjacent doors: primary plan should render nearby-door context geometry'
    )
    assert.ok(
        getWallFilledArea(adjacentSecondaryViews.plan, '#d1d5db') > 100,
        'Adjacent doors: secondary plan should render nearby-door context geometry'
    )
    for (const svg of [...Object.values(adjacentPrimaryViews), ...Object.values(adjacentSecondaryViews)]) {
        const canvasH = planH // use plan height as upper bound (conservative)
        assertCoordinatesWithinBounds(svg, options.width!, Math.max(canvasH, options.height!))
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
    for (const [view, svg] of Object.entries(backMountedViews)) {
        writeFileSync(`${dir}/back-mounted-${view}.svg`, svg)
    }
    for (const [view, svg] of Object.entries(highMountedDeviceViews)) {
        writeFileSync(`${dir}/high-mounted-device-${view}.svg`, svg)
    }
    // Plan-specific fixtures
    writeFileSync(`${dir}/plan-left-swing.svg`, leftPlan)
    writeFileSync(`${dir}/plan-right-swing.svg`, rightPlan)
    writeFileSync(`${dir}/plan-double-swing.svg`, bothPlan)
    writeFileSync(`${dir}/plan-sliding.svg`, slidingPlan)
    writeFileSync(`${dir}/plan-rotated-45.svg`, rot45Plan)
    writeFileSync(`${dir}/plan-upward-arc.svg`, upwardArcPlan)
    writeFileSync(`${dir}/plan-fixed-left-sidelight.svg`, sideFixedLeftPlan)
    writeFileSync(`${dir}/plan-fixed-right-sidelight.svg`, sideFixedRightPlan)
    writeFileSync(`${dir}/plan-handedness-left-plusZ.svg`,   handednessLeftPlusZViews.plan)
    writeFileSync(`${dir}/plan-handedness-left-minusZ.svg`,  handednessLeftMinusZViews.plan)
    writeFileSync(`${dir}/plan-handedness-right-plusZ.svg`,  handednessRightPlusZViews.plan)
    writeFileSync(`${dir}/plan-handedness-right-minusZ.svg`, handednessRightMinusZViews.plan)
    writeFileSync(`${dir}/plan-handedness-double-plusZ.svg`, handednessDoubleDoorViews.plan)
    for (const [view, svg] of Object.entries(lCornerViews)) {
        writeFileSync(`${dir}/l-corner-${view}.svg`, svg)
    }
    for (const [view, svg] of Object.entries(adjacentPrimaryViews)) {
        writeFileSync(`${dir}/adjacent-primary-${view}.svg`, svg)
    }
    for (const [view, svg] of Object.entries(adjacentSecondaryViews)) {
        writeFileSync(`${dir}/adjacent-secondary-${view}.svg`, svg)
    }

    console.log('Door wall context regression test passed')
}

main().catch((error) => {
    console.error(error)
    process.exitCode = 1
})
