import { NextRequest, NextResponse } from 'next/server'
import { getIronSession } from 'iron-session'
import { cookies } from 'next/headers'
import { sessionOptions, SessionData } from '@/lib/session'
import { put } from '@vercel/blob'

const AIRTABLE_API_BASE = 'https://api.airtable.com/v0'
const MAX_RATE_LIMIT_RETRIES = 5
const FIELD_RESOLUTION_CACHE_TTL_MS = 5 * 60 * 1000

type ResolvedFields = {
  doorId: string
  alTuernummer?: string
  geometryType?: string
  massDurchgangsbreite?: string
  massDurchgangshoehe?: string
  massRohbreite?: string
  massRohhoehe?: string
  massAussenrahmenBreite?: string
  massAussenrahmenHoehe?: string
  brandschutzManuell?: string
  schallschutzManuell?: string
  openingDirection?: string
  modelSource?: string
  frontView?: string
  backView?: string
  topView?: string
}

type TableField = {
  name: string
  type: string
  options?: string[]
}

type FieldResolutionCacheEntry = {
  resolvedFields: ResolvedFields
  attachmentFieldNames: string[]
  tableFieldsByName: Record<string, TableField>
  expiresAt: number
}

const fieldResolutionCache = new Map<string, FieldResolutionCacheEntry>()

const FIELD_CANDIDATES = {
  doorId: ['AL00_GUID', 'Door ID'],
  alTuernummer: ['AL00_Türnummer', 'AL00_Tuernummer'],
  geometryType: ['Geometry type', 'Door Type'],
  massDurchgangsbreite: ['GE01_LichteBreiteLB', 'Mass - Durchgangsbreite'],
  massDurchgangshoehe: ['GE01_LichteHöheLH', 'GE01_LichteHoeheLH', 'Mass - Durchgangshöhe'],
  massRohbreite: ['GE01_RoheBreiteRB', 'GE01_RohBreiteRB', 'Mass - Rohbreite'],
  massRohhoehe: ['GE01_RoheHöheRH', 'GE01_RoheHoeheRH', 'Mass - Rohhöhe'],
  massAussenrahmenBreite: ['GE01_BreiteAussenrahmenBRAM', 'Mass - Aussenrahmen Breite'],
  massAussenrahmenHoehe: ['GE01_HöheAussenrahmenHRAM', 'Mass - Aussenrahmen Höhe'],
  brandschutzManuell: ['IN01_Brandschutz_manuell'],
  schallschutzManuell: ['IN01_Schallschutz_manuell'],
  openingDirection: ['Opening Direction'],
  modelSource: ['Model Source'],
  frontView: ['AR01_FrontAnsicht', 'Front View', 'Vorderansicht', 'Front', 'Bild Front'],
  backView: ['AR01_BackAnsicht', 'Back View', 'Ruckansicht', 'Rueckansicht', 'Back', 'Bild Back'],
  topView: ['AR01_FloorAnsicht', 'Top View', 'Draufsicht', 'Grundriss', 'Plan View', 'Plan', 'Bild Top'],
} as const

interface DoorData {
  doorId: string
  doorType?: string
  alTuernummer?: string
  geometryType?: string
  openingDirection?: string
  modelSource?: string
  massDurchgangsbreite?: number
  massDurchgangshoehe?: number
  massRohbreite?: number
  massRohhoehe?: number
  massAussenrahmenBreite?: number
  massAussenrahmenHoehe?: number
  feuerwiderstand?: string
  bauschalldaemmmass?: string
  frontView?: string
  backView?: string
  topView?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getBackoffMs(attempt: number): number {
  const base = 700 * (2 ** attempt)
  const jitter = Math.floor(Math.random() * 300)
  return Math.min(base + jitter, 10_000)
}

async function airtableFetchWithRetry(input: string, init: RequestInit, operation: string): Promise<Response> {
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    const response = await fetch(input, init)
    if (response.ok) return response

    const bodyText = await response.clone().text().catch(() => '')
    const isRateLimited = response.status === 429 || bodyText.includes('RATE_LIMIT_REACHED')

    if (!isRateLimited || attempt === MAX_RATE_LIMIT_RETRIES) {
      return response
    }

    const waitMs = getBackoffMs(attempt)
    console.warn(`[Airtable] ${operation} rate-limited. Retry ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES} in ${waitMs}ms`)
    await sleep(waitMs)
  }

  throw new Error('Unexpected retry flow')
}

function pickField(available: Set<string>, candidates: readonly string[]): string | undefined {
  return candidates.find((name) => available.has(name))
}

