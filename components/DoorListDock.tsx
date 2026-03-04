'use client'

import type { CSSProperties, RefObject } from 'react'
import type { DoorContext } from '@/lib/door-analyzer'

type SortField = 'door' | 'type' | 'storey'
type ViewKind = 'front' | 'back' | 'plan'

export type DoorListDockProps = {
  // data
  doors: DoorContext[]
  selectedDoorIds: Set<string>
  hoveredDoorId: string | null

  // behaviors
  getDoorLabel: (door: DoorContext) => string
  onToggleSelect: (doorId: string) => void
  onDoorClick: (door: DoorContext) => void
  onHoverDoorId: (doorId: string | null) => void
  onShowSingleDoor: (door: DoorContext, view: ViewKind) => void

  // sorting UI
  sortIndicator: (field: SortField) => string
  onToggleSort: (field: SortField) => void

  // empty state actions (optional)
  hasActiveFilters?: boolean
  onClearFilters?: () => void

  // layout / limits
  maxItems?: number

  // docking (optional)
  dock?: boolean
  dockHeightPx?: number
  dockRightOffsetPx?: number // should match right sidebar width (e.g. 400)
  listContainerRef?: RefObject<HTMLDivElement | null>
}

export default function DoorListDock({
  doors,
  selectedDoorIds,
  hoveredDoorId,
  getDoorLabel,
  onToggleSelect,
  onDoorClick,
  onHoverDoorId,
  onShowSingleDoor,
  sortIndicator,
  onToggleSort,
  hasActiveFilters,
  onClearFilters,
  maxItems = 100,
  dock = false,
  dockHeightPx = 260,
  dockRightOffsetPx = 400,
  listContainerRef,
}: DoorListDockProps) {
  const visibleDoors = doors.slice(0, maxItems)
  const remaining = Math.max(0, doors.length - visibleDoors.length)

  return (
    <div
      className={dock ? 'door-list dock' : 'door-list'}
      style={
        dock
          ? ({
              height: `${dockHeightPx}px`,
              right: `${dockRightOffsetPx}px`,
            } as CSSProperties)
          : undefined
      }
      ref={listContainerRef as any}
    >
      {doors.length === 0 ? (
        <div className="empty-state">
          <p>No doors match your filters</p>
          {hasActiveFilters && onClearFilters && (
            <button className="text-button" onClick={onClearFilters}>
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="door-list-header">
            <span />
            <button className="list-header-button" onClick={() => onToggleSort('door')}>
              <span className="label-text">Door</span>
              <span className="sort-indicator">{sortIndicator('door')}</span>
            </button>
            <button className="list-header-button" onClick={() => onToggleSort('type')}>
              <span className="label-text">Type</span>
              <span className="sort-indicator">{sortIndicator('type')}</span>
            </button>
            <button className="list-header-button" onClick={() => onToggleSort('storey')}>
              <span className="label-text">Storey</span>
              <span className="sort-indicator">{sortIndicator('storey')}</span>
            </button>
            <span>Views</span>
          </div>

          {visibleDoors.map((door) => (
            <div
              key={door.doorId}
              className={`door-row ${selectedDoorIds.has(door.doorId) ? 'selected' : ''} ${hoveredDoorId === door.doorId ? 'hovered' : ''}`}
              onMouseEnter={() => onHoverDoorId(door.doorId)}
              onMouseLeave={() => onHoverDoorId(null)}
            >
              <label className="door-checkbox">
                <input
                  type="checkbox"
                  checked={selectedDoorIds.has(door.doorId)}
                  onChange={() => onToggleSelect(door.doorId)}
                />
                <span className="checkmark" />
              </label>

              <button className="door-name" onClick={() => onDoorClick(door)} title={getDoorLabel(door)}>
                {getDoorLabel(door)}
              </button>

              <div className="door-cell muted" title={door.doorTypeName || ''}>
                {door.doorTypeName || '—'}
              </div>

              <div className="door-cell muted" title={door.storeyName || ''}>
                {door.storeyName || '—'}
              </div>

              <div className="door-actions">
                <button className="action-button compact" onClick={() => onShowSingleDoor(door, 'front')} title="Front view">
                  F
                </button>
                <button className="action-button compact" onClick={() => onShowSingleDoor(door, 'back')} title="Back view">
                  B
                </button>
                <button className="action-button compact" onClick={() => onShowSingleDoor(door, 'plan')} title="Plan view">
                  P
                </button>
              </div>
            </div>
          ))}

          {remaining > 0 && <div className="more-items">+{remaining} more doors</div>}
        </>
      )}

      <style jsx>{`
        .door-list {
          flex: 1;
          overflow-y: auto;
          padding: 0;
        }

        /* Bottom overlay mode */
        .door-list.dock {
          position: fixed;
          left: 0;
          bottom: 0;
          /* right & height injected via style prop */
          background: #2a2a2a;
          border-top: 1px solid #333;
          box-shadow: 0 -12px 30px rgba(0, 0, 0, 0.4);
          z-index: 1200;
        }

        .empty-state {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 32px;
          color: #666;
          gap: 12px;
        }

        .door-list-header {
          display: grid;
          grid-template-columns: 24px minmax(0, 1fr) minmax(0, 88px) minmax(0, 68px) 110px;
          gap: 8px;
          padding: 8px 12px;
          background: #1d1d1d;
          border-bottom: 1px solid #303030;
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          color: #7d7d7d;
          position: sticky;
          top: 0;
          z-index: 5;
        }

        .door-list-header > span:last-child {
          text-align: center;
        }

        .list-header-button {
          display: flex;
          align-items: center;
          justify-content: space-between;
          width: 100%;
          min-width: 0;
          background: none;
          border: none;
          color: inherit;
          cursor: pointer;
          padding: 0;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          font-size: inherit;
          font-weight: 600;
          text-align: left;
          overflow: hidden;
        }

        .list-header-button:hover {
          color: #cbd5e1;
        }

        .list-header-button .label-text {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .sort-indicator {
          font-size: 10px;
          line-height: 1;
          color: #94a3b8;
          flex-shrink: 0;
          margin-left: 4px;
        }

        .door-row {
          display: grid;
          grid-template-columns: 24px minmax(0, 1fr) minmax(0, 88px) minmax(0, 68px) 110px;
          gap: 8px;
          align-items: center;
          min-height: 36px;
          padding: 5px 12px;
          border-bottom: 1px solid #2c2c2c;
          transition: background 0.15s ease;
        }

        .door-row:hover,
        .door-row.hovered {
          background: #242424;
        }

        .door-row.selected {
          background: rgba(37, 99, 235, 0.14);
        }

        .door-checkbox {
          position: relative;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }

        .door-checkbox input {
          width: 16px;
          height: 16px;
          opacity: 0;
          position: absolute;
          cursor: pointer;
        }

        .door-checkbox .checkmark {
          width: 14px;
          height: 14px;
          border: 1px solid #606060;
          border-radius: 4px;
          background: #1a1a1a;
          transition: all 0.15s ease;
          position: relative;
          display: inline-block;
        }

        .door-checkbox input:checked + .checkmark {
          background: #2563eb;
          border-color: #2563eb;
        }

        .door-checkbox input:checked + .checkmark::after {
          content: '';
          position: absolute;
          left: 50%;
          top: 48%;
          width: 4px;
          height: 7px;
          border: solid #fff;
          border-width: 0 2px 2px 0;
          transform: translate(-50%, -50%) rotate(45deg);
        }

        .door-name {
          border: none;
          background: none;
          color: #f3f4f6;
          text-align: left;
          font-size: 12px;
          font-weight: 500;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          cursor: pointer;
          padding: 0;
        }

        .door-name:hover {
          color: #93c5fd;
        }

        .door-cell {
          font-size: 11px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .door-cell.muted {
          color: #9ca3af;
        }

        .door-actions {
            display: grid;
            grid-auto-flow: column;
            grid-auto-columns: 20px;
            align-items: center;
            justify-content: center;
            gap: 4px;
            }

        .action-button {
          width: 20px;
          height: 20px;
          border: 1px solid #4b5563;
          background: #2d2d2d;
          border-radius: 5px;
          color: #d1d5db;
          font-size: 9px;
          font-weight: 700;
          line-height: 1;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: all 0.15s ease;
          padding: 0;
        }

        .action-button:hover {
          background: #374151;
          border-color: #6b7280;
          color: #fff;
        }

        .action-button.compact {
          min-width: 20px;
        }

        .more-items {
          text-align: center;
          padding: 12px;
          color: #666;
          font-size: 12px;
        }

        .text-button {
          background: #262626;
          border: 1px solid #3c3c3c;
          color: #d1d5db;
          font-size: 11px;
          border-radius: 999px;
          cursor: pointer;
          padding: 4px 10px;
        }

        .text-button:hover {
          background: #333;
          color: #fff;
        }
      `}</style>
    </div>
  )
}