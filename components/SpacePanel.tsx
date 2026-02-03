'use client'

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import type { SpaceContext } from '@/lib/ifc-space-types'
import { filterSpaces, getElementsInSpace } from '@/lib/space-analyzer'
import type { ElementVisibilityManager } from '@/lib/element-visibility-manager'
import type { NavigationManager } from '@/lib/navigation-manager'
import JSZip from 'jszip'
import { renderSpaceFloorPlan, renderSpaceViews } from '@/lib/space-svg-renderer'
import type { SpaceSVGRenderOptions } from '@/lib/ifc-space-types'

interface SpacePanelProps {
    spaceContexts: SpaceContext[]
    visibilityManager: ElementVisibilityManager | null
    navigationManager: NavigationManager | null
    modelSource?: string
    modelMetadata?: {
        api: any
        modelID: number
        elements: any[]
        lengthUnitScale: number
        isYUp: boolean
    } | null
    onComplete?: () => void
}

interface AirtableStatus {
    [spaceId: string]: 'idle' | 'sending' | 'success' | 'error'
}

export default function SpacePanel({
    spaceContexts,
    visibilityManager,
    navigationManager,
    modelSource,
    modelMetadata,
    onComplete,
}: SpacePanelProps) {
    // Filter state
    const [searchQuery, setSearchQuery] = useState('')
    const [selectedStoreys, setSelectedStoreys] = useState<Set<string>>(new Set())
    const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set())
    const [selectedFunctions, setSelectedFunctions] = useState<Set<string>>(new Set())
    const [isolateFiltered, setIsolateFiltered] = useState(false)

    // Collapsible sections
    const [storeyExpanded, setStoreyExpanded] = useState(false)
    const [typeExpanded, setTypeExpanded] = useState(true)
    const [functionExpanded, setFunctionExpanded] = useState(false)

    // Selection state
    const [selectedSpaceIds, setSelectedSpaceIds] = useState<Set<string>>(new Set())
    const [hoveredSpaceId, setHoveredSpaceId] = useState<string | null>(null)

    // UI state
    const [showFilters, setShowFilters] = useState(true)
    const [showStyleOptions, setShowStyleOptions] = useState(false)
    const [isProcessing, setIsProcessing] = useState(false)
    const [currentIndex, setCurrentIndex] = useState(0)
    const [progress, setProgress] = useState(0)
    const [error, setError] = useState<string | null>(null)
    const [airtableStatus, setAirtableStatus] = useState<AirtableStatus>({})
    const [airtableConfigured, setAirtableConfigured] = useState<boolean | null>(null)
    const [modalImage, setModalImage] = useState<{ svg: string; spaceId: string; view: string } | null>(null)
    const [showConfirmation, setShowConfirmation] = useState(false)
    const [pendingAction, setPendingAction] = useState<'download' | 'upload' | null>(null)

    // Refs
    const listContainerRef = useRef<HTMLDivElement>(null)

    // SVG render options
    const [options, setOptions] = useState<SpaceSVGRenderOptions>({
        width: 800,
        height: 600,
        margin: 1.0,
        showArea: true,
        showDimensions: true,
        showDoors: true,
        showWindows: true,
        showRoomLabel: true,
        showGrid: false,
        backgroundColor: '#f5f5f5',
        floorColor: '#ffffff',
        wallColor: '#333333',
        doorColor: '#0066cc',
        windowColor: '#66ccff',
        lineWidth: 2,
        fontSize: 14,
        fontFamily: 'Arial, sans-serif',
    })

    // Extract unique storeys, types, and functions
    const availableStoreys = useMemo(() => {
        const storeys = new Map<string, number>()
        spaceContexts.forEach(space => {
            if (space.storeyName) {
                storeys.set(space.storeyName, (storeys.get(space.storeyName) || 0) + 1)
            }
        })
        return Array.from(storeys.entries()).sort((a, b) => a[0].localeCompare(b[0]))
    }, [spaceContexts])

    const availableTypes = useMemo(() => {
        const types = new Map<string, number>()
        spaceContexts.forEach(space => {
            if (space.spaceType) {
                types.set(space.spaceType, (types.get(space.spaceType) || 0) + 1)
            }
        })
        return Array.from(types.entries()).sort((a, b) => a[0].localeCompare(b[0]))
    }, [spaceContexts])

    const availableFunctions = useMemo(() => {
        const functions = new Map<string, number>()
        spaceContexts.forEach(space => {
            if (space.spaceFunction) {
                functions.set(space.spaceFunction, (functions.get(space.spaceFunction) || 0) + 1)
            }
        })
        return Array.from(functions.entries()).sort((a, b) => a[0].localeCompare(b[0]))
    }, [spaceContexts])

    // Apply filters
    const filteredSpaces = useMemo(() => {
        let result = spaceContexts

        // Apply filter function
        result = filterSpaces(result, {
            spaceTypes: Array.from(selectedTypes),
            storeys: Array.from(selectedStoreys),
            functions: Array.from(selectedFunctions),
        })

        // Apply search query
        if (searchQuery.trim()) {
            const query = searchQuery.toLowerCase()
            result = result.filter(space =>
                space.spaceId.toLowerCase().includes(query) ||
                (space.spaceName?.toLowerCase().includes(query)) ||
                (space.spaceType?.toLowerCase().includes(query)) ||
                (space.storeyName?.toLowerCase().includes(query))
            )
        }

        return result
    }, [spaceContexts, selectedTypes, selectedStoreys, selectedFunctions, searchQuery])

    // Spaces to process (selected or filtered)
    const spacesToProcess = useMemo(() => {
        if (selectedSpaceIds.size > 0) {
            return filteredSpaces.filter(s => selectedSpaceIds.has(s.spaceId))
        }
        return filteredSpaces
    }, [filteredSpaces, selectedSpaceIds])

    // Check Airtable configuration
    useEffect(() => {
        fetch('/api/airtable')
            .then(res => res.json())
            .then(data => setAirtableConfigured(data.configured))
            .catch(() => setAirtableConfigured(false))
    }, [])

    // Sync filtered spaces with 3D view
    useEffect(() => {
        if (!visibilityManager) return

        if (isolateFiltered && filteredSpaces.length > 0) {
            const spaceExpressIds = filteredSpaces.map(s => s.space.expressID)
            visibilityManager.isolateElements(spaceExpressIds)
        } else {
            visibilityManager.resetAllVisibility()
        }
    }, [filteredSpaces, isolateFiltered, visibilityManager])

    // Handle hover - highlight in 3D
    const handleSpaceHover = useCallback((spaceId: string | null) => {
        setHoveredSpaceId(spaceId)

        if (!visibilityManager) return

        if (spaceId === null) {
            visibilityManager.setHoveredElement(null)
        } else {
            const space = spaceContexts.find(s => s.spaceId === spaceId)
            if (space) {
                visibilityManager.setHoveredElement(space.space.expressID)
            }
        }
    }, [spaceContexts, visibilityManager])

    // Handle space click - zoom to space
    const handleSpaceClick = useCallback((space: SpaceContext) => {
        if (!navigationManager || !space.space.boundingBox) return

        // Highlight the selected space in 3D
        if (visibilityManager) {
            visibilityManager.setSelectedElements([space.space.expressID])
        }

        // Zoom to space from above (plan view)
        const bbox = space.space.boundingBox
        const center = bbox.getCenter(new THREE.Vector3())
        const size = bbox.getSize(new THREE.Vector3())
        const distance = Math.max(size.x, size.y, size.z) * 2

        navigationManager.focusOn(center, distance)
    }, [navigationManager, visibilityManager])

    // Toggle space selection
    const toggleSpaceSelection = useCallback((spaceId: string) => {
        setSelectedSpaceIds(prev => {
            const next = new Set(prev)
            if (next.has(spaceId)) {
                next.delete(spaceId)
            } else {
                next.add(spaceId)
            }
            return next
        })
    }, [])

    // Select all filtered spaces
    const selectAllFiltered = useCallback(() => {
        setSelectedSpaceIds(new Set(filteredSpaces.map(s => s.spaceId)))
    }, [filteredSpaces])

    // Clear selection
    const clearSelection = useCallback(() => {
        setSelectedSpaceIds(new Set())
    }, [])

    // Clear all filters
    const clearFilters = useCallback(() => {
        setSearchQuery('')
        setSelectedStoreys(new Set())
        setSelectedTypes(new Set())
        setSelectedFunctions(new Set())
    }, [])

    // Toggle filter helpers
    const toggleStorey = useCallback((storey: string) => {
        setSelectedStoreys(prev => {
            const next = new Set(prev)
            if (next.has(storey)) next.delete(storey)
            else next.add(storey)
            return next
        })
    }, [])

    const toggleType = useCallback((type: string) => {
        setSelectedTypes(prev => {
            const next = new Set(prev)
            if (next.has(type)) next.delete(type)
            else next.add(type)
            return next
        })
    }, [])

    const toggleFunction = useCallback((func: string) => {
        setSelectedFunctions(prev => {
            const next = new Set(prev)
            if (next.has(func)) next.delete(func)
            else next.add(func)
            return next
        })
    }, [])

    // Show single space preview
    const showSingleSpace = useCallback(async (context: SpaceContext) => {
        try {
            let elementsInSpace: Map<string, any[]> | undefined
            if (modelMetadata) {
                elementsInSpace = getElementsInSpace(
                    context,
                    modelMetadata.elements,
                    modelMetadata.api,
                    modelMetadata.modelID,
                    modelMetadata.lengthUnitScale,
                    modelMetadata.isYUp
                )
            }
            const svg = renderSpaceFloorPlan(context, options, elementsInSpace, modelMetadata?.lengthUnitScale || 1)
            setModalImage({ svg, spaceId: context.spaceId, view: 'Floor Plan' })
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to render SVG')
        }
    }, [options, modelMetadata])

    // Download ZIP
    const performDownload = useCallback(async () => {
        if (spacesToProcess.length === 0) {
            setError('No spaces selected')
            return
        }

        setIsProcessing(true)
        setCurrentIndex(0)
        setProgress(0)
        setError(null)
        setShowConfirmation(false)

        const zip = new JSZip()
        const total = spacesToProcess.length

        try {
            for (let i = 0; i < spacesToProcess.length; i++) {
                const context = spacesToProcess[i]
                setCurrentIndex(i + 1)

                try {
                    let elementsInSpace: Map<string, any[]> | undefined
                    if (modelMetadata) {
                        elementsInSpace = getElementsInSpace(
                            context,
                            modelMetadata.elements,
                            modelMetadata.api,
                            modelMetadata.modelID,
                            modelMetadata.lengthUnitScale,
                            modelMetadata.isYUp
                        )
                    }
                    const floorPlan = renderSpaceFloorPlan(context, options, elementsInSpace, modelMetadata?.lengthUnitScale || 1)
                    const safeName = context.spaceName.replace(/[^a-zA-Z0-9-_]/g, '_')
                    zip.file(`${safeName}_${context.spaceId}_floor_plan.svg`, floorPlan)
                    setProgress(((i + 1) / total) * 100)
                } catch (err) {
                    console.error(`Error processing space ${context.spaceId}:`, err)
                }
            }

            const blob = await zip.generateAsync({ type: 'blob' })
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = `space_floor_plans_${new Date().toISOString().split('T')[0]}.zip`
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            URL.revokeObjectURL(url)

            setIsProcessing(false)
            if (onComplete) onComplete()
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to process spaces')
            setIsProcessing(false)
        } finally {
            setPendingAction(null)
        }
    }, [spacesToProcess, options, modelMetadata, onComplete])

    // Upload to Airtable
    const performUpload = useCallback(async () => {
        if (spacesToProcess.length === 0) return

        setIsProcessing(true)
        setCurrentIndex(0)
        setProgress(0)
        setError(null)
        setShowConfirmation(false)

        const newStatus: AirtableStatus = {}
        spacesToProcess.forEach(s => { newStatus[s.spaceId] = 'idle' })
        setAirtableStatus(newStatus)

        const CONCURRENCY = 3
        const total = spacesToProcess.length
        let failed = 0

        const processSpace = async (space: SpaceContext, index: number) => {
            setAirtableStatus(prev => ({ ...prev, [space.spaceId]: 'sending' }))

            try {
                let elementsInSpace: Map<string, any[]> | undefined
                if (modelMetadata) {
                    elementsInSpace = getElementsInSpace(
                        space,
                        modelMetadata.elements,
                        modelMetadata.api,
                        modelMetadata.modelID,
                        modelMetadata.lengthUnitScale,
                        modelMetadata.isYUp
                    )
                }
                const floorPlan = renderSpaceFloorPlan(space, options, elementsInSpace, modelMetadata?.lengthUnitScale || 1)
                const svgToDataUrl = (svg: string) =>
                    `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`

                const response = await fetch('/api/airtable', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        spaceId: space.spaceId,
                        spaceName: space.spaceName || undefined,
                        spaceType: space.spaceType || undefined,
                        spaceFunction: space.spaceFunction || undefined,
                        storeyName: space.storeyName || undefined,
                        grossFloorArea: space.space.grossFloorArea || undefined,
                        height: space.ceilingHeight || undefined,
                        width: space.space.boundingBox2D?.width || undefined,
                        depth: space.space.boundingBox2D?.depth || undefined,
                        doorCount: space.boundaryDoors.length || undefined,
                        windowCount: space.boundaryWindows.length || undefined,
                        modelSource: modelSource || undefined,
                        floorPlanView: svgToDataUrl(floorPlan),
                    }),
                })

                if (!response.ok) throw new Error('API Error')
                setAirtableStatus(prev => ({ ...prev, [space.spaceId]: 'success' }))
                return true
            } catch (err) {
                setAirtableStatus(prev => ({ ...prev, [space.spaceId]: 'error' }))
                failed++
                return false
            } finally {
                setCurrentIndex(prev => prev + 1)
                setProgress(((index + 1) / total) * 100)
            }
        }

        try {
            for (let i = 0; i < spacesToProcess.length; i += CONCURRENCY) {
                const batch = spacesToProcess.slice(i, i + CONCURRENCY)
                await Promise.all(batch.map((space, j) => processSpace(space, i + j)))
            }

            if (onComplete) onComplete()
            if (failed > 0) {
                setError(`Completed with ${failed} errors.`)
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Batch upload failed')
        } finally {
            setIsProcessing(false)
            setPendingAction(null)
        }
    }, [spacesToProcess, options, modelSource, modelMetadata, onComplete])

    const initiateAction = (action: 'download' | 'upload') => {
        if (spacesToProcess.length > 10) {
            setPendingAction(action)
            setShowConfirmation(true)
        } else {
            if (action === 'download') performDownload()
            else performUpload()
        }
    }

    const confirmAction = () => {
        if (pendingAction === 'download') performDownload()
        else if (pendingAction === 'upload') performUpload()
    }

    const closeModal = () => setModalImage(null)

    const downloadFromModal = () => {
        if (!modalImage) return
        const blob = new Blob([modalImage.svg], { type: 'image/svg+xml' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${modalImage.spaceId}_floor_plan.svg`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
    }

    // Escape key handlers
    useEffect(() => {
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                if (modalImage) setModalImage(null)
                else if (showConfirmation) setShowConfirmation(false)
            }
        }
        window.addEventListener('keydown', handleEscape)
        return () => window.removeEventListener('keydown', handleEscape)
    }, [modalImage, showConfirmation])

    const hasActiveFilters = selectedStoreys.size > 0 || selectedTypes.size > 0 || selectedFunctions.size > 0 || searchQuery.trim().length > 0

    // Format area for display
    const formatArea = (area: number | undefined) => {
        if (area === undefined) return null
        return `${area.toFixed(1)} m²`
    }

    return (
        <div className="space-panel">
            {/* Header */}
            <div className="panel-header">
                <div className="header-title">
                    <h2>Spaces</h2>
                    <span className="space-count-badge">{filteredSpaces.length}</span>
                </div>
                <div className="header-actions">
                    <button
                        className={`icon-button ${isolateFiltered ? 'active' : ''}`}
                        onClick={() => setIsolateFiltered(!isolateFiltered)}
                        title={isolateFiltered ? 'Show all elements' : 'Isolate spaces in 3D'}
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <circle cx="12" cy="12" r="10" />
                            <circle cx="12" cy="12" r="4" />
                        </svg>
                    </button>
                    <button
                        className={`icon-button ${showFilters ? 'active' : ''}`}
                        onClick={() => setShowFilters(!showFilters)}
                        title="Toggle filters"
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
                        </svg>
                        {hasActiveFilters && <span className="filter-badge" />}
                    </button>
                </div>
            </div>

            {/* Filter Section */}
            {showFilters && (
                <div className="filter-section">
                    {/* Search */}
                    <div className="search-container">
                        <svg className="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <circle cx="11" cy="11" r="8" />
                            <line x1="21" y1="21" x2="16.65" y2="16.65" />
                        </svg>
                        <input
                            type="text"
                            placeholder="Search spaces..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="search-input"
                        />
                        {searchQuery && (
                            <button className="clear-search" onClick={() => setSearchQuery('')}>×</button>
                        )}
                    </div>

                    {/* Storey Filter */}
                    {availableStoreys.length > 0 && (
                        <div className="filter-group">
                            <div className="filter-label collapsible" onClick={() => setStoreyExpanded(!storeyExpanded)}>
                                <span style={{ marginRight: '6px' }}>{storeyExpanded ? '▼' : '▶'}</span>
                                Storey
                            </div>
                            {storeyExpanded && (
                                <div className="filter-chips">
                                    {availableStoreys.map(([storey, count]) => (
                                        <button
                                            key={storey}
                                            className={`filter-chip ${selectedStoreys.has(storey) ? 'active' : ''}`}
                                            onClick={() => toggleStorey(storey)}
                                        >
                                            {storey}
                                            <span className="chip-count">{count}</span>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Type Filter */}
                    {availableTypes.length > 0 && (
                        <div className="filter-group">
                            <div className="filter-label collapsible" onClick={() => setTypeExpanded(!typeExpanded)}>
                                <span style={{ marginRight: '6px' }}>{typeExpanded ? '▼' : '▶'}</span>
                                Type
                            </div>
                            {typeExpanded && (
                                <div className="filter-chips">
                                    {availableTypes.map(([type, count]) => (
                                        <button
                                            key={type}
                                            className={`filter-chip ${selectedTypes.has(type) ? 'active' : ''}`}
                                            onClick={() => toggleType(type)}
                                        >
                                            {type}
                                            <span className="chip-count">{count}</span>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Function Filter */}
                    {availableFunctions.length > 0 && (
                        <div className="filter-group">
                            <div className="filter-label collapsible" onClick={() => setFunctionExpanded(!functionExpanded)}>
                                <span style={{ marginRight: '6px' }}>{functionExpanded ? '▼' : '▶'}</span>
                                Function
                            </div>
                            {functionExpanded && (
                                <div className="filter-chips">
                                    {availableFunctions.map(([func, count]) => (
                                        <button
                                            key={func}
                                            className={`filter-chip ${selectedFunctions.has(func) ? 'active' : ''}`}
                                            onClick={() => toggleFunction(func)}
                                        >
                                            {func}
                                            <span className="chip-count">{count}</span>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Clear Filters */}
                    {hasActiveFilters && (
                        <button className="clear-filters" onClick={clearFilters}>
                            Clear all filters
                        </button>
                    )}
                </div>
            )}

            {/* Selection Controls */}
            <div className="selection-controls">
                <div className="selection-info">
                    {selectedSpaceIds.size > 0 ? (
                        <span>{selectedSpaceIds.size} selected</span>
                    ) : (
                        <span>{filteredSpaces.length} spaces</span>
                    )}
                </div>
                <div className="selection-actions">
                    <button className="text-button" onClick={selectAllFiltered}>Select all</button>
                    {selectedSpaceIds.size > 0 && (
                        <button className="text-button" onClick={clearSelection}>Clear</button>
                    )}
                </div>
            </div>

            {/* Space List */}
            <div className="space-list" ref={listContainerRef}>
                {filteredSpaces.length === 0 ? (
                    <div className="empty-state">
                        <p>No spaces match your filters</p>
                        {hasActiveFilters && (
                            <button className="text-button" onClick={clearFilters}>Clear filters</button>
                        )}
                    </div>
                ) : (
                    filteredSpaces.slice(0, 100).map((space) => (
                        <div
                            key={space.spaceId}
                            className={`space-item ${selectedSpaceIds.has(space.spaceId) ? 'selected' : ''} ${hoveredSpaceId === space.spaceId ? 'hovered' : ''}`}
                            onMouseEnter={() => handleSpaceHover(space.spaceId)}
                            onMouseLeave={() => handleSpaceHover(null)}
                        >
                            <label className="space-checkbox">
                                <input
                                    type="checkbox"
                                    checked={selectedSpaceIds.has(space.spaceId)}
                                    onChange={() => toggleSpaceSelection(space.spaceId)}
                                />
                                <span className="checkmark" />
                            </label>

                            <div className="space-info" onClick={() => handleSpaceClick(space)}>
                                <div className="space-name">{space.spaceName}</div>
                                <div className="space-meta">
                                    {space.space.grossFloorArea && (
                                        <span className="meta-badge area">{formatArea(space.space.grossFloorArea)}</span>
                                    )}
                                    {space.storeyName && (
                                        <span className="meta-badge storey">{space.storeyName}</span>
                                    )}
                                    {space.spaceFunction && (
                                        <span className="meta-badge function">{space.spaceFunction}</span>
                                    )}
                                </div>
                                <div className="space-counts">
                                    {space.boundaryDoors.length > 0 && (
                                        <span className="count-badge">{space.boundaryDoors.length} doors</span>
                                    )}
                                    {space.boundaryWindows.length > 0 && (
                                        <span className="count-badge">{space.boundaryWindows.length} windows</span>
                                    )}
                                </div>
                            </div>

                            <div className="space-actions">
                                <button
                                    className="action-button"
                                    onClick={() => handleSpaceClick(space)}
                                    title="Zoom to space"
                                >
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                        <circle cx="12" cy="12" r="10" />
                                        <line x1="12" y1="8" x2="12" y2="16" />
                                        <line x1="8" y1="12" x2="16" y2="12" />
                                    </svg>
                                </button>
                                <button
                                    className="action-button"
                                    onClick={() => showSingleSpace(space)}
                                    title="Floor plan"
                                >
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                        <rect x="3" y="3" width="18" height="18" rx="2" />
                                        <line x1="3" y1="12" x2="21" y2="12" />
                                        <line x1="12" y1="3" x2="12" y2="21" />
                                    </svg>
                                </button>
                            </div>
                        </div>
                    ))
                )}
                {filteredSpaces.length > 100 && (
                    <div className="more-items">+{filteredSpaces.length - 100} more spaces</div>
                )}
            </div>

            {/* Export Section */}
            <div className="export-section">
                {/* Style Options Toggle */}
                <button className="section-toggle" onClick={() => setShowStyleOptions(!showStyleOptions)}>
                    <span>Style Options</span>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                        style={{ transform: showStyleOptions ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>
                        <polyline points="6 9 12 15 18 9" />
                    </svg>
                </button>

                {showStyleOptions && (
                    <div className="style-options">
                        <div className="option-row">
                            <label>Floor</label>
                            <input type="color" value={options.floorColor || '#ffffff'} onChange={(e) => setOptions({ ...options, floorColor: e.target.value })} />
                        </div>
                        <div className="option-row">
                            <label>Wall</label>
                            <input type="color" value={options.wallColor || '#333333'} onChange={(e) => setOptions({ ...options, wallColor: e.target.value })} />
                        </div>
                        <div className="option-row">
                            <label>Door</label>
                            <input type="color" value={options.doorColor || '#0066cc'} onChange={(e) => setOptions({ ...options, doorColor: e.target.value })} />
                        </div>
                        <div className="option-row">
                            <label>Window</label>
                            <input type="color" value={options.windowColor || '#66ccff'} onChange={(e) => setOptions({ ...options, windowColor: e.target.value })} />
                        </div>
                        <div className="option-row checkbox">
                            <label>
                                <input type="checkbox" checked={options.showArea} onChange={(e) => setOptions({ ...options, showArea: e.target.checked })} />
                                Show Area
                            </label>
                        </div>
                        <div className="option-row checkbox">
                            <label>
                                <input type="checkbox" checked={options.showDimensions} onChange={(e) => setOptions({ ...options, showDimensions: e.target.checked })} />
                                Show Dimensions
                            </label>
                        </div>
                        <div className="option-row checkbox">
                            <label>
                                <input type="checkbox" checked={options.showDoors} onChange={(e) => setOptions({ ...options, showDoors: e.target.checked })} />
                                Show Doors
                            </label>
                        </div>
                        <div className="option-row checkbox">
                            <label>
                                <input type="checkbox" checked={options.showWindows} onChange={(e) => setOptions({ ...options, showWindows: e.target.checked })} />
                                Show Windows
                            </label>
                        </div>
                    </div>
                )}

                {/* Progress */}
                {isProcessing && (
                    <div className="progress-container">
                        <div className="progress-bar">
                            <div className="progress-fill" style={{ width: `${progress}%` }} />
                        </div>
                        <div className="progress-text">Processing {currentIndex}/{spacesToProcess.length}...</div>
                    </div>
                )}

                {/* Error */}
                {error && <div className="error-message">{error}</div>}

                {/* Export Buttons */}
                <div className="export-buttons">
                    <button
                        className="export-button primary"
                        onClick={() => initiateAction('download')}
                        disabled={isProcessing || spacesToProcess.length === 0}
                    >
                        {isProcessing && pendingAction === 'download' ? 'Processing...' : `Download ZIP (${spacesToProcess.length})`}
                    </button>

                    {airtableConfigured && (
                        <button
                            className="export-button airtable"
                            onClick={() => initiateAction('upload')}
                            disabled={isProcessing || spacesToProcess.length === 0}
                        >
                            {isProcessing && pendingAction === 'upload' ? 'Uploading...' : `Airtable (${spacesToProcess.length})`}
                        </button>
                    )}
                </div>
            </div>

            {/* Confirmation Modal */}
            {showConfirmation && (
                <div className="modal-overlay" onClick={() => setShowConfirmation(false)}>
                    <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                        <h3>Process {spacesToProcess.length} spaces?</h3>
                        <p>This will generate {spacesToProcess.length} SVG floor plans.</p>
                        <div className="modal-actions">
                            <button className="cancel-button" onClick={() => setShowConfirmation(false)}>Cancel</button>
                            <button className="confirm-button" onClick={confirmAction}>Proceed</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Image Preview Modal */}
            {modalImage && (
                <div className="modal-overlay" onClick={closeModal}>
                    <div className="image-modal" onClick={(e) => e.stopPropagation()}>
                        <div className="image-modal-header">
                            <h3>{modalImage.spaceId} - {modalImage.view}</h3>
                            <button className="close-button" onClick={closeModal}>×</button>
                        </div>
                        <div className="image-modal-body">
                            <div dangerouslySetInnerHTML={{ __html: modalImage.svg }} />
                        </div>
                        <div className="image-modal-footer">
                            <button className="download-button" onClick={downloadFromModal}>Download</button>
                            <button className="close-button-secondary" onClick={closeModal}>Close</button>
                        </div>
                    </div>
                </div>
            )}

            <style jsx>{`
                .space-panel {
                    display: flex;
                    flex-direction: column;
                    height: 100%;
                    background: #2a2a2a;
                    color: #fff;
                    font-size: 13px;
                }
                .panel-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 12px 16px;
                    border-bottom: 1px solid #444;
                    background: #333;
                }
                .header-title {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                .header-title h2 {
                    margin: 0;
                    font-size: 16px;
                    font-weight: 600;
                }
                .space-count-badge {
                    background: #10b981;
                    color: #1a1a1a;
                    padding: 2px 8px;
                    border-radius: 12px;
                    font-size: 12px;
                    font-weight: 600;
                }
                .header-actions {
                    display: flex;
                    gap: 4px;
                }
                .icon-button {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    width: 32px;
                    height: 32px;
                    background: transparent;
                    border: 1px solid #555;
                    border-radius: 6px;
                    color: #aaa;
                    cursor: pointer;
                    transition: all 0.2s;
                    position: relative;
                }
                .icon-button:hover {
                    background: #444;
                    color: #fff;
                }
                .icon-button.active {
                    background: #10b981;
                    border-color: #10b981;
                    color: #1a1a1a;
                }
                .filter-badge {
                    position: absolute;
                    top: -2px;
                    right: -2px;
                    width: 8px;
                    height: 8px;
                    background: #f59e0b;
                    border-radius: 50%;
                }
                .filter-section {
                    padding: 12px 16px;
                    border-bottom: 1px solid #444;
                    display: flex;
                    flex-direction: column;
                    gap: 12px;
                }
                .search-container {
                    position: relative;
                }
                .search-icon {
                    position: absolute;
                    left: 10px;
                    top: 50%;
                    transform: translateY(-50%);
                    color: #666;
                }
                .search-input {
                    width: 100%;
                    padding: 8px 32px;
                    background: #1a1a1a;
                    border: 1px solid #444;
                    border-radius: 6px;
                    color: #fff;
                    font-size: 13px;
                }
                .search-input:focus {
                    outline: none;
                    border-color: #10b981;
                }
                .clear-search {
                    position: absolute;
                    right: 8px;
                    top: 50%;
                    transform: translateY(-50%);
                    background: none;
                    border: none;
                    color: #666;
                    cursor: pointer;
                    font-size: 16px;
                }
                .filter-group {
                    display: flex;
                    flex-direction: column;
                    gap: 6px;
                }
                .filter-label {
                    font-size: 11px;
                    text-transform: uppercase;
                    color: #888;
                    letter-spacing: 0.5px;
                    cursor: pointer;
                    user-select: none;
                }
                .filter-label.collapsible {
                    display: flex;
                    align-items: center;
                    transition: color 0.2s ease;
                }
                .filter-label.collapsible:hover {
                    color: #aaa;
                }
                .filter-chips {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 6px;
                }
                .filter-chip {
                    display: flex;
                    align-items: center;
                    gap: 4px;
                    padding: 4px 10px;
                    background: #1a1a1a;
                    border: 1px solid #444;
                    border-radius: 16px;
                    color: #ccc;
                    font-size: 12px;
                    cursor: pointer;
                    transition: all 0.2s;
                }
                .filter-chip:hover {
                    border-color: #666;
                }
                .filter-chip.active {
                    background: #10b981;
                    border-color: #10b981;
                    color: #1a1a1a;
                }
                .chip-count {
                    font-size: 10px;
                    opacity: 0.7;
                }
                .clear-filters {
                    background: none;
                    border: none;
                    color: #10b981;
                    font-size: 12px;
                    cursor: pointer;
                    align-self: flex-start;
                    padding: 0;
                }
                .selection-controls {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 8px 16px;
                    background: #1a1a1a;
                    font-size: 12px;
                }
                .selection-info {
                    color: #888;
                }
                .selection-actions {
                    display: flex;
                    gap: 12px;
                }
                .text-button {
                    background: none;
                    border: none;
                    color: #10b981;
                    font-size: 12px;
                    cursor: pointer;
                    padding: 0;
                }
                .text-button:hover {
                    text-decoration: underline;
                }
                .space-list {
                    flex: 1;
                    overflow-y: auto;
                    padding: 8px;
                }
                .empty-state {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    padding: 32px;
                    color: #666;
                    gap: 12px;
                }
                .space-item {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    padding: 8px 10px;
                    margin-bottom: 4px;
                    background: #333;
                    border-radius: 6px;
                    border: 1px solid transparent;
                    transition: all 0.15s;
                }
                .space-item:hover, .space-item.hovered {
                    background: #3a3a3a;
                    border-color: #10b981;
                }
                .space-item.selected {
                    background: rgba(16, 185, 129, 0.1);
                    border-color: #10b981;
                }
                .space-checkbox {
                    position: relative;
                    display: flex;
                    align-items: center;
                }
                .space-checkbox input {
                    width: 16px;
                    height: 16px;
                    opacity: 0;
                    position: absolute;
                }
                .space-checkbox .checkmark {
                    width: 16px;
                    height: 16px;
                    border: 1px solid #555;
                    border-radius: 3px;
                    background: #1a1a1a;
                }
                .space-checkbox input:checked + .checkmark {
                    background: #10b981;
                    border-color: #10b981;
                }
                .space-checkbox input:checked + .checkmark::after {
                    content: '';
                    position: absolute;
                    left: 5px;
                    top: 1px;
                    width: 4px;
                    height: 8px;
                    border: solid #1a1a1a;
                    border-width: 0 2px 2px 0;
                    transform: rotate(45deg);
                }
                .space-info {
                    flex: 1;
                    min-width: 0;
                    cursor: pointer;
                }
                .space-name {
                    font-weight: 500;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    font-size: 12px;
                }
                .space-meta {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 4px;
                    margin-top: 4px;
                }
                .meta-badge {
                    font-size: 10px;
                    padding: 2px 6px;
                    border-radius: 3px;
                    white-space: nowrap;
                }
                .meta-badge.area {
                    background: rgba(16, 185, 129, 0.2);
                    color: #34d399;
                }
                .meta-badge.storey {
                    background: rgba(168, 85, 247, 0.2);
                    color: #c084fc;
                }
                .meta-badge.function {
                    background: rgba(59, 130, 246, 0.2);
                    color: #60a5fa;
                }
                .space-counts {
                    display: flex;
                    gap: 8px;
                    margin-top: 2px;
                }
                .count-badge {
                    font-size: 10px;
                    color: #888;
                }
                .space-actions {
                    display: flex;
                    gap: 4px;
                    opacity: 0;
                    transition: opacity 0.2s;
                }
                .space-item:hover .space-actions {
                    opacity: 1;
                }
                .action-button {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    width: 24px;
                    height: 24px;
                    background: #444;
                    border: none;
                    border-radius: 4px;
                    color: #aaa;
                    cursor: pointer;
                }
                .action-button:hover {
                    background: #555;
                    color: #fff;
                }
                .more-items {
                    text-align: center;
                    padding: 12px;
                    color: #666;
                    font-size: 12px;
                }
                .export-section {
                    border-top: 1px solid #444;
                    padding: 12px 16px;
                    background: #333;
                }
                .section-toggle {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    width: 100%;
                    padding: 8px 0;
                    background: none;
                    border: none;
                    color: #aaa;
                    font-size: 12px;
                    cursor: pointer;
                }
                .section-toggle:hover {
                    color: #fff;
                }
                .style-options {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 8px;
                    padding: 12px 0;
                }
                .option-row {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                .option-row label {
                    font-size: 11px;
                    color: #888;
                    min-width: 50px;
                }
                .option-row input[type="color"] {
                    width: 32px;
                    height: 24px;
                    border: 1px solid #444;
                    border-radius: 4px;
                    cursor: pointer;
                }
                .option-row.checkbox {
                    grid-column: span 2;
                }
                .option-row.checkbox label {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    min-width: auto;
                }
                .progress-container {
                    margin: 12px 0;
                }
                .progress-bar {
                    width: 100%;
                    height: 4px;
                    background: #1a1a1a;
                    border-radius: 2px;
                    overflow: hidden;
                }
                .progress-fill {
                    height: 100%;
                    background: #10b981;
                    transition: width 0.2s;
                }
                .progress-text {
                    font-size: 11px;
                    color: #888;
                    margin-top: 4px;
                    text-align: center;
                }
                .error-message {
                    color: #ef4444;
                    font-size: 12px;
                    padding: 8px;
                    background: rgba(239, 68, 68, 0.1);
                    border-radius: 4px;
                    margin: 8px 0;
                }
                .export-buttons {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                    margin-top: 12px;
                }
                .export-button {
                    padding: 10px 16px;
                    border: none;
                    border-radius: 6px;
                    font-size: 13px;
                    font-weight: 500;
                    cursor: pointer;
                    transition: all 0.2s;
                }
                .export-button:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                }
                .export-button.primary {
                    background: #3b82f6;
                    color: #fff;
                }
                .export-button.primary:hover:not(:disabled) {
                    background: #2563eb;
                }
                .export-button.airtable {
                    background: #18bfff;
                    color: #fff;
                }
                .export-button.airtable:hover:not(:disabled) {
                    background: #0da8e6;
                }
                .modal-overlay {
                    position: fixed;
                    inset: 0;
                    background: rgba(0, 0, 0, 0.75);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 9999;
                }
                .modal-content {
                    background: #333;
                    padding: 24px;
                    border-radius: 12px;
                    max-width: 400px;
                    text-align: center;
                }
                .modal-content h3 {
                    margin: 0 0 12px;
                }
                .modal-content p {
                    color: #888;
                    margin: 0 0 20px;
                }
                .modal-actions {
                    display: flex;
                    gap: 12px;
                    justify-content: center;
                }
                .cancel-button, .confirm-button {
                    padding: 10px 20px;
                    border: none;
                    border-radius: 6px;
                    font-size: 14px;
                    cursor: pointer;
                }
                .cancel-button {
                    background: #555;
                    color: #fff;
                }
                .confirm-button {
                    background: #3b82f6;
                    color: #fff;
                }
                .image-modal {
                    background: #1a1a1a;
                    border-radius: 12px;
                    max-width: 90vw;
                    max-height: 90vh;
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                }
                .image-modal-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 16px 20px;
                    border-bottom: 1px solid #333;
                }
                .image-modal-header h3 {
                    margin: 0;
                    font-size: 16px;
                }
                .image-modal-body {
                    flex: 1;
                    overflow: auto;
                    padding: 20px;
                    background: #fff;
                }
                .image-modal-body :global(svg) {
                    display: block;
                    max-width: 100%;
                    height: auto;
                }
                .image-modal-footer {
                    display: flex;
                    gap: 12px;
                    justify-content: flex-end;
                    padding: 16px 20px;
                    border-top: 1px solid #333;
                }
                .download-button {
                    padding: 8px 16px;
                    background: #3b82f6;
                    color: #fff;
                    border: none;
                    border-radius: 6px;
                    cursor: pointer;
                }
                .close-button {
                    background: none;
                    border: none;
                    color: #888;
                    font-size: 24px;
                    cursor: pointer;
                }
                .close-button:hover {
                    color: #fff;
                }
                .close-button-secondary {
                    padding: 8px 16px;
                    background: #444;
                    color: #fff;
                    border: none;
                    border-radius: 6px;
                    cursor: pointer;
                }
            `}</style>
        </div>
    )
}

// Need THREE for Vector3
import * as THREE from 'three'
