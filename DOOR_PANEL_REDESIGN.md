# Door Panel UI Redesign - Architecture & Implementation Plan

## Overview

This document outlines the redesign of the Door Panel UI to provide exceptional UX for filtering, selecting, and exporting door views while maintaining tight integration with the 3D model display.

## User Journey Analysis

### Primary User Flow
1. **Upload IFC** → User loads architectural model
2. **Explore** → Navigate the 3D model to understand the building
3. **Filter** → Narrow down doors by storey, type, or search
4. **Preview** → See filtered doors highlighted in 3D
5. **Select** → Pick specific doors for processing
6. **Configure** → Set SVG style options
7. **Export** → Download ZIP or upload to Airtable

### Key UX Requirements
- **Visual feedback**: Filter changes must immediately reflect in 3D
- **Context awareness**: User should always know which door they're looking at
- **Progressive disclosure**: Advanced options hidden until needed
- **Keyboard navigation**: Power users can filter/select efficiently
- **Performance**: Smooth with 500+ doors

---

## Architecture

### Component Hierarchy

```
IFCViewer
├── [3D Canvas + Navigation]
├── ViewerToolbar (left side)
│   └── [existing tools]
└── DoorPanel (right side) ← NEW COMPONENT
    ├── DoorPanelHeader
    │   ├── Title + door count badge
    │   ├── Isolate toggle
    │   └── Collapse button
    ├── DoorFilterBar
    │   ├── Search input
    │   ├── StoreyFilter (dropdown/chips)
    │   ├── TypeFilter (dropdown/chips)
    │   └── Active filter badges
    ├── DoorList (virtualized)
    │   ├── Bulk selection controls
    │   └── DoorListItem[] (hover/click → 3D sync)
    ├── ExportSection (collapsible)
    │   ├── StyleOptions (collapsed)
    │   └── ExportButtons
    └── DoorPreviewModal
```

### State Management

Create `DoorFilterContext` to manage:
```typescript
interface DoorFilterState {
  // Filter state
  searchQuery: string
  selectedStoreys: Set<string>
  selectedTypes: Set<string>

  // Selection state
  selectedDoorIds: Set<string>
  hoveredDoorId: string | null

  // Derived
  filteredDoors: DoorContext[]

  // 3D sync options
  isolateFiltered: boolean
  highlightHovered: boolean
}
```

### Props Interface for DoorPanel

```typescript
interface DoorPanelProps {
  doorContexts: DoorContext[]

  // 3D integration
  visibilityManager: ElementVisibilityManager | null
  navigationManager: NavigationManager | null

  // Callbacks
  onDoorHover?: (doorId: string | null) => void
  onDoorFocus?: (doorContext: DoorContext) => void
  onIsolationChange?: (isolated: boolean, doorIds: number[]) => void

  // Export
  modelSource?: string
  onExportComplete?: () => void
}
```

---

## 3D Model Integration

### 1. Filter → Highlight Sync

When filters change, matching doors are highlighted in 3D:

```typescript
// In DoorPanel
useEffect(() => {
  if (visibilityManager && isolateFiltered) {
    const doorExpressIds = filteredDoors.map(d => d.door.expressID)
    visibilityManager.isolateElements(doorExpressIds)
  } else if (visibilityManager) {
    visibilityManager.resetAllVisibility()
    // Apply subtle highlight to filtered doors
    const doorExpressIds = filteredDoors.map(d => d.door.expressID)
    visibilityManager.highlightElements(doorExpressIds)
  }
}, [filteredDoors, isolateFiltered])
```

### 2. Hover → Glow Effect

When user hovers a door in the list:

```typescript
// ElementVisibilityManager extension
class ElementVisibilityManager {
  // NEW: Highlight with glow/outline effect
  highlightElement(expressId: number, color?: THREE.Color): void {
    // Option A: Material swap with emissive
    // Option B: Post-processing outline
    // Option C: Duplicate mesh with scaled wireframe
  }

  clearHighlight(): void {
    // Restore original materials
  }
}
```

### 3. Click → Zoom to Door

When user clicks a door:

