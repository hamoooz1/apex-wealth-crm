import { useEffect, useMemo, useState } from 'react'
import { Plus, Search, Save, X } from 'lucide-react'

import { fetchProfilesPageData } from '../lib/queries.js'
import { supabase } from '../lib/supabaseClient.js'
import { useAuth } from '../contexts/AuthContext.jsx'
import { confettiBurst } from '../lib/confetti.js'

import './Leads.css'

function initials(name) {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (!parts.length) return 'L'
  return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase()
}

function fullName(l) {
  return [l.first_name, l.last_name].filter(Boolean).join(' ')
}

function isoToDate(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toISOString().slice(0, 10)
  } catch {
    return ''
  }
}

const leadStatusOptions = [
  'new',
  'contacted',
  'qualified',
  'nurture',
  'lost',
  'converted',
]

async function convertLeadToClient({ leadId, patchLead, leadRow }) {
  // If client already exists for this lead, keep it idempotent.
  const { data: existing, error: existingErr } = await supabase
    .from('clients')
    .select('id')
    .eq('lead_id', leadId)
    .maybeSingle()
  if (existingErr) throw existingErr

  if (!existing) {
    const clientPayload = {
      lead_id: leadId,
      first_name: leadRow.first_name,
      last_name: leadRow.last_name || null,
      email: leadRow.email || null,
      phone: leadRow.phone || null,
      advisor_id: leadRow.assigned_to || null,
      aum: null,
      status: 'active',
      next_review_date: null,
      created_at: new Date().toISOString(),
    }

    const { error: insertErr } = await supabase.from('clients').insert(clientPayload)
    if (insertErr) throw insertErr
  }

  const { data: updatedLead, error: updErr } = await supabase
    .from('leads')
    .update(patchLead)
    .eq('id', leadId)
    .select('*')
    .maybeSingle()
  if (updErr) throw updErr
  return updatedLead
}

