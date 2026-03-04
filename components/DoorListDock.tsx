'use client'

import { useCallback, useEffect, useMemo, useState, useRef } from 'react'
import type { CSSProperties, RefObject } from 'react'
import type { DoorContext } from '@/lib/door-analyzer'

type SortField = 'door' | 'type' | 'storey' | 'brandschutz' | 'schallschutz' | 'lb' | 'lh' | 'rb' | 'rh' | 'bram' | 'hram' | 'guid'
type ViewKind = 'front' | 'back' | 'plan'

type ColKey = 'check' | 'door' | 'type' | 'storey' | 'brandschutz' | 'schallschutz' | 'lb' | 'lh' | 'rb' | 'rh' | 'bram' | 'hram' | 'views' | 'guid'
type StringSet = Set<string>

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  )
}

function FilterIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
    </svg>
  )
}

type ExcludeDropdownFilter = 'type' | 'storey' | 'brandschutz' | 'schallschutz'

function filterDoorsWithExclude(
  doors: DoorContext[],
  opts: {
    doorFilter: string
    typeFilterSet: Set<string>
    storeyFilterSet: Set<string>
    brandschutzFilterSet: Set<string>
    schallschutzFilterSet: Set<string>
    lbFilter: string
    lhFilter: string
    rbFilter: string
    rhFilter: string
    bramFilter: string
    hramFilter: string
    guidFilter: string
    exclude?: ExcludeDropdownFilter
    getDoorLabel: (d: DoorContext) => string
    formatNum: (n: number | null | undefined) => string
  }
): DoorContext[] {
  const d = opts.doorFilter.trim().toLowerCase()
  const lb = opts.lbFilter.trim().toLowerCase()
  const lh = opts.lhFilter.trim().toLowerCase()
  const rb = opts.rbFilter.trim().toLowerCase()
  const rh = opts.rhFilter.trim().toLowerCase()
  const bram = opts.bramFilter.trim().toLowerCase()
  const hram = opts.hramFilter.trim().toLowerCase()
  const g = opts.guidFilter.trim().toLowerCase()

  return doors.filter(door => {
    if (d) {
      const label = opts.getDoorLabel(door).toLowerCase()
      if (!label.includes(d)) return false
    }
    if (opts.exclude !== 'type' && opts.typeFilterSet.size > 0) {
      const type = door.csetStandardCH?.geometryType || '—'
      if (!opts.typeFilterSet.has(type)) return false
    }
    if (opts.exclude !== 'storey' && opts.storeyFilterSet.size > 0) {
      const storey = door.storeyName || '—'
      if (!opts.storeyFilterSet.has(storey)) return false
    }
    if (opts.exclude !== 'brandschutz' && opts.brandschutzFilterSet.size > 0) {
      const brand = door.csetStandardCH?.feuerwiderstand || '—'
      if (!opts.brandschutzFilterSet.has(brand)) return false
    }
    if (opts.exclude !== 'schallschutz' && opts.schallschutzFilterSet.size > 0) {
      const schall = door.csetStandardCH?.bauschalldaemmmass || '—'
      if (!opts.schallschutzFilterSet.has(schall)) return false
    }
    if (lb) {
      const val = opts.formatNum(door.csetStandardCH?.massDurchgangsbreite).toLowerCase()
      if (!val.includes(lb)) return false
    }
    if (lh) {
      const val = opts.formatNum(door.csetStandardCH?.massDurchgangshoehe).toLowerCase()
      if (!val.includes(lh)) return false
    }
    if (rb) {
      const val = opts.formatNum(door.csetStandardCH?.massRohbreite).toLowerCase()
      if (!val.includes(rb)) return false
    }
    if (rh) {
      const val = opts.formatNum(door.csetStandardCH?.massRohhoehe).toLowerCase()
      if (!val.includes(rh)) return false
    }
    if (bram) {
      const val = opts.formatNum(door.csetStandardCH?.massAussenrahmenBreite).toLowerCase()
      if (!val.includes(bram)) return false
    }
    if (hram) {
      const val = opts.formatNum(door.csetStandardCH?.massAussenrahmenHoehe).toLowerCase()
      if (!val.includes(hram)) return false
    }
    if (g) {
      const guid = ((door.door.globalId ?? door.doorId) || '').toLowerCase()
      if (!guid.includes(g)) return false
    }
    return true
  })
}

