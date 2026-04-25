import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { renderDoorsFromIfc } from '../lib/door-render-pipeline'

async function main() {
    const arch = resolve(process.env.ARCH ?? 'Flu21_A_AR_51_ARM_0000_A-AR-0000-0001_260421.ifc')
    const elec = process.env.ELEC ? resolve(process.env.ELEC) : null
    const guid = process.env.GUID ?? '0TwHxk1LHcHfwGMcoYgLi'
    // process.env.DEBUG_EDGE_COLORS = '1'
    const result = await renderDoorsFromIfc({ archIfcPath: arch, elecIfcPath: elec }, [guid], ['front', 'back'])
    const outDir = resolve('test-output/diag-back-line')
    mkdirSync(outDir, { recursive: true })
    for (const [g, d] of result.rendered) {
        writeFileSync(`${outDir}/${g}-front.svg`, d.svg.front, 'utf8')
        writeFileSync(`${outDir}/${g}-back.svg`, d.svg.back, 'utf8')
        console.log(`wrote ${outDir}/${g}-{front,back}.svg`)
    }
    if (result.notInIfc.length) console.log('notInIfc:', result.notInIfc)
}
main().catch((e) => { console.error(e); process.exit(1) })
