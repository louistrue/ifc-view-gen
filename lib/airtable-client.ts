/**
 * Thin Airtable wrapper tailored to the door-render round:
 *   - list door rows (with pagination + Valid!=yes filter)
 *   - overwrite attachment fields (clear → upload)
 *   - upload PNG bytes directly via content.airtable.com (no blob host needed)
 *
 * All network calls pass through a single 5 req/s token bucket so pagination,
 * clears, uploads, and patches can be scheduled without coordinating locally.
 * Each request has a 30 s hard timeout and retries transient network failures
 * with exponential backoff.
 */

const API = 'https://api.airtable.com/v0'
const CONTENT = 'https://content.airtable.com/v0'

// Airtable publishes a 5 req/s/base limit. Stay a fraction under to leave room
// for retries without tripping the sliding window.
const TOKEN_CAPACITY = 5
const TOKEN_REFILL_MS = 250

// Per-request hard timeout. A stuck TCP connection can otherwise hang a worker
// indefinitely because fetch has no default timeout.
const REQUEST_TIMEOUT_MS = 30_000

// Max attempts for transient failures (network errors + 429s + 5xx). Attempts
// beyond this surface to the caller as a failure row in the summary.
const MAX_RETRY_ATTEMPTS = 5

export interface AirtableConfig {
    token: string
    baseId: string
    tableName: string
}

export interface DoorRecord {
    id: string
    guid: string
    valid: 'yes' | 'no' | null
    /** Full field payload, in case callers need Comment/Category/etc. */
    fields: Record<string, unknown>
}

export interface AttachmentFieldBytes {
    filename: string
    contentType: string
    bytes: Buffer
}

class TokenBucket {
    private available = TOKEN_CAPACITY
    private waiters: Array<() => void> = []
    private timer: ReturnType<typeof setInterval> | null = null

    private ensureTimer() {
        if (this.timer) return
        // Do NOT `.unref()` this timer: if every worker is awaiting a token and
        // this is the only pending event, Node's event loop would otherwise
        // fire `beforeExit` and kill the process with queued uploads still
        // in flight. The timer is explicitly stopped by `close()` when work
        // is done.
        this.timer = setInterval(() => this.refill(), TOKEN_REFILL_MS)
    }

    private maybeStopTimer() {
        if (this.timer && this.waiters.length === 0 && this.available === TOKEN_CAPACITY) {
            clearInterval(this.timer)
            this.timer = null
        }
    }

    private refill() {
        if (this.available < TOKEN_CAPACITY) this.available += 1
        while (this.available > 0 && this.waiters.length > 0) {
            this.available -= 1
            const waiter = this.waiters.shift()!
            waiter()
        }
        this.maybeStopTimer()
    }

    take(): Promise<void> {
        if (this.available > 0) {
            this.available -= 1
            return Promise.resolve()
        }
        this.ensureTimer()
        return new Promise((resolve) => this.waiters.push(resolve))
    }

    /** Call at end of main() so Node can exit cleanly. */
    close(): void {
        if (this.timer) {
            clearInterval(this.timer)
            this.timer = null
        }
    }
}

const bucket = new TokenBucket()

/** Stop the rate-limit timer so the process can exit naturally. */
export function closeAirtableClient(): void {
    bucket.close()
}

async function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
}

async function requestJson(url: string, init: RequestInit, token: string, attempt = 0): Promise<any> {
    await bucket.take()
    let response: Response
    try {
        response = await fetch(url, {
            ...init,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                ...(init.headers ?? {}),
            },
        })
    } catch (err) {
        // Transient: TypeError "fetch failed" (DNS/connection drop), AbortError
        // (timeout), undici socket errors. Retry with exponential backoff up to
        // MAX_RETRY_ATTEMPTS before giving up.
        if (attempt < MAX_RETRY_ATTEMPTS) {
            const wait = Math.min(15_000, 1000 * 2 ** attempt)
            await sleep(wait)
            return requestJson(url, init, token, attempt + 1)
        }
        throw err instanceof Error
            ? new Error(`Airtable network ${init.method ?? 'GET'} ${url} (after ${attempt + 1} tries): ${err.message}`)
            : err
    }
    // 429 + 5xx are also retriable.
    if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRY_ATTEMPTS) {
        const wait = Math.min(15_000, 1000 * 2 ** attempt)
        await sleep(wait)
        return requestJson(url, init, token, attempt + 1)
    }
    if (!response.ok) {
        const body = await response.text()
        throw new Error(`Airtable ${response.status} ${init.method ?? 'GET'} ${url}: ${body}`)
    }
    return response.json()
}

