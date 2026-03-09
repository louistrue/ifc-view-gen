'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import * as THREE from 'three'
import { SectionPlane } from '@/lib/section-plane'

interface SectionAdjustOverlayProps {
    active: boolean
    sectionPlane: SectionPlane | null
    containerRef: React.RefObject<HTMLDivElement>
    triggerRender?: () => void
    rightPaletteOffsetPx?: number
}

export default function SectionAdjustOverlay({
    active,
    sectionPlane,
    containerRef,
    triggerRender,
    rightPaletteOffsetPx = 0,
}: SectionAdjustOverlayProps) {
    const [isDragging, setIsDragging] = useState(false)
    const [shiftHeld, setShiftHeld] = useState(false)
    const lastYRef = useRef(0)

    const handlePointerDown = (e: React.PointerEvent) => {
        if (!active || !sectionPlane?.isEnabled() || !e.shiftKey) return
        e.preventDefault()
        e.stopPropagation()
        lastYRef.current = e.clientY
        setIsDragging(true)
    }

    const handlePointerMove = useCallback(
        (e: PointerEvent) => {
            if (!isDragging || !sectionPlane) return
            if (!e.shiftKey) {
                setIsDragging(false)
                return
            }

            const deltaY = e.clientY - lastYRef.current
            lastYRef.current = e.clientY

            const rect = containerRef.current?.getBoundingClientRect()
            if (!rect) return

            const bounds = sectionPlane.getBounds()
            const size = bounds.getSize(new THREE.Vector3())
            const maxDim = Math.max(size.x, size.y, size.z)
            const sensitivity = (maxDim / rect.height) * 2
            const offsetDelta = deltaY * sensitivity

            sectionPlane.offset(offsetDelta)
            triggerRender?.()
        },
        [isDragging, sectionPlane, containerRef, triggerRender]
    )

    const handlePointerUp = useCallback(() => {
        setIsDragging(false)
    }, [])

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Shift') setShiftHeld(true)
        }
        const onKeyUp = (e: KeyboardEvent) => {
            if (e.key === 'Shift') {
                setShiftHeld(false)
                setIsDragging(false)
            }
        }
        window.addEventListener('keydown', onKeyDown)
        window.addEventListener('keyup', onKeyUp)
        return () => {
            window.removeEventListener('keydown', onKeyDown)
            window.removeEventListener('keyup', onKeyUp)
        }
    }, [])

    useEffect(() => {
        if (!active) return

        window.addEventListener('pointermove', handlePointerMove)
        window.addEventListener('pointerup', handlePointerUp)
        window.addEventListener('pointercancel', handlePointerUp)
        return () => {
            window.removeEventListener('pointermove', handlePointerMove)
            window.removeEventListener('pointerup', handlePointerUp)
            window.removeEventListener('pointercancel', handlePointerUp)
        }
    }, [active, handlePointerMove, handlePointerUp])

    if (!active) return null

    return (
        <div
            onPointerDown={handlePointerDown}
            style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                cursor: shiftHeld ? 'ns-resize' : 'default',
                zIndex: 999,
                pointerEvents: shiftHeld ? 'auto' : 'none',
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
                F — Flip  •  Shift — Schieben
            </div>
            {isDragging && (
                <div
                    style={{
                        position: 'absolute',
                        top: '50%',
                        left: '50%',
                        transform: 'translate(-50%, -50%)',
                        padding: '8px 16px',
                        backgroundColor: 'rgba(32, 32, 32, 0.9)',
                        borderRadius: '6px',
                        color: '#e0e0e0',
                        fontSize: '12px',
                        pointerEvents: 'none',
                    }}
                >
                    Shift + Drag — Section verschieben
                </div>
            )}
        </div>
    )
}