```typescript
// NavigationManager extension
class NavigationManager {
  // NEW: Zoom to specific element
  zoomToElement(boundingBox: THREE.Box3, padding: number = 1.5): void {
    const center = boundingBox.getCenter(new THREE.Vector3())
    const size = boundingBox.getSize(new THREE.Vector3())
    const maxDim = Math.max(size.x, size.y, size.z)

    // Calculate camera distance for good framing
    const fov = this.camera.fov * (Math.PI / 180)
    const distance = (maxDim * padding) / (2 * Math.tan(fov / 2))

    // Animate camera to position
    this.controls.setLookAt(
      center.x + distance * 0.5,
      center.y + distance * 0.5,
      center.z + distance * 0.5,
      center.x, center.y, center.z,
      true // animate
    )
  }
}
```

### 4. Selection → Persistent Coloring

Selected doors shown with distinct color:

```typescript
// Colors for door states
const DOOR_COLORS = {
  default: null,           // Original material
  filtered: 0x4ecdc4,      // Teal - matches app accent
  hovered: 0x00ff88,       // Bright green glow
  selected: 0x3b82f6,      // Blue - selection color
}
```

---

## DoorContext Enhancement

Add `storeyName` to DoorContext from spatial structure:

```typescript
// door-analyzer.ts
export interface DoorContext {
  // ... existing fields
  storeyName: string | null  // NEW: Extracted from spatial structure
}

// During analysis, look up storey from spatial containment
async function getStoreyForDoor(
  fragmentsModel: any,
  doorExpressId: number
): Promise<string | null> {
  // Use fragments spatial structure to find containing storey
  const spatialInfo = fragmentsModel.getSpatialStructure?.()
  // Traverse to find storey containing this door
}
```

---

## UI Components Detail

### DoorFilterBar

```tsx
<DoorFilterBar>
  {/* Search - filters by ID, type, or storey name */}
  <SearchInput
    placeholder="Search doors..."
    value={searchQuery}
    onChange={setSearchQuery}
  />

  {/* Quick filter chips */}
  <FilterChipGroup>
    <FilterChip
      active={selectedStoreys.size === 0 && selectedTypes.size === 0}
      onClick={clearFilters}
    >
      All ({doorContexts.length})
    </FilterChip>
  </FilterChipGroup>

  {/* Storey dropdown with checkboxes */}
  <DropdownFilter
    label="Storey"
    options={availableStoreys}
    selected={selectedStoreys}
    onChange={setSelectedStoreys}
    showCounts={true}
  />

  {/* Type dropdown with checkboxes */}
  <DropdownFilter
    label="Type"
    options={availableTypes}
    selected={selectedTypes}
    onChange={setSelectedTypes}
    showCounts={true}
  />

  {/* Active filters display */}
  {hasActiveFilters && (
    <ActiveFilters>
      {[...selectedStoreys].map(s => (
        <FilterBadge key={s} onRemove={() => removeStorey(s)}>{s}</FilterBadge>
      ))}
      {[...selectedTypes].map(t => (
        <FilterBadge key={t} onRemove={() => removeType(t)}>{t}</FilterBadge>
      ))}
      <ClearAllButton onClick={clearFilters}>Clear all</ClearAllButton>
    </ActiveFilters>
  )}
</DoorFilterBar>
```

### DoorListItem

```tsx
<DoorListItem
  door={doorContext}
  isSelected={selectedDoorIds.has(doorContext.doorId)}
  isHovered={hoveredDoorId === doorContext.doorId}
  onSelect={() => toggleSelection(doorContext.doorId)}
  onHover={() => setHoveredDoorId(doorContext.doorId)}
  onUnhover={() => setHoveredDoorId(null)}
  onFocus={() => zoomToDoor(doorContext)}
>
  {/* Checkbox */}
  <Checkbox checked={isSelected} />

  {/* Door info */}
  <DoorInfo>
    <DoorId>{doorContext.doorId}</DoorId>
    <DoorMeta>
      {doorContext.doorTypeName && <TypeBadge>{doorContext.doorTypeName}</TypeBadge>}
      {doorContext.storeyName && <StoreyBadge>{doorContext.storeyName}</StoreyBadge>}
    </DoorMeta>
  </DoorInfo>

  {/* Quick actions */}
  <QuickActions>
    <IconButton onClick={() => showPreview(doorContext)} title="Preview">
      <EyeIcon />
    </IconButton>
    <IconButton onClick={() => zoomToDoor(doorContext)} title="Zoom to door">
      <CrosshairIcon />
    </IconButton>
  </QuickActions>
</DoorListItem>
```

