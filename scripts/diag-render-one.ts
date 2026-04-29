/**
 * Render a single door with the live pipeline. Writes SVG/PNG into
 * test-output/diag-render/<guid>-{front,back,plan}.{svg,png} and prints
 * the device count + GUIDs for sanity-check vs Airtable image.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderDoorsFromIfc } from '../lib/door-render-pipeline'

async function main() {
    const guid = process.env.GUID
    if (!guid) throw new Error('GUID env required')
    const arch = resolve(process.env.ARCH_IFC_PATH ?? '')
    const elec = process.env.ELEC_IFC_PATH ? resolve(process.env.ELEC_IFC_PATH) : null
    if (!arch) throw new Error('ARCH_IFC_PATH required')

    const out = resolve('test-output/diag-render')
    mkdirSync(out, { recursive: true })

    const result = await renderDoorsFromIfc(
        { archIfcPath: arch, elecIfcPath: elec },
        [guid],
        ['front', 'back', 'plan'],
    )
    for (const [g, d] of result.rendered) {
        const safe = g.replace(/[\$\/]/g, '_')
        for (const v of ['front', 'back', 'plan'] as const) {
            const svg = (d.svg as any)[v]
            if (svg) writeFileSync(`${out}/${safe}-${v}.svg`, svg, 'utf8')
            const png = (d.png as any)?.[v]
            if (png) writeFileSync(`${out}/${safe}-${v}.png`, png)
        }
        console.log(`wrote ${safe}-{front,back,plan}.{svg,png}`)
        console.log(`devices: ${d.context.nearbyDevices.length} — ${d.context.nearbyDevices.map((x: any) => x.globalId + '/' + x.typeName + '/' + (x.name ?? '')).join(' | ')}`)
    }
    if (result.notInIfc.length) console.log('notInIfc:', result.notInIfc)
}
main().catch((e) => { console.error(e); process.exit(1) })
