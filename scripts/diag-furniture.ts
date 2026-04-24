import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import * as THREE from 'three'
import { loadIFCModelWithMetadata } from '../lib/ifc-loader'
function loadIfcFile(p: string): File { return new File([readFileSync(p)], basename(p), { type: 'application/octet-stream' }) }
async function main() {
    const arch = resolve(process.env.ARCH_IFC_PATH ?? 'Flu21_A_AR_51_ARM_0000_A-AR-0000-0001_260402.ifc')
    const model = await loadIFCModelWithMetadata(loadIfcFile(arch))
    const origin = new THREE.Vector3(119.75, -1.77, -25.75) // 0tozBW6 door origin
    const types = new Map<string, number>()
    let nearFurniture = 0
    const nearSamples: any[] = []
    for (const el of (model.elements as any[])) {
        const tn = (el.typeName || '').toUpperCase()
        types.set(tn, (types.get(tn) ?? 0) + 1)
        if (!tn.includes('FURNIT')) continue
        if (!el.boundingBox) continue
        const c = el.boundingBox.getCenter(new THREE.Vector3())
        const dist = c.distanceTo(origin)
        if (dist < 6) {
            nearFurniture++
            nearSamples.push({ eid: el.expressID, name: el.name, type: tn, dist: dist.toFixed(2),
                bbox: `x=[${el.boundingBox.min.x.toFixed(2)},${el.boundingBox.max.x.toFixed(2)}] y=[${el.boundingBox.min.y.toFixed(2)},${el.boundingBox.max.y.toFixed(2)}] z=[${el.boundingBox.min.z.toFixed(2)},${el.boundingBox.max.z.toFixed(2)}]` })
        }
    }
    console.log('Element types with FURNIT:', [...types.entries()].filter(([t]) => t.includes('FURNIT')))
    console.log('IfcFurniture within 6m of 0tozBW6 door:', nearFurniture)
    for (const s of nearSamples) console.log(' ', s)
}
main().catch(e => { console.error(e); process.exit(1) })
