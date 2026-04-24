/**
 * List every Valid='no' row with GUID, storey, category, and comment — one line each.
 * Sorted so rows with comments come first (useful when triaging annotations).
 */

interface Row {
    id: string
    fields: Record<string, unknown>
}

async function fetchAll(token: string, baseId: string, table: string, formula: string): Promise<Row[]> {
    const out: Row[] = []
    let offset: string | undefined
    do {
        const url = new URL(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`)
        url.searchParams.set('pageSize', '100')
        url.searchParams.set('filterByFormula', formula)
        if (offset) url.searchParams.set('offset', offset)
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
        if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
        const j = await res.json() as { records: Row[]; offset?: string }
        out.push(...j.records)
        offset = j.offset
    } while (offset)
    return out
}

function asStr(v: unknown): string {
    if (v == null) return ''
    if (typeof v === 'string') return v
    if (Array.isArray(v)) return v.map(asStr).join(',')
    return String(v)
}

async function main() {
    const token = process.env.AIRTABLE_TOKEN
    const baseId = process.env.AIRTABLE_BASE_ID
    const table = process.env.AIRTABLE_TABLE_NAME ?? 'Doors'
    if (!token || !baseId) throw new Error('AIRTABLE_TOKEN and AIRTABLE_BASE_ID required')

    const rows = await fetchAll(token, baseId, table, "{Valid} = 'no'")
    const sorted = rows.slice().sort((a, b) => {
        const ca = asStr(a.fields.Comment).trim().length > 0 ? 0 : 1
        const cb = asStr(b.fields.Comment).trim().length > 0 ? 0 : 1
        if (ca !== cb) return ca - cb
        return asStr(a.fields.BuildingStorey).localeCompare(asStr(b.fields.BuildingStorey))
    })

    console.log(`# Rows with Valid='no': ${sorted.length}\n`)
    console.log(`GUID\tStorey\tCategory\tComment`)
    for (const r of sorted) {
        const guid = asStr(r.fields.GUID)
        const storey = asStr(r.fields.BuildingStorey)
        const category = asStr(r.fields.Category)
        const comment = asStr(r.fields.Comment).replace(/\s+/g, ' ').trim()
        console.log(`${guid}\t${storey}\t${category}\t${comment}`)
    }

    const annotated = sorted.filter((r) => asStr(r.fields.Comment).trim().length > 0)
    console.log(`\n# Annotated (has Comment): ${annotated.length}`)
    console.log(`# Unannotated: ${sorted.length - annotated.length}`)
}

main().catch((err) => { console.error(err); process.exit(1) })
