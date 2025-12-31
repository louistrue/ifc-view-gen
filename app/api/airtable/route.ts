import { NextRequest, NextResponse } from 'next/server'
import { getIronSession } from 'iron-session'
import { cookies } from 'next/headers'
import { sessionOptions, SessionData } from '@/lib/session'

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

async function findOrCreateDoorRecord(
    doorId: string,
    token: string,
    baseId: string,
    tableName: string
): Promise<{ recordId: string; exists: boolean }> {
    // Search for existing record
    const searchUrl = `${AIRTABLE_API_BASE}/${baseId}/${encodeURIComponent(tableName)}?filterByFormula={Door ID}="${doorId}"`

    const searchResponse = await fetch(searchUrl, {
        headers: {
            'Authorization': `Bearer ${token}`,
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
    const createResponse = await fetch(`${AIRTABLE_API_BASE}/${baseId}/${encodeURIComponent(tableName)}`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
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

async function updateDoorRecord(
    recordId: string,
    data: DoorData,
    token: string,
    baseId: string,
    tableName: string
): Promise<void> {
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

    const updateResponse = await fetch(`${AIRTABLE_API_BASE}/${baseId}/${encodeURIComponent(tableName)}/${recordId}`, {
        method: 'PATCH',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fields }),
    })

    if (!updateResponse.ok) {
        const error = await updateResponse.text()
        throw new Error(`Failed to update Airtable record: ${error}`)
    }
}

interface AirtableRequestBody extends DoorData {
    baseId?: string
    tableName?: string
}

export async function POST(request: NextRequest) {
    try {
        // Get session data
        const session = await getIronSession<SessionData>(await cookies(), sessionOptions)

        if (!session.isAuthenticated || !session.airtableAccessToken) {
            return NextResponse.json(
                { error: 'Not authenticated. Please connect to Airtable first.' },
                { status: 401 }
            )
        }

        const body = await request.json() as AirtableRequestBody

        if (!body.doorId) {
            return NextResponse.json(
                { error: 'doorId is required' },
                { status: 400 }
            )
        }

        // Get baseId and tableName from request body or session (fallback to defaults)
        const baseId = body.baseId || session.airtableBaseId
        const tableName = body.tableName || session.airtableTableName || 'Doors'

        if (!baseId) {
            return NextResponse.json(
                { error: 'baseId is required. Please provide it in the request or save it in your session.' },
                { status: 400 }
            )
        }

        // Save baseId and tableName to session if provided in the request
        if (body.baseId && body.baseId !== session.airtableBaseId) {
            session.airtableBaseId = body.baseId
            await session.save()
        }
        if (body.tableName && body.tableName !== session.airtableTableName) {
            session.airtableTableName = body.tableName
            await session.save()
        }

        // Find or create the door record
        const { recordId, exists } = await findOrCreateDoorRecord(
            body.doorId,
            session.airtableAccessToken,
            baseId,
            tableName
        )

        // Update the record with the door data
        await updateDoorRecord(recordId, body, session.airtableAccessToken, baseId, tableName)

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

// GET endpoint to check authentication status
export async function GET() {
    const session = await getIronSession<SessionData>(await cookies(), sessionOptions)

    return NextResponse.json({
        isAuthenticated: session.isAuthenticated || false,
        hasBaseId: !!session.airtableBaseId,
        tableName: session.airtableTableName || 'Doors',
    })
}
