'use client'

import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { loadIFCModelWithMetadata, closeIFCModel } from '@/lib/ifc-loader'
import { analyzeDoors } from '@/lib/door-analyzer'
import type { DoorContext } from '@/lib/door-analyzer'
import type { LoadedIFCModel } from '@/lib/ifc-types'
import BatchProcessor from './BatchProcessor'

export default function IFCViewer() {
  const containerRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<THREE.Scene | null>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const animationFrameRef = useRef<number | null>(null)
  const modelGroupRef = useRef<THREE.Group | null>(null)
  const loadedModelRef = useRef<LoadedIFCModel | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [doorContexts, setDoorContexts] = useState<DoorContext[]>([])
  const [showBatchProcessor, setShowBatchProcessor] = useState(false)
  const mouseDownRef = useRef(false)
  const mousePositionRef = useRef({ x: 0, y: 0 })

  useEffect(() => {
    if (!containerRef.current) return

    // Initialize Three.js scene
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x222222)
    sceneRef.current = scene

    // Camera
    const camera = new THREE.PerspectiveCamera(
      75,
      containerRef.current.clientWidth / containerRef.current.clientHeight,
      0.1,
      1000
    )
    camera.position.set(10, 10, 10)
    camera.lookAt(0, 0, 0)
    cameraRef.current = camera

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setSize(containerRef.current.clientWidth, containerRef.current.clientHeight)
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.domElement.tabIndex = 0
    renderer.domElement.style.outline = 'none'
    containerRef.current.appendChild(renderer.domElement)
    rendererRef.current = renderer

    // Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6)
    scene.add(ambientLight)

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8)
    directionalLight.position.set(10, 10, 5)
    scene.add(directionalLight)

    // Grid helper
    const gridHelper = new THREE.GridHelper(20, 20)
    scene.add(gridHelper)

    // Axes helper
    const axesHelper = new THREE.AxesHelper(5)
    scene.add(axesHelper)

    // Animation loop
    const animate = () => {
      animationFrameRef.current = requestAnimationFrame(animate)
      renderer.render(scene, camera)
    }
    animate()

    // Handle window resize
    const handleResize = () => {
      if (!containerRef.current || !camera || !renderer) return
      camera.aspect = containerRef.current.clientWidth / containerRef.current.clientHeight
      camera.updateProjectionMatrix()
      renderer.setSize(containerRef.current.clientWidth, containerRef.current.clientHeight)
    }
    window.addEventListener('resize', handleResize)

    // Mouse controls
    const handleMouseDown = (e: MouseEvent) => {
      mouseDownRef.current = true
      mousePositionRef.current = { x: e.clientX, y: e.clientY }
    }

    const handleMouseMove = (e: MouseEvent) => {
      if (mouseDownRef.current) {
        const deltaX = e.clientX - mousePositionRef.current.x
        const deltaY = e.clientY - mousePositionRef.current.y
        mousePositionRef.current = { x: e.clientX, y: e.clientY }
        
        if (cameraRef.current) {
          const spherical = new THREE.Spherical()
          spherical.setFromVector3(cameraRef.current.position)
          spherical.theta -= deltaX * 0.01
          spherical.phi += deltaY * 0.01
          spherical.phi = Math.max(0.1, Math.min(Math.PI - 0.1, spherical.phi))
          
          cameraRef.current.position.setFromSpherical(spherical)
          cameraRef.current.lookAt(0, 0, 0)
        }
      }
    }

    const handleMouseUp = () => {
      mouseDownRef.current = false
    }

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault() // Prevent page zoom
      e.stopPropagation() // Stop event bubbling
      if (cameraRef.current) {
        const distance = cameraRef.current.position.length()
        const newDistance = distance + e.deltaY * 0.01
        cameraRef.current.position.normalize().multiplyScalar(Math.max(1, Math.min(50, newDistance)))
      }
    }

    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault()
    }

    renderer.domElement.addEventListener('mousedown', handleMouseDown)
    renderer.domElement.addEventListener('mousemove', handleMouseMove)
    renderer.domElement.addEventListener('mouseup', handleMouseUp)
    renderer.domElement.addEventListener('mouseleave', handleMouseUp)
    renderer.domElement.addEventListener('wheel', handleWheel, { passive: false })
    renderer.domElement.addEventListener('contextmenu', handleContextMenu)

    return () => {
      window.removeEventListener('resize', handleResize)
      renderer.domElement.removeEventListener('mousedown', handleMouseDown)
      renderer.domElement.removeEventListener('mousemove', handleMouseMove)
      renderer.domElement.removeEventListener('mouseup', handleMouseUp)
      renderer.domElement.removeEventListener('mouseleave', handleMouseUp)
      renderer.domElement.removeEventListener('wheel', handleWheel)
      renderer.domElement.removeEventListener('contextmenu', handleContextMenu)
      
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
      }
      renderer.dispose()
      if (containerRef.current && renderer.domElement.parentNode) {
        containerRef.current.removeChild(renderer.domElement)
      }
    }
  }, [])

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setIsLoading(true)
    setError(null)
    setShowBatchProcessor(false)
    setDoorContexts([])

    try {
      // Close previous model if exists
      if (loadedModelRef.current) {
        closeIFCModel(loadedModelRef.current.modelID)
        loadedModelRef.current = null
      }

      // Remove previous model from scene
      if (modelGroupRef.current && sceneRef.current) {
        sceneRef.current.remove(modelGroupRef.current)
        modelGroupRef.current.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.geometry.dispose()
            if (Array.isArray(child.material)) {
              child.material.forEach((mat) => mat.dispose())
            } else {
              child.material.dispose()
            }
          }
        })
        modelGroupRef.current = null
      }

      // Load new model with metadata
      const loadedModel = await loadIFCModelWithMetadata(file)
      loadedModelRef.current = loadedModel
      
      const group = loadedModel.group
      
      // Center the model at origin
      const box = new THREE.Box3().setFromObject(group)
      const center = box.getCenter(new THREE.Vector3())
      group.position.sub(center)
      
      if (sceneRef.current) {
        sceneRef.current.add(group)
        modelGroupRef.current = group
      }

      // Focus camera on the model geometry
      if (cameraRef.current && containerRef.current) {
        // Recalculate bounding box after centering
        const centeredBox = new THREE.Box3().setFromObject(group)
        const size = centeredBox.getSize(new THREE.Vector3())
        const maxDim = Math.max(size.x, size.y, size.z)
        
        // Calculate optimal camera distance to fit the model
        const fov = cameraRef.current.fov * (Math.PI / 180)
        const cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2))
        const distance = cameraZ * 1.5 // Add some padding
        
        // Position camera in a nice angle
        const angle = Math.PI / 4 // 45 degrees
        cameraRef.current.position.set(
          distance * Math.cos(angle),
          distance * Math.sin(angle),
          distance * Math.cos(angle)
        )
        cameraRef.current.lookAt(0, 0, 0)
        cameraRef.current.updateProjectionMatrix()
      }

      // Analyze doors
      console.log('Starting door analysis...')
      console.log(`Total elements loaded: ${loadedModel.elements.length}`)
      const contexts = analyzeDoors(loadedModel)
      console.log(`Door analysis complete. Found ${contexts.length} door contexts.`)
      setDoorContexts(contexts)
      
      // Always show batch processor if we have elements, even if no doors found
      // This helps with debugging
      if (loadedModel.elements.length > 0) {
        setShowBatchProcessor(true)
        if (contexts.length === 0) {
          console.warn('No doors detected. Check console for element types.')
          // Log all unique type names for debugging
          const uniqueTypes = new Set(loadedModel.elements.map(e => e.typeName))
          console.log('Unique element types found:', Array.from(uniqueTypes).slice(0, 20))
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load IFC file')
      console.error('Error loading IFC:', err)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="ifc-viewer-container">
      <div className="controls">
        <label htmlFor="ifc-file-input" className="file-input-label">
          {isLoading ? 'Loading...' : 'Select IFC File'}
        </label>
        <input
          id="ifc-file-input"
          type="file"
          accept=".ifc"
          onChange={handleFileChange}
          disabled={isLoading}
          className="file-input"
        />
        {error && <div className="error-message">{error}</div>}
        {doorContexts.length > 0 && (
          <div className="door-count">
            Found {doorContexts.length} door{doorContexts.length !== 1 ? 's' : ''}
          </div>
        )}
      </div>
      <div className="viewer-layout">
        <div ref={containerRef} className="viewer-canvas" />
        {showBatchProcessor && doorContexts.length > 0 && (
          <div className="batch-panel">
            <BatchProcessor
              doorContexts={doorContexts}
              onComplete={() => {
                // Optional: hide batch processor after completion
                // setShowBatchProcessor(false)
              }}
            />
          </div>
        )}
      </div>
    </div>
  )
}

