/**
 * True Fragments integration using @thatopen/fragments
 * Provides high-performance BIM model loading with the Fragments format
 */

import * as THREE from 'three';
import { IfcImporter, FragmentsModels, FragmentsModel, LodMode } from '@thatopen/fragments';
import type { ElementInfo, LoadedIFCModel } from './ifc-types';

// IndexedDB configuration for fragment binary caching
const DB_NAME = 'Fragments_Binary_Cache';
const DB_VERSION = 1;
const STORE_NAME = 'fragmentBinaries';

// Mapping from IFC class names to web-ifc type codes
const IFC_TYPE_CODE_MAP: Record<string, number> = {
  'IfcDoor': 64,
  'IfcWall': 65,
  'IfcWallStandardCase': 65,
  'IfcElectricAppliance': 266,
  'IfcLightFixture': 267,
  'IfcElectricDistributionBoard': 268,
  'IfcSwitchingDevice': 269,
  'IfcOutlet': 270,
  'IfcFlowTerminal': 271,
};

// Helper to get IFC type code from class name
function getIfcTypeCode(typeName: string): number {
  // Try exact match first
  if (IFC_TYPE_CODE_MAP[typeName]) {
    return IFC_TYPE_CODE_MAP[typeName];
  }
  // Try case-insensitive match
  const lower = typeName.toLowerCase();
  for (const [key, value] of Object.entries(IFC_TYPE_CODE_MAP)) {
    if (key.toLowerCase() === lower) {
      return value;
    }
  }
  // Default to -1 if unknown
  return -1;
}

interface LoadedFragmentsModel extends Omit<LoadedIFCModel, 'modelID' | 'api'> {
  fragmentsModel: FragmentsModel;
  fragmentsManager: FragmentsModels; // Manager for calling update() in render loop
}

interface CachedFragmentData {
  id: string;
  fileName: string;
  timestamp: number;
  fragmentBytes: Uint8Array;
  // Note: We don't cache metadata anymore since it requires the loaded model
  // Metadata will be extracted fresh each time from the fragments model
}

// Singleton fragments manager
let fragmentsManager: FragmentsModels | null = null;

/**
 * Initialize the FragmentsModels manager
 */
async function getFragmentsManager(): Promise<FragmentsModels> {
  if (fragmentsManager) return fragmentsManager;

  // Initialize with web worker path for threading
  const workerPath = '/fragments-worker/worker.mjs';
  fragmentsManager = new FragmentsModels(workerPath);

  return fragmentsManager;
}

/**
 * Initialize IndexedDB for fragment binary caching
 */
async function initDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
  });
}

/**
 * Get cached fragment binary from IndexedDB
 */
async function getCachedFragment(fileId: string): Promise<CachedFragmentData | null> {
  try {
    const db = await initDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(fileId);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.warn('Failed to get cached fragment:', error);
    return null;
  }
}

/**
 * Save fragment binary to IndexedDB cache
 */
async function cacheFragment(data: CachedFragmentData): Promise<void> {
  try {
    const db = await initDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put(data);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.warn('Failed to cache fragment:', error);
  }
}

/**
 * Generate a unique ID for a file based on its content
 */
async function generateFileId(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer.slice(0, 100000));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return `${file.name}_${file.size}_${hashHex.substring(0, 16)}`;
}

/**
 * Extract THREE.Mesh objects from a THREE.Group
 */
function extractMeshesFromGroup(group: THREE.Group): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  group.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      meshes.push(child);
    }
  });
  return meshes;
}

// IFC categories needed for door SVG generation
const DOOR_SVG_CATEGORIES = new Set([
  // Doors and openings
  'IFCDOOR',
  'IFCWINDOW',
  'IFCOPENINGELEMENT',
  // Walls
  'IFCWALL',
  'IFCWALLSTANDARDCASE',
  'IFCCURTAINWALL',
  // Context
  'IFCSLAB',
  // Electrical devices (all types)
  'IFCFLOWTERMINAL',
  'IFCLIGHTFIXTURE',
  'IFCOUTLET',
  'IFCSWITCHINGDEVICE',
  'IFCELECTRICALDISTRIBUTIONPOINT',
  'IFCELECTRICAPPLIANCE',
  'IFCFLOWCONTROLLER',
  'IFCFLOWSEGMENT',
  'IFCDISTRIBUTIONCONTROLELEMENT',
  'IFCDISTRIBUTIONFLOWELEMENT',
  'IFCELECTRICDISTRIBUTIONBOARD',
  'IFCJUNCTIONBOX',
  'IFCCABLECARRIERSEGMENT',
  'IFCCABLESEGMENT',
])

