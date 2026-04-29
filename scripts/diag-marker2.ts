import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import * as THREE from 'three'
import { renderDoorsFromIfc } from '../lib/door-render-pipeline'
async function main() {
    const arch = resolve('Flu21_A_AR_51_ARM_0000_A-AR-0000-0001_260421.ifc')
    const result = await renderDoorsFromIfc({ archIfcPath: arch, elecIfcPath: null }, ['0TwHxk1LHcHfwGMcoYgLi_'], [])
    for (const [guid, door] of result.rendered) {
        const ctx = door.context
        const f = ctx.viewFrame
        console.log(`${guid}`)
        console.log(`  storey=${ctx.storeyName}`)
        console.log(`  storeyElevation=${ctx.storeyElevation}`)
        console.log(`  origin.y=${f.origin.y.toFixed(3)}`)
        console.log(`  doorBottom=${(f.origin.y - f.height/2).toFixed(3)}`)
        console.log(`  doorTop=${(f.origin.y + f.height/2).toFixed(3)}`)
        console.log(`  markerLevelOffset = storeyElevation - origin.y = ${(ctx.storeyElevation! - f.origin.y).toFixed(3)}`)
    }
}
main().catch((e) => { console.error(e); process.exit(1) })
