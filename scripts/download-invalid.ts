/**
 * Pull every Airtable Doors row where Valid != "yes", download all three
 * attachments (Plan/Front/Back PNG) to test-output/invalid-review/<guid>/.
 * Also writes a manifest.json summarising the queue (category, GUID, etc.).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

interface AirtableAttachment {
    id?: string
    url: string
    filename?: string
    type?: string
}

interface AirtableRecord {
    id: string
    fields: {
        GUID?: string
        Valid?: 'yes' | 'no'
        Category?: string[]
        Comment?: string
        Plan?: AirtableAttachment[]
        Front?: AirtableAttachment[]
        Back?: AirtableAttachment[]
        [k: string]: unknown
    }
}

async function fetchAll(token: string, baseId: string, table: string, filter?: string): Promise<AirtableRecord[]> {
    const base = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`
    const out: AirtableRecord[] = []
    let offset: string | undefined
    do {
        const url = new URL(base)
        url.searchParams.set('pageSize', '100')
        if (filter) url.searchParams.set('filterByFormula', filter)
        if (offset) url.searchParams.set('offset', offset)
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
        if (!res.ok) throw new Error(`list: ${res.status} ${await res.text()}`)
        const json = await res.json() as { records: AirtableRecord[]; offset?: string }
        out.push(...json.records)
        offset = json.offset
    } while (offset)
    return out
}

async function downloadAttachment(att: AirtableAttachment, dest: string): Promise<void> {
    const res = await fetch(att.url)
    if (!res.ok) throw new Error(`fetch ${att.url}: ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    writeFileSync(dest, buf)
}

function sanitize(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'door'
}

async function main() {
    const token = process.env.AIRTABLE_TOKEN
    const baseId = process.env.AIRTABLE_BASE_ID
    const table = process.env.AIRTABLE_TABLE_NAME ?? 'Doors'
    if (!token || !baseId) throw new Error('AIRTABLE_TOKEN and AIRTABLE_BASE_ID required')

    // Everything that isn't validated (yes) is fair game — including rows
    // whose Category has already been set, which the bulk marker skipped.
    const records = await fetchAll(token, baseId, table, "NOT({Valid} = 'yes')")
    console.log(`Invalid records: ${records.length}`)

    const outRoot = resolve(process.cwd(), 'test-output', 'invalid-review')
    mkdirSync(outRoot, { recursive: true })

    const manifest: Array<{ guid: string; category: string[]; comment: string; valid: string; hasPlan: boolean; hasFront: boolean; hasBack: boolean }> = []

    let downloaded = 0
    for (const rec of records) {
        const guid = rec.fields.GUID ?? `record-${rec.id}`
        const dir = resolve(outRoot, sanitize(guid))
        mkdirSync(dir, { recursive: true })
        const cat = Array.isArray(rec.fields.Category) ? rec.fields.Category : []
        manifest.push({
            guid,
            category: cat,
            comment: rec.fields.Comment ?? '',
            valid: rec.fields.Valid ?? '',
            hasPlan: (rec.fields.Plan?.length ?? 0) > 0,
            hasFront: (rec.fields.Front?.length ?? 0) > 0,
            hasBack: (rec.fields.Back?.length ?? 0) > 0,
        })
        for (const [view, field] of [['plan', rec.fields.Plan], ['front', rec.fields.Front], ['back', rec.fields.Back]] as const) {
            const att = field?.[0]
            if (!att) continue
            try {
                await downloadAttachment(att, resolve(dir, `${view}.png`))
                downloaded++
            } catch (err) {
                console.error(`  ${guid}/${view}:`, err instanceof Error ? err.message : err)
            }
        }
        process.stdout.write(`\r  processed ${manifest.length}/${records.length}, downloaded ${downloaded}`)
    }
    if (manifest.length > 0) process.stdout.write('\n')

    writeFileSync(resolve(outRoot, 'manifest.json'), JSON.stringify(manifest, null, 2))
    console.log(`\nSaved to ${outRoot} (${downloaded} attachments).`)

    // Category breakdown
    const catCounts = new Map<string, number>()
    let noCat = 0
    for (const m of manifest) {
        if (m.category.length === 0) noCat++
        for (const c of m.category) catCounts.set(c, (catCounts.get(c) ?? 0) + 1)
    }
    console.log(`\nCategory breakdown:`)
    console.log(`  (none): ${noCat}`)
    for (const [c, n] of [...catCounts].sort((a, b) => b[1] - a[1])) console.log(`  ${c}: ${n}`)
}
main().catch((err) => { console.error(err); process.exit(1) })