### Export Section

```tsx
<ExportSection>
  {/* Collapsible style options */}
  <CollapsibleSection title="Style Options" defaultOpen={false}>
    <StyleGrid>
      <ColorPicker label="Door Color" value={options.doorColor} />
      <ColorPicker label="Wall Color" value={options.wallColor} />
      <ColorPicker label="Device Color" value={options.deviceColor} />
      <NumberInput label="Line Width" value={options.lineWidth} />
      <Toggle label="Show Legend" checked={options.showLegend} />
      <Toggle label="Show Labels" checked={options.showLabels} />
    </StyleGrid>
  </CollapsibleSection>

  {/* Export actions */}
  <ExportActions>
    <ExportButton
      onClick={handleDownload}
      disabled={selectedDoorIds.size === 0}
    >
      Download ZIP ({selectedDoorIds.size} doors)
    </ExportButton>

    {airtableConfigured && (
      <ExportButton
        variant="airtable"
        onClick={handleUpload}
        disabled={selectedDoorIds.size === 0}
      >
        Upload to Airtable ({selectedDoorIds.size} doors)
      </ExportButton>
    )}
  </ExportActions>

  {/* Progress indicator */}
  {isProcessing && (
    <ProgressBar value={progress} max={100}>
      Processing {currentIndex}/{totalDoors}...
    </ProgressBar>
  )}
</ExportSection>
```

---

## Styling Approach

Use CSS modules or styled-jsx with design tokens:

```css
/* Design tokens */
:root {
  --panel-bg: #2a2a2a;
  --panel-bg-darker: #1a1a1a;
  --border-color: #444;
  --text-primary: #fff;
  --text-secondary: #aaa;
  --text-muted: #666;

  --accent-primary: #3b82f6;    /* Blue - primary actions */
  --accent-secondary: #4ecdc4;  /* Teal - highlights */
  --accent-success: #22c55e;    /* Green - success states */
  --accent-warning: #f59e0b;    /* Orange - warnings */
  --accent-error: #ef4444;      /* Red - errors */

  --airtable-color: #18bfff;

  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;

  --shadow-sm: 0 1px 2px rgba(0,0,0,0.3);
  --shadow-md: 0 4px 12px rgba(0,0,0,0.4);
}
```

---

## Implementation Order

1. **Add storeyName to DoorContext** (door-analyzer.ts)
   - Modify analyzeDoors to extract storey from spatial structure
   - Update DoorContext interface

2. **Create DoorFilterContext** (new file)
   - State management for filters and selection
   - Derived filtered doors computation

3. **Extend ElementVisibilityManager** (existing file)
   - Add highlightElement/highlightElements methods
   - Add temporary color overlay capability

4. **Extend NavigationManager** (existing file)
   - Add zoomToElement method with smooth animation

5. **Create DoorPanel component** (new file)
   - Replace BatchProcessor
   - Implement all sub-components

6. **Integrate in IFCViewer** (existing file)
   - Pass managers to DoorPanel
   - Wire up callbacks

7. **Testing & Polish**
   - Test with large models (500+ doors)
   - Refine animations and transitions
   - Keyboard accessibility

---

## Migration from BatchProcessor

The new DoorPanel will:
- ✅ Keep all existing export functionality
- ✅ Keep all SVG style options
- ✅ Keep Airtable integration
- ✅ Add filtering by storey/type
- ✅ Add search capability
- ✅ Add 3D synchronization
- ✅ Add multi-select with checkboxes
- ✅ Add zoom-to-door
- ✅ Add hover highlighting

BatchProcessor.tsx will be replaced entirely by the new DoorPanel.tsx.

---

## Performance Considerations

1. **Virtualized list**: Use react-window or similar for 500+ doors
2. **Debounced search**: 300ms debounce on search input
3. **Memoized filtering**: useMemo for filtered doors computation
4. **Batched 3D updates**: Aggregate visibility changes before applying
5. **RAF for highlights**: Use requestAnimationFrame for smooth highlighting

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `/` | Focus search |
| `Escape` | Clear search / close modal |
| `↑/↓` | Navigate door list |
| `Space` | Toggle door selection |
| `Enter` | Zoom to door |
| `a` | Select all filtered |
| `d` | Deselect all |
| `i` | Toggle isolation mode |
