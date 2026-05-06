/**
 * ifc-lite-based Airtable render round.
 *
 * Same flag surface as `airtable-render-round.ts`, but the geometry pipeline
 * is the local @ifc-lite parser + WASM (no web-ifc, no ThatOpen Fragments).
 *
 * Default mode is `--local-only` so you have to opt in to Airtable mutation
 * with `--push`.  This is intentional during the rewrite — we want PNGs on
 * disk before any record gets touched.
 *
 * Flags:
 *   --guids=a,b,c        subset
 *   --guid-file=path     subset from file
 *   --force              ignore Valid filter (default fetches `Valid='no'` only)
 *   --dry-run            list targets and exit
 *   --local-only         (default) render to disk; never touch Airtable
 *   --push               actually upload to Airtable + flip Valid='check'
 *   --only=front,plan    subset of views
 *   --limit=N            cap targets
 *   --no-mark-check      skip the Valid='check' patch even when --push
 *   --no-airtable        skip pulling Airtable too — render every door in IFC
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
    analyzeDoor,
    buildAnalyzerCaches,
    type DoorContextLite,
} from '../lib/ifclite-door-analyzer'
import { renderDoorViewsLite } from '../lib/ifclite-renderer'
import { rasterizeSvgToPng } from '../lib/png-rasterize'
import { loadIfcLiteModel, type IfcLiteModel } from '../lib/ifclite-source'
import {
    batchUpdateRecords,
    clearAttachments,
    closeAirtableClient,
    listDoors,
    uploadAttachment,
    type AirtableConfig,
    type DoorRecord,
} from '../lib/airtable-client'

type View = 'front' | 'back' | 'plan'

const ALL_VIEWS: readonly View[] = ['front', 'back', 'plan']
const VIEW_TO_FIELD: Record<View, 'Plan' | 'Front' | 'Back'> = {
    plan: 'Plan',
    front: 'Front',
    back: 'Back',
}

const LOCK_FILE = resolve(process.cwd(), '.ifclite-round.lock')
const LOCK_TTL_MS = 60 * 60 * 1000
const MAX_ATTACHMENT_BYTES = 4.5 * 1024 * 1024

interface CliFlags {
    guids: string[] | null
    guidFile: string | null
    force: boolean
    /** Queue both Valid='no' AND Valid='check' rows (the full reviewer queue). */
    reviewQueue: boolean
    dryRun: boolean
    push: boolean
    skipAirtable: boolean
    views: readonly View[]
    limit: number | null
    markCheck: boolean
}

function parseCsvGuids(raw: string): string[] {
    return raw.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean)
}

function parseFlags(argv: string[]): CliFlags {
    const flags: CliFlags = {
        guids: null,
        guidFile: null,
        force: false,
        reviewQueue: false,
        dryRun: false,
        push: false,
        skipAirtable: false,
        views: ALL_VIEWS,
        limit: null,
        markCheck: true,
    }
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (arg === '--') continue
        else if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0) }
        else if (arg === '--force') flags.force = true
        else if (arg === '--review-queue') flags.reviewQueue = true
        else if (arg === '--dry-run') flags.dryRun = true
        else if (arg === '--local-only') flags.push = false
        else if (arg === '--push') flags.push = true
        else if (arg === '--no-mark-check') flags.markCheck = false
        else if (arg === '--no-airtable') flags.skipAirtable = true
        else if (arg.startsWith('--guids=')) flags.guids = parseCsvGuids(arg.slice('--guids='.length))
        else if (arg === '--guids' && i + 1 < argv.length) flags.guids = parseCsvGuids(argv[++i])
        else if (arg.startsWith('--guid-file=')) flags.guidFile = arg.slice('--guid-file='.length)
        else if (arg === '--guid-file' && i + 1 < argv.length) flags.guidFile = argv[++i]
        else if (arg.startsWith('--only=')) {
            const views = arg.slice('--only='.length).split(',').map((v) => v.trim().toLowerCase())
            flags.views = views.filter((v): v is View => v === 'front' || v === 'back' || v === 'plan')
            if (flags.views.length === 0) throw new Error(`--only must list at least one of front,back,plan`)
        }
        else if (arg.startsWith('--limit=')) {
            const n = Number.parseInt(arg.slice('--limit='.length), 10)
            if (!Number.isFinite(n) || n <= 0) throw new Error(`--limit must be a positive integer`)
            flags.limit = n
        }
        else throw new Error(`Unknown flag: ${arg}`)
    }
    return flags
}

