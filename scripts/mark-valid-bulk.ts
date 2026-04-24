/**
 * Mark every Airtable door row as Valid=yes, EXCEPT:
 *  1. rows with a non-empty `Category` (already categorised → leave alone)
 *  2. rows whose GUID is not present in the current IFC (orphaned)
 *
 * Default: dry-run (prints the plan). Pass --apply to patch.
 */
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { loadIFCModelWithMetadata } from '../lib/ifc-loader'

interface AirtableRecord {
    id: string
    fields: {
        GUID?: string
        Valid?: 'yes' | 'no'
        Category?: string[]
        [k: string]: unknown
    }
}

function loadIfcFile(path: string): File {
    return new File([readFileSync(path)], basename(path), { type: 'application/octet-stream' })
}

async function fetchAllDoors(token: string, baseId: string, table: string): Promise<AirtableRecord[]> {
    const base = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`
    const out: AirtableRecord[] = []
    let offset: string | undefined
    do {
        const url = new URL(base)
        url.searchParams.set('pageSize', '100')
        if (offset) url.searchParams.set('offset', offset)
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
        if (!res.ok) throw new Error(`list: ${res.status} ${await res.text()}`)
        const json = await res.json() as { records: AirtableRecord[]; offset?: string }
        out.push(...json.records)
        offset = json.offset
    } while (offset)
    return out
}

async function patchBatch(
    token: string,
    baseId: string,
    table: string,
    records: Array<{ id: string; fields: Record<string, unknown> }>,
): Promise<void> {
    const url = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`
    const res = await fetch(url, {
        method: 'PATCH',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ records }),
    })
    if (!res.ok) throw new Error(`patch batch: ${res.status} ${await res.text()}`)
}

async function main() {
    const apply = process.argv.includes('--apply')
    const token = process.env.AIRTABLE_TOKEN
    const baseId = process.env.AIRTABLE_BASE_ID
    const table = process.env.AIRTABLE_TABLE_NAME ?? 'Doors'
    if (!token || !baseId) throw new Error('AIRTABLE_TOKEN and AIRTABLE_BASE_ID required')

    const arch = resolve(process.env.ARCH_IFC_PATH ?? 'Flu21_A_AR_51_ARM_0000_A-AR-0000-0001_260402.ifc')
    const model = await loadIFCModelWithMetadata(loadIfcFile(arch))
    const ifcDoorGuids = new Set<string>()
    for (const el of model.elements) {
        if ((el.typeName || '').toUpperCase() === 'IFCDOOR' && typeof el.globalId === 'string') {
            ifcDoorGuids.add(el.globalId)
        }
    }

    const records = await fetchAllDoors(token, baseId, table)

    const toPatch: Array<{ id: string; fields: { Valid: 'yes' } }> = []
    let skippedCategory = 0
    let skippedOrphan = 0
    let alreadyYes = 0
    for (const r of records) {
        const guid = r.fields.GUID ?? ''
        const cat = Array.isArray(r.fields.Category) ? r.fields.Category : []
        if (cat.length > 0) { skippedCategory++; continue }
        if (!ifcDoorGuids.has(guid)) { skippedOrphan++; continue }
        if (r.fields.Valid === 'yes') { alreadyYes++; continue }
        toPatch.push({ id: r.id, fields: { Valid: 'yes' } })
    }

    console.log(`Airtable records: ${records.length}`)
    console.log(`  skipped (Category set): ${skippedCategory}`)
    console.log(`  skipped (orphan, not in IFC): ${skippedOrphan}`)
    console.log(`  already Valid=yes: ${alreadyYes}`)
    console.log(`  will patch to Valid=yes: ${toPatch.length}`)

    if (!apply) {
        console.log('\nDry run. Re-run with --apply to patch.')
        return
    }

    let patched = 0
    const BATCH = 10
    for (let i = 0; i < toPatch.length; i += BATCH) {
        const batch = toPatch.slice(i, i + BATCH)
        await patchBatch(token, baseId, table, batch)
        patched += batch.length
        process.stdout.write(`\rpatched ${patched}/${toPatch.length}`)
    }
    if (patched > 0) process.stdout.write('\n')
    console.log(`Done. Patched ${patched} record(s) to Valid=yes.`)
}
main().catch((err) => { console.error(err); process.exit(1) })
