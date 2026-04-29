/**
 * Populate a "Building Storey" column on the Airtable Doors table.
 *
 * 1. Fetch all door records from Airtable (GUIDs).
 * 2. Open the ARCH IFC and build a doorGuid -> IfcBuildingStorey.Name map
 *    via IfcRelContainedInSpatialStructure.
 * 3. Ensure the "Building Storey" field exists on the table (creates it via
 *    the metadata API if missing).
 * 4. PATCH every record in batches of 10 with its storey name (skips records
 *    whose value is already current).
 *
 * Flags:
 *   --dry-run        fetch + compute, print plan, no writes
 *   --limit=N        only update the first N records (smoke test)
 *   --create-field   try to create the field via the metadata API
 *                    (requires schema.bases:write on the PAT)
 *
 * Env:
 *   AIRTABLE_TOKEN      PAT with data.records:read/write (plus
 *                       schema.bases:read to verify field existence, and
 *                       schema.bases:write if using --create-field)
 *   AIRTABLE_BASE_ID
 *   AIRTABLE_TABLE_NAME (default: Doors)
 *   ARCH_IFC_PATH       path to architectural IFC (contains the doors)
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { IfcAPI } from 'web-ifc'
import * as WebIFC from 'web-ifc'
import { listDoors, type AirtableConfig, type DoorRecord } from '../lib/airtable-client'

const API = 'https://api.airtable.com/v0'
const META = 'https://api.airtable.com/v0/meta'
const FIELD_NAME = 'BuildingStorey'

interface CliFlags {
    dryRun: boolean
    limit: number | null
    createField: boolean
}

function parseFlags(argv: string[]): CliFlags {
    const flags: CliFlags = { dryRun: false, limit: null, createField: false }
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (arg === '--') continue
        else if (arg === '--dry-run') flags.dryRun = true
        else if (arg === '--create-field') flags.createField = true
        else if (arg.startsWith('--limit=')) {
            const n = Number.parseInt(arg.slice('--limit='.length), 10)
            if (!Number.isFinite(n) || n <= 0) throw new Error(`--limit must be a positive integer`)
            flags.limit = n
        } else if (arg === '--help' || arg === '-h') {
            console.log('add-storey-column — Flags: --dry-run  --limit=N  --create-field')
            process.exit(0)
        } else {
            throw new Error(`Unknown flag: ${arg}`)
        }
    }
    return flags
}

function requireEnv(name: string): string {
    const value = process.env[name]
    if (!value) throw new Error(`${name} is required in environment (.env)`)
    return value
}

async function initIfcApi(): Promise<IfcAPI> {
    const api = new IfcAPI()
    api.SetWasmPath(`${process.cwd()}/public/wasm/web-ifc/`, true)
    await api.Init()
    return api
}

function normalizeRefs(value: unknown): Array<{ value?: number }> {
    if (value == null) return []
    if (Array.isArray(value)) return value as Array<{ value?: number }>
    const vec = value as { size?: number; get?: (i: number) => unknown }
    if (typeof vec.size === 'number' && typeof vec.get === 'function') {
        const out: Array<{ value?: number }> = []
        for (let i = 0; i < vec.size; i++) out.push(vec.get(i) as { value?: number })
        return out
    }
    return [value as { value?: number }]
}

/** Walk the IFC and build { doorGuid -> storey name }. */
async function buildGuidToStoreyMap(ifcPath: string): Promise<Map<string, string>> {
    const api = await initIfcApi()
    const bytes = new Uint8Array(readFileSync(ifcPath))
    const modelID = api.OpenModel(bytes)
    if (modelID === -1) throw new Error(`Failed to open IFC: ${ifcPath}`)
    try {
        const IFCDOOR = (WebIFC as any).IFCDOOR as number
        const IFCBUILDINGSTOREY = (WebIFC as any).IFCBUILDINGSTOREY as number
        const IFCRELCONTAINEDINSPATIALSTRUCTURE =
            (WebIFC as any).IFCRELCONTAINEDINSPATIALSTRUCTURE as number

        // storey expressID -> name
        const storeyNameById = new Map<number, string>()
        const storeyIds = api.GetLineIDsWithType(modelID, IFCBUILDINGSTOREY)
        for (let i = 0; i < storeyIds.size(); i++) {
            const id = storeyIds.get(i)
            const entity: any = api.GetLine(modelID, id)
            const name = entity?.Name?.value ?? entity?.LongName?.value
            if (typeof name === 'string' && name.trim()) {
                storeyNameById.set(id, name.trim())
            }
        }

        // door expressID -> GlobalId (GUID)
        const doorGuidById = new Map<number, string>()
        const doorIds = api.GetLineIDsWithType(modelID, IFCDOOR)
        for (let i = 0; i < doorIds.size(); i++) {
            const id = doorIds.get(i)
            const entity: any = api.GetLine(modelID, id)
            const guid = entity?.GlobalId?.value
            if (typeof guid === 'string' && guid.trim() && !/^\d+$/.test(guid)) {
                doorGuidById.set(id, guid.trim())
            }
        }

        // expressID -> storey name via IfcRelContainedInSpatialStructure
        const storeyNameByElementId = new Map<number, string>()
        const relIds = api.GetLineIDsWithType(modelID, IFCRELCONTAINEDINSPATIALSTRUCTURE)
        for (let i = 0; i < relIds.size(); i++) {
            const rel: any = api.GetLine(modelID, relIds.get(i))
            const relatingId = rel?.RelatingStructure?.value
            if (typeof relatingId !== 'number') continue
            const name = storeyNameById.get(relatingId)
            if (!name) continue
            for (const ref of normalizeRefs(rel?.RelatedElements)) {
                if (typeof ref?.value === 'number') storeyNameByElementId.set(ref.value, name)
            }
        }

        const out = new Map<string, string>()
        for (const [doorId, guid] of doorGuidById) {
            const storey = storeyNameByElementId.get(doorId)
            if (storey) out.set(guid, storey)
        }
        return out
    } finally {
        api.CloseModel(modelID)
    }
}