function printHelp(): void {
    console.log(`ifclite-airtable-rounds — render Doors table images via @ifc-lite

Default queue: Valid = 'no' (explicit). Default mode: --local-only.
Pass --push to actually write attachments + flip Valid='check'.

Flags:
  --guids=a,b,c        subset (comma/space/semicolon separated)
  --guid-file=path     subset from file
  --force              include every record regardless of Valid
  --review-queue       queue Valid='no' AND Valid='check' rows
  --dry-run            list targets and exit
  --local-only         (default) render to disk; never touch Airtable
  --push               actually upload to Airtable
  --only=front,plan    subset of views (default all three)
  --limit=N            only render first N targets
  --no-mark-check      don't set Valid='check' after upload
  --no-airtable        skip Airtable; render every door in the IFC

Env:
  AIRTABLE_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_TABLE_NAME (only when --push or default mode)
  ARCH_IFC_PATH, ELEC_IFC_PATH`)
}

function readGuidsFromFile(path: string): string[] {
    const abs = resolve(path)
    if (!existsSync(abs)) throw new Error(`--guid-file not found: ${abs}`)
    return parseCsvGuids(readFileSync(abs, 'utf8'))
}

function requireEnv(name: string): string {
    const value = process.env[name]
    if (!value) throw new Error(`${name} is required in environment (.env)`)
    return value
}

function acquireLock(): void {
    if (existsSync(LOCK_FILE)) {
        const age = Date.now() - statSync(LOCK_FILE).mtimeMs
        if (age < LOCK_TTL_MS) {
            throw new Error(
                `Round in progress (${LOCK_FILE}, ${Math.round(age / 1000)}s old). `
                + `Delete the file manually if nothing is running.`
            )
        }
        console.warn(`Stale lock (${Math.round(age / 1000)}s); stealing.`)
    }
    writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
}

function releaseLock(): void {
    try {
        if (existsSync(LOCK_FILE)) {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            require('node:fs').unlinkSync(LOCK_FILE)
        }
    } catch { /* best-effort */ }
}

function roundId(): string { return new Date().toISOString().replace(/[:.]/g, '-') }

function sanitize(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'door'
}

interface RenderTarget {
    guid: string
    airtableRecordId: string | null
}

