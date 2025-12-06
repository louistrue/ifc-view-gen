'use client'

import { useState, useCallback, useEffect } from 'react'
import type { DoorContext } from '@/lib/door-analyzer'
import JSZip from 'jszip'
import { renderDoorViews, renderDoorElevationSVG, renderDoorPlanSVG } from '@/lib/svg-renderer'
import type { SVGRenderOptions } from '@/lib/svg-renderer'

interface BatchProcessorProps {
  doorContexts: DoorContext[]
  onComplete?: () => void
}

export default function BatchProcessor({ doorContexts, onComplete }: BatchProcessorProps) {
  const [isProcessing, setIsProcessing] = useState(false)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
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

  const processAllDoors = useCallback(async () => {
    if (doorContexts.length === 0) {
      setError('No doors found in the model')
      return
    }

    setIsProcessing(true)
    setCurrentIndex(0)
    setProgress(0)
    setError(null)

    const zip = new JSZip()
    // Limit to first 10 doors for testing
    const doorsToProcess = doorContexts.slice(0, 10)
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
    }
  }, [doorContexts, options, onComplete])

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
        {doorContexts.length > 0 ? (
          <p>
            Found {doorContexts.length} door{doorContexts.length !== 1 ? 's' : ''} in the model
          </p>
        ) : (
          <p className="warning-text">
            No doors detected. Check browser console for element types.
            The IFC file may use different naming conventions.
          </p>
        )}
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
          onClick={processAllDoors}
          disabled={isProcessing || doorContexts.length === 0}
          className="generate-button"
        >
          {isProcessing
            ? `Processing... ${currentIndex}/10`
            : `Generate First 10 Door Views (30 SVGs)`}
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
        <h3>Individual Doors</h3>
        <div className="door-items">
          {doorContexts.map((context) => (
            <div key={context.doorId} className="door-item">
              <span className="door-info">
                {context.doorId} - Wall: {context.wall ? 'Found' : 'Not found'} - Devices:{' '}
                {context.nearbyDevices.length}
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
              </div>
            </div>
          ))}
        </div>
      </div>
    </div >
  )
}

