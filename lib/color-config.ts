/**
 * Centralised colour palette for all door renders.
 *
 * Source of truth: `config/render-colors.json`. Hex values live once in the
 * `palette` object and every role references a name. Swap a hex there and the
 * whole drawing shifts. If the JSON is missing or malformed we fall back to
 * the hardcoded defaults embedded below so renders never break.
 *
 * The JSON is imported as a module (bundled by webpack for the browser, read
 * by Node for scripts) — no `node:fs` at runtime, so this module stays
 * bundleable from `components/IFCViewer.tsx` without pulling server-only
 * schemes into the browser build.
 *
 * `DoorBKPCategory` ships with this module because it's what `elevation.door.byBKP`
 * keys on — kept here so the classifier and the palette stay in one place.
 *
 * `WallBKPCategory` is the wall analog (CFC 2711 gypsum/drywall vs. default
 * concrete-ish). Classifier lives alongside the door one.
 */
import renderColorsJson from '../config/render-colors.json'

export type DoorBKPCategory = 'metal' | 'wood' | 'context'
export type WallBKPCategory = 'drywall'

interface RenderColorsConfig {
    palette: Record<string, string>
    plan: {
        wallCut: string
        wallCutByBKP?: Partial<Record<WallBKPCategory, string>>
        ceilingCut: string
        suspendedCeilingCut: string
        windowContext: string
        doorContext: string
        currentDoor: string
        electrical: string
        safety: string
    }
    elevation: {
        wall: string
        wallByBKP?: Partial<Record<WallBKPCategory, string>>
        suspendedCeiling: string
        glass: string
        electrical: string
        safety: string
        door: {
            default: string
            byBKP: Record<DoorBKPCategory, string>
        }
    }
    safety?: {
        layerKeywords?: string[]
    }
    strokes: {
        outline: string
    }
}

/** Matches `config/render-colors.json` one-to-one. Kept in sync manually. */
const FALLBACK_CONFIG: RenderColorsConfig = {
    palette: {
        grau:       '#E0E0E0',
        hellgrau:   '#D9CBBA',
        gelb:       '#FAC846',
        pink:       '#FA467F',
        anthrazit:  '#B8B8B8',
        hellbraun:  '#D19D5A',
        hellblau:   '#B5E1F7',
        graubraun:  '#D9CBBA',
    },
    plan: {
        wallCut:             'grau',
        wallCutByBKP: {
            drywall: 'graubraun',
        },
        ceilingCut:          'grau',
        suspendedCeilingCut: 'grau',
        windowContext:       'anthrazit',
        doorContext:         'anthrazit',
        currentDoor:         'anthrazit',
        electrical:          'gelb',
        safety:              'pink',
    },
    elevation: {
        wall:             'grau',
        wallByBKP: {
            drywall: 'graubraun',
        },
        suspendedCeiling: 'grau',
        glass:            'hellblau',
        electrical:       'gelb',
        safety:           'pink',
        door: {
            default: 'hellgrau',
            byBKP: {
                metal:   'anthrazit',
                wood:    'hellbraun',
                context: 'hellgrau',
            },
        },
    },
    safety: {
        layerKeywords: ['e_sicherheit', 'sicherheit'],
    },
    strokes: {
        outline: '#000000',
    },
}

function resolvePaletteName(config: RenderColorsConfig, name: string): string {
    const hex = config.palette[name]
    if (typeof hex === 'string' && /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(hex)) {
        return hex
    }
    // If a role already stores a hex literal (e.g. strokes.outline), accept it.
    if (/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(name)) {
        return name
    }
    console.warn(`[color-config] palette name "${name}" missing or invalid; falling back to #cccccc`)
    return '#cccccc'
}

export interface RenderColors {
    plan: {
        wallCut:             string
        wallCutByBKP:        Record<WallBKPCategory, string>
        ceilingCut:          string
        suspendedCeilingCut: string
        windowContext:       string
        doorContext:         string
        currentDoor:         string
        electrical:          string
        safety:              string
    }
    elevation: {
        wall:             string
        wallByBKP:        Record<WallBKPCategory, string>
        suspendedCeiling: string
        glass:            string
        electrical:       string
        safety:           string
        door: {
            default: string
            byBKP: Record<DoorBKPCategory, string>
        }
    }
    safety: {
        layerKeywords: readonly string[]
    }
    strokes: {
        outline: string
    }
}

