import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import * as THREE from 'three'
import { renderDoorsFromIfc } from '../lib/door-render-pipeline'
async function main() {
    const arch = resolve('Flu21_A_AR_51_ARM_0000_A-AR-0000-0001_260421.ifc')
    const elec = process.env.ELEC_IFC_PATH ? resolve(process.env.ELEC_IFC_PATH) : null
    const guids = ['0mwF46yfqRIwqBusMoSrol', '03Ah7HRzUIIeuVgQx_ZYlw', '0e50GpbNxsIR1BKz1EYai9', '12fPAfQpJDIhh1eETtqs15']
    const result = await renderDoorsFromIfc({ archIfcPath: arch, elecIfcPath: elec }, guids, [])
    for (const guid of guids) {
        const door = result.rendered.get(guid)
        if (!door) continue
        const ctx = door.context
        console.log(`${guid} storey=${ctx.storeyName}  storeyElevation=${ctx.storeyElevation}  origin.y=${ctx.viewFrame.origin.y.toFixed(3)}  doorBottom=${(ctx.viewFrame.origin.y - ctx.viewFrame.height / 2).toFixed(3)}`)
    }
}
main().catch((e) => { console.error(e); process.exit(1) })
