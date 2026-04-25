import { useEffect, useMemo, useState } from 'react'
import { Check, Pencil, X } from 'lucide-react'
import { fetchClientsPageData } from '../lib/queries.js'
import { supabase } from '../lib/supabaseClient.js'

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
  const [state, setState] = useState({ loading: true, error: null, data: null })
  const [editId, setEditId] = useState(null)
  const [draft, setDraft] = useState(null)
  const [saving, setSaving] = useState(false)

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
    const profilesMap = new Map(profiles.map((p) => [p.id, p]))
    const advisorName = (profileId) => {
      const p = profilesMap.get(profileId)
      return p ? p.full_name : 'Unknown'
    }
    return { clients, profiles, advisorName }
  }, [state.data, state.loading, state.error])

  function startEdit(c) {
    setEditId(c.id)
    setDraft({
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

  return (
    <div>
      <div className="pageHeader">
        <div>
          <h1 className="pageTitle">Clients</h1>
          <div className="pageSubtitle">Client roster and AUM</div>
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
                    {c.first_name} {c.last_name}
                  </div>
                </td>
                <td className="muted">{c.email}</td>
                <td className="muted">{c.phone}</td>
                <td className="muted">
                  {editId === c.id && draft ? (
                    <select
                      className="inlineInput"
                      value={draft.advisor_id}
                      onChange={(e) => setDraft((d) => ({ ...d, advisor_id: e.target.value }))}
                    >
                      <option value="">—</option>
                      {computed.profiles.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.full_name}
                        </option>
                      ))}
                    </select>
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
                    <select
                      className="inlineInput"
                      value={draft.status}
                      onChange={(e) => setDraft((d) => ({ ...d, status: e.target.value }))}
                    >
                      <option value="active">Active</option>
                      <option value="at_risk">At Risk</option>
                      <option value="inactive">Inactive</option>
                    </select>
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
                    <button className="btnSecondary" type="button" onClick={() => startEdit(c)}>
                      <Pencil size={16} />
                      Edit
                    </button>
                  )}
                </td>
              </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

