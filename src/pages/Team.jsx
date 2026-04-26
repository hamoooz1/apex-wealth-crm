import { useEffect, useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import './Team.css'
import { fetchTeamProfilesPageData } from '../lib/queries.js'
import Avatar from '../components/ui/Avatar.jsx'

function roleLabel(role) {
  if (role === 'admin') return 'Admin'
  if (role === 'manager') return 'Manager'
  return 'Advisor'
}

function fmtMoney(n) {
  const x = Number(n || 0)
  if (!Number.isFinite(x)) return '$0'
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0,
    }).format(x)
  } catch {
    return `$${Math.round(x).toLocaleString()}`
  }
}

function startOfMonth(d) {
  const x = new Date(d)
  x.setDate(1)
  x.setHours(0, 0, 0, 0)
  return x
}

export default function Team() {
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [data, setData] = useState(null)

  useEffect(() => {
    let mounted = true
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const rows = await fetchTeamProfilesPageData()
        if (!mounted) return
        setData(rows)
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

  const computed = useMemo(() => {
    const profiles = (data?.profiles || []).filter((p) => p.is_active !== false)
    const stages = (data?.pipeline_stages || []).filter((s) => s.is_active !== false)
    const entries = data?.pipeline_entries || []
    const meetings = data?.meetings || []
    const clients = data?.clients || []

    const stageNameById = new Map(stages.map((s) => [s.id, s.name]))
    const isTerminalStage = (stageId) => {
      const n = String(stageNameById.get(stageId) || '').toLowerCase()
      return (
        n.includes('closed won') ||
        n.includes('closed lost') ||
        n.includes('lost') ||
        n.includes('not proceeding') ||
        n.includes('no show') ||
        n.includes('cancel')
      )
    }

    const now = new Date()
    const monthStart = startOfMonth(now)
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1)

    const byAdvisor = new Map()
    for (const p of profiles) {
      byAdvisor.set(p.id, {
        profile: p,
        activePipelineValue: 0,
        meetingsThisMonth: 0,
        aumManaged: 0,
        closedClients: 0,
        notProceeding: 0,
        totalOpps: 0,
        byStageCount: new Map(stages.map((s) => [s.id, 0])),
      })
    }

    for (const c of clients) {
      const b = byAdvisor.get(c.advisor_id)
      if (!b) continue
      b.aumManaged += Number(c.aum || 0) || 0
      b.closedClients += 1
    }

    for (const m of meetings) {
      const b = byAdvisor.get(m.advisor_id)
      if (!b) continue
      const t = new Date(m.start_time)
      if (t >= monthStart && t < monthEnd) b.meetingsThisMonth += 1
    }

    for (const e of entries) {
      const b = byAdvisor.get(e.assigned_to)
      if (!b) continue
      b.totalOpps += 1
      if (b.byStageCount.has(e.stage_id)) {
        b.byStageCount.set(e.stage_id, (b.byStageCount.get(e.stage_id) || 0) + 1)
      }

      const stageName = String(stageNameById.get(e.stage_id) || '').toLowerCase()
      if (!isTerminalStage(e.stage_id)) {
        b.activePipelineValue += Number(e.value || 0) || 0
      }
      if (
        stageName.includes('lost') ||
        stageName.includes('not proceeding') ||
        stageName.includes('no show') ||
        stageName.includes('cancel')
      ) {
        b.notProceeding += 1
      }
    }

    const stagePalette = [
      { from: '#2563eb', to: '#3b82f6' },
      { from: '#f59e0b', to: '#fbbf24' },
      { from: '#fb923c', to: '#fdba74' },
      { from: '#f472b6', to: '#fb7185' },
      { from: '#a78bfa', to: '#c084fc' },
      { from: '#34d399', to: '#22c55e' },
      { from: '#0ea5e9', to: '#38bdf8' },
    ]

    const cards = Array.from(byAdvisor.values()).map((b) => {
      // Team page conversion: clients / (clients + pipeline opportunities)
      const denom = b.totalOpps + b.closedClients
      const conversionRate = denom === 0 ? 0 : Math.round((b.closedClients / denom) * 100)

      const stageRows = stages.map((s, idx) => {
        const count = b.byStageCount.get(s.id) || 0
        const colors = stagePalette[idx % stagePalette.length]
        return { stage: s, count, colors }
      })

      const max = Math.max(0, ...stageRows.map((r) => r.count))
      return {
        profile: b.profile,
        metrics: {
          activePipelineValue: b.activePipelineValue,
          meetingsThisMonth: b.meetingsThisMonth,
          aumManaged: b.aumManaged,
          closedClients: b.closedClients,
          notProceeding: b.notProceeding,
          conversionRate,
        },
        stageRows,
        maxStageCount: max,
      }
    })

    return { profiles, stages, cards }
  }, [data])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return computed.cards
    return computed.cards.filter(({ profile: p }) => {
      return (
        String(p.full_name || '').toLowerCase().includes(q) ||
        String(p.email || '').toLowerCase().includes(q)
      )
    })
  }, [computed.cards, query])

  return (
    <div>
      <div className="pageHeader">
        <div>
          <h1 className="pageTitle">Team Profiles</h1>
          <div className="pageSubtitle">Active employees and performance metrics</div>
        </div>

        <div className="teamHeaderRight">
          <div className="teamSearch">
            <Search size={16} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name or email…"
            />
          </div>
        </div>
      </div>

      {error ? (
        <div className="card" style={{ padding: 14, marginBottom: 12 }}>
          <div className="muted">Error: {error.message || 'Failed to load team profiles.'}</div>
        </div>
      ) : null}

      <div className="teamCards">
        {loading ? (
          <div className="card" style={{ padding: 14 }}>
            <div className="muted">Loading team…</div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="card" style={{ padding: 14 }}>
            <div className="muted">No active employees match your search.</div>
          </div>
        ) : (
          filtered.map(({ profile: p, metrics, stageRows, maxStageCount }) => (
            <div className="card teamPerfCard" key={p.id}>
              <div className="teamPerfHeader">
                <div className="teamPerfLeft">
                  <Avatar name={p.full_name} src={p.avatar_url || ''} size="xl" />
                  <div>
                    <div className="teamPerfNameRow">
                      <div className="teamPerfName">{p.full_name}</div>
                      <span className={['roleBadge', `role-${p.role}`].join(' ')}>
                        {roleLabel(p.role)}
                      </span>
                    </div>
                    <div className="teamPerfEmail">{p.email}</div>
                  </div>
                </div>
              </div>

              <div className="teamPerfMetrics">
                <div className="teamPerfMetric">
                  <div className="teamPerfMetricValue">{fmtMoney(metrics.activePipelineValue)}</div>
                  <div className="teamPerfMetricLabel">Active Pipeline</div>
                </div>
                <div className="teamPerfMetric">
                  <div className="teamPerfMetricValue">{metrics.meetingsThisMonth}</div>
                  <div className="teamPerfMetricLabel">Meetings This Month</div>
                </div>
                <div className="teamPerfMetric">
                  <div className="teamPerfMetricValue">{fmtMoney(metrics.aumManaged)}</div>
                  <div className="teamPerfMetricLabel">AUM Managed</div>
                </div>
                <div className="teamPerfMetric">
                  <div className="teamPerfMetricValue">{metrics.closedClients}</div>
                  <div className="teamPerfMetricLabel">Closed Clients</div>
                </div>
                <div className="teamPerfMetric">
                  <div className="teamPerfMetricValue">{metrics.notProceeding}</div>
                  <div className="teamPerfMetricLabel">Not Proceeding</div>
                </div>
                <div className="teamPerfMetric">
                  <div className="teamPerfMetricValue">{metrics.conversionRate}%</div>
                  <div className="teamPerfMetricLabel">Conversion Rate</div>
                </div>
              </div>

              <div className="teamPerfBreakdown">
                <div className="teamPerfBreakdownTitle">Pipeline Breakdown</div>
                <div className="teamPerfBreakdownRows">
                  {stageRows.map((r) => {
                    const w =
                      maxStageCount === 0 ? 0 : Math.max(6, Math.round((r.count / maxStageCount) * 100))
                    return (
                      <div className="teamPerfStageRow" key={r.stage.id}>
                        <div className="teamPerfStageName">{r.stage.name}</div>
                        <div className="teamPerfStageBarWrap">
                          <div
                            className="teamPerfStageBar"
                            style={{
                              width: `${w}%`,
                              background: `linear-gradient(90deg, ${r.colors.from}, ${r.colors.to})`,
                            }}
                          />
                        </div>
                        <div className="teamPerfStageCount">{r.count}</div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

