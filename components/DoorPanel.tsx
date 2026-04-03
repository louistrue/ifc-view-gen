'use client'

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { type DoorContext, geschossGeometrietypForAirtable } from '@/lib/door-analyzer'
import JSZip from 'jszip'
import {
  renderDoorViews,
  renderDoorElevationSVG,
  renderDoorPlanSVG,
  DEFAULT_SVG_FONT_FAMILY,
  type SVGRenderOptions,
} from '@/lib/svg-renderer'
import { Settings, ExternalLink, LogOut, Link2, Loader2, Check, X, Download, Upload } from 'lucide-react'

interface AirtableAuthStatus {
  isAuthenticated: boolean
  hasBaseId: boolean
  baseId: string | null
  baseName: string | null
  tableName: string | null
}

interface DoorPanelProps {
  doorContexts: DoorContext[]
  /** Checkbox selection in the bottom DoorListDock — drives ZIP / Airtable export. */
  dockSelectedDoorIds: Set<string>
  modelSource?: string
  onComplete?: () => void
  onShowSingleDoorReady?: (showSingleDoor: ((door: DoorContext, view: 'front' | 'back' | 'plan') => void) | null) => void
}

interface AirtableStatus {
  [doorId: string]: 'idle' | 'sending' | 'success' | 'error'
}