export default function Leads() {
  const { profile: me } = useAuth()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [query, setQuery] = useState('')

  const [leads, setLeads] = useState([])
  const [profiles, setProfiles] = useState([])
  const profilesMap = useMemo(
    () => new Map((profiles || []).map((p) => [p.id, p])),
    [profiles],
  )

  const [modalOpen, setModalOpen] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [draft, setDraft] = useState(null)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    let mounted = true
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const [profilesRows, leadsRes] = await Promise.all([
          fetchProfilesPageData(),
          supabase.from('leads').select('*').order('created_at', { ascending: false }),
        ])
        if (leadsRes.error) throw leadsRes.error
        if (!mounted) return
        setProfiles(profilesRows)
        setLeads(leadsRes.data || [])
      } catch (e) {
        if (!mounted) return
        setError(e)
      } finally {
        if (mounted) setLoading(false)
      }
    }
    load()
    return () => {
      mounted = false
    }
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return leads
    return leads.filter((l) => {
      return (
        (l.first_name || '').toLowerCase().includes(q) ||
        (l.last_name || '').toLowerCase().includes(q) ||
        (l.email || '').toLowerCase().includes(q) ||
        (l.phone || '').toLowerCase().includes(q)
      )
    })
  }, [leads, query])

  function advisorName(id) {
    if (!id) return '—'
    return profilesMap.get(id)?.full_name || '—'
  }

  function openCreate() {
    setEditingId(null)
    setDraft({
      first_name: '',
      last_name: '',
      email: '',
      phone: '',
      source: '',
      status: 'new',
      assigned_to: me?.role === 'advisor' ? me.id : '',
      notes: '',
    })
    setDirty(false)
    setModalOpen(true)
  }

  function openEdit(lead) {
    setEditingId(lead.id)
    setDraft({
      first_name: lead.first_name || '',
      last_name: lead.last_name || '',
      email: lead.email || '',
      phone: lead.phone || '',
      source: lead.source || '',
      status: lead.status || 'new',
      assigned_to: lead.assigned_to || '',
      notes: lead.notes || '',
    })
    setDirty(false)
    setModalOpen(true)
  }

  async function saveLead() {
    if (!draft) return
    setSaving(true)
    setError(null)
    try {
      if (editingId) {
        const prev = leads.find((l) => l.id === editingId)
        const patch = {
          ...draft,
          assigned_to: draft.assigned_to || null,
          updated_at: new Date().toISOString(),
        }
        const isConverting = patch.status === 'converted' && prev?.status !== 'converted'
        if (isConverting) {
          const updatedLead = await convertLeadToClient({
            leadId: editingId,
            patchLead: patch,
            leadRow: { ...prev, ...patch },
          })
          confettiBurst()
          setLeads((prevList) =>
            prevList.map((l) => (l.id === editingId ? updatedLead : l)),
          )
        } else {
          const { data, error } = await supabase
            .from('leads')
            .update(patch)
            .eq('id', editingId)
            .select('*')
            .maybeSingle()
          if (error) throw error
          setLeads((prevList) =>
            prevList.map((l) => (l.id === editingId ? data : l)),
          )
        }
      } else {
        const payload = {
          ...draft,
          assigned_to: draft.assigned_to || null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }
        if (payload.status === 'converted') {
          // Create lead first, then convert to client.
          const { data: createdLead, error: createErr } = await supabase
            .from('leads')
            .insert(payload)
            .select('*')
            .maybeSingle()
          if (createErr) throw createErr

          const updatedLead = await convertLeadToClient({
            leadId: createdLead.id,
            patchLead: { status: 'converted', updated_at: new Date().toISOString() },
            leadRow: createdLead,
          })
          confettiBurst()
          setLeads((prevList) => [updatedLead, ...prevList])
        } else {
          const { data, error } = await supabase
            .from('leads')
            .insert(payload)
            .select('*')
            .maybeSingle()
          if (error) throw error
          setLeads((prevList) => [data, ...prevList])
        }
      }
      setDirty(false)
      setModalOpen(false)
    } catch (e) {
      setError(e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div className="pageHeader">
        <div>
          <h1 className="pageTitle">Leads</h1>
          <div className="pageSubtitle">Create, assign, and manage prospects</div>
        </div>

        <div className="leadsHeaderRight">
          <div className="leadsSearch">
            <Search size={16} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search leads…"
            />
          </div>
          <button className="btnPrimary" type="button" onClick={openCreate}>
            <Plus size={16} />
            New Lead
          </button>
        </div>
      </div>

      {error ? (
        <div className="card" style={{ padding: 14, marginBottom: 12 }}>
          <div className="muted">Error: {error.message || 'Something went wrong.'}</div>
        </div>
      ) : null}

      <div className="card tableWrap">
        <table className="crmTable leadsTable">
          <thead>
            <tr>
              <th />
              <th>Name</th>
              <th>Email</th>
              <th>Phone</th>
              <th>Status</th>
              <th>Source</th>
              <th>Assigned</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={9} className="muted">
                  Loading leads…
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={9} className="muted">
                  No leads found.
                </td>
              </tr>
            ) : (
              filtered.map((l) => (
                <tr key={l.id}>
                  <td>
                    <div className="avatar" aria-hidden="true">
                      <div className="leadAvatarText">{initials(fullName(l))}</div>
                    </div>
                  </td>
                  <td>
                    <div className="leadName">{fullName(l) || '—'}</div>
                  </td>
                  <td className="muted">{l.email || '—'}</td>
                  <td className="muted">{l.phone || '—'}</td>
                  <td>
                    <span className="statusPill">{l.status || '—'}</span>
                  </td>
                  <td className="muted">{l.source || '—'}</td>
                  <td className="muted">{advisorName(l.assigned_to)}</td>
                  <td className="muted">{isoToDate(l.created_at) || '—'}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btnSecondary" type="button" onClick={() => openEdit(l)}>
                      Edit
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {modalOpen && draft ? (
        <div className="modalOverlay" role="dialog" aria-modal="true">
          <div className="modalCard">
            <div className="modalHeader">
              <div>
                <div className="modalTitle">{editingId ? 'Edit Lead' : 'New Lead'}</div>
                <div className="modalSub">Lead details and assignment</div>
              </div>
              <button className="iconBtn" type="button" onClick={() => setModalOpen(false)} aria-label="Close">
                <X size={16} />
              </button>
            </div>

            <div className="modalBody">
              <div className="formGrid">
                <label className="sField">
                  <div className="sLabel">First name</div>
                  <input
                    className="sInput"
                    value={draft.first_name}
                    onChange={(e) => {
                      setDraft((d) => ({ ...d, first_name: e.target.value }))
                      setDirty(true)
                    }}
                  />
                </label>
                <label className="sField">
                  <div className="sLabel">Last name</div>
                  <input
                    className="sInput"
                    value={draft.last_name}
                    onChange={(e) => {
                      setDraft((d) => ({ ...d, last_name: e.target.value }))
                      setDirty(true)
                    }}
                  />
                </label>
                <label className="sField">
                  <div className="sLabel">Email</div>
                  <input
                    className="sInput"
                    value={draft.email}
                    onChange={(e) => {
                      setDraft((d) => ({ ...d, email: e.target.value }))
                      setDirty(true)
                    }}
                  />
                </label>
                <label className="sField">
                  <div className="sLabel">Phone</div>
                  <input
                    className="sInput"
                    value={draft.phone}
                    onChange={(e) => {
                      setDraft((d) => ({ ...d, phone: e.target.value }))
                      setDirty(true)
                    }}
                  />
                </label>
                <label className="sField">
                  <div className="sLabel">Source</div>
                  <input
                    className="sInput"
                    value={draft.source}
                    onChange={(e) => {
                      setDraft((d) => ({ ...d, source: e.target.value }))
                      setDirty(true)
                    }}
                  />
                </label>
                <label className="sField">
                  <div className="sLabel">Status</div>
                  <select
                    className="sInput"
                    value={draft.status}
                    onChange={(e) => {
                      setDraft((d) => ({ ...d, status: e.target.value }))
                      setDirty(true)
                    }}
                  >
                    {leadStatusOptions.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="sField">
                  <div className="sLabel">Assigned advisor</div>
                  <select
                    className="sInput"
                    value={draft.assigned_to}
                    onChange={(e) => {
                      setDraft((d) => ({ ...d, assigned_to: e.target.value }))
                      setDirty(true)
                    }}
                  >
                    <option value="">—</option>
                    {profiles
                      .filter((p) => p.role === 'advisor' || p.role === 'manager' || p.role === 'admin')
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.full_name}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="sField" style={{ gridColumn: '1 / -1' }}>
                  <div className="sLabel">Notes</div>
                  <textarea
                    className="sTextarea"
                    value={draft.notes}
                    onChange={(e) => {
                      setDraft((d) => ({ ...d, notes: e.target.value }))
                      setDirty(true)
                    }}
                    rows={4}
                  />
                </label>
              </div>
            </div>

            <div className="modalFooter">
              <button className="btnSecondary" type="button" onClick={() => setModalOpen(false)}>
                Cancel
              </button>
              <button
                className="btnPrimary"
                type="button"
                disabled={!dirty || saving || !draft.first_name}
                onClick={saveLead}
              >
                <Save size={16} />
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

