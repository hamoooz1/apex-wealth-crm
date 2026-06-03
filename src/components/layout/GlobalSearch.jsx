import {
  Calendar,
  ClipboardList,
  Search,
  UserPlus,
  Users,
  UsersRound,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { globalSearch } from '../../lib/search.js'

const TYPE_ICONS = {
  client: Users,
  lead: UserPlus,
  meeting: Calendar,
  task: ClipboardList,
  team: UsersRound,
}

function flatItems(groups) {
  return groups.flatMap((g) => g.items.map((item) => ({ ...item, groupLabel: g.label })))
}

export default function GlobalSearch() {
  const navigate = useNavigate()
  const wrapRef = useRef(null)
  const inputRef = useRef(null)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [groups, setGroups] = useState([])
  const [activeIdx, setActiveIdx] = useState(-1)

  const shortcutHint =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform) ? '⌘K' : 'Ctrl+K'

  const flat = useMemo(() => flatItems(groups), [groups])

  useEffect(() => {
    function onKeyDown(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        setOpen(true)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    function onDocClick(e) {
      if (!wrapRef.current?.contains(e.target)) {
        setOpen(false)
        setActiveIdx(-1)
      }
    }
    if (open) document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  useEffect(() => {
    if (!open) return
    const q = query.trim()
    if (q.length < 2) {
      setGroups([])
      setError(null)
      setLoading(false)
      setActiveIdx(-1)
      return
    }

    setLoading(true)
    setError(null)
    const t = setTimeout(async () => {
      try {
        const result = await globalSearch(q)
        setGroups(result.groups)
        setActiveIdx(result.total ? 0 : -1)
      } catch (e) {
        setError(e)
        setGroups([])
        setActiveIdx(-1)
      } finally {
        setLoading(false)
      }
    }, 220)

    return () => clearTimeout(t)
  }, [query, open])

  function go(item) {
    if (!item?.href) return
    setOpen(false)
    setActiveIdx(-1)
    navigate(item.href)
  }

  function onInputKeyDown(e) {
    if (e.key === 'Escape') {
      setOpen(false)
      setActiveIdx(-1)
      inputRef.current?.blur()
      return
    }
    if (!flat.length) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => (i + 1) % flat.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => (i <= 0 ? flat.length - 1 : i - 1))
    } else if (e.key === 'Enter' && activeIdx >= 0) {
      e.preventDefault()
      go(flat[activeIdx])
    }
  }

  let runningIdx = -1

  return (
    <div className="searchWrap globalSearch" ref={wrapRef}>
      <Search size={16} className="globalSearchIcon" aria-hidden="true" />
      <input
        ref={inputRef}
        className="searchInput globalSearchInput"
        placeholder="Search clients, leads, meetings, tasks…"
        type="search"
        value={query}
        aria-label="Global search"
        aria-expanded={open}
        aria-autocomplete="list"
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
        }}
        onKeyDown={onInputKeyDown}
      />
      <kbd className="globalSearchHint" aria-hidden="true">
        {shortcutHint}
      </kbd>

      {open && (query.trim().length >= 2 || loading) ? (
        <div className="globalSearchPanel" role="listbox">
          {loading ? <div className="globalSearchEmpty">Searching…</div> : null}
          {!loading && error ? (
            <div className="globalSearchEmpty">{error.message || 'Search failed.'}</div>
          ) : null}
          {!loading && !error && groups.length === 0 ? (
            <div className="globalSearchEmpty">No results for &ldquo;{query.trim()}&rdquo;</div>
          ) : null}

          {!loading && !error
            ? groups.map((group) => (
                <div key={group.key} className="globalSearchGroup">
                  <div className="globalSearchGroupLabel">{group.label}</div>
                  {group.items.map((item) => {
                    runningIdx += 1
                    const idx = runningIdx
                    const Icon = TYPE_ICONS[item.type] || Search
                    const isActive = idx === activeIdx
                    return (
                      <button
                        key={`${item.type}-${item.id}`}
                        type="button"
                        role="option"
                        aria-selected={isActive}
                        className={['globalSearchItem', isActive ? 'isActive' : ''].filter(Boolean).join(' ')}
                        onMouseEnter={() => setActiveIdx(idx)}
                        onClick={() => go(item)}
                      >
                        <span className="globalSearchItemIcon">
                          <Icon size={15} />
                        </span>
                        <span className="globalSearchItemText">
                          <span className="globalSearchItemTitle">{item.title}</span>
                          {item.subtitle ? (
                            <span className="globalSearchItemSub">{item.subtitle}</span>
                          ) : null}
                        </span>
                      </button>
                    )
                  })}
                </div>
              ))
            : null}
        </div>
      ) : null}
    </div>
  )
}