/**
 * Extract metadata from fragments model using the correct API
 * Uses ItemGeometry API to get world transforms and apply them to meshes
 * This ensures meshes have correct matrixWorld for SVG generation
 * 
 * @param fragmentsModel - The loaded fragments model
 * @param filterCategories - If true, only extract door-related elements (faster)
 */
async function extractMetadata(fragmentsModel: FragmentsModel, filterCategories: boolean = true): Promise<ElementInfo[]> {
  const elements: ElementInfo[] = [];

  try {
    // Get all categories (IFC class names) and items in parallel
    const [categories, items, localIdsWithGeometry, itemCategories] = await Promise.all([
      fragmentsModel.getCategories(),
      fragmentsModel.getItemsWithGeometry(),
      fragmentsModel.getItemsIdsWithGeometry(),
      fragmentsModel.getItemsWithGeometryCategories(),
    ]);
    console.log(`Found ${categories.length} IFC categories`);
    console.log(`Found ${items.length} items with geometry`);

    if (items.length === 0) {
      console.warn('No items with geometry found in fragments model');
      return elements;
    }

    // Filter to only door-related categories for faster loading
    let filteredIndices: number[] = [];
    if (filterCategories) {
      for (let i = 0; i < itemCategories.length; i++) {
        const cat = itemCategories[i]?.toUpperCase() || '';
        if (DOOR_SVG_CATEGORIES.has(cat)) {
          filteredIndices.push(i);
        }
      }
      console.log(`Filtered to ${filteredIndices.length} door-related elements (from ${items.length})`);
    } else {
      filteredIndices = Array.from({ length: items.length }, (_, i) => i);
    }

    // Get only filtered localIds
    const filteredLocalIds = filteredIndices.map(i => localIdsWithGeometry[i]);

    // Only fetch detailed attributes for doors (saves time for walls/windows)
    const doorLocalIds = filteredLocalIds.filter((_, idx) => {
      const cat = itemCategories[filteredIndices[idx]]?.toUpperCase() || '';
      return cat === 'IFCDOOR';
    });

    // Fetch data for filtered items in parallel
    // Note: Only fetching detailed itemsData for doors since walls/windows don't need attributes
    const [doorItemsData, guids, worldBoxes, fragmentElements] = await Promise.all([
      doorLocalIds.length > 0
        ? fragmentsModel.getItemsData(doorLocalIds, {
          attributesDefault: true,
          relationsDefault: { attributes: false, relations: false },
        })
        : Promise.resolve([]),
      fragmentsModel.getGuidsByLocalIds(filteredLocalIds),
      fragmentsModel.getBoxes(filteredLocalIds),
      (fragmentsModel as any)._getElements(filteredLocalIds),
    ]);

    // Create map for door data lookup
    const doorDataMap = new Map<number, any>();
    doorLocalIds.forEach((id, idx) => {
      doorDataMap.set(id, doorItemsData[idx]);
    });
    console.log(`Got ${worldBoxes.length} world-space bounding boxes`);
    console.log(`Got ${fragmentElements.length} Element objects`);

    // Create arrays for direct index-based access (faster than maps)
    // fragmentElements are already in the same order as filteredLocalIds

    // Get filtered items - these correspond 1:1 with filteredLocalIds
    const filteredItems = filteredIndices.map(i => items[i]);

    // Process items in parallel batches for speed
    // Larger batch = more parallelism but more memory
    const batchSize = 200;
    for (let batchStart = 0; batchStart < filteredItems.length; batchStart += batchSize) {
      const batchEnd = Math.min(batchStart + batchSize, filteredItems.length);

      // Process batch in parallel using index for direct array access
      const batchPromises: Promise<ElementInfo | null>[] = [];
      for (let i = batchStart; i < batchEnd; i++) {
        const item = filteredItems[i];
        const dataIndex = i; // Direct index - no map lookup needed
        const localId = filteredLocalIds[i];
        const originalIndex = filteredIndices[i];

        batchPromises.push((async () => {
          try {
            const worldBox = worldBoxes[dataIndex];
            const globalId = guids[dataIndex] || undefined;
            const category = itemCategories[originalIndex] || 'Unknown';

            // Only get detailed data for doors
            const itemData = doorDataMap.get(localId);

            // Extract type name from category or itemData (for doors)
            let typeName = category;
            if ((!typeName || typeName === 'Unknown') && itemData) {
              if (typeof itemData === 'object') {
                for (const [key, value] of Object.entries(itemData)) {
                  if (key.toLowerCase().includes('type') && typeof value === 'object' && value !== null) {
                    const attrValue = (value as any).value;
                    if (typeof attrValue === 'string' && attrValue.length > 0) {
                      typeName = attrValue;
                      break;
                    }
                  }
                }
              }
            }

            // Get IFC type code
            const ifcType = getIfcTypeCode(typeName);

            // Get geometry with transforms using ItemGeometry API
            const geometry = await item.getGeometry();
            if (!geometry) return null;

            // Get world transform matrices - these are the key to correct SVG rendering!
            const transforms = await geometry.getTransform();

            // Get Element object for getMeshes() - direct array access
            const element = fragmentElements[dataIndex];
            if (!element) return null;

            // Get meshes from Element.getMeshes()
            let meshGroup: THREE.Group | null = null;
            try {
              meshGroup = await element.getMeshes();
            } catch (e) {
              console.warn(`getMeshes failed for localId ${localId}:`, e);
            }

            if (!meshGroup) {
              console.warn(`No mesh group for localId ${localId}`);
              return null;
            }

            // Extract meshes from the group
            const meshes = extractMeshesFromGroup(meshGroup);

            if (meshes.length === 0) {
              console.warn(`No meshes extracted from group for localId ${localId}`);
              return null;
            }
            
            // Verify mesh has valid geometry and debug geometry structure
            let hasValidGeometry = false;
            for (const mesh of meshes) {
              const geo = mesh.geometry;
              const posAttr = geo?.attributes?.position;
              
              // Check for interleaved buffer attributes (Fragments optimization)
              if (posAttr && 'isInterleavedBufferAttribute' in posAttr) {
                // Interleaved buffer - need to de-interleave for standard operations
                console.log(`[Fragments] Mesh ${localId}: Found InterleavedBufferAttribute, count=${posAttr.count}`);
                
                // Create standard BufferAttribute from interleaved data
                const count = posAttr.count;
                const newPositions = new Float32Array(count * 3);
                for (let v = 0; v < count; v++) {
                  newPositions[v * 3] = posAttr.getX(v);
                  newPositions[v * 3 + 1] = posAttr.getY(v);
                  newPositions[v * 3 + 2] = posAttr.getZ(v);
                }
                geo.setAttribute('position', new THREE.BufferAttribute(newPositions, 3));
                hasValidGeometry = true;
              } else if (posAttr?.count > 0) {
                hasValidGeometry = true;
              }
            }
            
            if (!hasValidGeometry) {
              console.warn(`[Fragments] No valid geometry for localId ${localId}`);
            }

            // Apply world transforms to meshes - CRITICAL for correct SVG generation!
            // We MUST bake the transform into the geometry vertices, not just set mesh.matrix,
            // because EdgesGeometry extracts edges from local geometry and doesn't respect mesh transforms.
            if (transforms && transforms.length > 0) {
              for (let j = 0; j < meshes.length && j < transforms.length; j++) {
                const mesh = meshes[j];
                const transform = transforms[j];

                if (transform && mesh.geometry) {
                  // Clone the geometry to avoid modifying shared geometry
                  mesh.geometry = mesh.geometry.clone();

                  // Apply the transform directly to the geometry vertices
                  // This ensures EdgesGeometry will work with world-space coordinates
                  mesh.geometry.applyMatrix4(transform);

                  // Reset mesh transforms since geometry is now in world space
                  mesh.position.set(0, 0, 0);
                  mesh.rotation.set(0, 0, 0);
                  mesh.scale.set(1, 1, 1);
                  mesh.updateMatrixWorld(true);
                }
              }
            }

            const primaryMesh = meshes[0];

            // Use world-space bounding box from Fragments API (proper way!)
            // This box is already correctly positioned and transformed in world space
            const boundingBox = worldBox && !worldBox.isEmpty() ? worldBox : undefined;

            // Create ElementInfo
            const elementInfo: ElementInfo = {
              expressID: localId,
              ifcType,
              typeName,
              mesh: primaryMesh,
              meshes: meshes.length > 0 ? meshes : undefined,
              boundingBox,
              globalId,
            };

            // Store elementInfo in mesh userData for later lookup
            meshes.forEach(mesh => {
              mesh.userData.expressID = localId;
              mesh.userData.elementInfo = elementInfo;
            });

            return elementInfo;
          } catch (error) {
            console.warn(`Failed to process item:`, error);
            return null;
          }
        })());
      }

      const batchResults = await Promise.all(batchPromises);
      batchResults.forEach(result => {
        if (result) {
          elements.push(result);
        }
      });
    }

    console.log(`✓ Extracted ${elements.length} elements from fragments model`);

    // Log some statistics
    const doorCount = elements.filter(e => e.typeName.toLowerCase().includes('door')).length;
    const wallCount = elements.filter(e => e.typeName.toLowerCase().includes('wall')).length;
    const windowCount = elements.filter(e => e.typeName.toLowerCase().includes('window')).length;
    console.log(`  - Doors: ${doorCount}, Walls: ${wallCount}, Windows: ${windowCount}`);

  } catch (error) {
    console.error('Failed to extract metadata from fragments:', error);
  }

  return elements;
}

