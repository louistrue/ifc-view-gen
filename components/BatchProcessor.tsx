'use client'

import { useState, useCallback, useEffect, useMemo } from 'react'
import type { DoorContext } from '@/lib/door-analyzer'
import { filterDoors } from '@/lib/door-analyzer'
import type { DoorFilterOptions } from '@/lib/door-analyzer'
import JSZip from 'jszip'
import { renderDoorViews, renderDoorElevationSVG, renderDoorPlanSVG } from '@/lib/svg-renderer'
import type { SVGRenderOptions } from '@/lib/svg-renderer'

interface BatchProcessorProps {
  doorContexts: DoorContext[]
  onComplete?: () => void
  modelSource?: string
}

interface AirtableStatus {
  [doorId: string]: 'idle' | 'sending' | 'success' | 'error'
}

export default function BatchProcessor({ doorContexts, onComplete, modelSource }: BatchProcessorProps) {
  const [isProcessing, setIsProcessing] = useState(false)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [airtableStatus, setAirtableStatus] = useState<AirtableStatus>({})
  const [airtableConfigured, setAirtableConfigured] = useState<boolean | null>(null)
  const [batchMode, setBatchMode] = useState<'test' | 'all'>('test')
  const [showConfirmation, setShowConfirmation] = useState(false)
  const [pendingAction, setPendingAction] = useState<'download' | 'upload' | null>(null)

  // Filter state
  const [selectedTypes, setSelectedTypes] = useState<string[]>([])
  const [selectedStoreys, setSelectedStoreys] = useState<string[]>([])
  const [guidFilter, setGuidFilter] = useState<string>('')
  const [showFilters, setShowFilters] = useState(false)

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

  // Extract unique door types and storeys
  const availableTypes = useMemo(() => {
    const types = new Set<string>()
    doorContexts.forEach(door => {
      if (door.doorTypeName) types.add(door.doorTypeName)
    })
    return Array.from(types).sort()
  }, [doorContexts])

  const availableStoreys = useMemo(() => {
    const storeys = new Set<string>()
    doorContexts.forEach(door => {
      if (door.storeyName) storeys.add(door.storeyName)
    })
    return Array.from(storeys).sort()
  }, [doorContexts])

  // Apply filters to door contexts
  const filteredDoors = useMemo(() => {
    const filters: DoorFilterOptions = {}

    if (selectedTypes.length > 0) {
      filters.doorTypes = selectedTypes
    }

    if (selectedStoreys.length > 0) {
      filters.storeys = selectedStoreys
    }

    if (guidFilter.trim()) {
      filters.guids = guidFilter.trim()
    }

    return filterDoors(doorContexts, filters)
  }, [doorContexts, selectedTypes, selectedStoreys, guidFilter])

  // Determine which doors to process based on mode and filters
  const doorsToProcess = useMemo(() => {
    const doorsAfterFilter = filteredDoors

    if (batchMode === 'all') {
      return doorsAfterFilter
    }
    // In test mode, consistent random slice
    if (doorsAfterFilter.length <= 10) {
      return doorsAfterFilter
    }
    // Use a seeded-like shuffle for consistency within same render cycle?
    // Actually standard shuffle is fine, but we should memoize heavily.
    const shuffled = [...doorsAfterFilter].sort(() => 0.5 - Math.random()) // clearer sort
    return shuffled.slice(0, 10)
  }, [filteredDoors, batchMode])

  // Add global unhandled rejection handler to catch any missed promise rejections
  useEffect(() => {
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      console.warn('Unhandled promise rejection caught:', event.reason)
      // Prevent default browser error handling
      event.preventDefault()
    }

    window.addEventListener('unhandledrejection', handleUnhandledRejection)

    return () => {
      window.removeEventListener('unhandledrejection', handleUnhandledRejection)
    }
  }, [])

  // Check Airtable configuration on mount
  useEffect(() => {
    fetch('/api/airtable')
      .then(res => res.json())
      .then(data => setAirtableConfigured(data.configured))
      .catch(() => setAirtableConfigured(false))
  }, [])

  // Send door to Airtable with all 3 views
  const sendToAirtable = useCallback(async (context: DoorContext) => {
    setAirtableStatus(prev => ({ ...prev, [context.doorId]: 'sending' }))

    try {
      // Render all 3 views
      const { front, back, plan } = await renderDoorViews(context, options)

      // Convert SVGs to data URLs for Airtable attachment
      const svgToDataUrl = (svg: string) =>
        `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`

      const response = await fetch('/api/airtable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          doorId: context.doorId,
          doorType: context.doorTypeName || undefined,
          openingDirection: context.openingDirection || undefined,
          modelSource: modelSource || undefined,
          frontView: svgToDataUrl(front),
          backView: svgToDataUrl(back),
          topView: svgToDataUrl(plan),
        }),
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Failed to send to Airtable')
      }

      setAirtableStatus(prev => ({ ...prev, [context.doorId]: 'success' }))
    } catch (err) {
      console.error('Airtable error:', err)
      setAirtableStatus(prev => ({ ...prev, [context.doorId]: 'error' }))
      setError(err instanceof Error ? err.message : 'Failed to send to Airtable')
    }
  }, [options, modelSource])

  // Batch upload all doors to Airtable
  const performUpload = useCallback(async () => {
    if (doorsToProcess.length === 0) return

    setIsProcessing(true)
    setCurrentIndex(0)
    setProgress(0)
    setError(null)
    setShowConfirmation(false)

    // Reset statuses
    const newStatus: AirtableStatus = {}
    doorsToProcess.forEach(d => { newStatus[d.doorId] = 'idle' })
    setAirtableStatus(newStatus)

    const CONCURRENCY = 3
    const total = doorsToProcess.length
    let completed = 0
    let failed = 0

    // Helper to process a single door
    const processDoor = async (door: DoorContext) => {
      setAirtableStatus(prev => ({ ...prev, [door.doorId]: 'sending' }))

      try {
        // Render all 3 views
        const { front, back, plan } = await renderDoorViews(door, options)

        // Convert SVGs to data URLs
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

        if (!response.ok) {
          throw new Error('API Error')
        }

        setAirtableStatus(prev => ({ ...prev, [door.doorId]: 'success' }))
        return true
      } catch (err) {
        console.error(`Failed to upload door ${door.doorId}:`, err)
        setAirtableStatus(prev => ({ ...prev, [door.doorId]: 'error' }))
        failed++
        return false
      } finally {
        completed++
        setCurrentIndex(completed)
        setProgress((completed / total) * 100)
      }
    }

    // Process queue with concurrency limit
    try {
      for (let i = 0; i < doorsToProcess.length; i += CONCURRENCY) {
        const batch = doorsToProcess.slice(i, i + CONCURRENCY)
        await Promise.all(batch.map(processDoor))
      }

      if (onComplete) onComplete()

      if (failed > 0) {
        setError(`Completed with ${failed} errors. Check individual door statuses.`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Batch upload failed')
    } finally {
      setIsProcessing(false)
      setPendingAction(null)
    }
  }, [doorsToProcess, options, modelSource, onComplete])

  const performDownload = useCallback(async () => {
    if (doorsToProcess.length === 0) {
      setError('No doors found')
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
          // Render all views
          const { front, back, plan } = await renderDoorViews(context, options)

          // Add to ZIP
          zip.file(`${context.doorId}_front.svg`, front)
          zip.file(`${context.doorId}_back.svg`, back)
          zip.file(`${context.doorId}_plan.svg`, plan)

          // Update progress
          setProgress(((i + 1) / total) * 100)
        } catch (err) {
          console.error(`Error processing door ${context.doorId}:`, err)
          // Continue with next door
        }
      }

      // Generate ZIP file
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
      if (onComplete) {
        onComplete()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to process doors')
      setIsProcessing(false)
    } finally {
      setPendingAction(null)
    }
  }, [doorsToProcess, options, onComplete])

  const initiateAction = (action: 'download' | 'upload') => {
    if (batchMode === 'all') {
      setPendingAction(action)
      setShowConfirmation(true)
    } else {
      // Direct execution for test mode
      if (action === 'download') performDownload()
      else performUpload()
    }
  }

  const confirmAction = () => {
    if (pendingAction === 'download') performDownload()
    else if (pendingAction === 'upload') performUpload()
  }

  const cancelAction = () => {
    setShowConfirmation(false)
    setPendingAction(null)
  }

  // Filter helper functions
  const toggleType = (type: string) => {
    setSelectedTypes(prev =>
      prev.includes(type)
        ? prev.filter(t => t !== type)
        : [...prev, type]
    )
  }

  const toggleStorey = (storey: string) => {
    setSelectedStoreys(prev =>
      prev.includes(storey)
        ? prev.filter(s => s !== storey)
        : [...prev, storey]
    )
  }

  const clearFilters = () => {
    setSelectedTypes([])
    setSelectedStoreys([])
    setGuidFilter('')
  }

  const selectAllTypes = () => {
    setSelectedTypes(availableTypes)
  }

  const selectAllStoreys = () => {
    setSelectedStoreys(availableStoreys)
  }

  const downloadSingleDoor = useCallback(
    async (context: DoorContext, view: 'front' | 'back' | 'plan') => {
      try {
        let svg = ''
        if (view === 'plan') {
          svg = await renderDoorPlanSVG(context, options)
        } else {
          svg = await renderDoorElevationSVG(context, view === 'back', options)
        }
        const blob = new Blob([svg], { type: 'image/svg+xml' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${context.doorId}_${view}.svg`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to render SVG')
      }
    },
    [options]
  )

  return (
    <div className="batch-processor">
      <div className="batch-header">
        <h2>Door View Generator</h2>
        <div className="header-controls">
          {doorContexts.length > 0 && (
            <div className="mode-toggle">
              <button
                className={`toggle-btn ${batchMode === 'test' ? 'active' : ''}`}
                onClick={() => setBatchMode('test')}
                disabled={isProcessing}
              >
                Test (10)
              </button>
              <button
                className={`toggle-btn ${batchMode === 'all' ? 'active' : ''}`}
                onClick={() => setBatchMode('all')}
                disabled={isProcessing}
              >
                All ({doorContexts.length})
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Filter Panel */}
      {doorContexts.length > 0 && (
        <div className="filter-panel">
          <div className="filter-header">
            <h3>
              Filter Doors
              {(selectedTypes.length > 0 || selectedStoreys.length > 0 || guidFilter.trim()) && (
                <span className="filter-badge">
                  {filteredDoors.length}/{doorContexts.length} doors
                </span>
              )}
            </h3>
            <div className="filter-actions">
              <button
                className="toggle-filters-btn"
                onClick={() => setShowFilters(!showFilters)}
                disabled={isProcessing}
              >
                {showFilters ? '▼ Hide Filters' : '▶ Show Filters'}
              </button>
              {(selectedTypes.length > 0 || selectedStoreys.length > 0 || guidFilter.trim()) && (
                <button
                  className="clear-filters-btn"
                  onClick={clearFilters}
                  disabled={isProcessing}
                >
                  Clear All
                </button>
              )}
            </div>
          </div>

          {showFilters && (
            <div className="filter-content">
              {/* Door Types Filter */}
              {availableTypes.length > 0 && (
                <div className="filter-section">
                  <div className="filter-section-header">
                    <label className="filter-label">Door Types ({selectedTypes.length}/{availableTypes.length})</label>
                    <div className="filter-section-actions">
                      <button
                        className="select-all-btn"
                        onClick={selectAllTypes}
                        disabled={isProcessing || selectedTypes.length === availableTypes.length}
                      >
                        Select All
                      </button>
                      <button
                        className="clear-btn"
                        onClick={() => setSelectedTypes([])}
                        disabled={isProcessing || selectedTypes.length === 0}
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                  <div className="checkbox-grid">
                    {availableTypes.map(type => (
                      <label key={type} className="checkbox-label">
                        <input
                          type="checkbox"
                          checked={selectedTypes.includes(type)}
                          onChange={() => toggleType(type)}
                          disabled={isProcessing}
                        />
                        <span>{type}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {/* Building Storeys Filter */}
              {availableStoreys.length > 0 && (
                <div className="filter-section">
                  <div className="filter-section-header">
                    <label className="filter-label">Building Storeys ({selectedStoreys.length}/{availableStoreys.length})</label>
                    <div className="filter-section-actions">
                      <button
                        className="select-all-btn"
                        onClick={selectAllStoreys}
                        disabled={isProcessing || selectedStoreys.length === availableStoreys.length}
                      >
                        Select All
                      </button>
                      <button
                        className="clear-btn"
                        onClick={() => setSelectedStoreys([])}
                        disabled={isProcessing || selectedStoreys.length === 0}
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                  <div className="checkbox-grid">
                    {availableStoreys.map(storey => (
                      <label key={storey} className="checkbox-label">
                        <input
                          type="checkbox"
                          checked={selectedStoreys.includes(storey)}
                          onChange={() => toggleStorey(storey)}
                          disabled={isProcessing}
                        />
                        <span>{storey}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {/* GUID Filter */}
              <div className="filter-section">
                <label className="filter-label">Filter by GUIDs (comma-separated)</label>
                <input
                  type="text"
                  className="guid-input"
                  placeholder="e.g., 2O2Fr$t4X7Zf8NOew3FLOH, 1S8LodzGX8dRt2NjBjEZHe"
                  value={guidFilter}
                  onChange={(e) => setGuidFilter(e.target.value)}
                  disabled={isProcessing}
                />
                <small className="filter-help">
                  Enter one or more door GUIDs separated by commas for precise filtering
                </small>
              </div>

              {/* Filter Statistics */}
              {(selectedTypes.length > 0 || selectedStoreys.length > 0 || guidFilter.trim()) && (
                <div className="filter-stats">
                  <strong>Filtering Results:</strong>
                  <ul>
                    <li>Total doors: {doorContexts.length}</li>
                    <li>After filters: {filteredDoors.length}</li>
                    {batchMode === 'test' && filteredDoors.length > 10 && (
                      <li>Test mode will process: 10 random doors</li>
                    )}
                    {batchMode === 'all' && (
                      <li>All mode will process: {filteredDoors.length} doors</li>
                    )}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="style-controls">
        <h3>Style Options</h3>
        <div className="control-grid">
          <div className="control-group">
            <label>Door Color</label>
            <input
              type="color"
              value={options.doorColor || '#000000'}
              onChange={(e) =>
                setOptions({ ...options, doorColor: e.target.value })
              }
            />
          </div>
          <div className="control-group">
            <label>Wall Color</label>
            <input
              type="color"
              value={options.wallColor || '#555555'}
              onChange={(e) =>
                setOptions({ ...options, wallColor: e.target.value })
              }
            />
          </div>
          <div className="control-group">
            <label>Device Color</label>
            <input
              type="color"
              value={options.deviceColor || '#FF0000'}
              onChange={(e) =>
                setOptions({ ...options, deviceColor: e.target.value })
              }
            />
          </div>
          <div className="control-group">
            <label>Line Width</label>
            <input
              type="number"
              min="0.5"
              max="5"
              step="0.5"
              value={options.lineWidth || 1}
              onChange={(e) =>
                setOptions({ ...options, lineWidth: parseFloat(e.target.value) })
              }
            />
          </div>
          <div className="control-group">
            <label>Line Color</label>
            <input
              type="color"
              value={options.lineColor || '#000000'}
              onChange={(e) =>
                setOptions({ ...options, lineColor: e.target.value })
              }
            />
          </div>
          <div className="control-group">
            <label>Margin (m)</label>
            <input
              type="number"
              min="0.1"
              max="2"
              step="0.1"
              value={options.margin || 0.5}
              onChange={(e) =>
                setOptions({ ...options, margin: parseFloat(e.target.value) })
              }
            />
          </div>
          <div className="control-group">
            <label>
              <input
                type="checkbox"
                checked={options.showLegend}
                onChange={(e) =>
                  setOptions({ ...options, showLegend: e.target.checked })
                }
              />
              Show Legend
            </label>
          </div>
          <div className="control-group">
            <label>
              <input
                type="checkbox"
                checked={options.showLabels}
                onChange={(e) =>
                  setOptions({ ...options, showLabels: e.target.checked })
                }
              />
              Show Labels
            </label>
          </div>
          <div className="control-group">
            <h3>Typography</h3>
          </div>
          <div className="control-group">
            <label>Font Size</label>
            <input
              type="number"
              min="8"
              max="48"
              step="1"
              value={options.fontSize || 14}
              onChange={(e) =>
                setOptions({ ...options, fontSize: parseInt(e.target.value) })
              }
            />
          </div>
          <div className="control-group">
            <label>Font Family</label>
            <select
              value={options.fontFamily || 'Arial'}
              onChange={(e) =>
                setOptions({ ...options, fontFamily: e.target.value })
              }
            >
              <option value="Arial">Arial</option>
              <option value="Helvetica">Helvetica</option>
              <option value="Verdana">Verdana</option>
              <option value="Times New Roman">Times New Roman</option>
              <option value="Courier New">Courier New</option>
            </select>
          </div>
        </div>
      </div>

      <div className="batch-actions">
        <button
          onClick={() => initiateAction('download')}
          disabled={isProcessing || doorContexts.length === 0}
          className="generate-button"
        >
          {isProcessing && pendingAction === 'download'
            ? `Processing... ${currentIndex}/${doorsToProcess.length}`
            : `Generate ZIP (${doorsToProcess.length} Doors)`}
        </button>

        {airtableConfigured && (
          <button
            onClick={() => initiateAction('upload')}
            disabled={isProcessing || doorContexts.length === 0}
            className="airtable-button"
            style={{ padding: '0.75rem 1.5rem', fontSize: '1rem', flex: 'none' }}
          >
            {isProcessing && pendingAction === 'upload'
              ? `Uploading... ${currentIndex}/${doorsToProcess.length}`
              : `Upload to Airtable (${doorsToProcess.length} Doors)`}
          </button>
        )}

        {isProcessing && (
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}
      </div>

      {error && <div className="error-message">{error}</div>}

      <div className="door-list">
        <h3>Individual Doors ({doorsToProcess.length})</h3>
        {batchMode === 'test' && doorContexts.length > 10 && (
          <p className="door-subset-info">
            Showing 10 random doors for performance. Switch to "All" to process everyone.
          </p>
        )}
        <div className="door-items">
          {doorsToProcess.slice(0, 50).map((context) => (
            <div key={context.doorId} className="door-item">
              <span className="door-info">
                <strong>{context.doorId}</strong>
                {context.doorTypeName && <span className="door-type-tag">{context.doorTypeName}</span>}
                {context.storeyName && <span className="door-storey-tag">{context.storeyName}</span>}
              </span>
              <div className="door-actions">
                <button
                  onClick={() => downloadSingleDoor(context, 'front')}
                  disabled={isProcessing}
                  className="download-button"
                >
                  Front
                </button>
                <button
                  onClick={() => downloadSingleDoor(context, 'back')}
                  disabled={isProcessing}
                  className="download-button"
                >
                  Back
                </button>
                <button
                  onClick={() => downloadSingleDoor(context, 'plan')}
                  disabled={isProcessing}
                  className="download-button"
                >
                  Plan
                </button>
                {airtableConfigured && (
                  <button
                    onClick={() => sendToAirtable(context)}
                    disabled={isProcessing || airtableStatus[context.doorId] === 'sending'}
                    className={`airtable-button ${airtableStatus[context.doorId] || 'idle'}`}
                    title="Send all 3 views to Airtable"
                  >
                    {airtableStatus[context.doorId] === 'sending' ? '⏳' :
                      airtableStatus[context.doorId] === 'success' ? '✓' :
                        airtableStatus[context.doorId] === 'error' ? '✗' : '📤'}
                  </button>
                )}
              </div>
            </div>
          ))}
          {doorsToProcess.length > 50 && (
            <p style={{ textAlign: 'center', padding: '1rem', color: '#666' }}>
              ...and {doorsToProcess.length - 50} more
            </p>
          )}
        </div>
      </div>

      {showConfirmation && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3>Confirm Large Batch Operation</h3>
            <p>
              You are about to {pendingAction === 'download' ? 'generate a ZIP for' : 'upload to Airtable'} <strong>{doorsToProcess.length} doors</strong>.
            </p>
            <p>
              This will generate <strong>{doorsToProcess.length * 3} SVG images</strong> and make {doorsToProcess.length} API requests (if uploading).
            </p>
            <p>This may take a while. Are you sure?</p>
            <div className="modal-actions">
              <button onClick={cancelAction} className="cancel-button">
                Cancel
              </button>
              <button onClick={confirmAction} className="confirm-button">
                Yes, Proceed
              </button>
            </div>
          </div>
        </div>
      )}

      <style jsx>{`
        .modal-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.5);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
        }
        .modal-content {
          background: white;
          padding: 2rem;
          border-radius: 8px;
          max-width: 500px;
          box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }
        .modal-actions {
          display: flex;
          gap: 1rem;
          justify-content: flex-end;
          margin-top: 1.5rem;
        }
        .confirm-button {
          background: #007bff;
          color: white;
          border: none;
          padding: 0.5rem 1rem;
          border-radius: 4px;
          cursor: pointer;
        }
        .cancel-button {
          background: #eee;
          border: none;
          padding: 0.5rem 1rem;
          border-radius: 4px;
          cursor: pointer;
        }
        .mode-toggle {
          display: flex;
          gap: 0.5rem;
          background: #f0f0f0;
          padding: 4px;
          border-radius: 6px;
        }
        .toggle-btn {
          border: none;
          background: transparent;
          padding: 4px 12px;
          border-radius: 4px;
          cursor: pointer;
          font-weight: 500;
        }
        .toggle-btn.active {
          background: white;
          box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
        .header-controls {
          display: flex;
          align-items: center;
          gap: 1rem;
        }
        .batch-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 2rem;
        }
        .filter-panel {
          background: #f8f9fa;
          border: 1px solid #dee2e6;
          border-radius: 8px;
          padding: 1rem;
          margin-bottom: 1.5rem;
        }
        .filter-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 0.5rem;
        }
        .filter-header h3 {
          margin: 0;
          font-size: 1.1rem;
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }
        .filter-badge {
          background: #007bff;
          color: white;
          padding: 0.25rem 0.75rem;
          border-radius: 12px;
          font-size: 0.85rem;
          font-weight: 600;
        }
        .filter-actions {
          display: flex;
          gap: 0.5rem;
        }
        .toggle-filters-btn {
          background: #6c757d;
          color: white;
          border: none;
          padding: 0.5rem 1rem;
          border-radius: 4px;
          cursor: pointer;
          font-size: 0.9rem;
        }
        .toggle-filters-btn:hover:not(:disabled) {
          background: #5a6268;
        }
        .clear-filters-btn {
          background: #dc3545;
          color: white;
          border: none;
          padding: 0.5rem 1rem;
          border-radius: 4px;
          cursor: pointer;
          font-size: 0.9rem;
        }
        .clear-filters-btn:hover:not(:disabled) {
          background: #c82333;
        }
        .filter-content {
          margin-top: 1rem;
          display: flex;
          flex-direction: column;
          gap: 1.5rem;
        }
        .filter-section {
          border: 1px solid #dee2e6;
          background: white;
          padding: 1rem;
          border-radius: 6px;
        }
        .filter-section-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 0.75rem;
        }
        .filter-label {
          font-weight: 600;
          color: #495057;
          margin: 0;
        }
        .filter-section-actions {
          display: flex;
          gap: 0.5rem;
        }
        .select-all-btn, .clear-btn {
          background: #e9ecef;
          border: 1px solid #ced4da;
          padding: 0.25rem 0.75rem;
          border-radius: 4px;
          cursor: pointer;
          font-size: 0.85rem;
        }
        .select-all-btn:hover:not(:disabled) {
          background: #dee2e6;
        }
        .clear-btn:hover:not(:disabled) {
          background: #dee2e6;
        }
        .select-all-btn:disabled, .clear-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .checkbox-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
          gap: 0.5rem;
        }
        .checkbox-label {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          cursor: pointer;
          padding: 0.25rem;
        }
        .checkbox-label input[type="checkbox"] {
          cursor: pointer;
        }
        .checkbox-label span {
          user-select: none;
        }
        .guid-input {
          width: 100%;
          padding: 0.5rem;
          border: 1px solid #ced4da;
          border-radius: 4px;
          font-family: monospace;
          font-size: 0.9rem;
          margin-top: 0.5rem;
        }
        .guid-input:focus {
          outline: none;
          border-color: #007bff;
          box-shadow: 0 0 0 0.2rem rgba(0, 123, 255, 0.25);
        }
        .filter-help {
          color: #6c757d;
          font-size: 0.85rem;
          display: block;
          margin-top: 0.25rem;
        }
        .filter-stats {
          background: #e7f3ff;
          border: 1px solid #b3d7ff;
          padding: 0.75rem;
          border-radius: 4px;
          margin-top: 0.5rem;
        }
        .filter-stats strong {
          color: #004085;
        }
        .filter-stats ul {
          margin: 0.5rem 0 0 1.5rem;
          padding: 0;
          color: #004085;
        }
        .filter-stats li {
          margin: 0.25rem 0;
        }
        .door-info {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          flex-wrap: wrap;
        }
        .door-type-tag {
          background: #e7f3ff;
          color: #004085;
          padding: 0.15rem 0.5rem;
          border-radius: 4px;
          font-size: 0.85rem;
          border: 1px solid #b3d7ff;
        }
        .door-storey-tag {
          background: #fff3cd;
          color: #856404;
          padding: 0.15rem 0.5rem;
          border-radius: 4px;
          font-size: 0.85rem;
          border: 1px solid #ffeaa7;
        }
      `}</style>
    </div>
  )
}

