import { NextRequest, NextResponse } from 'next/server'
import { put } from '@vercel/blob'

// Airtable configuration from environment
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || ''
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || 'Spaces'

const AIRTABLE_API_BASE = 'https://api.airtable.com/v0'

/**
 * Space data for Airtable export
 */
interface SpaceData {
    spaceId: string
    spaceName?: string
    spaceType?: string
    spaceFunction?: string
    storeyName?: string

    // Quantities
    grossFloorArea?: number
    netFloorArea?: number
    grossVolume?: number
    height?: number
    perimeter?: number

    // Dimensions
    width?: number
    depth?: number

    // Counts
    doorCount?: number
    windowCount?: number

    // Model source
    modelSource?: string

    // SVG views (base64 data URLs)
    floorPlanView?: string
}

/**
 * Upload base64 data URL to Vercel Blob storage
 */
async function uploadToBlob(dataUrl: string | undefined, spaceId: string, viewType: string): Promise<string | undefined> {
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
        const filename = `spaces/${spaceId}/${viewType}-${Date.now()}.${extension}`

        const blob = await put(filename, buffer, {
            access: 'public',
            contentType,
        })

        return blob.url
    } catch (error) {
        console.error(`Failed to upload ${viewType} for ${spaceId}:`, error)
        return undefined
    }
}

/**
 * Find or create a space record in Airtable
 */
async function findOrCreateSpaceRecord(spaceId: string): Promise<{ recordId: string; exists: boolean }> {
    // Search for existing record
    const searchUrl = `${AIRTABLE_API_BASE}/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}?filterByFormula={Space ID}="${spaceId}"`

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
                'Space ID': spaceId,
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

/**
 * Update a space record in Airtable
 */
async function updateSpaceRecord(recordId: string, data: SpaceData): Promise<void> {
    const fields: Record<string, unknown> = {}

    // Map data fields to Airtable fields
    if (data.spaceName) fields['Space Name'] = data.spaceName
    if (data.spaceType) fields['Space Type'] = data.spaceType
    if (data.spaceFunction) fields['Space Function'] = data.spaceFunction
    if (data.storeyName) fields['Storey'] = data.storeyName
    if (data.modelSource) fields['Model Source'] = data.modelSource

    // Numeric fields
    if (data.grossFloorArea !== undefined) fields['Gross Floor Area (m²)'] = data.grossFloorArea
    if (data.netFloorArea !== undefined) fields['Net Floor Area (m²)'] = data.netFloorArea
    if (data.grossVolume !== undefined) fields['Gross Volume (m³)'] = data.grossVolume
    if (data.height !== undefined) fields['Height (m)'] = data.height
    if (data.perimeter !== undefined) fields['Perimeter (m)'] = data.perimeter
    if (data.width !== undefined) fields['Width (m)'] = data.width
    if (data.depth !== undefined) fields['Depth (m)'] = data.depth
    if (data.doorCount !== undefined) fields['Door Count'] = data.doorCount
    if (data.windowCount !== undefined) fields['Window Count'] = data.windowCount

    // Upload images if present
    const floorPlanUrl = await uploadToBlob(data.floorPlanView, data.spaceId, 'floor-plan')

    if (floorPlanUrl) fields['Floor Plan View'] = [{ url: floorPlanUrl }]

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

        const body = await request.json() as SpaceData

        if (!body.spaceId) {
            return NextResponse.json(
                { error: 'spaceId is required' },
                { status: 400 }
            )
        }

        // Find or create the space record
        const { recordId, exists } = await findOrCreateSpaceRecord(body.spaceId)

        // Update the record with the space data
        await updateSpaceRecord(recordId, body)

        return NextResponse.json({
            success: true,
            recordId,
            created: !exists,
            message: exists
                ? `Updated existing space record: ${body.spaceId}`
                : `Created new space record: ${body.spaceId}`,
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
