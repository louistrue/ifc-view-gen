/**
 * Airtable render round.
 *
 * Pull every Doors row where Valid = 'no' (or a subset via --guids/--guid-file),
 * render front/back/plan from the IFC pair in .env, rasterise to PNG @ 1400 w,
 * keep a local backup, overwrite the Plan/Front/Back attachments on each
 * Airtable record, and set Valid = 'check' so the reviewer sees the row has
 * been re-rendered and is waiting for another look.
 *
 * Default filter: Valid = 'no' (explicit). Rows with Valid empty or any other
 * value are ignored unless --force is passed.
 *
 * Flags:
 *   --guids=a,b,c        subset
 *   --guid-file=path     subset from file (one per line, or comma/space/semicolon)
 *   --force              include every row regardless of Valid (for regression reruns)
 *   --dry-run            print the plan, render nothing
 *   --local-only         render + rasterise + local backup, skip Airtable
 *   --only=front,plan    limit views (default: front,back,plan)
 *   --limit=N            smoke test — only render the first N targets
 *   --no-mark-check      don't flip Valid to 'check' after upload
 *
 * Env:
 *   AIRTABLE_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_TABLE_NAME
 *   ARCH_IFC_PATH, ELEC_IFC_PATH
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderDoorsFromIfc, type DoorView } from '../lib/door-render-pipeline'
import { rasterizeSvgToPng, DEFAULT_RASTER_WIDTH_PX } from '../lib/png-rasterize'
import {
    batchUpdateRecords,
    clearAttachments,
    closeAirtableClient,
    listDoors,
    uploadAttachment,
    type AirtableConfig,
    type DoorRecord,
} from '../lib/airtable-client'

const ALL_VIEWS: readonly DoorView[] = ['front', 'back', 'plan']

const VIEW_TO_FIELD: Record<DoorView, 'Plan' | 'Front' | 'Back'> = {
    plan: 'Plan',
    front: 'Front',
    back: 'Back',
}

const LOCK_FILE = resolve(process.cwd(), '.airtable-round.lock')
const LOCK_TTL_MS = 60 * 60 * 1000
const MAX_ATTACHMENT_BYTES = 4.5 * 1024 * 1024

interface CliFlags {
    guids: string[] | null
    guidFile: string | null
    force: boolean
    dryRun: boolean
    localOnly: boolean
    views: readonly DoorView[]
    limit: number | null
    markCheck: boolean
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
        force: false,
        dryRun: false,
        localOnly: false,
        views: ALL_VIEWS,
        limit: null,
        markCheck: true,
    }
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (arg === '--') {
            // Bare `--` is npm's end-of-options marker and leaks through `node` invocation.
            continue
        } else if (arg === '--help' || arg === '-h') {
            printHelp()
            process.exit(0)
        } else if (arg === '--force') {
            flags.force = true
        } else if (arg === '--dry-run') {
            flags.dryRun = true
        } else if (arg === '--local-only') {
            flags.localOnly = true
        } else if (arg === '--no-mark-check') {
            flags.markCheck = false
        } else if (arg.startsWith('--guids=')) {
            flags.guids = parseCsvGuids(arg.slice('--guids='.length))
        } else if (arg === '--guids' && i + 1 < argv.length) {
            flags.guids = parseCsvGuids(argv[++i])
        } else if (arg.startsWith('--guid-file=')) {
            flags.guidFile = arg.slice('--guid-file='.length)
        } else if (arg === '--guid-file' && i + 1 < argv.length) {
            flags.guidFile = argv[++i]
        } else if (arg.startsWith('--only=')) {
            const views = arg.slice('--only='.length).split(',').map((v) => v.trim().toLowerCase())
            flags.views = views.filter((v): v is DoorView => v === 'front' || v === 'back' || v === 'plan')
            if (flags.views.length === 0) {
                throw new Error(`--only must list at least one of front,back,plan — got "${arg}"`)
            }
        } else if (arg.startsWith('--limit=')) {
            const n = Number.parseInt(arg.slice('--limit='.length), 10)
            if (!Number.isFinite(n) || n <= 0) throw new Error(`--limit must be a positive integer`)
            flags.limit = n
        } else {
            throw new Error(`Unknown flag: ${arg}`)
        }
    }
    return flags
}

function printHelp(): void {
    console.log(`airtable-render-round — render Doors table images

Default queue: Valid = 'no' (explicit). After a successful render+upload the
row's Valid flips to 'check' so the reviewer sees fresh renders pending
another look.

Flags:
  --guids=a,b,c        subset (comma/space/semicolon separated)
  --guid-file=path     subset from file (same separators, newlines ok)
  --force              include every row regardless of Valid
  --dry-run            list targets and exit
  --local-only         render locally; skip Airtable writes
  --only=front,plan    subset of views (default all three)
  --limit=N            only render first N targets
  --no-mark-check      don't set Valid='check' after successful upload

Env:
  AIRTABLE_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_TABLE_NAME
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
                `Round already in progress (${LOCK_FILE}, ${Math.round(age / 1000)}s old). `
                    + `Delete the file manually if you are sure nothing else is running.`
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
    } catch {
        /* best-effort */
    }
}