function normalizeFieldName(value: string): string {
  return value
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]/g, '')
}

function sanitizeChoiceValue(value: string | undefined | null): string | undefined {
  if (!value) return undefined
  const cleaned = value.trim().replace(/^\"+|\"+$/g, '').replace(/^'+|'+$/g, '')
  return cleaned.length > 0 ? cleaned : undefined
}

function extractNumericToken(value: string): string | undefined {
  const m = value.match(/\d+(?:[.,]\d+)?/)
  return m ? m[0].replace(',', '.') : undefined
}

function sanitizeSchallschutzValue(value: string | undefined | null): string | undefined {
  const cleaned = sanitizeChoiceValue(value)
  if (!cleaned) return undefined
  const numeric = extractNumericToken(cleaned)
  return numeric ?? cleaned
}

function normalizeChoiceCompare(value: string): string {
  return sanitizeChoiceValue(value)?.toLowerCase().replace(/\s+/g, '') ?? ''
}

function isNumericFieldType(type: string): boolean {
  return type === 'number' || type === 'currency' || type === 'percent' || type === 'duration' || type === 'rating'
}

function pickAirtableSelectValue(rawValue: string | undefined, field?: TableField): string | undefined {
  const cleaned = sanitizeChoiceValue(rawValue)
  if (!cleaned) return undefined
  if (!field) return cleaned

  const isSelect = field.type === 'singleSelect' || field.type === 'multipleSelects'
  const options = field.options ?? []
  if (!isSelect || options.length === 0) return cleaned

  const normalizedInput = normalizeChoiceCompare(cleaned)
  const exact = options.find((opt) => normalizeChoiceCompare(opt) === normalizedInput)
  if (exact) return exact

  const inputNum = extractNumericToken(cleaned)
  if (inputNum) {
    const byNumber = options.find((opt) => extractNumericToken(opt) === inputNum)
    if (byNumber) return byNumber
  }

  const contains = options.find((opt) => {
    const optN = normalizeChoiceCompare(opt)
    return optN.includes(normalizedInput) || normalizedInput.includes(optN)
  })
  if (contains) return contains

  return undefined
}

function findAttachmentByNormalizedExact(attachmentPool: string[], normalizedTarget: string): string | undefined {
  for (const fieldName of attachmentPool) {
    if (normalizeFieldName(fieldName) === normalizedTarget) return fieldName
  }
  return undefined
}

function findAttachmentByKeywords(attachmentPool: string[], keywords: string[]): string | undefined {
  for (const fieldName of attachmentPool) {
    const normalized = normalizeFieldName(fieldName)
    if (keywords.some((k) => normalized.includes(k))) return fieldName
  }
  return undefined
}

function resolveAttachmentField(preferred: string | undefined, attachmentPool: string[], used: Set<string>): string | undefined {
  if (preferred && !used.has(preferred)) {
    used.add(preferred)
    return preferred
  }
  for (const candidate of attachmentPool) {
    if (!used.has(candidate)) {
      used.add(candidate)
      return candidate
    }
  }
  return undefined
}

function getFieldResolutionCacheKey(baseId: string, tableName: string): string {
  return `${baseId}::${tableName}`
}

async function getAvailableTableFields(token: string, baseId: string, tableName: string): Promise<TableField[]> {
  const res = await airtableFetchWithRetry(
    `${AIRTABLE_API_BASE}/meta/bases/${baseId}/tables`,
    { headers: { Authorization: `Bearer ${token}` } },
    'fetch table schema'
  )

  if (!res.ok) {
    const error = await res.text()
    throw new Error(`Failed to read Airtable table schema: ${error}`)
  }

  const data = await res.json()
  const tables = Array.isArray(data.tables)
    ? (data.tables as Array<{ name?: string; fields?: Array<{ name?: string; type?: string; options?: { choices?: Array<{ name?: string }> } }> }> )
    : []
  const table = tables.find((t) => t.name === tableName)
  if (!table) throw new Error(`Connected table "${tableName}" not found in base.`)

  const result: TableField[] = []
  const fields = Array.isArray(table.fields) ? table.fields : []
  for (const field of fields) {
    if (typeof field?.name === 'string' && field.name.length > 0) {
      const choices = Array.isArray(field.options?.choices)
        ? field.options?.choices
            ?.map((c) => (typeof c?.name === 'string' ? c.name : ''))
            .filter((v): v is string => v.length > 0)
        : undefined
      result.push({
        name: field.name,
        type: typeof field.type === 'string' ? field.type : '',
        options: choices,
      })
    }
  }
  return result
}

/** Sanitize a string for use in blob path segments to prevent path traversal */
function sanitizeBlobPathSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, '_')
  return sanitized.slice(0, 255) || 'unknown'
}

