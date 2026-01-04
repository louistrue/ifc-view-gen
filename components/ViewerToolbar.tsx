'use client'

import { useState } from 'react'
import type { NavigationManager } from '@/lib/navigation-manager'
import type { SectionBox } from '@/lib/section-box'

export type SectionMode = 'off' | 'line' | 'face' | 'box'

interface ViewerToolbarProps {
    navigationManager: NavigationManager | null
    sectionBox: SectionBox | null
    onNavigationModeChange?: (mode: 'orbit' | 'walk') => void
    onSectionBoxToggle?: (enabled: boolean) => void
    onSectionModeChange?: (mode: SectionMode) => void
    onSpatialPanelToggle?: () => void
    onTypeFilterToggle?: () => void
    onZoomWindowToggle?: () => void
    onResetView?: () => void
    showSpatialPanel?: boolean
    showTypeFilter?: boolean
    zoomWindowActive?: boolean
    sectionMode?: SectionMode
    isSectionActive?: boolean  // True when ANY section (plane or box) is enabled
}

export default function ViewerToolbar({
    navigationManager,
    sectionBox,
    onNavigationModeChange,
    onSectionBoxToggle,
    onSectionModeChange,
    onSpatialPanelToggle,
    onTypeFilterToggle,
    onZoomWindowToggle,
    onResetView,
    showSpatialPanel = false,
    showTypeFilter = false,
    zoomWindowActive = false,
    sectionMode = 'off',
    isSectionActive = false,
}: ViewerToolbarProps) {
    const [navigationMode, setNavigationMode] = useState<'orbit' | 'walk'>('orbit')
    const [showSectionMenu, setShowSectionMenu] = useState(false)

    const handleNavigationModeToggle = () => {
        const newMode = navigationMode === 'orbit' ? 'walk' : 'orbit'
        setNavigationMode(newMode)
        if (navigationManager) {
            navigationManager.setMode(newMode)
        }
        if (onNavigationModeChange) {
            onNavigationModeChange(newMode)
        }
    }

    const handleSectionModeSelect = (mode: SectionMode) => {
        setShowSectionMenu(false)
        // Let IFCViewer handle all section state through onSectionModeChange
        if (onSectionModeChange) {
            onSectionModeChange(mode)
        }
    }

    const handleResetAll = () => {
        // Clear section
        handleSectionModeSelect('off')
        // Reset view
        if (onResetView) {
            onResetView()
        }
        // Zoom to fit
        if (navigationManager) {
            navigationManager.setViewPreset('iso')
        }
    }

    const buttonStyle: React.CSSProperties = {
        padding: '6px 10px',
        border: '1px solid #555',
        borderRadius: '3px',
        backgroundColor: '#2a2a2a',
        color: '#e0e0e0',
        cursor: 'pointer',
        fontSize: '12px',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontWeight: 500,
        transition: 'all 0.15s ease',
        width: '100%',
        textAlign: 'left' as const,
    }

    const activeButtonStyle: React.CSSProperties = {
        ...buttonStyle,
        backgroundColor: '#3d5a80',
        border: '1px solid #5a8fc2',
        color: '#fff',
    }

    const getSectionLabel = () => {
        if (isSectionActive && sectionMode === 'off') {
            return 'Section ✓'  // Section is active but not in drawing mode
        }
        switch (sectionMode) {
            case 'line': return 'Section: Line'
            case 'face': return 'Section: Face'
            case 'box': return 'Section: Box'
            default: return 'Section'
        }
    }

    return (
        <div
            className="viewer-toolbar"
            style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
                padding: '10px',
                backgroundColor: 'rgba(32, 32, 32, 0.95)',
                border: '1px solid #444',
                borderRadius: '6px',
                boxShadow: '0 2px 12px rgba(0,0,0,0.3)',
                width: '140px',
            }}
        >
            {/* Reset Button - Always visible when ANY section is active */}
            {isSectionActive && (
                <>
                    <button
                        onClick={handleResetAll}
                        title="Clear section and reset view [R]"
                        style={{
                            ...buttonStyle,
                            backgroundColor: '#4ecdc4',
                            border: '1px solid #6ee7df',
                            color: '#1a1a1a',
                            fontWeight: 600,
                            textAlign: 'center',
                        }}
                    >
                        ↺ Show Full Model
                    </button>
                    <div style={{ height: '1px', backgroundColor: '#444', margin: '2px 0' }} />
                </>
            )}

            {/* Navigation Mode Toggle */}
            <button
                onClick={handleNavigationModeToggle}
                title={`Switch to ${navigationMode === 'orbit' ? 'Walk' : 'Orbit'} mode [Tab]`}
                style={navigationMode === 'orbit' ? activeButtonStyle : buttonStyle}
            >
                {navigationMode === 'orbit' ? 'Orbit' : 'Walk'}
            </button>

            <div style={{ height: '1px', backgroundColor: '#444', margin: '4px 0' }} />

            {/* Section Menu */}
            <div style={{ position: 'relative' }}>
                <button
                    onClick={() => setShowSectionMenu(!showSectionMenu)}
                    title="Section tools [S]"
                    style={{
                        ...(isSectionActive || sectionMode !== 'off' ? activeButtonStyle : buttonStyle),
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                    }}
                >
                    <span>{getSectionLabel()}</span>
                    <span style={{ fontSize: '10px' }}>▾</span>
                </button>

                {showSectionMenu && (
                    <div
                        style={{
                            position: 'absolute',
                            top: '100%',
                            left: 0,
                            marginTop: '4px',
                            backgroundColor: 'rgba(32, 32, 32, 0.98)',
                            border: '1px solid #555',
                            borderRadius: '6px',
                            padding: '6px',
                            minWidth: '160px',
                            zIndex: 1002,
                            boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
                        }}
                    >
                        <div style={{
                            fontSize: '10px',
                            color: '#888',
                            marginBottom: '6px',
                            paddingLeft: '4px',
                            textTransform: 'uppercase',
                            letterSpacing: '0.5px'
                        }}>
                            Create Section
                        </div>

                        <button
                            onClick={() => handleSectionModeSelect('line')}
                            style={{
                                ...buttonStyle,
                                marginBottom: '4px',
                                ...(sectionMode === 'line' ? { backgroundColor: '#3d5a80', border: '1px solid #5a8fc2' } : {})
                            }}
                            title="Draw a line to create section plane"
                        >
                            <span style={{ marginRight: '8px' }}>╱</span>
                            Draw Line
                        </button>

                        <button
                            onClick={() => handleSectionModeSelect('face')}
                            style={{
                                ...buttonStyle,
                                marginBottom: '4px',
                                ...(sectionMode === 'face' ? { backgroundColor: '#3d5a80', border: '1px solid #5a8fc2' } : {})
                            }}
                            title="Click on a face to align section"
                        >
                            <span style={{ marginRight: '8px' }}>◧</span>
                            Click Face
                        </button>

                        <button
                            onClick={() => handleSectionModeSelect('box')}
                            style={{
                                ...buttonStyle,
                                marginBottom: '2px',
                                ...(sectionMode === 'box' ? { backgroundColor: '#3d5a80', border: '1px solid #5a8fc2' } : {})
                            }}
                            title="Create a 3D section box"
                        >
                            <span style={{ marginRight: '8px' }}>▣</span>
                            Section Box
                        </button>

                        {isSectionActive && (
                            <>
                                <div style={{ height: '1px', backgroundColor: '#444', margin: '8px 0' }} />
                                <button
                                    onClick={() => handleSectionModeSelect('off')}
                                    style={{
                                        ...buttonStyle,
                                        backgroundColor: 'rgba(248, 113, 113, 0.15)',
                                        border: '1px solid rgba(248, 113, 113, 0.4)',
                                        color: '#f87171',
                                        textAlign: 'center',
                                    }}
                                    title="Clear section and show full model [R]"
                                >
                                    Clear Section
                                </button>
                            </>
                        )}
                    </div>
                )}
            </div>

            {/* Zoom Window Toggle */}
            <button
                onClick={onZoomWindowToggle}
                title="Zoom window - draw rectangle to zoom [Z]"
                style={zoomWindowActive ? activeButtonStyle : buttonStyle}
            >
                Zoom Window
            </button>

            <div style={{ height: '1px', backgroundColor: '#444', margin: '4px 0' }} />

            {/* Spatial Panel Toggle */}
            <button
                onClick={onSpatialPanelToggle}
                title="Toggle spatial hierarchy"
                style={showSpatialPanel ? activeButtonStyle : buttonStyle}
            >
                Hierarchy
            </button>

            {/* IFC Class Filter Toggle */}
            <button
                onClick={onTypeFilterToggle}
                title="Filter by IFC class"
                style={showTypeFilter ? activeButtonStyle : buttonStyle}
            >
                Classes
            </button>

            <div style={{ height: '1px', backgroundColor: '#444', margin: '4px 0' }} />

            {/* Help */}
            <button
                title="Keyboard shortcuts"
                style={{ ...buttonStyle, textAlign: 'center' }}
                onClick={() => {
                    alert(`Keyboard Shortcuts:

Navigation:
  Tab — Switch Orbit/Walk mode
  W/A/S/D — Move (Walk mode)
  
Views:
  1-7 — View presets (Top, Bottom, Front, Back, Left, Right, 3D)
  Z — Zoom window
  
Section:
  R — Reset / Show full model
  F — Flip section direction
  ESC — Cancel section drawing`)
                }}
            >
                ? Shortcuts
            </button>
        </div>
    )
}
