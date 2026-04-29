/**
 * Revert Valid='check' back to Valid='no' for every row currently marked 'check'.
 * Use after a round run you want to undo (so those rows re-enter the next queue).
 *
 * Default: dry-run. Pass --apply to patch.
 */

interface AirtableRecord {
    id: string
    fields: { GUID?: string; Valid?: string;[k: string]: unknown }
}

async function fetchCheckRows(token: string, baseId: string, table: string): Promise<AirtableRecord[]> {
    const base = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`
    const out: AirtableRecord[] = []
    let offset: string | undefined
    do {
        const url = new URL(base)
        url.searchParams.set('pageSize', '100')
        url.searchParams.set('filterByFormula', "{Valid} = 'check'")
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
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ records, typecast: true }),
    })
    if (!res.ok) throw new Error(`patch: ${res.status} ${await res.text()}`)
}

async function main() {
    const apply = process.argv.includes('--apply')
    const token = process.env.AIRTABLE_TOKEN
    const baseId = process.env.AIRTABLE_BASE_ID
    const table = process.env.AIRTABLE_TABLE_NAME ?? 'Doors'
    if (!token || !baseId) throw new Error('AIRTABLE_TOKEN and AIRTABLE_BASE_ID required')

    const rows = await fetchCheckRows(token, baseId, table)
    console.log(`Found ${rows.length} row(s) with Valid='check'.`)
    if (!apply) {
        console.log("Dry run. Re-run with --apply to flip them back to Valid='no'.")
        return
    }

    const toPatch = rows.map((r) => ({ id: r.id, fields: { Valid: 'no' } }))
    let patched = 0
    const BATCH = 10
    for (let i = 0; i < toPatch.length; i += BATCH) {
        const batch = toPatch.slice(i, i + BATCH)
        await patchBatch(token, baseId, table, batch)
        patched += batch.length
        process.stdout.write(`\rpatched ${patched}/${toPatch.length}`)
    }
    if (patched > 0) process.stdout.write('\n')
    console.log(`Done. Reverted ${patched} row(s) to Valid='no'.`)
}

main().catch((err) => { console.error(err); process.exit(1) })
