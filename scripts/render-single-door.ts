import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import * as THREE from 'three'
import { analyzeDoors, loadDetailedGeometry } from '../lib/door-analyzer'
import {
    extractDoorCsetStandardCH,
    extractDoorHostRelationships,
    extractDoorLeafMetadata,
    extractDoorOperationTypes,
    extractSlabAggregateParts,
    loadIFCModelWithMetadata,
} from '../lib/ifc-loader'
import { renderDoorViews } from '../lib/svg-renderer'

function loadIfcFile(filePath: string): File {
    const buffer = readFileSync(filePath)
    return new File([buffer], basename(filePath), { type: 'application/octet-stream' })
}

async function main() {
    const guids = (process.argv[2] || '').split(',').filter(Boolean)
    if (guids.length === 0) {
        console.error('usage: node scripts/render-single-door-runner.js GUID1,GUID2')
        process.exit(1)
    }
    const outDir = resolve(process.cwd(), 'test-output/single-door-review')
    mkdirSync(outDir, { recursive: true })

    const primary = resolve(process.cwd(), 'Flu21_A_AR_51_ARM_0000_A-AR-0000-0001_260402.ifc')
    const elec = process.env.ELEC_IFC_PATH ? resolve(process.cwd(), process.env.ELEC_IFC_PATH) : undefined
    const file = loadIfcFile(primary)
    const elecFile = elec ? loadIfcFile(elec) : undefined
    const model = await loadIFCModelWithMetadata(file)
    const secondaryModel = elecFile ? await loadIFCModelWithMetadata(elecFile) : undefined
    const [ops, leaves, csets, slabParts, hostRels] = await Promise.all([
        extractDoorOperationTypes(file),
        extractDoorLeafMetadata(file),
        extractDoorCsetStandardCH(file),
        extractSlabAggregateParts(file),
        extractDoorHostRelationships(file),
    ])
    const doors = await analyzeDoors(model, secondaryModel, undefined, ops, csets, leaves, hostRels, slabParts)

    for (const guid of guids) {
        const d = doors.find(x => x.doorId === guid)
        if (!d) {
            console.warn('Skip', guid, '(not found)')
            continue
        }
        await loadDetailedGeometry([d], file, new THREE.Vector3(0, 0, 0), elecFile)
        const views = await renderDoorViews(d, { width: 1000, height: 500 })
        const safe = guid.replace(/\$/g, '')
        const dir = resolve(outDir, safe)
        mkdirSync(dir, { recursive: true })
        writeFileSync(resolve(dir, 'plan.svg'), views.plan)
        writeFileSync(resolve(dir, 'front.svg'), views.front)
        writeFileSync(resolve(dir, 'back.svg'), views.back)
        console.log('Wrote', dir)
    }
}
main().catch(err => { console.error(err); process.exit(1) })
