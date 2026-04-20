/* eslint-disable */
const { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } = require('node:fs')
const { join } = require('node:path')
const { Resvg } = require('@resvg/resvg-js')

const SRC_ROOT = join(process.cwd(), 'test-output/zgso-guid-review')
const OUT_DIR = '/tmp/svg-pngs'
mkdirSync(OUT_DIR, { recursive: true })

const guids = readdirSync(SRC_ROOT).filter((name) => {
    const p = join(SRC_ROOT, name, 'rendered')
    try { return statSync(p).isDirectory() } catch { return false }
})

let written = 0
for (const guid of guids) {
    const safe = guid.replace(/[^A-Za-z0-9_-]/g, '_')
    for (const view of ['plan', 'front', 'back']) {
        const svgPath = join(SRC_ROOT, guid, 'rendered', `${view}.svg`)
        try {
            const svg = readFileSync(svgPath, 'utf8')
            const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: 1400 } })
            const png = resvg.render().asPng()
            const outPath = join(OUT_DIR, `${safe}__${view}.png`)
            writeFileSync(outPath, png)
            written++
        } catch (err) {
            console.error(`Skip ${guid}/${view}: ${err.message}`)
        }
    }
}
console.log(`Wrote ${written} PNG(s) to ${OUT_DIR}`)