async function renderOne(
    arch: IfcLiteModel,
    elec: IfcLiteModel | null,
    caches: ReturnType<typeof buildAnalyzerCaches>,
    guidToExpressId: Map<string, number>,
    target: RenderTarget,
    views: readonly View[],
    backupRoot: string,
): Promise<{ pngs: Partial<Record<View, Buffer>>; ctx: DoorContextLite | null; reason?: string }> {
    const expressId = guidToExpressId.get(target.guid)
    if (expressId == null) return { pngs: {}, ctx: null, reason: 'not in IFC' }
    if (target.guid === '08v$5$g4ScGA26DW5Jh6Mz') {
        // #region agent log
        fetch('http://127.0.0.1:7398/ingest/5834f702-43d3-4b33-b0b3-25930b74e01f',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'b464c7'},body:JSON.stringify({sessionId:'b464c7',runId:process.env.DEBUG_RUN_ID ?? 'pre-fix',hypothesisId:'H8',location:'scripts/ifclite-airtable-rounds.ts:renderOne',message:'Ifclite render pipeline path hit for target guid',data:{guid:target.guid,expressId,views},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
    }
    const ctx = analyzeDoor(arch, expressId, caches, elec)
    if (!ctx) return { pngs: {}, ctx: null, reason: 'analyzer returned null' }
    const svgs = renderDoorViewsLite(ctx)
    const pngs: Partial<Record<View, Buffer>> = {}
    const guidDir = resolve(backupRoot, sanitize(target.guid))
    mkdirSync(guidDir, { recursive: true })
    for (const view of views) {
        const svg = svgs[view]
        writeFileSync(resolve(guidDir, `${view}.svg`), svg, 'utf8')
        let png = rasterizeSvgToPng(svg)
        if (png.byteLength > MAX_ATTACHMENT_BYTES) {
            png = rasterizeSvgToPng(svg, 1000)
        }
        writeFileSync(resolve(guidDir, `${view}.png`), png)
        pngs[view] = png
    }
    return { pngs, ctx }
}

async function main(): Promise<void> {
    const flags = parseFlags(process.argv.slice(2))

    const archIfc = resolve(requireEnv('ARCH_IFC_PATH'))
    const elecIfc = process.env.ELEC_IFC_PATH ? resolve(process.env.ELEC_IFC_PATH) : null
    if (!existsSync(archIfc)) throw new Error(`ARCH_IFC_PATH not found: ${archIfc}`)
    if (elecIfc && !existsSync(elecIfc)) throw new Error(`ELEC_IFC_PATH not found: ${elecIfc}`)

    const usingAirtable = !flags.skipAirtable
    let airtable: AirtableConfig | null = null
    if (usingAirtable) {
        airtable = {
            token: requireEnv('AIRTABLE_TOKEN'),
            baseId: requireEnv('AIRTABLE_BASE_ID'),
            tableName: process.env.AIRTABLE_TABLE_NAME || 'Doors',
        }
    }

    acquireLock()
    try {
        const backupRoot = resolve(process.cwd(), 'test-output', 'ifclite-rounds', roundId())
        mkdirSync(backupRoot, { recursive: true })
        console.log(`Round backup dir: ${backupRoot}`)
        console.log(`Mode: ${flags.push ? '--push (Airtable will be modified)' : '--local-only'}`)

        // 1. Load IFC(s).
        console.log('\nLoading AR IFC…')
        const tArch = Date.now()
        const arch = await loadIfcLiteModel(archIfc)
        console.log(`  AR ready: ${arch.byType('IFCDOOR').length} doors in ${Date.now() - tArch}ms`)
        let elec: IfcLiteModel | null = null
        if (elecIfc) {
            const tElec = Date.now()
            console.log('Loading EL IFC…')
            elec = await loadIfcLiteModel(elecIfc)
            console.log(`  EL ready: ${elec.allMeshes.length} meshes in ${Date.now() - tElec}ms`)
        }

        // 2. Build guid → expressId map.
        const guidToExpressId = new Map<string, number>()
        const archDoors = arch.byType('IFCDOOR')
        for (const id of archDoors) {
            const a = arch.attrs(id)
            if (a?.globalId) guidToExpressId.set(a.globalId, id)
        }
        console.log(`  guid map size: ${guidToExpressId.size}`)

        // 3. Targets.
        let targets: RenderTarget[]
        let recordsByGuid: Map<string, DoorRecord> = new Map()
        if (usingAirtable && airtable) {
            console.log('\nFetching Airtable records…')
            const filterOpts = flags.force
                ? {}
                : flags.reviewQueue
                    ? { onlyReviewable: true }
                    : { onlyNo: true }
            const queueDescription = flags.force
                ? 'all (--force)'
                : flags.reviewQueue
                    ? "Valid='no' OR Valid='check'"
                    : "Valid='no' only"
            console.log(`  filter: ${queueDescription}`)
            const records = await listDoors(airtable, filterOpts)
            recordsByGuid = new Map(records.map((d) => [d.guid, d]))
            console.log(`  ${records.length} candidate records`)

            const subsetGuids = new Set<string>()
            if (flags.guids) flags.guids.forEach((g) => subsetGuids.add(g))
            if (flags.guidFile) readGuidsFromFile(flags.guidFile).forEach((g) => subsetGuids.add(g))

            let chosen: DoorRecord[]
            if (subsetGuids.size > 0) {
                const missing: string[] = []
                chosen = []
                for (const g of subsetGuids) {
                    const rec = recordsByGuid.get(g)
                    if (rec) chosen.push(rec)
                    else missing.push(g)
                }
                if (missing.length > 0) {
                    throw new Error(
                        `Subset has ${missing.length} GUID(s) not in Airtable: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}`
                    )
                }
            } else chosen = records
            targets = chosen.map((r) => ({ guid: r.guid, airtableRecordId: r.id }))
        } else {
            // No Airtable: build targets from --guids / --guid-file or every door in IFC.
            const subset = new Set<string>()
            if (flags.guids) flags.guids.forEach((g) => subset.add(g))
            if (flags.guidFile) readGuidsFromFile(flags.guidFile).forEach((g) => subset.add(g))
            if (subset.size > 0) {
                targets = [...subset].map((g) => ({ guid: g, airtableRecordId: null }))
            } else {
                targets = []
                for (const [guid] of guidToExpressId.entries()) {
                    targets.push({ guid, airtableRecordId: null })
                }
            }
        }

        if (flags.limit !== null && targets.length > flags.limit) {
            targets = targets.slice(0, flags.limit)
        }

        if (targets.length === 0) {
            console.log('Nothing to render — all caught up.')
            return
        }

        console.log(`\nTargets: ${targets.length}`)
        if (flags.dryRun) {
            for (const t of targets.slice(0, 50)) console.log(`  - ${t.guid}`)
            if (targets.length > 50) console.log(`  …${targets.length - 50} more`)
            console.log('\n--dry-run: exiting without rendering.')
            return
        }

        // 4. Build analyzer caches once.
        console.log('\nBuilding analyzer caches…')
        const tCaches = Date.now()
        const caches = buildAnalyzerCaches(arch, elec)
        console.log(`  caches built in ${Date.now() - tCaches}ms`)

        // 5. Render loop (sequential — fast enough; renderer is CPU-bound).
        console.log(`\nRendering (views: ${flags.views.join(',')})…`)
        const ok: string[] = []
        const failed: Array<{ guid: string; reason: string }> = []
        let processed = 0
        for (const target of targets) {
            processed++
            const tDoor = Date.now()
            try {
                const result = await renderOne(arch, elec, caches, guidToExpressId, target, flags.views, backupRoot)
                if (result.reason) {
                    failed.push({ guid: target.guid, reason: result.reason })
                    console.log(`  [${processed}/${targets.length}] FAIL ${target.guid}: ${result.reason}`)
                    continue
                }
                ok.push(target.guid)
                if (processed % 50 === 0 || processed === targets.length) {
                    console.log(`  [${processed}/${targets.length}] ok ${target.guid} (${Date.now() - tDoor}ms)`)
                }
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err)
                failed.push({ guid: target.guid, reason: msg })
                console.log(`  [${processed}/${targets.length}] EXC ${target.guid}: ${msg}`)
            }
        }

        // 6. Optional Airtable push.
        if (flags.push && airtable) {
            console.log('\nUploading to Airtable…')
            const successfulRecordIds: string[] = []
            for (const guid of ok) {
                const rec = recordsByGuid.get(guid)
                if (!rec) continue
                const guidDir = resolve(backupRoot, sanitize(guid))
                try {
                    await clearAttachments(airtable, rec.id, flags.views.map((v) => VIEW_TO_FIELD[v]))
                    for (const view of flags.views) {
                        const pngPath = resolve(guidDir, `${view}.png`)
                        if (!existsSync(pngPath)) continue
                        await uploadAttachment(airtable, rec.id, VIEW_TO_FIELD[view], {
                            filename: `${sanitize(guid)}-${view}.png`,
                            contentType: 'image/png',
                            bytes: readFileSync(pngPath),
                        })
                    }
                    successfulRecordIds.push(rec.id)
                } catch (err) {
                    failed.push({ guid, reason: `upload failed: ${err instanceof Error ? err.message : String(err)}` })
                }
            }
            if (flags.markCheck && successfulRecordIds.length > 0) {
                await batchUpdateRecords(airtable, successfulRecordIds.map((id) => ({ id, fields: { Valid: 'check' } })))
                console.log(`  marked ${successfulRecordIds.length} record(s) Valid='check'`)
            }
        }

        // 7. Summary
        console.log(`\n--- summary ---`)
        console.log(`  ok:     ${ok.length}`)
        console.log(`  failed: ${failed.length}`)
        for (const f of failed.slice(0, 20)) console.log(`    - ${f.guid}: ${f.reason}`)
        if (failed.length > 20) console.log(`    …${failed.length - 20} more`)
        console.log(`  backup: ${backupRoot}`)
        if (failed.length > 0) process.exitCode = 1
    } finally {
        releaseLock()
        closeAirtableClient()
    }
}

main().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(process.env.DEBUG_STACK ? (err instanceof Error ? err.stack : err) : msg)
    releaseLock()
    process.exit(1)
})
