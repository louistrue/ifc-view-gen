'use client'

import { useState, useMemo, useRef } from 'react'
import type { ElementVisibilityManager } from '@/lib/element-visibility-manager'
import type { ElementInfo } from '@/lib/ifc-types'

interface TypeFilterPanelProps {
  visibilityManager: ElementVisibilityManager | null
  elements: ElementInfo[]
  activeFilters: Set<string> | null  // null = all visible, Set = only these visible
  onFiltersChange: (filters: Set<string> | null) => void
  onClose?: () => void
}

export default function TypeFilterPanel({
  visibilityManager,
  elements,
  activeFilters,
  onFiltersChange,
  onClose,
}: TypeFilterPanelProps) {
  const [searchQuery, setSearchQuery] = useState('')
  // Use parent-controlled state for filter persistence
  const visibleTypes = activeFilters
  const setVisibleTypes = onFiltersChange
  const isApplying = useRef(false) // Prevent double-calls

  // Get unique product types from elements with counts
  // Only shows productTypeName from IfcRelDefinesByType - NOT IFC classes
  const typeCategories = useMemo(() => {
    const counts = new Map<string, number>()
    let elementsWithType = 0
    let elementsWithoutType = 0

    for (const el of elements) {
      // Only use product type name (from IfcDoorType, IfcWindowType, etc.)
      // Skip IFC class names like IFCDOOR, IFCWALL
      if (el.productTypeName) {
        counts.set(el.productTypeName, (counts.get(el.productTypeName) || 0) + 1)
        elementsWithType++
      } else {
        elementsWithoutType++
      }
    }

    console.log(`TypeFilter: ${elementsWithType} elements have type names, ${elementsWithoutType} without`)

    // Sort by count descending
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count, isProductType: true }))
  }, [elements])

  // All type names for reference
  const allTypeNames = useMemo(() =>
    new Set(typeCategories.map(t => t.name)),
    [typeCategories]
  )

  // Filter by search query
  const filteredTypes = useMemo(() => {
    if (!searchQuery) return typeCategories
    const query = searchQuery.toLowerCase()
    return typeCategories.filter(t =>
      t.name.toLowerCase().includes(query)
    )
  }, [typeCategories, searchQuery])

  // Apply filter directly (not via useEffect)
  const applyFilter = async (types: Set<string> | null) => {
    if (!visibilityManager || isApplying.current) return

    isApplying.current = true
    try {
      if (types === null) {
        console.log('ClassFilter: Resetting to show all')
        await visibilityManager.resetAllVisibility()
      } else {
        const typesToShow = Array.from(types)
        console.log('ClassFilter: Filtering to:', typesToShow)
        await visibilityManager.filterByType(typesToShow)
      }
    } finally {
      isApplying.current = false
    }
  }

  const handleTypeClick = async (typeName: string) => {
    let newVisibleTypes: Set<string> | null

    if (visibleTypes === null) {
      // First click - isolate to just this type
      newVisibleTypes = new Set([typeName])
    } else if (visibleTypes.has(typeName)) {
      // Type is currently visible - toggle it off
      if (visibleTypes.size === 1) {
        // Last visible type - show all instead of hiding everything
        newVisibleTypes = null
      } else {
        // Remove from visible set
        newVisibleTypes = new Set(visibleTypes)
        newVisibleTypes.delete(typeName)
      }
    } else {
      // Type is currently hidden - add to visible set
      newVisibleTypes = new Set(visibleTypes)
      newVisibleTypes.add(typeName)
    }

    // Update state first
    setVisibleTypes(newVisibleTypes)
    // Then apply filter
    await applyFilter(newVisibleTypes)
  }

  const handleShowAll = async () => {
    setVisibleTypes(null)
    await applyFilter(null)
  }

  // Check if a type is currently visible
  const isTypeVisible = (typeName: string) => {
    return visibleTypes === null || visibleTypes.has(typeName)
  }

  // Format type name for display
  // For IFC classes: remove "Ifc" prefix
  // For product types: display as-is
  const formatTypeName = (name: string) => {
    // Check if it's an IFC class name
    if (name.startsWith('IFC') || name.startsWith('Ifc')) {
      const stripped = name.startsWith('IFC') ? name.slice(3) : name.slice(3)
      // Make it more readable: Door, Wall, Window etc.
      return stripped.charAt(0).toUpperCase() + stripped.slice(1).toLowerCase()
    }
    // Product type names - display as-is (these are user-defined in the IFC)
    return name
  }

  const isFiltered = visibleTypes !== null

  return (
    <div
      className="type-filter-panel"
      style={{
        padding: '10px',
        backgroundColor: 'rgba(32, 32, 32, 0.95)',
        border: '1px solid #444',
        borderRadius: '6px',
        boxShadow: '0 2px 12px rgba(0,0,0,0.3)',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        width: '180px',
        maxHeight: '400px',
      }}
    >
      {/* Show Full Model button when filtered */}
      {isFiltered && (
        <button
          onClick={handleShowAll}
          style={{
            padding: '8px 12px',
            fontSize: '12px',
            border: '1px solid #6ee7df',
            borderRadius: '4px',
            backgroundColor: '#4ecdc4',
            color: '#1a1a1a',
            cursor: 'pointer',
            fontWeight: 600,
            width: '100%',
            textAlign: 'center',
          }}
        >
          ↺ Show Full Model
        </button>
      )}

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: '12px', fontWeight: 600, color: '#e0e0e0' }}>
          Door Types
        </span>
        {onClose && (
          <button
            onClick={onClose}
            style={{
              padding: '2px 6px',
              fontSize: '10px',
              border: '1px solid #555',
              borderRadius: '3px',
              backgroundColor: 'transparent',
              color: '#888',
              cursor: 'pointer',
            }}
          >
            ✕
          </button>
        )}
      </div>

      {/* Search Input */}
      <input
        type="text"
        placeholder="Search door types..."
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        style={{
          padding: '6px 8px',
          fontSize: '11px',
          border: '1px solid #555',
          borderRadius: '4px',
          backgroundColor: '#1a1a1a',
          color: '#e0e0e0',
          outline: 'none',
          width: '100%',
          boxSizing: 'border-box',
        }}
      />

      {/* Filter status */}
      {isFiltered && (
        <div
          style={{
            padding: '6px 8px',
            backgroundColor: 'rgba(78, 205, 196, 0.15)',
            border: '1px solid rgba(78, 205, 196, 0.4)',
            borderRadius: '4px',
            fontSize: '11px',
            color: '#4ecdc4',
          }}
        >
          Showing {visibleTypes!.size} of {allTypeNames.size} types
        </div>
      )}

      {/* Type List */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '2px',
          overflowY: 'auto',
          flex: 1,
          maxHeight: '280px',
        }}
      >
        {filteredTypes.length === 0 ? (
          <div style={{ color: '#666', fontSize: '11px', padding: '8px', textAlign: 'center' }}>
            No types found
          </div>
        ) : (
          filteredTypes.map((type) => {
            const visible = isTypeVisible(type.name)
            return (
              <button
                key={type.name}
                onClick={() => handleTypeClick(type.name)}
                style={{
                  padding: '5px 8px',
                  border: '1px solid transparent',
                  borderRadius: '3px',
                  backgroundColor: visible && isFiltered ? 'rgba(78, 205, 196, 0.15)' : 'transparent',
                  color: visible ? '#e0e0e0' : '#666',
                  cursor: 'pointer',
                  fontSize: '11px',
                  fontFamily: 'system-ui, -apple-system, sans-serif',
                  textAlign: 'left',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  transition: 'all 0.1s ease',
                  opacity: visible ? 1 : 0.5,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.08)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = visible && isFiltered
                    ? 'rgba(78, 205, 196, 0.15)'
                    : 'transparent'
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{
                    width: '8px',
                    height: '8px',
                    borderRadius: '2px',
                    backgroundColor: visible ? '#4ecdc4' : '#444',
                    border: visible ? 'none' : '1px solid #555',
                    flexShrink: 0,
                  }} />
                  {formatTypeName(type.name)}
                </span>
                <span style={{
                  color: '#666',
                  fontSize: '10px',
                  marginLeft: '8px',
                }}>
                  {type.count}
                </span>
              </button>
            )
          })
        )}
      </div>

      {/* Hint */}
      <div style={{
        fontSize: '10px',
        color: '#555',
        textAlign: 'center',
        borderTop: '1px solid #333',
        paddingTop: '6px',
      }}>
        Click to isolate • Click again to add more
      </div>
    </div>
  )
}
