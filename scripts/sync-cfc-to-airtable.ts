/**
 * Sync IFC CFC values into Airtable field `CFC`, matched by GUID.
 *
 * Reads door CFC from Cset_StandardCH (`CFC / BKP / CCC / BCC`) on either
 * instance- or type-level psets, then updates Airtable records in batches.
 *
 * Flags:
 *   --guids=a,b,c        subset GUIDs
 *   --guid-file=path     subset GUIDs from file
 *   --dry-run            print planned changes, write nothing
 *   --only-missing       only fill rows where Airtable CFC is empty
 *
 * Env:
 *   AIRTABLE_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_TABLE_NAME
 *   ARCH_IFC_PATH
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { batchUpdateRecords, closeAirtableClient, listDoors, type AirtableConfig } from '../lib/airtable-client'
import { loadIfcLiteModel } from '../lib/ifclite-source'

interface CliFlags {
    guids: string[] | null
    guidFile: string | null
    dryRun: boolean
    onlyMissing: boolean
}

function parseCsvGuids(raw: string): string[] {
    return raw
        .split(/[\s,;]+/)
        .map((s) => s.trim())
        .filter(Boolean)
}

function parseFlags(argv: string[]): CliFlags {
    const flags: CliFlags = {
        guids: null,
        guidFile: null,
        dryRun: false,
        onlyMissing: false,
    }
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (arg === '--') continue
        else if (arg === '--help' || arg === '-h') {
            printHelp()
            process.exit(0)
        } else if (arg === '--dry-run') flags.dryRun = true
        else if (arg === '--only-missing') flags.onlyMissing = true
        else if (arg.startsWith('--guids=')) flags.guids = parseCsvGuids(arg.slice('--guids='.length))
        else if (arg === '--guids' && i + 1 < argv.length) flags.guids = parseCsvGuids(argv[++i])
        else if (arg.startsWith('--guid-file=')) flags.guidFile = arg.slice('--guid-file='.length)
        else if (arg === '--guid-file' && i + 1 < argv.length) flags.guidFile = argv[++i]
        else throw new Error(`Unknown flag: ${arg}`)
    }
    return flags
}

function printHelp(): void {
    console.log(`sync-cfc-to-airtable

Sync IFC CFC values into Airtable field "CFC" by matching GUID.

Flags:
  --guids=a,b,c        subset GUIDs
  --guid-file=path     subset GUIDs from file
  --dry-run            print planned changes, write nothing
  --only-missing       only fill rows where Airtable CFC is empty

Env:
  AIRTABLE_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_TABLE_NAME
  ARCH_IFC_PATH`)
}

function requireEnv(name: string): string {
    const value = process.env[name]
    if (!value) throw new Error(`${name} is required in environment (.env)`)
    return value
}

function readGuidsFromFile(path: string): string[] {
    const abs = resolve(path)
    if (!existsSync(abs)) throw new Error(`--guid-file not found: ${abs}`)
    return parseCsvGuids(readFileSync(abs, 'utf8'))
}

function readDoorCfc(model: Awaited<ReturnType<typeof loadIfcLiteModel>>, doorId: number): string | null {
    const allPsets = [...model.psets(doorId), ...model.typePsets(doorId)]
    for (const cset of allPsets) {
        if (cset.name !== 'Cset_StandardCH') continue
        for (const [key, value] of Object.entries(cset.properties)) {
            const norm = key.toLowerCase().replace(/[\s_/-]/g, '')
            if (norm !== 'cfcbkpcccbcc') continue
            const asString = value == null ? '' : String(value).trim()
            if (asString) return asString
        }
    }
    return null
}

async function main(): Promise<void> {
    const flags = parseFlags(process.argv.slice(2))

    const archIfc = resolve(requireEnv('ARCH_IFC_PATH'))
    if (!existsSync(archIfc)) throw new Error(`ARCH_IFC_PATH not found: ${archIfc}`)

    const airtable: AirtableConfig = {
        token: requireEnv('AIRTABLE_TOKEN'),
        baseId: requireEnv('AIRTABLE_BASE_ID'),
        tableName: process.env.AIRTABLE_TABLE_NAME || 'Doors',
    }

    console.log(`Loading IFC: ${archIfc}`)
    const model = await loadIfcLiteModel(archIfc)
    const doors = model.byType('IFCDOOR')
    console.log(`  IFC doors: ${doors.length}`)

    const guidToCfc = new Map<string, string>()
    for (const doorId of doors) {
        const attrs = model.attrs(doorId)
        const guid = attrs?.globalId?.trim()
        if (!guid) continue
        const cfc = readDoorCfc(model, doorId)
        if (!cfc) continue
        guidToCfc.set(guid, cfc)
    }
    console.log(`  IFC doors with CFC: ${guidToCfc.size}`)

    console.log('\nFetching Airtable rows...')
    const rows = await listDoors(airtable, {})
    const rowsByGuid = new Map(rows.map((r) => [r.guid, r]))
    console.log(`  Airtable rows with GUID: ${rows.length}`)

    const subsetGuids = new Set<string>()
    if (flags.guids) flags.guids.forEach((g) => subsetGuids.add(g))
    if (flags.guidFile) readGuidsFromFile(flags.guidFile).forEach((g) => subsetGuids.add(g))

    const candidates = subsetGuids.size > 0 ? [...subsetGuids] : [...rowsByGuid.keys()]
    if (subsetGuids.size > 0) console.log(`  subset size: ${subsetGuids.size}`)

    const updates: Array<{ id: string; fields: Record<string, unknown> }> = []
    let missingInIfc = 0
    let missingInAirtable = 0
    let skippedNoChange = 0
    let skippedAlreadySet = 0

    for (const guid of candidates) {
        const row = rowsByGuid.get(guid)
        if (!row) {
            missingInAirtable++
            continue
        }
        const cfc = guidToCfc.get(guid)
        if (!cfc) {
            missingInIfc++
            continue
        }
        const current = typeof row.fields.CFC === 'string' ? row.fields.CFC.trim() : ''
        if (flags.onlyMissing && current) {
            skippedAlreadySet++
            continue
        }
        if (current === cfc) {
            skippedNoChange++
            continue
        }
        updates.push({ id: row.id, fields: { CFC: cfc } })
    }

    console.log('\nPlanned update summary:')
    console.log(`  candidates:           ${candidates.length}`)
    console.log(`  will update:          ${updates.length}`)
    console.log(`  missing in IFC CFC:   ${missingInIfc}`)
    console.log(`  missing in Airtable:  ${missingInAirtable}`)
    console.log(`  unchanged:            ${skippedNoChange}`)
    if (flags.onlyMissing) console.log(`  skipped (already set): ${skippedAlreadySet}`)

    if (updates.length > 0) {
        for (const u of updates.slice(0, 20)) {
            const guid = rows.find((r) => r.id === u.id)?.guid ?? '<unknown-guid>'
            console.log(`  - ${guid} -> ${String(u.fields.CFC)}`)
        }
        if (updates.length > 20) console.log(`  ... ${updates.length - 20} more`)
    }

    if (flags.dryRun) {
        console.log('\n--dry-run: exiting without Airtable writes.')
        return
    }

    if (updates.length === 0) {
        console.log('\nNothing to update.')
        return
    }

    console.log('\nPatching Airtable...')
    await batchUpdateRecords(airtable, updates)
    console.log(`Done. Updated ${updates.length} row(s).`)
}

main()
    .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(msg)
        process.exit(1)
    })
    .finally(() => {
        closeAirtableClient()
    })
