import * as THREE from 'three'
import type { ElementInfo } from './ifc-types'

/**
 * Extended ElementInfo for IFC Space (room) with additional properties
 */
export interface SpaceInfo extends ElementInfo {
    // IFC Properties
    longName?: string           // Full descriptive name
    objectType?: string         // Space type classification
    description?: string        // Additional description

    // Qto_SpaceBaseQuantities (IFC standard quantities)
    grossFloorArea?: number     // m² - Total floor area
    netFloorArea?: number       // m² - Usable floor area
    grossVolume?: number        // m³ - Total volume
    netVolume?: number          // m³ - Usable volume
    height?: number             // m - Room height
    perimeter?: number          // m - Room perimeter

    // Calculated/Derived
    centerPoint?: THREE.Vector3 // Center of space
    boundaryPoints?: THREE.Vector2[] // 2D floor boundary polygon
    boundingBox2D?: {           // 2D bounding rectangle
        min: THREE.Vector2
        max: THREE.Vector2
        width: number
        depth: number
    }
}

/**
 * Context for a space including relationships and geometry
 */
export interface SpaceContext {
    space: SpaceInfo

    // Spatial relationships
    boundaryWalls: ElementInfo[]      // Walls that bound this space
    boundaryDoors: ElementInfo[]      // Doors in boundary walls
    boundaryWindows: ElementInfo[]    // Windows in boundary walls
    containedElements: ElementInfo[]  // Furniture, fixtures inside space

    // Geometric data
    floorPolygon: THREE.Vector2[]     // 2D boundary for floor plan
    ceilingHeight: number
    floorLevel: number                // Z coordinate of floor

    // Metadata
    spaceId: string                   // GlobalId
    spaceName: string                 // Name or LongName
    spaceType: string | null          // ObjectType or category
    spaceFunction: string | null      // Inferred function (OFFICE, etc.)
    storeyName: string | null         // Building storey

    // For detailed SVG rendering
    detailedGeometry?: {
        floorMeshes: THREE.Mesh[]
        wallMeshes: THREE.Mesh[]
        doorMeshes: THREE.Mesh[]
        windowMeshes: THREE.Mesh[]
        furnitureMeshes: THREE.Mesh[]
    }
}

/**
 * Room data structure for Airtable export
 */
export interface SpaceData {
    spaceId: string
    spaceName?: string
    spaceType?: string
    spaceFunction?: string
    storeyName?: string

    // Quantities
    grossFloorArea?: number
    netFloorArea?: number
    grossVolume?: number
    height?: number
    perimeter?: number

    // Dimensions from bounding box
    width?: number
    depth?: number

    // Counts
    doorCount?: number
    windowCount?: number

    // Model source
    modelSource?: string

    // SVG views (base64 data URLs)
    floorPlanView?: string
}

/**
 * Filter options for space filtering
 */
export interface SpaceFilterOptions {
    /** Filter by space type names (comma-separated or array) */
    spaceTypes?: string | string[]
    /** Filter by building storey names (comma-separated or array) */
    storeys?: string | string[]
    /** Filter by specific space GUIDs (comma-separated or array) */
    guids?: string | string[]
    /** Filter by space function */
    functions?: string | string[]
}

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
    | 'BEDROOM'
    | 'LIVING'
    | 'DINING'
    | 'GARAGE'
    | 'BALCONY'
    | 'TERRACE'
    | 'OTHER'

/**
 * SVG render options for space floor plan
 */
export interface SpaceSVGRenderOptions {
    width?: number
    height?: number
    margin?: number              // meters

    // Display options
    showArea?: boolean           // Display area measurement
    showDimensions?: boolean     // Show width/depth dimensions
    showDoors?: boolean          // Show door symbols
    showWindows?: boolean        // Show window symbols
    showRoomLabel?: boolean      // Show room name
    showGrid?: boolean           // Show grid lines
    gridSize?: number            // Grid cell size in meters

    // Colors
    backgroundColor?: string     // '#f5f5f5'
    floorColor?: string          // '#ffffff'
    wallColor?: string           // '#333333'
    wallFillColor?: string       // '#666666'
    doorColor?: string           // '#0066cc'
    windowColor?: string         // '#66ccff'
    dimensionColor?: string      // '#666666'
    labelColor?: string          // '#000000'

    // Line settings
    lineWidth?: number
    lineColor?: string
    fontSize?: number
    fontFamily?: string
}
