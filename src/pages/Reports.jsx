import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { fetchReportsPageData } from '../lib/queries.js'
import './Reports.css'

const DAY_MS = 1000 * 60 * 60 * 24

function formatCurrency(n) {
  const v = Number(n || 0)
  return v.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
}

function formatCompact(n) {
  const v = Number(n || 0)
  if (!Number.isFinite(v)) return '—'
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}k`
  return formatCurrency(v)
}

function daysBetween(fromMs, toMs) {
  return Math.round((toMs - fromMs) / DAY_MS)
}

const STATUS_COLORS = {
  active: '#16a34a',
  at_risk: '#f59e0b',
  inactive: '#94a3b8',
}

export default function Reports() {
  const [state, setState] = useState({ loading: true, error: null, data: null })

  useEffect(() => {
    let mounted = true
    async function load() {
      setState({ loading: true, error: null, data: null })
      try {
        const data = await fetchReportsPageData()
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
    const leads = state.data?.leads || []
    const tasks = state.data?.tasks || []
    const entries = state.data?.pipeline_entries || []
    const stages = state.data?.pipeline_stages || []
    const profiles = state.data?.profiles || []
    const profilesMap = new Map(profiles.map((p) => [p.id, p]))
    const profileName = (id) => profilesMap.get(id)?.full_name || 'Unassigned'

    const today = new Date().toISOString().slice(0, 10)
    const reviewHorizon = new Date(Date.now() + 14 * DAY_MS).toISOString().slice(0, 10)

    const totalAum = clients.reduce((s, c) => s + Number(c.aum || 0), 0)
    const activeClients = clients.filter((c) => c.status === 'active').length
    const pipelineValue = entries.reduce((s, e) => s + Number(e.value || 0), 0)
    const overdueTasks = tasks.filter(
      (t) => t.status !== 'done' && t.due_date && t.due_date < today,
    ).length

    const aumByAdvisor = profiles
      .filter((p) => p.role === 'advisor' || p.role === 'manager' || p.role === 'admin')
      .map((p) => {
        const owned = clients.filter((c) => c.advisor_id === p.id)
        const aum = owned.reduce((s, c) => s + Number(c.aum || 0), 0)
        return { name: p.full_name?.split(' ')[0] || 'Advisor', aum, clients: owned.length }
      })
      .filter((r) => r.clients > 0 || r.aum > 0)
      .sort((a, b) => b.aum - a.aum)

    const stageCounts = stages.map((s) => {
      const inStage = entries.filter((e) => e.stage_id === s.id)
      return {
        stage: s.name,
        count: inStage.length,
        value: inStage.reduce((n, e) => n + Number(e.value || 0), 0),
      }
    })

    const clientStatus = ['active', 'at_risk', 'inactive'].map((status) => ({
      name: status === 'at_risk' ? 'At Risk' : status.charAt(0).toUpperCase() + status.slice(1),
      value: clients.filter((c) => c.status === status).length,
      color: STATUS_COLORS[status],
    }))

    const convertedLeads = leads.filter((l) => l.status === 'converted').length
    const conversionRate = leads.length ? Math.round((convertedLeads / leads.length) * 100) : 0

    const staleLeads = leads
      .filter((l) => l.status !== 'converted' && l.status !== 'lost')
      .map((l) => ({
        ...l,
        idleDays: daysBetween(new Date(l.updated_at || l.created_at).getTime(), Date.now()),
      }))
      .filter((l) => l.idleDays >= 7)
      .sort((a, b) => b.idleDays - a.idleDays)

    const reviewsDue = clients
      .filter((c) => c.next_review_date && c.next_review_date <= reviewHorizon)
      .sort((a, b) => String(a.next_review_date).localeCompare(String(b.next_review_date)))

    const advisorStats = profiles
      .filter((p) => p.role === 'advisor' || p.role === 'manager')
      .map((p) => {
        const myClients = clients.filter((c) => c.advisor_id === p.id)
        const myTasks = tasks.filter((t) => t.assigned_to === p.id && t.status !== 'done')
        const myEntries = entries.filter((e) => e.assigned_to === p.id)
        return {
          id: p.id,
          name: p.full_name,
          clients: myClients.length,
          aum: myClients.reduce((s, c) => s + Number(c.aum || 0), 0),
          openTasks: myTasks.length,
          pipeline: myEntries.length,
        }
      })
      .filter((r) => r.clients > 0 || r.pipeline > 0 || r.openTasks > 0)
      .sort((a, b) => b.aum - a.aum)

    return {
      totalAum,
      activeClients,
      pipelineValue,
      overdueTasks,
      conversionRate,
      aumByAdvisor,
      stageCounts,
      clientStatus,
      staleLeads,
      reviewsDue,
      advisorStats,
      profileName,
    }
  }, [state.data])

  return (
    <div className="reportsPage">
      <div className="pageHeader">
        <div>
          <h1 className="pageTitle">Reports</h1>
          <div className="pageSubtitle">AUM, pipeline, and team performance</div>
        </div>
      </div>

      {state.error ? (
        <div className="card" style={{ padding: 14, marginBottom: 12 }}>
          <div className="muted">Error: {state.error.message || 'Failed to load reports.'}</div>
        </div>
      ) : null}

      <div className="repMetrics">
        {[
          { label: 'Total AUM', value: formatCompact(computed.totalAum) },
          { label: 'Active clients', value: computed.activeClients },
          { label: 'Pipeline value', value: formatCompact(computed.pipelineValue) },
          { label: 'Overdue tasks', value: computed.overdueTasks },
          { label: 'Lead conversion', value: `${computed.conversionRate}%` },
        ].map((m) => (
          <div className="card repMetric" key={m.label}>
            <div className="repMetricLabel">{m.label}</div>
            <div className="repMetricValue">{state.loading ? '…' : m.value}</div>
          </div>
        ))}
      </div>

      <div className="repGrid">
        <div className="card repChartCard">
          <div className="cardHeader">
            <div className="cardTitle">AUM by advisor</div>
          </div>
          <div className="chartBody" style={{ height: 280 }}>
            {state.loading ? (
              <div className="repEmpty">Loading…</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={computed.aumByAdvisor}>
                  <XAxis dataKey="name" tickLine={false} axisLine={false} fontSize={11} />
                  <YAxis tickLine={false} axisLine={false} fontSize={11} tickFormatter={(v) => formatCompact(v)} />
                  <Tooltip formatter={(v) => [formatCurrency(v), 'AUM']} />
                  <Bar dataKey="aum" fill="rgba(37, 99, 235, 0.45)" radius={[8, 8, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="card repChartCard">
          <div className="cardHeader">
            <div className="cardTitle">Pipeline by stage</div>
          </div>
          <div className="chartBody" style={{ height: 280 }}>
            {state.loading ? (
              <div className="repEmpty">Loading…</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={computed.stageCounts}>
                  <XAxis dataKey="stage" tickLine={false} axisLine={false} fontSize={11} />
                  <YAxis tickLine={false} axisLine={false} fontSize={11} />
                  <Tooltip
                    formatter={(value, name) =>
                      name === 'value' ? [formatCurrency(value), 'Value'] : [value, 'Count']
                    }
                  />
                  <Bar dataKey="count" fill="rgba(37, 99, 235, 0.35)" radius={[8, 8, 0, 0]} />
                  <Bar dataKey="value" fill="rgba(22, 163, 74, 0.22)" radius={[8, 8, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="card repChartCard">
          <div className="cardHeader">
            <div className="cardTitle">Client status</div>
          </div>
          <div className="chartBody repPieWrap">
            {state.loading ? (
              <div className="repEmpty">Loading…</div>
            ) : (
              <>
                <ResponsiveContainer width="100%" height={220}>
                  <PieChart>
                    <Tooltip formatter={(v) => [v, 'Clients']} />
                    <Pie
                      data={computed.clientStatus}
                      dataKey="value"
                      nameKey="name"
                      innerRadius={50}
                      outerRadius={78}
                      paddingAngle={2}
                    >
                      {computed.clientStatus.map((entry) => (
                        <Cell key={entry.name} fill={entry.color} />
                      ))}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
                <div className="donutLegend">
                  {computed.clientStatus.map((d) => (
                    <div className="legendRow" key={d.name}>
                      <span className="legendDot" style={{ background: d.color }} />
                      {d.name} ({d.value})
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="repTables">
        <div className="card">
          <div className="cardHeader">
            <div className="cardTitle">Advisor leaderboard</div>
          </div>
          <div className="tableWrap">
            <table className="crmTable">
              <thead>
                <tr>
                  <th>Advisor</th>
                  <th>Clients</th>
                  <th>AUM</th>
                  <th>Open tasks</th>
                  <th>Pipeline</th>
                </tr>
              </thead>
              <tbody>
                {state.loading ? (
                  <tr>
                    <td colSpan={5} className="muted">
                      Loading…
                    </td>
                  </tr>
                ) : computed.advisorStats.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="muted">
                      No advisor data yet.
                    </td>
                  </tr>
                ) : (
                  computed.advisorStats.map((a) => (
                    <tr key={a.id}>
                      <td>{a.name}</td>
                      <td>{a.clients}</td>
                      <td>{formatCurrency(a.aum)}</td>
                      <td>{a.openTasks}</td>
                      <td>{a.pipeline}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="cardHeader">
            <div className="cardTitle">Reviews due (14 days)</div>
          </div>
          <div className="tableWrap">
            <table className="crmTable">
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Advisor</th>
                  <th>Review date</th>
                </tr>
              </thead>
              <tbody>
                {state.loading ? (
                  <tr>
                    <td colSpan={3} className="muted">
                      Loading…
                    </td>
                  </tr>
                ) : computed.reviewsDue.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="muted">
                      No reviews due in the next 14 days.
                    </td>
                  </tr>
                ) : (
                  computed.reviewsDue.slice(0, 12).map((c) => (
                    <tr key={c.id}>
                      <td>
                        <Link to={`/clients/${c.id}`} className="clientLink">
                          {c.first_name} {c.last_name}
                        </Link>
                      </td>
                      <td className="muted">{computed.profileName(c.advisor_id)}</td>
                      <td className="muted">{c.next_review_date}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="cardHeader">
            <div className="cardTitle">Stale leads (7+ days idle)</div>
          </div>
          <div className="tableWrap">
            <table className="crmTable">
              <thead>
                <tr>
                  <th>Lead</th>
                  <th>Status</th>
                  <th>Assigned</th>
                  <th>Idle</th>
                </tr>
              </thead>
              <tbody>
                {state.loading ? (
                  <tr>
                    <td colSpan={4} className="muted">
                      Loading…
                    </td>
                  </tr>
                ) : computed.staleLeads.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="muted">
                      No stale leads.
                    </td>
                  </tr>
                ) : (
                  computed.staleLeads.slice(0, 12).map((l) => (
                    <tr key={l.id}>
                      <td>
                        {l.first_name} {l.last_name}
                      </td>
                      <td className="muted">{l.status}</td>
                      <td className="muted">{computed.profileName(l.assigned_to)}</td>
                      <td>{l.idleDays}d</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}
