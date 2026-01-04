'use client'

import type { NavigationManager } from '@/lib/navigation-manager'

export type SectionMode = 'off' | 'line'

interface ViewerToolbarProps {
    navigationManager: NavigationManager | null
    onSectionModeChange?: (mode: SectionMode) => void
    onSpatialPanelToggle?: () => void
    onTypeFilterToggle?: () => void
    onIFCClassFilterToggle?: () => void
    onZoomWindowToggle?: () => void
    onResetView?: () => void
    showSpatialPanel?: boolean
    showTypeFilter?: boolean
    showIFCClassFilter?: boolean
    zoomWindowActive?: boolean
    sectionMode?: SectionMode
    isSectionActive?: boolean  // True when section plane is enabled
}

export default function ViewerToolbar({
    navigationManager,
    onSectionModeChange,
    onSpatialPanelToggle,
    onTypeFilterToggle,
    onIFCClassFilterToggle,
    onZoomWindowToggle,
    onResetView,
    showSpatialPanel = false,
    showTypeFilter = false,
    showIFCClassFilter = false,
    zoomWindowActive = false,
    sectionMode = 'off',
    isSectionActive = false,
}: ViewerToolbarProps) {
    const handleSectionToggle = () => {
        // Toggle between 'off' and 'line' modes
        const newMode: SectionMode = sectionMode === 'off' ? 'line' : 'off'
        if (onSectionModeChange) {
            onSectionModeChange(newMode)
        }
    }

    const handleResetAll = () => {
        // Clear section
        if (onSectionModeChange) {
            onSectionModeChange('off')
        }
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

            {/* Section Toggle */}
            <button
                onClick={handleSectionToggle}
                title="Draw section line - hold Shift for horizontal/vertical [S]"
                style={(isSectionActive || sectionMode === 'line') ? activeButtonStyle : buttonStyle}
            >
                {sectionMode === 'line' ? 'Section: Drawing' : (isSectionActive ? 'Section ✓' : 'Section')}
            </button>

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

            {/* Type Filter Toggle */}
            <button
                onClick={onTypeFilterToggle}
                title="Filter by product types"
                style={showTypeFilter ? activeButtonStyle : buttonStyle}
            >
                Types
            </button>

            {/* IFC Class Filter Toggle */}
            <button
                onClick={onIFCClassFilterToggle}
                title="Filter by IFC classes"
                style={showIFCClassFilter ? activeButtonStyle : buttonStyle}
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

Views:
  1-7 — View presets (Top, Bottom, Front, Back, Left, 3D)
  Z — Zoom window
  
Section:
  R — Reset / Show full model
  Shift — Hold for horizontal/vertical constraint
  F — Flip section direction
  ESC — Cancel section drawing`)
                }}
            >
                ? Shortcuts
            </button>
        </div>
    )
}
