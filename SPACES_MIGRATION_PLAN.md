# Migration Plan: Doors to IFC Spaces (Rooms)

## Executive Summary

This document outlines a comprehensive plan to transform the door-view-creator tool into a **space/room-view-creator** that extracts room data (floor area, dimensions, boundaries) and generates floor plan views of rooms for export to Airtable.

---

## Table of Contents

1. [Overview of Changes](#1-overview-of-changes)
2. [Data Model Changes](#2-data-model-changes)
3. [IFC Space Analysis (space-analyzer.ts)](#3-ifc-space-analysis)
4. [SVG Floor Plan Renderer](#4-svg-floor-plan-renderer)
5. [API & Airtable Schema Changes](#5-api--airtable-schema-changes)
6. [UI Component Changes](#6-ui-component-changes)
7. [File Changes Summary](#7-file-changes-summary)
8. [Implementation Phases](#8-implementation-phases)
9. [Technical Considerations](#9-technical-considerations)

---

## 1. Overview of Changes

### Current State (Doors)
- Extracts IFCDOOR elements from IFC files
- Analyzes door context (host wall, nearby devices, opening direction)
- Generates elevation and plan SVG views of doors
- Exports door data + views to Airtable

### Target State (Spaces/Rooms)
- Extract IFCSPACE elements from IFC files
- Analyze space properties (area, volume, boundaries, adjacent spaces)
- Generate floor plan SVG views of rooms
- Export space data + floor plans to Airtable

### Mapping: Door Concepts → Space Concepts

| Door Concept | Space Concept |
|--------------|---------------|
| IFCDOOR | IFCSPACE |
| Door Type Name | Space Type (Office, Meeting Room, etc.) |
| Opening Direction | Space Function/Usage |
| Host Wall | Boundary Walls |
| Nearby Devices | Contained Elements (furniture, fixtures) |
| Door Elevation View | N/A (not applicable for spaces) |
| Door Plan View | Room Floor Plan View |
| Door GlobalId | Space GlobalId |
| Door Storey | Space Storey |

---

## 2. Data Model Changes

### 2.1 New TypeScript Interfaces

Create new file: `lib/ifc-space-types.ts`

```typescript
import * as THREE from 'three';
import { ElementInfo } from './ifc-types';

/**
 * Represents an IFC Space (room) with all extracted properties
 */
export interface SpaceInfo extends ElementInfo {
  // IFC Properties
  longName?: string;           // Full descriptive name
  objectType?: string;         // Space type classification

  // Qto_SpaceBaseQuantities (IFC standard quantities)
  grossFloorArea?: number;     // m² - Total floor area
  netFloorArea?: number;       // m² - Usable floor area
  grossVolume?: number;        // m³ - Total volume
  netVolume?: number;          // m³ - Usable volume
  height?: number;             // m - Room height
  perimeter?: number;          // m - Room perimeter

  // Calculated/Derived
  centerPoint?: THREE.Vector3; // Center of space
  boundaryPoints?: THREE.Vector2[]; // 2D floor boundary polygon
  boundingBox2D?: {            // 2D bounding rectangle
    min: THREE.Vector2;
    max: THREE.Vector2;
    width: number;
    depth: number;
  };
}

/**
 * Context for a space including relationships and geometry
 */
export interface SpaceContext {
  space: SpaceInfo;

  // Spatial relationships
  boundaryWalls: ElementInfo[];      // Walls that bound this space
  boundaryDoors: ElementInfo[];      // Doors in boundary walls
  boundaryWindows: ElementInfo[];    // Windows in boundary walls
  containedElements: ElementInfo[];  // Furniture, fixtures inside space
  adjacentSpaces: SpaceInfo[];       // Neighboring spaces

  // Geometric data
  floorPolygon: THREE.Vector2[];     // 2D boundary for floor plan
  ceilingHeight: number;
  floorLevel: number;                // Z coordinate of floor

  // Metadata
  spaceId: string;                   // GlobalId
  spaceName: string;                 // Name or LongName
  spaceType: string | null;          // ObjectType or category
  spaceFunction: string | null;      // Predefined type (OFFICE, etc.)
  storeyName: string | null;         // Building storey

  // For detailed SVG rendering
  detailedGeometry?: {
    floorMeshes: THREE.Mesh[];
    wallMeshes: THREE.Mesh[];
    doorMeshes: THREE.Mesh[];
    windowMeshes: THREE.Mesh[];
    furnitureMeshes: THREE.Mesh[];
  };
}

/**
 * Room data structure for Airtable export
 */
export interface SpaceData {
  spaceId: string;
  spaceName: string;
  spaceType?: string;
  spaceFunction?: string;
  storeyName?: string;

  // Quantities
  grossFloorArea?: number;
  netFloorArea?: number;
  grossVolume?: number;
  height?: number;
  perimeter?: number;

  // Dimensions
  width?: number;
  depth?: number;

  // Counts
  doorCount?: number;
  windowCount?: number;

  // Model source
  modelSource?: string;

  // SVG views (base64 data URLs)
  floorPlanView?: string;
  locationPlanView?: string;  // Shows space in context of storey
}

/**
 * IFC Space predefined types (from IFC4)
 */
export type IfcSpacePredefinedType =
  | 'SPACE'
  | 'PARKING'
  | 'GFA'           // Gross Floor Area
  | 'INTERNAL'
  | 'EXTERNAL'
  | 'USERDEFINED'
  | 'NOTDEFINED';

/**
 * Common space function types for classification
 */
export type SpaceFunctionType =
  | 'OFFICE'
  | 'MEETING'
  | 'CONFERENCE'
  | 'BATHROOM'
  | 'KITCHEN'
  | 'STORAGE'
  | 'CORRIDOR'
  | 'LOBBY'
  | 'STAIRWELL'
  | 'ELEVATOR'
  | 'MECHANICAL'
  | 'ELECTRICAL'
  | 'SERVER'
  | 'RECEPTION'
  | 'CAFETERIA'
  | 'LOUNGE'
  | 'OTHER';
```

### 2.2 Update Existing Types

Modify `lib/ifc-types.ts`:

```typescript
// Add space-related type checks
export function isSpaceType(typeName: string): boolean {
  const upperName = typeName.toUpperCase();
  return upperName.includes('SPACE') ||
         upperName === 'IFCSPACE' ||
         upperName === 'IFCSPATIALZONE';
}

// Update element categories
export type ElementCategory =
  | 'door'
  | 'wall'
  | 'window'
  | 'space'      // NEW
  | 'furniture'  // NEW
  | 'electrical'
  | 'structural'
  | 'other';
```

---

## 3. IFC Space Analysis

### 3.1 New File: `lib/space-analyzer.ts`

This is the core analysis module that extracts and processes IFCSPACE elements.

```typescript
/**
 * space-analyzer.ts
 *
 * Analyzes IFC files to extract space (room) information including:
 * - Space properties (area, volume, height)
 * - Boundary geometry (floor polygon)
 * - Related elements (walls, doors, windows, furniture)
 * - Spatial relationships (adjacent spaces)
 */

import * as THREE from 'three';
import { LoadedFragmentsModel, ElementInfo } from './ifc-types';
import { SpaceInfo, SpaceContext } from './ifc-space-types';
import { SpatialNode } from './spatial-structure';

// ============================================
// MAIN ANALYSIS FUNCTION
// ============================================

export async function analyzeSpaces(
  model: LoadedFragmentsModel,
  spatialStructure?: SpatialNode
): Promise<SpaceContext[]> {
  const spaces: SpaceContext[] = [];
  const elements = model.elements;

  // 1. Find all IFCSPACE elements
  const spaceElements = elements.filter(el => isSpaceType(el.typeName));

  // 2. Find walls, doors, windows for boundary analysis
  const walls = elements.filter(el => isWallType(el.typeName));
  const doors = elements.filter(el => isDoorType(el.typeName));
  const windows = elements.filter(el => isWindowType(el.typeName));
  const furniture = elements.filter(el => isFurnitureType(el.typeName));

  // 3. Analyze each space
  for (const spaceElement of spaceElements) {
    const context = await analyzeSpace(
      spaceElement,
      walls,
      doors,
      windows,
      furniture,
      spaceElements,
      spatialStructure
    );
    if (context) {
      spaces.push(context);
    }
  }

  return spaces;
}

// ============================================
// SPACE ANALYSIS FUNCTIONS
// ============================================

async function analyzeSpace(
  space: ElementInfo,
  walls: ElementInfo[],
  doors: ElementInfo[],
  windows: ElementInfo[],
  furniture: ElementInfo[],
  allSpaces: ElementInfo[],
  spatialStructure?: SpatialNode
): Promise<SpaceContext | null> {

  // Get space bounding box
  const bbox = space.boundingBox || calculateBoundingBox(space);
  if (!bbox) return null;

  const center = new THREE.Vector3();
  bbox.getCenter(center);

  // Find boundary elements
  const boundaryWalls = findBoundaryWalls(space, walls);
  const boundaryDoors = findDoorsInWalls(boundaryWalls, doors);
  const boundaryWindows = findWindowsInWalls(boundaryWalls, windows);
  const containedElements = findContainedElements(space, furniture);
  const adjacentSpaces = findAdjacentSpaces(space, allSpaces);

  // Extract floor polygon from space geometry
  const floorPolygon = extractFloorPolygon(space);

  // Get storey name from spatial structure
  const storeyName = getStoreyName(space, spatialStructure);

  // Get space properties from IFC
  const spaceInfo = space as SpaceInfo;

  return {
    space: spaceInfo,
    boundaryWalls,
    boundaryDoors,
    boundaryWindows,
    containedElements,
    adjacentSpaces: adjacentSpaces as SpaceInfo[],
    floorPolygon,
    ceilingHeight: spaceInfo.height || calculateHeight(bbox),
    floorLevel: bbox.min.z,
    spaceId: space.globalId || `space-${space.expressID}`,
    spaceName: spaceInfo.longName || space.productTypeName || `Space ${space.expressID}`,
    spaceType: spaceInfo.objectType || null,
    spaceFunction: inferSpaceFunction(spaceInfo),
    storeyName,
  };
}

// ============================================
// BOUNDARY DETECTION FUNCTIONS
// ============================================

function findBoundaryWalls(space: ElementInfo, walls: ElementInfo[]): ElementInfo[] {
  const spaceBbox = space.boundingBox;
  if (!spaceBbox) return [];

  // Expand space bbox slightly to catch walls at boundary
  const expandedBbox = spaceBbox.clone().expandByScalar(0.1);

  return walls.filter(wall => {
    const wallBbox = wall.boundingBox;
    if (!wallBbox) return false;
    return expandedBbox.intersectsBox(wallBbox);
  });
}

function findDoorsInWalls(walls: ElementInfo[], doors: ElementInfo[]): ElementInfo[] {
  return doors.filter(door => {
    const doorBbox = door.boundingBox;
    if (!doorBbox) return false;

    return walls.some(wall => {
      const wallBbox = wall.boundingBox;
      if (!wallBbox) return false;
      return doorBbox.intersectsBox(wallBbox);
    });
  });
}

function findWindowsInWalls(walls: ElementInfo[], windows: ElementInfo[]): ElementInfo[] {
  return windows.filter(window => {
    const windowBbox = window.boundingBox;
    if (!windowBbox) return false;

    return walls.some(wall => {
      const wallBbox = wall.boundingBox;
      if (!wallBbox) return false;
      return windowBbox.intersectsBox(wallBbox);
    });
  });
}

function findContainedElements(space: ElementInfo, furniture: ElementInfo[]): ElementInfo[] {
  const spaceBbox = space.boundingBox;
  if (!spaceBbox) return [];

  return furniture.filter(item => {
    const itemBbox = item.boundingBox;
    if (!itemBbox) return false;

    // Check if furniture center is inside space
    const center = new THREE.Vector3();
    itemBbox.getCenter(center);
    return spaceBbox.containsPoint(center);
  });
}

function findAdjacentSpaces(space: ElementInfo, allSpaces: ElementInfo[]): ElementInfo[] {
  const spaceBbox = space.boundingBox;
  if (!spaceBbox) return [];

  // Expand bbox to find neighbors
  const expandedBbox = spaceBbox.clone().expandByScalar(0.5);

  return allSpaces.filter(other => {
    if (other.expressID === space.expressID) return false;
    const otherBbox = other.boundingBox;
    if (!otherBbox) return false;
    return expandedBbox.intersectsBox(otherBbox);
  });
}

// ============================================
// FLOOR POLYGON EXTRACTION
// ============================================

function extractFloorPolygon(space: ElementInfo): THREE.Vector2[] {
  const polygon: THREE.Vector2[] = [];

  // Method 1: Extract from mesh geometry (bottom face)
  if (space.meshes && space.meshes.length > 0) {
    const floorPoints = extractBottomFaceVertices(space.meshes);
    if (floorPoints.length >= 3) {
      return convexHull2D(floorPoints);
    }
  }

  // Method 2: Fallback to bounding box rectangle
  const bbox = space.boundingBox;
  if (bbox) {
    return [
      new THREE.Vector2(bbox.min.x, bbox.min.y),
      new THREE.Vector2(bbox.max.x, bbox.min.y),
      new THREE.Vector2(bbox.max.x, bbox.max.y),
      new THREE.Vector2(bbox.min.x, bbox.max.y),
    ];
  }

  return polygon;
}

function extractBottomFaceVertices(meshes: THREE.Mesh[]): THREE.Vector2[] {
  const points: THREE.Vector2[] = [];
  const tolerance = 0.1; // 10cm tolerance for floor level

  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    if (!geometry) continue;

    const position = geometry.getAttribute('position');
    if (!position) continue;

    // Find minimum Z (floor level)
    let minZ = Infinity;
    for (let i = 0; i < position.count; i++) {
      const z = position.getZ(i);
      if (z < minZ) minZ = z;
    }

    // Collect vertices at floor level
    for (let i = 0; i < position.count; i++) {
      const z = position.getZ(i);
      if (Math.abs(z - minZ) < tolerance) {
        const x = position.getX(i);
        const y = position.getY(i);

        // Apply mesh world transform
        const worldPos = new THREE.Vector3(x, y, z);
        worldPos.applyMatrix4(mesh.matrixWorld);

        points.push(new THREE.Vector2(worldPos.x, worldPos.y));
      }
    }
  }

  return points;
}

// ============================================
// PROPERTY EXTRACTION
// ============================================

export async function extractSpaceProperties(
  file: File,
  api: any // web-ifc API
): Promise<Map<number, Partial<SpaceInfo>>> {
  const propertiesMap = new Map<number, Partial<SpaceInfo>>();

  // Get all IFCSPACE instances
  const spaceIds = api.GetLineIDsWithType(0, api.IFCSPACE);

  for (const spaceId of spaceIds) {
    const space = api.GetLine(0, spaceId);

    const props: Partial<SpaceInfo> = {
      expressID: spaceId,
      globalId: space.GlobalId?.value,
      longName: space.LongName?.value,
      objectType: space.ObjectType?.value,
    };

    // Get Qto_SpaceBaseQuantities
    const quantities = await getSpaceQuantities(api, spaceId);
    if (quantities) {
      props.grossFloorArea = quantities.GrossFloorArea;
      props.netFloorArea = quantities.NetFloorArea;
      props.grossVolume = quantities.GrossVolume;
      props.netVolume = quantities.NetVolume;
      props.height = quantities.Height;
      props.perimeter = quantities.GrossPerimeter;
    }

    propertiesMap.set(spaceId, props);
  }

  return propertiesMap;
}

async function getSpaceQuantities(api: any, spaceId: number): Promise<any> {
  // Find IfcRelDefinesByProperties for this space
  const relIds = api.GetLineIDsWithType(0, api.IFCRELDEFINESBYPROPERTIES);

  for (const relId of relIds) {
    const rel = api.GetLine(0, relId);

    // Check if this relation applies to our space
    const relatedObjects = rel.RelatedObjects;
    const appliesToSpace = relatedObjects.some(
      (obj: any) => obj.value === spaceId
    );

    if (!appliesToSpace) continue;

    // Get the property set
    const propSetRef = rel.RelatingPropertyDefinition;
    const propSet = api.GetLine(0, propSetRef.value);

    // Check if it's Qto_SpaceBaseQuantities
    if (propSet.Name?.value === 'Qto_SpaceBaseQuantities') {
      const quantities: any = {};

      for (const qtyRef of propSet.Quantities || []) {
        const qty = api.GetLine(0, qtyRef.value);
        const name = qty.Name?.value;
        const value = qty.AreaValue?.value ||
                      qty.VolumeValue?.value ||
                      qty.LengthValue?.value;

        if (name && value !== undefined) {
          quantities[name] = value;
        }
      }

      return quantities;
    }
  }

  return null;
}

// ============================================
// HELPER FUNCTIONS
// ============================================

function inferSpaceFunction(space: SpaceInfo): string | null {
  const name = (space.longName || space.productTypeName || '').toLowerCase();
  const type = (space.objectType || '').toLowerCase();

  const keywords = {
    'OFFICE': ['office', 'workspace', 'workstation'],
    'MEETING': ['meeting', 'conference', 'huddle'],
    'BATHROOM': ['bathroom', 'restroom', 'toilet', 'wc', 'lavatory'],
    'KITCHEN': ['kitchen', 'kitchenette', 'pantry', 'break room'],
    'STORAGE': ['storage', 'closet', 'store', 'archive'],
    'CORRIDOR': ['corridor', 'hallway', 'passage'],
    'LOBBY': ['lobby', 'foyer', 'entrance', 'reception'],
    'STAIRWELL': ['stair', 'stairwell', 'staircase'],
    'ELEVATOR': ['elevator', 'lift'],
    'MECHANICAL': ['mechanical', 'hvac', 'plant'],
    'ELECTRICAL': ['electrical', 'elec room'],
    'SERVER': ['server', 'data center', 'it room'],
  };

  for (const [func, terms] of Object.entries(keywords)) {
    if (terms.some(term => name.includes(term) || type.includes(term))) {
      return func;
    }
  }

  return null;
}

function calculateHeight(bbox: THREE.Box3): number {
  return bbox.max.z - bbox.min.z;
}

function calculateBoundingBox(element: ElementInfo): THREE.Box3 | null {
  if (element.boundingBox) return element.boundingBox;

  if (element.meshes && element.meshes.length > 0) {
    const bbox = new THREE.Box3();
    for (const mesh of element.meshes) {
      bbox.expandByObject(mesh);
    }
    return bbox;
  }

  if (element.mesh) {
    const bbox = new THREE.Box3();
    bbox.setFromObject(element.mesh);
    return bbox;
  }

  return null;
}

function getStoreyName(
  space: ElementInfo,
  spatialStructure?: SpatialNode
): string | null {
  if (!spatialStructure) return null;

  // Find storey containing this space
  function findStorey(node: SpatialNode): string | null {
    if (node.type === 'IFCBUILDINGSTOREY') {
      if (node.elementIds?.includes(space.expressID) ||
          node.allElementIds?.includes(space.expressID)) {
        return node.name;
      }
    }

    for (const child of node.children || []) {
      const result = findStorey(child);
      if (result) return result;
    }

    return null;
  }

  return findStorey(spatialStructure);
}

// Convex hull algorithm for 2D points
function convexHull2D(points: THREE.Vector2[]): THREE.Vector2[] {
  if (points.length < 3) return points;

  // Graham scan algorithm
  const sorted = [...points].sort((a, b) =>
    a.x === b.x ? a.y - b.y : a.x - b.x
  );

  const cross = (o: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower: THREE.Vector2[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper: THREE.Vector2[] = [];
  for (const p of sorted.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

// Type checking functions
function isSpaceType(typeName: string): boolean {
  const upper = typeName.toUpperCase();
  return upper.includes('SPACE') || upper === 'IFCSPACE';
}

function isWallType(typeName: string): boolean {
  const upper = typeName.toUpperCase();
  return upper.includes('WALL') || upper === 'IFCWALL' || upper === 'IFCWALLSTANDARDCASE';
}

function isDoorType(typeName: string): boolean {
  const upper = typeName.toUpperCase();
  return upper.includes('DOOR') || upper === 'IFCDOOR';
}

function isWindowType(typeName: string): boolean {
  const upper = typeName.toUpperCase();
  return upper.includes('WINDOW') || upper === 'IFCWINDOW';
}

function isFurnitureType(typeName: string): boolean {
  const upper = typeName.toUpperCase();
  return upper.includes('FURNISHING') ||
         upper === 'IFCFURNISHINGELEMENT' ||
         upper.includes('FURNITURE');
}
```

### 3.2 Key Analysis Functions

| Function | Purpose |
|----------|---------|
| `analyzeSpaces()` | Main entry point - analyzes all spaces in model |
| `findBoundaryWalls()` | Find walls that form the room boundary |
| `findDoorsInWalls()` | Find doors in the boundary walls |
| `extractFloorPolygon()` | Extract 2D floor boundary from geometry |
| `extractSpaceProperties()` | Get IFC properties (area, volume, etc.) |
| `inferSpaceFunction()` | Guess room function from name/type |

---

## 4. SVG Floor Plan Renderer

### 4.1 Modify `lib/svg-renderer.ts`

Add new functions for space rendering:

```typescript
/**
 * Render options for space floor plan SVG
 */
export interface SpaceSVGRenderOptions extends SVGRenderOptions {
  showArea?: boolean;           // Display area measurement
  showDimensions?: boolean;     // Show width/depth dimensions
  showDoors?: boolean;          // Show door swings
  showWindows?: boolean;        // Show windows
  showFurniture?: boolean;      // Show furniture outlines
  showRoomLabel?: boolean;      // Show room name
  showGrid?: boolean;           // Show grid lines
  gridSize?: number;            // Grid cell size in meters
  scale?: number;               // Drawing scale (e.g., 1:100)

  // Colors
  floorColor?: string;          // '#ffffff'
  wallColor?: string;           // '#333333'
  wallFillColor?: string;       // '#666666'
  doorColor?: string;           // '#0066cc'
  windowColor?: string;         // '#66ccff'
  furnitureColor?: string;      // '#999999'
  dimensionColor?: string;      // '#666666'
  labelColor?: string;          // '#000000'
}

/**
 * Render a floor plan SVG for a single space
 */
export function renderSpaceFloorPlan(
  context: SpaceContext,
  options: SpaceSVGRenderOptions = {}
): string {
  const {
    width = 800,
    height = 600,
    margin = 1.0,  // 1m margin
    showArea = true,
    showDimensions = true,
    showDoors = true,
    showWindows = true,
    showFurniture = false,
    showRoomLabel = true,
    showGrid = false,
    floorColor = '#ffffff',
    wallColor = '#333333',
    wallFillColor = '#666666',
    doorColor = '#0066cc',
    windowColor = '#66ccff',
    furnitureColor = '#999999',
    dimensionColor = '#666666',
    labelColor = '#000000',
    lineWidth = 2,
  } = options;

  // Calculate bounds from floor polygon
  const polygon = context.floorPolygon;
  if (!polygon || polygon.length < 3) {
    return createErrorSVG(width, height, 'No floor geometry');
  }

  // Calculate bounding box of polygon
  const bounds = calculatePolygonBounds(polygon);

  // Calculate scale to fit in viewport
  const worldWidth = bounds.width + margin * 2;
  const worldHeight = bounds.height + margin * 2;
  const scaleX = width / worldWidth;
  const scaleY = height / worldHeight;
  const scale = Math.min(scaleX, scaleY);

  // Transform function: world coords to SVG coords
  const toSVG = (p: THREE.Vector2): { x: number, y: number } => ({
    x: (p.x - bounds.minX + margin) * scale,
    y: height - (p.y - bounds.minY + margin) * scale, // Flip Y
  });

  // Start building SVG
  let svg = `<svg xmlns="http://www.w3.org/2000/svg"
    width="${width}" height="${height}"
    viewBox="0 0 ${width} ${height}">
    <defs>
      <pattern id="grid" width="${scale}" height="${scale}" patternUnits="userSpaceOnUse">
        <path d="M ${scale} 0 L 0 0 0 ${scale}" fill="none" stroke="#eee" stroke-width="0.5"/>
      </pattern>
    </defs>
    <rect width="100%" height="100%" fill="#f5f5f5"/>`;

  // Optional grid
  if (showGrid) {
    svg += `<rect width="100%" height="100%" fill="url(#grid)"/>`;
  }

  // Draw floor polygon (room fill)
  const floorPath = polygon.map((p, i) => {
    const svgP = toSVG(p);
    return i === 0 ? `M ${svgP.x} ${svgP.y}` : `L ${svgP.x} ${svgP.y}`;
  }).join(' ') + ' Z';

  svg += `<path d="${floorPath}" fill="${floorColor}" stroke="none"/>`;

  // Draw walls (thick lines around boundary)
  svg += `<path d="${floorPath}" fill="none" stroke="${wallColor}"
    stroke-width="${lineWidth * 2}" stroke-linejoin="miter"/>`;

  // Draw doors
  if (showDoors && context.boundaryDoors) {
    for (const door of context.boundaryDoors) {
      svg += renderDoorSymbol(door, toSVG, scale, doorColor);
    }
  }

  // Draw windows
  if (showWindows && context.boundaryWindows) {
    for (const window of context.boundaryWindows) {
      svg += renderWindowSymbol(window, toSVG, scale, windowColor);
    }
  }

  // Draw furniture outlines
  if (showFurniture && context.containedElements) {
    for (const item of context.containedElements) {
      svg += renderFurnitureOutline(item, toSVG, scale, furnitureColor);
    }
  }

  // Add room label
  if (showRoomLabel) {
    const center = toSVG(new THREE.Vector2(
      (bounds.minX + bounds.maxX) / 2,
      (bounds.minY + bounds.maxY) / 2
    ));
    svg += `<text x="${center.x}" y="${center.y}"
      text-anchor="middle" dominant-baseline="middle"
      font-family="Arial, sans-serif" font-size="16" font-weight="bold"
      fill="${labelColor}">${escapeXml(context.spaceName)}</text>`;
  }

  // Add area label
  if (showArea && context.space.grossFloorArea) {
    const center = toSVG(new THREE.Vector2(
      (bounds.minX + bounds.maxX) / 2,
      (bounds.minY + bounds.maxY) / 2
    ));
    const area = context.space.grossFloorArea.toFixed(1);
    svg += `<text x="${center.x}" y="${center.y + 20}"
      text-anchor="middle" dominant-baseline="middle"
      font-family="Arial, sans-serif" font-size="14"
      fill="${dimensionColor}">${area} m²</text>`;
  }

  // Add dimensions
  if (showDimensions) {
    svg += renderDimensions(bounds, toSVG, scale, dimensionColor, margin);
  }

  svg += '</svg>';
  return svg;
}

/**
 * Render a location plan showing space in context of storey
 */
export function renderSpaceLocationPlan(
  context: SpaceContext,
  allSpaces: SpaceContext[],
  options: SpaceSVGRenderOptions = {}
): string {
  // Similar to floor plan but shows all spaces on storey
  // with the current space highlighted
  // ... implementation
}

// Helper functions for rendering architectural symbols

function renderDoorSymbol(
  door: ElementInfo,
  toSVG: Function,
  scale: number,
  color: string
): string {
  // Render door opening with swing arc
  // ... implementation based on door bounding box
}

function renderWindowSymbol(
  window: ElementInfo,
  toSVG: Function,
  scale: number,
  color: string
): string {
  // Render window as parallel lines in wall
  // ... implementation
}

function renderFurnitureOutline(
  item: ElementInfo,
  toSVG: Function,
  scale: number,
  color: string
): string {
  // Render furniture as simple rectangle
  const bbox = item.boundingBox;
  if (!bbox) return '';

  const min = toSVG(new THREE.Vector2(bbox.min.x, bbox.min.y));
  const max = toSVG(new THREE.Vector2(bbox.max.x, bbox.max.y));

  return `<rect x="${min.x}" y="${max.y}"
    width="${max.x - min.x}" height="${min.y - max.y}"
    fill="${color}" fill-opacity="0.3" stroke="${color}" stroke-width="1"/>`;
}

function renderDimensions(
  bounds: any,
  toSVG: Function,
  scale: number,
  color: string,
  margin: number
): string {
  // Render dimension lines with measurements
  // ... implementation
}

function calculatePolygonBounds(polygon: THREE.Vector2[]) {
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;

  for (const p of polygon) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }

  return {
    minX, maxX, minY, maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function escapeXml(str: string): string {
  return str.replace(/[<>&'"]/g, c => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;',
    "'": '&apos;', '"': '&quot;'
  }[c] || c));
}

function createErrorSVG(width: number, height: number, message: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#fee"/>
    <text x="50%" y="50%" text-anchor="middle" fill="#c00">${message}</text>
  </svg>`;
}
```

### 4.2 View Types Comparison

| Door Views (Current) | Space Views (New) |
|---------------------|-------------------|
| Front Elevation | N/A |
| Back Elevation | N/A |
| Plan View (door only) | Floor Plan View (full room) |
| N/A | Location Plan (room in storey context) |

---

## 5. API & Airtable Schema Changes

### 5.1 Modify `app/api/airtable/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { put } from '@vercel/blob';

// Updated interface for space data
interface SpaceData {
  spaceId: string;
  spaceName?: string;
  spaceType?: string;
  spaceFunction?: string;
  storeyName?: string;
  grossFloorArea?: number;
  netFloorArea?: number;
  grossVolume?: number;
  height?: number;
  perimeter?: number;
  width?: number;
  depth?: number;
  doorCount?: number;
  windowCount?: number;
  modelSource?: string;
  floorPlanView?: string;      // base64 SVG
  locationPlanView?: string;   // base64 SVG
}

export async function POST(request: NextRequest) {
  try {
    const spaceData: SpaceData = await request.json();

    // Validate required fields
    if (!spaceData.spaceId) {
      return NextResponse.json(
        { success: false, message: 'Space ID is required' },
        { status: 400 }
      );
    }

    const token = process.env.AIRTABLE_TOKEN;
    const baseId = process.env.AIRTABLE_BASE_ID;
    const tableName = process.env.AIRTABLE_TABLE_NAME || 'Spaces';

    if (!token || !baseId) {
      return NextResponse.json(
        { success: false, message: 'Airtable not configured' },
        { status: 500 }
      );
    }

    // Find existing record by Space ID
    const searchUrl = `https://api.airtable.com/v0/${baseId}/${tableName}?filterByFormula={Space ID}="${spaceData.spaceId}"`;
    const searchResponse = await fetch(searchUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const searchData = await searchResponse.json();

    let recordId = searchData.records?.[0]?.id;
    const isNew = !recordId;

    // Create new record if not exists
    if (isNew) {
      const createResponse = await fetch(
        `https://api.airtable.com/v0/${baseId}/${tableName}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            fields: {
              'Space ID': spaceData.spaceId,
              'Space Name': spaceData.spaceName,
              'Created At': new Date().toISOString(),
            },
          }),
        }
      );
      const createData = await createResponse.json();
      recordId = createData.id;
    }

    // Upload SVG images to blob storage
    const uploads: Record<string, string> = {};

    if (spaceData.floorPlanView) {
      const blob = await uploadSVG(
        spaceData.floorPlanView,
        `spaces/${spaceData.spaceId}/floor-plan-${Date.now()}.svg`
      );
      uploads['Floor Plan View'] = blob.url;
    }

    if (spaceData.locationPlanView) {
      const blob = await uploadSVG(
        spaceData.locationPlanView,
        `spaces/${spaceData.spaceId}/location-plan-${Date.now()}.svg`
      );
      uploads['Location Plan View'] = blob.url;
    }

    // Update record with all fields
    const updateFields: Record<string, any> = {
      'Space Name': spaceData.spaceName,
      'Space Type': spaceData.spaceType,
      'Space Function': spaceData.spaceFunction,
      'Storey': spaceData.storeyName,
      'Gross Floor Area (m²)': spaceData.grossFloorArea,
      'Net Floor Area (m²)': spaceData.netFloorArea,
      'Gross Volume (m³)': spaceData.grossVolume,
      'Height (m)': spaceData.height,
      'Perimeter (m)': spaceData.perimeter,
      'Width (m)': spaceData.width,
      'Depth (m)': spaceData.depth,
      'Door Count': spaceData.doorCount,
      'Window Count': spaceData.windowCount,
      'Model Source': spaceData.modelSource,
    };

    // Add image attachments
    for (const [field, url] of Object.entries(uploads)) {
      updateFields[field] = [{ url }];
    }

    // Remove undefined fields
    for (const key of Object.keys(updateFields)) {
      if (updateFields[key] === undefined) {
        delete updateFields[key];
      }
    }

    await fetch(
      `https://api.airtable.com/v0/${baseId}/${tableName}/${recordId}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fields: updateFields }),
      }
    );

    return NextResponse.json({
      success: true,
      recordId,
      created: isNew,
      message: isNew ? 'Space created' : 'Space updated',
    });

  } catch (error) {
    console.error('Airtable API error:', error);
    return NextResponse.json(
      { success: false, message: String(error) },
      { status: 500 }
    );
  }
}

async function uploadSVG(base64Data: string, path: string) {
  // Remove data URL prefix if present
  const base64 = base64Data.replace(/^data:image\/svg\+xml;base64,/, '');
  const buffer = Buffer.from(base64, 'base64');

  return await put(path, buffer, {
    access: 'public',
    contentType: 'image/svg+xml',
  });
}
```

### 5.2 Airtable Table Schema

**Table Name:** `Spaces` (or `Rooms`)

| Field Name | Field Type | Description |
|------------|------------|-------------|
| Space ID | Single line text (Primary) | IFC GlobalId |
| Space Name | Single line text | Room name / LongName |
| Space Type | Single select | Office, Meeting, etc. |
| Space Function | Single select | OFFICE, MEETING, BATHROOM, etc. |
| Storey | Single line text | Building storey name |
| Gross Floor Area (m²) | Number (decimal) | Total floor area |
| Net Floor Area (m²) | Number (decimal) | Usable floor area |
| Gross Volume (m³) | Number (decimal) | Total volume |
| Height (m) | Number (decimal) | Ceiling height |
| Perimeter (m) | Number (decimal) | Room perimeter |
| Width (m) | Number (decimal) | Bounding box width |
| Depth (m) | Number (decimal) | Bounding box depth |
| Door Count | Number (integer) | Number of doors |
| Window Count | Number (integer) | Number of windows |
| Model Source | Single line text | IFC filename |
| Floor Plan View | Attachment | SVG floor plan |
| Location Plan View | Attachment | SVG location plan |
| Created At | Date | Record creation date |
| Notes | Long text | Additional notes |

### 5.3 Setup Script Update

Modify `scripts/setup-airtable.js` to create Spaces table:

```javascript
// Default table name changed
const DEFAULT_TABLE_NAME = 'Spaces';

// Updated field definitions for spaces
const SPACE_FIELDS = [
  { name: 'Space ID', type: 'singleLineText' },
  { name: 'Space Name', type: 'singleLineText' },
  { name: 'Space Type', type: 'singleSelect', options: {
    choices: [
      { name: 'Office' },
      { name: 'Meeting Room' },
      { name: 'Conference Room' },
      { name: 'Bathroom' },
      { name: 'Kitchen' },
      { name: 'Storage' },
      { name: 'Corridor' },
      { name: 'Lobby' },
      { name: 'Other' },
    ]
  }},
  // ... rest of fields
];
```

---

## 6. UI Component Changes

### 6.1 Rename/Modify Components

| Current File | New File | Changes |
|--------------|----------|---------|
| `DoorPanel.tsx` | `SpacePanel.tsx` | Complete refactor for spaces |
| `BatchProcessor.tsx` | `BatchProcessor.tsx` | Update for space data |
| `IFCViewer.tsx` | `IFCViewer.tsx` | Update imports and state |

### 6.2 New SpacePanel Component

```typescript
// components/SpacePanel.tsx

'use client';

import React, { useState, useMemo, useCallback } from 'react';
import { SpaceContext, SpaceData } from '../lib/ifc-space-types';
import { renderSpaceFloorPlan } from '../lib/svg-renderer';

interface SpacePanelProps {
  spaceContexts: SpaceContext[];
  onSelectSpace: (spaceId: string) => void;
  onHoverSpace: (spaceId: string | null) => void;
  selectedSpaceIds: Set<string>;
  highlightedSpaceId: string | null;
  onIsolateSpace: (spaceId: string) => void;
  onRenderSVG: (context: SpaceContext) => Promise<string>;
  onUploadToAirtable: (spaces: SpaceContext[]) => Promise<void>;
}

export default function SpacePanel({
  spaceContexts,
  onSelectSpace,
  onHoverSpace,
  selectedSpaceIds,
  highlightedSpaceId,
  onIsolateSpace,
  onRenderSVG,
  onUploadToAirtable,
}: SpacePanelProps) {

  // Filter state
  const [storeyFilter, setStoreyFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'area' | 'storey'>('name');

  // Get unique storeys and types for filters
  const storeys = useMemo(() => {
    const set = new Set<string>();
    spaceContexts.forEach(ctx => {
      if (ctx.storeyName) set.add(ctx.storeyName);
    });
    return Array.from(set).sort();
  }, [spaceContexts]);

  const spaceTypes = useMemo(() => {
    const set = new Set<string>();
    spaceContexts.forEach(ctx => {
      if (ctx.spaceType) set.add(ctx.spaceType);
    });
    return Array.from(set).sort();
  }, [spaceContexts]);

  // Filter and sort spaces
  const filteredSpaces = useMemo(() => {
    return spaceContexts
      .filter(ctx => {
        if (storeyFilter !== 'all' && ctx.storeyName !== storeyFilter) return false;
        if (typeFilter !== 'all' && ctx.spaceType !== typeFilter) return false;
        if (searchQuery) {
          const query = searchQuery.toLowerCase();
          return ctx.spaceName.toLowerCase().includes(query) ||
                 ctx.spaceId.toLowerCase().includes(query);
        }
        return true;
      })
      .sort((a, b) => {
        switch (sortBy) {
          case 'area':
            return (b.space.grossFloorArea || 0) - (a.space.grossFloorArea || 0);
          case 'storey':
            return (a.storeyName || '').localeCompare(b.storeyName || '');
          default:
            return a.spaceName.localeCompare(b.spaceName);
        }
      });
  }, [spaceContexts, storeyFilter, typeFilter, searchQuery, sortBy]);

  // Selection handlers
  const handleSelectAll = useCallback(() => {
    filteredSpaces.forEach(ctx => onSelectSpace(ctx.spaceId));
  }, [filteredSpaces, onSelectSpace]);

  const handleClearSelection = useCallback(() => {
    selectedSpaceIds.forEach(id => onSelectSpace(id));
  }, [selectedSpaceIds, onSelectSpace]);

  // Upload handler
  const handleUpload = useCallback(async () => {
    const selected = spaceContexts.filter(ctx =>
      selectedSpaceIds.has(ctx.spaceId)
    );
    await onUploadToAirtable(selected);
  }, [spaceContexts, selectedSpaceIds, onUploadToAirtable]);

  return (
    <div className="space-panel">
      {/* Header with counts */}
      <div className="panel-header">
        <h2>Spaces ({filteredSpaces.length})</h2>
        <span className="selected-count">
          {selectedSpaceIds.size} selected
        </span>
      </div>

      {/* Filters */}
      <div className="filters">
        <input
          type="text"
          placeholder="Search spaces..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
        />

        <select value={storeyFilter} onChange={e => setStoreyFilter(e.target.value)}>
          <option value="all">All Storeys</option>
          {storeys.map(s => <option key={s} value={s}>{s}</option>)}
        </select>

        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
          <option value="all">All Types</option>
          {spaceTypes.map(t => <option key={t} value={t}>{t}</option>)}
        </select>

        <select value={sortBy} onChange={e => setSortBy(e.target.value as any)}>
          <option value="name">Sort by Name</option>
          <option value="area">Sort by Area</option>
          <option value="storey">Sort by Storey</option>
        </select>
      </div>

      {/* Bulk actions */}
      <div className="bulk-actions">
        <button onClick={handleSelectAll}>Select All</button>
        <button onClick={handleClearSelection}>Clear</button>
        <button
          onClick={handleUpload}
          disabled={selectedSpaceIds.size === 0}
        >
          Upload to Airtable ({selectedSpaceIds.size})
        </button>
      </div>

      {/* Space list */}
      <div className="space-list">
        {filteredSpaces.map(ctx => (
          <SpaceListItem
            key={ctx.spaceId}
            context={ctx}
            isSelected={selectedSpaceIds.has(ctx.spaceId)}
            isHighlighted={highlightedSpaceId === ctx.spaceId}
            onSelect={() => onSelectSpace(ctx.spaceId)}
            onHover={hover => onHoverSpace(hover ? ctx.spaceId : null)}
            onIsolate={() => onIsolateSpace(ctx.spaceId)}
          />
        ))}
      </div>
    </div>
  );
}

// Individual space list item
function SpaceListItem({
  context,
  isSelected,
  isHighlighted,
  onSelect,
  onHover,
  onIsolate,
}: {
  context: SpaceContext;
  isSelected: boolean;
  isHighlighted: boolean;
  onSelect: () => void;
  onHover: (hover: boolean) => void;
  onIsolate: () => void;
}) {
  return (
    <div
      className={`space-item ${isSelected ? 'selected' : ''} ${isHighlighted ? 'highlighted' : ''}`}
      onClick={onSelect}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
    >
      <div className="space-info">
        <div className="space-name">{context.spaceName}</div>
        <div className="space-details">
          {context.storeyName && <span className="storey">{context.storeyName}</span>}
          {context.spaceType && <span className="type">{context.spaceType}</span>}
        </div>
        <div className="space-metrics">
          {context.space.grossFloorArea && (
            <span className="area">{context.space.grossFloorArea.toFixed(1)} m²</span>
          )}
          {context.boundaryDoors.length > 0 && (
            <span className="doors">{context.boundaryDoors.length} doors</span>
          )}
          {context.boundaryWindows.length > 0 && (
            <span className="windows">{context.boundaryWindows.length} windows</span>
          )}
        </div>
      </div>
      <div className="space-actions">
        <button onClick={e => { e.stopPropagation(); onIsolate(); }}>
          Isolate
        </button>
      </div>
    </div>
  );
}
```

### 6.3 Update IFCViewer.tsx

Key changes needed:

```typescript
// Replace door-related imports
import { analyzeSpaces } from '../lib/space-analyzer';
import { SpaceContext } from '../lib/ifc-space-types';
import { renderSpaceFloorPlan } from '../lib/svg-renderer';
import SpacePanel from './SpacePanel';

// Replace door state with space state
const [spaceContexts, setSpaceContexts] = useState<SpaceContext[]>([]);
const [selectedSpaceIds, setSelectedSpaceIds] = useState<Set<string>>(new Set());
const [highlightedSpaceId, setHighlightedSpaceId] = useState<string | null>(null);

// Update analysis after model load
useEffect(() => {
  if (loadedModel && spatialStructure) {
    analyzeSpaces(loadedModel, spatialStructure)
      .then(setSpaceContexts);
  }
}, [loadedModel, spatialStructure]);

// Update render function
const handleRenderSVG = async (context: SpaceContext) => {
  return renderSpaceFloorPlan(context, {
    showArea: true,
    showDimensions: true,
    showDoors: true,
    showWindows: true,
  });
};
```

---

## 7. File Changes Summary

### 7.1 New Files to Create

| File | Purpose |
|------|---------|
| `lib/ifc-space-types.ts` | TypeScript interfaces for spaces |
| `lib/space-analyzer.ts` | Space analysis and extraction |
| `components/SpacePanel.tsx` | Space management UI |
| `SPACES_MIGRATION_PLAN.md` | This document |

### 7.2 Files to Modify

| File | Changes |
|------|---------|
| `lib/svg-renderer.ts` | Add `renderSpaceFloorPlan()` and related functions |
| `lib/ifc-types.ts` | Add `isSpaceType()` helper |
| `app/api/airtable/route.ts` | Update for SpaceData interface |
| `components/IFCViewer.tsx` | Replace door state with space state |
| `components/BatchProcessor.tsx` | Update for space batch processing |
| `scripts/setup-airtable.js` | Update for Spaces table schema |

### 7.3 Files to Remove/Deprecate

| File | Action |
|------|--------|
| `lib/door-analyzer.ts` | Keep for reference, deprecate |
| `components/DoorPanel.tsx` | Replace with SpacePanel |

---

## 8. Implementation Phases

### Phase 1: Data Layer (Est. effort: Medium)
1. Create `lib/ifc-space-types.ts` with all interfaces
2. Create `lib/space-analyzer.ts` with core analysis functions
3. Add space type detection to `lib/ifc-types.ts`
4. Test space extraction with sample IFC files

### Phase 2: SVG Rendering (Est. effort: Medium-High)
1. Add `renderSpaceFloorPlan()` to `lib/svg-renderer.ts`
2. Implement floor polygon rendering
3. Add door/window symbols
4. Add dimensions and labels
5. Test with various room shapes

### Phase 3: API & Database (Est. effort: Low-Medium)
1. Update `app/api/airtable/route.ts` for SpaceData
2. Update `scripts/setup-airtable.js` for Spaces table
3. Test Airtable integration

### Phase 4: UI Components (Est. effort: Medium)
1. Create `components/SpacePanel.tsx`
2. Update `components/IFCViewer.tsx`
3. Update `components/BatchProcessor.tsx`
4. Add space-specific styling

### Phase 5: Testing & Polish (Est. effort: Medium)
1. Test with real IFC files
2. Handle edge cases (irregular rooms, missing data)
3. Performance optimization
4. Documentation updates

---

## 9. Technical Considerations

### 9.1 IFC Space Geometry Challenges

**Challenge:** IFC spaces can have complex geometry (curved walls, irregular shapes).

**Solution:**
- Use convex hull for simple cases
- Implement proper polygon triangulation for complex shapes
- Fall back to bounding box rectangle if geometry extraction fails

### 9.2 Floor Polygon Extraction

**Approaches:**
1. **Bottom face extraction:** Find mesh vertices at minimum Z level
2. **Space boundary:** Use IfcRelSpaceBoundary relationships
3. **Section plane:** Create horizontal section through space
4. **Bounding box:** Simple rectangular approximation

**Recommended:** Start with bounding box, then implement bottom face extraction.

### 9.3 Handling Missing Properties

IFC files vary in quality. Handle missing data gracefully:

```typescript
// Calculate area from geometry if IFC property missing
if (!space.grossFloorArea && space.boundingBox) {
  const size = new THREE.Vector3();
  space.boundingBox.getSize(size);
  space.grossFloorArea = size.x * size.y; // Approximation
}
```

### 9.4 Performance Considerations

- **Large models:** May have 100+ spaces - use virtualized list
- **SVG generation:** Generate on-demand, not all at once
- **Batch upload:** Limit concurrent uploads (3-5 at a time)

### 9.5 Edge Cases

1. **Spaces without geometry:** Some IFC files have spaces as bounding boxes only
2. **Nested spaces:** Spaces within spaces (e.g., office within open plan)
3. **External spaces:** Balconies, terraces marked as spaces
4. **Multi-level spaces:** Atriums spanning multiple storeys

---

## 10. Success Criteria

- [ ] Successfully extract IFCSPACE elements from IFC files
- [ ] Retrieve space properties (area, volume, height) from IFC
- [ ] Generate accurate floor plan SVGs with dimensions
- [ ] Display spaces in UI with filtering and selection
- [ ] Export space data + floor plans to Airtable
- [ ] Handle edge cases gracefully (missing data, complex geometry)
- [ ] Maintain performance with large models (100+ spaces)

---

## Appendix: IFC Space Property Mapping

### Qto_SpaceBaseQuantities (IFC Standard)

| IFC Quantity | Our Property | Unit |
|--------------|--------------|------|
| GrossFloorArea | grossFloorArea | m² |
| NetFloorArea | netFloorArea | m² |
| GrossVolume | grossVolume | m³ |
| NetVolume | netVolume | m³ |
| Height | height | m |
| GrossPerimeter | perimeter | m |
| NetPerimeter | - | m |
| GrossWallArea | - | m² |
| NetWallArea | - | m² |
| GrossCeilingArea | - | m² |
| NetCeilingArea | - | m² |

### IfcSpace Attributes

| IFC Attribute | Our Property |
|---------------|--------------|
| GlobalId | spaceId |
| Name | spaceName |
| LongName | spaceName (fallback) |
| ObjectType | spaceType |
| PredefinedType | spaceFunction |

---

*Document created: 2026-02-02*
*Last updated: 2026-02-02*
