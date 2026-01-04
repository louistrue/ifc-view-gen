'use client'

import { useState, useMemo, useRef } from 'react'
import type { ElementVisibilityManager } from '@/lib/element-visibility-manager'
import type { ElementInfo } from '@/lib/ifc-types'

interface IFCClassFilterPanelProps {
  visibilityManager: ElementVisibilityManager | null
  elements: ElementInfo[]
  activeFilters: Set<string> | null  // null = all visible, Set = only these visible
  onFiltersChange: (filters: Set<string> | null) => void
  onClose?: () => void
}

export default function IFCClassFilterPanel({
  visibilityManager,
  elements,
  activeFilters,
  onFiltersChange,
  onClose,
}: IFCClassFilterPanelProps) {
  const [searchQuery, setSearchQuery] = useState('')
  // Use parent-controlled state for filter persistence
  const visibleClasses = activeFilters
  const setVisibleClasses = onFiltersChange
  const isApplying = useRef(false) // Prevent double-calls

  // Get unique IFC class names from elements with counts
  // Only shows typeName (IFC class like IFCDOOR, IFCWALL, etc.)
  const classCategories = useMemo(() => {
    const counts = new Map<string, number>()

    for (const el of elements) {
      // Only use IFC class name (typeName)
      if (el.typeName) {
        counts.set(el.typeName, (counts.get(el.typeName) || 0) + 1)
      }
    }

    // Sort by count descending
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }))
  }, [elements])

  // All class names for reference
  const allClassNames = useMemo(() =>
    new Set(classCategories.map(c => c.name)),
    [classCategories]
  )

  // Filter by search query
  const filteredClasses = useMemo(() => {
    if (!searchQuery) return classCategories
    const query = searchQuery.toLowerCase()
    return classCategories.filter(c =>
      c.name.toLowerCase().includes(query)
    )
  }, [classCategories, searchQuery])

  // Apply filter directly (not via useEffect)
  const applyFilter = async (classes: Set<string> | null) => {
    if (!visibilityManager || isApplying.current) return

    isApplying.current = true
    try {
      if (classes === null) {
        console.log('IFCClassFilter: Resetting to show all')
        await visibilityManager.resetAllVisibility()
      } else {
        const classesToShow = Array.from(classes)
        console.log('IFCClassFilter: Filtering to:', classesToShow)
        await visibilityManager.filterByIFCClass(classesToShow)
      }
    } finally {
      isApplying.current = false
    }
  }

  const handleClassClick = async (className: string) => {
    let newVisibleClasses: Set<string> | null

    if (visibleClasses === null) {
      // First click - isolate to just this class
      newVisibleClasses = new Set([className])
    } else if (visibleClasses.has(className)) {
      // Class is currently visible - toggle it off
      if (visibleClasses.size === 1) {
        // Last visible class - show all instead of hiding everything
        newVisibleClasses = null
      } else {
        // Remove from visible set
        newVisibleClasses = new Set(visibleClasses)
        newVisibleClasses.delete(className)
      }
    } else {
      // Class is currently hidden - add to visible set
      newVisibleClasses = new Set(visibleClasses)
      newVisibleClasses.add(className)
    }

    // Update state first
    setVisibleClasses(newVisibleClasses)
    // Then apply filter
    await applyFilter(newVisibleClasses)
  }

  const handleShowAll = async () => {
    setVisibleClasses(null)
    await applyFilter(null)
  }

  // Check if a class is currently visible
  const isClassVisible = (className: string) => {
    return visibleClasses === null || visibleClasses.has(className)
  }

  // Format IFC class name for display - remove "IFC" prefix
  const formatClassName = (name: string) => {
    // Remove "IFC" prefix and make it readable
    const stripped = name.startsWith('IFC') ? name.slice(3) : name.startsWith('Ifc') ? name.slice(3) : name
    // Make it more readable: Door, Wall, Window etc.
    return stripped.charAt(0).toUpperCase() + stripped.slice(1).toLowerCase()
  }

  const isFiltered = visibleClasses !== null

  return (
    <div
      className="ifc-class-filter-panel"
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
          IFC Classes
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
        placeholder="Search IFC classes..."
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
          Showing {visibleClasses!.size} of {allClassNames.size} classes
        </div>
      )}

      {/* Class List */}
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
        {filteredClasses.length === 0 ? (
          <div style={{ color: '#666', fontSize: '11px', padding: '8px', textAlign: 'center' }}>
            No classes found
          </div>
        ) : (
          filteredClasses.map((cls) => {
            const visible = isClassVisible(cls.name)
            return (
              <button
                key={cls.name}
                onClick={() => handleClassClick(cls.name)}
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
                  {formatClassName(cls.name)}
                </span>
                <span style={{
                  color: '#666',
                  fontSize: '10px',
                  marginLeft: '8px',
                }}>
                  {cls.count}
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

