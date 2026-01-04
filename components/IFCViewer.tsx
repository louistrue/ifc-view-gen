'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import * as THREE from 'three'
import { loadIFCModelWithFragments, clearFragmentsCache, getFragmentsCacheStats } from '@/lib/fragments-loader'
import { analyzeDoors } from '@/lib/door-analyzer'
import type { DoorContext } from '@/lib/door-analyzer'
import type { LoadedModel, ElementInfo } from '@/lib/ifc-types'
import BatchProcessor from './BatchProcessor'
import ModelManagerPanel, { getModelColor } from './ModelManagerPanel'
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

  // Multi-model state
  const [loadedModels, setLoadedModels] = useState<LoadedModel[]>([])
  const loadedModelsRef = useRef<LoadedModel[]>([])

  // Keep ref in sync with state
  useEffect(() => {
    loadedModelsRef.current = loadedModels
  }, [loadedModels])

  const [isLoading, setIsLoading] = useState(false)
  const [loadingProgress, setLoadingProgress] = useState(0)
  const [loadingStage, setLoadingStage] = useState<string>('')
  const [loadingModelName, setLoadingModelName] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [doorContexts, setDoorContexts] = useState<DoorContext[]>([])
  const [showBatchProcessor, setShowBatchProcessor] = useState(false)

  // Cache management
  const [showCacheInfo, setShowCacheInfo] = useState(false)
  const [cacheStats, setCacheStats] = useState<{ entries: number; totalSize: number; files: any[] } | null>(null)

  // Navigation and performance systems
  const navigationManagerRef = useRef<NavigationManager | null>(null)
  const visibilityManagerRef = useRef<ElementVisibilityManager | null>(null)
  const sectionBoxRef = useRef<SectionBox | null>(null)
  const sectionPlaneRef = useRef<SectionPlane | null>(null)
  const batchProcessorVisibleRef = useRef(false)
  const fragmentsManagerRef = useRef<any>(null)
  const triggerRenderRef = useRef<() => void>(() => { })
  const isLoadingRef = useRef(false)
  const loadQueueRef = useRef<File[]>([])

  // Spatial structure
  const [spatialStructure, setSpatialStructure] = useState<SpatialNode | null>(null)

  // UI state
  const [showSpatialPanel, setShowSpatialPanel] = useState(false)
  const [showTypeFilter, setShowTypeFilter] = useState(false)
  const [navigationMode, setNavigationMode] = useState<'orbit' | 'walk'>('orbit')
  const [zoomWindowActive, setZoomWindowActive] = useState(false)
  const [sectionMode, setSectionMode] = useState<SectionMode>('off')
  const [isSectionActive, setIsSectionActive] = useState(false)
  const [activeClassFilters, setActiveClassFilters] = useState<Set<string> | null>(null)

  // Computed state
  const hasModels = loadedModels.length > 0
  const allElements = loadedModels.flatMap(m => m.elements)

  useEffect(() => {
    if (!containerRef.current) return

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x222222)
    sceneRef.current = scene

    const camera = new THREE.PerspectiveCamera(
      75,
      containerRef.current.clientWidth / containerRef.current.clientHeight,
      0.1,
      1000
    )
    camera.position.set(10, 10, 10)
    camera.lookAt(0, 0, 0)
    cameraRef.current = camera

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    const containerWidth = containerRef.current.clientWidth
    const containerHeight = containerRef.current.clientHeight

    renderer.setSize(containerWidth, containerHeight)
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.localClippingEnabled = true
    renderer.domElement.tabIndex = 0
    renderer.domElement.style.outline = 'none'
    containerRef.current.appendChild(renderer.domElement)
    rendererRef.current = renderer

    camera.aspect = containerWidth / containerHeight
    camera.updateProjectionMatrix()

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6)
    scene.add(ambientLight)

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8)
    directionalLight.position.set(10, 10, 5)
    scene.add(directionalLight)

    let needsRender = true
    let lastTime = performance.now()

    triggerRenderRef.current = () => {
      needsRender = true
    }

    const animate = () => {
      animationFrameRef.current = requestAnimationFrame(animate)

      const currentTime = performance.now()
      const delta = (currentTime - lastTime) / 1000
      lastTime = currentTime

      if (navigationManagerRef.current) {
        const navNeedsUpdate = navigationManagerRef.current.update(delta)
        if (navNeedsUpdate) {
          needsRender = true
        }
      }

      if (needsRender) {
        if (fragmentsManagerRef.current) {
          fragmentsManagerRef.current.update(true)
        }
        renderer.render(scene, camera)
        needsRender = false
      }
    }
    animate()

    const markNeedsRender = () => {
      needsRender = true
      if (fragmentsManagerRef.current) {
        fragmentsManagerRef.current.update(true)
      }
    }

    const navManager = new NavigationManager(camera, scene, renderer)
    navManager.setNeedsRenderCallback(markNeedsRender)
    navManager.onModeChange((mode) => {
      setNavigationMode(mode)
      needsRender = true
    })
    navigationManagerRef.current = navManager

    const handleResize = () => {
      if (!containerRef.current || !camera || !renderer) return

      const containerWidth = containerRef.current.clientWidth
      const containerHeight = containerRef.current.clientHeight

      if (containerWidth <= 0 || containerHeight <= 0) return

      renderer.setSize(containerWidth, containerHeight)
      camera.aspect = containerWidth / containerHeight
      camera.updateProjectionMatrix()

      needsRender = true
    }
    window.addEventListener('resize', handleResize)
    setTimeout(handleResize, 0)

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault()
        if (navigationManagerRef.current) {
          const newMode = navigationMode === 'orbit' ? 'walk' : 'orbit'
          navigationManagerRef.current.setMode(newMode)
        }
      }

      if (e.key >= '1' && e.key <= '7' && navigationManagerRef.current) {
        const presets: Array<'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'iso'> = [
          'top', 'bottom', 'front', 'back', 'left', 'right', 'iso'
        ]
        const presetIndex = parseInt(e.key) - 1
        if (presetIndex >= 0 && presetIndex < presets.length) {
          navigationManagerRef.current.setViewPreset(presets[presetIndex])
        }
      }

      if (e.key === 'z' || e.key === 'Z') {
        setZoomWindowActive(prev => !prev)
      }

      if (e.key === 'r' || e.key === 'R') {
        handleResetView()
      }

      if (e.key === 'Escape') {
        setSectionMode('off')
        setZoomWindowActive(false)
      }

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

  const handleResetView = () => {
    if (sectionPlaneRef.current) {
      sectionPlaneRef.current.disable()
    }
    if (sectionBoxRef.current) {
      sectionBoxRef.current.disable()
    }
    if (visibilityManagerRef.current) {
      visibilityManagerRef.current.resetAllVisibility()
    }
    setActiveClassFilters(null)
    setSectionMode('off')
    setIsSectionActive(false)
    if (navigationManagerRef.current) {
      navigationManagerRef.current.setViewPreset('iso')
    }
    triggerRenderRef.current()
  }

  // Load a single model
  const loadModel = useCallback(async (file: File): Promise<LoadedModel | null> => {
    const modelId = `${file.name}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    const modelIndex = loadedModelsRef.current.length

    try {
      setLoadingModelName(file.name)
      setLoadingStage('Starting...')

      const loadedData = await loadIFCModelWithFragments(file, ({ percent, stage }) => {
        setLoadingProgress(percent)
        setLoadingStage(stage)
      })

      const group = loadedData.group

      // Center model if first model, otherwise align with existing models
      const box = new THREE.Box3().setFromObject(group)
      const center = box.getCenter(new THREE.Vector3())

      if (loadedModelsRef.current.length === 0) {
        group.position.sub(center)
      } else {
        // Get the combined center of existing models
        const existingBox = new THREE.Box3()
        loadedModelsRef.current.forEach(m => {
          if (m.visible) {
            existingBox.expandByObject(m.group)
          }
        })
        if (!existingBox.isEmpty()) {
          const existingCenter = existingBox.getCenter(new THREE.Vector3())
          group.position.sub(center).add(existingCenter)
        } else {
          group.position.sub(center)
        }
      }

      if (sceneRef.current) {
        sceneRef.current.add(group)
      }

      // Enable fragments optimizations
      if (cameraRef.current && loadedData.fragmentsModel) {
        loadedData.fragmentsModel.useCamera(cameraRef.current)
        fragmentsManagerRef.current = loadedData.fragmentsManager
        await loadedData.fragmentsManager.update(true)
      }

      const model: LoadedModel = {
        id: modelId,
        fileName: file.name,
        group,
        elements: loadedData.elements,
        fragmentsModel: loadedData.fragmentsModel,
        fragmentsManager: loadedData.fragmentsManager,
        color: getModelColor(modelIndex),
        visible: true,
        loadedAt: new Date(),
        elementCount: loadedData.elements.length,
      }

      return model
    } catch (err) {
      console.error('Error loading IFC:', err)
      throw err
    }
  }, [])

  // Process load queue
  const processLoadQueue = useCallback(async () => {
    if (isLoadingRef.current || loadQueueRef.current.length === 0) return

    isLoadingRef.current = true
    setIsLoading(true)
    setError(null)

    while (loadQueueRef.current.length > 0) {
      const file = loadQueueRef.current.shift()!

      try {
        const model = await loadModel(file)
        if (model) {
          setLoadedModels(prev => {
            const updated = [...prev, model]
            loadedModelsRef.current = updated
            return updated
          })
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : `Failed to load ${file.name}`)
      }
    }

    // After all models loaded, run analysis and setup
    await finalizeModelLoading()

    setIsLoading(false)
    setLoadingProgress(0)
    setLoadingStage('')
    setLoadingModelName('')
    isLoadingRef.current = false
  }, [loadModel])

  // Finalize after models are loaded
  const finalizeModelLoading = useCallback(async () => {
    const models = loadedModelsRef.current
    if (models.length === 0) return

    // Get the first model for visibility manager initialization
    const firstModel = models[0]
    if (firstModel.fragmentsModel) {
      const allElementsFromModels = models.flatMap(m => m.elements)
      const visibilityManager = new ElementVisibilityManager(
        firstModel.fragmentsModel,
        allElementsFromModels
      )
      visibilityManagerRef.current = visibilityManager

      if (firstModel.fragmentsManager) {
        visibilityManager.setFragmentsManager(firstModel.fragmentsManager)
      }
      visibilityManager.setRenderCallback(() => triggerRenderRef.current())

      // Extract spatial structure from first model
      const spatialRoot = await extractSpatialStructure(
        firstModel.fragmentsModel,
        firstModel.elements
      )
      setSpatialStructure(spatialRoot)
    }

    // Calculate combined bounds
    const combinedBox = new THREE.Box3()
    models.forEach(m => {
      if (m.visible) {
        combinedBox.expandByObject(m.group)
      }
    })

    // Initialize section tools
    if (sceneRef.current && rendererRef.current && !combinedBox.isEmpty()) {
      const sectionBox = new SectionBox(
        sceneRef.current,
        { min: combinedBox.min, max: combinedBox.max },
        rendererRef.current
      )
      sectionBoxRef.current = sectionBox

      const sectionPlane = new SectionPlane(
        sceneRef.current,
        combinedBox,
        rendererRef.current
      )
      sectionPlane.setOnChangeCallback(() => {
        triggerRenderRef.current()
      })
      sectionPlaneRef.current = sectionPlane
    }

    // Focus camera on combined model geometry
    if (cameraRef.current && containerRef.current && !combinedBox.isEmpty()) {
      const size = combinedBox.getSize(new THREE.Vector3())
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

      // CRITICAL: Update fragments with new camera position and trigger render
      if (firstModel.fragmentsModel && firstModel.fragmentsManager) {
        firstModel.fragmentsModel.useCamera(cameraRef.current)
        await firstModel.fragmentsManager.update(true)
      }

      if (navigationManagerRef.current) {
        navigationManagerRef.current.focusOn(new THREE.Vector3(0, 0, 0), distance)
        setTimeout(() => {
          if (navigationManagerRef.current) {
            navigationManagerRef.current.setViewPreset('iso')
          }
          // Trigger render after view preset change
          triggerRenderRef.current()
        }, 100)
      }

      // Force immediate render
      triggerRenderRef.current()
    }

    // Analyze doors from all models
    setLoadingStage('Analyzing doors...')
    const allElementsFromModels = models.flatMap(m => m.elements)

    // Create a combined model object for door analysis
    const combinedModel = {
      group: new THREE.Group(),
      elements: allElementsFromModels,
      fragmentsModel: firstModel.fragmentsModel,
      fragmentsManager: firstModel.fragmentsManager,
    }

    const contexts = await analyzeDoors(combinedModel)
    setDoorContexts(contexts)

    if (allElementsFromModels.length > 0) {
      setShowBatchProcessor(true)
      batchProcessorVisibleRef.current = true
    }

    // Final render trigger to ensure model is visible
    triggerRenderRef.current()
  }, [])

  // Add models handler
  const handleAddModels = useCallback((files: FileList) => {
    const ifcFiles = Array.from(files).filter(f => f.name.toLowerCase().endsWith('.ifc'))
    if (ifcFiles.length === 0) return

    loadQueueRef.current.push(...ifcFiles)
    processLoadQueue()
  }, [processLoadQueue])

  // Remove model handler
  const handleRemoveModel = useCallback((modelId: string) => {
    setLoadedModels(prev => {
      const modelToRemove = prev.find(m => m.id === modelId)
      if (modelToRemove && sceneRef.current) {
        sceneRef.current.remove(modelToRemove.group)
        modelToRemove.group.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.geometry.dispose()
            if (Array.isArray(child.material)) {
              child.material.forEach((mat) => mat.dispose())
            } else {
              child.material.dispose()
            }
          }
        })
      }

      const updated = prev.filter(m => m.id !== modelId)
      loadedModelsRef.current = updated

      // Re-analyze doors if models remain
      if (updated.length > 0) {
        const allElements = updated.flatMap(m => m.elements)
        analyzeDoors({ group: new THREE.Group(), elements: allElements }).then(contexts => {
          setDoorContexts(contexts)
        })
      } else {
        setDoorContexts([])
        setShowBatchProcessor(false)
      }

      return updated
    })

    triggerRenderRef.current()
  }, [])

  // Toggle model visibility
  const handleToggleVisibility = useCallback((modelId: string) => {
    setLoadedModels(prev => {
      return prev.map(m => {
        if (m.id === modelId) {
          m.group.visible = !m.visible
          return { ...m, visible: !m.visible }
        }
        return m
      })
    })
    triggerRenderRef.current()
  }, [])

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

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      if (rendererRef.current && containerRef.current && cameraRef.current) {
        const containerWidth = containerRef.current.clientWidth
        const containerHeight = containerRef.current.clientHeight

        if (containerWidth <= 0 || containerHeight <= 0) return

        rendererRef.current.setSize(containerWidth, containerHeight)
        cameraRef.current.aspect = containerWidth / containerHeight
        cameraRef.current.updateProjectionMatrix()

        batchProcessorVisibleRef.current = showBatchProcessor
      }
    }, 50)

    return () => clearTimeout(timeoutId)
  }, [showBatchProcessor, hasModels])

  // Get first model for compatibility with existing components
  const firstModel = loadedModels[0]

  return (
    <div className="ifc-viewer-container">
      {/* Top menu - only show when models are loaded */}
      {hasModels && (
        <div className="controls">
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
              <rect x="20" y="10" width="60" height="80" fill="none" stroke="#4a5568" strokeWidth="2.5" strokeLinecap="round" />
              <g className="door-panel">
                <rect x="25" y="15" width="50" height="70" fill="#3b82f6" opacity="0.15" stroke="#3b82f6" strokeWidth="2" />
                <circle cx="70" cy="50" r="3" fill="#3b82f6" opacity="0.4" />
              </g>
            </svg>
          </div>

          <div className="header-info">
            <span className="app-title">Door View Generator</span>
            {doorContexts.length > 0 && (
              <span className="door-count-badge">
                {doorContexts.length} door{doorContexts.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>

          <div className="header-actions">
            <button
              onClick={() => setShowCacheInfo(!showCacheInfo)}
              className="cache-button"
              title="Manage fragments cache"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
              </svg>
              Cache
            </button>
          </div>

          {error && <div className="error-message">{error}</div>}
        </div>
      )}

      {showCacheInfo && (
        <div className="cache-info-overlay">
          <div className="cache-info">
            <div className="cache-header">
              <h3>Fragments Cache</h3>
              <button onClick={() => setShowCacheInfo(false)} className="close-btn">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
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
        </div>
      )}

      <div className="viewer-layout" style={{ position: 'relative' }}>
        <div
          ref={containerRef}
          className="viewer-canvas"
          style={{
            width: '100%',
            height: '100%',
            flex: 1,
          }}
        />

        <ZoomWindowOverlay
          active={zoomWindowActive}
          onComplete={() => setZoomWindowActive(false)}
          navigationManager={navigationManagerRef.current}
          containerRef={containerRef}
        />

        <SectionDrawOverlay
          active={sectionMode === 'line' || sectionMode === 'face'}
          mode={sectionMode === 'line' ? 'line' : 'face'}
          onComplete={() => setSectionMode('off')}
          onSectionEnabled={() => {
            setIsSectionActive(true)
            triggerRenderRef.current()
          }}
          sectionPlane={sectionPlaneRef.current}
          camera={cameraRef.current}
          scene={sceneRef.current}
          containerRef={containerRef}
        />

        {/* Landing UI overlay when no model loaded */}
        {!hasModels && !isLoading && (
          <div className="landing-overlay">
            <div className="landing-content">
              <div className="landing-icon">
                <svg
                  width="48"
                  height="48"
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
              <h2 className="landing-title">Door View Generator</h2>
              <p className="landing-description">
                Generate professional SVG door views from IFC building models.
                Upload one or more IFC files to get started.
              </p>

              <label className="upload-zone">
                <svg
                  width="32"
                  height="32"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                <span className="upload-text">Drop IFC files here or click to browse</span>
                <span className="upload-hint">Supports multiple .ifc files</span>
                <input
                  type="file"
                  accept=".ifc"
                  multiple
                  onChange={(e) => e.target.files && handleAddModels(e.target.files)}
                  style={{ display: 'none' }}
                />
              </label>

              <div className="landing-steps">
                <div className="step">
                  <div className="step-number active">1</div>
                  <div className="step-label">Upload IFC</div>
                </div>
                <div className="step-divider" />
                <div className="step">
                  <div className="step-number">2</div>
                  <div className="step-label">Find Doors</div>
                </div>
                <div className="step-divider" />
                <div className="step">
                  <div className="step-number">3</div>
                  <div className="step-label">Export SVG</div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Loading state overlay */}
        {isLoading && (
          <div className="loading-overlay">
            <div className="loading-spinner" />
            <div className="loading-info">
              <div className="loading-file">{loadingModelName}</div>
              <div className="loading-stage">{loadingStage || 'Loading...'}</div>
              <div className="loading-progress">{Math.round(loadingProgress)}%</div>
            </div>
          </div>
        )}

        {showBatchProcessor && doorContexts.length > 0 && (
          <div className="batch-panel">
            <BatchProcessor
              doorContexts={doorContexts}
              onComplete={() => { }}
            />
          </div>
        )}
      </div>

      {/* Model Manager Panel - show when models are loaded */}
      {hasModels && (
        <div className="model-manager-container">
          <ModelManagerPanel
            models={loadedModels}
            onAddModels={handleAddModels}
            onRemoveModel={handleRemoveModel}
            onToggleVisibility={handleToggleVisibility}
            isLoading={isLoading}
            loadingModelName={loadingModelName}
          />
        </div>
      )}

      {/* Left Sidebar Container */}
      {hasModels && firstModel && (
        <div className="left-sidebar">
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
                triggerRenderRef.current()
              }
            }}
            onSectionModeChange={(mode) => {
              if (sectionPlaneRef.current) {
                sectionPlaneRef.current.disable()
              }
              if (sectionBoxRef.current && mode !== 'box') {
                sectionBoxRef.current.disable()
              }
              if (mode === 'off') {
                setIsSectionActive(false)
              }
              if (mode === 'box' && sectionBoxRef.current) {
                sectionBoxRef.current.enable()
                setIsSectionActive(true)
              }
              setSectionMode(mode)
              triggerRenderRef.current()
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

          {navigationManagerRef.current && (
            <ViewPresets navigationManager={navigationManagerRef.current} />
          )}

          {showSpatialPanel && spatialStructure && (
            <SpatialHierarchyPanel
              spatialStructure={spatialStructure}
              visibilityManager={visibilityManagerRef.current}
              onClose={() => setShowSpatialPanel(false)}
            />
          )}

          {showTypeFilter && allElements.length > 0 && (
            <TypeFilterPanel
              visibilityManager={visibilityManagerRef.current}
              elements={allElements}
              activeFilters={activeClassFilters}
              onFiltersChange={setActiveClassFilters}
              onClose={() => setShowTypeFilter(false)}
            />
          )}
        </div>
      )}

      <style jsx>{`
        .controls {
          display: flex;
          align-items: center;
          gap: 16px;
          padding: 12px 16px;
          background: linear-gradient(180deg, #1a1a1a 0%, #151515 100%);
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        }

        .header-info {
          display: flex;
          align-items: center;
          gap: 12px;
          flex: 1;
        }

        .app-title {
          color: #e0e0e0;
          font-size: 15px;
          font-weight: 500;
        }

        .door-count-badge {
          background: rgba(34, 197, 94, 0.15);
          color: #4ade80;
          padding: 4px 10px;
          border-radius: 12px;
          font-size: 12px;
          font-weight: 500;
        }

        .header-actions {
          display: flex;
          gap: 8px;
        }

        .cache-button {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 6px 12px;
          background: rgba(255, 255, 255, 0.08);
          color: #999;
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 6px;
          cursor: pointer;
          font-size: 13px;
          transition: all 0.2s;
        }

        .cache-button:hover {
          background: rgba(255, 255, 255, 0.12);
          color: #e0e0e0;
        }

        .cache-info-overlay {
          position: fixed;
          top: 60px;
          right: 16px;
          z-index: 1000;
        }

        .cache-info {
          background: #1e1e1e;
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 12px;
          padding: 16px;
          max-width: 320px;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
        }

        .cache-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 12px;
        }

        .cache-info h3 {
          margin: 0;
          color: #e0e0e0;
          font-size: 14px;
          font-weight: 600;
        }

        .close-btn {
          background: transparent;
          border: none;
          color: #666;
          cursor: pointer;
          padding: 4px;
          border-radius: 4px;
          transition: all 0.2s;
        }

        .close-btn:hover {
          background: rgba(255, 255, 255, 0.1);
          color: #fff;
        }

        .cache-info p {
          margin: 0 0 12px 0;
          color: #888;
          font-size: 12px;
          line-height: 1.5;
        }

        .cache-stats > div {
          margin-bottom: 8px;
          font-size: 13px;
          color: #ccc;
        }

        .cached-files {
          margin: 12px 0;
          padding: 8px;
          background: rgba(0, 0, 0, 0.3);
          border-radius: 6px;
          max-height: 150px;
          overflow-y: auto;
        }

        .cached-file {
          display: flex;
          justify-content: space-between;
          padding: 6px 0;
          border-bottom: 1px solid rgba(255, 255, 255, 0.05);
          font-size: 12px;
          color: #999;
        }

        .cached-file:last-child {
          border-bottom: none;
        }

        .file-size {
          color: #666;
        }

        .clear-cache-button {
          width: 100%;
          padding: 8px;
          background: rgba(239, 68, 68, 0.15);
          color: #ef4444;
          border: 1px solid rgba(239, 68, 68, 0.3);
          border-radius: 6px;
          cursor: pointer;
          font-size: 13px;
          transition: all 0.2s;
        }

        .clear-cache-button:hover {
          background: rgba(239, 68, 68, 0.25);
        }

        .error-message {
          color: #ff4444;
          font-size: 13px;
          padding: 6px 12px;
          background: rgba(255, 68, 68, 0.1);
          border-radius: 6px;
          border: 1px solid rgba(255, 68, 68, 0.2);
        }

        .model-manager-container {
          position: fixed;
          top: 70px;
          right: 16px;
          z-index: 100;
        }

        .left-sidebar {
          position: fixed;
          top: 70px;
          left: 16px;
          z-index: 100;
          display: flex;
          flex-direction: column;
          gap: 12px;
          max-height: calc(100vh - 90px);
          overflow-y: auto;
          overflow-x: visible;
        }

        .landing-overlay {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          background: linear-gradient(135deg, #1a1a1a 0%, #0f0f0f 100%);
          z-index: 10;
        }

        .landing-content {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 24px;
          max-width: 480px;
          text-align: center;
          padding: 40px;
        }

        .landing-icon {
          width: 100px;
          height: 100px;
          border-radius: 24px;
          background: rgba(59, 130, 246, 0.1);
          border: 2px dashed rgba(59, 130, 246, 0.3);
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .landing-title {
          margin: 0;
          font-size: 28px;
          font-weight: 600;
          color: #e0e0e0;
        }

        .landing-description {
          margin: 0;
          font-size: 15px;
          color: #888;
          line-height: 1.6;
        }

        .upload-zone {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 12px;
          width: 100%;
          padding: 40px;
          border: 2px dashed #333;
          border-radius: 16px;
          background: rgba(255, 255, 255, 0.02);
          cursor: pointer;
          transition: all 0.2s;
          color: #666;
        }

        .upload-zone:hover {
          border-color: #3b82f6;
          background: rgba(59, 130, 246, 0.05);
          color: #60a5fa;
        }

        .upload-text {
          font-size: 14px;
          font-weight: 500;
        }

        .upload-hint {
          font-size: 12px;
          opacity: 0.7;
        }

        .landing-steps {
          display: flex;
          align-items: center;
          gap: 16px;
          margin-top: 16px;
        }

        .step {
          text-align: center;
        }

        .step-number {
          width: 36px;
          height: 36px;
          border-radius: 50%;
          background: #2a2a2a;
          color: #666;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 16px;
          font-weight: 600;
          margin: 0 auto 8px;
        }

        .step-number.active {
          background: rgba(59, 130, 246, 0.2);
          color: #3b82f6;
        }

        .step-label {
          font-size: 12px;
          color: #666;
        }

        .step-divider {
          width: 40px;
          height: 1px;
          background: #333;
          margin-bottom: 24px;
        }

        .loading-overlay {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          background: rgba(15, 15, 15, 0.95);
          gap: 24px;
          z-index: 10;
        }

        .loading-spinner {
          width: 56px;
          height: 56px;
          border: 3px solid #333;
          border-top-color: #3b82f6;
          border-radius: 50%;
          animation: spin 1s linear infinite;
        }

        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }

        .loading-info {
          text-align: center;
        }

        .loading-file {
          font-size: 14px;
          color: #888;
          margin-bottom: 8px;
        }

        .loading-stage {
          font-size: 16px;
          color: #e0e0e0;
          font-weight: 500;
        }

        .loading-progress {
          font-size: 36px;
          color: #3b82f6;
          font-weight: 600;
          margin-top: 8px;
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

        :global(.door-panel) {
          transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }
      `}</style>
    </div>
  )
}
