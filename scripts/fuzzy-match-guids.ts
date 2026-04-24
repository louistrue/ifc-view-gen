/**
 * Fuzzy-match Airtable GUIDs against IFC door GUIDs.
 *
 * Encode flaws between IFC (GUID contains `$` and `_`) and CSV exports /
 * spreadsheets (sometimes `$` gets converted to `_` on save/import) leave a
 * subset of Airtable rows looking orphaned. This walks every "not in IFC"
 * GUID, generates `$`/`_` swap candidates, and reports which ones match an
 * actual IFC door.
 *
 * Default: dry-run (prints the mapping, no writes).
 * Pass --apply to patch Airtable's GUID field for each confident match.
 */
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { loadIFCModelWithMetadata } from '../lib/ifc-loader'

interface AirtableRecord {
    id: string
    fields: { GUID?: string; [k: string]: unknown }
}

const MISSING: readonly string[] = [
    '0GWhwF4yhoI8O1$W17AhLg',
    '1KfjmNJb_0Hgds7Zn_PjKC',
    '1hiapEsZkOIBa0oQ84Xxev',
    '2U$LV0eSvaGQeLz_N81O_f',
    '1tHmTLLVk3IxcT9_XDH2pG',
    '2rwEcrrTGAGec7zdonnM44',
    '35hYz2YcclHxxj1zJw66$t',
    '1lZeYHhkAgHPAG$nsEkaAs',
    '3mDNCET6rfHuG_$X9ylfIe',
    '2B6serLLyOHOpBoXGgegoR',
    '2sqIGsQisAIwvsrq73L1N1',
    '2KShbQWVNHHQCLXmQuYRIW',
    '1E0FbSLTZ3IBm3mZubxe7h',
    '1H6NdrJovdJvzseJ0sU2zh',
    '1YII0pTZ_3JxVqTfA6jC16',
    '1vFzKiv7bqGvvU7XOz86Y_',
    '1xrnj_1n1wHwyKzWENNMoO',
    '0K8ZJTld4qH9fxwAzAk_lO',
    '2Cp9tUwMK3G8o1iw6OwNNe',
    '0x_i4DUHzUGBl$jCelLn5P',
    '15fhuS5snNIwuFjJmC3Guf',
    '2mMYOxcNdlHx3QaCCWDeaO',
    '1NxTuUGzjFIPXnpXXW2Sqj',
    '3EY3$ekHWUIeQTgzraqOs8',
    '0c4LBXexGPHgcDWqTNIHIK',
    '223gB3b1mFJgLh_U63ZY03',
    '3lazu1DhIGIf1muyFRRbOk',
    '00u5qpWEIrG8Uv8LUhP_VA',
    '3sg3khyow8GuSOljMA0gOm',
    '1hGS2RoqG1JwSbtBpbEAE7',
    '0Ip11oFL76Hwq2jLiv5sB2',
    '1Z8i1hnelTGfJmFWoDAhI1',
]

function loadIfcFile(path: string): File {
    return new File([readFileSync(path)], basename(path), { type: 'application/octet-stream' })
}

/**
 * GUID positions that hold a dollar or underscore can have been swapped on
 * spreadsheet round-trips. Generate all candidate strings with each flippable
 * character independently swapped. Returns the set including the original.
 */
function guidCandidates(guid: string): Set<string> {
    const positions = [...guid].flatMap((c, i) => (c === '$' || c === '_' ? [i] : []))
    const out = new Set<string>([guid])
    if (positions.length === 0 || positions.length > 10) return out
    const total = 1 << positions.length
    for (let mask = 1; mask < total; mask++) {
        const chars = [...guid]
        for (let bit = 0; bit < positions.length; bit++) {
            if (mask & (1 << bit)) {
                const i = positions[bit]
                chars[i] = chars[i] === '$' ? '_' : '$'
            }
        }
        out.add(chars.join(''))
    }
    return out
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
        if (!res.ok) throw new Error(`Airtable list failed: ${res.status} ${await res.text()}`)
        const json = await res.json() as { records: AirtableRecord[]; offset?: string }
        out.push(...json.records)
        offset = json.offset
    } while (offset)
    return out
}

