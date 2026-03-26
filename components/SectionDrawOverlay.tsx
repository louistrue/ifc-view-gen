'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import * as THREE from 'three'
import { SectionPlaneManager } from '@/lib/section-plane'

type SectionMode = 'line'

interface SectionDrawOverlayProps {
    active: boolean
    mode: SectionMode
    onComplete: () => void
    onSectionEnabled: () => void  // Called when a section is successfully created
    sectionPlaneManager: SectionPlaneManager | null
    camera: THREE.PerspectiveCamera | null
    scene: THREE.Scene | null
    containerRef: React.RefObject<HTMLDivElement>  // Canvas container for dimension matching
    triggerRender?: () => void  // Callback to trigger scene render
    rightPaletteOffsetPx?: number  // Right palette width when visible (for centering hint)
}

export default function SectionDrawOverlay({
    active,
    mode,
    onComplete,
    onSectionEnabled,
    sectionPlaneManager,
    camera,
    scene,
    containerRef,
    triggerRender,
    rightPaletteOffsetPx = 0,
}: SectionDrawOverlayProps) {
    const [isDrawing, setIsDrawing] = useState(false)
    const [startPoint, setStartPoint] = useState({ x: 0, y: 0 })
    const [currentPoint, setCurrentPoint] = useState({ x: 0, y: 0 })
    const [shiftHeld, setShiftHeld] = useState(false)
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

    // Snap to 0°, 90°, 180°, 270° in world XZ plane when Shift is held (independent of camera rotation)
    const SNAP_ANGLES = [0, Math.PI / 2, Math.PI, -Math.PI / 2] as const

    const getConstrainedResult = useCallback((
        start: { x: number; y: number },
        current: { x: number; y: number },
        shift: boolean,
        width: number,
        height: number
    ): {
        screenCoords: { x: number; y: number }
        startNDC?: { x: number; y: number }
        endNDC?: { x: number; y: number }
        startWorld?: THREE.Vector3
        endWorld?: THREE.Vector3
    } => {
        if (!shift || !camera || !sectionPlaneManager) {
            return { screenCoords: current }
        }

        const dx = current.x - start.x
        const dy = current.y - start.y
        const length = Math.sqrt(dx * dx + dy * dy)
        if (length < 0.001) return { screenCoords: current }

        // Convert screen points to world points on the view plane through model center
        const bounds = sectionPlaneManager.getBounds()
        const boundsCenter = bounds.getCenter(new THREE.Vector3())
        const viewDir = new THREE.Vector3()
        camera.getWorldDirection(viewDir)
        const viewPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(viewDir, boundsCenter)

        const toWorld = (px: number, py: number) => {
            const ndcX = (px / width) * 2 - 1
            const ndcY = -((py / height) * 2 - 1)
            const near = new THREE.Vector3(ndcX, ndcY, 0).unproject(camera)
            const far = new THREE.Vector3(ndcX, ndcY, 1).unproject(camera)
            const dir = new THREE.Vector3().subVectors(far, near).normalize()
            const ray = new THREE.Ray(near, dir)
            const point = new THREE.Vector3()
            ray.intersectPlane(viewPlane, point)
            return point
        }

        const startWorld = toWorld(start.x, start.y)
        const currentWorld = toWorld(current.x, current.y)
        // World horizontal plane is XZ (Y-up). Section plane is vertical, so constrain in XZ.
        const dirXZ = new THREE.Vector2(
            currentWorld.x - startWorld.x,
            currentWorld.z - startWorld.z
        )
        const lenXZ = dirXZ.length()
        if (lenXZ < 0.001) return { screenCoords: current }

        const angle = Math.atan2(dirXZ.y, dirXZ.x)
        const snapAngle = SNAP_ANGLES.reduce((best, a) => {
            let diffBest = Math.abs(angle - best)
            if (diffBest > Math.PI) diffBest = 2 * Math.PI - diffBest
            let diffA = Math.abs(angle - a)
            if (diffA > Math.PI) diffA = 2 * Math.PI - diffA
            return diffA < diffBest ? a : best
        })

        const endWorld = startWorld.clone().add(new THREE.Vector3(
            Math.cos(snapAngle) * lenXZ,
            0,
            Math.sin(snapAngle) * lenXZ
        ))

        // Use NDC directly from world positions to avoid conversion errors (section must align with line)
        const startNDC = startWorld.clone().project(camera)
        const endNDC = endWorld.clone().project(camera)

        const screenCoords = {
            x: ((endNDC.x + 1) / 2) * width,
            y: (1 - endNDC.y) / 2 * height,
        }
        return {
            screenCoords,
            startNDC: { x: startNDC.x, y: startNDC.y },
            endNDC: { x: endNDC.x, y: endNDC.y },
            startWorld: startWorld.clone(),
            endWorld: endWorld.clone(),
        }
    }, [camera, sectionPlaneManager])

    const handleMouseDown = (e: React.MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()

        const coords = getRelativeCoords(e)

        // Start drawing a line
        setStartPoint(coords)
        setCurrentPoint(coords)
        setIsDrawing(true)
    }

    const handleMouseMove = (e: React.MouseEvent) => {
        const coords = getRelativeCoords(e)

        if (isDrawing) {
            e.preventDefault()
            e.stopPropagation()
            const width = containerRef.current?.clientWidth || overlayRef.current?.clientWidth || 1
            const height = containerRef.current?.clientHeight || overlayRef.current?.clientHeight || 1
            const result = getConstrainedResult(startPoint, coords, shiftHeld, width, height)
            setCurrentPoint(result.screenCoords)
        }
    }

    const handleMouseUp = (e: React.MouseEvent) => {
        if (!isDrawing) return
        e.preventDefault()
        e.stopPropagation()

        const coords = getRelativeCoords(e)
        const width = containerRef.current?.clientWidth || overlayRef.current?.clientWidth || 1
        const height = containerRef.current?.clientHeight || overlayRef.current?.clientHeight || 1
        const result = getConstrainedResult(startPoint, coords, shiftHeld, width, height)
        setCurrentPoint(result.screenCoords)
        setIsDrawing(false)

        // Calculate line length using constrained coordinates
        const dx = result.screenCoords.x - startPoint.x
        const dy = result.screenCoords.y - startPoint.y
        const length = Math.sqrt(dx * dx + dy * dy)

        // Only create section if line is long enough
        if (length > 30 && sectionPlaneManager && camera && overlayRef.current) {
            if (result.startWorld && result.endWorld) {
                sectionPlaneManager.addFromWorldLine(result.startWorld, result.endWorld)
            } else {
                const w = containerRef.current?.clientWidth || overlayRef.current.clientWidth
                const h = containerRef.current?.clientHeight || overlayRef.current.clientHeight
                const startNDC = result.startNDC ?? {
                    x: (startPoint.x / w) * 2 - 1,
                    y: -((startPoint.y / h) * 2 - 1)
                }
                const endNDC = result.endNDC ?? {
                    x: (result.screenCoords.x / w) * 2 - 1,
                    y: -((result.screenCoords.y / h) * 2 - 1)
                }
                sectionPlaneManager.addFromScreenLine(startNDC, endNDC, camera)
            }
            onSectionEnabled()
        }

        onComplete()
    }

    // ESC to cancel, Shift for constraint
    useEffect(() => {
        if (!active) return

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setIsDrawing(false)
                if (triggerRender) {
                    triggerRender()
                }
                onComplete()
            }
            // Shift key for horizontal/vertical constraint
            if (e.key === 'Shift') {
                setShiftHeld(true)
            }
            // F to flip section
            if ((e.key === 'f' || e.key === 'F') && sectionPlaneManager?.hasAnyEnabled()) {
                sectionPlaneManager.getActivePlane()?.flip()
            }
        }

        const handleKeyUp = (e: KeyboardEvent) => {
            if (e.key === 'Shift') {
                setShiftHeld(false)
            }
        }

        document.addEventListener('keydown', handleKeyDown)
        document.addEventListener('keyup', handleKeyUp)
        return () => {
            document.removeEventListener('keydown', handleKeyDown)
            document.removeEventListener('keyup', handleKeyUp)
        }
    }, [active, onComplete, sectionPlaneManager, triggerRender])

    // Reset shift state when overlay becomes inactive
    useEffect(() => {
        if (!active) {
            setShiftHeld(false)
        }
    }, [active])

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
                if (triggerRender) {
                    triggerRender()
                }
            }}
            style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                cursor: 'crosshair',
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
                F — Flip  |  Shift — Schieben
            </div>

            {/* Section line being drawn */}
            {isDrawing && (
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
        </div>
    )
}

