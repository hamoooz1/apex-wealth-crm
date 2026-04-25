import { Plus, Percent, DollarSign, Clock3 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { fetchPipelinePageData } from '../lib/queries.js'

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

    return { stages, pipeline_entries, leadName, advisorName }
  }, [state.data, state.loading, state.error])

  return (
    <div>
      <div className="pageHeader">
        <div>
          <h1 className="pageTitle">Pipeline</h1>
          <div className="pageSubtitle">Track opportunities by stage</div>
        </div>
      </div>

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
                  <button className="iconBtn" type="button" aria-label="Add pipeline entry">
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
                      <span className="tag">
                        <DollarSign size={14} />
                        {formatCurrency(e.value)}
                      </span>
                      <span className="tag">
                        <Percent size={14} />
                        {e.probability}%
                      </span>
                      <span className="tag">
                        <Clock3 size={14} />
                        {shortDate(e.updated_at)}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

