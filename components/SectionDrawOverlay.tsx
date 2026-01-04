'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import * as THREE from 'three'
import { SectionPlane, getFaceAtPoint } from '@/lib/section-plane'

type SectionMode = 'line' | 'face'

interface SectionDrawOverlayProps {
    active: boolean
    mode: SectionMode
    onComplete: () => void
    onSectionEnabled: () => void  // Called when a section is successfully created
    sectionPlane: SectionPlane | null
    camera: THREE.PerspectiveCamera | null
    scene: THREE.Scene | null
    containerRef: React.RefObject<HTMLDivElement>  // Canvas container for dimension matching
}

export default function SectionDrawOverlay({
    active,
    mode,
    onComplete,
    onSectionEnabled,
    sectionPlane,
    camera,
    scene,
    containerRef,
}: SectionDrawOverlayProps) {
    const [isDrawing, setIsDrawing] = useState(false)
    const [startPoint, setStartPoint] = useState({ x: 0, y: 0 })
    const [currentPoint, setCurrentPoint] = useState({ x: 0, y: 0 })
    const [hoverPoint, setHoverPoint] = useState<{ x: number; y: number } | null>(null)
    const overlayRef = useRef<HTMLDivElement>(null)

    const getRelativeCoords = useCallback((e: React.MouseEvent) => {
        if (!overlayRef.current) return { x: 0, y: 0 }
        // Use canvas container position for accurate mapping to camera projection
        const rect = containerRef.current?.getBoundingClientRect() || overlayRef.current.getBoundingClientRect()
        return {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
        }
    }, [containerRef])

    const handleMouseDown = (e: React.MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()

        const coords = getRelativeCoords(e)

        if (mode === 'line') {
            // Start drawing a line
            setStartPoint(coords)
            setCurrentPoint(coords)
            setIsDrawing(true)
        } else if (mode === 'face') {
            // Click on face to create section
            if (sectionPlane && camera && scene && overlayRef.current) {
                // Use canvas container dimensions to match camera projection
                const width = containerRef.current?.clientWidth || overlayRef.current.clientWidth
                const height = containerRef.current?.clientHeight || overlayRef.current.clientHeight

                const faceData = getFaceAtPoint(
                    coords,
                    camera,
                    scene,
                    width,
                    height
                )

                if (faceData) {
                    sectionPlane.setFromFace(faceData.point, faceData.normal)
                    sectionPlane.enable()
                    onSectionEnabled()
                    onComplete()
                }
            }
        }
    }

    const handleMouseMove = (e: React.MouseEvent) => {
        const coords = getRelativeCoords(e)
        setHoverPoint(coords)

        if (isDrawing && mode === 'line') {
            e.preventDefault()
            e.stopPropagation()
            setCurrentPoint(coords)
        }
    }

    const handleMouseUp = (e: React.MouseEvent) => {
        if (!isDrawing || mode !== 'line') return
        e.preventDefault()
        e.stopPropagation()

        const coords = getRelativeCoords(e)
        setCurrentPoint(coords)
        setIsDrawing(false)

        // Calculate line length
        const dx = coords.x - startPoint.x
        const dy = coords.y - startPoint.y
        const length = Math.sqrt(dx * dx + dy * dy)

        // Only create section if line is long enough
        if (length > 30 && sectionPlane && camera && overlayRef.current) {
            // Use canvas container dimensions to match camera projection exactly
            const width = containerRef.current?.clientWidth || overlayRef.current.clientWidth
            const height = containerRef.current?.clientHeight || overlayRef.current.clientHeight

            const startNDC = {
                x: (startPoint.x / width) * 2 - 1,
                y: -((startPoint.y / height) * 2 - 1)
            }
            const endNDC = {
                x: (coords.x / width) * 2 - 1,
                y: -((coords.y / height) * 2 - 1)
            }

            sectionPlane.setFromScreenLine(startNDC, endNDC, camera)
            sectionPlane.enable()
            onSectionEnabled()
        }

        onComplete()
    }

    // ESC to cancel
    useEffect(() => {
        if (!active) return

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setIsDrawing(false)
                onComplete()
            }
            // F to flip section
            if ((e.key === 'f' || e.key === 'F') && sectionPlane?.isEnabled()) {
                sectionPlane.flip()
            }
        }

        document.addEventListener('keydown', handleKeyDown)
        return () => document.removeEventListener('keydown', handleKeyDown)
    }, [active, onComplete, sectionPlane])

    if (!active) return null

    // Calculate line angle for display
    const lineAngle = isDrawing
        ? Math.atan2(currentPoint.y - startPoint.y, currentPoint.x - startPoint.x) * (180 / Math.PI)
        : 0

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
                setHoverPoint(null)
            }}
            style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                cursor: mode === 'line' ? 'crosshair' : 'pointer',
                zIndex: 1001,
                backgroundColor: 'rgba(0, 0, 0, 0.05)',
            }}
        >
            {/* Instructions */}
            <div
                style={{
                    position: 'absolute',
                    top: '50%',
                    left: '50%',
                    transform: 'translate(-50%, -50%)',
                    padding: '16px 24px',
                    backgroundColor: 'rgba(32, 32, 32, 0.95)',
                    borderRadius: '8px',
                    color: '#e0e0e0',
                    fontSize: '13px',
                    fontFamily: 'system-ui, -apple-system, sans-serif',
                    textAlign: 'center',
                    pointerEvents: 'none',
                    opacity: isDrawing ? 0 : 1,
                    transition: 'opacity 0.2s',
                    boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
                }}
            >
                <div style={{ fontWeight: 600, marginBottom: '8px', fontSize: '14px' }}>
                    {mode === 'line' ? 'Draw Section Line' : 'Click Face for Section'}
                </div>
                <div style={{ color: '#888', fontSize: '12px', lineHeight: 1.5 }}>
                    {mode === 'line' ? (
                        <>
                            Draw a line to create a section plane<br />
                            The model will be cut perpendicular to your line
                        </>
                    ) : (
                        <>
                            Click on any face to create a section<br />
                            The section will align to the face plane
                        </>
                    )}
                </div>
                <div style={{ marginTop: '12px', color: '#666', fontSize: '11px' }}>
                    ESC to cancel • F to flip section
                </div>
            </div>

            {/* Section line being drawn */}
            {isDrawing && mode === 'line' && (
                <>
                    {/* Main line */}
                    <svg
                        style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: '100%',
                            height: '100%',
                            pointerEvents: 'none',
                        }}
                    >
                        <line
                            x1={startPoint.x}
                            y1={startPoint.y}
                            x2={currentPoint.x}
                            y2={currentPoint.y}
                            stroke="#4ecdc4"
                            strokeWidth="3"
                            strokeDasharray="8,4"
                        />
                        {/* Direction indicator arrows */}
                        <g transform={`translate(${(startPoint.x + currentPoint.x) / 2}, ${(startPoint.y + currentPoint.y) / 2}) rotate(${lineAngle + 90})`}>
                            <polygon
                                points="0,-15 8,5 -8,5"
                                fill="#4ecdc4"
                                opacity="0.9"
                            />
                        </g>
                        {/* Start point */}
                        <circle
                            cx={startPoint.x}
                            cy={startPoint.y}
                            r="6"
                            fill="#4ecdc4"
                        />
                        {/* End point */}
                        <circle
                            cx={currentPoint.x}
                            cy={currentPoint.y}
                            r="6"
                            fill="#4ecdc4"
                        />
                    </svg>

                    {/* Cut direction label */}
                    <div
                        style={{
                            position: 'absolute',
                            left: (startPoint.x + currentPoint.x) / 2 + 20,
                            top: (startPoint.y + currentPoint.y) / 2 - 10,
                            backgroundColor: '#4ecdc4',
                            color: '#1a1a1a',
                            padding: '4px 8px',
                            borderRadius: '4px',
                            fontSize: '11px',
                            fontWeight: 600,
                            pointerEvents: 'none',
                        }}
                    >
                        CUT
                    </div>
                </>
            )}

            {/* Face mode hover indicator */}
            {mode === 'face' && hoverPoint && !isDrawing && (
                <div
                    style={{
                        position: 'absolute',
                        left: hoverPoint.x - 15,
                        top: hoverPoint.y - 15,
                        width: 30,
                        height: 30,
                        border: '2px solid #4ecdc4',
                        borderRadius: '50%',
                        pointerEvents: 'none',
                        backgroundColor: 'rgba(78, 205, 196, 0.15)',
                    }}
                />
            )}
        </div>
    )
}