function roundId(): string {
    return new Date().toISOString().replace(/[:.]/g, '-')
}

async function main(): Promise<void> {
    const flags = parseFlags(process.argv.slice(2))

    const airtable: AirtableConfig = {
        token: requireEnv('AIRTABLE_TOKEN'),
        baseId: requireEnv('AIRTABLE_BASE_ID'),
        tableName: process.env.AIRTABLE_TABLE_NAME || 'Doors',
    }
    const archIfc = resolve(requireEnv('ARCH_IFC_PATH'))
    const elecIfc = process.env.ELEC_IFC_PATH ? resolve(process.env.ELEC_IFC_PATH) : null
    if (!existsSync(archIfc)) throw new Error(`ARCH_IFC_PATH not found: ${archIfc}`)
    if (elecIfc && !existsSync(elecIfc)) throw new Error(`ELEC_IFC_PATH not found: ${elecIfc}`)

    acquireLock()
    try {
        const backupRoot = resolve(process.cwd(), 'test-output', 'airtable-rounds', roundId())
        mkdirSync(backupRoot, { recursive: true })
        console.log(`Round backup dir: ${backupRoot}`)

        // 1. Fetch candidates
        const queueDescription = flags.force ? 'all records (--force)' : "Valid='no' only"
        console.log(`\nFetching Airtable records (${queueDescription})...`)
        const allDoors = await listDoors(airtable, flags.force ? {} : { onlyNo: true })
        const airtableByGuid = new Map(allDoors.map((d) => [d.guid, d]))
        console.log(`  ${allDoors.length} record(s) in queue`)

        // 2. Intersect with subset
        const subsetGuids = new Set<string>()
        if (flags.guids) flags.guids.forEach((g) => subsetGuids.add(g))
        if (flags.guidFile) readGuidsFromFile(flags.guidFile).forEach((g) => subsetGuids.add(g))

        let targets: DoorRecord[]
        if (subsetGuids.size > 0) {
            const missingInAirtable: string[] = []
            targets = []
            for (const guid of subsetGuids) {
                const record = airtableByGuid.get(guid)
                if (record) targets.push(record)
                else missingInAirtable.push(guid)
            }
            if (missingInAirtable.length > 0) {
                throw new Error(
                    `Subset has ${missingInAirtable.length} GUID(s) not in Airtable: ${missingInAirtable.slice(0, 5).join(', ')}${
                        missingInAirtable.length > 5 ? ', …' : ''
                    }`
                )
            }
        } else {
            targets = allDoors
        }

        if (flags.limit !== null && targets.length > flags.limit) {
            targets = targets.slice(0, flags.limit)
        }

        if (targets.length === 0) {
            console.log('Nothing to render — all caught up.')
            return
        }

        console.log(`\nTargets: ${targets.length} GUID(s)`)
        if (flags.dryRun) {
            for (const t of targets) console.log(`  - ${t.guid}`)
            console.log('\n--dry-run: exiting without rendering.')
            return
        }

        // 3. Render everything in one IFC session
        console.log(`\nLoading IFC and rendering (views: ${flags.views.join(',')})...`)
        const targetGuids = targets.map((t) => t.guid)
        const result = await renderDoorsFromIfc(
            { archIfcPath: archIfc, elecIfcPath: elecIfc },
            targetGuids,
            flags.views
        )
        console.log(
            `  rendered=${result.rendered.size} renderErrors=${result.renderErrors.size} notInIfc=${result.notInIfc.length}`
        )

        // 4a. Per-GUID local work (rasterise + write backup PNG/SVG) feeds a
        // shared queue that upload workers consume concurrently — rasterising
        // and uploading overlap so the 5 req/s upload bucket stays saturated
        // from second 1, saving several minutes over strict phase-ordering.
        const ok: string[] = []
        const failed: Array<{ guid: string; reason: string }> = []
        interface ReadyForUpload {
            target: { id: string; guid: string }
            guidDir: string
            pngByView: Partial<Record<DoorView, Buffer>>
        }
        const uploadQueue: ReadyForUpload[] = []
        let rasterisationComplete = false
        const queueWaiters: Array<() => void> = []
        const notifyWaiters = () => {
            while (queueWaiters.length > 0) {
                const w = queueWaiters.shift()!
                w()
            }
        }
        const takeFromQueue = async (): Promise<ReadyForUpload | null> => {
            while (true) {
                if (uploadQueue.length > 0) return uploadQueue.shift()!
                if (rasterisationComplete) return null
                await new Promise<void>((resolve) => queueWaiters.push(resolve))
            }
        }

        // Crash diagnostics: catch anything that would otherwise kill the
        // process without a summary, and reveal whether the round is blocking
        // on a pending Promise when Node decides to exit.
        process.on('uncaughtException', (err) => {
            console.error('[uncaughtException]', err)
        })
        process.on('unhandledRejection', (reason) => {
            console.error('[unhandledRejection]', reason)
        })
        process.on('beforeExit', (code) => {
            console.log(`[beforeExit] code=${code} queue=${uploadQueue.length} rasterDone=${rasterisationComplete} uploadCount=${uploadCount()}`)
        })
        process.on('exit', (code) => {
            // Last-gasp line, synchronous — this should always reach the log.
            process.stdout.write(`[exit] code=${code} queue=${uploadQueue.length} rasterDone=${rasterisationComplete} uploadCount=${uploadCount()}\n`)
        })

        // 4b. Start upload workers BEFORE rasterisation begins so the first
        // rasterised door is already uploaded while the rest are still being
        // converted. Each worker serialises its own HTTPS calls (1 clear + 3
        // uploads) so Node's connection pool stays happy.
        const UPLOAD_CONCURRENCY = 4
        const successfulRecordIds: string[] = []
        let uploadProgress = 0
        const uploadCount = () => uploadProgress

        const uploadOne = async (item: ReadyForUpload): Promise<void> => {
            const { target, guidDir, pngByView } = item
            try {
                const fieldsToClear = flags.views.map((v) => VIEW_TO_FIELD[v])
                await clearAttachments(airtable, target.id, fieldsToClear)
                for (const view of flags.views) {
                    const png = pngByView[view]
                    if (!png) continue
                    await uploadAttachment(airtable, target.id, VIEW_TO_FIELD[view], {
                        filename: `${sanitize(target.guid)}-${view}.png`,
                        contentType: 'image/png',
                        bytes: png,
                    })
                }
                successfulRecordIds.push(target.id)
                ok.push(target.guid)
                uploadProgress++
                console.log(`  [upload ${uploadProgress}] ok ${target.guid}`)
            } catch (err) {
                const msg = err instanceof Error ? (err.stack ?? err.message) : String(err)
                writeFileSync(resolve(guidDir, 'upload-error.txt'), `${msg}\n`)
                failed.push({
                    guid: target.guid,
                    reason: `upload failed: ${err instanceof Error ? err.message : String(err)}`,
                })
                uploadProgress++
                console.log(`  [upload ${uploadProgress}] FAILED ${target.guid}: ${err instanceof Error ? err.message : String(err)}`)
            }
        }

        const uploadWorkersPromise: Promise<void> = flags.localOnly
            ? Promise.resolve()
            : Promise.all(
                Array.from({ length: UPLOAD_CONCURRENCY }, async () => {
                    while (true) {
                        const item = await takeFromQueue()
                        if (!item) break
                        await uploadOne(item)
                    }
                })
            ).then(() => undefined)

        for (const target of targets) {
            const guid = target.guid
            const guidDir = resolve(backupRoot, sanitize(guid))
            mkdirSync(guidDir, { recursive: true })

            const renderError = result.renderErrors.get(guid)
            const rendered = result.rendered.get(guid)

            if (result.notInIfc.includes(guid)) {
                writeFileSync(resolve(guidDir, 'status.txt'), 'NOT_IN_IFC\n')
                failed.push({ guid, reason: 'not in IFC' })
                continue
            }

            if (renderError || !rendered) {
                const msg = renderError?.stack ?? renderError?.message ?? 'no renderer output'
                writeFileSync(resolve(guidDir, 'error.txt'), `${msg}\n`)
                failed.push({ guid, reason: `render failed: ${renderError?.message ?? 'unknown'}` })
                continue
            }

            const pngByView: Partial<Record<DoorView, Buffer>> = {}
            let rasterFailed = false
            for (const view of flags.views) {
                const svg = rendered.svg[view]
                if (!svg) continue
                writeFileSync(resolve(guidDir, `${view}.svg`), svg, 'utf8')
                let png: Buffer
                try {
                    png = rasterizeSvgToPng(svg)
                } catch (err) {
                    writeFileSync(
                        resolve(guidDir, `${view}-raster-error.txt`),
                        err instanceof Error ? (err.stack ?? err.message) : String(err)
                    )
                    rasterFailed = true
                    break
                }
                if (png.byteLength > MAX_ATTACHMENT_BYTES) {
                    try {
                        png = rasterizeSvgToPng(svg, 1000)
                    } catch (err) {
                        writeFileSync(
                            resolve(guidDir, `${view}-raster-error.txt`),
                            err instanceof Error ? (err.stack ?? err.message) : String(err)
                        )
                        rasterFailed = true
                        break
                    }
                    if (png.byteLength > MAX_ATTACHMENT_BYTES) {
                        writeFileSync(
                            resolve(guidDir, `${view}-raster-error.txt`),
                            `PNG still > ${MAX_ATTACHMENT_BYTES} bytes after width=1000 retry.`
                        )
                        rasterFailed = true
                        break
                    }
                }
                writeFileSync(resolve(guidDir, `${view}.png`), png)
                pngByView[view] = png
            }
            if (rasterFailed) {
                failed.push({ guid, reason: 'rasterisation failed (see backup dir)' })
                continue
            }

            if (flags.localOnly) {
                ok.push(guid)
                continue
            }

            uploadQueue.push({ target, guidDir, pngByView })
            notifyWaiters()
        }
        rasterisationComplete = true
        notifyWaiters()

        // Wait for upload workers to drain the queue.
        try {
            await uploadWorkersPromise
        } catch (err) {
            console.error('Upload worker loop crashed:', err instanceof Error ? err.message : err)
        }

        // 4c. Batched Valid='check' patch (10 records/call).
        if (flags.markCheck && successfulRecordIds.length > 0) {
            try {
                await batchUpdateRecords(
                    airtable,
                    successfulRecordIds.map((id) => ({ id, fields: { Valid: 'check' } }))
                )
                console.log(`  marked ${successfulRecordIds.length} record(s) Valid='check'`)
            } catch (err) {
                console.error('Batch mark failed:', err instanceof Error ? err.message : err)
            }
        }

        // 5. Summary — always print, even on partial failure.
        console.log(`\n--- summary ---`)
        console.log(`  rendered: ${uploadCount()} uploaded, ${failed.length} failed`)
        console.log(`  ok:     ${ok.length}`)
        console.log(`  failed: ${failed.length}`)
        for (const f of failed) console.log(`    - ${f.guid}: ${f.reason}`)
        console.log(`  backup: ${backupRoot}`)

        if (failed.length > 0) process.exitCode = 1
    } finally {
        releaseLock()
        closeAirtableClient()
    }
}

function sanitize(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'door'
}

main().catch((err) => {
    // Per-GUID errors are already captured to the backup dir; at top level the
    // message is enough. Full stacks are only useful while developing the CLI,
    // in which case set DEBUG_STACK=1.
    const msg = err instanceof Error ? err.message : String(err)
    console.error(process.env.DEBUG_STACK ? (err instanceof Error ? err.stack : err) : msg)
    releaseLock()
    process.exit(1)
})
