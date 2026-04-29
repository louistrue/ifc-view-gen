/**
 * For every row Valid in {no, check}, pull /comments and keep only those
 * created within the last N hours (default 6h). Output a per-row breakdown
 * of recent comment text plus the Category multi-select on the same row.
 *
 * Reviewer annotations on PNG attachments surface as record-level comments
 * with a text label (and an internal image-region payload). Only the label
 * is exposed via the standard API.
 */

interface Row {
    id: string
    fields: Record<string, unknown>
}
interface Comment {
    id: string
    text: string
    createdTime: string
    author?: { name?: string; email?: string }
}

const WINDOW_HOURS = Number(process.env.WINDOW_HOURS ?? '6')
const CONCURRENCY = 4
const SLEEP_MS = 80

function asStr(v: unknown): string {
    if (v == null) return ''
    if (typeof v === 'string') return v
    if (Array.isArray(v)) return v.map(asStr).join(',')
    return String(v)
}
function asArr(v: unknown): string[] {
    if (v == null) return []
    if (Array.isArray(v)) return v.map((x) => asStr(x).trim()).filter(Boolean)
    const s = asStr(v).trim()
    return s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []
}
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)) }

async function fetchAllRows(token: string, baseId: string, table: string, formula: string): Promise<Row[]> {
    const out: Row[] = []
    let offset: string | undefined
    do {
        const url = new URL(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`)
        url.searchParams.set('pageSize', '100')
        url.searchParams.set('filterByFormula', formula)
        if (offset) url.searchParams.set('offset', offset)
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
        if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
        const j = (await res.json()) as { records: Row[]; offset?: string }
        out.push(...j.records)
        offset = j.offset
    } while (offset)
    return out
}

async function fetchComments(token: string, baseId: string, table: string, recId: string): Promise<Comment[]> {
    const out: Comment[] = []
    let offset: string | undefined
    do {
        const url = new URL(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}/${recId}/comments`)
        url.searchParams.set('pageSize', '100')
        if (offset) url.searchParams.set('offset', offset)
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
        if (!res.ok) {
            if (res.status === 429) { await sleep(1000); offset = offset ?? ''; continue }
            throw new Error(`${res.status} ${await res.text()} for ${recId}`)
        }
        const j = (await res.json()) as { comments: Comment[]; offset?: string }
        out.push(...j.comments)
        offset = j.offset
    } while (offset)
    return out
}

async function main() {
    const token = process.env.AIRTABLE_TOKEN
    const baseId = process.env.AIRTABLE_BASE_ID
    const table = process.env.AIRTABLE_TABLE_NAME ?? 'Doors'
    if (!token || !baseId) throw new Error('AIRTABLE_TOKEN and AIRTABLE_BASE_ID required')

    const cutoff = Date.now() - WINDOW_HOURS * 3600 * 1000
    const cutoffISO = new Date(cutoff).toISOString()

    const rows = await fetchAllRows(token, baseId, table, "OR({Valid}='no',{Valid}='check')")
    console.error(`fetched ${rows.length} rows; window cutoff ${cutoffISO}`)

    const results: Array<{ row: Row; comments: Comment[] }> = []
    let i = 0
    async function worker() {
        while (true) {
            const idx = i++
            if (idx >= rows.length) return
            const row = rows[idx]
            try {
                const all = await fetchComments(token!, baseId!, table, row.id)
                const recent = all.filter((c) => c.createdTime >= cutoffISO)
                if (recent.length > 0) results.push({ row, comments: recent })
            } catch (e) {
                console.error(`error on ${row.id}:`, (e as Error).message)
            }
            if (idx % 50 === 0) console.error(`...${idx}/${rows.length}`)
            await sleep(SLEEP_MS)
        }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))

    console.error(`rows with recent comments: ${results.length}`)

    // Aggregate
    const modeCounts: Record<string, number> = {}
    const modeGuids: Record<string, Array<{ guid: string; valid: string; storey: string; commentCount: number }>> = {}
    const allComments: Array<{ guid: string; valid: string; storey: string; createdTime: string; text: string; cats: string[] }> = []

    for (const { row, comments } of results) {
        const guid = asStr(row.fields.GUID)
        const valid = asStr(row.fields.Valid)
        const storey = asStr(row.fields.BuildingStorey)
        const cats = asArr(row.fields.Category)
        const labels = new Set<string>()
        for (const c of comments) {
            const text = c.text.trim()
            const norm = text.toLowerCase().replace(/\s+/g, ' ').trim()
            labels.add(norm)
            allComments.push({ guid, valid, storey, createdTime: c.createdTime, text, cats })
        }
        for (const m of labels) {
            modeCounts[m] = (modeCounts[m] ?? 0) + 1
            if (!modeGuids[m]) modeGuids[m] = []
            modeGuids[m].push({ guid, valid, storey, commentCount: comments.filter((c) => c.text.toLowerCase().replace(/\s+/g, ' ').trim() === m).length })
        }
    }

    console.log('================================================================')
    console.log(`Recent comment window: last ${WINDOW_HOURS} h  (since ${cutoffISO})`)
    console.log(`Rows queried (Valid in {no,check}): ${rows.length}`)
    console.log(`Rows with at least one recent comment: ${results.length}`)
    console.log('================================================================\n')

    console.log('## Distinct comment labels (frequency = unique rows tagged)')
    const sorted = Object.entries(modeCounts).sort((a, b) => b[1] - a[1])
    for (const [m, n] of sorted) {
        console.log(`  ${String(n).padStart(4)}  ${m}`)
    }

    console.log('\n## GUIDs per recent comment label')
    for (const [m, n] of sorted) {
        console.log(`\n### "${m}"  (${n} rows)`)
        for (const r of modeGuids[m] ?? []) {
            console.log(`   ${r.guid} [${r.valid}]\t${r.storey}\t×${r.commentCount}`)
        }
    }

    console.log('\n## All recent comments (chronological)')
    allComments.sort((a, b) => a.createdTime.localeCompare(b.createdTime))
    for (const c of allComments) {
        console.log(`${c.createdTime}\t${c.guid}\t[${c.valid}]\t${c.storey}\tcat=${c.cats.join('|')}\t${c.text.replace(/\s+/g, ' ').trim()}`)
    }
}

main().catch((e) => { console.error(e); process.exit(1) })
