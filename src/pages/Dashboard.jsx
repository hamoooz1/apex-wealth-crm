import { useEffect, useMemo, useState } from 'react'
import { fetchDashboardData } from '../lib/queries.js'

import {
  ArrowUpRight,
  Briefcase,
  CheckCircle2,
  CircleDollarSign,
  ClipboardList,
  LineChart,
  UsersRound,
  CalendarDays,
} from 'lucide-react'

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

function formatCurrency(n) {
  const v = Number(n || 0)
  return v.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  })
}

function formatCompact(n) {
  const v = Number(n || 0)
  if (!Number.isFinite(v)) return '-'
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`
  return String(v)
}

function formatDateTime(iso) {
  const d = new Date(iso)
  return d.toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function Dashboard() {
  const [state, setState] = useState({
    loading: true,
    error: null,
    data: null,
  })

  useEffect(() => {
    let mounted = true
    async function load() {
      setState({ loading: true, error: null, data: null })
      try {
        const data = await fetchDashboardData()
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
    const data = state.data
    const leads = data?.leads || []
    const clients = data?.clients || []
    const tasks = data?.tasks || []
    const meetings = data?.meetings || []
    const pipeline_entries = data?.pipeline_entries || []
    const pipeline_stages = data?.pipeline_stages || []
    const activity_logs = data?.activity_logs || []
    const profiles = data?.profiles || []

    const leadsMap = new Map(leads.map((l) => [l.id, l]))
    const profilesMap = new Map(profiles.map((p) => [p.id, p]))

    const newLeads = leads.filter((l) => {
      const created = new Date(l.created_at)
      const days = (Date.now() - created.getTime()) / (1000 * 60 * 60 * 24)
      return days <= 7
    }).length

    const activePipelineValue = pipeline_entries.reduce(
      (sum, e) => sum + Number(e.value || 0),
      0,
    )
    const closedClients = clients.length
    const totalProspects = leads.length + clients.length
    const totalAum = clients.reduce((sum, c) => sum + Number(c.aum || 0), 0)
    const conversionRate = totalProspects
      ? Math.round((clients.length / totalProspects) * 100)
      : 0

    const meetingsThisWeek = meetings.filter((m) => {
      const start = new Date(m.start_time).getTime()
      const days = (start - Date.now()) / (1000 * 60 * 60 * 24)
      return days >= 0 && days <= 7
    }).length

    const overdueTasks = tasks.filter((t) => {
      if (t.status === 'done') return false
      if (!t.due_date) return false
      return (
        new Date(t.due_date).getTime() < new Date().setHours(0, 0, 0, 0)
      )
    }).length

    const stageCounts = pipeline_stages
      .filter((s) => s.is_active !== false)
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((s) => ({
        stage: s.name,
        count: pipeline_entries.filter((e) => e.stage_id === s.id).length,
        value: pipeline_entries
          .filter((e) => e.stage_id === s.id)
          .reduce((sum, e) => sum + Number(e.value || 0), 0),
      }))

    const donutData = [
      {
        name: 'Active Clients',
        value: clients.filter((c) => c.status === 'active').length,
        color: '#2563eb',
      },
      {
        name: 'At Risk',
        value: clients.filter((c) => c.status === 'at_risk').length,
        color: '#f59e0b',
      },
      {
        name: 'Inactive',
        value: clients.filter((c) => c.status === 'inactive').length,
        color: '#94a3b8',
      },
    ].filter((x) => x.value > 0)

    const leadName = (leadId) => {
      const l = leadsMap.get(leadId)
      return l ? `${l.first_name} ${l.last_name}` : 'Unknown Lead'
    }

    const profileName = (profileId) => {
      const p = profilesMap.get(profileId)
      return p ? p.full_name : 'Unknown'
    }

    return {
      leads,
      clients,
      tasks,
      meetings,
      pipeline_entries,
      pipeline_stages,
      activity_logs,
      profiles,
      newLeads,
      activePipelineValue,
      closedClients,
      totalProspects,
      totalAum,
      conversionRate,
      meetingsThisWeek,
      overdueTasks,
      stageCounts,
      donutData,
      leadName,
      profileName,
    }
  }, [state.data, state.loading, state.error])

  const metrics = [
    {
      label: 'New Leads',
      value: String(computed.newLeads || 0),
      helper: 'Last 7 days',
      badge: 'blue',
      icon: UsersRound,
    },
    {
      label: 'Active Pipeline',
      value: formatCurrency(computed.activePipelineValue || 0),
      helper: 'Open opportunities',
      badge: 'blue',
      icon: LineChart,
    },
    {
      label: 'Closed Clients',
      value: String(computed.closedClients || 0),
      helper: 'Converted clients',
      badge: 'green',
      icon: Briefcase,
    },
    {
      label: 'Total Prospects',
      value: String(computed.totalProspects || 0),
      helper: 'Leads + clients',
      badge: 'blue',
      icon: ClipboardList,
    },
    {
      label: 'Total AUM',
      value: formatCurrency(computed.totalAum || 0),
      helper: 'Assets under management',
      badge: 'green',
      icon: CircleDollarSign,
    },
    {
      label: 'Conversion Rate',
      value: `${computed.conversionRate || 0}%`,
      helper: 'Prospects → clients',
      badge: 'blue',
      icon: ArrowUpRight,
    },
    {
      label: 'Meetings This Week',
      value: String(computed.meetingsThisWeek || 0),
      helper: 'Scheduled calls',
      badge: 'blue',
      icon: CalendarDays,
    },
    {
      label: 'Overdue Tasks',
      value: String(computed.overdueTasks || 0),
      helper: 'Needs attention',
      badge: computed.overdueTasks ? 'red' : 'amber',
      icon: CheckCircle2,
    },
  ]

  return (
    <div>
      <div className="pageHeader">
        <div>
          <h1 className="pageTitle">Dashboard</h1>
          <div className="pageSubtitle">
            Apex Wealth overview and performance snapshot
          </div>
        </div>
      </div>

      <div className="gridMetrics">
        {metrics.map((m) => {
          const Icon = m.icon
          return (
            <div className="card metricCard" key={m.label}>
              <div className="metricTop">
                <div>
                  <div className="metricLabel">{m.label}</div>
                  <div className="metricValue">{m.value}</div>
                </div>
                <div className={['iconBadge', m.badge].join(' ')}>
                  <Icon size={16} />
                </div>
              </div>
              <div className="metricHelper">{m.helper}</div>
            </div>
          )
        })}
      </div>

      <div className="dashLower">
        <div className="card">
          <div className="cardHeader">
            <div className="cardTitle">Pipeline by Stage</div>
            <div className="muted">Open opportunities</div>
          </div>
          <div className="chartBody" style={{ height: 300 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={computed.stageCounts || []}>
                <XAxis
                  dataKey="stage"
                  tickLine={false}
                  axisLine={false}
                  fontSize={11}
                />
                <YAxis tickLine={false} axisLine={false} fontSize={11} />
                <Tooltip
                  cursor={{ fill: 'rgba(2, 6, 23, 0.03)' }}
                  formatter={(value, name) => {
                    if (name === 'value') return [formatCurrency(value), 'Value']
                    return [value, 'Count']
                  }}
                />
                <Bar
                  dataKey="count"
                  fill="rgba(37, 99, 235, 0.35)"
                  radius={[10, 10, 0, 0]}
                />
                <Bar
                  dataKey="value"
                  fill="rgba(22, 163, 74, 0.22)"
                  radius={[10, 10, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="dashRightCol">
          <div className="card">
            <div className="cardHeader">
              <div className="cardTitle">Distribution</div>
              <div className="muted">Client status</div>
            </div>
            <div className="chartBody" style={{ height: 300 }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Tooltip formatter={(v) => [v, 'Clients']} />
                  <Pie
                    data={computed.donutData || []}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={58}
                    outerRadius={86}
                    paddingAngle={2}
                  >
                    {(computed.donutData || []).map((entry) => (
                      <Cell key={entry.name} fill={entry.color} />
                    ))}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>

              <div className="donutLegend">
                {(computed.donutData || []).map((d) => (
                  <div className="legendRow" key={d.name}>
                    <span className="legendDot" style={{ background: d.color }} />
                    <span className="legendName">{d.name}</span>
                    <span className="legendVal">{d.value}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="cardHeader">
              <div className="cardTitle">Recent Activity</div>
              <div className="muted">Audit log</div>
            </div>
            <div className="activityBody">
              {state.loading ? (
                <div className="emptyState">Loading activity…</div>
              ) : state.error ? (
                <div className="emptyState">Failed to load dashboard data.</div>
              ) : (computed.activity_logs || []).length === 0 ? (
                <div className="emptyState">No activity yet</div>
              ) : (computed.activity_logs || [])
                .slice(0, 6)
                .map((a) => (
                  <div className="activityRow" key={a.id}>
                    <div className="activityDot" aria-hidden="true" />
                    <div className="activityMain">
                      <div className="activityTitle">
                        <span className="activityActor">
                          {computed.profileName(a.actor_id)}
                        </span>
                        <span className="activityAction">{a.action}</span>
                        {a.lead_id ? (
                          <span className="activityTarget">
                            {computed.leadName(a.lead_id)}
                          </span>
                        ) : null}
                      </div>
                      <div className="activityMeta">
                        {formatDateTime(a.created_at)}
                      </div>
                    </div>
                    <div className="activityValue">
                      {a.details?.title ? a.details.title : formatCompact(a.details?.value)}
                    </div>
                  </div>
                ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

