import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import * as THREE from 'three'
import { loadIFCModelWithMetadata, extractDoorOperationTypes, extractDoorCsetStandardCH } from '../lib/ifc-loader'
import { analyzeDoors, loadDetailedGeometry } from '../lib/door-analyzer'
import { renderDoorViews, type SVGRenderOptions } from '../lib/svg-renderer'

const DEFAULT_IFC = resolve(process.cwd(), '01_BIMcollab_Example_ARC.ifc')
const OUTPUT_DIR = resolve(process.cwd(), 'test-output', 'real-ifc')
const TARGET_DOOR_IDS = [
    '0yeZSZRUW0IfFY9zGbBsQq',
    '3cj1ZB_n8uluASwh0q2BbP',
]

async function main() {
    const filePath = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_IFC
    const fileBuffer = readFileSync(filePath)
    const file = new File([fileBuffer], basename(filePath), { type: 'application/octet-stream' })

    console.log(`Loading IFC: ${filePath}`)
    const model = await loadIFCModelWithMetadata(file)
    const operationTypeMap = await extractDoorOperationTypes(file)
    const csetStandardCHMap = await extractDoorCsetStandardCH(file)
    const contexts = await analyzeDoors(model, undefined, undefined, operationTypeMap, csetStandardCHMap)

    await loadDetailedGeometry(contexts, file, new THREE.Vector3(0, 0, 0))

    const options: SVGRenderOptions = {
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

    const selected = contexts.filter((context) => TARGET_DOOR_IDS.includes(context.doorId))
    const fallback = selected.length > 0
        ? selected
        : contexts.filter((context) => context.openingDirection).slice(0, 5)

    mkdirSync(OUTPUT_DIR, { recursive: true })

    console.log(`Rendering ${fallback.length} door(s)`)
    for (const context of fallback) {
        const { front, back, plan } = await renderDoorViews(context, options)
        const prefix = resolve(OUTPUT_DIR, context.doorId)
        writeFileSync(`${prefix}-front.svg`, front)
        writeFileSync(`${prefix}-back.svg`, back)
        writeFileSync(`${prefix}-plan.svg`, plan)
        console.log(
            JSON.stringify({
                doorId: context.doorId,
                openingDirection: context.openingDirection,
                typeName: context.doorTypeName,
                placementYAxis: context.door.placementYAxis?.toArray() ?? null,
                semanticFacing: context.viewFrame.semanticFacing.toArray(),
                output: `${prefix}-plan.svg`,
            })
        )
    }
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
