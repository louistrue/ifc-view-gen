'use client'

import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { loadIFCModelWithFragments, clearFragmentsCache, getFragmentsCacheStats } from '@/lib/fragments-loader'
import { analyzeDoors, loadDetailedGeometry } from '@/lib/door-analyzer'
import type { DoorContext } from '@/lib/door-analyzer'
import DoorPanel from './DoorPanel'
import { NavigationManager } from '@/lib/navigation-manager'
import { extractSpatialStructure, type SpatialNode } from '@/lib/spatial-structure'
import { ElementVisibilityManager } from '@/lib/element-visibility-manager'
import { SectionBox } from '@/lib/section-box'
import { SectionPlane } from '@/lib/section-plane'
import ViewerToolbar, { type SectionMode } from './ViewerToolbar'
import ZoomWindowOverlay from './ZoomWindowOverlay'
import SectionDrawOverlay from './SectionDrawOverlay'
import ViewPresets from './ViewPresets'
import SpatialHierarchyPanel from './SpatialHierarchyPanel'
import TypeFilterPanel from './TypeFilterPanel'

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
  const archFileRef = useRef<File | null>(null) // Store arch file for detailed geometry extraction
  const modelCenterOffsetRef = useRef<THREE.Vector3>(new THREE.Vector3()) // Store centering offset

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

  // Navigation and performance systems
  const navigationManagerRef = useRef<NavigationManager | null>(null)
  const visibilityManagerRef = useRef<ElementVisibilityManager | null>(null)
  const sectionBoxRef = useRef<SectionBox | null>(null)
  const sectionPlaneRef = useRef<SectionPlane | null>(null)
  const batchProcessorVisibleRef = useRef(false)
  const fragmentsManagerRef = useRef<any>(null) // Fragments manager for update() in render loop
  const triggerRenderRef = useRef<() => void>(() => { }) // Function to trigger a render
  const isLoadingRef = useRef(false) // Prevent double-loading from React StrictMode

  // Spatial structure
  const [spatialStructure, setSpatialStructure] = useState<SpatialNode | null>(null)
  const spatialStructureRef = useRef<SpatialNode | null>(null) // For immediate access in async code

  // UI state
  const [showSpatialPanel, setShowSpatialPanel] = useState(false)
  const [showTypeFilter, setShowTypeFilter] = useState(false)
  const [navigationMode, setNavigationMode] = useState<'orbit' | 'walk'>('orbit')
  const [zoomWindowActive, setZoomWindowActive] = useState(false)
  const [sectionMode, setSectionMode] = useState<SectionMode>('off')
  const [isSectionActive, setIsSectionActive] = useState(false) // True when any section is enabled
  const [modelLoaded, setModelLoaded] = useState(false)
  // Persist active class filters across panel open/close
  const [activeClassFilters, setActiveClassFilters] = useState<Set<string> | null>(null)

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

    // Canvas fills full container - sidebars are overlays
    const containerWidth = containerRef.current.clientWidth
    const containerHeight = containerRef.current.clientHeight

    renderer.setSize(containerWidth, containerHeight)
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.localClippingEnabled = true // Enable clipping planes for section box
    renderer.domElement.tabIndex = 0
    renderer.domElement.style.outline = 'none'
    containerRef.current.appendChild(renderer.domElement)
    rendererRef.current = renderer

    // Update camera aspect ratio
    camera.aspect = containerWidth / containerHeight
    camera.updateProjectionMatrix()

    // Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6)
    scene.add(ambientLight)

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8)
    directionalLight.position.set(10, 10, 5)
    scene.add(directionalLight)

    // Grid and axes helpers removed for cleaner view

    // Optimized render loop: render on-demand instead of continuous 60fps
    let needsRender = true
    let lastTime = performance.now()

    // Expose trigger function for external components
    triggerRenderRef.current = () => {
      needsRender = true
    }

    const animate = () => {
      animationFrameRef.current = requestAnimationFrame(animate)

      const currentTime = performance.now()
      const delta = (currentTime - lastTime) / 1000 // Convert to seconds
      lastTime = currentTime

      // Update navigation manager
      if (navigationManagerRef.current) {
        const navNeedsUpdate = navigationManagerRef.current.update(delta)
        if (navNeedsUpdate) {
          needsRender = true
        }
      }

      if (needsRender) {
        // CRITICAL: Update Fragments manager before rendering
        // This updates LOD levels and visibility based on camera position
        if (fragmentsManagerRef.current) {
          fragmentsManagerRef.current.update(true)
        }
        renderer.render(scene, camera)
        needsRender = false
      }
    }
    animate()

    // Mark as needing render when camera changes
    const markNeedsRender = () => {
      needsRender = true
      // Also notify Fragments of camera change for LOD updates
      if (fragmentsManagerRef.current) {
        fragmentsManagerRef.current.update(true)
      }
    }

    // Initialize navigation manager
    const navManager = new NavigationManager(camera, scene, renderer)
    navManager.setNeedsRenderCallback(markNeedsRender)
    navManager.onModeChange((mode) => {
      setNavigationMode(mode)
      needsRender = true
    })
    navigationManagerRef.current = navManager

    // Handle window resize
    const handleResize = () => {
      if (!containerRef.current || !camera || !renderer) return

      const containerWidth = containerRef.current.clientWidth
      const containerHeight = containerRef.current.clientHeight

      // Don't resize if container has no dimensions (hidden)
      if (containerWidth <= 0 || containerHeight <= 0) return

      // Sidebars are overlays (position: absolute), so they don't take layout space
      // Canvas fills the full container, no viewport adjustment needed
      renderer.setSize(containerWidth, containerHeight)

      // Update camera aspect ratio
      camera.aspect = containerWidth / containerHeight
      camera.updateProjectionMatrix()

      needsRender = true
    }
    window.addEventListener('resize', handleResize)

    // Initial resize to set correct viewport
    setTimeout(handleResize, 0)

    // Keyboard shortcuts
    const handleKeyDown = (e: KeyboardEvent) => {
      // Tab to switch navigation mode
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault()
        if (navigationManagerRef.current) {
          const newMode = navigationMode === 'orbit' ? 'walk' : 'orbit'
          navigationManagerRef.current.setMode(newMode)
        }
      }

      // View presets (1-7)
      if (e.key >= '1' && e.key <= '7' && navigationManagerRef.current) {
        const presets: Array<'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'iso'> = [
          'top', 'bottom', 'front', 'back', 'left', 'right', 'iso'
        ]
        const presetIndex = parseInt(e.key) - 1
        if (presetIndex >= 0 && presetIndex < presets.length) {
          navigationManagerRef.current.setViewPreset(presets[presetIndex])
        }
      }

      // Z key for zoom window
      if (e.key === 'z' || e.key === 'Z') {
        setZoomWindowActive(prev => !prev)
      }

      // R key for reset view (clear sections)
      if (e.key === 'r' || e.key === 'R') {
        handleResetView()
      }

      // Escape key to cancel section drawing
      if (e.key === 'Escape') {
        setSectionMode('off')
        setZoomWindowActive(false)
      }

      // F key to flip section direction
      if ((e.key === 'f' || e.key === 'F') && sectionPlaneRef.current) {
        sectionPlaneRef.current.flip()
      }
    }
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('resize', handleResize)
      window.removeEventListener('keydown', handleKeyDown)

      if (navigationManagerRef.current) {
        navigationManagerRef.current.dispose()
      }

      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
      }
      renderer.dispose()
      if (containerRef.current && renderer.domElement.parentNode) {
        containerRef.current.removeChild(renderer.domElement)
      }
    }
  }, [])

  // Reset view - clears all sections and shows full model
  const handleResetView = () => {
    // Clear section plane
    if (sectionPlaneRef.current) {
      sectionPlaneRef.current.disable()
    }
    // Clear section box
    if (sectionBoxRef.current) {
      sectionBoxRef.current.disable()
    }
    // Reset visibility manager
    if (visibilityManagerRef.current) {
      visibilityManagerRef.current.resetAllVisibility()
    }
    // Reset class filters
    setActiveClassFilters(null)
    // Reset section states
    setSectionMode('off')
    setIsSectionActive(false)
    // Zoom to fit the model
    if (navigationManagerRef.current) {
      navigationManagerRef.current.setViewPreset('iso')
    }
    // Force render to show changes
    triggerRenderRef.current()
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>, type: 'arch' | 'elec') => {
    const file = e.target.files?.[0]
    if (!file) return

    // Prevent double-loading from React StrictMode
    if (isLoadingRef.current) {
      console.log('⚠️ Load already in progress, skipping duplicate call')
      return
    }
    isLoadingRef.current = true

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
        setLoadingStage('Starting...')
        const loadedModel = await loadIFCModelWithFragments(file, ({ percent, stage }) => {
          setLoadingProgress(percent)
          setLoadingStage(stage)
        })

        loadedModelRef.current = loadedModel
        setModelLoaded(true)
        archFileRef.current = file // Store file for detailed geometry extraction

        const group = loadedModel.group

        // Center the model at origin
        const box = new THREE.Box3().setFromObject(group)
        const center = box.getCenter(new THREE.Vector3())
        group.position.sub(center)
        modelCenterOffsetRef.current = center.clone() // Store for geometry offset

        // CRITICAL: Apply centering offset to extracted elements' bounding boxes and meshes
        // The extracted meshes have world-space geometry, but we've now shifted the scene.
        // We MUST CLONE geometry before translating to avoid modifying shared/instanced geometry!
        for (const element of loadedModel.elements) {
          // Offset bounding box
          if (element.boundingBox) {
            element.boundingBox.min.sub(center)
            element.boundingBox.max.sub(center)
          }
          // Offset mesh geometry - CLONE first to avoid shared geometry issues!
          if (element.meshes) {
            for (let i = 0; i < element.meshes.length; i++) {
              const mesh = element.meshes[i]
              if (mesh.geometry) {
                // Clone geometry to avoid modifying shared instances
                mesh.geometry = mesh.geometry.clone()
                mesh.geometry.translate(-center.x, -center.y, -center.z)
              }
            }
          }
          if (element.mesh?.geometry) {
            // Clone geometry to avoid modifying shared instances
            element.mesh.geometry = element.mesh.geometry.clone()
            element.mesh.geometry.translate(-center.x, -center.y, -center.z)
          }
        }
        console.log(`✓ Applied centering offset to ${loadedModel.elements.length} elements`)

        if (sceneRef.current) {
          sceneRef.current.add(group)
          modelGroupRef.current = group
        }

        // CRITICAL: Enable Fragments camera-based optimizations (LOD, frustum culling)
        if (cameraRef.current && loadedModel.fragmentsModel) {
          loadedModel.fragmentsModel.useCamera(cameraRef.current)
          fragmentsManagerRef.current = loadedModel.fragmentsManager
          // Trigger initial update after camera is set
          await loadedModel.fragmentsManager.update(true)
          console.log('✓ Enabled Fragments camera-based optimizations (LOD, culling)')
        }

        // Initialize visibility manager
        const visibilityManager = new ElementVisibilityManager(
          loadedModel.fragmentsModel,
          loadedModel.elements
        )
        visibilityManagerRef.current = visibilityManager

        // Connect visibility manager to Fragments, render system, and scene (for highlights)
        if (loadedModel.fragmentsManager) {
          visibilityManager.setFragmentsManager(loadedModel.fragmentsManager)
        }
        if (sceneRef.current) {
          visibilityManager.setScene(sceneRef.current)
        }
        visibilityManager.setRenderCallback(() => triggerRenderRef.current())

        // Extract spatial structure
        const spatialRoot = await extractSpatialStructure(
          loadedModel.fragmentsModel,
          loadedModel.elements
        )
        setSpatialStructure(spatialRoot)
        spatialStructureRef.current = spatialRoot // Store in ref for immediate access

        // Initialize section box with renderer for global clipping
        const modelBounds = new THREE.Box3().setFromObject(group)
        if (sceneRef.current && rendererRef.current) {
          const sectionBox = new SectionBox(
            sceneRef.current,
            { min: modelBounds.min, max: modelBounds.max },
            rendererRef.current
          )
          sectionBoxRef.current = sectionBox

          // Initialize section plane (for line/face drawing)
          const sectionPlane = new SectionPlane(
            sceneRef.current,
            modelBounds,
            rendererRef.current
          )
          // Set callback to trigger render when section changes (e.g., flip)
          sectionPlane.setOnChangeCallback(() => {
            triggerRenderRef.current()
          })
          sectionPlaneRef.current = sectionPlane
        }

        // Focus camera on the model geometry (accounting for visible canvas area)
        if (cameraRef.current && containerRef.current && rendererRef.current) {
          const centeredBox = new THREE.Box3().setFromObject(group)
          const size = centeredBox.getSize(new THREE.Vector3())
          const maxDim = Math.max(size.x, size.y, size.z)

          // Canvas fills full container - sidebars are overlays
          const containerWidth = containerRef.current.clientWidth
          const containerHeight = containerRef.current.clientHeight
          cameraRef.current.aspect = containerWidth / containerHeight
          cameraRef.current.updateProjectionMatrix()

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

          // Trigger Fragments update after camera movement
          if (loadedModel.fragmentsModel && fragmentsManagerRef.current) {
            loadedModel.fragmentsModel.useCamera(cameraRef.current)
            fragmentsManagerRef.current.update(true)
          }

          // Focus navigation manager on center and set to 3D isometric view
          if (navigationManagerRef.current) {
            navigationManagerRef.current.focusOn(new THREE.Vector3(0, 0, 0), distance)
            // Set to 3D isometric view after a short delay to ensure camera is ready
            setTimeout(() => {
              if (navigationManagerRef.current) {
                navigationManagerRef.current.setViewPreset('iso')
              }
            }, 100)
          }
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

        setLoadingStage('Loading electrical model...')
        const loadedElecModel = await loadIFCModelWithFragments(file, ({ percent, stage }) => {
          setLoadingProgress(percent)
          setLoadingStage(`Electrical: ${stage}`)
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
        // Pass spatial structure to extract storey names for doors
        const contexts = await analyzeDoors(
          loadedModelRef.current,
          electricalModelRef.current || undefined,
          spatialStructureRef.current  // Use ref for immediate access
        )
        console.log(`Door analysis complete. Found ${contexts.length} door contexts.`)

        // Load detailed geometry from web-ifc for high-quality SVG generation
        if (archFileRef.current && contexts.length > 0) {
          setLoadingStage('Extracting detailed geometry...')
          console.log('Loading detailed geometry from web-ifc...')
          try {
            await loadDetailedGeometry(contexts, archFileRef.current, modelCenterOffsetRef.current)
            console.log('✓ Detailed geometry loaded for SVG rendering')
          } catch (err) {
            console.warn('Failed to load detailed geometry, SVG will use simplified rendering:', err)
          }
        }

        setDoorContexts(contexts)

        if (loadedModelRef.current.elements.length > 0) {
          setShowBatchProcessor(true)
          batchProcessorVisibleRef.current = true
          // Update viewport when batch processor appears
          setTimeout(() => {
            if (rendererRef.current && containerRef.current && cameraRef.current) {
              // Canvas fills full container - sidebars are overlays
              const containerWidth = containerRef.current.clientWidth
              const containerHeight = containerRef.current.clientHeight
              rendererRef.current.setSize(containerWidth, containerHeight)
              cameraRef.current.aspect = containerWidth / containerHeight
              cameraRef.current.updateProjectionMatrix()
            }
          }, 100)
        }
      }

    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load IFC file')
      console.error('Error loading IFC:', err)
    } finally {
      setIsLoading(false)
      setLoadingProgress(0)
      setLoadingStage('')
      isLoadingRef.current = false // Allow new loads
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

  // Update renderer when model loads
  useEffect(() => {
    // Use timeout to ensure DOM has updated
    const timeoutId = setTimeout(() => {
      if (rendererRef.current && containerRef.current && cameraRef.current) {
        const containerWidth = containerRef.current.clientWidth
        const containerHeight = containerRef.current.clientHeight

        if (containerWidth <= 0 || containerHeight <= 0) return

        // Sidebars are overlays, canvas fills full container
        rendererRef.current.setSize(containerWidth, containerHeight)
        cameraRef.current.aspect = containerWidth / containerHeight
        cameraRef.current.updateProjectionMatrix()

        batchProcessorVisibleRef.current = showBatchProcessor
      }
    }, 50)

    return () => clearTimeout(timeoutId)
  }, [showBatchProcessor, modelLoaded])

  return (
    <div className="ifc-viewer-container">
      {/* Top menu - only show when model is loaded */}
      {modelLoaded && (
        <div className="controls">
          {/* Subtle logo with door opening animation */}
          <div
            className="logo-container"
            style={{
              display: 'flex',
              alignItems: 'center',
              marginRight: '16px',
              cursor: 'default',
            }}
          >
            <svg
              width="28"
              height="28"
              viewBox="0 0 100 100"
              style={{ display: 'block' }}
            >
              {/* Door frame */}
              <rect x="20" y="10" width="60" height="80" fill="none" stroke="#4a5568" strokeWidth="2.5" strokeLinecap="round" />

              {/* Door panel - will rotate on hover (hinge at left edge x=25) */}
              <g className="door-panel">
                <rect x="25" y="15" width="50" height="70" fill="#3b82f6" opacity="0.15" stroke="#3b82f6" strokeWidth="2" />
                <circle cx="70" cy="50" r="3" fill="#3b82f6" opacity="0.4" />
              </g>
            </svg>
          </div>
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
              Cache
            </button>
          </div>

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
      )}
      <div className="viewer-layout" style={{ position: 'relative' }}>
        {/* 3D Canvas - always rendered to maintain dimensions */}
        <div
          ref={containerRef}
          className="viewer-canvas"
          style={{
            width: '100%',
            height: '100%',
            flex: 1,
          }}
        />

        {/* Zoom Window Overlay - covers entire canvas */}
        <ZoomWindowOverlay
          active={zoomWindowActive}
          onComplete={() => setZoomWindowActive(false)}
          navigationManager={navigationManagerRef.current}
          containerRef={containerRef}
        />

        {/* Section Draw Overlay - for line/face section modes */}
        <SectionDrawOverlay
          active={sectionMode === 'line' || sectionMode === 'face'}
          mode={sectionMode === 'line' ? 'line' : 'face'}
          onComplete={() => setSectionMode('off')}
          onSectionEnabled={() => {
            setIsSectionActive(true)
            triggerRenderRef.current() // Force render to show section
          }}
          sectionPlane={sectionPlaneRef.current}
          camera={cameraRef.current}
          scene={sceneRef.current}
          containerRef={containerRef}
        />

        {/* Landing UI overlay when no model loaded */}
        {!modelLoaded && !isLoading && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: '#1a1a1a',
              padding: '40px',
              gap: '32px',
              zIndex: 10,
            }}
          >
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '16px',
              }}
            >
              <div
                style={{
                  width: '80px',
                  height: '80px',
                  borderRadius: '16px',
                  backgroundColor: 'rgba(59, 130, 246, 0.1)',
                  border: '2px dashed rgba(59, 130, 246, 0.3)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: '8px',
                }}
              >
                <svg
                  width="40"
                  height="40"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="rgba(59, 130, 246, 0.6)"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                  <polyline points="9 22 9 12 15 12 15 22" />
                </svg>
              </div>
              <h2
                style={{
                  margin: 0,
                  fontSize: '24px',
                  fontWeight: 600,
                  color: '#e0e0e0',
                  fontFamily: 'system-ui, -apple-system, sans-serif',
                }}
              >
                Door View Generator
              </h2>
              <p
                style={{
                  margin: 0,
                  fontSize: '14px',
                  color: '#888',
                  textAlign: 'center',
                  maxWidth: '400px',
                  lineHeight: '1.6',
                }}
              >
                Generate professional SVG door views from IFC building models.
                Upload an architectural IFC file to get started.
              </p>
            </div>

            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
                width: '100%',
                maxWidth: '400px',
              }}
            >
              <label
                htmlFor="ifc-file-input-landing"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '12px',
                  padding: '32px',
                  border: '2px dashed #444',
                  borderRadius: '12px',
                  backgroundColor: 'rgba(255, 255, 255, 0.02)',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = '#3b82f6'
                  e.currentTarget.style.backgroundColor = 'rgba(59, 130, 246, 0.05)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = '#444'
                  e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.02)'
                }}
              >
                <svg
                  width="32"
                  height="32"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#666"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                <span style={{ fontSize: '14px', color: '#888', fontWeight: 500 }}>
                  Drop IFC file here or click to browse
                </span>
                <span style={{ fontSize: '12px', color: '#666' }}>
                  Supports .ifc files
                </span>
                <input
                  id="ifc-file-input-landing"
                  type="file"
                  accept=".ifc"
                  onChange={(e) => handleFileChange(e, 'arch')}
                  style={{ display: 'none' }}
                />
              </label>
            </div>

            <div
              style={{
                display: 'flex',
                gap: '24px',
                marginTop: '16px',
              }}
            >
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '24px', fontWeight: 600, color: '#3b82f6' }}>1</div>
                <div style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>Upload IFC</div>
              </div>
              <div style={{ width: '40px', height: '1px', backgroundColor: '#333', marginTop: '16px' }} />
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '24px', fontWeight: 600, color: '#666' }}>2</div>
                <div style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>Find Doors</div>
              </div>
              <div style={{ width: '40px', height: '1px', backgroundColor: '#333', marginTop: '16px' }} />
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '24px', fontWeight: 600, color: '#666' }}>3</div>
                <div style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>Export SVG</div>
              </div>
            </div>
          </div>
        )}

        {/* Loading state overlay */}
        {isLoading && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: '#1a1a1a',
              gap: '24px',
              zIndex: 10,
            }}
          >
            <div
              style={{
                width: '60px',
                height: '60px',
                border: '3px solid #333',
                borderTopColor: '#3b82f6',
                borderRadius: '50%',
                animation: 'spin 1s linear infinite',
              }}
            />
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '16px', color: '#e0e0e0', fontWeight: 500 }}>
                {loadingStage || 'Loading...'}
              </div>
              <div style={{ fontSize: '32px', color: '#3b82f6', fontWeight: 600, marginTop: '8px' }}>
                {Math.round(loadingProgress)}%
              </div>
            </div>
          </div>
        )}

        {showBatchProcessor && doorContexts.length > 0 && (
          <div className="batch-panel">
            <DoorPanel
              doorContexts={doorContexts}
              visibilityManager={visibilityManagerRef.current}
              navigationManager={navigationManagerRef.current}
              onComplete={() => {
                // Optional callback when export completes
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
        .spatial-node {
            margin: 2px 0;
        }
        .spatial-node-header {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 4px 8px;
            border-radius: 4px;
            cursor: pointer;
        }
        .spatial-node-header:hover {
            background-color: #f0f0f0;
        }
        .spatial-node-toggle {
            background: none;
            border: none;
            cursor: pointer;
            font-size: 10px;
            padding: 0;
            width: 16px;
        }
        .spatial-node-name {
            flex: 1;
            font-size: 13px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .spatial-node-count {
            font-size: 11px;
            color: #666;
        }
        .spatial-node-actions {
            display: flex;
            gap: 4px;
            align-items: center;
        }
        .spatial-node-action {
            background: none;
            border: none;
            cursor: pointer;
            font-size: 14px;
            padding: 2px 4px;
        }
        @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
        }
        .logo-container {
            transition: opacity 0.2s ease;
            opacity: 0.7;
        }
        .logo-container:hover {
            opacity: 1;
        }
        .logo-container:hover .door-panel {
            transform: translateX(-45px);
            transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .door-panel {
            transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }
      `}</style>

      {/* Left Sidebar Container - Prevents overlap */}
      {loadedModelRef.current && (
        <div
          style={{
            position: 'fixed',
            top: '80px',
            left: '16px',
            zIndex: 1000,
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            maxHeight: 'calc(100vh - 100px)',
            overflowY: 'auto',
            overflowX: 'visible',
          }}
        >
          {/* Viewer Toolbar */}
          <ViewerToolbar
            navigationManager={navigationManagerRef.current}
            sectionBox={sectionBoxRef.current}
            onNavigationModeChange={setNavigationMode}
            onSectionBoxToggle={(enabled) => {
              if (sectionBoxRef.current) {
                if (enabled) {
                  sectionBoxRef.current.enable()
                  setIsSectionActive(true)
                } else {
                  sectionBoxRef.current.disable()
                  setIsSectionActive(false)
                }
                triggerRenderRef.current() // Force render
              }
            }}
            onSectionModeChange={(mode) => {
              // Clear previous section when changing modes
              if (sectionPlaneRef.current) {
                sectionPlaneRef.current.disable()
              }
              if (sectionBoxRef.current && mode !== 'box') {
                sectionBoxRef.current.disable()
              }
              // If turning off, clear section active state
              if (mode === 'off') {
                setIsSectionActive(false)
              }
              // If selecting box mode, enable section box
              if (mode === 'box' && sectionBoxRef.current) {
                sectionBoxRef.current.enable()
                setIsSectionActive(true)
              }
              setSectionMode(mode)
              triggerRenderRef.current() // Force render to show changes
            }}
            sectionMode={sectionMode}
            isSectionActive={isSectionActive}
            onSpatialPanelToggle={() => setShowSpatialPanel(!showSpatialPanel)}
            onTypeFilterToggle={() => setShowTypeFilter(!showTypeFilter)}
            onZoomWindowToggle={() => setZoomWindowActive(!zoomWindowActive)}
            onResetView={handleResetView}
            showSpatialPanel={showSpatialPanel}
            showTypeFilter={showTypeFilter}
            zoomWindowActive={zoomWindowActive}
          />

          {/* View Presets */}
          {navigationManagerRef.current && (
            <ViewPresets navigationManager={navigationManagerRef.current} />
          )}

          {/* Spatial Hierarchy Panel */}
          {showSpatialPanel && spatialStructure && (
            <SpatialHierarchyPanel
              spatialStructure={spatialStructure}
              visibilityManager={visibilityManagerRef.current}
              onClose={() => setShowSpatialPanel(false)}
            />
          )}

          {/* IFC Class Filter Panel */}
          {showTypeFilter && loadedModelRef.current && (
            <TypeFilterPanel
              visibilityManager={visibilityManagerRef.current}
              elements={loadedModelRef.current.elements}
              activeFilters={activeClassFilters}
              onFiltersChange={setActiveClassFilters}
              onClose={() => setShowTypeFilter(false)}
            />
          )}
        </div>
      )}
    </div>
  )
}

