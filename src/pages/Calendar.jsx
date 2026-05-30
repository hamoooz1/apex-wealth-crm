import { useEffect, useMemo, useState } from 'react'
import {
  CalendarSync,
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  List as ListIcon,
  Plus,
  RefreshCw,
} from 'lucide-react'
import { useAuth } from '../contexts/AuthContext.jsx'
import { fetchCalendarPageData, fetchMeetings, deleteMeetingById } from '../lib/queries.js'
import { syncCalendly } from '../lib/calendly.js'
import MeetingModal from '../components/meetings/MeetingModal.jsx'
import Select from '../components/ui/Select.jsx'
import './Calendar.css'

const rangeOptions = [
  { value: 7, label: 'Next 7 days' },
  { value: 14, label: 'Next 14 days' },
  { value: 30, label: 'Next 30 days' },
  { value: 90, label: 'Next 90 days' },
]

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function fmtDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString([], { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function fmtTime(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function startOfDay(d) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

function startOfMonth(d) {
  const x = new Date(d)
  x.setDate(1)
  x.setHours(0, 0, 0, 0)
  return x
}

function addDays(d, n) {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}

function addMonths(d, n) {
  const x = new Date(d)
  x.setMonth(x.getMonth() + n)
  return x
}

function dayKey(d) {
  const x = new Date(d)
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
}

function sourceBadge(source) {
  if (source === 'calendly') return { label: 'Calendly', cls: 'srcCalendly' }
  if (source === 'zoom') return { label: 'Zoom', cls: 'srcZoom' }
  return { label: 'Manual', cls: 'srcManual' }
}

function chipClass(source) {
  if (source === 'calendly') return 'evChip evCalendly'
  if (source === 'zoom') return 'evChip evZoom'
  return 'evChip evManual'
}

export default function Calendar() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [profiles, setProfiles] = useState([])
  const [leads, setLeads] = useState([])
  const [clients, setClients] = useState([])

  const [view, setView] = useState('month')
  const [rangeDays, setRangeDays] = useState(14)
  const [monthCursor, setMonthCursor] = useState(() => startOfMonth(new Date()))
  const [advisorFilter, setAdvisorFilter] = useState('')
  const [meetings, setMeetings] = useState([])
  const [expandedDay, setExpandedDay] = useState(null)

  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [syncing, setSyncing] = useState(false)

  const byProfileId = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles])
  const byLeadId = useMemo(() => new Map(leads.map((l) => [l.id, l])), [leads])
  const byClientId = useMemo(() => new Map(clients.map((c) => [c.id, c])), [clients])

  const advisors = useMemo(() => {
    return profiles.filter((p) => p.role === 'advisor' || p.role === 'manager' || p.role === 'admin')
  }, [profiles])

  const advisorFilterOptions = useMemo(
    () => [
      { value: '', label: 'All' },
      ...advisors.map((p) => ({ value: p.id, label: p.full_name })),
    ],
    [advisors],
  )

  const effectiveAdvisorId = useMemo(() => {
    if (!profile?.id) return ''
    if (!isAdmin) return profile.id
    return advisorFilter || ''
  }, [advisorFilter, isAdmin, profile?.id])

  const monthGrid = useMemo(() => {
    const first = startOfMonth(monthCursor)
    const gridStart = addDays(first, -first.getDay())
    const days = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i))
    return { gridStart, gridEnd: addDays(gridStart, 42), days }
  }, [monthCursor])

  const meetingsByDay = useMemo(() => {
    const map = new Map()
    for (const m of meetings) {
      if (!m.start_time) continue
      const k = dayKey(m.start_time)
      if (!map.has(k)) map.set(k, [])
      map.get(k).push(m)
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => new Date(a.start_time) - new Date(b.start_time))
    }
    return map
  }, [meetings])

  async function loadPage() {
    if (!profile?.id) return
    setLoading(true)
    setError(null)
    try {
      const base = await fetchCalendarPageData()
      setProfiles(base.profiles || [])
      setLeads(base.leads || [])
      setClients(base.clients || [])

      let from
      let to
      if (view === 'month') {
        from = monthGrid.gridStart
        to = monthGrid.gridEnd
      } else {
        from = startOfDay(new Date())
        to = addDays(from, rangeDays)
      }

      const rows = await fetchMeetings({
        from: from.toISOString(),
        to: to.toISOString(),
        advisorId: effectiveAdvisorId || null,
      })
      setMeetings(rows)
    } catch (e) {
      setError(e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadPage()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id, rangeDays, effectiveAdvisorId, view, monthCursor])

  async function onSyncCalendly() {
    setSyncing(true)
    setError(null)
    try {
      await syncCalendly()
      await loadPage()
    } catch (e) {
      setError(e)
    } finally {
      setSyncing(false)
    }
  }

  function onCreate(dateArg) {
    const base = dateArg instanceof Date ? new Date(dateArg) : new Date()
    if (dateArg instanceof Date) base.setHours(9, 0, 0, 0)
    else base.setMinutes(0, 0, 0)
    const end = new Date(base.getTime() + 30 * 60 * 1000)
    setEditing({
      id: null,
      advisor_id: isAdmin ? effectiveAdvisorId || '' : profile?.id,
      title: '',
      start_time: base.toISOString(),
      end_time: end.toISOString(),
      meeting_type: '',
      meeting_url: '',
      status: 'scheduled',
      notes: '',
      lead_id: null,
      client_id: null,
      source: 'manual',
    })
    setModalOpen(true)
  }

  function onEdit(m) {
    setEditing(m)
    setModalOpen(true)
  }

  async function onDelete(m) {
    if (!m?.id) return
    const ok = window.confirm('Delete this meeting? This cannot be undone.')
    if (!ok) return
    setLoading(true)
    setError(null)
    try {
      await deleteMeetingById(m.id)
      await loadPage()
    } catch (e) {
      setError(e)
    } finally {
      setLoading(false)
    }
  }

  const todayKey = dayKey(new Date())
  const monthLabel = monthCursor.toLocaleDateString([], { month: 'long', year: 'numeric' })

  return (
    <div>
      <div className="pageHeader">
        <div>
          <h1 className="pageTitle">Calendar</h1>
          <div className="pageSubtitle">Meetings across your CRM</div>
        </div>
        <div className="pageActions">
          <button className="btnSecondary" type="button" onClick={onSyncCalendly} disabled={loading || syncing}>
            <CalendarSync size={16} />
            {syncing ? 'Syncing…' : 'Sync Calendly'}
          </button>
          <button className="btnSecondary" type="button" onClick={loadPage} disabled={loading}>
            <RefreshCw size={16} />
            Refresh
          </button>
          <button className="btnPrimary" type="button" onClick={() => onCreate()} disabled={loading}>
            <Plus size={16} />
            New meeting
          </button>
        </div>
      </div>

      <div className="calendarCard card">
        <div className="calendarToolbar">
          <div className="calToolbarLeft">
            <div className="calViewToggle" role="tablist" aria-label="Calendar view">
              <button
                type="button"
                className={['calToggleBtn', view === 'month' ? 'isActive' : null].filter(Boolean).join(' ')}
                onClick={() => setView('month')}
                aria-selected={view === 'month'}
              >
                <CalendarDays size={15} />
                Month
              </button>
              <button
                type="button"
                className={['calToggleBtn', view === 'list' ? 'isActive' : null].filter(Boolean).join(' ')}
                onClick={() => setView('list')}
                aria-selected={view === 'list'}
              >
                <ListIcon size={15} />
                List
              </button>
            </div>

            {view === 'month' ? (
              <div className="calMonthNav">
                <button
                  className="calNavBtn"
                  type="button"
                  onClick={() => setMonthCursor((c) => addMonths(c, -1))}
                  aria-label="Previous month"
                >
                  <ChevronLeft size={16} />
                </button>
                <button className="calTodayBtn" type="button" onClick={() => setMonthCursor(startOfMonth(new Date()))}>
                  Today
                </button>
                <button
                  className="calNavBtn"
                  type="button"
                  onClick={() => setMonthCursor((c) => addMonths(c, 1))}
                  aria-label="Next month"
                >
                  <ChevronRight size={16} />
                </button>
                <div className="calMonthLabel">{monthLabel}</div>
              </div>
            ) : (
              <label className="calField">
                <div className="calLabel">Range</div>
                <Select
                  className="calSelectUi"
                  value={rangeDays}
                  onChange={(v) => setRangeDays(Number(v) || 14)}
                  options={rangeOptions}
                />
              </label>
            )}
          </div>

          {isAdmin ? (
            <label className="calField">
              <div className="calLabel">Advisor</div>
              <Select
                className="calSelectUi"
                value={advisorFilter}
                onChange={(v) => setAdvisorFilter(v)}
                options={advisorFilterOptions}
              />
            </label>
          ) : (
            <div className="calHint">Showing your meetings only</div>
          )}
        </div>

        {error ? <div className="inlineError">{error.message || 'Failed to load meetings.'}</div> : null}
        {loading ? <div className="inlineHint">Loading…</div> : null}

        {view === 'month' ? (
          <div className="calMonthWrap">
            <div className="calMonthGrid calWeekHead">
              {WEEKDAYS.map((w) => (
                <div className="calWeekday" key={w}>
                  {w}
                </div>
              ))}
            </div>
            <div className="calMonthGrid calMonthBody">
              {monthGrid.days.map((day) => {
                const k = dayKey(day)
                const inMonth = day.getMonth() === monthCursor.getMonth()
                const isToday = k === todayKey
                const dayMeetings = meetingsByDay.get(k) || []
                const expanded = expandedDay === k
                const visible = expanded ? dayMeetings : dayMeetings.slice(0, 3)
                const hidden = dayMeetings.length - visible.length
                return (
                  <div
                    key={k}
                    className={['calDayCell', inMonth ? null : 'calDayOut', isToday ? 'calDayToday' : null]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => onCreate(day)}
                  >
                    <div className="calDayTop">
                      <span className={['calDayNum', isToday ? 'calDayNumToday' : null].filter(Boolean).join(' ')}>
                        {day.getDate()}
                      </span>
                    </div>
                    <div className="calDayChips">
                      {visible.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          className={[chipClass(m.source), m.status === 'canceled' ? 'evCanceled' : null]
                            .filter(Boolean)
                            .join(' ')}
                          title={`${m.title} · ${fmtTime(m.start_time)}`}
                          onClick={(e) => {
                            e.stopPropagation()
                            onEdit(m)
                          }}
                        >
                          <span className="evTime">{fmtTime(m.start_time)}</span>
                          <span className="evTitle">{m.title || 'Meeting'}</span>
                        </button>
                      ))}
                      {hidden > 0 ? (
                        <button
                          type="button"
                          className="evMore"
                          onClick={(e) => {
                            e.stopPropagation()
                            setExpandedDay(expanded ? null : k)
                          }}
                        >
                          {expanded ? 'Show less' : `+${hidden} more`}
                        </button>
                      ) : null}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ) : (
          <div className="calendarTableWrap">
            <table className="calendarTable">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Title</th>
                  <th>Advisor</th>
                  <th>Linked record</th>
                  <th>Source</th>
                  <th>Status</th>
                  <th style={{ width: 160 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {meetings.length === 0 && !loading ? (
                  <tr>
                    <td colSpan={7} className="tMuted">
                      No meetings in this range.
                    </td>
                  </tr>
                ) : (
                  meetings.map((m) => {
                    const adv = byProfileId.get(m.advisor_id)
                    const lead = m.lead_id ? byLeadId.get(m.lead_id) : null
                    const client = m.client_id ? byClientId.get(m.client_id) : null
                    const linked = lead
                      ? `Lead: ${lead.full_name || lead.email || lead.id}`
                      : client
                        ? `Client: ${client.full_name || client.email || client.id}`
                        : '—'
                    const src = sourceBadge(m.source)
                    const canEdit = m.source !== 'calendly'
                    return (
                      <tr key={m.id}>
                        <td className="tMuted">{fmtDateTime(m.start_time)}</td>
                        <td className="tTitle">{m.title}</td>
                        <td className="tMuted">{adv?.full_name || '—'}</td>
                        <td className="tMuted">{linked}</td>
                        <td>
                          <span className={['srcBadge', src.cls].join(' ')}>{src.label}</span>
                        </td>
                        <td className="tMuted">{m.status || '—'}</td>
                        <td>
                          <div className="rowActions">
                            <button className="btnSecondary" type="button" onClick={() => onEdit(m)} disabled={!canEdit}>
                              {canEdit ? 'Edit' : 'View'}
                            </button>
                            <button className="btnSecondary" type="button" onClick={() => onDelete(m)} disabled={!canEdit}>
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modalOpen ? (
        <MeetingModal
          open={modalOpen}
          onClose={() => {
            setModalOpen(false)
            setEditing(null)
          }}
          meeting={editing}
          me={profile}
          isAdmin={isAdmin}
          profiles={profiles}
          leads={leads}
          clients={clients}
          onSaved={async () => {
            setModalOpen(false)
            setEditing(null)
            await loadPage()
          }}
        />
      ) : null}
    </div>
  )
}