export default function DoorPanel({
  doorContexts,
  dockSelectedDoorIds,
  modelSource,
  onComplete,
  onShowSingleDoorReady,
}: DoorPanelProps) {
  // UI state
  const [showSettings, setShowSettings] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [airtableStatus, setAirtableStatus] = useState<AirtableStatus>({})
  const [authStatus, setAuthStatus] = useState<AirtableAuthStatus | null>(null)
  const [modalImage, setModalImage] = useState<{ svg: string; doorId: string; view: string } | null>(null)
  const [showConfirmation, setShowConfirmation] = useState(false)
  const [pendingAction, setPendingAction] = useState<'download' | 'upload' | null>(null)

  // SVG render options
  const [options, setOptions] = useState<SVGRenderOptions>({
    width: 1000,
    height: 1000,
    margin: 0.5,
    doorColor: '#dedede',
    wallColor: '#e3e3e3',
    deviceColor: '#fcc647',
    lineWidth: 1.5,
    lineColor: '#000000',
    showFills: true,
    showLegend: true,
    showLabels: true,
    fontSize: 22,
    fontFamily: DEFAULT_SVG_FONT_FAMILY,
    wallRevealSide: 0.12,
    wallRevealTop: 0.04,
  })

  // Dock checkboxes when any; otherwise entire model door list (filter in bottom table)
  const doorsToProcess = useMemo(() => {
    if (dockSelectedDoorIds.size > 0) {
      return doorContexts.filter(d => dockSelectedDoorIds.has(d.doorId))
    }
    return doorContexts
  }, [doorContexts, dockSelectedDoorIds])

  // Check Airtable OAuth auth status
  const checkAuthStatus = useCallback(() => {
    fetch('/api/airtable')
      .then(res => res.json())
      .then(data => setAuthStatus(data))
      .catch(() => setAuthStatus({ isAuthenticated: false, hasBaseId: false, baseId: null, baseName: null, tableName: 'Doors' }))
  }, [])

  useEffect(() => {
    checkAuthStatus()

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return
      if (event.data.type === 'airtable-oauth-success') {
        checkAuthStatus()
        setError(null)
      } else if (event.data.type === 'airtable-oauth-error') {
        setError(`OAuth error: ${event.data.error}`)
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [checkAuthStatus])

  const handleConnectAirtable = () => {
    const width = 600, height = 700
    const left = window.screen.width / 2 - width / 2
    const top = window.screen.height / 2 - height / 2
    const popup = window.open(
      '/api/auth/airtable/authorize?popup=true',
      'airtable-oauth',
      `width=${width},height=${height},left=${left},top=${top},toolbar=no,location=no,status=no,menubar=no,scrollbars=yes,resizable=yes`
    )
    if (!popup || popup.closed || typeof popup.closed === 'undefined') {
      setError('Popup was blocked. Please allow popups for this site.')
    }
  }

  const handleDisconnectAirtable = async () => {
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST' })
      if (response.ok) {
        setAuthStatus({ isAuthenticated: false, hasBaseId: false, baseId: null, baseName: null, tableName: 'Doors' })
      }
    } catch {
      setError('Failed to disconnect from Airtable')
    }
  }

  const isAirtableReady = authStatus?.isAuthenticated === true

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

        if (process.env.NODE_ENV === 'development') {
          console.info('[door-preview-debug]', {
            source: 'DoorPanel',
            doorId: context.doorId,
            view,
            wallColor: options.wallColor,
            doorColor: options.doorColor,
            hostWallId: context.hostWall?.expressID ?? null,
            wallBoundingBox: Boolean(context.hostWall?.boundingBox),
            detailedDoorMeshes: context.detailedGeometry?.doorMeshes.length ?? 0,
            detailedWallMeshes: context.detailedGeometry?.wallMeshes.length ?? 0,
            svgIncludesWallColor: Boolean(options.wallColor && svg.includes(options.wallColor)),
            svgIncludesDoorColor: Boolean(options.doorColor && svg.includes(options.doorColor)),
            svgDoorFillCount: options.doorColor ? (svg.match(new RegExp(options.doorColor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length : 0,
            svgWallFillCount: options.wallColor ? (svg.match(new RegExp(options.wallColor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length : 0,
          })
        }

        setModalImage({ svg, doorId: context.doorId, view })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to render SVG')
      }
    },
    [options]
  )

  useEffect(() => {
    onShowSingleDoorReady?.(showSingleDoor)
    return () => { onShowSingleDoorReady?.(null) }
  }, [showSingleDoor, onShowSingleDoorReady])

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

    const CONCURRENCY = 2
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
            doorType: door.doorTypeName ?? undefined,
            alTuernummer: door.csetStandardCH?.alTuernummer ?? undefined,
            openingDirection: door.openingDirection || undefined,
            modelSource: modelSource || undefined,
            geometryType: geschossGeometrietypForAirtable(door),
            geometryTypeSync: door.csetStandardCH?.geometryType?.trim() || undefined,
            geschossSync: door.storeyName?.trim() || undefined,
            massDurchgangsbreite: door.csetStandardCH?.massDurchgangsbreite ?? undefined,
            massDurchgangshoehe: door.csetStandardCH?.massDurchgangshoehe ?? undefined,
            massRohbreite: door.csetStandardCH?.massRohbreite ?? undefined,
            massRohhoehe: door.csetStandardCH?.massRohhoehe ?? undefined,
            massAussenrahmenBreite: door.csetStandardCH?.massAussenrahmenBreite ?? undefined,
            massAussenrahmenHoehe: door.csetStandardCH?.massAussenrahmenHoehe ?? undefined,
            feuerwiderstand: door.csetStandardCH?.feuerwiderstand ?? undefined,
            bauschalldaemmmass: door.csetStandardCH?.bauschalldaemmmass ?? undefined,
            frontView: svgToDataUrl(front),
            backView: svgToDataUrl(back),
            topView: svgToDataUrl(plan),
          }),
        })

        if (!response.ok) {
          const errData = await response.json().catch(() => ({}))
          throw new Error(errData.error || 'API Error')
        }
        setAirtableStatus(prev => ({ ...prev, [door.doorId]: 'success' }))
        return true
      } catch (err) {
        console.error(`Airtable upload error for ${door.doorId}:`, err)
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

  // Escape key + click-outside handlers
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (modalImage) setModalImage(null)
        else if (showConfirmation) setShowConfirmation(false)
        else if (showSettings) setShowSettings(false)
      }
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [modalImage, showConfirmation, showSettings])

  // Close settings panel on outside click
  const settingsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!showSettings) return
    const handleClick = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setShowSettings(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showSettings])

  return (
    <div className="door-panel">
      {/* Header */}
      <div className="panel-header">
        <div className="header-title">
          <h2>Doors</h2>
          <span className="door-count-badge">{doorContexts.length}</span>
        </div>
        <div className="header-actions">
          {/* Settings / Airtable button */}
          <div className="settings-wrapper" ref={settingsRef}>
            <button
              className={`icon-button ${showSettings ? 'active' : ''} ${isAirtableReady ? 'airtable-connected' : ''}`}
              onClick={() => setShowSettings(v => !v)}
              title="Airtable settings"
            >
              <Settings size={16} />
              {isAirtableReady && <span className="connected-dot" />}
            </button>

            {showSettings && (
              <div className="settings-panel">
                <div className="settings-title">Airtable</div>

                {authStatus === null ? (
                  <div className="settings-loading">
                    <Loader2 size={14} className="spin-icon" /> Checking...
                  </div>
                ) : isAirtableReady ? (
                  <>
                    <div className="settings-status connected">
                      <Check size={13} />
                      Connected
                    </div>
                    {authStatus.baseId && (
                      <a
                        href={`https://airtable.com/${authStatus.baseId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="settings-link"
                        title={`Open base in Airtable → table: ${authStatus.tableName}`}
                      >
                        <Link2 size={13} />
                        <span>{authStatus.baseName || authStatus.baseId}</span>
                        <ExternalLink size={11} />
                      </a>
                    )}
                    <button className="settings-disconnect" onClick={handleDisconnectAirtable}>
                      <LogOut size={13} />
                      Disconnect
                    </button>
                  </>
                ) : (
                  <>
                    <div className="settings-status disconnected">
                      <X size={13} />
                      Not connected
                    </div>
                    <button className="settings-connect" onClick={() => { handleConnectAirtable(); setShowSettings(false) }}>
                      Connect to Airtable
                    </button>
                    <p className="settings-hint">
                      Connect to upload door views directly to your Airtable base.
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="selection-controls">
        <div className="selection-info">
          {dockSelectedDoorIds.size > 0 ? (
            <span>{dockSelectedDoorIds.size} selected for export</span>
          ) : (
            <span>{doorContexts.length} doors in model (export all)</span>
          )}
        </div>
        <div className="selection-hint">
          Filter and sort in the bottom table. Use checkboxes to export only selected doors; with none checked, export includes every door above.
        </div>
      </div>

      {/* Export Section */}
      <div className="export-section">
        <h3 className="style-options-title">Style Options</h3>
        <div className="style-options">
          <div className="option-row">
            <label>Door</label>
            <input type="color" value={options.doorColor || '#333333'} onChange={(e) => setOptions({ ...options, doorColor: e.target.value })} />
          </div>
          <div className="option-row">
            <label>Wall</label>
            <input type="color" value={options.wallColor || '#5B7DB1'} onChange={(e) => setOptions({ ...options, wallColor: e.target.value })} />
          </div>
          <div className="option-row">
            <label>Device</label>
            <input type="color" value={options.deviceColor || '#CC0000'} onChange={(e) => setOptions({ ...options, deviceColor: e.target.value })} />
          </div>
          <div className="option-row">
            <label>Line Width</label>
            <input type="number" min="0.5" max="5" step="0.5" value={options.lineWidth || 1.5} onChange={(e) => setOptions({ ...options, lineWidth: parseFloat(e.target.value) })} />
          </div>
          <div className="option-row">
            <label>Wall Sides %</label>
            <input type="number" min="0" max="50" step="1" value={Math.round((options.wallRevealSide ?? 0.12) * 100)} onChange={(e) => setOptions({ ...options, wallRevealSide: parseFloat(e.target.value) / 100 })} />
          </div>
          <div className="option-row">
            <label>Wall Top %</label>
            <input type="number" min="0" max="50" step="1" value={Math.round((options.wallRevealTop ?? 0.04) * 100)} onChange={(e) => setOptions({ ...options, wallRevealTop: parseFloat(e.target.value) / 100 })} />
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
          <div className="option-row">
            <label>Text px</label>
            <input
              type="number"
              min={8}
              max={48}
              step={1}
              value={options.fontSize ?? 22}
              onChange={(e) => setOptions({ ...options, fontSize: parseInt(e.target.value, 10) || 22 })}
            />
          </div>
        </div>

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
        <div className="export-toolbar">
          <div className="export-summary">
            <span className="summary-count">{doorsToProcess.length} ready</span>
            <span className={`summary-connection ${isAirtableReady ? 'connected' : 'disconnected'}`}>
              {isAirtableReady ? 'Airtable connected' : 'Airtable not connected'}
            </span>
          </div>
          <div className="export-buttons">
          <button
            className="export-button secondary"
            onClick={() => initiateAction('download')}
            disabled={isProcessing || doorsToProcess.length === 0}
          >
            <Download size={14} />
            <span>{isProcessing && pendingAction === 'download' ? 'Processing...' : 'Export ZIP'}</span>
          </button>

          <button
            className={`export-button airtable ${!isAirtableReady ? 'needs-auth' : ''}`}
            onClick={() => {
              if (!isAirtableReady) {
                handleConnectAirtable()
              } else {
                initiateAction('upload')
              }
            }}
            disabled={isProcessing || (!isAirtableReady ? false : doorsToProcess.length === 0)}
          >
            <Upload size={14} />
            <span>{isProcessing && pendingAction === 'upload'
              ? `Uploading... ${currentIndex}/${doorsToProcess.length}`
              : !isAirtableReady
              ? 'Connect Airtable'
              : 'Upload to Airtable'}</span>
          </button>
          </div>
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
          background: #1a1a1a;
          color: #fff;
          font-size: 13px;
        }

        .panel-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 12px 16px;
          border-bottom: 1px solid #333;
          background: #1a1a1a;
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
          background: #2563eb;
          color: #fff;
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

        .selection-controls {
          display: flex;
          flex-direction: column;
          gap: 12px;
          padding: 12px 16px;
          background: #1a1a1a;
          font-size: 11px;
          color: #888;
        }

        .selection-info {
          font-size: 11px;
          color: #888;
        }

        .selection-hint {
          font-size: 11px;
          line-height: 1.5;
          color: #888;
        }

        .export-section {
          border-top: 1px solid #333;
          padding: 12px 16px;
          background: #1a1a1a;
        }

        .style-options-title {
          margin: 0 0 10px;
          font-size: 12px;
          font-weight: 600;
          color: #aaa;
          text-transform: uppercase;
          letter-spacing: 0.06em;
        }

        .style-options {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 11px 12px;
          padding: 8px 0 12px;
        }

        .option-row {
          display: flex;
          align-items: center;
          gap: 14px;
        }

        .option-row:not(.checkbox) {
          width: 100%;
          min-width: 0;
        }

        .option-row:not(.checkbox) label {
          font-size: 11px;
          color: #888;
          min-width: 0;
          flex: 1;
          text-align: left;
        }

        .option-row:not(.checkbox) input[type="color"],
        .option-row:not(.checkbox) input[type="number"] {
          flex-shrink: 0;
          margin-left: auto;
        }

        .option-row input[type="color"] {
          width: 32px;
          height: 24px;
          border: 1px solid #444;
          border-radius: 4px;
          cursor: pointer;
        }

        .option-row input[type="number"] {
          width: 32px;
          height: 24px;
          padding: 0 1px;
          background: #1a1a1a;
          border: 1px solid #444;
          border-radius: 4px;
          color: #888;
          font-size: 9px;
          font-weight: 500;
          letter-spacing: 0;
          text-align: center;
          box-sizing: border-box;
          -moz-appearance: textfield;
        }

        .option-row input[type="number"]::-webkit-outer-spin-button,
        .option-row input[type="number"]::-webkit-inner-spin-button {
          -webkit-appearance: none;
          margin: 0;
        }

        .option-row.checkbox {
          grid-column: span 2;
        }

        .option-row.checkbox label {
          display: flex;
          align-items: center;
          gap: 6px;
          min-width: auto;
          font-size: 11px;
          color: #888;
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

        .export-toolbar {
          margin-top: 12px;
          padding: 10px;
          border: 1px solid #444;
          border-radius: 10px;
          background: #2a2a2a;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .export-summary {
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 11px;
        }

        .summary-count {
          color: #e5e7eb;
          font-weight: 600;
        }

        .summary-connection {
          color: #9ca3af;
          padding: 2px 8px;
          border-radius: 999px;
          background: #1f2937;
          border: 1px solid #374151;
        }

        .summary-connection.connected {
          color: #86efac;
          background: rgba(34, 197, 94, 0.12);
          border-color: rgba(34, 197, 94, 0.3);
        }

        .summary-connection.disconnected {
          color: #fca5a5;
          background: rgba(239, 68, 68, 0.12);
          border-color: rgba(239, 68, 68, 0.28);
        }

        .export-buttons {
          display: flex;
          flex-direction: row;
          gap: 8px;
        }

        .export-button {
          flex: 1;
          padding: 10px 12px;
          border: 1px solid transparent;
          border-radius: 8px;
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
        }

        .export-button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .export-button.secondary {
          background: #374151;
          border-color: #4b5563;
          color: #e5e7eb;
        }

        .export-button.secondary:hover:not(:disabled) {
          background: #4b5563;
          border-color: #6b7280;
        }

        .export-button.airtable {
          background: #2563eb;
          border-color: #2563eb;
          color: #fff;
        }

        .export-button.airtable:hover:not(:disabled) {
          background: #1d4ed8;
          border-color: #1d4ed8;
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
          min-height: 0;
          overflow: hidden;
          padding: 20px;
          background: #fff;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .image-modal-body :global(svg) {
          display: block;
          max-width: 100%;
          max-height: 100%;
          width: auto;
          height: auto;
          object-fit: contain;
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

        /* Settings panel */
        .settings-wrapper {
          position: relative;
        }

        .icon-button.airtable-connected {
          border-color: #22c55e;
          color: #22c55e;
        }

        .connected-dot {
          position: absolute;
          top: -2px;
          right: -2px;
          width: 8px;
          height: 8px;
          background: #22c55e;
          border-radius: 50%;
          border: 1px solid #2a2a2a;
        }

        .settings-panel {
          position: absolute;
          top: calc(100% + 8px);
          right: 0;
          width: 220px;
          background: #1e1e1e;
          border: 1px solid #444;
          border-radius: 10px;
          padding: 14px;
          z-index: 200;
          box-shadow: 0 8px 24px rgba(0,0,0,0.5);
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .settings-title {
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.8px;
          color: #666;
        }

        .settings-loading {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 12px;
          color: #888;
        }

        .settings-status {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 12px;
          font-weight: 500;
          padding: 6px 8px;
          border-radius: 6px;
        }

        .settings-status.connected {
          background: rgba(34, 197, 94, 0.12);
          color: #22c55e;
        }

        .settings-status.disconnected {
          background: rgba(239, 68, 68, 0.12);
          color: #f87171;
        }

        .settings-link {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 7px 10px;
          background: rgba(78, 205, 196, 0.1);
          border: 1px solid rgba(78, 205, 196, 0.3);
          border-radius: 6px;
          color: #4ecdc4;
          font-size: 12px;
          font-weight: 500;
          text-decoration: none;
          transition: background 0.15s;
          white-space: nowrap;
          overflow: hidden;
        }

        .settings-link span {
          flex: 1;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .settings-link:hover {
          background: rgba(78, 205, 196, 0.2);
        }

        .settings-disconnect {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 7px 10px;
          background: transparent;
          border: 1px solid #555;
          border-radius: 6px;
          color: #f87171;
          font-size: 12px;
          cursor: pointer;
          transition: all 0.15s;
          width: 100%;
        }

        .settings-disconnect:hover {
          background: rgba(239, 68, 68, 0.1);
          border-color: #f87171;
        }

        .settings-connect {
          padding: 8px 12px;
          background: #3b82f6;
          border: none;
          border-radius: 6px;
          color: #fff;
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.15s;
          width: 100%;
        }

        .settings-connect:hover {
          background: #2563eb;
        }

        .settings-hint {
          margin: 0;
          font-size: 11px;
          color: #666;
          line-height: 1.4;
        }

        :global(.spin-icon) {
          animation: spin 1s linear infinite;
        }

        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }

        .export-button.airtable.needs-auth {
          background: #1f2937;
          border: 1px dashed #4b5563;
          color: #cbd5e1;
        }

        .export-button.airtable.needs-auth:hover {
          background: #3b82f6;
          border-color: #3b82f6;
          color: #fff;
        }
      `}</style>
    </div>
  )
}