function resolveColors(config: RenderColorsConfig): RenderColors {
    const P = (name: string) => resolvePaletteName(config, name)
    const resolveWallBKP = (
        map: Partial<Record<WallBKPCategory, string>> | undefined,
        fallback: string,
    ): Record<WallBKPCategory, string> => ({
        drywall: map?.drywall ? P(map.drywall) : P(fallback),
    })
    const layerKeywords = (config.safety?.layerKeywords ?? FALLBACK_CONFIG.safety!.layerKeywords!)
        .map((k) => k.toLowerCase())
        .filter((k) => k.length > 0)
    return {
        plan: {
            wallCut:             P(config.plan.wallCut),
            wallCutByBKP:        resolveWallBKP(config.plan.wallCutByBKP, config.plan.wallCut),
            ceilingCut:          P(config.plan.ceilingCut),
            suspendedCeilingCut: P(config.plan.suspendedCeilingCut),
            windowContext:       P(config.plan.windowContext),
            doorContext:         P(config.plan.doorContext),
            currentDoor:         P(config.plan.currentDoor),
            electrical:          P(config.plan.electrical),
            safety:              P(config.plan.safety),
        },
        elevation: {
            wall:             P(config.elevation.wall),
            wallByBKP:        resolveWallBKP(config.elevation.wallByBKP, config.elevation.wall),
            suspendedCeiling: P(config.elevation.suspendedCeiling),
            glass:            P(config.elevation.glass),
            electrical:       P(config.elevation.electrical),
            safety:           P(config.elevation.safety),
            door: {
                default: P(config.elevation.door.default),
                byBKP: {
                    metal:   P(config.elevation.door.byBKP.metal),
                    wood:    P(config.elevation.door.byBKP.wood),
                    context: P(config.elevation.door.byBKP.context),
                },
            },
        },
        safety: {
            layerKeywords,
        },
        strokes: {
            outline: P(config.strokes.outline),
        },
    }
}

let cachedColors: RenderColors | null = null

export function loadRenderColors(): RenderColors {
    if (cachedColors) return cachedColors
    let config: RenderColorsConfig = FALLBACK_CONFIG
    try {
        // The JSON is bundled at build time — no fs read at runtime.
        config = renderColorsJson as RenderColorsConfig
    } catch (err) {
        console.warn('[color-config] failed to parse bundled render-colors.json; using built-in defaults:', err)
    }
    cachedColors = resolveColors(config)
    return cachedColors
}

/** Test-only hook to reset the cache. Prod code never calls this. */
export function __resetRenderColorsCache(): void {
    cachedColors = null
}

/**
 * Map the free-text `'CFC / BKP / CCC / BCC'` property from
 * `Cset_StandardCH` to one of the known door categories.
 *
 * Confirmed CFC codes in the Flu21 model:
 *   CFC 2216  Portes extérieurs metal / Aussentüren, Tore aus Metall  → metal
 *   CFC 2720  Portes intérieurs en métal / Innentüren aus Metall      → metal
 *   CFC 2730  Portes intérieurs en bois / Innentüren aus Holz         → wood
 *
 * Unknown / missing values return null, which the renderer treats as
 * `elevation.door.default`.
 */
export function classifyDoorBKP(cfcBkpCccBcc: string | null | undefined): DoorBKPCategory | null {
    if (!cfcBkpCccBcc) return null
    const code = cfcBkpCccBcc.toUpperCase()
    if (/\bCFC\s*2(216|720)\b/.test(code) || code.includes('METAL') || code.includes('MÉTAL')) return 'metal'
    if (/\bCFC\s*2730\b/.test(code) || code.includes('BOIS') || code.includes('HOLZ')) return 'wood'
    return null
}

/**
 * Map the same `'CFC / BKP / CCC / BCC'` string to wall categories.
 *
 * Confirmed CFC codes for walls in the Flu21 model:
 *   CFC 2711  Construction à sec en plâtre / Trockenbau Gipserarbeiten  → drywall
 *
 * Unknown / missing values return null, which the renderer treats as the
 * default `wall` / `plan.wallCut` colour.
 */
