'use client'

import { useRef, useState } from 'react'
import type { LoadedModel } from '@/lib/ifc-types'

interface ModelManagerPanelProps {
  models: LoadedModel[]
  onAddModels: (files: FileList) => void
  onRemoveModel: (modelId: string) => void
  onToggleVisibility: (modelId: string) => void
  isLoading: boolean
  loadingModelName?: string
}

// Nice pastel colors for models
const MODEL_COLORS = [
  '#3b82f6', // Blue
  '#10b981', // Green
  '#f59e0b', // Amber
  '#8b5cf6', // Violet
  '#ec4899', // Pink
  '#06b6d4', // Cyan
  '#f97316', // Orange
  '#84cc16', // Lime
]

export function getModelColor(index: number): string {
  return MODEL_COLORS[index % MODEL_COLORS.length]
}

export default function ModelManagerPanel({
  models,
  onAddModels,
  onRemoveModel,
  onToggleVisibility,
  isLoading,
  loadingModelName,
}: ModelManagerPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isDragOver, setIsDragOver] = useState(false)

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const ifcFiles = Array.from(e.dataTransfer.files).filter(f =>
        f.name.toLowerCase().endsWith('.ifc')
      )
      if (ifcFiles.length > 0) {
        const dt = new DataTransfer()
        ifcFiles.forEach(f => dt.items.add(f))
        onAddModels(dt.files)
      }
    }
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onAddModels(e.target.files)
      // Reset input so same file can be selected again
      e.target.value = ''
    }
  }

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }

  const totalElements = models.reduce((sum, m) => sum + m.elementCount, 0)

  return (
    <div className="model-manager-panel">
      {/* Header */}
      <div className="model-manager-header">
        <div className="header-title">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
            <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
            <line x1="12" y1="22.08" x2="12" y2="12" />
          </svg>
          <span>Models</span>
          <span className="model-count">{models.length}</span>
        </div>
        {totalElements > 0 && (
          <div className="elements-count">
            {totalElements.toLocaleString()} elements
          </div>
        )}
      </div>

      {/* Model List */}
      <div className="model-list">
        {models.map((model) => (
          <div key={model.id} className={`model-item ${!model.visible ? 'hidden-model' : ''}`}>
            <div className="model-color" style={{ backgroundColor: model.color }} />
            <div className="model-info">
              <div className="model-name" title={model.fileName}>
                {model.fileName.length > 20
                  ? model.fileName.slice(0, 17) + '...'
                  : model.fileName}
              </div>
              <div className="model-meta">
                {model.elementCount.toLocaleString()} elements
              </div>
            </div>
            <div className="model-actions">
              <button
                className={`visibility-btn ${model.visible ? 'visible' : 'hidden'}`}
                onClick={() => onToggleVisibility(model.id)}
                title={model.visible ? 'Hide model' : 'Show model'}
              >
                {model.visible ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                )}
              </button>
              <button
                className="remove-btn"
                onClick={() => onRemoveModel(model.id)}
                title="Remove model"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </div>
        ))}

        {/* Loading indicator for new model */}
        {isLoading && loadingModelName && (
          <div className="model-item loading">
            <div className="loading-spinner" />
            <div className="model-info">
              <div className="model-name">{loadingModelName}</div>
              <div className="model-meta">Loading...</div>
            </div>
          </div>
        )}
      </div>

      {/* Add More Models */}
      <div
        className={`add-model-zone ${isDragOver ? 'drag-over' : ''} ${isLoading ? 'disabled' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => !isLoading && fileInputRef.current?.click()}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="16" />
          <line x1="8" y1="12" x2="16" y2="12" />
        </svg>
        <span>Add IFC Models</span>
        <input
          ref={fileInputRef}
          type="file"
          accept=".ifc"
          multiple
          onChange={handleFileSelect}
          style={{ display: 'none' }}
        />
      </div>

      <style jsx>{`
        .model-manager-panel {
          background: linear-gradient(180deg, #1e1e1e 0%, #171717 100%);
          border-radius: 12px;
          padding: 12px;
          min-width: 240px;
          max-width: 280px;
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
          border: 1px solid rgba(255, 255, 255, 0.08);
        }

        .model-manager-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 12px;
          padding-bottom: 10px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        }

        .header-title {
          display: flex;
          align-items: center;
          gap: 8px;
          color: #e0e0e0;
          font-weight: 600;
          font-size: 14px;
        }

        .model-count {
          background: rgba(59, 130, 246, 0.2);
          color: #60a5fa;
          padding: 2px 8px;
          border-radius: 10px;
          font-size: 12px;
          font-weight: 500;
        }

        .elements-count {
          font-size: 11px;
          color: #666;
        }

        .model-list {
          display: flex;
          flex-direction: column;
          gap: 6px;
          max-height: 300px;
          overflow-y: auto;
          margin-bottom: 10px;
        }

        .model-list::-webkit-scrollbar {
          width: 4px;
        }

        .model-list::-webkit-scrollbar-track {
          background: transparent;
        }

        .model-list::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.15);
          border-radius: 2px;
        }

        .model-item {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 8px 10px;
          background: rgba(255, 255, 255, 0.04);
          border-radius: 8px;
          transition: all 0.2s ease;
        }

        .model-item:hover {
          background: rgba(255, 255, 255, 0.08);
        }

        .model-item.hidden-model {
          opacity: 0.5;
        }

        .model-item.loading {
          background: rgba(59, 130, 246, 0.1);
          border: 1px dashed rgba(59, 130, 246, 0.3);
        }

        .model-color {
          width: 8px;
          height: 32px;
          border-radius: 4px;
          flex-shrink: 0;
        }

        .loading-spinner {
          width: 8px;
          height: 32px;
          border-radius: 4px;
          background: linear-gradient(180deg, #3b82f6 0%, #1d4ed8 100%);
          animation: pulse 1.5s ease-in-out infinite;
        }

        @keyframes pulse {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 1; }
        }

        .model-info {
          flex: 1;
          min-width: 0;
        }

        .model-name {
          color: #e0e0e0;
          font-size: 13px;
          font-weight: 500;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .model-meta {
          color: #666;
          font-size: 11px;
          margin-top: 2px;
        }

        .model-actions {
          display: flex;
          gap: 4px;
        }

        .visibility-btn, .remove-btn {
          background: transparent;
          border: none;
          padding: 4px;
          cursor: pointer;
          border-radius: 4px;
          color: #666;
          transition: all 0.15s ease;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .visibility-btn:hover {
          background: rgba(255, 255, 255, 0.1);
          color: #fff;
        }

        .visibility-btn.hidden {
          color: #ef4444;
        }

        .remove-btn:hover {
          background: rgba(239, 68, 68, 0.2);
          color: #ef4444;
        }

        .add-model-zone {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          padding: 12px;
          border: 2px dashed rgba(255, 255, 255, 0.15);
          border-radius: 8px;
          cursor: pointer;
          color: #888;
          font-size: 13px;
          transition: all 0.2s ease;
        }

        .add-model-zone:hover:not(.disabled) {
          border-color: #3b82f6;
          background: rgba(59, 130, 246, 0.1);
          color: #60a5fa;
        }

        .add-model-zone.drag-over {
          border-color: #3b82f6;
          background: rgba(59, 130, 246, 0.15);
          color: #60a5fa;
        }

        .add-model-zone.disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      `}</style>
    </div>
  )
}
