# Door Filtering Features

This document describes the door filtering features that allow selective processing of doors from IFC files.

## Overview

The door filtering system allows you to process specific doors based on:
- **Door Type** (using ifcRelDefinesByType)
- **Building Storey** (using ifcRelContainedInSpatialStructure)
- **Specific GUIDs** (comma-separated list)

This is useful for:
- Performance optimization (processing only necessary doors)
- Incremental updates (regenerating specific doors without re-rendering everything)
- Storey-specific exports (e.g., generating views for one floor at a time)

## Usage

### 1. Door Analysis Script

Use the `analyze-doors-filtered.js` script to inspect and filter doors:

```bash
# List all doors and their properties
node scripts/analyze-doors-filtered.js path/to/model.ifc

# List all door types and storeys in the model
node scripts/analyze-doors-filtered.js path/to/model.ifc --list-types --list-storeys

# Filter by door type
node scripts/analyze-doors-filtered.js path/to/model.ifc --door-types "T30,T60"

# Filter by building storey
node scripts/analyze-doors-filtered.js path/to/model.ifc --storeys "EG,OG1,OG2"

# Filter by specific GUIDs
node scripts/analyze-doors-filtered.js path/to/model.ifc --guids "2O2Fr$t4X7Zf8NOew3FLOH,1S8LodzGX8dRt2NjBjEZHe"

# Combine filters (AND logic)
node scripts/analyze-doors-filtered.js path/to/model.ifc --door-types "T30" --storeys "EG"
```

### 2. Airtable Import Script

Use the `import-doors-to-airtable.js` script with filtering:

```bash
# Import all doors
node scripts/import-doors-to-airtable.js path/to/model.ifc

# Import only specific door types
node scripts/import-doors-to-airtable.js path/to/model.ifc --door-types "T30,T60"

# Import doors from specific storeys
node scripts/import-doors-to-airtable.js path/to/model.ifc --storeys "EG,OG1"

# Import specific doors by GUID
node scripts/import-doors-to-airtable.js path/to/model.ifc --guids "2O2Fr$t4X7Zf8NOew3FLOH"
```

### 3. Programmatic Usage

Use the filtering utilities in your code:

```typescript
import { analyzeDoors, filterDoors, type DoorFilterOptions } from './lib/door-analyzer'

// Analyze all doors
const allDoors = analyzeDoors(model)

// Define filters
const filters: DoorFilterOptions = {
  doorTypes: 'T30,T60',           // Filter by type names (comma-separated)
  storeys: 'EG,OG1',              // Filter by storey names (comma-separated)
  guids: '2O2Fr$t4X7Zf8NOew3FLOH' // Filter by GUIDs (comma-separated)
}

// Apply filters
const filteredDoors = filterDoors(allDoors, filters)

// Or use arrays instead of comma-separated strings
const filters2: DoorFilterOptions = {
  doorTypes: ['T30', 'T60'],
  storeys: ['EG', 'OG1'],
  guids: ['2O2Fr$t4X7Zf8NOew3FLOH', '1S8LodzGX8dRt2NjBjEZHe']
}
```

## Filter Behavior

### Door Type Filter
- **Case-insensitive partial match**
- Matches if the door type name contains any of the specified types
- Example: `--door-types "T30"` matches "T30-1", "T30-2", "Brand-T30", etc.

### Storey Filter
- **Case-insensitive partial match**
- Matches if the storey name contains any of the specified storeys
- Example: `--storeys "EG"` matches "EG", "Erdgeschoss", "EG-Main", etc.

### GUID Filter
- **Exact match**
- Matches only exact GUIDs
- GUIDs are the IFC GlobalId values (e.g., "2O2Fr$t4X7Zf8NOew3FLOH")

### Multiple Filters
When multiple filter types are specified, they use **AND logic**:
- The door must match ALL filter criteria to be included
- Example: `--door-types "T30" --storeys "EG"` returns only T30 doors on the EG storey

