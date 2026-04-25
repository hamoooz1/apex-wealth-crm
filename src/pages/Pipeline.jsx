import { DollarSign, Percent, Clock3, Plus, Save, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { fetchPipelinePageData } from '../lib/queries.js'
import { supabase } from '../lib/supabaseClient.js'
import Select from '../components/ui/Select.jsx'

function formatCurrency(n) {
  const v = Number(n || 0)
  return v.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  })
}

function shortDate(iso) {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: '2-digit' })
}

export default function Pipeline() {
  const [state, setState] = useState({ loading: true, error: null, data: null })
  const [editingId, setEditingId] = useState(null)
  const [editDraft, setEditDraft] = useState(null)
  const [saving, setSaving] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [createStageId, setCreateStageId] = useState(null)
  const [createDraft, setCreateDraft] = useState(null)
  const [createSaving, setCreateSaving] = useState(false)

  useEffect(() => {
    let mounted = true
    async function load() {
      setState({ loading: true, error: null, data: null })
      try {
        const data = await fetchPipelinePageData()
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
    const pipeline_stages = state.data?.pipeline_stages || []
    const pipeline_entries = state.data?.pipeline_entries || []
    const leads = state.data?.leads || []
    const profiles = state.data?.profiles || []

    const leadsMap = new Map(leads.map((l) => [l.id, l]))
    const profilesMap = new Map(profiles.map((p) => [p.id, p]))

    const stages = pipeline_stages
      .filter((s) => s.is_active !== false)
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order)

    const leadName = (leadId) => {
      const l = leadsMap.get(leadId)
      return l ? `${l.first_name} ${l.last_name}` : 'Unknown Lead'
    }
    const advisorName = (profileId) => {
      const p = profilesMap.get(profileId)
      return p ? p.full_name : 'Unknown'
    }

    const stagesOptions = stages.map((s) => ({ value: s.id, label: s.name }))
    const leadsOptions = leads
      .slice()
      .sort((a, b) => String(a.first_name || '').localeCompare(String(b.first_name || '')))
      .map((l) => ({
        value: l.id,
        label: `${l.first_name || ''} ${l.last_name || ''}`.trim() || l.email || 'Lead',
      }))
    return { stages, stagesOptions, pipeline_entries, leadName, advisorName }
  }, [state.data, state.loading, state.error])

  const leadsOptions = useMemo(() => {
    const leads = state.data?.leads || []
    return leads
      .slice()
      .sort((a, b) => String(a.first_name || '').localeCompare(String(b.first_name || '')))
      .map((l) => ({
        value: l.id,
        label: `${l.first_name || ''} ${l.last_name || ''}`.trim() || l.email || 'Lead',
      }))
  }, [state.data])

  const profilesOptions = useMemo(() => {
    const profiles = state.data?.profiles || []
    return profiles.map((p) => ({ value: p.id, label: p.full_name }))
  }, [state.data])

  function openCreate(stageId) {
    setCreateStageId(stageId)
    setCreateDraft({
      lead_id: '',
      assigned_to: '',
      value: '',
      probability: 20,
    })
    setCreateOpen(true)
  }

  function closeCreate() {
    setCreateOpen(false)
    setCreateStageId(null)
    setCreateDraft(null)
  }

  async function createEntry() {
    if (!createDraft?.lead_id || !createStageId) return
    setCreateSaving(true)
    setState((s) => ({ ...s, error: null }))
    try {
      // prevent duplicates (one pipeline entry per lead)
      const existing = (state.data?.pipeline_entries || []).some(
        (e) => e.lead_id === createDraft.lead_id,
      )
      if (existing) {
        throw new Error('This lead already has a pipeline entry.')
      }

      const payload = {
        lead_id: createDraft.lead_id,
        stage_id: createStageId,
        assigned_to: createDraft.assigned_to || null,
        value: createDraft.value === '' ? null : Number(createDraft.value),
        probability:
          createDraft.probability === '' ? null : Number(createDraft.probability),
        entered_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      const { data, error } = await supabase
        .from('pipeline_entries')
        .insert(payload)
        .select('*')
        .maybeSingle()
      if (error) throw error

      setState((s) => ({
        ...s,
        data: {
          ...s.data,
          pipeline_entries: [data, ...(s.data?.pipeline_entries || [])],
        },
      }))

      closeCreate()
    } catch (e) {
      setState((s) => ({ ...s, error: e }))
    } finally {
      setCreateSaving(false)
    }
  }

  async function updateEntry(entryId, patch) {
    setState((s) => ({ ...s, error: null }))
    // optimistic
    setState((s) => ({
      ...s,
      data: {
        ...s.data,
        pipeline_entries: (s.data?.pipeline_entries || []).map((e) =>
          e.id === entryId ? { ...e, ...patch } : e,
        ),
      },
    }))
    try {
      const { data, error } = await supabase
        .from('pipeline_entries')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', entryId)
        .select('*')
        .maybeSingle()
      if (error) throw error
      setState((s) => ({
        ...s,
        data: {
          ...s.data,
          pipeline_entries: (s.data?.pipeline_entries || []).map((e) =>
            e.id === entryId ? data : e,
          ),
        },
      }))
    } catch (e) {
      setState((s) => ({ ...s, error: e }))
      // reload best-effort
      try {
        const data = await fetchPipelinePageData()
        setState({ loading: false, error: e, data })
      } catch {
        // ignore
      }
    }
  }

  function openEdit(e) {
    setEditingId(e.id)
    setEditDraft({
      value: e.value ?? '',
      probability: e.probability ?? '',
    })
  }

  function closeEdit() {
    setEditingId(null)
    setEditDraft(null)
  }

  async function saveEdit(entryId) {
    if (!editDraft) return
    setSaving(true)
    try {
      await updateEntry(entryId, {
        value: editDraft.value === '' ? null : Number(editDraft.value),
        probability:
          editDraft.probability === '' ? null : Number(editDraft.probability),
      })
      closeEdit()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div className="pageHeader">
        <div>
          <h1 className="pageTitle">Pipeline</h1>
          <div className="pageSubtitle">Track opportunities by stage</div>
        </div>
      </div>

      {state.error ? (
        <div className="card" style={{ padding: 14, marginBottom: 12 }}>
          <div className="muted">Error: {state.error.message || 'Something went wrong.'}</div>
        </div>
      ) : null}

      <div className="pipelineBoard">
        {computed.stages.map((stage) => {
          const items = (computed.pipeline_entries || [])
            .filter((e) => e.stage_id === stage.id)
            .slice()
            .sort(
              (a, b) =>
                new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
            )

          return (
            <div className="kanbanCol" key={stage.id}>
              <div className="kanbanColHeader">
                <div className="kanbanColTitle">{stage.name}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div className="pillCount">{items.length} cards</div>
                  <button
                    className="iconBtn"
                    type="button"
                    aria-label="Add pipeline entry"
                    onClick={() => openCreate(stage.id)}
                  >
                    <Plus size={16} />
                  </button>
                </div>
              </div>

              {state.loading ? (
                <div className="emptyState">Loading pipeline…</div>
              ) : state.error ? (
                <div className="emptyState">Failed to load pipeline.</div>
              ) : items.length === 0 ? (
                <div className="emptyState">No opportunities</div>
              ) : (
                items.map((e) => (
                  <div className="taskCard" key={e.id}>
                    <div className="pipelineTitle">{computed.leadName(e.lead_id)}</div>
                    <div className="pipelineSub">{computed.advisorName(e.assigned_to)}</div>
                    <div className="taskMeta">
                      <Select
                        size="sm"
                        value={e.stage_id}
                        onChange={(next) => updateEntry(e.id, { stage_id: next })}
                        options={computed.stagesOptions}
                        className="pipelineSelect"
                      />
                      <span className="tag">
                        <DollarSign size={14} />
                        {editingId === e.id ? (
                          <input
                            className="inlineInput"
                            style={{ minWidth: 90, height: 28 }}
                            type="number"
                            value={editDraft?.value ?? ''}
                            onChange={(ev) =>
                              setEditDraft((d) => ({ ...d, value: ev.target.value }))
                            }
                            placeholder="0"
                          />
                        ) : (
                          formatCurrency(e.value)
                        )}
                      </span>
                      <span className="tag">
                        <Percent size={14} />
                        {editingId === e.id ? (
                          <input
                            className="inlineInput"
                            style={{ minWidth: 80, height: 28 }}
                            type="number"
                            value={editDraft?.probability ?? ''}
                            onChange={(ev) =>
                              setEditDraft((d) => ({ ...d, probability: ev.target.value }))
                            }
                            placeholder="0"
                          />
                        ) : (
                          `${e.probability ?? 0}%`
                        )}
                      </span>
                      <span className="tag">
                        <Clock3 size={14} />
                        {shortDate(e.updated_at)}
                      </span>
                      {editingId === e.id ? (
                        <span style={{ display: 'inline-flex', gap: 8 }}>
                          <button
                            className="btnSecondary"
                            type="button"
                            onClick={closeEdit}
                            disabled={saving}
                          >
                            Cancel
                          </button>
                          <button
                            className="btnPrimary"
                            type="button"
                            onClick={() => saveEdit(e.id)}
                            disabled={saving}
                          >
                            {saving ? 'Saving…' : 'Save'}
                          </button>
                        </span>
                      ) : (
                        <button
                          className="btnSecondary"
                          type="button"
                          onClick={() => openEdit(e)}
                        >
                          Edit
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          )
        })}
      </div>

      {createOpen && createDraft ? (
        <div className="modalOverlay" role="dialog" aria-modal="true">
          <div className="modalCard">
            <div className="modalHeader">
              <div>
                <div className="modalTitle">Add Opportunity</div>
                <div className="modalSub">Create a pipeline entry for a lead</div>
              </div>
              <button className="iconBtn" type="button" onClick={closeCreate} aria-label="Close">
                <X size={16} />
              </button>
            </div>

            <div className="modalBody">
              <div className="formGrid">
                <label className="sField" style={{ gridColumn: '1 / -1' }}>
                  <div className="sLabel">Lead</div>
                  <Select
                    value={createDraft.lead_id}
                    onChange={(v) =>
                      setCreateDraft((d) => ({ ...d, lead_id: v }))
                    }
                    options={leadsOptions}
                    placeholder="Select a lead…"
                  />
                </label>

                <label className="sField">
                  <div className="sLabel">Assigned to</div>
                  <Select
                    value={createDraft.assigned_to}
                    onChange={(v) =>
                      setCreateDraft((d) => ({ ...d, assigned_to: v }))
                    }
                    options={profilesOptions}
                    placeholder="Unassigned"
                  />
                </label>

                <label className="sField">
                  <div className="sLabel">Value</div>
                  <input
                    className="sInput"
                    type="number"
                    value={createDraft.value}
                    onChange={(e) =>
                      setCreateDraft((d) => ({ ...d, value: e.target.value }))
                    }
                    placeholder="0"
                  />
                </label>

                <label className="sField">
                  <div className="sLabel">Probability</div>
                  <input
                    className="sInput"
                    type="number"
                    value={createDraft.probability}
                    onChange={(e) =>
                      setCreateDraft((d) => ({ ...d, probability: e.target.value }))
                    }
                    placeholder="20"
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
                onClick={createEntry}
                disabled={!createDraft.lead_id || createSaving}
              >
                <Save size={16} />
                {createSaving ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

