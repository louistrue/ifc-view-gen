'use client'

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import type { DoorContext } from '@/lib/door-analyzer'
import { filterDoors } from '@/lib/door-analyzer'
import type { ElementVisibilityManager } from '@/lib/element-visibility-manager'
import type { NavigationManager } from '@/lib/navigation-manager'
import JSZip from 'jszip'
import { renderDoorViews, renderDoorElevationSVG, renderDoorPlanSVG } from '@/lib/svg-renderer'
import type { SVGRenderOptions } from '@/lib/svg-renderer'

interface DoorPanelProps {
  doorContexts: DoorContext[]
  visibilityManager: ElementVisibilityManager | null
  navigationManager: NavigationManager | null
  modelSource?: string
  onComplete?: () => void
}

interface AirtableStatus {
  [doorId: string]: 'idle' | 'sending' | 'success' | 'error'
}

export default function DoorPanel({
  doorContexts,
  visibilityManager,
  navigationManager,
  modelSource,
  onComplete,
}: DoorPanelProps) {
  // Filter state
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedStoreys, setSelectedStoreys] = useState<Set<string>>(new Set())
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set())
  const [isolateFiltered, setIsolateFiltered] = useState(false)

  // Selection state
  const [selectedDoorIds, setSelectedDoorIds] = useState<Set<string>>(new Set())
  const [hoveredDoorId, setHoveredDoorId] = useState<string | null>(null)

  // UI state
  const [showFilters, setShowFilters] = useState(true)
  const [showStyleOptions, setShowStyleOptions] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [airtableStatus, setAirtableStatus] = useState<AirtableStatus>({})
  const [airtableConfigured, setAirtableConfigured] = useState<boolean | null>(null)
  const [modalImage, setModalImage] = useState<{ svg: string; doorId: string; view: string } | null>(null)
  const [showConfirmation, setShowConfirmation] = useState(false)
  const [pendingAction, setPendingAction] = useState<'download' | 'upload' | null>(null)

  // Refs
  const listContainerRef = useRef<HTMLDivElement>(null)

  // SVG render options
  const [options, setOptions] = useState<SVGRenderOptions>({
    width: 1000,
    height: 1000,
    margin: 0.5,
    doorColor: '#333333',
    wallColor: '#888888',
    deviceColor: '#CC0000',
    lineWidth: 1.5,
    lineColor: '#000000',
    showFills: true,
    showLegend: true,
    showLabels: true,
    fontSize: 14,
    fontFamily: 'Arial',
  })

  // Extract unique storeys and types
  const availableStoreys = useMemo(() => {
    const storeys = new Map<string, number>()
    doorContexts.forEach(door => {
      if (door.storeyName) {
        storeys.set(door.storeyName, (storeys.get(door.storeyName) || 0) + 1)
      }
    })
    return Array.from(storeys.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [doorContexts])

  const availableTypes = useMemo(() => {
    const types = new Map<string, number>()
    doorContexts.forEach(door => {
      if (door.doorTypeName) {
        types.set(door.doorTypeName, (types.get(door.doorTypeName) || 0) + 1)
      }
    })
    return Array.from(types.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [doorContexts])

  // Apply filters
  const filteredDoors = useMemo(() => {
    let result = doorContexts

    // Apply filter function
    result = filterDoors(result, {
      doorTypes: Array.from(selectedTypes),
      storeys: Array.from(selectedStoreys),
    })

    // Apply search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase()
      result = result.filter(door =>
        door.doorId.toLowerCase().includes(query) ||
        (door.doorTypeName?.toLowerCase().includes(query)) ||
        (door.storeyName?.toLowerCase().includes(query))
      )
    }

    return result
  }, [doorContexts, selectedTypes, selectedStoreys, searchQuery])

  // Doors to process (selected or filtered)
  const doorsToProcess = useMemo(() => {
    if (selectedDoorIds.size > 0) {
      return filteredDoors.filter(d => selectedDoorIds.has(d.doorId))
    }
    return filteredDoors
  }, [filteredDoors, selectedDoorIds])

  // Check Airtable configuration
  useEffect(() => {
    fetch('/api/airtable')
      .then(res => res.json())
      .then(data => setAirtableConfigured(data.configured))
      .catch(() => setAirtableConfigured(false))
  }, [])

  // Sync filtered doors with 3D view
  useEffect(() => {
    if (!visibilityManager) return

    if (isolateFiltered && filteredDoors.length > 0) {
      const doorExpressIds = filteredDoors.map(d => d.door.expressID)
      visibilityManager.isolateElements(doorExpressIds)
    } else {
      visibilityManager.resetAllVisibility()
    }
  }, [filteredDoors, isolateFiltered, visibilityManager])

  // Handle hover - highlight in 3D
  const handleDoorHover = useCallback((doorId: string | null) => {
    setHoveredDoorId(doorId)

    if (!visibilityManager) return

    if (doorId === null) {
      visibilityManager.setHoveredElement(null)
    } else {
      const door = doorContexts.find(d => d.doorId === doorId)
      if (door) {
        visibilityManager.setHoveredElement(door.door.expressID)
      }
    }
  }, [doorContexts, visibilityManager])

  // Handle door click - zoom to door
  const handleDoorClick = useCallback((door: DoorContext) => {
    if (!navigationManager || !door.door.boundingBox) return

    navigationManager.zoomToElementFromNormal(
      door.door.boundingBox,
      door.normal,
      2.5
    )
  }, [navigationManager])

  // Toggle door selection
  const toggleDoorSelection = useCallback((doorId: string) => {
    setSelectedDoorIds(prev => {
      const next = new Set(prev)
      if (next.has(doorId)) {
        next.delete(doorId)
      } else {
        next.add(doorId)
      }
      return next
    })
  }, [])

  // Select all filtered doors
  const selectAllFiltered = useCallback(() => {
    setSelectedDoorIds(new Set(filteredDoors.map(d => d.doorId)))
  }, [filteredDoors])

  // Clear selection
  const clearSelection = useCallback(() => {
    setSelectedDoorIds(new Set())
  }, [])

  // Clear all filters
  const clearFilters = useCallback(() => {
    setSearchQuery('')
    setSelectedStoreys(new Set())
    setSelectedTypes(new Set())
  }, [])

  // Toggle storey filter
  const toggleStorey = useCallback((storey: string) => {
    setSelectedStoreys(prev => {
      const next = new Set(prev)
      if (next.has(storey)) {
        next.delete(storey)
      } else {
        next.add(storey)
      }
      return next
    })
  }, [])

  // Toggle type filter
  const toggleType = useCallback((type: string) => {
    setSelectedTypes(prev => {
      const next = new Set(prev)
      if (next.has(type)) {
        next.delete(type)
      } else {
        next.add(type)
      }
      return next
    })
  }, [])

  // Show single door preview
  const showSingleDoor = useCallback(
    async (context: DoorContext, view: 'front' | 'back' | 'plan') => {
      try {
        let svg = ''
        if (view === 'plan') {
          svg = await renderDoorPlanSVG(context, options)
        } else {
          svg = await renderDoorElevationSVG(context, view === 'back', options)
        }
        setModalImage({ svg, doorId: context.doorId, view })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to render SVG')
      }
    },
    [options]
  )

  // Download ZIP
  const performDownload = useCallback(async () => {
    if (doorsToProcess.length === 0) {
      setError('No doors selected')
      return
    }

    setIsProcessing(true)
    setCurrentIndex(0)
    setProgress(0)
    setError(null)
    setShowConfirmation(false)

    const zip = new JSZip()
    const total = doorsToProcess.length

    try {
      for (let i = 0; i < doorsToProcess.length; i++) {
        const context = doorsToProcess[i]
        setCurrentIndex(i + 1)

        try {
          const { front, back, plan } = await renderDoorViews(context, options)
          zip.file(`${context.doorId}_front.svg`, front)
          zip.file(`${context.doorId}_back.svg`, back)
          zip.file(`${context.doorId}_plan.svg`, plan)
          setProgress(((i + 1) / total) * 100)
        } catch (err) {
          console.error(`Error processing door ${context.doorId}:`, err)
        }
      }

      const blob = await zip.generateAsync({ type: 'blob' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `door_views_${new Date().toISOString().split('T')[0]}.zip`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)

      setIsProcessing(false)
      if (onComplete) onComplete()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to process doors')
      setIsProcessing(false)
    } finally {
      setPendingAction(null)
    }
  }, [doorsToProcess, options, onComplete])

  // Upload to Airtable
  const performUpload = useCallback(async () => {
    if (doorsToProcess.length === 0) return

    setIsProcessing(true)
    setCurrentIndex(0)
    setProgress(0)
    setError(null)
    setShowConfirmation(false)

    const newStatus: AirtableStatus = {}
    doorsToProcess.forEach(d => { newStatus[d.doorId] = 'idle' })
    setAirtableStatus(newStatus)

    const CONCURRENCY = 3
    const total = doorsToProcess.length
    let failed = 0

    const processDoor = async (door: DoorContext, index: number) => {
      setAirtableStatus(prev => ({ ...prev, [door.doorId]: 'sending' }))

      try {
        const { front, back, plan } = await renderDoorViews(door, options)
        const svgToDataUrl = (svg: string) =>
          `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`

        const response = await fetch('/api/airtable', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            doorId: door.doorId,
            doorType: door.doorTypeName || undefined,
            openingDirection: door.openingDirection || undefined,
            modelSource: modelSource || undefined,
            frontView: svgToDataUrl(front),
            backView: svgToDataUrl(back),
            topView: svgToDataUrl(plan),
          }),
        })

        if (!response.ok) throw new Error('API Error')
        setAirtableStatus(prev => ({ ...prev, [door.doorId]: 'success' }))
        return true
      } catch (err) {
        setAirtableStatus(prev => ({ ...prev, [door.doorId]: 'error' }))
        failed++
        return false
      } finally {
        setCurrentIndex(prev => prev + 1)
        setProgress(((index + 1) / total) * 100)
      }
    }

    try {
      for (let i = 0; i < doorsToProcess.length; i += CONCURRENCY) {
        const batch = doorsToProcess.slice(i, i + CONCURRENCY)
        await Promise.all(batch.map((door, j) => processDoor(door, i + j)))
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
  }, [doorsToProcess, options, modelSource, onComplete])

  const initiateAction = (action: 'download' | 'upload') => {
    if (doorsToProcess.length > 10) {
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
    a.download = `${modalImage.doorId}_${modalImage.view}.svg`
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

  const hasActiveFilters = selectedStoreys.size > 0 || selectedTypes.size > 0 || searchQuery.trim().length > 0

  return (
    <div className="door-panel">
      {/* Header */}
      <div className="panel-header">
        <div className="header-title">
          <h2>Doors</h2>
          <span className="door-count-badge">{filteredDoors.length}</span>
        </div>
        <div className="header-actions">
          <button
            className={`icon-button ${isolateFiltered ? 'active' : ''}`}
            onClick={() => setIsolateFiltered(!isolateFiltered)}
            title={isolateFiltered ? 'Show all elements' : 'Isolate doors in 3D'}
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
              placeholder="Search doors..."
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
              <div className="filter-label">Storey</div>
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
            </div>
          )}

          {/* Type Filter */}
          {availableTypes.length > 0 && (
            <div className="filter-group">
              <div className="filter-label">Type</div>
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
          {selectedDoorIds.size > 0 ? (
            <span>{selectedDoorIds.size} selected</span>
          ) : (
            <span>{filteredDoors.length} doors</span>
          )}
        </div>
        <div className="selection-actions">
          <button className="text-button" onClick={selectAllFiltered}>
            Select all
          </button>
          {selectedDoorIds.size > 0 && (
            <button className="text-button" onClick={clearSelection}>
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Door List */}
      <div className="door-list" ref={listContainerRef}>
        {filteredDoors.length === 0 ? (
          <div className="empty-state">
            <p>No doors match your filters</p>
            {hasActiveFilters && (
              <button className="text-button" onClick={clearFilters}>
                Clear filters
              </button>
            )}
          </div>
        ) : (
          filteredDoors.slice(0, 100).map((door) => (
            <div
              key={door.doorId}
              className={`door-item ${selectedDoorIds.has(door.doorId) ? 'selected' : ''} ${hoveredDoorId === door.doorId ? 'hovered' : ''}`}
              onMouseEnter={() => handleDoorHover(door.doorId)}
              onMouseLeave={() => handleDoorHover(null)}
            >
              <label className="door-checkbox">
                <input
                  type="checkbox"
                  checked={selectedDoorIds.has(door.doorId)}
                  onChange={() => toggleDoorSelection(door.doorId)}
                />
                <span className="checkmark" />
              </label>

              <div className="door-info" onClick={() => handleDoorClick(door)}>
                <div className="door-id">{door.doorId}</div>
                <div className="door-meta">
                  {door.doorTypeName && (
                    <span className="meta-badge type">{door.doorTypeName}</span>
                  )}
                  {door.storeyName && (
                    <span className="meta-badge storey">{door.storeyName}</span>
                  )}
                </div>
              </div>

              <div className="door-actions">
                <button
                  className="action-button"
                  onClick={() => handleDoorClick(door)}
                  title="Zoom to door"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="16" />
                    <line x1="8" y1="12" x2="16" y2="12" />
                  </svg>
                </button>
                <button
                  className="action-button"
                  onClick={() => showSingleDoor(door, 'front')}
                  title="Preview front view"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                </button>
              </div>
            </div>
          ))
        )}
        {filteredDoors.length > 100 && (
          <div className="more-items">
            +{filteredDoors.length - 100} more doors
          </div>
        )}
      </div>

      {/* Export Section */}
      <div className="export-section">
        {/* Collapsible Style Options */}
        <button
          className="section-toggle"
          onClick={() => setShowStyleOptions(!showStyleOptions)}
        >
          <span>Style Options</span>
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            style={{ transform: showStyleOptions ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        {showStyleOptions && (
          <div className="style-options">
            <div className="option-row">
              <label>Door</label>
              <input type="color" value={options.doorColor || '#333333'} onChange={(e) => setOptions({ ...options, doorColor: e.target.value })} />
            </div>
            <div className="option-row">
              <label>Wall</label>
              <input type="color" value={options.wallColor || '#888888'} onChange={(e) => setOptions({ ...options, wallColor: e.target.value })} />
            </div>
            <div className="option-row">
              <label>Device</label>
              <input type="color" value={options.deviceColor || '#CC0000'} onChange={(e) => setOptions({ ...options, deviceColor: e.target.value })} />
            </div>
            <div className="option-row">
              <label>Line Width</label>
              <input type="number" min="0.5" max="5" step="0.5" value={options.lineWidth || 1.5} onChange={(e) => setOptions({ ...options, lineWidth: parseFloat(e.target.value) })} />
            </div>
            <div className="option-row checkbox">
              <label>
                <input type="checkbox" checked={options.showLegend} onChange={(e) => setOptions({ ...options, showLegend: e.target.checked })} />
                Show Legend
              </label>
            </div>
            <div className="option-row checkbox">
              <label>
                <input type="checkbox" checked={options.showLabels} onChange={(e) => setOptions({ ...options, showLabels: e.target.checked })} />
                Show Labels
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
            <div className="progress-text">
              Processing {currentIndex}/{doorsToProcess.length}...
            </div>
          </div>
        )}

        {/* Error */}
        {error && <div className="error-message">{error}</div>}

        {/* Export Buttons */}
        <div className="export-buttons">
          <button
            className="export-button primary"
            onClick={() => initiateAction('download')}
            disabled={isProcessing || doorsToProcess.length === 0}
          >
            {isProcessing && pendingAction === 'download' ? 'Processing...' : `Download ZIP (${doorsToProcess.length})`}
          </button>

          {airtableConfigured && (
            <button
              className="export-button airtable"
              onClick={() => initiateAction('upload')}
              disabled={isProcessing || doorsToProcess.length === 0}
            >
              {isProcessing && pendingAction === 'upload' ? 'Uploading...' : `Airtable (${doorsToProcess.length})`}
            </button>
          )}
        </div>
      </div>

      {/* Confirmation Modal */}
      {showConfirmation && (
        <div className="modal-overlay" onClick={() => setShowConfirmation(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3>Process {doorsToProcess.length} doors?</h3>
            <p>This will generate {doorsToProcess.length * 3} SVG images.</p>
            <div className="modal-actions">
              <button className="cancel-button" onClick={() => setShowConfirmation(false)}>
                Cancel
              </button>
              <button className="confirm-button" onClick={confirmAction}>
                Proceed
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Image Preview Modal */}
      {modalImage && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="image-modal" onClick={(e) => e.stopPropagation()}>
            <div className="image-modal-header">
              <h3>{modalImage.doorId} - {modalImage.view}</h3>
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
        .door-panel {
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

        .door-count-badge {
          background: #4ecdc4;
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
          background: #4ecdc4;
          border-color: #4ecdc4;
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
          border-color: #4ecdc4;
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
          background: #4ecdc4;
          border-color: #4ecdc4;
          color: #1a1a1a;
        }

        .chip-count {
          font-size: 10px;
          opacity: 0.7;
        }

        .clear-filters {
          background: none;
          border: none;
          color: #4ecdc4;
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
          color: #4ecdc4;
          font-size: 12px;
          cursor: pointer;
          padding: 0;
        }

        .text-button:hover {
          text-decoration: underline;
        }

        .door-list {
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

        .door-item {
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

        .door-item:hover, .door-item.hovered {
          background: #3a3a3a;
          border-color: #4ecdc4;
        }

        .door-item.selected {
          background: rgba(78, 205, 196, 0.1);
          border-color: #4ecdc4;
        }

        .door-checkbox {
          position: relative;
          display: flex;
          align-items: center;
        }

        .door-checkbox input {
          width: 16px;
          height: 16px;
          opacity: 0;
          position: absolute;
        }

        .door-checkbox .checkmark {
          width: 16px;
          height: 16px;
          border: 1px solid #555;
          border-radius: 3px;
          background: #1a1a1a;
        }

        .door-checkbox input:checked + .checkmark {
          background: #4ecdc4;
          border-color: #4ecdc4;
        }

        .door-checkbox input:checked + .checkmark::after {
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

        .door-info {
          flex: 1;
          min-width: 0;
          cursor: pointer;
        }

        .door-id {
          font-weight: 500;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          font-size: 12px;
        }

        .door-meta {
          display: flex;
          gap: 4px;
          margin-top: 4px;
        }

        .meta-badge {
          font-size: 10px;
          padding: 2px 6px;
          border-radius: 3px;
          white-space: nowrap;
        }

        .meta-badge.type {
          background: rgba(59, 130, 246, 0.2);
          color: #60a5fa;
        }

        .meta-badge.storey {
          background: rgba(168, 85, 247, 0.2);
          color: #c084fc;
        }

        .door-actions {
          display: flex;
          gap: 4px;
          opacity: 0;
          transition: opacity 0.2s;
        }

        .door-item:hover .door-actions {
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

        .option-row input[type="number"] {
          width: 60px;
          padding: 4px 6px;
          background: #1a1a1a;
          border: 1px solid #444;
          border-radius: 4px;
          color: #fff;
          font-size: 12px;
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
          background: #4ecdc4;
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
