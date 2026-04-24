/**
 * Resume the Airtable upload phase from an existing round backup dir.
 *
 * For each `<backup>/<GUID>/` dir that has {plan,front,back}.png, run:
 *   clear → upload (sequentially) → mark Valid='check' (batched at end).
 *
 * Runs with a bounded worker pool (default 4 doors in flight). Each worker's
 * uploads are SEQUENTIAL within a door so Node's default HTTPS agent pool is
 * never saturated. Per-door progress is printed as newline-terminated lines so
 * the log stays visible when stdout is piped.
 *
 * Usage:
 *   node scripts/resume-upload-from-backup-runner.js <backup-dir>
 *   node scripts/resume-upload-from-backup-runner.js <backup-dir> --concurrency=3
 *
 * Skips dirs that are missing any of the 3 PNGs (e.g. NOT_IN_IFC stubs).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import {
    batchUpdateRecords,
    clearAttachments,
    closeAirtableClient,
    listDoors,
    uploadAttachment,
    type AirtableConfig,
} from '../lib/airtable-client'

const VIEW_FIELDS = [
    { view: 'plan' as const, field: 'Plan' as const, file: 'plan.png' },
    { view: 'front' as const, field: 'Front' as const, file: 'front.png' },
    { view: 'back' as const, field: 'Back' as const, file: 'back.png' },
]

function sanitize(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'door'
}

function parseArgs(argv: string[]): { backupDir: string; concurrency: number } {
    let backupDir: string | null = null
    let concurrency = 4
    for (const arg of argv) {
        if (arg.startsWith('--concurrency=')) {
            const n = Number.parseInt(arg.slice('--concurrency='.length), 10)
            if (!Number.isFinite(n) || n <= 0 || n > 10) {
                throw new Error(`--concurrency must be 1..10; got "${arg}"`)
            }
            concurrency = n
        } else if (!arg.startsWith('-')) {
            backupDir = arg
        }
    }
    if (!backupDir) {
        throw new Error('Usage: resume-upload-from-backup <backup-dir> [--concurrency=N]')
    }
    const abs = resolve(backupDir)
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
        throw new Error(`Backup dir not found: ${abs}`)
    }
    return { backupDir: abs, concurrency }
}

function requireEnv(name: string): string {
    const v = process.env[name]
    if (!v) throw new Error(`${name} is required`)
    return v
}

interface DoorBackup {
    sanitizedGuid: string
    pngs: Record<'plan' | 'front' | 'back', Buffer>
}

function readBackupDoors(backupDir: string): DoorBackup[] {
    const out: DoorBackup[] = []
    for (const entry of readdirSync(backupDir)) {
        const dir = resolve(backupDir, entry)
        if (!statSync(dir).isDirectory()) continue
        const pngs: Partial<Record<'plan' | 'front' | 'back', Buffer>> = {}
        let missing = false
        for (const { view, file } of VIEW_FIELDS) {
            const path = resolve(dir, file)
            if (!existsSync(path)) { missing = true; break }
            pngs[view] = readFileSync(path)
        }
        if (missing) continue
        out.push({ sanitizedGuid: entry, pngs: pngs as DoorBackup['pngs'] })
    }
    return out
}

async function main() {
    require('dotenv').config()
    const { backupDir, concurrency } = parseArgs(process.argv.slice(2))

    const airtable: AirtableConfig = {
        token: requireEnv('AIRTABLE_TOKEN'),
        baseId: requireEnv('AIRTABLE_BASE_ID'),
        tableName: process.env.AIRTABLE_TABLE_NAME ?? 'Doors',
    }

    console.log(`Backup dir: ${backupDir}`)
    console.log(`Concurrency: ${concurrency} (sequential uploads within each door)`)

    const backups = readBackupDoors(backupDir)
    console.log(`Doors with full 3-view PNG set: ${backups.length}`)
    if (backups.length === 0) return

    console.log('Fetching Airtable records to map GUID → record ID...')
    const allDoors = await listDoors(airtable)
    const recordByGuid = new Map<string, string>()
    const recordBySanitized = new Map<string, string>()
    for (const d of allDoors) {
        if (!d.guid) continue
        recordByGuid.set(d.guid, d.id)
        recordBySanitized.set(sanitize(d.guid), d.id)
    }

    interface Job { sanitizedGuid: string; recordId: string; pngs: DoorBackup['pngs'] }
    const jobs: Job[] = []
    const orphans: string[] = []
    for (const b of backups) {
        const recordId = recordBySanitized.get(b.sanitizedGuid)
        if (!recordId) { orphans.push(b.sanitizedGuid); continue }
        jobs.push({ sanitizedGuid: b.sanitizedGuid, recordId, pngs: b.pngs })
    }
    console.log(`Matched ${jobs.length} doors to Airtable records, ${orphans.length} orphans.`)
    if (orphans.length > 0) {
        console.log(`  orphans (first 10): ${orphans.slice(0, 10).join(', ')}`)
    }
    if (jobs.length === 0) return

    const successfulRecordIds: string[] = []
    const failed: Array<{ sanitizedGuid: string; reason: string }> = []
    let done = 0
    const total = jobs.length

    const uploadOne = async (job: Job): Promise<void> => {
        const { recordId, sanitizedGuid, pngs } = job
        try {
            await clearAttachments(airtable, recordId, ['Plan', 'Front', 'Back'])
            // Sequential uploads within a door — avoids exhausting Node's
            // HTTPS agent pool when multiple doors are in flight.
            for (const { view, field } of VIEW_FIELDS) {
                await uploadAttachment(airtable, recordId, field, {
                    filename: `${sanitizedGuid}-${view}.png`,
                    contentType: 'image/png',
                    bytes: pngs[view],
                })
            }
            successfulRecordIds.push(recordId)
            done++
            console.log(`  [${done}/${total}] uploaded ${sanitizedGuid}`)
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err)
            failed.push({ sanitizedGuid, reason })
            done++
            console.log(`  [${done}/${total}] FAILED ${sanitizedGuid}: ${reason}`)
        }
    }

    const queue = jobs.slice()
    const workers: Promise<void>[] = []
    for (let w = 0; w < Math.min(concurrency, queue.length); w++) {
        workers.push((async () => {
            while (queue.length > 0) {
                const job = queue.shift()
                if (!job) break
                await uploadOne(job)
            }
        })())
    }
    await Promise.all(workers)

    console.log(`\nUploads done. Marking ${successfulRecordIds.length} records Valid='check' (batched)...`)
    if (successfulRecordIds.length > 0) {
        await batchUpdateRecords(
            airtable,
            successfulRecordIds.map((id) => ({ id, fields: { Valid: 'check' } }))
        )
    }

    console.log(`\n--- summary ---`)
    console.log(`  ok:      ${successfulRecordIds.length}`)
    console.log(`  failed:  ${failed.length}`)
    console.log(`  orphans: ${orphans.length}`)
    for (const f of failed) console.log(`    - ${f.sanitizedGuid}: ${f.reason}`)
    if (failed.length > 0) process.exitCode = 1
    closeAirtableClient()
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    closeAirtableClient()
    process.exit(1)
})
