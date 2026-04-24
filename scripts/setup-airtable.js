#!/usr/bin/env node

/**
 * Idempotent Airtable schema bootstrap for the door-render round pipeline.
 *
 * Creates (or adopts) the `Doors` table with exactly these fields:
 *   GUID      primary single-line text
 *   Valid     single-select: yes | no
 *   Comment   long text
 *   Category  single-line text
 *   Plan      multiple attachments
 *   Front     multiple attachments
 *   Back      multiple attachments
 *
 * Re-running is safe: existing fields are left alone, missing fields are added.
 * Never deletes fields or records.
 *
 * Env:
 *   AIRTABLE_TOKEN          Personal Access Token with schema.bases:write + data.records:read
 *   AIRTABLE_BASE_ID        (optional) target base; if absent, prints picker
 *   AIRTABLE_TABLE_NAME     (optional) table name, defaults to "Doors"
 */

require('dotenv').config()

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID
const TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || 'Doors'

if (!AIRTABLE_TOKEN) {
    console.error('AIRTABLE_TOKEN environment variable is required')
    process.exit(1)
}

const META_BASE = 'https://api.airtable.com/v0/meta'

async function airtable(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: {
            Authorization: `Bearer ${AIRTABLE_TOKEN}`,
            'Content-Type': 'application/json',
            ...options.headers,
        },
    })
    if (!response.ok) {
        const body = await response.text()
        throw new Error(`Airtable ${response.status}: ${body}`)
    }
    return response.json()
}

async function listBases() {
    const { bases } = await airtable(`${META_BASE}/bases`)
    return bases
}

async function getTables(baseId) {
    const { tables } = await airtable(`${META_BASE}/bases/${baseId}/tables`)
    return tables
}

/**
 * Field specs in creation order. The first field (GUID) becomes the primary
 * when Airtable creates the table fresh.
 */
function desiredFields() {
    return [
        {
            name: 'GUID',
            type: 'singleLineText',
            description: 'IFC GlobalId of the door. Primary key for this table.',
        },
        {
            name: 'Valid',
            type: 'singleSelect',
            description: 'Human review verdict. Round script renders every row where Valid="no", then sets Valid="check" so the reviewer sees fresh renders pending another look.',
            options: {
                choices: [{ name: 'yes' }, { name: 'no' }, { name: 'check' }],
            },
        },
        {
            name: 'Comment',
            type: 'multilineText',
            description: 'Human-written notes about what is wrong or what needs to change.',
        },
        {
            name: 'Category',
            type: 'singleLineText',
            description: 'Free-form category tag. Type whatever you want, no predefined list.',
        },
        {
            name: 'Plan',
            type: 'multipleAttachments',
            description: 'Plan (Grundriss) PNG rendered by scripts/airtable-render-round.ts.',
        },
        {
            name: 'Front',
            type: 'multipleAttachments',
            description: 'Front elevation (Vorderansicht) PNG rendered by scripts/airtable-render-round.ts.',
        },
        {
            name: 'Back',
            type: 'multipleAttachments',
            description: 'Back elevation (Rückansicht) PNG rendered by scripts/airtable-render-round.ts.',
        },
    ]
}

async function createTable(baseId) {
    const body = {
        name: TABLE_NAME,
        description: 'Door render review queue driven by scripts/airtable-render-round.ts.',
        fields: desiredFields(),
    }
    return airtable(`${META_BASE}/bases/${baseId}/tables`, {
        method: 'POST',
        body: JSON.stringify(body),
    })
}

async function addField(baseId, tableId, fieldSpec) {
    return airtable(`${META_BASE}/bases/${baseId}/tables/${tableId}/fields`, {
        method: 'POST',
        body: JSON.stringify(fieldSpec),
    })
}

async function resolveBaseId() {
    if (AIRTABLE_BASE_ID) return AIRTABLE_BASE_ID
    const bases = await listBases()
    if (bases.length === 0) {
        console.error('No bases available for this token. Create one in Airtable first.')
        process.exit(1)
    }
    console.log('AIRTABLE_BASE_ID is not set. Available bases:')
    for (const base of bases) {
        console.log(`  ${base.id}  ${base.name}`)
    }
    console.error('\nPick one and add it to .env as AIRTABLE_BASE_ID=..., then re-run.')
    process.exit(1)
}

async function main() {
    const baseId = await resolveBaseId()
    console.log(`Target base: ${baseId}`)
    console.log(`Target table: ${TABLE_NAME}`)

    const tables = await getTables(baseId)
    let table = tables.find((t) => t.name === TABLE_NAME)

    if (!table) {
        console.log(`Table "${TABLE_NAME}" not found; creating with full schema.`)
        table = await createTable(baseId)
        console.log(`Created table ${table.id} with ${table.fields.length} field(s).`)
    } else {
        console.log(`Table "${TABLE_NAME}" already exists (${table.id}); reconciling fields.`)
        const existing = new Set(table.fields.map((f) => f.name))
        for (const spec of desiredFields()) {
            if (existing.has(spec.name)) continue
            console.log(`  + adding missing field: ${spec.name} (${spec.type})`)
            await addField(baseId, table.id, spec)
        }
    }

    const final = await getTables(baseId)
    const doorsTable = final.find((t) => t.name === TABLE_NAME)
    console.log(`\nFinal field list for ${TABLE_NAME}:`)
    for (const field of doorsTable.fields) {
        console.log(`  - ${field.name} (${field.type})`)
    }

    console.log(`\nDone. Add/confirm in your .env:`)
    console.log(`  AIRTABLE_BASE_ID=${baseId}`)
    console.log(`  AIRTABLE_TABLE_NAME=${TABLE_NAME}`)
}

main().catch((err) => {
    console.error(err.message || err)
    process.exit(1)
})
