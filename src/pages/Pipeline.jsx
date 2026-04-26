import { ChevronDown, ChevronRight, Plus, Save, Search, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { fetchPipelinePageData } from '../lib/queries.js'
import { supabase } from '../lib/supabaseClient.js'
import Select from '../components/ui/Select.jsx'
import Avatar from '../components/ui/Avatar.jsx'

function shortDate(iso) {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: '2-digit' })
}

function initials(name) {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  const a = (parts[0] || '').slice(0, 1).toUpperCase()
  const b = (parts[1] || '').slice(0, 1).toUpperCase()
  return (a + b) || '?'
}

export default function Pipeline() {
  const [state, setState] = useState({ loading: true, error: null, data: null })
  const [expandedStageId, setExpandedStageId] = useState(null)
  const [search, setSearch] = useState('')
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
    const advisor = (profileId) => profilesMap.get(profileId) || null

    const stagesOptions = stages.map((s) => ({ value: s.id, label: s.name }))
    return { stages, stagesOptions, pipeline_entries, leadName, advisorName, advisor }
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

  const grouped = useMemo(() => {
    const entries = computed.pipeline_entries || []
    const byStage = new Map()
    for (const stage of computed.stages) byStage.set(stage.id, [])
    for (const e of entries) {
      const list = byStage.get(e.stage_id)
      if (list) list.push(e)
    }
    for (const [k, list] of byStage) {
      byStage.set(
        k,
        list
          .slice()
          .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()),
      )
    }
    const maxCount = Math.max(0, ...Array.from(byStage.values()).map((l) => l.length))
    const topCount = (computed.stages[0] ? (byStage.get(computed.stages[0].id) || []).length : 0) || 0
    return { byStage, maxCount, topCount }
  }, [computed.pipeline_entries, computed.stages])

  const stagePalette = [
    { from: '#f59e0b', to: '#fbbf24' },
    { from: '#fb923c', to: '#fdba74' },
    { from: '#f472b6', to: '#fb7185' },
    { from: '#a78bfa', to: '#c084fc' },
    { from: '#60a5fa', to: '#38bdf8' },
    { from: '#34d399', to: '#22c55e' },
  ]

  return (
    <div>
      <div className="pageHeader">
        <div>
          <h1 className="pageTitle">Sales Funnel</h1>
          <div className="pageSubtitle">Click any stage to see the prospects inside.</div>
        </div>
      </div>

      {state.error ? (
        <div className="card" style={{ padding: 14, marginBottom: 12 }}>
          <div className="muted">Error: {state.error.message || 'Something went wrong.'}</div>
        </div>
      ) : null}

      <div className="card funnelCard">
        <div className="funnelTopRow">
          <div className="funnelSearch">
            <Search size={14} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name…"
              aria-label="Search prospects"
            />
          </div>
        </div>

        <div className="funnelGridHeader" role="row">
          <div className="funnelGridHeaderCell">Stage</div>
          <div className="funnelGridHeaderCell">Prospects</div>
          <div className="funnelGridHeaderCell funnelGridHeaderCellRight">Rate</div>
        </div>

        {state.loading ? (
          <div className="emptyState">Loading funnel…</div>
        ) : computed.stages.length === 0 ? (
          <div className="emptyState">No stages configured</div>
        ) : (
          <div className="funnelList">
            {computed.stages.map((stage, idx) => {
              const items = grouped.byStage.get(stage.id) || []
              const isOpen = expandedStageId === stage.id
              const widthPct =
                grouped.maxCount === 0
                  ? 0
                  : Math.max(6, Math.round((items.length / grouped.maxCount) * 100))
              const ratePct =
                grouped.topCount === 0 ? 0 : Math.round((items.length / grouped.topCount) * 100)

              const q = search.trim().toLowerCase()
              const filteredItems =
                q.length === 0
                  ? items
                  : items.filter((e) => computed.leadName(e.lead_id).toLowerCase().includes(q))

              const colors = stagePalette[idx % stagePalette.length]

              return (
                <div key={stage.id} className="funnelStageItem">
                  <button
                    type="button"
                    className="funnelStageRow"
                    onClick={() =>
                      setExpandedStageId((cur) => (cur === stage.id ? null : stage.id))
                    }
                    aria-expanded={isOpen}
                  >
                    <div className="funnelStageName">
                      {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      <span>{stage.name}</span>
                    </div>

                    <div className="funnelBarWrap" aria-hidden="true">
                      <div
                        className="funnelBar"
                        style={{
                          width: `${widthPct}%`,
                          background: `linear-gradient(90deg, ${colors.from}, ${colors.to})`,
                        }}
                      >
                        <span className="funnelBarCount">{items.length}</span>
                      </div>
                    </div>

                    <div className="funnelRate">{ratePct}%</div>
                  </button>

                  {isOpen ? (
                    <div className="funnelStageDetails">
                      <div className="funnelStageActions">
                        <button
                          className="btnSecondary"
                          type="button"
                          onClick={() => openCreate(stage.id)}
                        >
                          <Plus size={16} />
                          Add opportunity
                        </button>
                      </div>

                      <div className="funnelTable">
                        <div className="funnelTableHead">
                          <div>Client</div>
                          <div>Advisor</div>
                          <div>Last activity</div>
                          <div className="funnelTableRight">In stage</div>
                        </div>

                        {filteredItems.length === 0 ? (
                          <div className="funnelEmpty">No prospects in this stage.</div>
                        ) : (
                          filteredItems.map((e) => {
                            const name = computed.leadName(e.lead_id)
                            return (
                              <div className="funnelTableRow" key={e.id}>
                                <div className="funnelClientCell">
                                  <div className="funnelAvatar">{initials(name)}</div>
                                  <div className="funnelClientName">{name}</div>
                                </div>
                                <div className="funnelAdvisorCell">
                                  {(() => {
                                    const a = computed.advisor(e.assigned_to)
                                    const name = a?.full_name || 'Unassigned'
                                    return (
                                      <div className="funnelAdvisorPill">
                                        <Avatar name={name} src={a?.avatar_url || ''} size="sm" />
                                        <span className="funnelAdvisorName">{name}</span>
                                      </div>
                                    )
                                  })()}
                                </div>
                                <div className="funnelActivityCell">{shortDate(e.updated_at)}</div>
                                <div className="funnelTableRight">
                                  <Select
                                    size="sm"
                                    value={e.stage_id}
                                    onChange={(next) => updateEntry(e.id, { stage_id: next })}
                                    options={computed.stagesOptions}
                                    align="right"
                                    className="pipelineSelect"
                                  />
                                </div>
                              </div>
                            )
                          })
                        )}
                      </div>
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
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

