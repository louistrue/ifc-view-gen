'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import * as THREE from 'three'
import { SectionPlane } from '@/lib/section-plane'

export type SectionDragDirection = 'top' | 'bottom'

interface SectionDragOverlayProps {
    active: boolean
    direction: SectionDragDirection
    onComplete: () => void
    onSectionEnabled: () => void
    sectionPlane: SectionPlane | null
    camera: THREE.PerspectiveCamera | null
    containerRef: React.RefObject<HTMLDivElement>
    triggerRender?: () => void
    rightPaletteOffsetPx?: number
}

export default function SectionDragOverlay({
    active,
    direction,
    onComplete,
    onSectionEnabled,
    sectionPlane,
    camera,
    containerRef,
    triggerRender,
    rightPaletteOffsetPx = 0,
}: SectionDragOverlayProps) {
    const [isDragging, setIsDragging] = useState(false)
    const [currentY, setCurrentY] = useState(0)
    const overlayRef = useRef<HTMLDivElement>(null)

    const screenYToWorldY = useCallback(
        (screenY: number): number => {
            if (!containerRef.current || !camera || !sectionPlane) return 0
            const rect = containerRef.current.getBoundingClientRect()
            const bounds = sectionPlane.getBounds()
            const minY = bounds.min.y
            const maxY = bounds.max.y

            // screenY: 0 = top of view, rect.height = bottom
            // direction top: drag from top down -> start at maxY, drag down decreases world Y
            // direction bottom: drag from bottom up -> start at minY, drag up increases world Y
            const t = 1 - screenY / rect.height // 0 at bottom, 1 at top
            return minY + t * (maxY - minY)
        },
        [containerRef, camera, sectionPlane, direction]
    )

    const handleMouseDown = (e: React.MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        if (!overlayRef.current || !sectionPlane) return

        const rect = containerRef.current?.getBoundingClientRect() || overlayRef.current.getBoundingClientRect()
        const localY = e.clientY - rect.top
        const worldY = screenYToWorldY(localY)

        sectionPlane.setByDirection(direction === 'top' ? 'bottom' : 'top', worldY)
        sectionPlane.enable()
        sectionPlane.flip() // Start inverted per user preference
        onSectionEnabled()

        setIsDragging(true)
        setCurrentY(localY)
        triggerRender?.()
    }

    const handleMouseMove = (e: React.MouseEvent) => {
        if (!isDragging || !sectionPlane) return
        e.preventDefault()
        e.stopPropagation()

        const rect = containerRef.current?.getBoundingClientRect() || overlayRef.current.getBoundingClientRect()
        const localY = e.clientY - rect.top
        const worldY = screenYToWorldY(localY)

        sectionPlane.setByDirection(direction === 'top' ? 'bottom' : 'top', worldY)
        setCurrentY(localY)
        triggerRender?.()
    }

    const handleMouseUp = (e: React.MouseEvent) => {
        if (!isDragging) return
        e.preventDefault()
        e.stopPropagation()
        setIsDragging(false)
        onComplete()
        triggerRender?.()
    }

    useEffect(() => {
        if (!active) return

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setIsDragging(false)
                sectionPlane?.disable()
                triggerRender?.()
                onComplete()
            }
            if ((e.key === 'f' || e.key === 'F') && sectionPlane?.isEnabled()) {
                sectionPlane.flip()
                triggerRender?.()
            }
        }

        document.addEventListener('keydown', handleKeyDown)
        return () => document.removeEventListener('keydown', handleKeyDown)
    }, [active, onComplete, sectionPlane, triggerRender])

    if (!active) return null

    return (
        <div
            ref={overlayRef}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={() => {
                if (isDragging) {
                    setIsDragging(false)
                    onComplete()
                    triggerRender?.()
                }
            }}
            style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                cursor: 'ns-resize',
                zIndex: 1001,
                backgroundColor: 'rgba(0, 0, 0, 0.05)',
            }}
        >
            {/* Help text top center - between left edge and right palette */}
            <div
                style={{
                    position: 'absolute',
                    top: '12px',
                    left: `calc((100% - ${rightPaletteOffsetPx}px) / 2)`,
                    transform: 'translateX(-50%)',
                    padding: '6px 14px',
                    backgroundColor: 'rgba(32, 32, 32, 0.9)',
                    borderRadius: '6px',
                    color: '#e0e0e0',
                    fontSize: '12px',
                    fontFamily: 'system-ui, -apple-system, sans-serif',
                    pointerEvents: 'none',
                }}
            >
                F — Flip  •  Shift — Schieben  •  ESC — Abbrechen
            </div>

            {isDragging && containerRef.current && (
                <div
                    style={{
                        position: 'absolute',
                        left: 0,
                        right: 0,
                        top: currentY,
                        height: '2px',
                        backgroundColor: '#4ecdc4',
                        pointerEvents: 'none',
                        boxShadow: '0 0 8px rgba(78, 205, 196, 0.6)',
                    }}
                />
            )}
        </div>
    )
}
