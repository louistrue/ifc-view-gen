const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { Resvg } = require('@resvg/resvg-js')
const dir = process.argv[2]
if (!dir) { console.error('usage: node scripts/render-svg-to-png.js <dir>'); process.exit(1) }
for (const view of ['plan', 'front', 'back']) {
    const svgPath = join(dir, `${view}.svg`)
    try {
        const svg = readFileSync(svgPath, 'utf8')
        const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1400 } }).render().asPng()
        writeFileSync(join(dir, `${view}.png`), png)
        console.log('Wrote', view, 'PNG')
    } catch (e) { console.error('skip', view, e.message) }
}
