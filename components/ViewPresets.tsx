'use client'

import type { NavigationManager } from '@/lib/navigation-manager'

interface ViewPreset {
  id: string
  name: string
  shortcut: string
  preset: 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'iso'
}

const PRESETS: ViewPreset[] = [
  { id: 'top', name: 'Top', shortcut: '1', preset: 'top' },
  { id: 'front', name: 'Front', shortcut: '2', preset: 'front' },
  { id: 'right', name: 'Left', shortcut: '3', preset: 'right' },
  { id: 'iso', name: '3D', shortcut: '4', preset: 'iso' },
]

interface ViewPresetsProps {
  navigationManager: NavigationManager | null
  onPresetSelect?: (preset: ViewPreset['preset']) => void
}

export default function ViewPresets({ navigationManager, onPresetSelect }: ViewPresetsProps) {
  const handlePresetClick = (preset: ViewPreset['preset']) => {
    if (navigationManager) {
      navigationManager.setViewPreset(preset)
    }
    if (onPresetSelect) {
      onPresetSelect(preset)
    }
  }

  const buttonStyle = {
    padding: '6px 10px',
    border: '1px solid #555',
    borderRadius: '3px',
    backgroundColor: '#2a2a2a',
    color: '#e0e0e0',
    cursor: 'pointer',
    fontSize: '12px',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontWeight: 500 as const,
    transition: 'all 0.15s ease',
  }

  return (
    <div
      className="view-presets"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '10px',
        backgroundColor: 'rgba(32, 32, 32, 0.95)',
        border: '1px solid #444',
        borderRadius: '6px',
        boxShadow: '0 2px 12px rgba(0,0,0,0.3)',
        width: '140px',
      }}
    >
      <span style={{ fontSize: '11px', color: '#888', marginBottom: '2px' }}>Views</span>
      {PRESETS.map((preset) => (
        <button
          key={preset.id}
          onClick={() => handlePresetClick(preset.preset)}
          title={`${preset.name} [${preset.shortcut}]`}
          style={buttonStyle}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = '#3a3a3a'
            e.currentTarget.style.borderColor = '#666'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = '#2a2a2a'
            e.currentTarget.style.borderColor = '#555'
          }}
        >
          {preset.name}
        </button>
      ))}
    </div>
  )
}

