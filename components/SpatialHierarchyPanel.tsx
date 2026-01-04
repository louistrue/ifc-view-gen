'use client'

import { useState, useEffect, useCallback } from 'react'
import type { SpatialNode } from '@/lib/spatial-structure'
import type { ElementVisibilityManager } from '@/lib/element-visibility-manager'
import { getAllElementIds, getAllModelElementIds } from '@/lib/spatial-structure'

interface StoreyInfo {
    id: number
    name: string
    elementCount: number
    elementIds: number[] // Tracked elements (for display count)
    allElementIds: number[] // ALL model elements (for visibility)
}

interface SpatialHierarchyPanelProps {
    spatialStructure: SpatialNode | null
    visibilityManager: ElementVisibilityManager | null
    onClose?: () => void
}

export default function SpatialHierarchyPanel({
    spatialStructure,
    visibilityManager,
    onClose,
}: SpatialHierarchyPanelProps) {
    const [isMinimized, setIsMinimized] = useState(false)
    const [storeys, setStoreys] = useState<StoreyInfo[]>([])
    const [hiddenStoreys, setHiddenStoreys] = useState<Set<number>>(new Set())
    const [isolatedStorey, setIsolatedStorey] = useState<number | null>(null)
    const [allElements, setAllElements] = useState<number[]>([])

    // Extract storeys (and unassigned category) from spatial structure
    useEffect(() => {
        if (!spatialStructure) {
            setStoreys([])
            return
        }

        const foundStoreys: StoreyInfo[] = []

        // Recursively find all storeys and special categories
        const findStoreys = (node: SpatialNode) => {
            // Include both storeys and the "Unassigned" category
            if (node.type === 'IfcBuildingStorey' || (node.type === 'Category' && node.id === -99999)) {
                const trackedIds = getAllElementIds(node)
                const allIds = getAllModelElementIds(node)
                if (allIds.length > 0) {
                    foundStoreys.push({
                        id: node.id,
                        name: node.name,
                        elementCount: trackedIds.length, // Show tracked count
                        elementIds: trackedIds,
                        allElementIds: allIds, // Use all IDs for visibility
                    })
                }
            }

            for (const child of node.children) {
                findStoreys(child)
            }
        }

        findStoreys(spatialStructure)

        // Also collect all elements from root
        const rootElements = getAllModelElementIds(spatialStructure)

        console.log(`Found ${foundStoreys.length} storeys/categories with total ${rootElements.length} model elements`)
        setStoreys(foundStoreys)
        setAllElements(rootElements)
    }, [spatialStructure])

    const handleVisibilityToggle = async (storey: StoreyInfo, visible: boolean) => {
        if (!visibilityManager) {
            console.warn('No visibility manager')
            return
        }

        console.log(`Toggle storey: ${storey.name} (${storey.allElementIds.length} model elements) -> ${visible}`)

        let newHidden = new Set(hiddenStoreys)

        // If we're in solo mode and user is adding another storey
        if (isolatedStorey !== null && visible && isolatedStorey !== storey.id) {
            console.log('Adding storey to solo view - switching to multi-select mode')
            // Mark all OTHER storeys as hidden (except the solo'd one and the new one)
            newHidden = new Set(storeys.filter(s => s.id !== isolatedStorey && s.id !== storey.id).map(s => s.id))
            setIsolatedStorey(null)
        } else if (visible) {
            newHidden.delete(storey.id)
        } else {
            newHidden.add(storey.id)
        }

        // Apply visibility
        if (visible) {
            await visibilityManager.setElementsVisible(storey.allElementIds, true)
        } else {
            await visibilityManager.setElementsVisible(storey.allElementIds, false)
        }

        setHiddenStoreys(newHidden)
    }

    const handleIsolate = async (storey: StoreyInfo) => {
        if (!visibilityManager) {
            console.warn('No visibility manager')
            return
        }

        console.log(`Solo storey: ${storey.name} (${storey.allElementIds.length} model elements)`)

        // If already in solo mode on this storey, exit solo
        if (isolatedStorey === storey.id) {
            console.log('Exiting solo mode - showing all')
            setIsolatedStorey(null)
            setHiddenStoreys(new Set()) // Clear hidden state - all visible
            await visibilityManager.resetAllVisibility()
            return
        }

        // Enter solo mode - hide everything except this storey
        setIsolatedStorey(storey.id)
        // Mark all OTHER storeys as hidden in UI state
        const othersHidden = new Set(storeys.filter(s => s.id !== storey.id).map(s => s.id))
        setHiddenStoreys(othersHidden)
        await visibilityManager.isolateElements(storey.allElementIds)
    }

    const handleShowAll = async () => {
        if (!visibilityManager) return

        console.log('Show all storeys')
        setHiddenStoreys(new Set())
        setIsolatedStorey(null)
        await visibilityManager.resetAllVisibility()
    }

    const handleHideAll = async () => {
        if (!visibilityManager) return

        console.log('Hide all elements')
        const allStoreyIds = new Set(storeys.map(s => s.id))
        setHiddenStoreys(allStoreyIds)

        // Hide ALL elements in the entire model
        await visibilityManager.hideAllElements()
    }

    const isStoreyVisible = (storey: StoreyInfo): boolean => {
        return !hiddenStoreys.has(storey.id)
    }

    const hasChanges = hiddenStoreys.size > 0 || isolatedStorey !== null

    if (!spatialStructure) {
        return null
    }

    return (
        <div
            style={{
                width: isMinimized ? '140px' : '260px',
                backgroundColor: 'rgba(32, 32, 32, 0.95)',
                border: '1px solid #444',
                borderRadius: '6px',
                boxShadow: '0 2px 12px rgba(0,0,0,0.3)',
                display: 'flex',
                flexDirection: 'column',
                maxHeight: '300px',
                overflow: 'hidden',
                flexShrink: 0,
            }}
        >
            {/* Header */}
            <div
                style={{
                    padding: '8px 10px',
                    borderBottom: '1px solid #444',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                }}
            >
                <span style={{ fontSize: '11px', color: '#888', fontWeight: 500 }}>
                    Storeys ({storeys.length})
                </span>
                <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                    {hasChanges && (
                        <button
                            onClick={handleShowAll}
                            title="Show All"
                            style={{
                                background: 'rgba(0, 150, 136, 0.2)',
                                border: '1px solid rgba(0, 150, 136, 0.4)',
                                borderRadius: '3px',
                                cursor: 'pointer',
                                fontSize: '10px',
                                color: '#00bcd4',
                                padding: '2px 6px',
                            }}
                        >
                            ↺ Reset
                        </button>
                    )}
                    <button
                        onClick={() => setIsMinimized(!isMinimized)}
                        style={{
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            fontSize: '12px',
                            color: '#888',
                            padding: '2px 6px',
                        }}
                    >
                        {isMinimized ? '+' : '−'}
                    </button>
                    {onClose && (
                        <button
                            onClick={onClose}
                            style={{
                                background: 'none',
                                border: 'none',
                                cursor: 'pointer',
                                fontSize: '14px',
                                color: '#888',
                                padding: '2px 6px',
                            }}
                        >
                            ×
                        </button>
                    )}
                </div>
            </div>

            {!isMinimized && (
                <>
                    {/* Quick actions */}
                    <div style={{
                        padding: '6px 8px',
                        borderBottom: '1px solid #333',
                        display: 'flex',
                        gap: '6px',
                    }}>
                        <button
                            onClick={handleShowAll}
                            style={{
                                flex: 1,
                                padding: '4px 8px',
                                fontSize: '10px',
                                background: '#333',
                                border: '1px solid #555',
                                borderRadius: '3px',
                                color: '#aaa',
                                cursor: 'pointer',
                            }}
                        >
                            Show All
                        </button>
                        <button
                            onClick={handleHideAll}
                            style={{
                                flex: 1,
                                padding: '4px 8px',
                                fontSize: '10px',
                                background: '#333',
                                border: '1px solid #555',
                                borderRadius: '3px',
                                color: '#aaa',
                                cursor: 'pointer',
                            }}
                        >
                            Hide All
                        </button>
                    </div>

                    {/* Storey list */}
                    <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
                        {storeys.length === 0 ? (
                            <div style={{ padding: '12px', textAlign: 'center', color: '#666', fontSize: '11px' }}>
                                No storeys found
                            </div>
                        ) : (
                            storeys.map((storey) => {
                                const isVisible = isStoreyVisible(storey)
                                const isIsolated = isolatedStorey === storey.id

                                return (
                                    <div
                                        key={storey.id}
                                        style={{
                                            padding: '6px 10px',
                                            borderBottom: '1px solid #333',
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '8px',
                                            backgroundColor: isIsolated ? 'rgba(0, 150, 136, 0.15)' : 'transparent',
                                        }}
                                    >
                                        {/* Checkbox */}
                                        <input
                                            type="checkbox"
                                            checked={isVisible}
                                            onChange={(e) => handleVisibilityToggle(storey, e.target.checked)}
                                            style={{ margin: 0, cursor: 'pointer' }}
                                            title="Toggle visibility"
                                        />

                                        {/* Name and count */}
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <div
                                                style={{
                                                    fontSize: '11px',
                                                    color: isVisible ? '#e0e0e0' : '#666',
                                                    overflow: 'hidden',
                                                    textOverflow: 'ellipsis',
                                                    whiteSpace: 'nowrap',
                                                }}
                                                title={storey.name}
                                            >
                                                {storey.name}
                                            </div>
                                            <div style={{ fontSize: '9px', color: '#555' }}>
                                                {storey.elementCount} elements
                                            </div>
                                        </div>

                                        {/* Isolate button */}
                                        <button
                                            onClick={() => handleIsolate(storey)}
                                            title={isIsolated ? 'Show all (exit solo)' : 'Solo (show only this)'}
                                            style={{
                                                background: isIsolated ? 'rgba(0, 150, 136, 0.3)' : 'none',
                                                border: isIsolated ? '1px solid #00bcd4' : 'none',
                                                borderRadius: '3px',
                                                color: isIsolated ? '#00bcd4' : '#888',
                                                cursor: 'pointer',
                                                fontSize: '12px',
                                                padding: '2px 4px',
                                            }}
                                        >
                                            ◉
                                        </button>
                                    </div>
                                )
                            })
                        )}
                    </div>
                </>
            )}
        </div>
    )
}
