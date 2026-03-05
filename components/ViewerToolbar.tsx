'use client'

import { useState, useEffect } from 'react'
import type { NavigationManager } from '@/lib/navigation-manager'

export type SectionMode = 'off' | 'line' | 'drag-top' | 'drag-bottom'

interface ViewerToolbarProps {
    navigationManager: NavigationManager | null
    onSectionModeChange?: (mode: SectionMode) => void
    onResetView?: () => void
    sectionMode?: SectionMode
    isSectionActive?: boolean
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

const roundButtonStyle = (active: boolean) => ({
    width: '40px',
    height: '40px',
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
}: ViewerToolbarProps) {
    const [expanded, setExpanded] = useState(false)

    useEffect(() => {
        if (sectionMode === 'off') setExpanded(false)
    }, [sectionMode])

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

    const isSectionMode = sectionMode !== 'off'
    const isActive = isSectionActive || isSectionMode

    return (
        <div
            style={{
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                gap: '8px',
            }}
        >
            {isSectionActive && (
                <button
                    onClick={handleResetAll}
                    title="Show full model [R]"
                    style={{
                        width: '40px',
                        height: '40px',
                        borderRadius: '50%',
                        border: '1px solid #6ee7df',
                        backgroundColor: '#4ecdc4',
                        color: '#1a1a1a',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '16px',
                        transition: 'all 0.15s ease',
                    }}
                >
                    ↺
                </button>
            )}

            <button
                onClick={handleScissorsClick}
                title="Section"
                style={{
                    ...roundButtonStyle(isActive),
                    width: '48px',
                    height: '48px',
                }}
            >
                <ScissorsIcon size={24} />
            </button>

            {expanded && (
                <>
                    <button
                        onClick={() => handleModeSelect('line')}
                        title="Draw section line (2 clicks)"
                        style={roundButtonStyle(sectionMode === 'line')}
                    >
                        <LineIcon size={22} />
                    </button>
                    <button
                        onClick={() => handleModeSelect('drag-top')}
                        title="Drag section from top"
                        style={roundButtonStyle(sectionMode === 'drag-top')}
                    >
                        <ArrowDownIcon size={22} />
                    </button>
                    <button
                        onClick={() => handleModeSelect('drag-bottom')}
                        title="Drag section from bottom"
                        style={roundButtonStyle(sectionMode === 'drag-bottom')}
                    >
                        <ArrowUpIcon size={22} />
                    </button>
                </>
            )}
        </div>
    )
}
