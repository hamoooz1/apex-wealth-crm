import { supabase } from './supabaseClient.js'

const LIMIT_PER_TYPE = 6

function sanitizeTerm(raw) {
  return String(raw || '')
    .trim()
    .replace(/[,().\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 80)
}

function ilikePattern(term) {
  const safe = term.replace(/"/g, '').replace(/,/g, ' ')
  return `"%${safe}%"`
}

function orIlike(fields, pattern) {
  return fields.map((f) => `${f}.ilike.${pattern}`).join(',')
}

function personName(first, last) {
  return [first, last].filter(Boolean).join(' ') || 'Unnamed'
}

function contactSubtitle(row) {
  const parts = [row.email, row.phone].filter(Boolean)
  return parts.join(' · ') || ''
}

function mapClient(row) {
  const name = personName(row.first_name, row.last_name)
  return {
    type: 'client',
    id: row.id,
    title: name,
    subtitle: contactSubtitle(row) || 'Client',
    href: `/clients/${row.id}`,
  }
}

function mapLead(row) {
  const name = personName(row.first_name, row.last_name)
  return {
    type: 'lead',
    id: row.id,
    title: name,
    subtitle: contactSubtitle(row) || `Lead · ${row.status || 'new'}`,
    href: '/leads',
  }
}

function mapMeeting(row) {
  return {
    type: 'meeting',
    id: row.id,
    title: row.title || 'Meeting',
    subtitle: row.start_time
      ? new Date(row.start_time).toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })
      : 'Meeting',
    href: '/calendar',
  }
}

function mapTask(row) {
  return {
    type: 'task',
    id: row.id,
    title: row.title || 'Task',
    subtitle: row.due_date ? `Due ${row.due_date}` : row.status || 'Task',
    href: '/tasks',
  }
}

function mapTeam(row) {
  return {
    type: 'team',
    id: row.id,
    title: row.full_name || 'Team member',
    subtitle: [row.email, row.role].filter(Boolean).join(' · ') || 'Team',
    href: '/team',
  }
}

export const SEARCH_GROUPS = [
  { key: 'client', label: 'Clients' },
  { key: 'lead', label: 'Leads' },
  { key: 'meeting', label: 'Meetings' },
  { key: 'task', label: 'Tasks' },
  { key: 'team', label: 'Team' },
]

export async function globalSearch(rawQuery) {
  const term = sanitizeTerm(rawQuery)
  if (term.length < 2) return { term, groups: [], total: 0 }

  const pattern = ilikePattern(term)

  const [clientsRes, leadsRes, meetingsRes, tasksRes, teamRes] = await Promise.all([
    supabase
      .from('clients')
      .select('id, first_name, last_name, email, phone')
      .or(orIlike(['first_name', 'last_name', 'email', 'phone'], pattern))
      .order('created_at', { ascending: false })
      .limit(LIMIT_PER_TYPE),
    supabase
      .from('leads')
      .select('id, first_name, last_name, email, phone, status')
      .or(orIlike(['first_name', 'last_name', 'email', 'phone'], pattern))
      .order('created_at', { ascending: false })
      .limit(LIMIT_PER_TYPE),
    supabase
      .from('meetings')
      .select('id, title, start_time, notes')
      .or(orIlike(['title', 'notes', 'meeting_type'], pattern))
      .order('start_time', { ascending: false })
      .limit(LIMIT_PER_TYPE),
    supabase
      .from('tasks')
      .select('id, title, description, due_date, status')
      .or(orIlike(['title', 'description'], pattern))
      .order('created_at', { ascending: false })
      .limit(LIMIT_PER_TYPE),
    supabase
      .from('profiles')
      .select('id, full_name, email, role')
      .or(orIlike(['full_name', 'email'], pattern))
      .eq('is_active', true)
      .order('full_name', { ascending: true })
      .limit(LIMIT_PER_TYPE),
  ])

  const err =
    clientsRes.error || leadsRes.error || meetingsRes.error || tasksRes.error || teamRes.error
  if (err) throw err

  const buckets = {
    client: (clientsRes.data || []).map(mapClient),
    lead: (leadsRes.data || []).map(mapLead),
    meeting: (meetingsRes.data || []).map(mapMeeting),
    task: (tasksRes.data || []).map(mapTask),
    team: (teamRes.data || []).map(mapTeam),
  }

  const groups = SEARCH_GROUPS.map((g) => ({
    ...g,
    items: buckets[g.key] || [],
  })).filter((g) => g.items.length > 0)

  const total = groups.reduce((n, g) => n + g.items.length, 0)
  return { term, groups, total }
}