async function uploadToBlob(dataUrl: string | undefined, doorId: string, viewType: string): Promise<string | undefined> {
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
    const safeDoorId = sanitizeBlobPathSegment(doorId)
    const filename = `doors/${safeDoorId}/${viewType}-${Date.now()}.${extension}`

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
  tableName: string,
  doorIdField: string
): Promise<{ recordId: string; exists: boolean }> {
  const tableUrl = `${AIRTABLE_API_BASE}/${baseId}/${encodeURIComponent(tableName)}`
  // Escape for Airtable formula string: backslash first, then double-quote
  const safeDoorId = doorId.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, ' ')

  const searchUrl = `${tableUrl}?filterByFormula={${doorIdField}}="${safeDoorId}"`
  const searchRes = await airtableFetchWithRetry(searchUrl, { headers: { Authorization: `Bearer ${token}` } }, 'find record')

  if (!searchRes.ok) {
    const error = await searchRes.text()
    throw new Error(`Failed to search Airtable: ${error}`)
  }

  const searchData = await searchRes.json()
  if (searchData.records?.length > 0) {
    return { recordId: searchData.records[0].id, exists: true }
  }

  const createRes = await airtableFetchWithRetry(
    tableUrl,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields: { [doorIdField]: doorId } }),
    },
    'create record'
  )

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
  tableName: string,
  fieldsMap: ResolvedFields,
  tableFieldsByName: Record<string, TableField>
): Promise<void> {
  const fields: Record<string, unknown> = {}
  const normalizedGeometryType = sanitizeChoiceValue(data.geometryType)
  const normalizedDoorType = sanitizeChoiceValue(data.doorType)
  const normalizedBrandschutz = sanitizeChoiceValue(data.feuerwiderstand)
  const normalizedSchallschutz = sanitizeSchallschutzValue(data.bauschalldaemmmass)

  const normalizedTuernummer = sanitizeChoiceValue(data.alTuernummer) || sanitizeChoiceValue(data.doorType)
  if (normalizedTuernummer && fieldsMap.alTuernummer) fields[fieldsMap.alTuernummer] = normalizedTuernummer
  if (normalizedGeometryType && fieldsMap.geometryType) fields[fieldsMap.geometryType] = normalizedGeometryType
  else if (normalizedDoorType && fieldsMap.geometryType) fields[fieldsMap.geometryType] = normalizedDoorType

  if (typeof data.massDurchgangsbreite === 'number' && fieldsMap.massDurchgangsbreite) fields[fieldsMap.massDurchgangsbreite] = data.massDurchgangsbreite
  if (typeof data.massDurchgangshoehe === 'number' && fieldsMap.massDurchgangshoehe) fields[fieldsMap.massDurchgangshoehe] = data.massDurchgangshoehe
  if (typeof data.massRohbreite === 'number' && fieldsMap.massRohbreite) fields[fieldsMap.massRohbreite] = data.massRohbreite
  if (typeof data.massRohhoehe === 'number' && fieldsMap.massRohhoehe) fields[fieldsMap.massRohhoehe] = data.massRohhoehe
  if (typeof data.massAussenrahmenBreite === 'number' && fieldsMap.massAussenrahmenBreite) fields[fieldsMap.massAussenrahmenBreite] = data.massAussenrahmenBreite
  if (typeof data.massAussenrahmenHoehe === 'number' && fieldsMap.massAussenrahmenHoehe) fields[fieldsMap.massAussenrahmenHoehe] = data.massAussenrahmenHoehe

  if (normalizedBrandschutz && fieldsMap.brandschutzManuell) {
    const brandschutzField = tableFieldsByName[fieldsMap.brandschutzManuell]
    const mapped = pickAirtableSelectValue(normalizedBrandschutz, brandschutzField)
    if (mapped) fields[fieldsMap.brandschutzManuell] = mapped
  }

  if (normalizedSchallschutz && fieldsMap.schallschutzManuell) {
    const schallschutzField = tableFieldsByName[fieldsMap.schallschutzManuell]
    if (schallschutzField && isNumericFieldType(schallschutzField.type)) {
      const parsed = Number(normalizedSchallschutz)
      if (Number.isFinite(parsed)) {
        fields[fieldsMap.schallschutzManuell] = parsed
      }
    } else {
      const mapped = pickAirtableSelectValue(normalizedSchallschutz, schallschutzField)
      if (mapped) {
        fields[fieldsMap.schallschutzManuell] = mapped
      } else if (schallschutzField?.type !== 'singleSelect' && schallschutzField?.type !== 'multipleSelects') {
        fields[fieldsMap.schallschutzManuell] = normalizedSchallschutz
      } else {
        console.warn('[Airtable] Schallschutz value not matched to select options', {
          doorId: data.doorId,
          input: normalizedSchallschutz,
          options: schallschutzField?.options,
        })
      }
    }
  }

  if (data.openingDirection && fieldsMap.openingDirection) fields[fieldsMap.openingDirection] = data.openingDirection
  if (data.modelSource && fieldsMap.modelSource) fields[fieldsMap.modelSource] = data.modelSource

  const [frontUrl, backUrl, topUrl] = await Promise.all([
    uploadToBlob(data.frontView, data.doorId, 'front'),
    uploadToBlob(data.backView, data.doorId, 'back'),
    uploadToBlob(data.topView, data.doorId, 'top'),
  ])

  if (frontUrl && fieldsMap.frontView) fields[fieldsMap.frontView] = [{ url: frontUrl }]
  if (backUrl && fieldsMap.backView) fields[fieldsMap.backView] = [{ url: backUrl }]
  if (topUrl && fieldsMap.topView) fields[fieldsMap.topView] = [{ url: topUrl }]

  if (Object.keys(fields).length === 0) return

  const updateUrl = `${AIRTABLE_API_BASE}/${baseId}/${encodeURIComponent(tableName)}/${recordId}`
  const updateRes = await airtableFetchWithRetry(
    updateUrl,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields }),
    },
    'update record'
  )

  if (!updateRes.ok) {
    const error = await updateRes.text()
    if (error.includes('INVALID_MULTIPLE_CHOICE_OPTIONS')) {
      const retryFields: Record<string, unknown> = { ...fields }
      const maybeRestrictedSelectFields = [
        fieldsMap.schallschutzManuell,
        fieldsMap.brandschutzManuell,
        fieldsMap.geometryType,
      ].filter((name): name is string => Boolean(name))

      let removed = 0
      for (const fieldName of maybeRestrictedSelectFields) {
        if (fieldName in retryFields) {
          delete retryFields[fieldName]
          removed++
        }
      }

      if (removed > 0 && Object.keys(retryFields).length > 0) {
        console.warn('[Airtable] Retrying update without restricted single-select values', {
          removedFields: maybeRestrictedSelectFields,
          doorId: data.doorId,
        })

        const retryRes = await airtableFetchWithRetry(
          updateUrl,
          {
            method: 'PATCH',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ fields: retryFields }),
          },
          'update record (without restricted select values)'
        )

        if (retryRes.ok) return
        const retryError = await retryRes.text()
        throw new Error(`Failed to update Airtable record after fallback: ${retryError}`)
      }
    }
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

    const body = (await request.json()) as DoorData
    if (!body.doorId) {
      return NextResponse.json({ error: 'doorId is required' }, { status: 400 })
    }

    const baseId = session.airtableBaseId
    const tableName = session.airtableTableName
    if (!baseId || !tableName) {
      return NextResponse.json(
        { error: 'No Airtable base/table found in session. Please reconnect via OAuth.' },
        { status: 400 }
      )
    }

    let resolvedFields: ResolvedFields
    let attachmentFieldNames: string[]
    let tableFieldsByName: Record<string, TableField>

    const cacheKey = getFieldResolutionCacheKey(baseId, tableName)
    const cached = fieldResolutionCache.get(cacheKey)

    if (cached && cached.expiresAt > Date.now()) {
      resolvedFields = cached.resolvedFields
      attachmentFieldNames = cached.attachmentFieldNames
      tableFieldsByName = cached.tableFieldsByName
    } else {
      const tableFields = await getAvailableTableFields(session.airtableAccessToken, baseId, tableName)
      tableFieldsByName = Object.fromEntries(tableFields.map((f) => [f.name, f]))
      const availableFields = new Set(tableFields.map((f) => f.name))
      attachmentFieldNames = tableFields.filter((f) => f.type === 'multipleAttachments').map((f) => f.name)
      const usedAttachmentFields = new Set<string>()

      const preferredFront = pickField(availableFields, FIELD_CANDIDATES.frontView)
      const preferredBack = pickField(availableFields, FIELD_CANDIDATES.backView)
      const preferredTop = pickField(availableFields, FIELD_CANDIDATES.topView)

      const forcedFront = findAttachmentByNormalizedExact(attachmentFieldNames, 'ar01frontansicht')
      const forcedBack = findAttachmentByNormalizedExact(attachmentFieldNames, 'ar01backansicht')
      const forcedTop = findAttachmentByNormalizedExact(attachmentFieldNames, 'ar01flooransicht')

      const heuristicFront = findAttachmentByKeywords(attachmentFieldNames, ['front', 'vorder', 'ansichta', 'ansicht'])
      const heuristicBack = findAttachmentByKeywords(attachmentFieldNames, ['back', 'ruck', 'rueck', 'hinten', 'ansichtb', 'ansicht'])
      const heuristicTop = findAttachmentByKeywords(attachmentFieldNames, ['floor', 'top', 'plan', 'grundriss', 'drauf', 'ansichtc'])

      resolvedFields = {
        doorId: pickField(availableFields, FIELD_CANDIDATES.doorId) || '',
        alTuernummer: pickField(availableFields, FIELD_CANDIDATES.alTuernummer),
        geometryType: pickField(availableFields, FIELD_CANDIDATES.geometryType),
        massDurchgangsbreite: pickField(availableFields, FIELD_CANDIDATES.massDurchgangsbreite),
        massDurchgangshoehe: pickField(availableFields, FIELD_CANDIDATES.massDurchgangshoehe),
        massRohbreite: pickField(availableFields, FIELD_CANDIDATES.massRohbreite),
        massRohhoehe: pickField(availableFields, FIELD_CANDIDATES.massRohhoehe),
        massAussenrahmenBreite: pickField(availableFields, FIELD_CANDIDATES.massAussenrahmenBreite),
        massAussenrahmenHoehe: pickField(availableFields, FIELD_CANDIDATES.massAussenrahmenHoehe),
        brandschutzManuell: pickField(availableFields, FIELD_CANDIDATES.brandschutzManuell),
        schallschutzManuell: pickField(availableFields, FIELD_CANDIDATES.schallschutzManuell),
        openingDirection: pickField(availableFields, FIELD_CANDIDATES.openingDirection),
        modelSource: pickField(availableFields, FIELD_CANDIDATES.modelSource),
        frontView: resolveAttachmentField(forcedFront || preferredFront || heuristicFront, attachmentFieldNames, usedAttachmentFields),
        backView: resolveAttachmentField(forcedBack || preferredBack || heuristicBack, attachmentFieldNames, usedAttachmentFields),
        topView: resolveAttachmentField(forcedTop || preferredTop || heuristicTop, attachmentFieldNames, usedAttachmentFields),
      }

      fieldResolutionCache.set(cacheKey, {
        resolvedFields,
        attachmentFieldNames,
        tableFieldsByName,
        expiresAt: Date.now() + FIELD_RESOLUTION_CACHE_TTL_MS,
      })
    }

    if (!resolvedFields.doorId) {
      return NextResponse.json(
        { error: 'Required Airtable key field not found. Expected one of: AL00_GUID, Door ID' },
        { status: 400 }
      )
    }

    console.log('[Airtable] Field resolution:', {
      tableName,
      doorId: resolvedFields.doorId,
      alTuernummer: resolvedFields.alTuernummer,
      brandschutz: resolvedFields.brandschutzManuell,
      schallschutz: resolvedFields.schallschutzManuell,
      geometryType: resolvedFields.geometryType,
      frontView: resolvedFields.frontView,
      backView: resolvedFields.backView,
      topView: resolvedFields.topView,
      attachmentFieldCount: attachmentFieldNames.length,
      attachmentFields: attachmentFieldNames,
    })

    const { recordId, exists } = await findOrCreateDoorRecord(
      body.doorId,
      session.airtableAccessToken,
      baseId,
      tableName,
      resolvedFields.doorId
    )

    await updateDoorRecord(
      recordId,
      body,
      session.airtableAccessToken,
      baseId,
      tableName,
      resolvedFields,
      tableFieldsByName
    )

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
      { error: 'Failed to send to Airtable' },
      { status: 500 }
    )
  }
}

export async function GET() {
  const session = await getIronSession<SessionData>(await cookies(), sessionOptions)

  return NextResponse.json({
    isAuthenticated: session.isAuthenticated || false,
    hasBaseId: !!session.airtableBaseId,
    baseId: session.airtableBaseId || null,
    baseName: session.airtableBaseName || null,
    tableName: session.airtableTableName || null,
  })
}