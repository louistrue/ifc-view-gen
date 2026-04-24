import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { loadIFCModelWithMetadata } from '../lib/ifc-loader'

function loadIfcFile(p: string): File {
    return new File([readFileSync(p)], basename(p), { type: 'application/octet-stream' })
}

async function main() {
    const token = process.env.AIRTABLE_TOKEN!
    const baseId = process.env.AIRTABLE_BASE_ID!
    const table = process.env.AIRTABLE_TABLE_NAME ?? 'Doors'

    const arch = resolve(process.env.ARCH_IFC_PATH ?? 'Flu21_A_AR_51_ARM_0000_A-AR-0000-0001_260402.ifc')
    const model = await loadIFCModelWithMetadata(loadIfcFile(arch))
    const ifcDoors = new Set<string>()
    for (const el of model.elements) {
        if ((el.typeName || '').toUpperCase() === 'IFCDOOR' && typeof el.globalId === 'string') ifcDoors.add(el.globalId)
    }

    const all: any[] = []
    let offset: string | undefined
    do {
        const url = new URL(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`)
        url.searchParams.set('pageSize', '100')
        url.searchParams.set('filterByFormula', "NOT({Valid}='yes')")
        if (offset) url.searchParams.set('offset', offset)
        const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
        const j = await r.json() as any
        all.push(...j.records)
        offset = j.offset
    } while (offset)

    const renderable: string[] = []
    const orphans: string[] = []
    for (const rec of all) {
        const g = rec.fields.GUID
        if (!g) continue
        if (ifcDoors.has(g)) renderable.push(g)
        else orphans.push(g)
    }

    console.log(`Total non-valid: ${all.length}`)
    console.log(`\nRenderable (in IFC) — ${renderable.length}:`)
    for (const g of renderable) console.log(`  ${g}`)
    console.log(`\nOrphans (not in IFC) — ${orphans.length}:`)
    for (const g of orphans) console.log(`  ${g}`)
}
main().catch((e) => { console.error(e); process.exit(1) })
