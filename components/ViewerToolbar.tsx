'use client'

import { useState, useEffect } from 'react'
import type { NavigationManager } from '@/lib/navigation-manager'
import type { ElementVisibilityManager } from '@/lib/element-visibility-manager'
import type { DoorContext } from '@/lib/door-analyzer'

export type SectionMode = 'off' | 'line' | 'drag-top' | 'drag-bottom'

export type ColorMode = 'off' | 'geometry-type'

interface ViewerToolbarProps {
    navigationManager: NavigationManager | null
    onSectionModeChange?: (mode: SectionMode) => void
    onResetView?: () => void
    sectionMode?: SectionMode
    isSectionActive?: boolean
    visibilityManager?: ElementVisibilityManager | null
    doorContexts?: DoorContext[]
    colorMode?: ColorMode
    onColorModeChange?: (mode: ColorMode) => void
    doorFilterActive?: boolean
    onDoorFilterChange?: (active: boolean) => void
    onTriggerRender?: () => void
}

function ScissorsIcon({ size = 20 }: { size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <circle cx="6" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <path d="M8.12 8.12L12 12" />
            <path d="M20 4L8.12 15.88" />
            <path d="M14.8 14.8L20 20" />
        </svg>
    )
}

function LineIcon({ size = 20 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="4" y1="12" x2="20" y2="12" />
        </svg>
    )
}

function ArrowDownIcon({ size = 20 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14" />
            <path d="M19 12l-7 7-7-7" />
        </svg>
    )
}

function ArrowUpIcon({ size = 20 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 19V5" />
            <path d="M5 12l7-7 7 7" />
        </svg>
    )
}

function CenterIcon({ size = 20 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M12 2v4" />
            <path d="M12 18v4" />
            <path d="M2 12h4" />
            <path d="M18 12h4" />
        </svg>
    )
}

function PaintIcon({ size = 20 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18.37 2.63 14 7l-1.59-1.59a2 2 0 0 0-2.82 0L8 7l9 9 1.59-1.59a2 2 0 0 0 0-2.82L17 10l4.37-4.37a2.12 2.12 0 1 0-3-3Z" />
            <path d="M9 8c-2 3-4 3.5-7 4l8 10c2-1 6-5 6-7" />
            <path d="M14.5 17.5 4.5 15" />
        </svg>
    )
}

function GeometryTypeIcon({ size = 20 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
            <path d="M3.27 6.96L12 12.01l8.73-5.05" />
            <path d="M12 22.08V12" />
        </svg>
    )
}

function DoorIcon({ size = 20 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 20h16" />
            <path d="M4 20V4" />
            <path d="M4 4a16 16 0 0 1 16 16" />
        </svg>
    )
}

const roundButtonStyle = (active: boolean, size: 40 | 48 = 48) => ({
    width: `${size}px`,
    height: `${size}px`,
    borderRadius: '50%',
    border: active ? '1px solid #5a8fc2' : '1px solid #555',
    backgroundColor: active ? '#3d5a80' : '#2a2a2a',
    color: active ? '#fff' : '#e0e0e0',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'all 0.15s ease',
    boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
})

