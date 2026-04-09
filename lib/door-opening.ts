export type DoorSwingHingeSide = 'left' | 'right' | 'both'

export interface DoorOperationInfo {
    raw: string | null
    kind: 'swing' | 'sliding' | 'folding' | 'fixed' | 'none'
    hingeSide: DoorSwingHingeSide | null
    swingCapable: boolean
    fixedLabeled: boolean
}

export function parseDoorOperationType(operationType: string | null): DoorOperationInfo {
    if (!operationType) {
        return {
            raw: null,
            kind: 'none',
            hingeSide: null,
            swingCapable: false,
            fixedLabeled: false,
        }
    }

    const upper = operationType.toUpperCase()

    if (upper.includes('SWING_FIXED_LEFT')) {
        return {
            raw: operationType,
            kind: 'fixed',
            hingeSide: 'left',
            swingCapable: true,
            fixedLabeled: true,
        }
    }

    if (upper.includes('SWING_FIXED_RIGHT')) {
        return {
            raw: operationType,
            kind: 'fixed',
            hingeSide: 'right',
            swingCapable: true,
            fixedLabeled: true,
        }
    }

    if (upper.includes('SINGLE_SWING_LEFT') || upper === 'SINGLE_SWING_LEFT') {
        return {
            raw: operationType,
            kind: 'swing',
            hingeSide: 'left',
            swingCapable: true,
            fixedLabeled: false,
        }
    }

    if (upper.includes('SINGLE_SWING_RIGHT') || upper === 'SINGLE_SWING_RIGHT') {
        return {
            raw: operationType,
            kind: 'swing',
            hingeSide: 'right',
            swingCapable: true,
            fixedLabeled: false,
        }
    }

    if (upper.includes('DOUBLE_DOOR_SINGLE_SWING') || upper.includes('DOUBLE_DOOR_DOUBLE_SWING')) {
        return {
            raw: operationType,
            kind: 'swing',
            hingeSide: 'both',
            swingCapable: true,
            fixedLabeled: false,
        }
    }

    if (upper.includes('SLIDING_TO_LEFT')) {
        return {
            raw: operationType,
            kind: 'sliding',
            hingeSide: null,
            swingCapable: false,
            fixedLabeled: false,
        }
    }

    if (upper.includes('SLIDING_TO_RIGHT')) {
        return {
            raw: operationType,
            kind: 'sliding',
            hingeSide: null,
            swingCapable: false,
            fixedLabeled: false,
        }
    }

    if (upper.includes('SLIDING') && !upper.includes('FOLDING')) {
        return {
            raw: operationType,
            kind: 'sliding',
            hingeSide: null,
            swingCapable: false,
            fixedLabeled: false,
        }
    }

    if (upper.includes('FOLDING')) {
        return {
            raw: operationType,
            kind: 'folding',
            hingeSide: null,
            swingCapable: false,
            fixedLabeled: false,
        }
    }

    if (upper.includes('FIXED')) {
        return {
            raw: operationType,
            kind: 'fixed',
            hingeSide: null,
            swingCapable: false,
            fixedLabeled: true,
        }
    }

    if (upper.includes('SWING')) {
        return {
            raw: operationType,
            kind: 'swing',
            hingeSide: 'right',
            swingCapable: true,
            fixedLabeled: false,
        }
    }

    return {
        raw: operationType,
        kind: 'none',
        hingeSide: null,
        swingCapable: false,
        fixedLabeled: false,
    }
}
