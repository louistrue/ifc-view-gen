'use client'

import { useState, useCallback, useMemo, useRef } from 'react'
import type { WallContext } from '@/lib/wall-analyzer'
import { filterWalls } from '@/lib/wall-analyzer'
import type { ElementVisibilityManager } from '@/lib/element-visibility-manager'
import type { NavigationManager } from '@/lib/navigation-manager'
import JSZip from 'jszip'
import { renderWallViews, renderWallElevationSVG, renderWallPlanSVG } from '@/lib/wall-svg-renderer'
import type { WallSVGRenderOptions } from '@/lib/wall-svg-renderer'
import { Download } from 'lucide-react'

interface WallPanelProps {
  wallContexts: WallContext[]
  visibilityManager: ElementVisibilityManager | null
  navigationManager: NavigationManager | null
  onComplete?: () => void
  onShowSingleWallReady?: (fn: ((wall: WallContext, view: 'front' | 'back' | 'plan') => void) | null) => void
}

export default function WallPanel({
  wallContexts,
  visibilityManager,
  navigationManager,
  onComplete,
  onShowSingleWallReady,
}: WallPanelProps) {
  // Filter state
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedStoreys, setSelectedStoreys] = useState<Set<string>>(new Set())
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set())
  const [storeyExpanded, setStoreyExpanded] = useState(false)
  const [typeExpanded, setTypeExpanded] = useState(true)

  // Selection state
  const [selectedWallIds, setSelectedWallIds] = useState<Set<string>>(new Set())

  // UI state
  const [showFilters, setShowFilters] = useState(true)
  const [showStyleOptions, setShowStyleOptions] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [modalImage, setModalImage] = useState<{ svg: string; wallId: string; view: string } | null>(null)
  const [sortField, setSortField] = useState<'wall' | 'type' | 'storey'>('wall')
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc')

  // Refs
  const listContainerRef = useRef<HTMLDivElement>(null)

  // SVG render options
  const [options, setOptions] = useState<WallSVGRenderOptions>({
    width: 1200,
    height: 800,
    margin: 0.5,
    wallColor: '#5B7DB1',
    windowColor: '#7EC8E3',
    doorColor: '#8B6914',
    electricalColor: '#CC0000',
    lineWidth: 1.5,
    lineColor: '#000000',
    showFills: true,
    showLegend: true,
    showLabels: true,
    fontSize: 14,
    fontFamily: 'Arial',
  })

  // Available storeys
  const availableStoreys = useMemo(() => {
    const wallsForStoreyFacet = filterWalls(wallContexts, { wallTypes: Array.from(selectedTypes) })
    const storeys = new Map<string, number>()
    wallsForStoreyFacet.forEach(wall => {
      if (wall.storeyName) storeys.set(wall.storeyName, (storeys.get(wall.storeyName) || 0) + 1)
    })
    selectedStoreys.forEach(storey => { if (!storeys.has(storey)) storeys.set(storey, 0) })
    return Array.from(storeys.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [wallContexts, selectedTypes, selectedStoreys])

  // Available types
  const availableTypes = useMemo(() => {
    const wallsForTypeFacet = filterWalls(wallContexts, { storeys: Array.from(selectedStoreys) })
    const types = new Map<string, number>()
    wallsForTypeFacet.forEach(wall => {
      if (wall.wallTypeName) types.set(wall.wallTypeName, (types.get(wall.wallTypeName) || 0) + 1)
    })
    selectedTypes.forEach(type => { if (!types.has(type)) types.set(type, 0) })
    return Array.from(types.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [wallContexts, selectedStoreys, selectedTypes])

  // Apply filters
  const filteredWalls = useMemo(() => {
    let result = filterWalls(wallContexts, {
      wallTypes: Array.from(selectedTypes),
      storeys: Array.from(selectedStoreys),
    })

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase()
      result = result.filter(wall =>
        wall.wallId.toLowerCase().includes(query) ||
        (wall.wall.name?.toLowerCase().includes(query)) ||
        (wall.wallTypeName?.toLowerCase().includes(query)) ||
        (wall.storeyName?.toLowerCase().includes(query))
      )
    }

    return result
  }, [wallContexts, selectedTypes, selectedStoreys, searchQuery])

  // Walls to process
  const wallsToProcess = useMemo(() => {
    if (selectedWallIds.size > 0) {
      return filteredWalls.filter(w => selectedWallIds.has(w.wallId))
    }
    return filteredWalls
  }, [filteredWalls, selectedWallIds])

  const getWallLabel = useCallback((wall: WallContext) => {
    return wall.wall.name || wall.wallTypeName || wall.wallId
  }, [])

  const sortedWalls = useMemo(() => {
    const walls = [...filteredWalls]
    walls.sort((a, b) => {
      const aValue = sortField === 'wall' ? getWallLabel(a) : sortField === 'type' ? (a.wallTypeName || '') : (a.storeyName || '')
      const bValue = sortField === 'wall' ? getWallLabel(b) : sortField === 'type' ? (b.wallTypeName || '') : (b.storeyName || '')
      const compared = aValue.localeCompare(bValue, undefined, { numeric: true, sensitivity: 'base' })
      return sortDirection === 'asc' ? compared : -compared
    })
    return walls
  }, [filteredWalls, sortField, sortDirection, getWallLabel])

  // Show single wall SVG in modal
  const showSingleWall = useCallback(async (wall: WallContext, view: 'front' | 'back' | 'plan') => {
    try {
      let svg: string
      if (view === 'plan') {
        svg = await renderWallPlanSVG(wall, options)
      } else {
        svg = await renderWallElevationSVG(wall, view === 'back', options)
      }
      setModalImage({ svg, wallId: wall.wallId, view })
    } catch (err) {
      console.error('Failed to render wall SVG:', err)
    }
  }, [options])

  // Register callback
  if (onShowSingleWallReady) {
    onShowSingleWallReady(showSingleWall)
  }

  // Export all walls as ZIP
  const handleExport = async () => {
    if (wallsToProcess.length === 0) return
    setIsProcessing(true)
    setProgress(0)
    setError(null)

    try {
      const zip = new JSZip()
      const total = wallsToProcess.length

      for (let i = 0; i < total; i++) {
        const wall = wallsToProcess[i]
        const label = getWallLabel(wall).replace(/[^a-zA-Z0-9_-]/g, '_')

        try {
          const views = await renderWallViews(wall, options)
          zip.file(`${label}_front.svg`, views.front)
          zip.file(`${label}_back.svg`, views.back)
          zip.file(`${label}_plan.svg`, views.plan)
        } catch (err) {
          console.error(`Failed to render wall ${wall.wallId}:`, err)
        }

        setProgress(((i + 1) / total) * 100)
      }

      const blob = await zip.generateAsync({ type: 'blob' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `wall-views-${new Date().toISOString().slice(0, 10)}.zip`
      link.click()
      URL.revokeObjectURL(url)
      onComplete?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed')
    } finally {
      setIsProcessing(false)
      setProgress(0)
    }
  }

  const sortIndicator = (field: typeof sortField) =>
    sortField !== field ? '↕' : sortDirection === 'asc' ? '↑' : '↓'

  const toggleSort = (field: typeof sortField) => {
    if (sortField === field) {
      setSortDirection(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDirection('asc')
    }
  }

  return (
    <div style={{
      width: '380px',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      backgroundColor: '#1e1e1e',
      color: '#e0e0e0',
      fontSize: '13px',
      overflow: 'hidden',
      borderLeft: '1px solid #333',
    }}>
      {/* Header */}
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid #333',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: '15px' }}>Wall Viewer</div>
          <div style={{ color: '#888', fontSize: '12px', marginTop: '2px' }}>
            {filteredWalls.length} of {wallContexts.length} walls
            {selectedWallIds.size > 0 && ` (${selectedWallIds.size} selected)`}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            type="button"
            onClick={() => setShowFilters(!showFilters)}
            style={{
              background: showFilters ? '#3b82f6' : '#333',
              border: 'none',
              borderRadius: '4px',
              color: '#fff',
              padding: '4px 8px',
              cursor: 'pointer',
              fontSize: '11px',
            }}
          >
            Filters
          </button>
          <button
            type="button"
            onClick={() => setShowStyleOptions(!showStyleOptions)}
            style={{
              background: showStyleOptions ? '#3b82f6' : '#333',
              border: 'none',
              borderRadius: '4px',
              color: '#fff',
              padding: '4px 8px',
              cursor: 'pointer',
              fontSize: '11px',
            }}
          >
            Style
          </button>
        </div>
      </div>

      {/* Search */}
      <div style={{ padding: '8px 16px' }}>
        <input
          type="text"
          placeholder="Search walls..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          style={{
            width: '100%',
            padding: '6px 8px',
            backgroundColor: '#2a2a2a',
            border: '1px solid #444',
            borderRadius: '4px',
            color: '#e0e0e0',
            fontSize: '12px',
            outline: 'none',
          }}
        />
      </div>

      {/* Filters */}
      {showFilters && (
        <div style={{ padding: '0 16px 8px', maxHeight: '200px', overflowY: 'auto' }}>
          {/* Storey filter */}
          <div style={{ marginBottom: '8px' }}>
            <button
              type="button"
              onClick={() => setStoreyExpanded(!storeyExpanded)}
              style={{
                background: 'none', border: 'none', color: '#aaa', cursor: 'pointer',
                padding: '2px 0', fontSize: '11px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px',
              }}
            >
              {storeyExpanded ? '▼' : '▶'} STOREY
              {selectedStoreys.size > 0 && (
                <span style={{ color: '#3b82f6', fontWeight: 400 }}>({selectedStoreys.size})</span>
              )}
            </button>
            {storeyExpanded && availableStoreys.map(([storey, count]) => (
              <label key={storey} style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '1px 0 1px 12px', fontSize: '11px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={selectedStoreys.has(storey)}
                  onChange={() => {
                    const next = new Set(selectedStoreys)
                    next.has(storey) ? next.delete(storey) : next.add(storey)
                    setSelectedStoreys(next)
                  }}
                  style={{ margin: 0 }}
                />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{storey}</span>
                <span style={{ color: '#666', fontSize: '10px' }}>({count})</span>
              </label>
            ))}
          </div>

          {/* Type filter */}
          <div>
            <button
              type="button"
              onClick={() => setTypeExpanded(!typeExpanded)}
              style={{
                background: 'none', border: 'none', color: '#aaa', cursor: 'pointer',
                padding: '2px 0', fontSize: '11px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px',
              }}
            >
              {typeExpanded ? '▼' : '▶'} TYPE
              {selectedTypes.size > 0 && (
                <span style={{ color: '#3b82f6', fontWeight: 400 }}>({selectedTypes.size})</span>
              )}
            </button>
            {typeExpanded && availableTypes.map(([type, count]) => (
              <label key={type} style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '1px 0 1px 12px', fontSize: '11px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={selectedTypes.has(type)}
                  onChange={() => {
                    const next = new Set(selectedTypes)
                    next.has(type) ? next.delete(type) : next.add(type)
                    setSelectedTypes(next)
                  }}
                  style={{ margin: 0 }}
                />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{type}</span>
                <span style={{ color: '#666', fontSize: '10px' }}>({count})</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Style options */}
      {showStyleOptions && (
        <div style={{ padding: '8px 16px', borderBottom: '1px solid #333' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', fontSize: '11px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              Wall
              <input type="color" value={options.wallColor} onChange={e => setOptions(o => ({ ...o, wallColor: e.target.value }))} style={{ width: '24px', height: '18px', border: 'none', cursor: 'pointer' }} />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              Window
              <input type="color" value={options.windowColor} onChange={e => setOptions(o => ({ ...o, windowColor: e.target.value }))} style={{ width: '24px', height: '18px', border: 'none', cursor: 'pointer' }} />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              Door
              <input type="color" value={options.doorColor} onChange={e => setOptions(o => ({ ...o, doorColor: e.target.value }))} style={{ width: '24px', height: '18px', border: 'none', cursor: 'pointer' }} />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              Electrical
              <input type="color" value={options.electricalColor} onChange={e => setOptions(o => ({ ...o, electricalColor: e.target.value }))} style={{ width: '24px', height: '18px', border: 'none', cursor: 'pointer' }} />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <input type="checkbox" checked={options.showFills} onChange={e => setOptions(o => ({ ...o, showFills: e.target.checked }))} />
              Fills
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <input type="checkbox" checked={options.showLegend} onChange={e => setOptions(o => ({ ...o, showLegend: e.target.checked }))} />
              Legend
            </label>
          </div>
        </div>
      )}

      {/* Wall list */}
      <div ref={listContainerRef} style={{ flex: 1, overflowY: 'auto', padding: '0 8px' }}>
        {/* Column headers */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '28px 1fr 80px 60px 60px 60px',
          gap: '2px',
          padding: '4px 8px',
          borderBottom: '1px solid #333',
          fontSize: '10px',
          color: '#888',
          fontWeight: 600,
          position: 'sticky',
          top: 0,
          backgroundColor: '#1e1e1e',
          zIndex: 1,
        }}>
          <div />
          <button type="button" onClick={() => toggleSort('wall')} style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', textAlign: 'left', padding: 0, fontSize: '10px', fontWeight: 600 }}>
            Wall {sortIndicator('wall')}
          </button>
          <button type="button" onClick={() => toggleSort('type')} style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', textAlign: 'left', padding: 0, fontSize: '10px', fontWeight: 600 }}>
            Type {sortIndicator('type')}
          </button>
          <div>Win</div>
          <div>Elec</div>
          <div>Views</div>
        </div>

        {sortedWalls.map(wall => {
          const isSelected = selectedWallIds.has(wall.wallId)
          return (
            <div
              key={wall.wallId}
              style={{
                display: 'grid',
                gridTemplateColumns: '28px 1fr 80px 60px 60px 60px',
                gap: '2px',
                padding: '4px 8px',
                borderBottom: '1px solid #2a2a2a',
                backgroundColor: isSelected ? 'rgba(59, 130, 246, 0.1)' : 'transparent',
                cursor: 'pointer',
                alignItems: 'center',
                fontSize: '11px',
              }}
              onClick={() => {
                if (navigationManager && wall.wall.boundingBox) {
                  navigationManager.zoomToElementFromNormal(wall.wall.boundingBox, wall.normal, 2.5)
                }
              }}
            >
              <input
                type="checkbox"
                checked={isSelected}
                onChange={() => {
                  const next = new Set(selectedWallIds)
                  next.has(wall.wallId) ? next.delete(wall.wallId) : next.add(wall.wallId)
                  setSelectedWallIds(next)
                }}
                onClick={e => e.stopPropagation()}
                style={{ margin: 0, cursor: 'pointer' }}
              />
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {getWallLabel(wall)}
              </div>
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#888' }}>
                {wall.wallTypeName || '—'}
              </div>
              <div style={{ color: wall.windows.length > 0 ? '#7EC8E3' : '#555' }}>
                {wall.windows.length || '—'}
              </div>
              <div style={{ color: wall.electricalDevices.length > 0 ? '#CC0000' : '#555' }}>
                {wall.electricalDevices.length || '—'}
              </div>
              <div style={{ display: 'flex', gap: '2px' }}>
                <button
                  type="button"
                  title="Front elevation"
                  onClick={e => { e.stopPropagation(); showSingleWall(wall, 'front') }}
                  style={{ background: 'none', border: '1px solid #444', borderRadius: '2px', color: '#aaa', cursor: 'pointer', padding: '1px 3px', fontSize: '9px' }}
                >
                  F
                </button>
                <button
                  type="button"
                  title="Plan view"
                  onClick={e => { e.stopPropagation(); showSingleWall(wall, 'plan') }}
                  style={{ background: 'none', border: '1px solid #444', borderRadius: '2px', color: '#aaa', cursor: 'pointer', padding: '1px 3px', fontSize: '9px' }}
                >
                  P
                </button>
              </div>
            </div>
          )
        })}

        {sortedWalls.length === 0 && (
          <div style={{ padding: '20px', textAlign: 'center', color: '#666' }}>
            No walls with hosted components found
          </div>
        )}
      </div>

      {/* Export button */}
      <div style={{ padding: '12px 16px', borderTop: '1px solid #333' }}>
        {isProcessing ? (
          <div>
            <div style={{ height: '4px', backgroundColor: '#333', borderRadius: '2px', overflow: 'hidden', marginBottom: '8px' }}>
              <div style={{ height: '100%', width: `${progress}%`, backgroundColor: '#3b82f6', transition: 'width 0.3s' }} />
            </div>
            <div style={{ textAlign: 'center', fontSize: '11px', color: '#888' }}>
              Generating SVGs... {Math.round(progress)}%
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={handleExport}
            disabled={wallsToProcess.length === 0}
            style={{
              width: '100%',
              padding: '8px 16px',
              backgroundColor: wallsToProcess.length > 0 ? '#3b82f6' : '#333',
              border: 'none',
              borderRadius: '6px',
              color: '#fff',
              cursor: wallsToProcess.length > 0 ? 'pointer' : 'not-allowed',
              fontSize: '13px',
              fontWeight: 500,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
            }}
          >
            <Download size={14} />
            Export {wallsToProcess.length} Wall{wallsToProcess.length !== 1 ? 's' : ''} as SVG
          </button>
        )}
        {error && (
          <div style={{ color: '#ef4444', fontSize: '11px', marginTop: '8px', textAlign: 'center' }}>{error}</div>
        )}
      </div>

      {/* SVG Preview Modal */}
      {modalImage && (
        <div
          style={{
            position: 'fixed',
            top: 0, left: 0, right: 0, bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.8)',
            zIndex: 10000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
          }}
          onClick={() => setModalImage(null)}
        >
          <div
            style={{
              maxWidth: '90vw',
              maxHeight: '90vh',
              backgroundColor: '#fff',
              borderRadius: '8px',
              overflow: 'auto',
              padding: '16px',
            }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px', alignItems: 'center' }}>
              <div style={{ fontWeight: 600, color: '#333' }}>
                {modalImage.view === 'front' ? 'Front Elevation' : modalImage.view === 'back' ? 'Back Elevation' : 'Plan View'}
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  type="button"
                  onClick={() => {
                    const blob = new Blob([modalImage.svg], { type: 'image/svg+xml' })
                    const url = URL.createObjectURL(blob)
                    const link = document.createElement('a')
                    link.href = url
                    link.download = `wall-${modalImage.wallId}-${modalImage.view}.svg`
                    link.click()
                    URL.revokeObjectURL(url)
                  }}
                  style={{
                    background: '#3b82f6', border: 'none', borderRadius: '4px', color: '#fff',
                    padding: '4px 12px', cursor: 'pointer', fontSize: '12px',
                  }}
                >
                  Download SVG
                </button>
                <button
                  type="button"
                  onClick={() => setModalImage(null)}
                  style={{
                    background: '#666', border: 'none', borderRadius: '4px', color: '#fff',
                    padding: '4px 12px', cursor: 'pointer', fontSize: '12px',
                  }}
                >
                  Close
                </button>
              </div>
            </div>
            <div dangerouslySetInnerHTML={{ __html: modalImage.svg }} />
          </div>
        </div>
      )}
    </div>
  )
}
