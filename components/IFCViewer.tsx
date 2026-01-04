'use client'

import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { loadIFCModelWithFragments, clearFragmentsCache, getFragmentsCacheStats } from '@/lib/fragments-loader'
import { analyzeDoors } from '@/lib/door-analyzer'
import type { DoorContext } from '@/lib/door-analyzer'
import BatchProcessor from './BatchProcessor'

export default function IFCViewer() {
  const containerRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<THREE.Scene | null>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const animationFrameRef = useRef<number | null>(null)
  const modelGroupRef = useRef<THREE.Group | null>(null)
  const electricalModelGroupRef = useRef<THREE.Group | null>(null)

  const loadedModelRef = useRef<any>(null)
  const electricalModelRef = useRef<any>(null)

  const [isLoading, setIsLoading] = useState(false)
  const [loadingProgress, setLoadingProgress] = useState(0)
  const [loadingStage, setLoadingStage] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [doorContexts, setDoorContexts] = useState<DoorContext[]>([])
  const [showBatchProcessor, setShowBatchProcessor] = useState(false)

  // File names for display
  const [archFileName, setArchFileName] = useState<string>('')
  const [elecFileName, setElecFileName] = useState<string>('')

  // Cache management
  const [showCacheInfo, setShowCacheInfo] = useState(false)
  const [cacheStats, setCacheStats] = useState<{ entries: number; totalSize: number; files: any[] } | null>(null)

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
          spherical.phi -= deltaY * 0.01
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

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>, type: 'arch' | 'elec') => {
    const file = e.target.files?.[0]
    if (!file) return

    setIsLoading(true)
    setLoadingProgress(0)
    setError(null)
    setShowBatchProcessor(false)

    if (type === 'arch') {
      setDoorContexts([])
      setArchFileName(file.name)
    } else {
      setElecFileName(file.name)
    }

    try {
      if (type === 'arch') {
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

        loadedModelRef.current = null

        // Load model using fragments (10x faster!)
        setLoadingStage('Loading with fragments...')
        const loadedModel = await loadIFCModelWithFragments(file, (progress) => {
          setLoadingProgress(progress)
          if (progress < 30) {
            setLoadingStage('Converting to fragments...')
          } else if (progress < 80) {
            setLoadingStage('Processing geometry...')
          } else {
            setLoadingStage('Finalizing...')
          }
        })

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
          const centeredBox = new THREE.Box3().setFromObject(group)
          const size = centeredBox.getSize(new THREE.Vector3())
          const maxDim = Math.max(size.x, size.y, size.z)

          const fov = cameraRef.current.fov * (Math.PI / 180)
          const cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2))
          const distance = cameraZ * 1.5

          const angle = Math.PI / 4
          cameraRef.current.position.set(
            distance * Math.cos(angle),
            distance * Math.sin(angle),
            distance * Math.cos(angle)
          )
          cameraRef.current.lookAt(0, 0, 0)
          cameraRef.current.updateProjectionMatrix()
        }
      } else {
        // Load Electrical Model
        if (electricalModelGroupRef.current && sceneRef.current) {
          sceneRef.current.remove(electricalModelGroupRef.current)
          electricalModelGroupRef.current.traverse((child) => {
            if (child instanceof THREE.Mesh) {
              child.geometry.dispose()
              if (Array.isArray(child.material)) {
                child.material.forEach((mat) => mat.dispose())
              } else {
                child.material.dispose()
              }
            }
          })
          electricalModelGroupRef.current = null
        }

        electricalModelRef.current = null

        setLoadingStage('Loading electrical model with fragments...')
        const loadedElecModel = await loadIFCModelWithFragments(file, (progress) => {
          setLoadingProgress(progress)
        })
        electricalModelRef.current = loadedElecModel

        const group = loadedElecModel.group

        if (modelGroupRef.current) {
          const offset = modelGroupRef.current.position.clone()
          group.position.copy(offset)
        }

        if (sceneRef.current) {
          sceneRef.current.add(group)
          electricalModelGroupRef.current = group
        }
      }

      // Re-analyze doors if Arch model is loaded
      if (loadedModelRef.current) {
        setLoadingStage('Analyzing doors...')
        console.log('Starting door analysis...')
        const contexts = await analyzeDoors(loadedModelRef.current, electricalModelRef.current || undefined)
        console.log(`Door analysis complete. Found ${contexts.length} door contexts.`)
        setDoorContexts(contexts)

        if (loadedModelRef.current.elements.length > 0) {
          setShowBatchProcessor(true)
        }
      }

    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load IFC file')
      console.error('Error loading IFC:', err)
    } finally {
      setIsLoading(false)
      setLoadingProgress(0)
      setLoadingStage('')
    }
  }

  const handleClearCache = async () => {
    if (window.confirm('Clear all cached fragments? Files will need to be converted again on next load.')) {
      await clearFragmentsCache()
      await loadCacheStats()
      alert('Cache cleared successfully!')
    }
  }

  const loadCacheStats = async () => {
    const stats = await getFragmentsCacheStats()
    setCacheStats(stats)
  }

  useEffect(() => {
    if (showCacheInfo && !cacheStats) {
      loadCacheStats()
    }
  }, [showCacheInfo, cacheStats])

  return (
    <div className="ifc-viewer-container">
      <div className="controls">
        <div className="file-inputs">
          <div className="input-group">
            <label htmlFor="ifc-file-input" className="file-input-label">
              {isLoading ? 'Loading...' : (archFileName || '1. Select Architectural IFC')}
            </label>
            <input
              id="ifc-file-input"
              type="file"
              accept=".ifc"
              onChange={(e) => handleFileChange(e, 'arch')}
              disabled={isLoading}
              className="file-input"
            />
          </div>

          <div className="input-group">
            <label htmlFor="elec-file-input" className="file-input-label secondary">
              {isLoading ? 'Loading...' : (elecFileName || '2. Select Electrical IFC (Optional)')}
            </label>
            <input
              id="elec-file-input"
              type="file"
              accept=".ifc"
              onChange={(e) => handleFileChange(e, 'elec')}
              disabled={isLoading}
              className="file-input"
            />
          </div>

          <button
            onClick={() => setShowCacheInfo(!showCacheInfo)}
            className="cache-button"
            title="Manage fragments cache"
          >
            ⚡ Cache
          </button>
        </div>

        {isLoading && (
          <div className="loading-indicator">
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${loadingProgress}%` }} />
            </div>
            <div className="loading-text">
              {loadingStage} ({Math.round(loadingProgress)}%)
            </div>
          </div>
        )}

        {showCacheInfo && (
          <div className="cache-info">
            <h3>Fragments Cache</h3>
            <p>Fragments provide 10x faster loading! First load converts IFC to fragments, subsequent loads are instant.</p>
            {cacheStats && (
              <div className="cache-stats">
                <div>Cached files: {cacheStats.entries}</div>
                <div>Total size: {(cacheStats.totalSize / 1024 / 1024).toFixed(2)} MB</div>
                {cacheStats.files.length > 0 && (
                  <div className="cached-files">
                    {cacheStats.files.map((file, idx) => (
                      <div key={idx} className="cached-file">
                        <span>{file.fileName}</span>
                        <span className="file-size">{(file.size / 1024 / 1024).toFixed(2)} MB</span>
                      </div>
                    ))}
                  </div>
                )}
                <button onClick={handleClearCache} className="clear-cache-button">
                  Clear Cache
                </button>
              </div>
            )}
          </div>
        )}

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

      <style jsx>{`
        .file-inputs {
            display: flex;
            gap: 1rem;
            margin-bottom: 0.5rem;
            align-items: flex-start;
        }
        .input-group {
            display: flex;
            flex-direction: column;
        }
        .file-input-label.secondary {
            background-color: #555;
        }
        .file-input-label.secondary:hover {
            background-color: #666;
        }
        .cache-button {
            padding: 0.5rem 1rem;
            background-color: #4CAF50;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            font-weight: bold;
            transition: background-color 0.2s;
        }
        .cache-button:hover {
            background-color: #45a049;
        }
        .loading-indicator {
            margin: 1rem 0;
            padding: 1rem;
            background-color: #f0f0f0;
            border-radius: 4px;
        }
        .progress-bar {
            width: 100%;
            height: 20px;
            background-color: #ddd;
            border-radius: 10px;
            overflow: hidden;
            margin-bottom: 0.5rem;
        }
        .progress-fill {
            height: 100%;
            background: linear-gradient(90deg, #4CAF50, #45a049);
            transition: width 0.3s ease;
        }
        .loading-text {
            text-align: center;
            font-size: 14px;
            color: #333;
            font-weight: 500;
        }
        .cache-info {
            margin: 1rem 0;
            padding: 1rem;
            background-color: #e8f5e9;
            border-radius: 4px;
            border-left: 4px solid #4CAF50;
        }
        .cache-info h3 {
            margin: 0 0 0.5rem 0;
            color: #2e7d32;
        }
        .cache-info p {
            margin: 0 0 1rem 0;
            color: #555;
          font-size: 14px;
        }
        .cache-stats {
            margin-top: 1rem;
        }
        .cache-stats > div {
            margin-bottom: 0.5rem;
            font-size: 14px;
        }
        .cached-files {
            margin: 1rem 0;
            padding: 0.5rem;
            background-color: white;
            border-radius: 4px;
            max-height: 200px;
            overflow-y: auto;
        }
        .cached-file {
            display: flex;
            justify-content: space-between;
            padding: 0.5rem;
            border-bottom: 1px solid #eee;
        }
        .cached-file:last-child {
            border-bottom: none;
        }
        .file-size {
            color: #666;
            font-size: 12px;
        }
        .clear-cache-button {
            padding: 0.5rem 1rem;
            background-color: #f44336;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            transition: background-color 0.2s;
        }
        .clear-cache-button:hover {
            background-color: #da190b;
        }
      `}</style>
    </div>
  )
}

