import * as assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { buildDoorContextsFromIfcState, loadAnalysisModelWithOffset } from '../lib/door-context-pipeline'
import { renderDoorPlanSVG, type SVGRenderOptions } from '../lib/svg-renderer'

const DEFAULT_PRIMARY_IFC = resolve(process.cwd(), 'Flu21_A_AR_51_ARM_0000_A-AR-0000-0001_260402.ifc')
const DEFAULT_SECONDARY_IFC = resolve(process.cwd(), 'Flu21_A_EL_51_ELM_0000_A-EL-2300-0001_IFC Elektro.ifc')
const DEFAULT_DOOR_ID = '1GC8_IDRe1IBG36pAeR$YB'
const DEFAULT_OUTPUT_DIR = resolve(process.cwd(), 'test-output', 'single-door-plan')

type Args = {
    primaryIfcPath: string
    secondaryIfcPath?: string
    doorId: string
    outputDir: string
}

function parseArgs(argv: string[]): Args {
    let primaryIfcPath = DEFAULT_PRIMARY_IFC
    let secondaryIfcPath: string | undefined = DEFAULT_SECONDARY_IFC
    let doorId = DEFAULT_DOOR_ID
    let outputDir = DEFAULT_OUTPUT_DIR

    for (const arg of argv) {
        if (arg.startsWith('--secondary=')) {
            const value = arg.slice('--secondary='.length)
            secondaryIfcPath = value ? resolve(value) : undefined
        } else if (arg === '--no-secondary') {
            secondaryIfcPath = undefined
        } else if (arg.startsWith('--door=')) {
            doorId = arg.slice('--door='.length)
        } else if (arg.startsWith('--out-dir=')) {
            outputDir = resolve(arg.slice('--out-dir='.length))
        } else if (!arg.startsWith('--')) {
            primaryIfcPath = resolve(arg)
        } else {
            throw new Error(`Unknown argument: ${arg}`)
        }
    }

    return { primaryIfcPath, secondaryIfcPath, doorId, outputDir }
}

function loadIfcFile(filePath: string): File {
    const buffer = readFileSync(filePath)
    return new File([buffer], basename(filePath), { type: 'application/octet-stream' })
}

async function main() {
    const { primaryIfcPath, secondaryIfcPath, doorId, outputDir } = parseArgs(process.argv.slice(2))

    console.log(`Primary IFC: ${primaryIfcPath}`)
    if (secondaryIfcPath) {
        console.log(`Secondary IFC: ${secondaryIfcPath}`)
    }
    console.log(`Target door: ${doorId}`)

    const primaryFile = loadIfcFile(primaryIfcPath)
    const secondaryFile = secondaryIfcPath ? loadIfcFile(secondaryIfcPath) : undefined

    const { model: primaryModel, modelCenterOffset } = await loadAnalysisModelWithOffset(primaryFile)
    const secondaryModel = secondaryFile
        ? (await loadAnalysisModelWithOffset(secondaryFile, { modelCenterOffset })).model
        : undefined

    const { contexts, operationTypeMap, csetStandardCHMap, doorLeafMetadataMap } = await buildDoorContextsFromIfcState({
        primaryFile,
        primaryModel,
        secondaryFile,
        secondaryModel,
        detailedGeometryOffset: modelCenterOffset,
    })

    const context = contexts.find((candidate) => candidate.doorId === doorId)
    assert.ok(context, `Door ${doorId} not found in ${primaryIfcPath}`)

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

    const plan = await renderDoorPlanSVG(context, options)
    mkdirSync(outputDir, { recursive: true })

    const safeDoorId = doorId.replace(/[^A-Za-z0-9._-]/g, '_')
    const svgPath = resolve(outputDir, `${safeDoorId}-plan.svg`)
    const jsonPath = resolve(outputDir, `${safeDoorId}-plan.json`)

    writeFileSync(svgPath, plan)
    writeFileSync(
        jsonPath,
        `${JSON.stringify({
            doorId: context.doorId,
            doorTypeName: context.doorTypeName,
            openingDirection: context.openingDirection,
            operationTypeFromMap: operationTypeMap.get(context.door.expressID) ?? null,
            storeyName: context.storeyName,
            nearbyDeviceCount: context.nearbyDevices.length,
            viewFrame: {
                origin: context.viewFrame.origin.toArray(),
                widthAxis: context.viewFrame.widthAxis.toArray(),
                semanticFacing: context.viewFrame.semanticFacing.toArray(),
                width: context.viewFrame.width,
                thickness: context.viewFrame.thickness,
                height: context.viewFrame.height,
            },
            extractedLeafMetadata: doorLeafMetadataMap.get(context.door.expressID) ?? null,
            extractedCsetStandardCH: csetStandardCHMap.get(context.door.expressID) ?? null,
            csetStandardCH: context.csetStandardCH ?? null,
            operableLeaves: context.operableLeaves ?? null,
        }, null, 2)}\n`
    )

    console.log('')
    console.log(JSON.stringify({
        doorId: context.doorId,
        openingDirection: context.openingDirection,
        doorTypeName: context.doorTypeName,
        operableLeaves: context.operableLeaves ?? null,
        svgPath,
        jsonPath,
    }, null, 2))
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
