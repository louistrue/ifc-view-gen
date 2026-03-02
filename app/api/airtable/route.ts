import { NextRequest, NextResponse } from 'next/server'
import { getIronSession } from 'iron-session'
import { cookies } from 'next/headers'
import { sessionOptions, SessionData } from '@/lib/session'
import { put } from '@vercel/blob'

const AIRTABLE_API_BASE = 'https://api.airtable.com/v0'

// ─── Hardcoded Airtable field names ────────────────────────────────────────
// Your Airtable table must contain columns with exactly these names.
const FIELDS = {
  doorId:           'Door ID',
  frontView:        'Front View',
  backView:         'Back View',
  topView:          'Top View',
  doorType:         'Door Type',
  openingDirection: 'Opening Direction',
  modelSource:      'Model Source',
} as const
// ───────────────────────────────────────────────────────────────────────────

interface DoorData {
    doorId: string
    doorType?: string
    openingDirection?: string
    modelSource?: string
    frontView?: string  // base64 or URL
    backView?: string
    topView?: string
}

// Helper to upload base64 images to Vercel Blob
async function uploadToBlob(
    dataUrl: string | undefined,
    doorId: string,
    viewType: string
): Promise<string | undefined> {
    if (!dataUrl || !dataUrl.startsWith('data:')) return dataUrl

    if (!process.env.BLOB_READ_WRITE_TOKEN) {
        console.warn('BLOB_READ_WRITE_TOKEN not configured, skipping image upload')
        return undefined
    }

    try {
        const matches = dataUrl.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/)
        if (!matches || matches.length !== 3) return undefined

        const contentType = matches[1]
        const buffer = Buffer.from(matches[2], 'base64')
        const extension = contentType.split('/')[1] || 'bin'
        const filename = `doors/${doorId}/${viewType}-${Date.now()}.${extension}`

        const blob = await put(filename, buffer, { access: 'public', contentType })
        return blob.url
    } catch (error) {
        console.error(`Failed to upload ${viewType} for ${doorId}:`, error)
        return undefined
    }
}

async function findOrCreateDoorRecord(
    doorId: string,
    token: string,
    baseId: string,
    tableName: string
): Promise<{ recordId: string; exists: boolean }> {
    const tableUrl = `${AIRTABLE_API_BASE}/${baseId}/${encodeURIComponent(tableName)}`

    // Search for existing record by Door ID
    const searchUrl = `${tableUrl}?filterByFormula={${FIELDS.doorId}}="${doorId}"`
    const searchRes = await fetch(searchUrl, {
        headers: { Authorization: `Bearer ${token}` },
    })

    if (!searchRes.ok) {
        const error = await searchRes.text()
        throw new Error(`Failed to search Airtable: ${error}`)
    }

    const searchData = await searchRes.json()
    if (searchData.records?.length > 0) {
        return { recordId: searchData.records[0].id, exists: true }
    }

    // Create new record
    const createRes = await fetch(tableUrl, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            fields: { [FIELDS.doorId]: doorId },
        }),
    })

    if (!createRes.ok) {
        const error = await createRes.text()
        throw new Error(`Failed to create Airtable record: ${error}`)
    }

    const createData = await createRes.json()
    return { recordId: createData.id, exists: false }
}

async function updateDoorRecord(
    recordId: string,
    data: DoorData,
    token: string,
    baseId: string,
    tableName: string
): Promise<void> {
    const fields: Record<string, unknown> = {}

    if (data.doorType)         fields[FIELDS.doorType]         = data.doorType
    if (data.openingDirection) fields[FIELDS.openingDirection] = data.openingDirection
    if (data.modelSource)      fields[FIELDS.modelSource]      = data.modelSource

    const frontUrl = await uploadToBlob(data.frontView, data.doorId, 'front')
    const backUrl  = await uploadToBlob(data.backView,  data.doorId, 'back')
    const topUrl   = await uploadToBlob(data.topView,   data.doorId, 'top')

    if (frontUrl) fields[FIELDS.frontView] = [{ url: frontUrl }]
    if (backUrl)  fields[FIELDS.backView]  = [{ url: backUrl }]
    if (topUrl)   fields[FIELDS.topView]   = [{ url: topUrl }]

    const updateRes = await fetch(
        `${AIRTABLE_API_BASE}/${baseId}/${encodeURIComponent(tableName)}/${recordId}`,
        {
            method: 'PATCH',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ fields }),
        }
    )

    if (!updateRes.ok) {
        const error = await updateRes.text()
        throw new Error(`Failed to update Airtable record: ${error}`)
    }
}

export async function POST(request: NextRequest) {
    try {
        const session = await getIronSession<SessionData>(await cookies(), sessionOptions)

        if (!session.isAuthenticated || !session.airtableAccessToken) {
            return NextResponse.json(
                { error: 'Not authenticated. Please connect to Airtable first.' },
                { status: 401 }
            )
        }

        const body = await request.json() as DoorData

        if (!body.doorId) {
            return NextResponse.json({ error: 'doorId is required' }, { status: 400 })
        }

        const baseId    = session.airtableBaseId
        const tableName = session.airtableTableName

        if (!baseId || !tableName) {
            return NextResponse.json(
                { error: 'No Airtable base/table found in session. Please reconnect via OAuth.' },
                { status: 400 }
            )
        }

        const { recordId, exists } = await findOrCreateDoorRecord(
            body.doorId, session.airtableAccessToken, baseId, tableName
        )
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

export async function GET() {
    const session = await getIronSession<SessionData>(await cookies(), sessionOptions)

    return NextResponse.json({
        isAuthenticated: session.isAuthenticated || false,
        hasBaseId:  !!session.airtableBaseId,
        baseId:     session.airtableBaseId  || null,
        baseName:   session.airtableBaseName || null,
        tableName:  session.airtableTableName || null,
    })
}