/**
 * Load IFC model using true Fragments format
 * Provides 10x+ faster loading with the optimized Fragments binary format!
 */
export interface LoadingProgress {
  percent: number;
  stage: string;
}

export async function loadIFCModelWithFragments(
  file: File,
  onProgress?: (progress: LoadingProgress) => void
): Promise<LoadedFragmentsModel> {
  console.log('Loading IFC model with Fragments...');

  // Stage 1: Initialize
  onProgress?.({ percent: 0, stage: 'Initializing...' });

  const fileId = await generateFileId(file);
  onProgress?.({ percent: 5, stage: 'Checking cache...' });

  const cached = await getCachedFragment(fileId);

  let fragmentBytes: Uint8Array;

  if (cached) {
    // Cached path - faster
    console.log('✓ Loading from cached Fragments binary (ultra-fast!)');
    onProgress?.({ percent: 10, stage: 'Loading from cache...' });

    // Simulate a brief delay to show the stage (cache read is too fast)
    await new Promise(r => setTimeout(r, 100));

    fragmentBytes = cached.fragmentBytes;
    onProgress?.({ percent: 30, stage: 'Cache loaded' });
  } else {
    // Fresh conversion path
    console.log('Converting IFC to Fragments binary (first-time conversion)...');
    onProgress?.({ percent: 10, stage: 'Reading IFC file...' });

    // Initialize the IFC importer
    const importer = new IfcImporter();

    // Configure web-ifc WASM path
    importer.wasm = {
      path: '/wasm/web-ifc/',
      absolute: true,
    };

    onProgress?.({ percent: 15, stage: 'Initializing parser...' });

    // Read file as buffer
    const buffer = await file.arrayBuffer();
    const uint8 = new Uint8Array(buffer);

    onProgress?.({ percent: 20, stage: 'Parsing IFC structure...' });

    // Convert IFC to Fragments binary format
    // This is the key step that creates the optimized format!
    fragmentBytes = await importer.process({
      bytes: uint8,
      progressCallback: (progress) => {
        // Map importer progress (0-1) to our progress (20-60)
        const percent = Math.round(20 + progress * 40);
        onProgress?.({ percent, stage: `Converting geometry (${Math.round(progress * 100)}%)...` });
      },
    });

    onProgress?.({ percent: 65, stage: 'Saving to cache...' });

    // Cache the fragment binary for future use
    await cacheFragment({
      id: fileId,
      fileName: file.name,
      timestamp: Date.now(),
      fragmentBytes,
    });

    console.log('✓ Fragments binary cached for future use');
    onProgress?.({ percent: 70, stage: 'Cached for next time' });
  }

  // Stage 2: Load into renderer
  onProgress?.({ percent: 75, stage: 'Building 3D scene...' });

  const manager = await getFragmentsManager();
  const modelId = `model_${Date.now()}`;

  const fragmentsModel = await manager.load(fragmentBytes, { modelId });

  onProgress?.({ percent: 80, stage: 'Optimizing rendering...' });

  // Update the manager to prepare for rendering
  await manager.update(true);

  onProgress?.({ percent: 85, stage: 'Extracting metadata...' });

  // Extract metadata from the loaded fragments model
  // This creates properly transformed meshes for SVG generation ONLY
  // NOTE: We do NOT add these meshes to the 3D scene - we use fragmentsModel.object instead!
  const elements = await extractMetadata(fragmentsModel);

  onProgress?.({ percent: 95, stage: 'Finalizing...' });

  // CRITICAL: Use Fragments' optimized scene object for 3D rendering
  // This provides LOD, frustum culling, instanced rendering, and all performance optimizations!
  const group = new THREE.Group();
  group.name = file.name;

  // Add Fragments' optimized scene object (contains all performance optimizations)
  if (fragmentsModel.object) {
    group.add(fragmentsModel.object);
  }

  // Configure Fragments performance settings
  // Enable LOD system for automatic level-of-detail based on camera distance
  await fragmentsModel.setLodMode(LodMode.DEFAULT);

  // Configure manager settings for optimal performance
  manager.settings.maxUpdateRate = 100; // Max 10 updates per second (100ms)
  manager.settings.graphicsQuality = 0.8; // High quality (0-1 scale)
  manager.settings.forceUpdateRate = 200; // Force update every 200ms if needed

  console.log(`✓ Loaded ${elements.length} elements using Fragments format`);
  console.log(`✓ Using Fragments optimized rendering (LOD, culling, instancing enabled)`);
  console.log(`✓ Extracted meshes available for SVG generation: ${elements.length} elements`);
  onProgress?.({ percent: 100, stage: 'Complete!' });

  return {
    group,
    elements,
    fragmentsModel,
    fragmentsManager: manager, // Return manager for update() calls in render loop
  };
}

