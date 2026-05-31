import { useEffect, useMemo, useState } from 'react'
import { fetchDashboardData } from '../lib/queries.js'
import { humanizeAction } from '../lib/activity.js'
import Avatar from '../components/ui/Avatar.jsx'

import {
  ArrowUpRight,
  Briefcase,
  CheckCircle2,
  CircleDollarSign,
  ClipboardList,
  LineChart,
  UsersRound,
  CalendarDays,
  AlertTriangle,
  CalendarClock,
  Hourglass,
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

function formatDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
  })
}

const DAY_MS = 1000 * 60 * 60 * 24

function daysBetween(fromMs, toMs) {
  return Math.round((toMs - fromMs) / DAY_MS)
}

function formatFromTo(fromVal, toVal, { kind = 'text', fmt } = {}) {
  const f = fromVal == null || fromVal === '' ? '—' : fromVal
  const t = toVal == null || toVal === '' ? '—' : toVal
  if (fmt) return `${fmt(f)} → ${fmt(t)}`
  if (kind === 'number') return `${Number(f)} → ${Number(t)}`
  return `${String(f)} → ${String(t)}`
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
    const clientsMap = new Map(clients.map((c) => [c.id, c]))
    const stagesMap = new Map(pipeline_stages.map((s) => [s.id, s]))

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

    const todayStart = new Date().setHours(0, 0, 0, 0)
    const reviewHorizon = todayStart + 14 * DAY_MS

    const overdueTasksList = tasks
      .filter(
        (t) =>
          t.status !== 'done' &&
          t.due_date &&
          new Date(t.due_date).getTime() < todayStart,
      )
      .sort((a, b) => new Date(a.due_date) - new Date(b.due_date))

    const upcomingReviews = clients
      .filter(
        (c) =>
          c.next_review_date &&
          new Date(c.next_review_date).getTime() <= reviewHorizon,
      )
      .sort((a, b) => new Date(a.next_review_date) - new Date(b.next_review_date))

    const staleLeads = leads
      .filter((l) => {
        const status = String(l.status || '').toLowerCase()
        if (status === 'converted' || status === 'lost') return false
        const ts = new Date(l.updated_at || l.created_at).getTime()
        return Date.now() - ts >= 14 * DAY_MS
      })
      .sort(
        (a, b) =>
          new Date(a.updated_at || a.created_at) -
          new Date(b.updated_at || b.created_at),
      )

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

    const clientName = (clientId) => {
      const c = clientsMap.get(clientId)
      if (!c) return 'Unknown Client'
      return `${c.first_name} ${c.last_name || ''}`.trim()
    }

    const stageName = (stageId) => stagesMap.get(stageId)?.name || '—'

    const profileName = (profileId) => {
      const p = profilesMap.get(profileId)
      return p ? p.full_name : 'Unknown'
    }

    const profile = (profileId) => profilesMap.get(profileId) || null

    const activityMeta = (a) => {
      const d = a?.details || {}
      const action = String(a?.action || '')

      if (action === 'pipeline.stage_changed') {
        return `Stage: ${formatFromTo(stageName(d.from), stageName(d.to))}`
      }
      if (action === 'pipeline.value_changed') {
        return `Value: ${formatFromTo(d.from, d.to, { fmt: (x) => formatCurrency(x) })}`
      }
      if (action === 'pipeline.probability_changed') {
        return `Probability: ${formatFromTo(d.from, d.to)}%`
      }
      if (action === 'pipeline.assigned' || action === 'lead.assigned' || action === 'task.assigned' || action === 'client.advisor_changed' || action === 'meeting.advisor_changed') {
        return `Assignee: ${formatFromTo(profileName(d.from), profileName(d.to))}`
      }
      if (action === 'lead.status_changed' || action === 'task.status_changed' || action === 'client.status_changed' || action === 'meeting.status_changed') {
        return `Status: ${formatFromTo(d.from, d.to)}`
      }
      if (action === 'meeting.rescheduled') {
        return `When: ${formatFromTo(d.from, d.to, { fmt: (x) => formatDateTime(x) })}`
      }
      if (action === 'client.aum_changed') {
        return `AUM: ${formatFromTo(d.from, d.to, { fmt: (x) => formatCurrency(x) })}`
      }
      if (action === 'client.next_review_changed') {
        return `Next review: ${formatFromTo(d.from, d.to)}`
      }
      if (action === 'task.due_date_changed') {
        return `Due: ${formatFromTo(d.from, d.to)}`
      }
      if (action === 'task.priority_changed') {
        return `Priority: ${formatFromTo(d.from, d.to)}`
      }

      return ''
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
      overdueTasksList,
      upcomingReviews,
      staleLeads,
      todayStart,
      stageCounts,
      donutData,
      leadName,
      clientName,
      profileName,
      profile,
      stageName,
      activityMeta,
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

      <div className="card actionCenter">
        <div className="cardHeader">
          <div className="cardTitle">Action Center</div>
          <div className="muted">What needs your attention</div>
        </div>
        <div className="actionGrid">
          <div className="actionCol">
            <div className="actionColHead">
              <span className="actionColIcon red">
                <AlertTriangle size={15} />
              </span>
              <span className="actionColTitle">Overdue tasks</span>
              <span className="actionCount">{(computed.overdueTasksList || []).length}</span>
            </div>
            <div className="actionList">
              {state.loading ? (
                <div className="actionEmpty">Loading…</div>
              ) : (computed.overdueTasksList || []).length === 0 ? (
                <div className="actionEmpty">Nothing overdue. Nice work.</div>
              ) : (
                (computed.overdueTasksList || []).slice(0, 5).map((t) => {
                  const od = daysBetween(new Date(t.due_date).getTime(), computed.todayStart)
                  return (
                    <div className="actionItem" key={t.id}>
                      <div className="actionItemMain">
                        <div className="actionItemTitle">{t.title}</div>
                        <div className="actionItemSub">
                          {computed.profileName(t.assigned_to)} · due {formatDate(t.due_date)}
                        </div>
                      </div>
                      <span className="actionPill red">{od}d late</span>
                    </div>
                  )
                })
              )}
            </div>
          </div>

          <div className="actionCol">
            <div className="actionColHead">
              <span className="actionColIcon blue">
                <CalendarClock size={15} />
              </span>
              <span className="actionColTitle">Reviews due</span>
              <span className="actionCount">{(computed.upcomingReviews || []).length}</span>
            </div>
            <div className="actionList">
              {state.loading ? (
                <div className="actionEmpty">Loading…</div>
              ) : (computed.upcomingReviews || []).length === 0 ? (
                <div className="actionEmpty">No reviews in the next 14 days.</div>
              ) : (
                (computed.upcomingReviews || []).slice(0, 5).map((c) => {
                  const due = daysBetween(computed.todayStart, new Date(c.next_review_date).setHours(0, 0, 0, 0))
                  const overdue = due < 0
                  return (
                    <div className="actionItem" key={c.id}>
                      <div className="actionItemMain">
                        <div className="actionItemTitle">
                          {`${c.first_name} ${c.last_name || ''}`.trim()}
                        </div>
                        <div className="actionItemSub">
                          {computed.profileName(c.advisor_id)} · {formatDate(c.next_review_date)}
                        </div>
                      </div>
                      <span className={['actionPill', overdue ? 'red' : 'blue'].join(' ')}>
                        {overdue ? `${Math.abs(due)}d late` : due === 0 ? 'today' : `${due}d`}
                      </span>
                    </div>
                  )
                })
              )}
            </div>
          </div>

          <div className="actionCol">
            <div className="actionColHead">
              <span className="actionColIcon amber">
                <Hourglass size={15} />
              </span>
              <span className="actionColTitle">Stale leads</span>
              <span className="actionCount">{(computed.staleLeads || []).length}</span>
            </div>
            <div className="actionList">
              {state.loading ? (
                <div className="actionEmpty">Loading…</div>
              ) : (computed.staleLeads || []).length === 0 ? (
                <div className="actionEmpty">No leads going cold.</div>
              ) : (
                (computed.staleLeads || []).slice(0, 5).map((l) => {
                  const idle = daysBetween(
                    new Date(l.updated_at || l.created_at).getTime(),
                    Date.now(),
                  )
                  return (
                    <div className="actionItem" key={l.id}>
                      <div className="actionItemMain">
                        <div className="actionItemTitle">
                          {`${l.first_name} ${l.last_name || ''}`.trim()}
                        </div>
                        <div className="actionItemSub">
                          {computed.profileName(l.assigned_to)} · no activity {idle}d
                        </div>
                      </div>
                      <span className="actionPill amber">{idle}d</span>
                    </div>
                  )
                })
              )}
            </div>
          </div>
        </div>
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
                          <span className="activityActorChip">
                            <Avatar
                              name={computed.profileName(a.actor_id)}
                              src={computed.profile(a.actor_id)?.avatar_url || ''}
                              size="sm"
                            />
                            <span className="activityActorName">
                              {computed.profileName(a.actor_id)}
                            </span>
                          </span>
                        </span>
                        <span className="activityAction">{humanizeAction(a.action)}</span>
                        {a.client_id ? (
                          <span className="activityTarget">
                            {computed.clientName(a.client_id)}
                          </span>
                        ) : a.lead_id ? (
                          <span className="activityTarget">{computed.leadName(a.lead_id)}</span>
                        ) : null}
                      </div>
                      <div className="activityMeta">
                        <span>{formatDateTime(a.created_at)}</span>
                        {computed.activityMeta(a) ? (
                          <>
                            <span className="activitySep">•</span>
                            <span className="activityDetail">{computed.activityMeta(a)}</span>
                          </>
                        ) : null}
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

