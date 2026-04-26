import { supabase } from './supabaseClient.js'

export async function getProfilesMap() {
  const { data, error } = await supabase.from('profiles').select('*')
  if (error) throw error
  const map = new Map()
  for (const p of data || []) map.set(p.id, p)
  return map
}

export async function getLeadsMap() {
  const { data, error } = await supabase.from('leads').select('*')
  if (error) throw error
  const map = new Map()
  for (const l of data || []) map.set(l.id, l)
  return map
}

export async function fetchDashboardData() {
  const [
    leadsRes,
    clientsRes,
    tasksRes,
    meetingsRes,
    entriesRes,
    stagesRes,
    activityRes,
    profilesRes,
  ] = await Promise.all([
    supabase.from('leads').select('*'),
    supabase.from('clients').select('*'),
    supabase.from('tasks').select('*'),
    supabase.from('meetings').select('*'),
    supabase.from('pipeline_entries').select('*'),
    supabase.from('pipeline_stages').select('*').order('sort_order', { ascending: true }),
    supabase.from('activity_logs').select('*').order('created_at', { ascending: false }).limit(12),
    supabase.from('profiles').select('*'),
  ])

  const firstError =
    leadsRes.error ||
    clientsRes.error ||
    tasksRes.error ||
    meetingsRes.error ||
    entriesRes.error ||
    stagesRes.error ||
    activityRes.error ||
    profilesRes.error

  if (firstError) throw firstError

  return {
    leads: leadsRes.data || [],
    clients: clientsRes.data || [],
    tasks: tasksRes.data || [],
    meetings: meetingsRes.data || [],
    pipeline_entries: entriesRes.data || [],
    pipeline_stages: stagesRes.data || [],
    activity_logs: activityRes.data || [],
    profiles: profilesRes.data || [],
  }
}

export async function fetchTasksPageData() {
  const [tasksRes, leadsRes, clientsRes] = await Promise.all([
    supabase.from('tasks').select('*').order('created_at', { ascending: false }),
    supabase.from('leads').select('*'),
    supabase.from('clients').select('*'),
  ])
  const err = tasksRes.error || leadsRes.error || clientsRes.error
  if (err) throw err
  return { tasks: tasksRes.data || [], leads: leadsRes.data || [], clients: clientsRes.data || [] }
}

export async function fetchPipelinePageData() {
  const [stagesRes, entriesRes, leadsRes, profilesRes] = await Promise.all([
    supabase.from('pipeline_stages').select('*').order('sort_order', { ascending: true }),
    supabase.from('pipeline_entries').select('*').order('updated_at', { ascending: false }),
    supabase.from('leads').select('*'),
    supabase.from('profiles').select('*'),
  ])
  const err = stagesRes.error || entriesRes.error || leadsRes.error || profilesRes.error
  if (err) throw err
  return {
    pipeline_stages: stagesRes.data || [],
    pipeline_entries: entriesRes.data || [],
    leads: leadsRes.data || [],
    profiles: profilesRes.data || [],
  }
}

export async function fetchClientsPageData() {
  const [clientsRes, profilesRes] = await Promise.all([
    supabase.from('clients').select('*').order('created_at', { ascending: false }),
    supabase.from('profiles').select('*'),
  ])
  const err = clientsRes.error || profilesRes.error
  if (err) throw err
  return { clients: clientsRes.data || [], profiles: profilesRes.data || [] }
}

export async function fetchProfilesPageData() {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

export async function fetchTeamProfilesPageData() {
  const [profilesRes, clientsRes, meetingsRes, entriesRes, stagesRes] = await Promise.all([
    supabase.from('profiles').select('*').order('created_at', { ascending: false }),
    supabase.from('clients').select('*'),
    supabase.from('meetings').select('*'),
    supabase.from('pipeline_entries').select('*'),
    supabase.from('pipeline_stages').select('*').order('sort_order', { ascending: true }),
  ])

  const err =
    profilesRes.error ||
    clientsRes.error ||
    meetingsRes.error ||
    entriesRes.error ||
    stagesRes.error
  if (err) throw err

  return {
    profiles: profilesRes.data || [],
    clients: clientsRes.data || [],
    meetings: meetingsRes.data || [],
    pipeline_entries: entriesRes.data || [],
    pipeline_stages: stagesRes.data || [],
  }
}

export async function updateProfileById(profileId, patch) {
  const { data, error } = await supabase
    .from('profiles')
    .update(patch)
    .eq('id', profileId)
    .select('*')
    .maybeSingle()
  if (error) throw error
  return data || null
}

export async function createProfileRow(payload) {
  const { data, error } = await supabase
    .from('profiles')
    .insert(payload)
    .select('*')
    .maybeSingle()
  if (error) throw error
  return data || null
}