async function patchGuid(token: string, baseId: string, table: string, recordId: string, newGuid: string): Promise<void> {
    const url = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}/${recordId}`
    const res = await fetch(url, {
        method: 'PATCH',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fields: { GUID: newGuid } }),
    })
    if (!res.ok) throw new Error(`patch ${recordId} -> ${newGuid}: ${res.status} ${await res.text()}`)
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
    const ifcAllGuids = new Map<string, string>()  // guid -> typeName
    for (const el of model.elements) {
        const type = (el.typeName || '').toUpperCase()
        if (typeof el.globalId === 'string') ifcAllGuids.set(el.globalId, type)
        if (type === 'IFCDOOR' && typeof el.globalId === 'string') ifcDoorGuids.add(el.globalId)
    }
    console.log(`IFC door GUID count: ${ifcDoorGuids.size}`)
    console.log(`IFC element count (any type): ${ifcAllGuids.size}`)

    // Quick diagnostic: are any missing GUIDs present as a non-door element?
    for (const g of MISSING) {
        const t = ifcAllGuids.get(g)
        if (t && t !== 'IFCDOOR') console.log(`  ${g} exists as ${t}`)
    }

    const airtable = await fetchAllDoors(token, baseId, table)
    const airtableByGuid = new Map<string, AirtableRecord>()
    for (const r of airtable) {
        const g = r.fields.GUID
        if (typeof g === 'string') airtableByGuid.set(g, r)
    }
    console.log(`Airtable record count: ${airtable.length}`)

    // Precompute each airtable GUID's closest IFC GUID by Hamming + Levenshtein.
    const hamming = (a: string, b: string): number => {
        if (a.length !== b.length) return Math.max(a.length, b.length)
        let d = 0
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++
        return d
    }
    const levenshtein = (a: string, b: string): number => {
        if (a === b) return 0
        const m = a.length, n = b.length
        if (m === 0 || n === 0) return Math.max(m, n)
        const prev = new Array(n + 1).fill(0)
        for (let j = 0; j <= n; j++) prev[j] = j
        const curr = new Array(n + 1).fill(0)
        for (let i = 1; i <= m; i++) {
            curr[0] = i
            for (let j = 1; j <= n; j++) {
                const cost = a[i - 1] === b[j - 1] ? 0 : 1
                curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
            }
            for (let j = 0; j <= n; j++) prev[j] = curr[j]
        }
        return prev[n]
    }

    const ifcGuidList = [...ifcDoorGuids]
    const plan: Array<{ airtableGuid: string; newGuid: string; recordId: string; distance: number; method: string }> = []
    const unresolved: string[] = []
    for (const airtableGuid of MISSING) {
        const record = airtableByGuid.get(airtableGuid)
        if (!record) { unresolved.push(`${airtableGuid} — not in Airtable`); continue }

        // 1. $/_ swap
        const swaps = [...guidCandidates(airtableGuid)].filter((g) => g !== airtableGuid && ifcDoorGuids.has(g))
        if (swaps.length === 1) {
            plan.push({ airtableGuid, newGuid: swaps[0], recordId: record.id, distance: 0, method: '$/_ swap' })
            continue
        }
        if (swaps.length > 1) {
            unresolved.push(`${airtableGuid} — ambiguous $/_ swaps: ${swaps.join(', ')}`)
            continue
        }

        // 2. closest IFC GUID by Hamming (same length) — typical for single-char corruptions
        let bestHam = { guid: '', dist: Infinity }
        for (const g of ifcGuidList) {
            if (g.length !== airtableGuid.length) continue
            const d = hamming(airtableGuid, g)
            if (d < bestHam.dist) { bestHam = { guid: g, dist: d } }
        }

        // 3. closest IFC GUID by Levenshtein
        let bestLev = { guid: '', dist: Infinity }
        for (const g of ifcGuidList) {
            const d = levenshtein(airtableGuid, g)
            if (d < bestLev.dist) { bestLev = { guid: g, dist: d } }
        }

        if (bestHam.dist <= 2) {
            plan.push({ airtableGuid, newGuid: bestHam.guid, recordId: record.id, distance: bestHam.dist, method: `hamming=${bestHam.dist}` })
        } else if (bestLev.dist <= 2) {
            plan.push({ airtableGuid, newGuid: bestLev.guid, recordId: record.id, distance: bestLev.dist, method: `levenshtein=${bestLev.dist}` })
        } else {
            unresolved.push(`${airtableGuid} — nearest ham=${bestHam.dist} (${bestHam.guid}), lev=${bestLev.dist} (${bestLev.guid})`)
        }
    }

    console.log(`\nResolvable: ${plan.length}/${MISSING.length}`)
    for (const p of plan) console.log(`  ${p.airtableGuid} -> ${p.newGuid}  [${p.method}]`)
    console.log(`\nUnresolved: ${unresolved.length}`)
    for (const u of unresolved) console.log(`  ${u}`)

    if (!apply) {
        console.log('\nDry run. Re-run with --apply to patch Airtable.')
        return
    }

    let patched = 0
    for (const p of plan) {
        try {
            await patchGuid(token, baseId, table, p.recordId, p.newGuid)
            patched++
            process.stdout.write(`\rpatched ${patched}/${plan.length}`)
        } catch (err) {
            console.error(`\npatch ${p.airtableGuid} failed:`, err instanceof Error ? err.message : err)
        }
    }
    if (patched > 0) process.stdout.write('\n')
    console.log(`Patched ${patched}/${plan.length} Airtable records.`)
}
main().catch((err) => { console.error(err); process.exit(1) })
