import * as assert from 'node:assert/strict'
import * as THREE from 'three'
import { renderDoorViews, type SVGRenderOptions } from '../lib/svg-renderer'
import { analyzeDoors, type DoorContext } from '../lib/door-analyzer'
import type { ElementInfo, LoadedIFCModel } from '../lib/ifc-types'

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

function createRotatedBoxMesh(
    expressID: number,
    width: number,
    height: number,
    depth: number,
    center: THREE.Vector3,
    rotationY: number
): THREE.Mesh {
    const geometry = new THREE.BoxGeometry(width, height, depth)
    geometry.rotateY(rotationY)
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

function buildContext(includeWall: boolean): DoorContext {
    const doorMesh = createBoxMesh(1, 1, 2.1, 0.12, new THREE.Vector3(0, 1.05, 0))
    const wallMesh = createBoxMesh(2, 40, 3, 0.24, new THREE.Vector3(0, 1.5, 0))
    const deviceMesh = createBoxMesh(3, 0.12, 0.12, 0.08, new THREE.Vector3(0.7, 1.1, 0.08))

    const door = makeElement(1, 'IFCDOOR', doorMesh)
    const hostWall = makeElement(2, 'IFCWALL', wallMesh)
    const device = makeElement(3, 'IFCELECTRICAPPLIANCE', deviceMesh)

    return {
        door,
        wall: null,
        hostWall: includeWall ? hostWall : null,
        nearbyDevices: [device],
        normal: new THREE.Vector3(0, 0, 1),
        center: door.boundingBox!.getCenter(new THREE.Vector3()),
        doorId: 'Door-1',
        openingDirection: 'SINGLE_SWING_LEFT',
        doorTypeName: 'Mock Door Type',
        storeyName: 'Level 01',
        detailedGeometry: {
            doorMeshes: [doorMesh],
            wallMeshes: includeWall ? [wallMesh] : [],
            deviceMeshes: [deviceMesh],
        },
    }
}

async function main() {
    const options: SVGRenderOptions = {
        width: 1000,
        height: 1000,
        margin: 0.5,
        doorColor: '#111111',
        wallColor: '#777777',
        deviceColor: '#cc0000',
        lineColor: '#000000',
        showFills: true,
        showLegend: true,
        showLabels: true,
    }

    const withWall = buildContext(true)
    const withoutWall = buildContext(false)

    const withWallViews = await renderDoorViews(withWall, options)
    const withoutWallViews = await renderDoorViews(withoutWall, options)

    for (const [viewName, svg] of Object.entries(withWallViews)) {
        assert.ok(svg.includes(options.wallColor!), `${viewName} SVG is missing wall-colored geometry`)
        assert.ok(svg.includes('Wand'), `${viewName} SVG is missing the wall legend item`)
        assertCoordinatesWithinBounds(svg, options.width!, options.height!)
    }

    for (const viewName of ['front', 'back', 'plan'] as const) {
        const doorPathsWithWall = extractPathDataByFill(withWallViews[viewName], options.doorColor!)
        const doorPathsWithoutWall = extractPathDataByFill(withoutWallViews[viewName], options.doorColor!)
        assert.deepEqual(
            doorPathsWithWall,
            doorPathsWithoutWall,
            `${viewName} door fill geometry changed when wall context was added`
        )
    }

    const shiftedBoundsContext = buildContext(false)
    shiftedBoundsContext.center = shiftedBoundsContext.center.clone().add(new THREE.Vector3(5, 0, 0))
    shiftedBoundsContext.door.boundingBox = shiftedBoundsContext.door.boundingBox!.clone().translate(new THREE.Vector3(5, 0, 0))

    const baselineFront = await renderDoorViews(withoutWall, options)
    const shiftedFront = await renderDoorViews(shiftedBoundsContext, options)

    for (const viewName of ['front', 'back'] as const) {
        const baselineDoorPaths = extractPathDataByFill(baselineFront[viewName], options.doorColor!)
        const shiftedDoorPaths = extractPathDataByFill(shiftedFront[viewName], options.doorColor!)
        assert.deepEqual(
            shiftedDoorPaths,
            baselineDoorPaths,
            `${viewName} elevation changed when only fragment-space bounds were shifted`
        )
    }

    const rotatedDoorMesh = createRotatedBoxMesh(10, 1, 2.1, 0.12, new THREE.Vector3(0, 1.05, 0), Math.PI / 4)
    const rotatedDoor = makeElement(10, 'IFCDOOR', rotatedDoorMesh)
    const rotatedModel: LoadedIFCModel = {
        group: new THREE.Group(),
        elements: [rotatedDoor],
        modelID: 0,
        api: null,
    }
    ;(rotatedModel as LoadedIFCModel & { fragmentsModel: { getItemsData: () => Promise<unknown[]> } }).fragmentsModel = {
        getItemsData: async () => [],
    }
    const [rotatedContext] = await analyzeDoors(rotatedModel)
    assert.ok(rotatedContext, 'Rotated door should produce a door context')

    const expectedNormal = new THREE.Vector3(Math.SQRT1_2, 0, Math.SQRT1_2)
    const normalAlignment = Math.abs(rotatedContext.normal.clone().normalize().dot(expectedNormal))
    assert.ok(normalAlignment > 0.95, `Rotated door normal should follow mesh orientation, got ${rotatedContext.normal.toArray().join(', ')}`)

    console.log('Door wall context SVG test passed')
}

main().catch((error) => {
    console.error(error)
    process.exitCode = 1
})
