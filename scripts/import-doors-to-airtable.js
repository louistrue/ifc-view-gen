#!/usr/bin/env node

/**
 * Seed the Airtable `Doors` table with every IfcDoor GlobalId from an IFC file.
 *
 * Writes only GUID and Valid=no for new rows. Leaves existing rows (matched by
 * GUID) untouched so re-running is safe when you already have human review in
 * progress. No images, no type names, no opening directions — that all belongs
 * to the render round, not the seed.
 *
 * Usage:
 *   node scripts/import-doors-to-airtable.js [ifc-file-path]
 *
 * If no path is given, uses ARCH_IFC_PATH from .env.
 *
 * Env:
 *   AIRTABLE_TOKEN       Personal Access Token (data.records:write)
 *   AIRTABLE_BASE_ID     Base ID (run setup-airtable.js first)
 *   AIRTABLE_TABLE_NAME  Table name (defaults to "Doors")
 *   ARCH_IFC_PATH        (optional) default IFC path
 */

require('dotenv').config()

const fs = require('node:fs')
const path = require('node:path')
const WebIFC = require('web-ifc')

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || 'Doors'
const API = 'https://api.airtable.com/v0'

if (!AIRTABLE_TOKEN) {
    console.error('AIRTABLE_TOKEN is required')
    process.exit(1)
}
if (!AIRTABLE_BASE_ID) {
    console.error('AIRTABLE_BASE_ID is required (run scripts/setup-airtable.js first)')
    process.exit(1)
}

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

async function extractDoorGuidsFromIfc(filePath) {
    const api = new WebIFC.IfcAPI()
    await api.Init()
    const bytes = fs.readFileSync(filePath)
    const modelID = api.OpenModel(new Uint8Array(bytes))
    const doorLines = api.GetLineIDsWithType(modelID, WebIFC.IFCDOOR)
    const guids = []
    for (let i = 0; i < doorLines.size(); i++) {
        const expressID = doorLines.get(i)
        const door = api.GetLine(modelID, expressID)
        const globalId = door.GlobalId?.value
        if (globalId) guids.push(globalId)
    }
    api.CloseModel(modelID)
    return guids
}

async function fetchAllExistingGuids() {
    const existing = new Set()
    let offset
    do {
        const url = new URL(`${API}/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`)
        url.searchParams.set('pageSize', '100')
        url.searchParams.append('fields[]', 'GUID')
        if (offset) url.searchParams.set('offset', offset)
        const data = await airtable(url.toString())
        for (const record of data.records) {
            const guid = record.fields?.GUID
            if (guid) existing.add(guid)
        }
        offset = data.offset
    } while (offset)
    return existing
}

async function createRecordsBatched(guids) {
    let created = 0
    const BATCH = 10
    for (let i = 0; i < guids.length; i += BATCH) {
        const slice = guids.slice(i, i + BATCH)
        const records = slice.map((guid) => ({ fields: { GUID: guid, Valid: 'no' } }))
        await airtable(`${API}/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`, {
            method: 'POST',
            body: JSON.stringify({ records, typecast: true }),
        })
        created += slice.length
        process.stdout.write(`\r  created ${created}/${guids.length}`)
        if (i + BATCH < guids.length) {
            // stay under 5 req/s
            await new Promise((r) => setTimeout(r, 220))
        }
    }
    process.stdout.write('\n')
    return created
}

async function main() {
    const cliPath = process.argv[2]
    const envPath = process.env.ARCH_IFC_PATH
    const filePath = cliPath
        ? path.resolve(cliPath)
        : envPath
            ? path.resolve(envPath)
            : null
    if (!filePath) {
        console.error('Usage: node scripts/import-doors-to-airtable.js <path-to-ifc>')
        console.error('       or set ARCH_IFC_PATH in .env')
        process.exit(1)
    }
    if (!fs.existsSync(filePath)) {
        console.error(`IFC not found: ${filePath}`)
        process.exit(1)
    }

    console.log(`Parsing ${filePath}`)
    const ifcGuids = await extractDoorGuidsFromIfc(filePath)
    console.log(`Found ${ifcGuids.length} IfcDoor(s)`)

    console.log('Fetching existing Airtable rows...')
    const existing = await fetchAllExistingGuids()
    console.log(`${existing.size} row(s) already present`)

    const newGuids = ifcGuids.filter((g) => !existing.has(g))
    if (newGuids.length === 0) {
        console.log('Nothing new to seed.')
        return
    }
    console.log(`Creating ${newGuids.length} row(s) (Valid=no)`)
    const created = await createRecordsBatched(newGuids)
    console.log(`Done. Created ${created} row(s).`)
}

main().catch((err) => {
    console.error(err.message || err)
    process.exit(1)
})