Within a single filter type, values use **OR logic**:
- The door must match ANY of the specified values
- Example: `--door-types "T30,T60"` returns doors that are either T30 OR T60

## Data Structure

### DoorContext Interface

The `DoorContext` interface has been extended to include storey information:

```typescript
export interface DoorContext {
    door: ElementInfo
    wall: ElementInfo | null
    hostWall: ElementInfo | null
    nearbyDevices: ElementInfo[]
    normal: THREE.Vector3
    center: THREE.Vector3
    doorId: string
    openingDirection: string | null
    doorTypeName: string | null
    storeyName: string | null  // NEW: Building storey name
}
```

### DoorFilterOptions Interface

```typescript
export interface DoorFilterOptions {
    /** Filter by door type names (comma-separated or array) */
    doorTypes?: string | string[]
    /** Filter by building storey names (comma-separated or array) */
    storeys?: string | string[]
    /** Filter by specific door GUIDs (comma-separated or array) */
    guids?: string | string[]
}
```

## IFC Relationships

### Door Type (ifcRelDefinesByType)
- Extracts the door type definition via `IFCRELDEFINESBYTYPE` relationships
- Retrieves the type name from the `IFCDOORTYPE.Name` property
- Used for filtering by door type

### Building Storey (ifcRelContainedInSpatialStructure)
- Extracts the spatial container via `IFCRELCONTAINEDINSPATIALSTRUCTURE` relationships
- Retrieves the storey name from `IFCBUILDINGSTOREY.Name` or `IFCBUILDINGSTOREY.LongName`
- Used for filtering by storey

## Performance Considerations

### When to Use Filtering

1. **Large Models**: Filter by storey to process one floor at a time
2. **Incremental Updates**: Filter by GUID to regenerate only changed doors
3. **Type-Specific Processing**: Filter by type for specialized door categories
4. **Testing**: Filter to a small subset for quick testing

### Best Practices

1. Use `--list-types` and `--list-storeys` first to discover available filter values
2. Filter by storey for large models to reduce memory usage
3. Use GUID filtering for precise updates of specific doors
4. Combine filters to narrow down results efficiently

## Examples

### Workflow: Update Specific Doors

```bash
# Step 1: Analyze the model to find door GUIDs
node scripts/analyze-doors-filtered.js model.ifc --storeys "EG"

# Step 2: Copy the GUIDs of doors you want to update
# Output will show a comma-separated list of GUIDs

# Step 3: Process only those specific doors
node scripts/import-doors-to-airtable.js model.ifc --guids "GUID1,GUID2,GUID3"
```

### Workflow: Process by Floor

```bash
# Process ground floor doors
node scripts/import-doors-to-airtable.js model.ifc --storeys "EG"

# Process first floor doors
node scripts/import-doors-to-airtable.js model.ifc --storeys "OG1"

# Process second floor doors
node scripts/import-doors-to-airtable.js model.ifc --storeys "OG2"
```

### Workflow: Process by Door Category

```bash
# Process fire doors
node scripts/import-doors-to-airtable.js model.ifc --door-types "T30,T60,T90"

# Process standard doors
node scripts/import-doors-to-airtable.js model.ifc --door-types "Standard"
```

## Troubleshooting

### No Doors Match Filter

If no doors match your filter criteria:
1. Use `--list-types` and `--list-storeys` to see available values
2. Check for typos in filter values
3. Remember that filters are case-insensitive partial matches (except GUIDs)
4. Try filtering with a single criterion first

### Storey Information Missing

If doors show "Unknown" storey:
1. Check if the IFC file contains `IFCBUILDINGSTOREY` entities
2. Verify that doors are properly contained in spatial structures
3. Some IFC files may not have proper spatial hierarchy

### Type Information Missing

If doors show "Unknown" type:
1. Check if the IFC file contains `IFCDOORTYPE` entities
2. Verify that doors have `IFCRELDEFINESBYTYPE` relationships
3. Some IFC files may not define door types
