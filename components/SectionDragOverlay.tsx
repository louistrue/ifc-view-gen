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

    const label = direction === 'top' ? 'Drag from top' : 'Drag from bottom'

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
                    opacity: isDragging ? 0 : 1,
                    transition: 'opacity 0.2s',
                    boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
                }}
            >
                <div style={{ fontWeight: 600, marginBottom: '8px', fontSize: '14px' }}>{label}</div>
                <div style={{ color: '#888', fontSize: '12px' }}>
                    Drag to position horizontal section plane
                </div>
                <div style={{ marginTop: '12px', color: '#666', fontSize: '11px' }}>
                    ESC to cancel • F to flip section
                </div>
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
