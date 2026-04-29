/**
 * Analyze failure modes for all non-valid (Valid='no') and check (Valid='check') rows.
 * Pulls full failure context: Failures_V03 (latest) titles + descriptions + Status,
 * plus Failures_V02, Failures_V01, legacy Category multi-select, and free-text Comment.
 *
 * Skips rows where Comment contains a percentage marker (e.g. "90%", "75%") —
 * these are acknowledged-as-acceptable and we do not touch them anymore.
 */

interface Row {
    id: string
    fields: Record<string, unknown>
}

interface FailureMeta {
    id: string
    view?: string
    title?: string
    description?: string
    status?: string
}

async function fetchAll(token: string, baseId: string, table: string, formula?: string): Promise<Row[]> {
    const out: Row[] = []
    let offset: string | undefined
    do {
        const url = new URL(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`)
        url.searchParams.set('pageSize', '100')
        if (formula) url.searchParams.set('filterByFormula', formula)
        if (offset) url.searchParams.set('offset', offset)
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
        if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
        const j = (await res.json()) as { records: Row[]; offset?: string }
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

function asArr(v: unknown): string[] {
    if (v == null) return []
    if (Array.isArray(v)) return v.map((x) => asStr(x).trim()).filter(Boolean)
    const s = asStr(v).trim()
    return s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []
}

const PERCENT_RE = /\b\d{1,3}\s*%/

async function main() {
    const token = process.env.AIRTABLE_TOKEN
    const baseId = process.env.AIRTABLE_BASE_ID
    const table = process.env.AIRTABLE_TABLE_NAME ?? 'Doors'
    if (!token || !baseId) throw new Error('AIRTABLE_TOKEN and AIRTABLE_BASE_ID required')

    const failureRecords = await fetchAll(token, baseId, 'Failures')
    const failureMap = new Map<string, FailureMeta>()
    for (const f of failureRecords) {
        failureMap.set(f.id, {
            id: f.id,
            view: asStr(f.fields.view),
            title: asStr(f.fields.title),
            description: asStr(f.fields.description),
            status: asStr(f.fields.Status),
        })
    }

    const rows = await fetchAll(token, baseId, table, "OR({Valid}='no',{Valid}='check')")

    const validCounts: Record<string, number> = {}
    for (const r of rows) {
        const v = asStr(r.fields.Valid) || '<empty>'
        validCounts[v] = (validCounts[v] ?? 0) + 1
    }

    const acceptedByScore: Row[] = []
    const triage: Row[] = []
    for (const r of rows) {
        const comment = asStr(r.fields.Comment)
        if (PERCENT_RE.test(comment)) acceptedByScore.push(r)
        else triage.push(r)
    }

    const v03Counts: Record<string, number> = {}
    const v03Guids: Record<string, string[]> = {}
    const v03Status: Record<string, string> = {}
    const categoryCounts: Record<string, number> = {}
    const categoryGuids: Record<string, string[]> = {}
    const untaggedRows: Row[] = []
    const v02OnlyCounts: Record<string, number> = {}
    const v02OnlyGuids: Record<string, string[]> = {}
    const v01OnlyCounts: Record<string, number> = {}
    const v01OnlyGuids: Record<string, string[]> = {}

    // "best-known tag" rollup — per row, take V03 if any, else V02, else V01, else Category
    const bestModeCounts: Record<string, number> = {}
    const bestModeGuids: Record<string, { guid: string; valid: string; storey: string; source: string }[]> = {}

    for (const r of triage) {
        const guid = asStr(r.fields.GUID)
        const v03Ids = asArr(r.fields.Failures_V03)
        const v02Ids = asArr(r.fields.Failures_V02)
        const v01Ids = asArr(r.fields.Failures_V01)
        const cats = asArr(r.fields.Category)
        const hasAny = v03Ids.length > 0 || v02Ids.length > 0 || v01Ids.length > 0 || cats.length > 0

        if (v03Ids.length > 0) {
            for (const id of v03Ids) {
                const meta = failureMap.get(id)
                const key = meta?.title ?? id
                v03Counts[key] = (v03Counts[key] ?? 0) + 1
                if (!v03Guids[key]) v03Guids[key] = []
                v03Guids[key].push(guid)
                if (meta?.status) v03Status[key] = meta.status
            }
        } else if (v02Ids.length > 0) {
            for (const id of v02Ids) {
                const meta = failureMap.get(id)
                const key = meta?.title ?? id
                v02OnlyCounts[key] = (v02OnlyCounts[key] ?? 0) + 1
                if (!v02OnlyGuids[key]) v02OnlyGuids[key] = []
                v02OnlyGuids[key].push(guid)
            }
        } else if (v01Ids.length > 0) {
            for (const id of v01Ids) {
                const meta = failureMap.get(id)
                const key = meta?.title ?? id
                v01OnlyCounts[key] = (v01OnlyCounts[key] ?? 0) + 1
                if (!v01OnlyGuids[key]) v01OnlyGuids[key] = []
                v01OnlyGuids[key].push(guid)
            }
        }

        for (const c of cats) {
            categoryCounts[c] = (categoryCounts[c] ?? 0) + 1
            if (!categoryGuids[c]) categoryGuids[c] = []
            categoryGuids[c].push(guid)
        }

        // best-known tag for this row
        const titlesFor = (ids: string[]): string[] =>
            ids.map((id) => failureMap.get(id)?.title ?? id).filter(Boolean)
        let modes: string[] = []
        let source = ''
        if (v03Ids.length > 0) { modes = titlesFor(v03Ids); source = 'V03' }
        else if (v02Ids.length > 0) { modes = titlesFor(v02Ids); source = 'V02' }
        else if (v01Ids.length > 0) { modes = titlesFor(v01Ids); source = 'V01' }
        else if (cats.length > 0) { modes = cats; source = 'Category' }
        if (modes.length > 0) {
            for (const m of modes) {
                const key = `[${source}] ${m}`
                bestModeCounts[key] = (bestModeCounts[key] ?? 0) + 1
                if (!bestModeGuids[key]) bestModeGuids[key] = []
                bestModeGuids[key].push({
                    guid,
                    valid: asStr(r.fields.Valid),
                    storey: asStr(r.fields.BuildingStorey),
                    source,
                })
            }
        }

        if (!hasAny) untaggedRows.push(r)
    }

    const annotated = triage.filter((r) => asStr(r.fields.Comment).trim().length > 0)

    console.log('================================================================')
    console.log(`Total rows queried (Valid in {no,check}): ${rows.length}`)
    console.log('Breakdown by Valid:')
    for (const [k, v] of Object.entries(validCounts)) console.log(`  ${k.padEnd(10)} ${v}`)
    console.log()
    console.log(`Skipped (percentage marker in Comment): ${acceptedByScore.length}`)
    console.log(`Triage rows: ${triage.length}`)
    console.log()
    console.log(`Failure tag table size: ${failureRecords.length} records`)
    console.log('================================================================')

    if (acceptedByScore.length > 0) {
        console.log('\n--- SKIPPED (have % score in Comment) ---')
        for (const r of acceptedByScore) {
            console.log(`  ${asStr(r.fields.GUID)}\t[${asStr(r.fields.Valid)}]\t${asStr(r.fields.BuildingStorey)}\t${asStr(r.fields.Comment).replace(/\s+/g, ' ').trim()}`)
        }
    }

    console.log('\n================================================================')
    console.log('FAILURES_V03 (LATEST tagging) — frequency in triage set')
    console.log('================================================================')
    const sortedV03 = Object.entries(v03Counts).sort((a, b) => b[1] - a[1])
    for (const [title, count] of sortedV03) {
        console.log(`  ${String(count).padStart(4)}  [${(v03Status[title] || 'undefined').padEnd(10)}]  ${title}`)
    }

    console.log('\n================================================================')
    console.log('LEGACY Category multi-select — frequency')
    console.log('================================================================')
    const sortedCats = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1])
    for (const [c, n] of sortedCats) console.log(`  ${String(n).padStart(4)}  ${c}`)

    if (Object.keys(v02OnlyCounts).length > 0) {
        console.log('\n================================================================')
        console.log('FAILURES_V02-only (no V03 tag) — these were tagged in v02 round')
        console.log('================================================================')
        for (const [t, n] of Object.entries(v02OnlyCounts).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${t}`)
    }
    if (Object.keys(v01OnlyCounts).length > 0) {
        console.log('\n================================================================')
        console.log('FAILURES_V01-only (no V02/V03 tag)')
        console.log('================================================================')
        for (const [t, n] of Object.entries(v01OnlyCounts).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${t}`)
    }

    console.log('\n================================================================')
    console.log('BEST-KNOWN FAILURE MODE PER ROW (V03 > V02 > V01 > Category)')
    console.log('================================================================')
    const sortedBest = Object.entries(bestModeCounts).sort((a, b) => b[1] - a[1])
    for (const [k, n] of sortedBest) {
        console.log(`  ${String(n).padStart(4)}  ${k}`)
    }

    console.log('\n================================================================')
    console.log('GUIDS PER BEST-KNOWN FAILURE MODE (full triage list)')
    console.log('================================================================')
    for (const [k, count] of sortedBest) {
        const list = bestModeGuids[k] ?? []
        const byValid = { check: 0, no: 0 } as Record<string, number>
        for (const u of list) byValid[u.valid] = (byValid[u.valid] ?? 0) + 1
        console.log(`\n## ${k}  (${count})  check=${byValid.check ?? 0} no=${byValid.no ?? 0}`)
        for (const u of list) console.log(`   ${u.guid} [${u.valid}]\t${u.storey}`)
    }

    console.log('\n================================================================')
    console.log('GUIDS PER FAILURES_V03 TITLE (latest tagging only)')
    console.log('================================================================')
    for (const [title, count] of sortedV03) {
        const meta = Object.values(failureMap.values ? [] : []) // placeholder unused
        // find description for this title
        let description = ''
        let view = ''
        let status = v03Status[title] || ''
        for (const f of failureMap.values()) {
            if (f.title === title) { description = f.description ?? ''; view = f.view ?? ''; break }
        }
        console.log(`\n## [${status}]  ${title}  (${count})  view=${view}`)
        if (description) console.log(`   desc: ${description.replace(/\s+/g, ' ').trim().slice(0, 240)}`)
        for (const g of v03Guids[title] ?? []) console.log(`   ${g}`)
    }

    if (untaggedRows.length > 0) {
        console.log('\n================================================================')
        console.log(`UNTAGGED — ${untaggedRows.length} rows (no V01/V02/V03 link, no Category)`)
        console.log('================================================================')
        const byStorey: Record<string, { guid: string; valid: string }[]> = {}
        for (const r of untaggedRows) {
            const k = asStr(r.fields.BuildingStorey) || '<no storey>'
            if (!byStorey[k]) byStorey[k] = []
            byStorey[k].push({ guid: asStr(r.fields.GUID), valid: asStr(r.fields.Valid) })
        }
        for (const [s, list] of Object.entries(byStorey).sort((a, b) => a[0].localeCompare(b[0]))) {
            console.log(`\n## ${s}  (${list.length})`)
            for (const u of list) console.log(`   ${u.guid} [${u.valid}]`)
        }
    }

    if (annotated.length > 0) {
        console.log('\n================================================================')
        console.log(`ANNOTATED with free-text Comment — ${annotated.length} rows`)
        console.log('================================================================')
        for (const r of annotated) {
            const guid = asStr(r.fields.GUID)
            const valid = asStr(r.fields.Valid)
            const storey = asStr(r.fields.BuildingStorey)
            const cats = asArr(r.fields.Category).join(',')
            const v03Ids = asArr(r.fields.Failures_V03)
            const v03Titles = v03Ids.map((id) => failureMap.get(id)?.title ?? id).join(' / ')
            const comment = asStr(r.fields.Comment).replace(/\s+/g, ' ').trim()
            console.log(`\n[${valid}] ${guid}  storey=${storey}`)
            if (cats) console.log(`  cat: ${cats}`)
            if (v03Titles) console.log(`  V03: ${v03Titles}`)
            console.log(`  comment: ${comment}`)
        }
    }
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