export function classifyWallBKP(cfcBkpCccBcc: string | null | undefined): WallBKPCategory | null {
    if (!cfcBkpCccBcc) return null
    const code = cfcBkpCccBcc.toUpperCase()
    if (/\bCFC\s*2711\b/.test(code)
        || code.includes('TROCKENBAU')
        || code.includes('GIPSER')
        || code.includes('GIPSPLATTE')
        || code.includes('PLÂTRE')
        || code.includes('PLATRE')) return 'drywall'
    return null
}

/** Pick the elevation door-leaf colour from the door's BKP classification. */
export function resolveElevationDoorColor(
    cfcBkpCccBcc: string | null | undefined,
    colors: RenderColors = loadRenderColors()
): string {
    const category = classifyDoorBKP(cfcBkpCccBcc)
    return category ? colors.elevation.door.byBKP[category] : colors.elevation.door.default
}

/** Pick the plan-view wall-cut colour from a wall's BKP classification. */
export function resolveWallCutColor(
    cfcBkpCccBcc: string | null | undefined,
    colors: RenderColors = loadRenderColors()
): string {
    const category = classifyWallBKP(cfcBkpCccBcc)
    return category ? colors.plan.wallCutByBKP[category] : colors.plan.wallCut
}

/** Pick the elevation wall-face colour from a wall's BKP classification. */
export function resolveWallElevationColor(
    cfcBkpCccBcc: string | null | undefined,
    colors: RenderColors = loadRenderColors()
): string {
    const category = classifyWallBKP(cfcBkpCccBcc)
    return category ? colors.elevation.wallByBKP[category] : colors.elevation.wall
}

/**
 * Classify an electrical-model element as safety-relevant by its `Name`.
 *
 * The ELEC IFC flattens everything into IfcElectricAppliance / IfcLamp
 * regardless of semantic role, so the discriminator lives in the name
 * field. Keywords below cover fire, alarm, emergency-light, and water
 * detection devices actually present in the Flu21 model.
 *
 * Bewegungsmelder (motion detector) is intentionally classified as
 * electrical — in Swiss commercial buildings it's more often part of the
 * lighting-automation system than the alarm panel.
 */
const SAFETY_NAME_KEYWORDS: readonly string[] = [
    'rauchmelder',
    'brandmelde',
    'handfeuermelder',
    'feuermelder',
    'wärmemelder', 'waermemelder', 'wärmemelder',
    'wassermelder',
    'alarm',
    'sirene',
    'blitzleuchte',
    'notleuchte',
    'notbeleuchtung',
    'fluchtweg',
]

export function isSafetyDeviceName(name: string | null | undefined): boolean {
    if (!name) return false
    const lower = name.toLowerCase()
    return SAFETY_NAME_KEYWORDS.some((kw) => lower.includes(kw))
}

/**
 * Layer-based safety classification. The Flu21 spec says safety-relevant
 * devices live on layer `E_Sicherheit` (system/layer name may vary). We
 * lowercase-match against `colors.safety.layerKeywords`, so either the
 * presentation-layer name or the IfcSystem name is enough to trigger.
 */
export function isSafetyDeviceByLayer(
    layers: readonly string[] | null | undefined,
    colors: RenderColors = loadRenderColors()
): boolean {
    if (!layers || layers.length === 0) return false
    const keywords = colors.safety.layerKeywords
    if (keywords.length === 0) return false
    for (const layer of layers) {
        if (!layer) continue
        const lower = layer.toLowerCase()
        if (keywords.some((kw) => lower.includes(kw))) return true
    }
    return false
}

/**
 * Combined safety classifier: prefer layer assignment (reliable in models
 * that author it) and fall back to the name-keyword heuristic (Flu21 today).
 */
export function isSafetyDevice(
    name: string | null | undefined,
    layers: readonly string[] | null | undefined,
    colors: RenderColors = loadRenderColors()
): boolean {
    if (isSafetyDeviceByLayer(layers, colors)) return true
    return isSafetyDeviceName(name)
}
