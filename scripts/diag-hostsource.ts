import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import * as THREE from 'three'
import { analyzeDoors } from '../lib/door-analyzer'
import {
    extractDoorAnalyzerSidecarMaps,
    extractDoorHostRelationships,
    extractDoorLeafMetadata,
    extractSlabAggregateParts,
    loadIFCModelWithMetadata,
} from '../lib/ifc-loader'
function loadIfcFile(p: string): File { return new File([readFileSync(p)], basename(p), { type: 'application/octet-stream' }) }
async function main() {
    const arch = resolve(process.env.ARCH_IFC_PATH ?? 'Flu21_A_AR_51_ARM_0000_A-AR-0000-0001_260402.ifc')
    const archFile = loadIfcFile(arch)
    const model = await loadIFCModelWithMetadata(archFile)
    const { operationTypeMap, csetStandardCHMap, wallAggregatePartMap } = await extractDoorAnalyzerSidecarMaps(archFile)
    const doorLeafMetadataMap = await extractDoorLeafMetadata(archFile)
    const hostRelationshipMap = await extractDoorHostRelationships(archFile)
    const slabAggregatePartMap = await extractSlabAggregateParts(archFile)
    const contexts = await analyzeDoors(model, undefined, undefined, operationTypeMap, csetStandardCHMap, doorLeafMetadataMap, hostRelationshipMap, slabAggregatePartMap, wallAggregatePartMap)
    for (const guid of ['0rcDhkErfjJ9px01Ab_sgY', '3rHkFkTPPyIhdsnM91YiTi', '0tozBW6IrhHAbVXTAM4jd$']) {
        const ctx = contexts.find(c => c.doorId === guid)
        if (!ctx) { console.log(guid, 'NOT FOUND'); continue }
        const f = ctx.viewFrame
        const wa = f.widthAxis, ua = f.upAxis, sa = f.semanticFacing
        console.log(guid)
        console.log('  hostSource=', (ctx as any).diagnostics?.hostSource, 'relationHostEID=', (ctx as any).diagnostics?.relationHostExpressID)
        console.log('  hostWall.eid=', ctx.hostWall?.expressID, 'hostWall.guid=', ctx.hostWall?.globalId)
        console.log('  widthAxis=', wa.toArray().map(v => v.toFixed(2)).join(','), ' upAxis=', ua.toArray().map(v => v.toFixed(2)).join(','), ' semanticFacing=', sa.toArray().map(v => v.toFixed(2)).join(','))
        console.log('  door.width=', f.width.toFixed(2), 'height=', f.height.toFixed(2), 'thickness=', f.thickness.toFixed(2))
        if (ctx.hostWall?.boundingBox) {
            const bb = ctx.hostWall.boundingBox
            const ax = bb.max.x - bb.min.x, ay = bb.max.y - bb.min.y, az = bb.max.z - bb.min.z
            console.log('  hostWall world size: x=', ax.toFixed(2), 'y=', ay.toFixed(2), 'z=', az.toFixed(2))
        }
    }
}
main().catch(e => { console.error(e); process.exit(1) })