function toDoorRecord(raw: { id: string; fields?: Record<string, unknown> }): DoorRecord {
    const fields = raw.fields ?? {}
    const guid = typeof fields.GUID === 'string' ? fields.GUID : ''
    const validRaw = typeof fields.Valid === 'string' ? fields.Valid.trim().toLowerCase() : null
    const valid = validRaw === 'yes' ? 'yes' : validRaw === 'no' ? 'no' : null
    return { id: raw.id, guid, valid, fields }
}

export async function listDoors(
    config: AirtableConfig,
    options: { onlyNonValid?: boolean; onlyNo?: boolean } = {}
): Promise<DoorRecord[]> {
    const { token, baseId, tableName } = config
    const out: DoorRecord[] = []
    let offset: string | undefined
    do {
        const url = new URL(`${API}/${baseId}/${encodeURIComponent(tableName)}`)
        url.searchParams.set('pageSize', '100')
        if (options.onlyNo) {
            url.searchParams.set('filterByFormula', "{Valid} = 'no'")
        } else if (options.onlyNonValid) {
            url.searchParams.set('filterByFormula', "NOT({Valid} = 'yes')")
        }
        if (offset) url.searchParams.set('offset', offset)
        const data = await requestJson(url.toString(), { method: 'GET' }, token)
        for (const record of data.records ?? []) {
            const door = toDoorRecord(record)
            if (door.guid) out.push(door)
        }
        offset = data.offset
    } while (offset)
    return out
}

/**
 * Set a single field on a record. Uses `typecast: true` so single-select
 * values that don't yet exist (e.g. a new "check" option) are auto-created.
 */
export async function setRecordField(
    config: AirtableConfig,
    recordId: string,
    fieldName: string,
    value: unknown
): Promise<void> {
    await requestJson(
        `${API}/${config.baseId}/${encodeURIComponent(config.tableName)}/${recordId}`,
        {
            method: 'PATCH',
            body: JSON.stringify({ fields: { [fieldName]: value }, typecast: true }),
        },
        config.token
    )
}

/**
 * Batch PATCH up to 10 records in one call. Each entry gets its own `fields`
 * payload. Saves N-1 API calls per 10 records compared to `setRecordField`.
 */
export async function batchUpdateRecords(
    config: AirtableConfig,
    updates: ReadonlyArray<{ id: string; fields: Record<string, unknown> }>
): Promise<void> {
    if (updates.length === 0) return
    for (let i = 0; i < updates.length; i += 10) {
        const chunk = updates.slice(i, i + 10)
        await requestJson(
            `${API}/${config.baseId}/${encodeURIComponent(config.tableName)}`,
            {
                method: 'PATCH',
                body: JSON.stringify({ records: chunk, typecast: true }),
            },
            config.token
        )
    }
}

/** Clear the named attachment fields on a record before re-uploading. */
export async function clearAttachments(
    config: AirtableConfig,
    recordId: string,
    fieldNames: readonly string[]
): Promise<void> {
    if (fieldNames.length === 0) return
    const fields: Record<string, unknown[]> = {}
    for (const name of fieldNames) fields[name] = []
    await requestJson(
        `${API}/${config.baseId}/${encodeURIComponent(config.tableName)}/${recordId}`,
        { method: 'PATCH', body: JSON.stringify({ fields }) },
        config.token
    )
}

/**
 * Upload a PNG (or any supported attachment) directly into an Airtable field.
 * Appends to whatever is already there — use `clearAttachments` first if you
 * want pure overwrite semantics.
 *
 * https://airtable.com/developers/web/api/upload-attachment
 */
export async function uploadAttachment(
    config: AirtableConfig,
    recordId: string,
    fieldName: string,
    attachment: AttachmentFieldBytes
): Promise<void> {
    const url = `${CONTENT}/${config.baseId}/${recordId}/${encodeURIComponent(fieldName)}/uploadAttachment`
    const body = {
        contentType: attachment.contentType,
        filename: attachment.filename,
        file: attachment.bytes.toString('base64'),
    }
    await requestJson(url, { method: 'POST', body: JSON.stringify(body) }, config.token)
}