const COLS: Array<{ key: ColKey; min: number; initial: number }> = [
  { key: 'check', min: 24, initial: 24 },
  { key: 'door', min: 140, initial: 260 },
  { key: 'type', min: 110, initial: 140 },
  { key: 'storey', min: 90, initial: 110 },
  { key: 'brandschutz', min: 90, initial: 110 },
  { key: 'schallschutz', min: 90, initial: 110 },
  { key: 'lb', min: 56, initial: 72 },
  { key: 'lh', min: 56, initial: 72 },
  { key: 'rb', min: 56, initial: 72 },
  { key: 'rh', min: 56, initial: 72 },
  { key: 'bram', min: 60, initial: 80 },
  { key: 'hram', min: 60, initial: 80 },
  { key: 'views', min: 90, initial: 100 },
  { key: 'guid', min: 160, initial: 220 },
]

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
  onSetSort: (field: SortField, direction: 'asc' | 'desc') => void

  // empty state actions (optional)
  hasActiveFilters?: boolean
  onClearFilters?: () => void

  // sync storey filter to 3D model visibility
  onStoreyFilterChange?: (storeyNames: Set<string>) => void

  // layout / limits
  maxItems?: number

  // docking (optional)
  dock?: boolean
  dockHeightPx?: number
  dockRightOffsetPx?: number // should match right sidebar width (e.g. 400)
  onDockHeightChange?: (heightPx: number) => void
  minDockHeightPx?: number
  maxDockHeightPx?: number
  listContainerRef?: RefObject<HTMLDivElement | null>
  scrollToDoorId?: string | null
  onScrollToDoorHandled?: () => void
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
  onSetSort,
  hasActiveFilters,
  onClearFilters,
  onStoreyFilterChange,
  maxItems = 2000,
  dock = false,
  dockHeightPx = 260,
  dockRightOffsetPx = 400,
  onDockHeightChange,
  minDockHeightPx = 120,
  maxDockHeightPx = 600,
  listContainerRef,
  scrollToDoorId,
  onScrollToDoorHandled,
}: DoorListDockProps) {
   const [doorFilter, setDoorFilter] = useState('')
   const [typeFilterSet, setTypeFilterSet] = useState<Set<string>>(new Set())
   const [storeyFilterSet, setStoreyFilterSet] = useState<Set<string>>(new Set())
   const [brandschutzFilterSet, setBrandschutzFilterSet] = useState<Set<string>>(new Set())
   const [schallschutzFilterSet, setSchallschutzFilterSet] = useState<Set<string>>(new Set())
   const [lbFilter, setLbFilter] = useState('')
   const [lhFilter, setLhFilter] = useState('')
   const [rbFilter, setRbFilter] = useState('')
   const [rhFilter, setRhFilter] = useState('')
   const [bramFilter, setBramFilter] = useState('')
   const [hramFilter, setHramFilter] = useState('')
   const [guidFilter, setGuidFilter] = useState('')

   const [colWidths, setColWidths] = useState<Record<ColKey, number>>(() => {
     const init = {} as Record<ColKey, number>
     for (const c of COLS) init[c.key] = c.initial
     return init
   })

   const gridTemplate = useMemo(
     () => COLS.map(c => `${Math.max(c.min, colWidths[c.key])}px`).join(' '),
     [colWidths]
   )

   const totalWidth = useMemo(
     () => COLS.reduce((sum, c) => sum + Math.max(c.min, colWidths[c.key]), 0),
     [colWidths]
   )

   const resizingRef = useRef<{ key: ColKey; startX: number; startWidth: number } | null>(null)
   const scrollContainerRef = useRef<HTMLDivElement | null>(null)

   const onResizeMove = useCallback((e: MouseEvent) => {
     const r = resizingRef.current
     if (!r) return
     const col = COLS.find(c => c.key === r.key)!
     const delta = e.clientX - r.startX
     const next = Math.max(col.min, r.startWidth + delta)
     setColWidths(prev => ({ ...prev, [r.key]: next }))
   }, [])

   const onResizeEnd = useCallback(() => {
     resizingRef.current = null
     window.removeEventListener('mousemove', onResizeMove)
     window.removeEventListener('mouseup', onResizeEnd)
     document.body.classList.remove('col-resizing')
   }, [])

   const onResizeStart = useCallback((key: ColKey, e: React.MouseEvent) => {
     e.preventDefault()
     e.stopPropagation()
     const startWidth = colWidths[key]
     resizingRef.current = { key, startX: e.clientX, startWidth }
     document.body.classList.add('col-resizing')
     window.addEventListener('mousemove', onResizeMove)
     window.addEventListener('mouseup', onResizeEnd)
   }, [colWidths, onResizeMove, onResizeEnd])

   const heightResizeRef = useRef<{ startY: number; startHeight: number } | null>(null)

   const onHeightResizeMove = useCallback(
     (e: MouseEvent) => {
       const r = heightResizeRef.current
       if (!r || !onDockHeightChange) return
       const deltaY = e.clientY - r.startY
       const next = Math.min(maxDockHeightPx, Math.max(minDockHeightPx, r.startHeight - deltaY))
       onDockHeightChange(next)
     },
     [onDockHeightChange, minDockHeightPx, maxDockHeightPx]
   )

   const onHeightResizeEnd = useCallback(() => {
     heightResizeRef.current = null
     window.removeEventListener('mousemove', onHeightResizeMove)
     window.removeEventListener('mouseup', onHeightResizeEnd)
     document.body.classList.remove('dock-height-resizing')
   }, [onHeightResizeMove])

   const onHeightResizeStart = useCallback(
     (e: React.MouseEvent) => {
       e.preventDefault()
       e.stopPropagation()
       if (!onDockHeightChange) return
       heightResizeRef.current = { startY: e.clientY, startHeight: dockHeightPx }
       document.body.classList.add('dock-height-resizing')
       window.addEventListener('mousemove', onHeightResizeMove)
       window.addEventListener('mouseup', onHeightResizeEnd)
     },
     [onDockHeightChange, dockHeightPx, onHeightResizeMove, onHeightResizeEnd]
   )

   const formatNum = useCallback((n: number | null | undefined) =>
     n != null && Number.isFinite(n) ? String(n) : '—', [])

   const filterOpts = useMemo(
     () => ({
       doorFilter,
       typeFilterSet,
       storeyFilterSet,
       brandschutzFilterSet,
       schallschutzFilterSet,
       lbFilter,
       lhFilter,
       rbFilter,
       rhFilter,
       bramFilter,
       hramFilter,
       guidFilter,
       getDoorLabel,
       formatNum,
     }),
     [doorFilter, typeFilterSet, storeyFilterSet, brandschutzFilterSet, schallschutzFilterSet, lbFilter, lhFilter, rbFilter, rhFilter, bramFilter, hramFilter, guidFilter, getDoorLabel, formatNum]
   )

   const filteredDoors = useMemo(
     () => filterDoorsWithExclude(doors, filterOpts),
     [doors, filterOpts]
   )

   const doorsForTypeOptions = useMemo(
     () => filterDoorsWithExclude(doors, { ...filterOpts, exclude: 'type' }),
     [doors, filterOpts]
   )
   const doorsForStoreyOptions = useMemo(
     () => filterDoorsWithExclude(doors, { ...filterOpts, exclude: 'storey' }),
     [doors, filterOpts]
   )
   const doorsForBrandschutzOptions = useMemo(
     () => filterDoorsWithExclude(doors, { ...filterOpts, exclude: 'brandschutz' }),
     [doors, filterOpts]
   )
   const doorsForSchallschutzOptions = useMemo(
     () => filterDoorsWithExclude(doors, { ...filterOpts, exclude: 'schallschutz' }),
     [doors, filterOpts]
   )

   const visibleDoors = filteredDoors.slice(0, maxItems)
   const remaining = Math.max(0, filteredDoors.length - visibleDoors.length)

   const clearLocalFilters = () => {
     setDoorFilter('')
     setTypeFilterSet(new Set())
     setStoreyFilterSet(new Set())
     setBrandschutzFilterSet(new Set())
     setSchallschutzFilterSet(new Set())
     setLbFilter('')
     setLhFilter('')
     setRbFilter('')
     setRhFilter('')
     setBramFilter('')
     setHramFilter('')
     setGuidFilter('')
   }

   const hasLocalFilters = doorFilter || typeFilterSet.size > 0 || storeyFilterSet.size > 0 || brandschutzFilterSet.size > 0 || schallschutzFilterSet.size > 0 || lbFilter || lhFilter || rbFilter || rhFilter || bramFilter || hramFilter || guidFilter

   const uniqueTypeValues = useMemo(() => {
     const s = new Set<string>()
     doorsForTypeOptions.forEach(d => {
       s.add(d.csetStandardCH?.geometryType || '—')
     })
     typeFilterSet.forEach(v => s.add(v))
     return Array.from(s).sort()
   }, [doorsForTypeOptions, typeFilterSet])

   const uniqueStoreyValues = useMemo(() => {
     const s = new Set<string>()
     doorsForStoreyOptions.forEach(d => {
       s.add(d.storeyName || '—')
     })
     storeyFilterSet.forEach(v => s.add(v))
     return Array.from(s).sort()
   }, [doorsForStoreyOptions, storeyFilterSet])

   const uniqueBrandschutzValues = useMemo(() => {
     const s = new Set<string>()
     doorsForBrandschutzOptions.forEach(d => {
       s.add(d.csetStandardCH?.feuerwiderstand || '—')
     })
     brandschutzFilterSet.forEach(v => s.add(v))
     return Array.from(s).sort()
   }, [doorsForBrandschutzOptions, brandschutzFilterSet])

   const uniqueSchallschutzValues = useMemo(() => {
     const s = new Set<string>()
     doorsForSchallschutzOptions.forEach(d => {
       s.add(d.csetStandardCH?.bauschalldaemmmass || '—')
     })
     schallschutzFilterSet.forEach(v => s.add(v))
     return Array.from(s).sort()
   }, [doorsForSchallschutzOptions, schallschutzFilterSet])

   type DropdownCol = SortField
   const [dropdownOpenKey, setDropdownOpenKey] = useState<DropdownCol | null>(null)
   const dropdownRef = useRef<HTMLDivElement>(null)
   const headerCheckboxRef = useRef<HTMLInputElement>(null)

   const allVisibleSelected = visibleDoors.length > 0 && visibleDoors.every(d => selectedDoorIds.has(d.doorId))
   const someVisibleSelected = visibleDoors.some(d => selectedDoorIds.has(d.doorId))

   const onHeaderCheckboxChange = useCallback(() => {
     if (allVisibleSelected) {
       visibleDoors.forEach(d => onToggleSelect(d.doorId))
     } else {
       visibleDoors.forEach(d => {
         if (!selectedDoorIds.has(d.doorId)) onToggleSelect(d.doorId)
       })
     }
   }, [allVisibleSelected, visibleDoors, selectedDoorIds, onToggleSelect])

   useEffect(() => {
     const el = headerCheckboxRef.current
     if (el) el.indeterminate = someVisibleSelected && !allVisibleSelected
   }, [someVisibleSelected, allVisibleSelected])

   useEffect(() => {
     const visibleIds = new Set(filteredDoors.map(d => d.doorId))
     selectedDoorIds.forEach(id => {
       if (!visibleIds.has(id)) onToggleSelect(id)
     })
   }, [filteredDoors, selectedDoorIds, onToggleSelect])

   useEffect(() => {
     if (!scrollToDoorId || !onScrollToDoorHandled) return
     const el = scrollContainerRef.current?.querySelector(`[data-door-id="${scrollToDoorId}"]`)
     el?.scrollIntoView({ block: 'nearest', behavior: 'auto' })
     onScrollToDoorHandled()
   }, [scrollToDoorId, onScrollToDoorHandled])

   useEffect(() => {
     onStoreyFilterChange?.(storeyFilterSet)
   }, [storeyFilterSet, onStoreyFilterChange])

   useEffect(() => {
     if (!dropdownOpenKey) return
     const onOutside = (e: MouseEvent) => {
       if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
         setDropdownOpenKey(null)
       }
     }
     const onEscape = (e: KeyboardEvent) => {
       if (e.key === 'Escape') setDropdownOpenKey(null)
     }
     document.addEventListener('mousedown', onOutside)
     document.addEventListener('keydown', onEscape)
     return () => {
       document.removeEventListener('mousedown', onOutside)
       document.removeEventListener('keydown', onEscape)
     }
   }, [dropdownOpenKey])

   const toggleDropdownValue = useCallback(
     (key: 'type' | 'storey' | 'brandschutz' | 'schallschutz', value: string, setter: (fn: (p: StringSet) => StringSet) => void) => {
       setter(prev => {
         const next = new Set(prev)
         if (next.has(value)) next.delete(value)
         else next.add(value)
         return next
       })
     },
     []
   )

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
      ref={(el) => {
        scrollContainerRef.current = el
        if (listContainerRef) (listContainerRef as any).current = el
      }}
    >
      <div className="door-list-scroll-area">
        {dock && onDockHeightChange && (
          <div
            className="dock-resize-handle"
            onMouseDown={onHeightResizeStart}
            title="Höhe anpassen"
          />
        )}
        {filteredDoors.length === 0 ? (
        <div className="empty-state">
          <p>No doors match your filters</p>
          {hasLocalFilters && (
            <button className="text-button" onClick={clearLocalFilters}>
              Clear filters
            </button>
          )}
          {hasActiveFilters && onClearFilters && !hasLocalFilters && (
            <button className="text-button" onClick={onClearFilters}>
              Clear parent filters
            </button>
          )}
        </div>
      ) : (
        <div className="door-list-scroll" style={{ minWidth: totalWidth }}>
          <div className="door-list-header" style={{ gridTemplateColumns: gridTemplate }}>
            <div className="header-col header-col-checkbox">
              <div className="header-row">
                <label className="door-checkbox">
                  <input
                    ref={headerCheckboxRef}
                    type="checkbox"
                    checked={allVisibleSelected}
                    disabled={visibleDoors.length === 0}
                    onChange={onHeaderCheckboxChange}
                  />
                  <span className="checkmark" />
                </label>
              </div>
            </div>

            <div className="header-col header-resizable" ref={dropdownOpenKey === 'door' ? dropdownRef : undefined}>
              <div className="header-row">
                <button className="list-header-button" onClick={() => setDropdownOpenKey(k => k === 'door' ? null : 'door')}>
                  <span className="header-label-wrap">
                    {doorFilter.trim() !== '' && (
                      <span className="header-filter-icon" title="Filter aktiv">
                        <FilterIcon />
                      </span>
                    )}
                    <span className="label-text">Türnummer</span>
                  </span>
                </button>
              </div>
              {dropdownOpenKey === 'door' && (
                <div className="header-dropdown">
                  <input className="header-filter" placeholder="Suchen…" value={doorFilter} onChange={(e) => setDoorFilter(e.target.value)} autoFocus />
                  <div className="header-sort-buttons">
                    <button type="button" className="header-sort-btn" onClick={() => onSetSort('door', 'asc')} title="Aufsteigend">↑</button>
                    <button type="button" className="header-sort-btn" onClick={() => onSetSort('door', 'desc')} title="Absteigend">↓</button>
                  </div>
                </div>
              )}
              <div className="col-resizer" onMouseDown={(e) => onResizeStart('door', e)} />
            </div>

            <div className="header-col header-resizable" ref={dropdownOpenKey === 'type' ? dropdownRef : undefined}>
              <div className="header-row">
                <button className="list-header-button" onClick={() => setDropdownOpenKey(k => k === 'type' ? null : 'type')}>
                  <span className="header-label-wrap">
                    {typeFilterSet.size > 0 && (
                      <span className="header-filter-icon" title="Filter aktiv">
                        <FilterIcon />
                      </span>
                    )}
                    <span className="label-text">Geometrietyp</span>
                  </span>
                </button>
              </div>
              {dropdownOpenKey === 'type' && (
                <div className="header-dropdown">
                  {uniqueTypeValues.map(v => (
                    <label key={v} className="header-dropdown-item">
                      <input type="checkbox" checked={typeFilterSet.has(v)} onChange={() => toggleDropdownValue('type', v, setTypeFilterSet)} />
                      <span>{v}</span>
                    </label>
                  ))}
                  <div className="header-sort-buttons">
                    <button type="button" className="header-sort-btn" onClick={() => onSetSort('type', 'asc')} title="Aufsteigend">↑</button>
                    <button type="button" className="header-sort-btn" onClick={() => onSetSort('type', 'desc')} title="Absteigend">↓</button>
                  </div>
                </div>
              )}
              <div className="col-resizer" onMouseDown={(e) => onResizeStart('type', e)} />
            </div>

            <div className="header-col header-resizable" ref={dropdownOpenKey === 'storey' ? dropdownRef : undefined}>
              <div className="header-row">
                <button className="list-header-button" onClick={() => setDropdownOpenKey(k => k === 'storey' ? null : 'storey')}>
                  <span className="header-label-wrap">
                    {storeyFilterSet.size > 0 && (
                      <span className="header-filter-icon" title="Filter aktiv">
                        <FilterIcon />
                      </span>
                    )}
                    <span className="label-text">Geschoss</span>
                  </span>
                </button>
              </div>
              {dropdownOpenKey === 'storey' && (
                <div className="header-dropdown">
                  {uniqueStoreyValues.map(v => (
                    <label key={v} className="header-dropdown-item">
                      <input type="checkbox" checked={storeyFilterSet.size === 0 || storeyFilterSet.has(v)} onChange={() => toggleDropdownValue('storey', v, setStoreyFilterSet)} />
                      <span>{v}</span>
                    </label>
                  ))}
                  <div className="header-sort-buttons">
                    <button type="button" className="header-sort-btn" onClick={() => onSetSort('storey', 'asc')} title="Aufsteigend">↑</button>
                    <button type="button" className="header-sort-btn" onClick={() => onSetSort('storey', 'desc')} title="Absteigend">↓</button>
                  </div>
                </div>
              )}
              <div className="col-resizer" onMouseDown={(e) => onResizeStart('storey', e)} />
            </div>

            <div className="header-col header-resizable" ref={dropdownOpenKey === 'brandschutz' ? dropdownRef : undefined}>
              <div className="header-row">
                <button className="list-header-button" onClick={() => setDropdownOpenKey(k => k === 'brandschutz' ? null : 'brandschutz')}>
                  <span className="header-label-wrap">
                    {brandschutzFilterSet.size > 0 && (
                      <span className="header-filter-icon" title="Filter aktiv">
                        <FilterIcon />
                      </span>
                    )}
                    <span className="label-text">Brandschutz</span>
                  </span>
                </button>
              </div>
              {dropdownOpenKey === 'brandschutz' && (
                <div className="header-dropdown">
                  {uniqueBrandschutzValues.map(v => (
                    <label key={v} className="header-dropdown-item">
                      <input type="checkbox" checked={brandschutzFilterSet.has(v)} onChange={() => toggleDropdownValue('brandschutz', v, setBrandschutzFilterSet)} />
                      <span>{v}</span>
                    </label>
                  ))}
                  <div className="header-sort-buttons">
                    <button type="button" className="header-sort-btn" onClick={() => onSetSort('brandschutz', 'asc')} title="Aufsteigend">↑</button>
                    <button type="button" className="header-sort-btn" onClick={() => onSetSort('brandschutz', 'desc')} title="Absteigend">↓</button>
                  </div>
                </div>
              )}
              <div className="col-resizer" onMouseDown={(e) => onResizeStart('brandschutz', e)} />
            </div>

            <div className="header-col header-resizable" ref={dropdownOpenKey === 'schallschutz' ? dropdownRef : undefined}>
              <div className="header-row">
                <button className="list-header-button" onClick={() => setDropdownOpenKey(k => k === 'schallschutz' ? null : 'schallschutz')}>
                  <span className="header-label-wrap">
                    {schallschutzFilterSet.size > 0 && (
                      <span className="header-filter-icon" title="Filter aktiv">
                        <FilterIcon />
                      </span>
                    )}
                    <span className="label-text">Schallschutz</span>
                  </span>
                </button>
              </div>
              {dropdownOpenKey === 'schallschutz' && (
                <div className="header-dropdown">
                  {uniqueSchallschutzValues.map(v => (
                    <label key={v} className="header-dropdown-item">
                      <input type="checkbox" checked={schallschutzFilterSet.has(v)} onChange={() => toggleDropdownValue('schallschutz', v, setSchallschutzFilterSet)} />
                      <span>{v}</span>
                    </label>
                  ))}
                  <div className="header-sort-buttons">
                    <button type="button" className="header-sort-btn" onClick={() => onSetSort('schallschutz', 'asc')} title="Aufsteigend">↑</button>
                    <button type="button" className="header-sort-btn" onClick={() => onSetSort('schallschutz', 'desc')} title="Absteigend">↓</button>
                  </div>
                </div>
              )}
              <div className="col-resizer" onMouseDown={(e) => onResizeStart('schallschutz', e)} />
            </div>

            <div className="header-col header-resizable header-col-numeric" ref={dropdownOpenKey === 'lb' ? dropdownRef : undefined}>
              <div className="header-row">
                <button className="list-header-button" onClick={() => setDropdownOpenKey(k => k === 'lb' ? null : 'lb')}>
                  <span className="header-label-wrap">
                    {lbFilter.trim() !== '' && (
                      <span className="header-filter-icon" title="Filter aktiv">
                        <FilterIcon />
                      </span>
                    )}
                    <span className="label-text">LB</span>
                  </span>
                </button>
              </div>
              {dropdownOpenKey === 'lb' && (
                <div className="header-dropdown">
                  <input className="header-filter" placeholder="Suchen…" value={lbFilter} onChange={(e) => setLbFilter(e.target.value)} autoFocus />
                  <div className="header-sort-buttons">
                    <button type="button" className="header-sort-btn" onClick={() => onSetSort('lb', 'asc')} title="Aufsteigend">↑</button>
                    <button type="button" className="header-sort-btn" onClick={() => onSetSort('lb', 'desc')} title="Absteigend">↓</button>
                  </div>
                </div>
              )}
              <div className="col-resizer" onMouseDown={(e) => onResizeStart('lb', e)} />
            </div>
            <div className="header-col header-resizable header-col-numeric" ref={dropdownOpenKey === 'lh' ? dropdownRef : undefined}>
              <div className="header-row">
                <button className="list-header-button" onClick={() => setDropdownOpenKey(k => k === 'lh' ? null : 'lh')}>
                  <span className="header-label-wrap">
                    {lhFilter.trim() !== '' && (
                      <span className="header-filter-icon" title="Filter aktiv">
                        <FilterIcon />
                      </span>
                    )}
                    <span className="label-text">LH</span>
                  </span>
                </button>
              </div>
              {dropdownOpenKey === 'lh' && (
                <div className="header-dropdown">
                  <input className="header-filter" placeholder="Suchen…" value={lhFilter} onChange={(e) => setLhFilter(e.target.value)} autoFocus />
                  <div className="header-sort-buttons">
                    <button type="button" className="header-sort-btn" onClick={() => onSetSort('lh', 'asc')} title="Aufsteigend">↑</button>
                    <button type="button" className="header-sort-btn" onClick={() => onSetSort('lh', 'desc')} title="Absteigend">↓</button>
                  </div>
                </div>
              )}
              <div className="col-resizer" onMouseDown={(e) => onResizeStart('lh', e)} />
            </div>
            <div className="header-col header-resizable header-col-numeric" ref={dropdownOpenKey === 'rb' ? dropdownRef : undefined}>
              <div className="header-row">
                <button className="list-header-button" onClick={() => setDropdownOpenKey(k => k === 'rb' ? null : 'rb')}>
                  <span className="header-label-wrap">
                    {rbFilter.trim() !== '' && (
                      <span className="header-filter-icon" title="Filter aktiv">
                        <FilterIcon />
                      </span>
                    )}
                    <span className="label-text">RB</span>
                  </span>
                </button>
              </div>
              {dropdownOpenKey === 'rb' && (
                <div className="header-dropdown">
                  <input className="header-filter" placeholder="Suchen…" value={rbFilter} onChange={(e) => setRbFilter(e.target.value)} autoFocus />
                  <div className="header-sort-buttons">
                    <button type="button" className="header-sort-btn" onClick={() => onSetSort('rb', 'asc')} title="Aufsteigend">↑</button>
                    <button type="button" className="header-sort-btn" onClick={() => onSetSort('rb', 'desc')} title="Absteigend">↓</button>
                  </div>
                </div>
              )}
              <div className="col-resizer" onMouseDown={(e) => onResizeStart('rb', e)} />
            </div>
            <div className="header-col header-resizable header-col-numeric" ref={dropdownOpenKey === 'rh' ? dropdownRef : undefined}>
              <div className="header-row">
                <button className="list-header-button" onClick={() => setDropdownOpenKey(k => k === 'rh' ? null : 'rh')}>
                  <span className="header-label-wrap">
                    {rhFilter.trim() !== '' && (
                      <span className="header-filter-icon" title="Filter aktiv">
                        <FilterIcon />
                      </span>
                    )}
                    <span className="label-text">RH</span>
                  </span>
                </button>
              </div>
              {dropdownOpenKey === 'rh' && (
                <div className="header-dropdown">
                  <input className="header-filter" placeholder="Suchen…" value={rhFilter} onChange={(e) => setRhFilter(e.target.value)} autoFocus />
                  <div className="header-sort-buttons">
                    <button type="button" className="header-sort-btn" onClick={() => onSetSort('rh', 'asc')} title="Aufsteigend">↑</button>
                    <button type="button" className="header-sort-btn" onClick={() => onSetSort('rh', 'desc')} title="Absteigend">↓</button>
                  </div>
                </div>
              )}
              <div className="col-resizer" onMouseDown={(e) => onResizeStart('rh', e)} />
            </div>
            <div className="header-col header-resizable header-col-numeric" ref={dropdownOpenKey === 'bram' ? dropdownRef : undefined}>
              <div className="header-row">
                <button className="list-header-button" onClick={() => setDropdownOpenKey(k => k === 'bram' ? null : 'bram')}>
                  <span className="header-label-wrap">
                    {bramFilter.trim() !== '' && (
                      <span className="header-filter-icon" title="Filter aktiv">
                        <FilterIcon />
                      </span>
                    )}
                    <span className="label-text">BRAM</span>
                  </span>
                </button>
              </div>
              {dropdownOpenKey === 'bram' && (
                <div className="header-dropdown">
                  <input className="header-filter" placeholder="Suchen…" value={bramFilter} onChange={(e) => setBramFilter(e.target.value)} autoFocus />
                  <div className="header-sort-buttons">
                    <button type="button" className="header-sort-btn" onClick={() => onSetSort('bram', 'asc')} title="Aufsteigend">↑</button>
                    <button type="button" className="header-sort-btn" onClick={() => onSetSort('bram', 'desc')} title="Absteigend">↓</button>
                  </div>
                </div>
              )}
              <div className="col-resizer" onMouseDown={(e) => onResizeStart('bram', e)} />
            </div>
            <div className="header-col header-resizable header-col-numeric" ref={dropdownOpenKey === 'hram' ? dropdownRef : undefined}>
              <div className="header-row">
                <button className="list-header-button" onClick={() => setDropdownOpenKey(k => k === 'hram' ? null : 'hram')}>
                  <span className="header-label-wrap">
                    {hramFilter.trim() !== '' && (
                      <span className="header-filter-icon" title="Filter aktiv">
                        <FilterIcon />
                      </span>
                    )}
                    <span className="label-text">HRAM</span>
                  </span>
                </button>
              </div>
              {dropdownOpenKey === 'hram' && (
                <div className="header-dropdown">
                  <input className="header-filter" placeholder="Suchen…" value={hramFilter} onChange={(e) => setHramFilter(e.target.value)} autoFocus />
                  <div className="header-sort-buttons">
                    <button type="button" className="header-sort-btn" onClick={() => onSetSort('hram', 'asc')} title="Aufsteigend">↑</button>
                    <button type="button" className="header-sort-btn" onClick={() => onSetSort('hram', 'desc')} title="Absteigend">↓</button>
                  </div>
                </div>
              )}
              <div className="col-resizer" onMouseDown={(e) => onResizeStart('hram', e)} />
            </div>

            <div className="header-col header-resizable view-col">
              <div className="header-row">
                <button disabled type="button" className="list-header-button" style={{ cursor: 'default', pointerEvents: 'none', opacity: 1 }}>
                  <span className="label-text">Ansicht</span>
                </button>
                <span className="header-search-toggle" style={{ visibility: 'hidden', pointerEvents: 'none' }} aria-hidden>
                  <SearchIcon />
                </span>
              </div>
              <div className="col-resizer" onMouseDown={(e) => onResizeStart('views', e)} />
            </div>

            <div className="header-col header-resizable" ref={dropdownOpenKey === 'guid' ? dropdownRef : undefined}>
              <div className="header-row">
                <button className="list-header-button" onClick={() => setDropdownOpenKey(k => k === 'guid' ? null : 'guid')}>
                  <span className="header-label-wrap">
                    {guidFilter.trim() !== '' && (
                      <span className="header-filter-icon" title="Filter aktiv">
                        <FilterIcon />
                      </span>
                    )}
                    <span className="label-text">GUID</span>
                  </span>
                </button>
              </div>
              {dropdownOpenKey === 'guid' && (
                <div className="header-dropdown">
                  <input className="header-filter" placeholder="Suchen…" value={guidFilter} onChange={(e) => setGuidFilter(e.target.value)} autoFocus />
                  <div className="header-sort-buttons">
                    <button type="button" className="header-sort-btn" onClick={() => onSetSort('guid', 'asc')} title="Aufsteigend">↑</button>
                    <button type="button" className="header-sort-btn" onClick={() => onSetSort('guid', 'desc')} title="Absteigend">↓</button>
                  </div>
                </div>
              )}
              <div className="col-resizer" onMouseDown={(e) => onResizeStart('guid', e)} />
            </div>
          </div>

          {visibleDoors.map((door) => (
            <div
              key={door.doorId}
              data-door-id={door.doorId}
              className={`door-row ${selectedDoorIds.has(door.doorId) ? 'selected' : ''} ${hoveredDoorId === door.doorId ? 'hovered' : ''}`}
              style={{ gridTemplateColumns: gridTemplate }}
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

              <div className="door-cell muted" title={door.csetStandardCH?.geometryType || ''}>
                {door.csetStandardCH?.geometryType || '—'}
              </div>

              <div className="door-cell muted" title={door.storeyName || ''}>
                {door.storeyName || '—'}
              </div>

              <div className="door-cell muted door-cell-text" title={door.csetStandardCH?.feuerwiderstand || ''}>
                {door.csetStandardCH?.feuerwiderstand || '—'}
              </div>
              <div className="door-cell muted door-cell-text" title={door.csetStandardCH?.bauschalldaemmmass || ''}>
                {door.csetStandardCH?.bauschalldaemmmass || '—'}
              </div>
              <div className="door-cell muted door-cell-numeric" title={formatNum(door.csetStandardCH?.massDurchgangsbreite)}>
                {formatNum(door.csetStandardCH?.massDurchgangsbreite)}
              </div>
              <div className="door-cell muted door-cell-numeric" title={formatNum(door.csetStandardCH?.massDurchgangshoehe)}>
                {formatNum(door.csetStandardCH?.massDurchgangshoehe)}
              </div>
              <div className="door-cell muted door-cell-numeric" title={formatNum(door.csetStandardCH?.massRohbreite)}>
                {formatNum(door.csetStandardCH?.massRohbreite)}
              </div>
              <div className="door-cell muted door-cell-numeric" title={formatNum(door.csetStandardCH?.massRohhoehe)}>
                {formatNum(door.csetStandardCH?.massRohhoehe)}
              </div>
              <div className="door-cell muted door-cell-numeric" title={formatNum(door.csetStandardCH?.massAussenrahmenBreite)}>
                {formatNum(door.csetStandardCH?.massAussenrahmenBreite)}
              </div>
              <div className="door-cell muted door-cell-numeric" title={formatNum(door.csetStandardCH?.massAussenrahmenHoehe)}>
                {formatNum(door.csetStandardCH?.massAussenrahmenHoehe)}
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

              <div className="door-cell muted door-cell-guid" title={door.door.globalId ?? door.doorId}>
                {door.door.globalId ?? door.doorId}
              </div>
            </div>
          ))}

          {remaining > 0 && <div className="more-items">+{remaining} more doors</div>}
        </div>
      )}
      </div>

      {doors.length > 0 && (
        <div className="list-footer">
          {`${visibleDoors.length} von ${filteredDoors.length} Türen angezeigt (Anzeigelimit ${maxItems} Türen)`}
          {selectedDoorIds.size > 0 && ` | ${selectedDoorIds.size} selektiert`}
          {hasLocalFilters && (
            <>
              {' | '}
              <button type="button" className="text-button" onClick={clearLocalFilters}>
                Filter zurücksetzen
              </button>
            </>
          )}
        </div>
      )}


      <style jsx>{`
        .door-list {
          flex: 1;
          display: flex;
          flex-direction: column;
          padding: 0;
          min-height: 0;
        }

        .door-list-scroll-area {
          flex: 1;
          min-height: 0;
          overflow-x: auto;
          overflow-y: auto;
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

        .dock-resize-handle {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          height: 8px;
          cursor: ns-resize;
          z-index: 15;
        }

        .dock-resize-handle:hover {
          background: rgba(148, 163, 184, 0.15);
        }

        :global(body.dock-height-resizing) {
          cursor: ns-resize !important;
          user-select: none;
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
          gap: 6px;
          padding: 5px 12px;
          background: #1d1d1d;
          border-bottom: 1px solid #303030;
          font-size: 11px;
          color: #7d7d7d;
          position: sticky;
          top: 0;
          z-index: 5;
          align-items: stretch;
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
          font-size: 11px;
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

        .header-label-wrap {
          display: flex;
          align-items: center;
          gap: 4px;
          min-width: 0;
        }

        .header-filter-icon {
          flex-shrink: 0;
          color: #fff;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }

        .header-row {
          display: flex;
          align-items: center;
          width: 100%;
          min-width: 0;
          gap: 4px;
          height: 22px;
        }

        .header-row .list-header-button {
          flex: 1;
          min-width: 0;
        }

        .header-search-toggle {
          flex-shrink: 0;
          margin-left: auto;
          margin-right: 8px;
          padding: 4px;
          background: none;
          border: none;
          color: #fff;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .header-search-toggle:hover {
          color: #cbd5e1;
        }

        .header-dropdown-trigger {
          flex-shrink: 0;
          width: 20px;
          height: 20px;
          padding: 0;
          border: 1px solid #333;
          border-radius: 4px;
          background: #141414;
          color: #9ca3af;
          cursor: pointer;
          font-size: 10px;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .header-dropdown-trigger:hover {
          color: #fff;
          border-color: #555;
        }

        .header-dropdown {
          position: absolute;
          top: 100%;
          left: 0;
          right: 0;
          margin-top: 4px;
          max-height: 200px;
          overflow-y: auto;
          background: #1d1d1d;
          border: 1px solid #333;
          border-radius: 6px;
          padding: 4px;
          z-index: 20;
          box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        }

        .header-dropdown-item {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 4px 6px;
          cursor: pointer;
          font-size: 11px;
          border-radius: 4px;
        }

        .header-dropdown-item:hover {
          background: #2a2a2a;
        }

        .header-dropdown-item input {
          flex-shrink: 0;
        }

        .header-sort-buttons {
          display: flex;
          gap: 4px;
          margin-top: 8px;
          padding-top: 8px;
          border-top: 1px solid #333;
        }

        .header-sort-btn {
          flex: 1;
          padding: 4px 8px;
          font-size: 11px;
          border: 1px solid #333;
          border-radius: 4px;
          background: #141414;
          color: #9ca3af;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .header-sort-btn:hover {
          color: #fff;
          border-color: #555;
          background: #2a2a2a;
        }

        .door-row {
          display: grid;
          gap: 6px;
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
          cursor: pointer;
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

        .door-cell-numeric {
          text-align: right;
          font-variant-numeric: tabular-nums;
        }

        .door-cell-text {
          text-align: right;
        }

        .door-cell-guid {
          font-size: 10px;
          font-family: ui-monospace, monospace;
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

        .list-footer {
          flex-shrink: 0;
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 4px;
          padding: 8px 12px;
          font-size: 11px;
          color: #7d7d7d;
          border-top: 1px solid #303030;
          background: #1d1d1d;
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

        .header-col {
          display: flex;
          flex-direction: column;
          gap: 6px;
          min-width: 0;
          min-height: 22px;
          justify-content: center;
        }

        .header-col-checkbox {
          min-height: 36px;
        }

        .header-col-checkbox .header-row {
          justify-content: center;
        }

        .header-col-numeric .list-header-button {
          justify-content: flex-end;
          text-align: right;
        }



        .header-filter {
          width: 100%;
          height: 22px;
          padding: 2px 6px;
          background: #141414;
          border: 1px solid #333;
          border-radius: 6px;
          color: #e5e7eb;
          font-size: 11px;
        }

        .header-filter:focus {
          outline: none;
          border-color: #4ecdc4;
        }

        .header-label {
          font-size: 11px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

       .header-resizable {
          position: relative;
        }
          .col-resizer {
          position: absolute;
          top: 0;
          right: -3px;
          width: 6px;
          height: 100%;
          cursor: col-resize;
          z-index: 10;
        }
          .col-resizer:hover {
          background: rgba(148, 163, 184, 0.15);
        }
          :global(body.col-resizing) {
          cursor: col-resize !important;
          user-select: none;
        }
      `}</style>
    </div>
  )
}