async function airtableFetch(url: string, init: RequestInit, token: string, attempt = 0): Promise<any> {
    const response = await fetch(url, {
        ...init,
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...(init.headers ?? {}),
        },
    })
    if (response.status === 429 && attempt < 5) {
        await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** attempt)))
        return airtableFetch(url, init, token, attempt + 1)
    }
    if (!response.ok) {
        const body = await response.text()
        throw new Error(`Airtable ${response.status} ${init.method ?? 'GET'} ${url}: ${body}`)
    }
    return response.json()
}

async function ensureStoreyField(cfg: AirtableConfig, createIfMissing: boolean): Promise<boolean> {
    let tables: any
    try {
        tables = await airtableFetch(`${META}/bases/${cfg.baseId}/tables`, { method: 'GET' }, cfg.token)
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes(' 403 ')) {
            console.log(`  (token lacks schema.bases:read — skipping existence check; will surface as a PATCH error if field is missing)`)
            return false
        }
        throw err
    }
    const table = tables.tables?.find(
        (t: any) => t.name === cfg.tableName || t.id === cfg.tableName
    )
    if (!table) throw new Error(`Table "${cfg.tableName}" not found in base ${cfg.baseId}`)
    const existing = (table.fields ?? []).find((f: any) => f.name === FIELD_NAME)
    if (existing) {
        console.log(`  field "${FIELD_NAME}" already exists (${existing.type})`)
        return true
    }
    if (!createIfMissing) {
        throw new Error(
            `Field "${FIELD_NAME}" is missing on table ${table.id}. Either:
    (a) create it manually in Airtable as a Single line text column named "${FIELD_NAME}", or
    (b) re-run with --create-field (requires schema.bases:write on the PAT).`
        )
    }
    console.log(`  field "${FIELD_NAME}" missing — creating singleLineText field`)
    await airtableFetch(
        `${META}/bases/${cfg.baseId}/tables/${table.id}/fields`,
        {
            method: 'POST',
            body: JSON.stringify({
                name: FIELD_NAME,
                type: 'singleLineText',
                description: 'IfcBuildingStorey.Name of the door, extracted from the ARCH IFC.',
            }),
        },
        cfg.token
    )
    return true
}

