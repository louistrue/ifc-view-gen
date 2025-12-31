'use client'

import { useState, useCallback, useEffect, useMemo } from 'react'
import type { DoorContext } from '@/lib/door-analyzer'
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

interface AirtableAuthStatus {
  isAuthenticated: boolean
  hasBaseId: boolean
  tableName: string
}

export default function BatchProcessor({ doorContexts, onComplete, modelSource }: BatchProcessorProps) {
  const [isProcessing, setIsProcessing] = useState(false)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [airtableStatus, setAirtableStatus] = useState<AirtableStatus>({})
  const [authStatus, setAuthStatus] = useState<AirtableAuthStatus | null>(null)
  const [batchMode, setBatchMode] = useState<'test' | 'all'>('test')
  const [showConfirmation, setShowConfirmation] = useState(false)
  const [pendingAction, setPendingAction] = useState<'download' | 'upload' | null>(null)
  const [baseId, setBaseId] = useState('')
  const [tableName, setTableName] = useState('Doors')
  const [showAirtableConfig, setShowAirtableConfig] = useState(false)

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

  // Determine which doors to process based on mode
  const doorsToProcess = useMemo(() => {
    if (batchMode === 'all') {
      return doorContexts
    }
    // In test mode, consistent random slice
    if (doorContexts.length <= 10) {
      return doorContexts
    }
    // Use a seeded-like shuffle for consistency within same render cycle?
    // Actually standard shuffle is fine, but we should memoize heavily.
    const shuffled = [...doorContexts].sort(() => 0.5 - Math.random()) // clearer sort
    return shuffled.slice(0, 10)
  }, [doorContexts, batchMode])

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

  // Check Airtable authentication status on mount and after OAuth
  const checkAuthStatus = useCallback(() => {
    fetch('/api/airtable')
      .then(res => res.json())
      .then(data => {
        setAuthStatus(data)
        if (data.tableName) setTableName(data.tableName)
      })
      .catch(() => setAuthStatus({ isAuthenticated: false, hasBaseId: false, tableName: 'Doors' }))
  }, [])

  useEffect(() => {
    checkAuthStatus()

    // Listen for OAuth popup messages
    const handleMessage = (event: MessageEvent) => {
      // Verify origin for security
      if (event.origin !== window.location.origin) return

      if (event.data.type === 'airtable-oauth-success') {
        console.log('OAuth success received from popup')
        checkAuthStatus()
        setShowAirtableConfig(true)
        setError(null)
      } else if (event.data.type === 'airtable-oauth-error') {
        console.error('OAuth error received from popup:', event.data.error)
        setError(`OAuth error: ${event.data.error}`)
      }
    }

    window.addEventListener('message', handleMessage)

    return () => {
      window.removeEventListener('message', handleMessage)
    }
  }, [checkAuthStatus])

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
          baseId: baseId || undefined,
          tableName: tableName || undefined,
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
  }, [options, modelSource, baseId, tableName])

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
            baseId: baseId || undefined,
            tableName: tableName || undefined,
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
  }, [doorsToProcess, options, modelSource, onComplete, baseId, tableName])

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

  const handleConnectAirtable = () => {
    // Open OAuth in popup window
    const width = 600
    const height = 700
    const left = window.screen.width / 2 - width / 2
    const top = window.screen.height / 2 - height / 2

    const popup = window.open(
      '/api/auth/airtable/authorize?popup=true',
      'airtable-oauth',
      `width=${width},height=${height},left=${left},top=${top},toolbar=no,location=no,status=no,menubar=no,scrollbars=yes,resizable=yes`
    )

    // Check if popup was blocked
    if (!popup || popup.closed || typeof popup.closed === 'undefined') {
      setError('Popup was blocked. Please allow popups for this site and try again.')
    }
  }

  const handleDisconnectAirtable = async () => {
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST' })
      if (response.ok) {
        setAuthStatus({ isAuthenticated: false, hasBaseId: false, tableName: 'Doors' })
        setBaseId('')
        setTableName('Doors')
        setShowAirtableConfig(false)
      }
    } catch (err) {
      setError('Failed to disconnect from Airtable')
    }
  }

  // Check if user needs to connect or configure Airtable
  const needsAuth = !authStatus?.isAuthenticated
  const needsConfig = authStatus?.isAuthenticated && !authStatus?.hasBaseId && !baseId
  const isAirtableReady = authStatus?.isAuthenticated && (authStatus?.hasBaseId || baseId)

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
          {authStatus?.isAuthenticated && (
            <button onClick={handleDisconnectAirtable} className="disconnect-button-small" disabled={isProcessing} title="Disconnect from Airtable">
              Disconnect
            </button>
          )}
        </div>
      </div>

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

        <button
          onClick={() => {
            if (needsAuth) {
              handleConnectAirtable()
            } else if (needsConfig) {
              setShowAirtableConfig(true)
            } else {
              initiateAction('upload')
            }
          }}
          disabled={isProcessing || doorContexts.length === 0}
          className="airtable-button"
          style={{ padding: '0.75rem 1.5rem', fontSize: '1rem', flex: 'none' }}
        >
          {isProcessing && pendingAction === 'upload'
            ? `Uploading... ${currentIndex}/${doorsToProcess.length}`
            : needsAuth
            ? `🔒 Connect & Upload to Airtable (${doorsToProcess.length} Doors)`
            : needsConfig
            ? `⚙️ Configure & Upload to Airtable (${doorsToProcess.length} Doors)`
            : `Upload to Airtable (${doorsToProcess.length} Doors)`}
        </button>

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
                {context.doorId} - Wall: {context.wall ? 'Found' : 'Not found'}
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
                <button
                  onClick={() => {
                    if (needsAuth) {
                      handleConnectAirtable()
                    } else if (needsConfig) {
                      setShowAirtableConfig(true)
                    } else {
                      sendToAirtable(context)
                    }
                  }}
                  disabled={isProcessing || airtableStatus[context.doorId] === 'sending'}
                  className={`airtable-button ${airtableStatus[context.doorId] || 'idle'}`}
                  title={needsAuth ? 'Connect to Airtable' : needsConfig ? 'Configure Airtable' : 'Send all 3 views to Airtable'}
                >
                  {airtableStatus[context.doorId] === 'sending' ? '⏳' :
                    airtableStatus[context.doorId] === 'success' ? '✓' :
                      airtableStatus[context.doorId] === 'error' ? '✗' :
                      needsAuth ? '🔒' : '📤'}
                </button>
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

      {showAirtableConfig && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3>Configure Airtable</h3>
            <p>Enter your Airtable base details to start uploading.</p>
            <div className="config-form-modal">
              <div className="form-group">
                <label htmlFor="modal-baseId">Base ID *</label>
                <input
                  id="modal-baseId"
                  type="text"
                  value={baseId}
                  onChange={(e) => setBaseId(e.target.value)}
                  placeholder="appXXXXXXXXXXXXXX"
                  autoFocus
                />
                <small>Find this in your Airtable base URL (e.g., airtable.com/<strong>appXXXX</strong>/...)</small>
              </div>
              <div className="form-group">
                <label htmlFor="modal-tableName">Table Name</label>
                <input
                  id="modal-tableName"
                  type="text"
                  value={tableName}
                  onChange={(e) => setTableName(e.target.value)}
                  placeholder="Doors"
                />
                <small>The name of the table where doors will be stored</small>
              </div>
            </div>
            <div className="modal-actions">
              <button onClick={() => setShowAirtableConfig(false)} className="cancel-button">
                Cancel
              </button>
              <button
                onClick={() => {
                  if (!baseId) {
                    setError('Base ID is required')
                    return
                  }
                  setShowAirtableConfig(false)
                }}
                className="confirm-button"
                disabled={!baseId}
              >
                Save & Continue
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
        .disconnect-button-small {
          background: #dc3545;
          color: white;
          border: none;
          padding: 0.4rem 0.8rem;
          border-radius: 4px;
          cursor: pointer;
          font-size: 0.85rem;
        }
        .disconnect-button-small:hover:not(:disabled) {
          background: #c82333;
        }
        .disconnect-button-small:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .config-form-modal {
          margin: 1.5rem 0;
        }
        .config-form-modal .form-group {
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
          margin-bottom: 1rem;
        }
        .config-form-modal .form-group label {
          font-weight: 500;
          font-size: 0.9rem;
        }
        .config-form-modal .form-group input {
          padding: 0.6rem;
          border: 1px solid #ccc;
          border-radius: 4px;
          font-size: 0.95rem;
        }
        .config-form-modal .form-group input:focus {
          outline: none;
          border-color: #007bff;
        }
        .config-form-modal .form-group small {
          font-size: 0.8rem;
          color: #666;
        }
      `}</style>
    </div>
  )
}

