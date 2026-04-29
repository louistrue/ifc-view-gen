/**
 * Pull current Airtable images for a list of GUIDs into a side-by-side
 * directory, so we can compare local renders (test-output/airtable-rounds/...)
 * against the live Airtable state without uploading anything.
 *
 * Reads guids from --guid-file or stdin. Saves to test-output/_airtable-cache/<GUID>/{front,back,plan}.png.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

interface Row { id: string; fields: Record<string, unknown> }

async function fetchByGuid(token: string, baseId: string, table: string, guid: string): Promise<Row | null> {
    const url = new URL(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`)
    url.searchParams.set('pageSize', '1')
    url.searchParams.set('filterByFormula', `{GUID}='${guid.replace(/'/g, "\\'")}'`)
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
    const j = (await res.json()) as { records: Row[] }
    return j.records[0] ?? null
}

async function downloadAttachment(url: string): Promise<Buffer> {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`download failed ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
}

async function main() {
    const token = process.env.AIRTABLE_TOKEN
    const baseId = process.env.AIRTABLE_BASE_ID
    const table = process.env.AIRTABLE_TABLE_NAME ?? 'Doors'
    if (!token || !baseId) throw new Error('AIRTABLE_TOKEN and AIRTABLE_BASE_ID required')

    const args = process.argv.slice(2)
    let guidFile: string | null = null
    for (const a of args) {
        if (a.startsWith('--guid-file=')) guidFile = a.slice('--guid-file='.length)
    }
    if (!guidFile) throw new Error('Usage: --guid-file=path')
    const guids = readFileSync(resolve(guidFile), 'utf8')
        .split(/[\s,;]+/)
        .map((s) => s.trim())
        .filter(Boolean)

    const outRoot = resolve('test-output/_airtable-cache')
    mkdirSync(outRoot, { recursive: true })

    let done = 0
    const FIELDS = ['Plan', 'Front', 'Back'] as const
    for (const guid of guids) {
        const safe = guid.replace(/[\$\/]/g, '_')
        const dir = resolve(outRoot, safe)
        const allDone = FIELDS.every((f) => existsSync(resolve(dir, `${f.toLowerCase()}.png`)))
        if (allDone) { done++; if (done % 50 === 0) console.error(`...${done}/${guids.length} (cached)`); continue }
        try {
            const rec = await fetchByGuid(token, baseId, table, guid)
            if (!rec) { console.error(`not found: ${guid}`); continue }
            mkdirSync(dir, { recursive: true })
            for (const f of FIELDS) {
                const att = (rec.fields[f] as any[] | undefined)?.[0]
                if (!att?.url) continue
                const buf = await downloadAttachment(att.url)
                writeFileSync(resolve(dir, `${f.toLowerCase()}.png`), buf)
            }
        } catch (e) {
            console.error(`error on ${guid}:`, (e as Error).message)
        }
        done++
        if (done % 25 === 0) console.error(`...${done}/${guids.length}`)
        await new Promise((r) => setTimeout(r, 60))
    }
    console.error(`done — ${done}/${guids.length}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
