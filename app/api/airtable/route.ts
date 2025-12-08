import { NextRequest, NextResponse } from 'next/server'

// Hardcoded Airtable configuration - update after running setup script
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || '' // Set after running setup
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || 'Doors'

const AIRTABLE_API_BASE = 'https://api.airtable.com/v0'

interface DoorData {
    doorId: string
    doorType?: string
    openingDirection?: string
    modelSource?: string
    frontView?: string // base64 or URL
    backView?: string
    topView?: string
}

async function findOrCreateDoorRecord(doorId: string): Promise<{ recordId: string; exists: boolean }> {
    // Search for existing record
    const searchUrl = `${AIRTABLE_API_BASE}/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}?filterByFormula={Door ID}="${doorId}"`

    const searchResponse = await fetch(searchUrl, {
        headers: {
            'Authorization': `Bearer ${AIRTABLE_TOKEN}`,
        },
    })

    if (!searchResponse.ok) {
        const error = await searchResponse.text()
        throw new Error(`Failed to search Airtable: ${error}`)
    }

    const searchData = await searchResponse.json()

    if (searchData.records && searchData.records.length > 0) {
        return { recordId: searchData.records[0].id, exists: true }
    }

    // Create new record if not found
    const createResponse = await fetch(`${AIRTABLE_API_BASE}/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${AIRTABLE_TOKEN}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            fields: {
                'Door ID': doorId,
                'Created At': new Date().toISOString(),
            },
        }),
    })

    if (!createResponse.ok) {
        const error = await createResponse.text()
        throw new Error(`Failed to create Airtable record: ${error}`)
    }

    const createData = await createResponse.json()
    return { recordId: createData.id, exists: false }
}

import { put } from '@vercel/blob'

// Helper to upload base64 images to Vercel Blob
async function uploadToBlob(dataUrl: string | undefined, doorId: string, viewType: string): Promise<string | undefined> {
    if (!dataUrl || !dataUrl.startsWith('data:')) return dataUrl

    if (!process.env.BLOB_READ_WRITE_TOKEN) {
        console.warn('BLOB_READ_WRITE_TOKEN not configured, skipping image upload')
        return undefined
    }

    try {
        // Parse base64
        const matches = dataUrl.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/)
        if (!matches || matches.length !== 3) return undefined

        const contentType = matches[1]
        const buffer = Buffer.from(matches[2], 'base64')
        const extension = contentType.split('/')[1] || 'bin'
        const filename = `doors/${doorId}/${viewType}-${Date.now()}.${extension}`

        const blob = await put(filename, buffer, {
            access: 'public',
            contentType,
        })

        return blob.url
    } catch (error) {
        console.error(`Failed to upload ${viewType} for ${doorId}:`, error)
        return undefined
    }
}

async function updateDoorRecord(recordId: string, data: DoorData): Promise<void> {
    const fields: Record<string, unknown> = {}

    if (data.doorType) fields['Door Type'] = data.doorType
    if (data.openingDirection) fields['Opening Direction'] = data.openingDirection
    if (data.modelSource) fields['Model Source'] = data.modelSource

    // Upload images if present
    const frontUrl = await uploadToBlob(data.frontView, data.doorId, 'front')
    const backUrl = await uploadToBlob(data.backView, data.doorId, 'back')
    const topUrl = await uploadToBlob(data.topView, data.doorId, 'top')

    if (frontUrl) fields['Front View'] = [{ url: frontUrl }]
    if (backUrl) fields['Back View'] = [{ url: backUrl }]
    if (topUrl) fields['Top View'] = [{ url: topUrl }]

    const updateResponse = await fetch(`${AIRTABLE_API_BASE}/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}/${recordId}`, {
        method: 'PATCH',
        headers: {
            'Authorization': `Bearer ${AIRTABLE_TOKEN}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fields }),
    })

    if (!updateResponse.ok) {
        const error = await updateResponse.text()
        throw new Error(`Failed to update Airtable record: ${error}`)
    }
}

export async function POST(request: NextRequest) {
    try {
        // Check configuration
        if (!AIRTABLE_TOKEN) {
            return NextResponse.json(
                { error: 'AIRTABLE_TOKEN not configured' },
                { status: 500 }
            )
        }

        if (!AIRTABLE_BASE_ID) {
            return NextResponse.json(
                { error: 'AIRTABLE_BASE_ID not configured. Run the setup script first.' },
                { status: 500 }
            )
        }

        const body = await request.json() as DoorData

        if (!body.doorId) {
            return NextResponse.json(
                { error: 'doorId is required' },
                { status: 400 }
            )
        }

        // Find or create the door record
        const { recordId, exists } = await findOrCreateDoorRecord(body.doorId)

        // Update the record with the door data
        await updateDoorRecord(recordId, body)

        return NextResponse.json({
            success: true,
            recordId,
            created: !exists,
            message: exists
                ? `Updated existing door record: ${body.doorId}`
                : `Created new door record: ${body.doorId}`,
        })

    } catch (error) {
        console.error('Airtable API error:', error)
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Failed to send to Airtable' },
            { status: 500 }
        )
    }
}

// GET endpoint to check configuration
export async function GET() {
    const configured = !!(AIRTABLE_TOKEN && AIRTABLE_BASE_ID)

    return NextResponse.json({
        configured,
        hasToken: !!AIRTABLE_TOKEN,
        hasBaseId: !!AIRTABLE_BASE_ID,
        tableName: AIRTABLE_TABLE_NAME,
    })
}
