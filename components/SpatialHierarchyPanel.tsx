'use client'

import { useState, useRef, useEffect } from 'react'
import type { SpatialNode } from '@/lib/spatial-structure'
import type { ElementVisibilityManager } from '@/lib/element-visibility-manager'

interface SpatialHierarchyPanelProps {
  spatialStructure: SpatialNode | null
  visibilityManager: ElementVisibilityManager | null
  onFocusNode?: (node: SpatialNode) => void
  onClose?: () => void
}

export default function SpatialHierarchyPanel({
  spatialStructure,
  visibilityManager,
  onFocusNode,
  onClose,
}: SpatialHierarchyPanelProps) {
  const [isMinimized, setIsMinimized] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [expandedNodes, setExpandedNodes] = useState<Set<number>>(new Set())

  useEffect(() => {
    if (spatialStructure) {
      setExpandedNodes(new Set([spatialStructure.id]))
    }
  }, [spatialStructure])

  const toggleExpanded = (nodeId: number) => {
    const newExpanded = new Set(expandedNodes)
    if (newExpanded.has(nodeId)) {
      newExpanded.delete(nodeId)
    } else {
      newExpanded.add(nodeId)
    }
    setExpandedNodes(newExpanded)
  }

  const handleVisibilityToggle = async (node: SpatialNode, visible: boolean) => {
    if (!visibilityManager) return
    await visibilityManager.setSpatialNodeVisibility(node, visible)
  }

  const handleIsolate = async (node: SpatialNode) => {
    if (!visibilityManager) return
    await visibilityManager.isolateSpatialNode(node)
  }

  const handleFocus = (node: SpatialNode) => {
    if (onFocusNode) {
      onFocusNode(node)
    }
  }

  const filterNodes = (node: SpatialNode, query: string): SpatialNode | null => {
    if (!query) return node

    const matchesQuery = node.name.toLowerCase().includes(query.toLowerCase())
    const filteredChildren = node.children
      .map(child => filterNodes(child, query))
      .filter((child): child is SpatialNode => child !== null)

    if (matchesQuery || filteredChildren.length > 0) {
      return {
        ...node,
        children: filteredChildren,
      }
    }

    return null
  }

  const filteredStructure = spatialStructure
    ? filterNodes(spatialStructure, searchQuery)
    : null

  const renderNode = (node: SpatialNode, depth: number = 0): JSX.Element | null => {
    const isExpanded = expandedNodes.has(node.id)
    const hasChildren = node.children.length > 0
    const elementCount = node.elementIds.length

    return (
      <div key={node.id} className="spatial-node">
        <div
          className="spatial-node-header"
          style={{ paddingLeft: `${depth * 12 + 6}px` }}
        >
          <button
            className="spatial-node-toggle"
            onClick={() => toggleExpanded(node.id)}
            disabled={!hasChildren}
            style={{ 
              opacity: hasChildren ? 1 : 0.3,
              background: 'none',
              border: 'none',
              color: '#888',
              cursor: hasChildren ? 'pointer' : 'default',
              fontSize: '10px',
              padding: '0 4px',
            }}
          >
            {hasChildren ? (isExpanded ? '▼' : '▶') : '·'}
          </button>

          <span 
            className="spatial-node-name" 
            title={node.name}
            style={{
              flex: 1,
              fontSize: '12px',
              color: '#e0e0e0',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {node.name}
          </span>

          {elementCount > 0 && (
            <span style={{ fontSize: '10px', color: '#666', marginLeft: '4px' }}>
              ({elementCount})
            </span>
          )}

          <div className="spatial-node-actions" style={{ display: 'flex', gap: '2px', marginLeft: '4px' }}>
            <button
              onClick={() => handleFocus(node)}
              title="Focus"
              style={{
                background: 'none',
                border: 'none',
                color: '#888',
                cursor: 'pointer',
                fontSize: '10px',
                padding: '2px 4px',
              }}
            >
              ◎
            </button>
            <button
              onClick={() => handleIsolate(node)}
              title="Isolate"
              style={{
                background: 'none',
                border: 'none',
                color: '#888',
                cursor: 'pointer',
                fontSize: '10px',
                padding: '2px 4px',
              }}
            >
              ◉
            </button>
            <input
              type="checkbox"
              checked={node.visible}
              onChange={(e) => handleVisibilityToggle(node, e.target.checked)}
              title="Visible"
              style={{ margin: 0, cursor: 'pointer' }}
            />
          </div>
        </div>

        {isExpanded && hasChildren && (
          <div className="spatial-node-children">
            {node.children.map((child) => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    )
  }

  if (!spatialStructure) {
    return null
  }

  return (
    <div
      className="spatial-hierarchy-panel"
      style={{
        width: isMinimized ? '140px' : '280px',
        maxHeight: isMinimized ? 'auto' : '400px',
        backgroundColor: 'rgba(32, 32, 32, 0.95)',
        border: '1px solid #444',
        borderRadius: '6px',
        boxShadow: '0 2px 12px rgba(0,0,0,0.3)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          padding: '8px 10px',
          borderBottom: '1px solid #444',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span style={{ fontSize: '11px', color: '#888', fontWeight: 500 }}>
          Spatial Hierarchy
        </span>
        <div style={{ display: 'flex', gap: '4px' }}>
          <button
            onClick={(e) => {
              e.stopPropagation()
              setIsMinimized(!isMinimized)
            }}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: '12px',
              color: '#888',
              padding: '2px 6px',
              lineHeight: '1',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = '#fff'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = '#888'
            }}
          >
            {isMinimized ? '+' : '−'}
          </button>
          {onClose && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                onClose()
              }}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                fontSize: '14px',
                color: '#888',
                padding: '2px 6px',
                lineHeight: '1',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = '#fff'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = '#888'
              }}
            >
              ×
            </button>
          )}
        </div>
      </div>

      {!isMinimized && (
        <>
          <div style={{ padding: '6px' }}>
            <input
              type="text"
              placeholder="Search..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                width: '100%',
                padding: '4px 8px',
                border: '1px solid #555',
                borderRadius: '3px',
                fontSize: '11px',
                backgroundColor: '#2a2a2a',
                color: '#e0e0e0',
                outline: 'none',
              }}
            />
          </div>

          <div
            className="spatial-tree"
            style={{
              overflowY: 'auto',
              padding: '4px',
              flex: 1,
            }}
          >
            {filteredStructure ? (
              renderNode(filteredStructure)
            ) : (
              <div style={{ padding: '12px', textAlign: 'center', color: '#666', fontSize: '11px' }}>
                No results
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