/**
 * Clear fragments binary cache
 */
export async function clearFragmentsCache(): Promise<void> {
  try {
    const db = await initDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.clear();
      request.onsuccess = () => {
        console.log('Fragments cache cleared');
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error('Failed to clear cache:', error);
  }
}

/**
 * Get cache statistics
 */
export async function getFragmentsCacheStats(): Promise<{
  entries: number;
  totalSize: number;
  files: Array<{ fileName: string; timestamp: Date; size: number }>;
}> {
  try {
    const db = await initDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();

      request.onsuccess = () => {
        const entries = request.result as CachedFragmentData[];
        const files = entries.map(entry => ({
          fileName: entry.fileName,
          timestamp: new Date(entry.timestamp),
          size: entry.fragmentBytes.byteLength,
        }));

        const totalSize = files.reduce((sum, file) => sum + file.size, 0);

        resolve({
          entries: entries.length,
          totalSize,
          files,
        });
      };
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error('Failed to get cache stats:', error);
    return { entries: 0, totalSize: 0, files: [] };
  }
}

/**
 * Dispose of fragments manager and cleanup resources
 */
export async function disposeFragmentsManager(): Promise<void> {
  if (fragmentsManager) {
    await fragmentsManager.dispose();
    fragmentsManager = null;
  }
}