export default function ViewerToolbar({
    navigationManager,
    onSectionModeChange,
    onResetView,
    sectionMode = 'off',
    isSectionActive = false,
    visibilityManager,
    doorContexts = [],
    colorMode = 'off',
    onColorModeChange,
    doorFilterActive = false,
    onDoorFilterChange,
    onTriggerRender,
}: ViewerToolbarProps) {
    const [expanded, setExpanded] = useState(false)
    const [colorExpanded, setColorExpanded] = useState(false)

    useEffect(() => {
        if (sectionMode === 'off') setExpanded(false)
    }, [sectionMode])

    useEffect(() => {
        if (colorMode === 'off') setColorExpanded(false)
    }, [colorMode])

    const handleScissorsClick = () => {
        if (sectionMode !== 'off') {
            onSectionModeChange?.('off')
        } else {
            setExpanded((prev) => !prev)
        }
    }

    const handleModeSelect = (mode: SectionMode) => {
        onSectionModeChange?.(mode)
        setExpanded(false)
    }

    const handleResetAll = () => {
        onSectionModeChange?.('off')
        onResetView?.()
        navigationManager?.setViewPreset('iso')
        setExpanded(false)
    }

    const handleColorClick = async () => {
        if (colorMode !== 'off') {
            await onColorModeChange?.('off')
            requestAnimationFrame(() => {
                requestAnimationFrame(() => onTriggerRender?.())
            })
            onTriggerRender?.()
        } else {
            setColorExpanded((prev) => !prev)
        }
    }

    const handleColorByGeometryType = async () => {
        if (colorMode === 'geometry-type') {
            await onColorModeChange?.('off')
            requestAnimationFrame(() => {
                requestAnimationFrame(() => onTriggerRender?.())
            })
            onTriggerRender?.()
        } else if (visibilityManager && doorContexts.length > 0) {
            onColorModeChange?.('geometry-type')
            await visibilityManager.colorDoorsByGeometryType(doorContexts, doorFilterActive)
            // Double rAF: Fragments highlight needs a frame to commit before render shows it
            requestAnimationFrame(() => {
                requestAnimationFrame(() => onTriggerRender?.())
            })
            onTriggerRender?.()
        }
        setColorExpanded(false)
    }

    const handleDoorFilterClick = async () => {
        if (!visibilityManager) return
        if (doorFilterActive) {
            await visibilityManager.enqueueFilterUpdate(async () => {
                await visibilityManager!.clearIFCClassFilters()
                if (colorMode === 'geometry-type' && doorContexts.length > 0) {
                    await visibilityManager!.colorDoorsByGeometryType(doorContexts, false)
                }
            })
            onDoorFilterChange?.(false)
        } else {
            await visibilityManager.enqueueFilterUpdate(async () => {
                await visibilityManager!.filterByIFCClass(['IFCDOOR'])
            })
            onDoorFilterChange?.(true)
        }
        onTriggerRender?.()
    }

    const isSectionMode = sectionMode !== 'off'
    const isActive = isSectionActive || isSectionMode
    const isColorActive = colorMode !== 'off'

    return (
        <div
            style={{
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                gap: '8px',
            }}
        >
            <div
                style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    gap: '8px',
                }}
            >
                <button
                    onClick={() => navigationManager?.setViewPreset('iso')}
                    title="Center model"
                    aria-label="Center model"
                    style={roundButtonStyle(false)}
                >
                    <CenterIcon size={24} />
                </button>
                <div
                    style={{
                        display: 'flex',
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: '8px',
                    }}
                >
                    <button
                        onClick={handleScissorsClick}
                        title="Section"
                        aria-label="Section"
                        aria-pressed={isActive}
                        style={roundButtonStyle(isActive)}
                    >
                        <ScissorsIcon size={24} />
                    </button>
                    {expanded && (
                        <>
                            <button
                                onClick={() => handleModeSelect('line')}
                                title="Draw section line (2 clicks)"
                                aria-label="Draw section line (2 clicks)"
                                aria-pressed={sectionMode === 'line'}
                                style={roundButtonStyle(sectionMode === 'line')}
                            >
                                <LineIcon size={24} />
                            </button>
                            <button
                                onClick={() => handleModeSelect('drag-top')}
                                title="Drag section from top"
                                aria-label="Drag section from top"
                                aria-pressed={sectionMode === 'drag-top'}
                                style={roundButtonStyle(sectionMode === 'drag-top')}
                            >
                                <ArrowDownIcon size={24} />
                            </button>
                            <button
                                onClick={() => handleModeSelect('drag-bottom')}
                                title="Drag section from bottom"
                                aria-label="Drag section from bottom"
                                aria-pressed={sectionMode === 'drag-bottom'}
                                style={roundButtonStyle(sectionMode === 'drag-bottom')}
                            >
                                <ArrowUpIcon size={24} />
                            </button>
                        </>
                    )}
                    {isSectionActive && (
                        <button
                            onClick={handleResetAll}
                            title="Show full model [R]"
                            aria-label="Show full model"
                            style={roundButtonStyle(false)}
                        >
                            <span style={{ fontSize: '24px', lineHeight: 1 }}>↺</span>
                        </button>
                    )}
                </div>
                <div
                    style={{
                        display: 'flex',
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: '8px',
                    }}
                >
                    <button
                        onClick={handleColorClick}
                        title="Color"
                        aria-label="Color"
                        aria-pressed={isColorActive}
                        style={roundButtonStyle(isColorActive)}
                    >
                        <PaintIcon size={24} />
                    </button>
                    {colorExpanded && (
                        <button
                            onClick={handleColorByGeometryType}
                            title="Nach Geometrietyp einfärben"
                            style={roundButtonStyle(colorMode === 'geometry-type')}
                        >
                            <GeometryTypeIcon size={24} />
                        </button>
                    )}
                </div>
                <button
                    onClick={handleDoorFilterClick}
                    title="Nur IfcDoors anzeigen"
                    aria-label="Door filter"
                    aria-pressed={doorFilterActive}
                    style={roundButtonStyle(doorFilterActive)}
                >
                    <DoorIcon size={24} />
                </button>
            </div>
        </div>
    )
}