async function patchBatch(
    cfg: AirtableConfig,
    updates: Array<{ id: string; fields: Record<string, unknown> }>
): Promise<void> {
    if (updates.length === 0) return
    const url = `${API}/${cfg.baseId}/${encodeURIComponent(cfg.tableName)}`
    await airtableFetch(
        url,
        { method: 'PATCH', body: JSON.stringify({ records: updates }) },
        cfg.token
    )
}

async function main(): Promise<void> {
    const flags = parseFlags(process.argv.slice(2))

    const cfg: AirtableConfig = {
        token: requireEnv('AIRTABLE_TOKEN'),
        baseId: requireEnv('AIRTABLE_BASE_ID'),
        tableName: process.env.AIRTABLE_TABLE_NAME || 'Doors',
    }
    const archIfc = resolve(requireEnv('ARCH_IFC_PATH'))
    if (!existsSync(archIfc)) throw new Error(`ARCH_IFC_PATH not found: ${archIfc}`)

    console.log(`Airtable base: ${cfg.baseId}`)
    console.log(`Airtable table: ${cfg.tableName}`)
    console.log(`ARCH IFC: ${archIfc}`)

    console.log(`\n1. Ensuring "${FIELD_NAME}" field exists...`)
    if (flags.dryRun) {
        console.log('  (dry-run — skipping schema check/create)')
    } else {
        await ensureStoreyField(cfg, flags.createField)
    }

    console.log(`\n2. Fetching Airtable records...`)
    const records = await listDoors(cfg, { onlyNonValid: false })
    console.log(`  ${records.length} record(s)`)

    console.log(`\n3. Extracting door GUID -> storey from IFC...`)
    const guidToStorey = await buildGuidToStoreyMap(archIfc)
    console.log(`  ${guidToStorey.size} door(s) with a storey in the IFC`)

    // Plan updates: only patch where value differs from current Airtable value.
    const updates: Array<{ id: string; fields: Record<string, unknown>; guid: string; storey: string }> = []
    const missingInIfc: string[] = []
    const alreadyCurrent: string[] = []
    for (const r of records as DoorRecord[]) {
        const storey = guidToStorey.get(r.guid)
        if (!storey) {
            missingInIfc.push(r.guid)
            continue
        }
        const current = r.fields[FIELD_NAME]
        if (typeof current === 'string' && current === storey) {
            alreadyCurrent.push(r.guid)
            continue
        }
        updates.push({ id: r.id, fields: { [FIELD_NAME]: storey }, guid: r.guid, storey })
    }

    console.log(`\nPlan:`)
    console.log(`  to update:      ${updates.length}`)
    console.log(`  already current: ${alreadyCurrent.length}`)
    console.log(`  GUID not in IFC: ${missingInIfc.length}`)
    if (missingInIfc.length > 0) {
        const sample = missingInIfc.slice(0, 5).join(', ')
        console.log(`    sample: ${sample}${missingInIfc.length > 5 ? ', …' : ''}`)
    }

    let queue = updates
    if (flags.limit !== null && queue.length > flags.limit) {
        queue = queue.slice(0, flags.limit)
        console.log(`  (limit=${flags.limit} — trimming to ${queue.length})`)
    }

    if (flags.dryRun) {
        console.log(`\n--dry-run: exiting without writes.`)
        for (const u of queue.slice(0, 20)) console.log(`  ${u.guid} -> "${u.storey}"`)
        if (queue.length > 20) console.log(`  … +${queue.length - 20} more`)
        return
    }

    if (queue.length === 0) {
        console.log(`\nNothing to update.`)
        return
    }

    console.log(`\n4. Patching Airtable in batches of 10...`)
    let done = 0
    for (let i = 0; i < queue.length; i += 10) {
        const batch = queue.slice(i, i + 10).map(({ id, fields }) => ({ id, fields }))
        await patchBatch(cfg, batch)
        done += batch.length
        process.stdout.write(`\r  updated ${done}/${queue.length}`)
    }
    process.stdout.write('\n')
    console.log(`\nDone.`)
}

main().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(process.env.DEBUG_STACK ? (err instanceof Error ? err.stack : err) : msg)
    process.exit(1)
})
