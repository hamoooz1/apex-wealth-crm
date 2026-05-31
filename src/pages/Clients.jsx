import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Check, Film, Pencil, Plus, Trash2, X } from 'lucide-react'
import { fetchClientsPageData } from '../lib/queries.js'
import { supabase } from '../lib/supabaseClient.js'
import { useAuth } from '../contexts/AuthContext.jsx'
import Select from '../components/ui/Select.jsx'

function formatCurrency(n) {
  const v = Number(n || 0)
  return v.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  })
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

export default function Clients() {
  const { profile: me } = useAuth()
  const canDelete = me?.role === 'admin'
  const [state, setState] = useState({ loading: true, error: null, data: null })
  const [editId, setEditId] = useState(null)
  const [draft, setDraft] = useState(null)
  const [saving, setSaving] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [createDraft, setCreateDraft] = useState(null)
  const [createSaving, setCreateSaving] = useState(false)

  useEffect(() => {
    let mounted = true
    async function load() {
      setState({ loading: true, error: null, data: null })
      try {
        const data = await fetchClientsPageData()
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
  }, [])

  const computed = useMemo(() => {
    const clients = state.data?.clients || []
    const profiles = state.data?.profiles || []
    const recordingCounts = state.data?.recordingCounts || {}
    const profilesMap = new Map(profiles.map((p) => [p.id, p]))
    const advisorName = (profileId) => {
      const p = profilesMap.get(profileId)
      return p ? p.full_name : 'Unknown'
    }
    const advisorOptions = [
      { value: '', label: '—' },
      ...profiles.map((p) => ({ value: p.id, label: p.full_name })),
    ]
    const statusOptions = [
      { value: 'active', label: 'Active' },
      { value: 'at_risk', label: 'At Risk' },
      { value: 'inactive', label: 'Inactive' },
    ]
    return { clients, profiles, recordingCounts, advisorName, advisorOptions, statusOptions }
  }, [state.data, state.loading, state.error])

  function startEdit(c) {
    setEditId(c.id)
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
  }

  function cancelEdit() {
    setEditId(null)
    setDraft(null)
  }

  async function saveInline() {
    if (!editId || !draft) return
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
      const { data, error } = await supabase
        .from('clients')
        .update(patch)
        .eq('id', editId)
        .select('*')
        .maybeSingle()
      if (error) throw error

      setState((s) => ({
        ...s,
        data: {
          ...s.data,
          clients: (s.data?.clients || []).map((c) => (c.id === editId ? data : c)),
        },
      }))
      cancelEdit()
    } catch (e) {
      setState((s) => ({ ...s, error: e }))
    } finally {
      setSaving(false)
    }
  }

  function openCreate() {
    setCreateDraft({
      first_name: '',
      last_name: '',
      email: '',
      phone: '',
      advisor_id: '',
      aum: '',
      status: 'active',
      next_review_date: '',
    })
    setCreateOpen(true)
  }

  function closeCreate() {
    setCreateOpen(false)
    setCreateDraft(null)
  }

  async function createClient() {
    if (!createDraft?.first_name?.trim()) return
    setCreateSaving(true)
    setState((s) => ({ ...s, error: null }))
    try {
      const payload = {
        first_name: createDraft.first_name.trim(),
        last_name: createDraft.last_name.trim() || null,
        email: createDraft.email.trim() || null,
        phone: createDraft.phone.trim() || null,
        advisor_id: createDraft.advisor_id || null,
        aum: createDraft.aum === '' ? null : Number(createDraft.aum),
        status: createDraft.status || null,
        next_review_date: createDraft.next_review_date || null,
      }

      const { data, error } = await supabase.from('clients').insert(payload).select('*').maybeSingle()
      if (error) throw error

      setState((s) => ({
        ...s,
        data: { ...s.data, clients: [data, ...(s.data?.clients || [])] },
      }))
      closeCreate()
    } catch (e) {
      setState((s) => ({ ...s, error: e }))
    } finally {
      setCreateSaving(false)
    }
  }

  async function deleteClient(clientId) {
    if (!canDelete) return
    const ok = window.confirm('Delete this client? This cannot be undone.')
    if (!ok) return
    setState((s) => ({ ...s, error: null }))
    try {
      const { error } = await supabase.from('clients').delete().eq('id', clientId)
      if (error) throw error
      setState((s) => ({
        ...s,
        data: { ...s.data, clients: (s.data?.clients || []).filter((c) => c.id !== clientId) },
      }))
      if (editId === clientId) cancelEdit()
    } catch (e) {
      setState((s) => ({ ...s, error: e }))
    }
  }

  return (
    <div>
      <div className="pageHeader">
        <div>
          <h1 className="pageTitle">Clients</h1>
          <div className="pageSubtitle">Client roster and AUM</div>
        </div>
        <div className="pageHeaderRight">
          <button className="btnPrimary" type="button" onClick={openCreate}>
            <Plus size={16} />
            New Client
          </button>
        </div>
      </div>

      {state.error ? (
        <div className="card" style={{ padding: 14, marginBottom: 12 }}>
          <div className="muted">Error: {state.error.message || 'Something went wrong.'}</div>
        </div>
      ) : null}

      <div className="card tableWrap">
        <table className="crmTable">
          <thead>
            <tr>
              <th>Client</th>
              <th>Email</th>
              <th>Phone</th>
              <th>Advisor</th>
              <th>AUM</th>
              <th>Status</th>
              <th>Next Review Date</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {state.loading ? (
              <tr>
                <td colSpan={8} className="muted">
                  Loading clients…
                </td>
              </tr>
            ) : state.error ? (
              <tr>
                <td colSpan={8} className="muted">
                  Failed to load clients.
                </td>
              </tr>
            ) : computed.clients.length === 0 ? (
              <tr>
                <td colSpan={8} className="muted">
                  No clients yet.
                </td>
              </tr>
            ) : (
              computed.clients.map((c) => (
              <tr key={c.id}>
                <td>
                  <div className="clientName">
                    <div className="avatar" aria-hidden="true" />
                    {editId === c.id && draft ? (
                      <div style={{ display: 'flex', gap: 8 }}>
                        <input
                          className="inlineInput"
                          value={draft.first_name}
                          onChange={(e) => setDraft((d) => ({ ...d, first_name: e.target.value }))}
                          placeholder="First"
                          style={{ minWidth: 120 }}
                        />
                        <input
                          className="inlineInput"
                          value={draft.last_name}
                          onChange={(e) => setDraft((d) => ({ ...d, last_name: e.target.value }))}
                          placeholder="Last"
                          style={{ minWidth: 120 }}
                        />
                      </div>
                    ) : (
                      <Link to={`/clients/${c.id}`} className="clientLink">
                        {c.first_name} {c.last_name}
                      </Link>
                    )}
                  </div>
                </td>
                <td className="muted">
                  {editId === c.id && draft ? (
                    <input
                      className="inlineInput"
                      value={draft.email}
                      onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))}
                      placeholder="email@domain.com"
                      style={{ minWidth: 220 }}
                    />
                  ) : (
                    c.email
                  )}
                </td>
                <td className="muted">
                  {editId === c.id && draft ? (
                    <input
                      className="inlineInput"
                      value={draft.phone}
                      onChange={(e) => setDraft((d) => ({ ...d, phone: e.target.value }))}
                      placeholder="(000) 000-0000"
                    />
                  ) : (
                    c.phone
                  )}
                </td>
                <td className="muted">
                  {editId === c.id && draft ? (
                    <Select
                      value={draft.advisor_id}
                      onChange={(v) => setDraft((d) => ({ ...d, advisor_id: v }))}
                      options={computed.advisorOptions}
                      size="sm"
                      align="right"
                    />
                  ) : (
                    computed.advisorName(c.advisor_id)
                  )}
                </td>
                <td>
                  {editId === c.id && draft ? (
                    <input
                      className="inlineInput"
                      type="number"
                      value={draft.aum}
                      onChange={(e) => setDraft((d) => ({ ...d, aum: e.target.value }))}
                      placeholder="0"
                    />
                  ) : (
                    formatCurrency(c.aum)
                  )}
                </td>
                <td>
                  {editId === c.id && draft ? (
                    <Select
                      value={draft.status}
                      onChange={(v) => setDraft((d) => ({ ...d, status: v }))}
                      options={computed.statusOptions}
                      size="sm"
                      align="right"
                    />
                  ) : (
                    <span className={['statusPill', statusClass(c.status)].join(' ')}>
                      {statusLabel(c.status)}
                    </span>
                  )}
                </td>
                <td className="muted">
                  {editId === c.id && draft ? (
                    <input
                      className="inlineInput"
                      type="date"
                      value={draft.next_review_date}
                      onChange={(e) => setDraft((d) => ({ ...d, next_review_date: e.target.value }))}
                    />
                  ) : (
                    c.next_review_date
                  )}
                </td>
                <td style={{ textAlign: 'right' }}>
                  {editId === c.id ? (
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                      <button className="btnSecondary" type="button" onClick={cancelEdit} disabled={saving}>
                        <X size={16} />
                      </button>
                      <button className="btnPrimary" type="button" onClick={saveInline} disabled={saving}>
                        <Check size={16} />
                        {saving ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                      <Link
                        className="btnSecondary recBtn"
                        to={`/clients/${c.id}?tab=recordings`}
                        title="View recordings"
                      >
                        <Film size={16} />
                        {computed.recordingCounts[c.id] ? (
                          <span className="recBadge">{computed.recordingCounts[c.id]}</span>
                        ) : null}
                      </Link>
                      <button className="btnSecondary" type="button" onClick={() => startEdit(c)}>
                        <Pencil size={16} />
                        Edit
                      </button>
                      {canDelete ? (
                        <button className="btnSecondary" type="button" onClick={() => deleteClient(c.id)}>
                          <Trash2 size={16} />
                        </button>
                      ) : null}
                    </div>
                  )}
                </td>
              </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {createOpen && createDraft ? (
        <div className="modalOverlay" role="dialog" aria-modal="true">
          <div className="modalCard">
            <div className="modalHeader">
              <div>
                <div className="modalTitle">New Client</div>
                <div className="modalSub">Create a new client record</div>
              </div>
              <button className="iconBtn" type="button" onClick={closeCreate} aria-label="Close">
                <X size={16} />
              </button>
            </div>

            <div className="modalBody">
              <div className="formGrid">
                <label className="sField">
                  <div className="sLabel">First name</div>
                  <input
                    className="sInput"
                    value={createDraft.first_name}
                    onChange={(e) => setCreateDraft((d) => ({ ...d, first_name: e.target.value }))}
                    placeholder="First"
                  />
                </label>
                <label className="sField">
                  <div className="sLabel">Last name</div>
                  <input
                    className="sInput"
                    value={createDraft.last_name}
                    onChange={(e) => setCreateDraft((d) => ({ ...d, last_name: e.target.value }))}
                    placeholder="Last"
                  />
                </label>
                <label className="sField" style={{ gridColumn: '1 / -1' }}>
                  <div className="sLabel">Email</div>
                  <input
                    className="sInput"
                    value={createDraft.email}
                    onChange={(e) => setCreateDraft((d) => ({ ...d, email: e.target.value }))}
                    placeholder="email@domain.com"
                  />
                </label>
                <label className="sField">
                  <div className="sLabel">Phone</div>
                  <input
                    className="sInput"
                    value={createDraft.phone}
                    onChange={(e) => setCreateDraft((d) => ({ ...d, phone: e.target.value }))}
                    placeholder="(000) 000-0000"
                  />
                </label>
                <label className="sField">
                  <div className="sLabel">Advisor</div>
                  <Select
                    value={createDraft.advisor_id}
                    onChange={(v) => setCreateDraft((d) => ({ ...d, advisor_id: v }))}
                    options={computed.advisorOptions}
                    placeholder="—"
                  />
                </label>
                <label className="sField">
                  <div className="sLabel">AUM</div>
                  <input
                    className="sInput"
                    type="number"
                    value={createDraft.aum}
                    onChange={(e) => setCreateDraft((d) => ({ ...d, aum: e.target.value }))}
                    placeholder="0"
                  />
                </label>
                <label className="sField">
                  <div className="sLabel">Status</div>
                  <Select
                    value={createDraft.status}
                    onChange={(v) => setCreateDraft((d) => ({ ...d, status: v }))}
                    options={computed.statusOptions}
                  />
                </label>
                <label className="sField" style={{ gridColumn: '1 / -1' }}>
                  <div className="sLabel">Next review date</div>
                  <input
                    className="sInput"
                    type="date"
                    value={createDraft.next_review_date}
                    onChange={(e) => setCreateDraft((d) => ({ ...d, next_review_date: e.target.value }))}
                  />
                </label>
              </div>
            </div>

            <div className="modalFooter">
              <button className="btnSecondary" type="button" onClick={closeCreate} disabled={createSaving}>
                Cancel
              </button>
              <button
                className="btnPrimary"
                type="button"
                onClick={createClient}
                disabled={!createDraft.first_name.trim() || createSaving}
              >
                <Check size={16} />
                {createSaving ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

