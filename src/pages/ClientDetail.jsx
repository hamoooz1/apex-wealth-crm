import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Calendar as CalendarIcon, Check, ClipboardList, Pencil, X } from 'lucide-react'
import { fetchClientDetail } from '../lib/queries.js'
import { supabase } from '../lib/supabaseClient.js'
import Select from '../components/ui/Select.jsx'
import './ClientDetail.css'

function formatCurrency(n) {
  const v = Number(n || 0)
  return v.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
}

function statusLabel(s) {
  if (s === 'active') return 'Active'
  if (s === 'at_risk') return 'At Risk'
  if (s === 'inactive') return 'Inactive'
  return String(s || '')
}

function statusClass(s) {
  if (s === 'active') return 'active'
  if (s === 'at_risk') return 'at-risk'
  if (s === 'inactive') return 'inactive'
  return ''
}

function initials(first, last) {
  return `${(first || '').charAt(0)}${(last || '').charAt(0)}`.toUpperCase() || '—'
}

function formatDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function taskStatusLabel(s) {
  if (s === 'todo') return 'To do'
  if (s === 'in_progress') return 'In progress'
  if (s === 'done') return 'Done'
  return String(s || '')
}

export default function ClientDetail() {
  const { id } = useParams()
  const [state, setState] = useState({ loading: true, error: null, data: null })
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let mounted = true
    async function load() {
      setState({ loading: true, error: null, data: null })
      try {
        const data = await fetchClientDetail(id)
        if (!mounted) return
        setState({ loading: false, error: null, data })
      } catch (e) {
        if (!mounted) return
        setState({ loading: false, error: e, data: null })
      }
    }
    load()
    return () => {
      mounted = false
    }
  }, [id])

  const computed = useMemo(() => {
    const client = state.data?.client || null
    const profiles = state.data?.profiles || []
    const meetings = state.data?.meetings || []
    const tasks = state.data?.tasks || []
    const profilesMap = new Map(profiles.map((p) => [p.id, p]))
    const advisorName = client?.advisor_id ? profilesMap.get(client.advisor_id)?.full_name || 'Unknown' : '—'
    const advisorOptions = [
      { value: '', label: '—' },
      ...profiles.map((p) => ({ value: p.id, label: p.full_name })),
    ]
    const statusOptions = [
      { value: 'active', label: 'Active' },
      { value: 'at_risk', label: 'At Risk' },
      { value: 'inactive', label: 'Inactive' },
    ]
    const now = Date.now()
    const upcoming = meetings
      .filter((m) => m.start_time && new Date(m.start_time).getTime() >= now && m.status !== 'canceled')
      .sort((a, b) => new Date(a.start_time) - new Date(b.start_time))
    const past = meetings
      .filter((m) => !(m.start_time && new Date(m.start_time).getTime() >= now && m.status !== 'canceled'))
      .sort((a, b) => new Date(b.start_time) - new Date(a.start_time))
    const openTasks = tasks.filter((t) => t.status !== 'done')
    return { client, advisorName, advisorOptions, statusOptions, upcoming, past, openTasks }
  }, [state.data])

  function startEdit() {
    const c = computed.client
    if (!c) return
    setDraft({
      first_name: c.first_name || '',
      last_name: c.last_name || '',
      email: c.email || '',
      phone: c.phone || '',
      advisor_id: c.advisor_id || '',
      aum: c.aum ?? '',
      status: c.status || 'active',
      next_review_date: c.next_review_date || '',
    })
    setEditing(true)
  }

  function cancelEdit() {
    setEditing(false)
    setDraft(null)
  }

  async function saveEdit() {
    if (!draft) return
    setSaving(true)
    setState((s) => ({ ...s, error: null }))
    try {
      const patch = {
        first_name: draft.first_name || null,
        last_name: draft.last_name || null,
        email: draft.email || null,
        phone: draft.phone || null,
        advisor_id: draft.advisor_id || null,
        aum: draft.aum === '' ? null : Number(draft.aum),
        status: draft.status || null,
        next_review_date: draft.next_review_date || null,
      }
      const { data, error } = await supabase.from('clients').update(patch).eq('id', id).select('*').maybeSingle()
      if (error) throw error
      setState((s) => ({ ...s, data: { ...s.data, client: data } }))
      cancelEdit()
    } catch (e) {
      setState((s) => ({ ...s, error: e }))
    } finally {
      setSaving(false)
    }
  }

  if (state.loading) {
    return (
      <div>
        <Link to="/clients" className="backLink">
          <ArrowLeft size={16} /> Clients
        </Link>
        <div className="card" style={{ padding: 16, marginTop: 12 }}>
          <div className="muted">Loading client…</div>
        </div>
      </div>
    )
  }

  if (state.error || !computed.client) {
    return (
      <div>
        <Link to="/clients" className="backLink">
          <ArrowLeft size={16} /> Clients
        </Link>
        <div className="card" style={{ padding: 16, marginTop: 12 }}>
          <div className="muted">{state.error?.message || 'Client not found.'}</div>
        </div>
      </div>
    )
  }

  const c = computed.client
  const fullName = [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Client'

  return (
    <div className="clientDetail">
      <Link to="/clients" className="backLink">
        <ArrowLeft size={16} /> Clients
      </Link>

      {state.error ? (
        <div className="card" style={{ padding: 14, margin: '12px 0' }}>
          <div className="muted">Error: {state.error.message || 'Something went wrong.'}</div>
        </div>
      ) : null}

      <div className="card cdHeader">
        <div className="cdIdentity">
          <div className="cdAvatar" aria-hidden="true">
            {initials(c.first_name, c.last_name)}
          </div>
          <div>
            <div className="cdName">{fullName}</div>
            <div className="cdSubRow">
              <span className={['statusPill', statusClass(c.status)].join(' ')}>{statusLabel(c.status)}</span>
              <span className="muted">Advisor: {computed.advisorName}</span>
            </div>
          </div>
        </div>
        <div className="cdHeaderRight">
          <div className="cdAum">
            <div className="cdAumLabel">AUM</div>
            <div className="cdAumValue">{formatCurrency(c.aum)}</div>
          </div>
          {!editing ? (
            <button className="btnSecondary" type="button" onClick={startEdit}>
              <Pencil size={16} /> Edit
            </button>
          ) : null}
        </div>
      </div>

      {editing && draft ? (
        <div className="card cdEditCard">
          <div className="formGrid">
            <label className="sField">
              <div className="sLabel">First name</div>
              <input className="sInput" value={draft.first_name} onChange={(e) => setDraft((d) => ({ ...d, first_name: e.target.value }))} />
            </label>
            <label className="sField">
              <div className="sLabel">Last name</div>
              <input className="sInput" value={draft.last_name} onChange={(e) => setDraft((d) => ({ ...d, last_name: e.target.value }))} />
            </label>
            <label className="sField">
              <div className="sLabel">Email</div>
              <input className="sInput" value={draft.email} onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))} />
            </label>
            <label className="sField">
              <div className="sLabel">Phone</div>
              <input className="sInput" value={draft.phone} onChange={(e) => setDraft((d) => ({ ...d, phone: e.target.value }))} />
            </label>
            <label className="sField">
              <div className="sLabel">Advisor</div>
              <Select value={draft.advisor_id} onChange={(v) => setDraft((d) => ({ ...d, advisor_id: v }))} options={computed.advisorOptions} placeholder="—" />
            </label>
            <label className="sField">
              <div className="sLabel">AUM</div>
              <input className="sInput" type="number" value={draft.aum} onChange={(e) => setDraft((d) => ({ ...d, aum: e.target.value }))} />
            </label>
            <label className="sField">
              <div className="sLabel">Status</div>
              <Select value={draft.status} onChange={(v) => setDraft((d) => ({ ...d, status: v }))} options={computed.statusOptions} />
            </label>
            <label className="sField">
              <div className="sLabel">Next review date</div>
              <input className="sInput" type="date" value={draft.next_review_date} onChange={(e) => setDraft((d) => ({ ...d, next_review_date: e.target.value }))} />
            </label>
          </div>
          <div className="cdEditActions">
            <button className="btnSecondary" type="button" onClick={cancelEdit} disabled={saving}>
              <X size={16} /> Cancel
            </button>
            <button className="btnPrimary" type="button" onClick={saveEdit} disabled={saving}>
              <Check size={16} /> {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      ) : (
        <div className="card cdFacts">
          <div className="cdFact">
            <div className="cdFactLabel">Email</div>
            <div className="cdFactValue">{c.email || '—'}</div>
          </div>
          <div className="cdFact">
            <div className="cdFactLabel">Phone</div>
            <div className="cdFactValue">{c.phone || '—'}</div>
          </div>
          <div className="cdFact">
            <div className="cdFactLabel">Next review</div>
            <div className="cdFactValue">{c.next_review_date || '—'}</div>
          </div>
        </div>
      )}

      <div className="cdGrid">
        <div className="card cdPanel">
          <div className="cdPanelHead">
            <CalendarIcon size={16} />
            <span>Upcoming meetings</span>
            <span className="cdCount">{computed.upcoming.length}</span>
          </div>
          {computed.upcoming.length === 0 ? (
            <div className="muted cdEmpty">No upcoming meetings.</div>
          ) : (
            <ul className="cdList">
              {computed.upcoming.map((m) => (
                <li key={m.id} className="cdListItem">
                  <div className="cdItemMain">{m.title || 'Meeting'}</div>
                  <div className="cdItemMeta">{formatDateTime(m.start_time)}</div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card cdPanel">
          <div className="cdPanelHead">
            <CalendarIcon size={16} />
            <span>Past meetings</span>
            <span className="cdCount">{computed.past.length}</span>
          </div>
          {computed.past.length === 0 ? (
            <div className="muted cdEmpty">No past meetings.</div>
          ) : (
            <ul className="cdList">
              {computed.past.slice(0, 8).map((m) => (
                <li key={m.id} className="cdListItem">
                  <div className="cdItemMain">{m.title || 'Meeting'}</div>
                  <div className="cdItemMeta">
                    {formatDateTime(m.start_time)}
                    {m.status ? <span className="cdItemStatus"> · {m.status}</span> : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card cdPanel">
          <div className="cdPanelHead">
            <ClipboardList size={16} />
            <span>Open tasks</span>
            <span className="cdCount">{computed.openTasks.length}</span>
          </div>
          {computed.openTasks.length === 0 ? (
            <div className="muted cdEmpty">No open tasks.</div>
          ) : (
            <ul className="cdList">
              {computed.openTasks.map((t) => (
                <li key={t.id} className="cdListItem">
                  <div className="cdItemMain">{t.title}</div>
                  <div className="cdItemMeta">
                    {t.due_date ? `Due ${t.due_date}` : 'No due date'}
                    <span className="cdItemStatus"> · {taskStatusLabel(t.status)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
