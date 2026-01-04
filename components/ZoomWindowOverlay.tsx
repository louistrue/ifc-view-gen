'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import type { NavigationManager } from '@/lib/navigation-manager'

interface ZoomWindowOverlayProps {
  active: boolean
  onComplete: () => void
  navigationManager: NavigationManager | null
  containerRef: React.RefObject<HTMLDivElement>
}

export default function ZoomWindowOverlay({
  active,
  onComplete,
  navigationManager,
  containerRef,
}: ZoomWindowOverlayProps) {
  const [isDrawing, setIsDrawing] = useState(false)
  const [startPoint, setStartPoint] = useState({ x: 0, y: 0 })
  const [currentPoint, setCurrentPoint] = useState({ x: 0, y: 0 })
  const overlayRef = useRef<HTMLDivElement>(null)

  const getRelativeCoords = useCallback((e: MouseEvent | React.MouseEvent) => {
    if (!overlayRef.current) return { x: 0, y: 0 }
    const rect = overlayRef.current.getBoundingClientRect()
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    }
  }, [])

  // Handle mouse events directly on the overlay element
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    
    const coords = getRelativeCoords(e.nativeEvent)
    setStartPoint(coords)
    setCurrentPoint(coords)
    setIsDrawing(true)
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDrawing) return
    e.preventDefault()
    e.stopPropagation()
    
    const coords = getRelativeCoords(e.nativeEvent)
    setCurrentPoint(coords)
  }

  const handleMouseUp = (e: React.MouseEvent) => {
    if (!isDrawing) return
    e.preventDefault()
    e.stopPropagation()
    
    const coords = getRelativeCoords(e.nativeEvent)
    setCurrentPoint(coords)
    setIsDrawing(false)

    // Calculate the rectangle
    const rect = {
      x1: Math.min(startPoint.x, coords.x),
      y1: Math.min(startPoint.y, coords.y),
      x2: Math.max(startPoint.x, coords.x),
      y2: Math.max(startPoint.y, coords.y),
    }

    // Only zoom if the rectangle is large enough (at least 20px)
    const width = rect.x2 - rect.x1
    const height = rect.y2 - rect.y1
    
    if (width > 20 && height > 20 && navigationManager && overlayRef.current) {
      navigationManager.zoomToRect(
        rect,
        overlayRef.current.clientWidth,
        overlayRef.current.clientHeight
      )
    }

    onComplete()
  }

  // Global keydown for ESC
  useEffect(() => {
    if (!active) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsDrawing(false)
        onComplete()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [active, onComplete])

  if (!active) return null

  // Calculate rectangle dimensions
  const rectStyle = isDrawing
    ? {
        left: Math.min(startPoint.x, currentPoint.x),
        top: Math.min(startPoint.y, currentPoint.y),
        width: Math.abs(currentPoint.x - startPoint.x),
        height: Math.abs(currentPoint.y - startPoint.y),
      }
    : null

  return (
    <div
      ref={overlayRef}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={() => {
        if (isDrawing) {
          setIsDrawing(false)
        }
      }}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        cursor: 'crosshair',
        zIndex: 1001, // Higher than left sidebar (1000)
        backgroundColor: 'rgba(0, 0, 0, 0.1)',
      }}
    >
      {/* Instructions */}
      <div
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          padding: '12px 20px',
          backgroundColor: 'rgba(32, 32, 32, 0.9)',
          borderRadius: '6px',
          color: '#e0e0e0',
          fontSize: '13px',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          textAlign: 'center',
          pointerEvents: 'none',
          opacity: isDrawing ? 0 : 1,
          transition: 'opacity 0.2s',
        }}
      >
        <div style={{ fontWeight: 500, marginBottom: '4px' }}>Zoom Window</div>
        <div style={{ color: '#888', fontSize: '11px' }}>
          Click and drag to select area • ESC to cancel
        </div>
      </div>

      {/* Selection rectangle */}
      {isDrawing && rectStyle && (
        <div
          style={{
            position: 'absolute',
            left: rectStyle.left,
            top: rectStyle.top,
            width: rectStyle.width,
            height: rectStyle.height,
            border: '2px dashed #3b82f6',
            backgroundColor: 'rgba(59, 130, 246, 0.15)',
            pointerEvents: 'none',
          }}
        />
      )}
    </div>
  )
}

