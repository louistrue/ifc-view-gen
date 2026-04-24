/**
 * Centralised colour palette for all door renders.
 *
 * Source of truth: `config/render-colors.json`. Hex values live once in the
 * `palette` object and every role references a name. Swap a hex there and the
 * whole drawing shifts. If the JSON is missing or malformed we fall back to
 * the hardcoded defaults embedded below so renders never break.
 *
 * `DoorBKPCategory` ships with this module because it's what `elevation.door.byBKP`
 * keys on — kept here so the classifier and the palette stay in one place.
 */
import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'

export type DoorBKPCategory = 'metal' | 'wood' | 'context'

interface RenderColorsConfig {
    palette: Record<string, string>
    plan: {
        wallCut: string
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
        suspendedCeiling: string
        glass: string
        electrical: string
        safety: string
        door: {
            default: string
            byBKP: Record<DoorBKPCategory, string>
        }
    }
    strokes: {
        outline: string
    }
}

/** Matches `config/render-colors.json` one-to-one. Kept in sync manually. */
const FALLBACK_CONFIG: RenderColorsConfig = {
    palette: {
        grau:       '#9E9E9E',
        hellgrau:   '#E3E3E3',
        gelb:       '#F4B400',
        pink:       '#E91E63',
        anthrazit:  '#3A3A3A',
        hellbraun:  '#C19A6B',
        hellblau:   '#D3E4F5',
    },
    plan: {
        wallCut:             'grau',
        ceilingCut:          'grau',
        suspendedCeilingCut: 'grau',
        windowContext:       'hellgrau',
        doorContext:         'hellgrau',
        currentDoor:         'hellgrau',
        electrical:          'gelb',
        safety:              'pink',
    },
    elevation: {
        wall:             'grau',
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
        suspendedCeiling: string
        glass:            string
        electrical:       string
        safety:           string
        door: {
            default: string
            byBKP: Record<DoorBKPCategory, string>
        }
    }
    strokes: {
        outline: string
    }
}

function resolveColors(config: RenderColorsConfig): RenderColors {
    const P = (name: string) => resolvePaletteName(config, name)
    return {
        plan: {
            wallCut:             P(config.plan.wallCut),
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
        const jsonPath = resolvePath(process.cwd(), 'config/render-colors.json')
        const raw = readFileSync(jsonPath, 'utf8')
        config = JSON.parse(raw) as RenderColorsConfig
    } catch (err) {
        // File missing in a deployment bundle, or JSON malformed — keep defaults.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.warn('[color-config] failed to load config/render-colors.json; using built-in defaults:', err)
        }
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

/** Pick the elevation door-leaf colour from the door's BKP classification. */
export function resolveElevationDoorColor(
    cfcBkpCccBcc: string | null | undefined,
    colors: RenderColors = loadRenderColors()
): string {
    const category = classifyDoorBKP(cfcBkpCccBcc)
    return category ? colors.elevation.door.byBKP[category] : colors.elevation.door.default
}
