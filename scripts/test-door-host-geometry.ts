import * as assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as THREE from 'three'
import { analyzeDoors, type DoorContext } from '../lib/door-analyzer'
import type { ElementInfo, LoadedIFCModel } from '../lib/ifc-types'
import { renderDoorViews, type SVGRenderOptions } from '../lib/svg-renderer'

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

async function buildContext(): Promise<DoorContext> {
    return buildContextVariant({})
}

async function buildContextVariant(options: {
    includeLeftJamb?: boolean
    includeRightJamb?: boolean
    includeLintel?: boolean
    perpendicularReturnDepth?: number
}): Promise<DoorContext> {
    const {
        includeLeftJamb = true,
        includeRightJamb = true,
        includeLintel = true,
        perpendicularReturnDepth = 0,
    } = options
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
    const perpendicularReturn = perpendicularReturnDepth > 0
        ? createBoxMesh(
            2,
            wallThickness,
            wallHeight,
            perpendicularReturnDepth,
            new THREE.Vector3(-openingWidth / 2 + wallThickness / 2, wallHeight / 2, perpendicularReturnDepth / 2)
        )
        : null
    const wallMeshes = [
        ...(includeLeftJamb ? [leftJamb] : []),
        ...(includeRightJamb ? [rightJamb] : []),
        ...(includeLintel ? [lintel] : []),
        ...(perpendicularReturn ? [perpendicularReturn] : []),
    ]

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
        deviceMeshes: [],
    }
    return context
}

type BBox2D = { minX: number; minY: number; maxX: number; maxY: number }

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
            minX: Math.min(...points.map((point) => point.x)),
            minY: Math.min(...points.map((point) => point.y)),
            maxX: Math.max(...points.map((point) => point.x)),
            maxY: Math.max(...points.map((point) => point.y)),
        })
    }
    return boxes
}

function combineBoxes(boxes: BBox2D[]): BBox2D {
    assert.ok(boxes.length > 0, 'Expected at least one box')
    return {
        minX: Math.min(...boxes.map((box) => box.minX)),
        minY: Math.min(...boxes.map((box) => box.minY)),
        maxX: Math.max(...boxes.map((box) => box.maxX)),
        maxY: Math.max(...boxes.map((box) => box.maxY)),
    }
}

function overlapsVertically(a: BBox2D, b: BBox2D): boolean {
    return Math.min(a.maxY, b.maxY) > Math.max(a.minY, b.minY)
}

async function main() {
    const options: SVGRenderOptions = {
        width: 1000,
        height: 1000,
        margin: 0.5,
        doorColor: '#111111',
        wallColor: '#777777',
        lineColor: '#000000',
        showFills: true,
        showLegend: false,
        showLabels: false,
    }

    const context = await buildContext()
    const views = await renderDoorViews(context, options)

    const outputDir = path.join(process.cwd(), 'test-output', 'host-geometry-debug')
    fs.mkdirSync(outputDir, { recursive: true })
    fs.writeFileSync(path.join(outputDir, 'front.svg'), views.front)
    fs.writeFileSync(path.join(outputDir, 'back.svg'), views.back)
    fs.writeFileSync(path.join(outputDir, 'plan.svg'), views.plan)

    const planDoorBox = combineBoxes(getPathBBoxesByFill(views.plan, options.doorColor!))
    const planWallBox = combineBoxes(getPathBBoxesByFill(views.plan, options.wallColor!))
    const wallThicknessPx = planWallBox.maxY - planWallBox.minY
    const doorThicknessPx = planDoorBox.maxY - planDoorBox.minY
    const frontGapPx = planDoorBox.minY - planWallBox.minY
    const backGapPx = planWallBox.maxY - planDoorBox.maxY

    assert.ok(wallThicknessPx > doorThicknessPx * 1.5, `Expected wall thickness (${wallThicknessPx.toFixed(2)}px) to exceed door thickness (${doorThicknessPx.toFixed(2)}px)`)
    assert.ok(Math.abs(frontGapPx - backGapPx) > 8, `Expected door to sit off-center within wall thickness, gaps were ${frontGapPx.toFixed(2)}px and ${backGapPx.toFixed(2)}px`)

    const frontDoorBox = combineBoxes(getPathBBoxesByFill(views.front, options.doorColor!))
    const frontWallBoxes = getPathBBoxesByFill(views.front, options.wallColor!)
    const lintelBox = frontWallBoxes
        .filter((box) => (box.maxX - box.minX) > (frontDoorBox.maxX - frontDoorBox.minX) * 0.8)
        .sort((a, b) => (b.maxX - b.minX) - (a.maxX - a.minX))[0]

    assert.ok(lintelBox, 'Expected a top wall/slab band above the door')
    const slabGapPx = frontDoorBox.minY - lintelBox.maxY
    assert.ok(slabGapPx > 8, `Expected visible gap between slab bottom and door top, got ${slabGapPx.toFixed(2)}px`)

    const missingLeftContext = await buildContextVariant({ includeLeftJamb: false })
    const missingLeftViews = await renderDoorViews(missingLeftContext, options)
    const missingLeftDoorBox = combineBoxes(getPathBBoxesByFill(missingLeftViews.front, options.doorColor!))
    const missingLeftWallBoxes = getPathBBoxesByFill(missingLeftViews.front, options.wallColor!)
    const leftSideWallBox = missingLeftWallBoxes.find((box) =>
        box.maxX < missingLeftDoorBox.minX - 4 &&
        overlapsVertically(box, missingLeftDoorBox)
    )
    assert.ok(!leftSideWallBox, 'Did not expect a left wall band when there is no left adjacent wall material')

    const perpendicularReturnContext = await buildContextVariant({ perpendicularReturnDepth: 3 })
    const perpendicularReturnViews = await renderDoorViews(perpendicularReturnContext, options)
    const perpendicularPlanDoorBox = combineBoxes(getPathBBoxesByFill(perpendicularReturnViews.plan, options.doorColor!))
    const perpendicularPlanWallBox = combineBoxes(getPathBBoxesByFill(perpendicularReturnViews.plan, options.wallColor!))
    const scalePxPerMeter = (perpendicularPlanDoorBox.maxY - perpendicularPlanDoorBox.minY) / 0.08
    const perpendicularWallThicknessPx = perpendicularPlanWallBox.maxY - perpendicularPlanWallBox.minY
    assert.ok(
        perpendicularWallThicknessPx <= scalePxPerMeter * 1.05,
        `Expected perpendicular wall return to be cropped near 1m, got ${perpendicularWallThicknessPx.toFixed(2)}px at ${scalePxPerMeter.toFixed(2)} px/m`
    )

    console.info('Standalone host geometry test passed.', {
        outputDir,
        wallThicknessPx,
        doorThicknessPx,
        frontGapPx,
        backGapPx,
        slabGapPx,
    })
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
