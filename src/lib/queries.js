import { supabase } from './supabaseClient.js'

const PROFILE_MIN = 'id, full_name, email, role, avatar_url'

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
    supabase.from('leads').select('id, first_name, last_name, status, created_at, updated_at'),
    supabase.from('clients').select('id, first_name, last_name, status, aum, next_review_date, advisor_id'),
    supabase.from('tasks').select('id, title, status, due_date, assigned_to, client_id, lead_id'),
    supabase.from('meetings').select('id, title, start_time, status, advisor_id, client_id'),
    supabase.from('pipeline_entries').select('id, stage_id, value, lead_id'),
    supabase.from('pipeline_stages').select('id, name, sort_order, is_active').order('sort_order', { ascending: true }),
    supabase.from('activity_logs').select('id, action, details, created_at, actor_id, client_id, lead_id').order('created_at', { ascending: false }).limit(12),
    supabase.from('profiles').select(PROFILE_MIN),
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

export async function fetchReportsPageData() {
  const [clientsRes, leadsRes, tasksRes, entriesRes, stagesRes, profilesRes] = await Promise.all([
    supabase.from('clients').select('*'),
    supabase.from('leads').select('*'),
    supabase.from('tasks').select('*'),
    supabase.from('pipeline_entries').select('*'),
    supabase.from('pipeline_stages').select('*').order('sort_order', { ascending: true }),
    supabase.from('profiles').select('*'),
  ])
  const err =
    clientsRes.error ||
    leadsRes.error ||
    tasksRes.error ||
    entriesRes.error ||
    stagesRes.error ||
    profilesRes.error
  if (err) throw err
  return {
    clients: clientsRes.data || [],
    leads: leadsRes.data || [],
    tasks: tasksRes.data || [],
    pipeline_entries: entriesRes.data || [],
    pipeline_stages: stagesRes.data || [],
    profiles: profilesRes.data || [],
  }
}

export async function fetchClientsPageData() {
  const [clientsRes, profilesRes, recordingsRes] = await Promise.all([
    supabase.from('clients').select('*').order('created_at', { ascending: false }),
    supabase.from('profiles').select(PROFILE_MIN),
    supabase.from('meeting_recordings').select('client_id'),
  ])
  const err = clientsRes.error || profilesRes.error || recordingsRes.error
  if (err) throw err

  const recordingCounts = {}
  for (const r of recordingsRes.data || []) {
    if (r.client_id) recordingCounts[r.client_id] = (recordingCounts[r.client_id] || 0) + 1
  }

  return {
    clients: clientsRes.data || [],
    profiles: profilesRes.data || [],
    recordingCounts,
  }
}

export async function fetchClientDetail(clientId) {
  const [clientRes, profilesRes, meetingsRes, tasksRes, recordingsRes, activityRes, notesRes, documentsRes] =
    await Promise.all([
    supabase.from('clients').select('*').eq('id', clientId).maybeSingle(),
    supabase.from('profiles').select(PROFILE_MIN),
    supabase.from('meetings').select('*').eq('client_id', clientId).order('start_time', { ascending: false }),
    supabase
      .from('tasks')
      .select('*')
      .eq('client_id', clientId)
      .order('due_date', { ascending: true, nullsFirst: false }),
    supabase
      .from('meeting_recordings')
      .select('*')
      .eq('client_id', clientId)
      .order('recording_start', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false }),
    supabase
      .from('activity_logs')
      .select('*')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })
      .limit(100),
    supabase
      .from('client_notes')
      .select('*')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false }),
    supabase
      .from('client_documents')
      .select('*')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false }),
  ])
  const err =
    clientRes.error ||
    profilesRes.error ||
    meetingsRes.error ||
    tasksRes.error ||
    recordingsRes.error ||
    activityRes.error ||
    notesRes.error ||
    documentsRes.error
  if (err) throw err
  return {
    client: clientRes.data || null,
    profiles: profilesRes.data || [],
    meetings: meetingsRes.data || [],
    tasks: tasksRes.data || [],
    recordings: recordingsRes.data || [],
    activity: activityRes.data || [],
    notes: notesRes.data || [],
    documents: documentsRes.data || [],
  }
}

export async function addClientNote({ clientId, authorId, kind, body }) {
  const { data, error } = await supabase
    .from('client_notes')
    .insert({ client_id: clientId, author_id: authorId, kind: kind || 'note', body })
    .select('*')
    .maybeSingle()
  if (error) throw error
  return data
}

export async function deleteClientNote(noteId) {
  const { error } = await supabase.from('client_notes').delete().eq('id', noteId)
  if (error) throw error
  return true
}

export async function fetchProfilesPageData() {
  const { data, error } = await supabase
    .from('profiles')
    .select(`${PROFILE_MIN}, manager_id, is_active, created_at`)
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

export async function fetchCalendarPageData() {
  const [profilesRes, leadsRes, clientsRes] = await Promise.all([
    supabase.from('profiles').select(PROFILE_MIN).order('full_name', { ascending: true }),
    supabase.from('leads').select('id, first_name, last_name, email, status').order('created_at', { ascending: false }),
    supabase.from('clients').select('id, first_name, last_name, email, status, advisor_id').order('created_at', { ascending: false }),
  ])
  const err = profilesRes.error || leadsRes.error || clientsRes.error
  if (err) throw err
  return { profiles: profilesRes.data || [], leads: leadsRes.data || [], clients: clientsRes.data || [] }
}

export async function fetchMeetings({ from, to, advisorId = null } = {}) {
  let q = supabase
    .from('meetings')
    .select('*')
    .order('start_time', { ascending: true })

  if (from) q = q.gte('start_time', from)
  if (to) q = q.lte('start_time', to)
  if (advisorId) q = q.eq('advisor_id', advisorId)

  const { data, error } = await q
  if (error) throw error
  return data || []
}

export async function createMeeting(payload) {
  const { data, error } = await supabase.from('meetings').insert(payload).select('*').maybeSingle()
  if (error) throw error
  return data || null
}

export async function updateMeetingById(meetingId, patch) {
  const { data, error } = await supabase
    .from('meetings')
    .update(patch)
    .eq('id', meetingId)
    .select('*')
    .maybeSingle()
  if (error) throw error
  return data || null
}

export async function deleteMeetingById(meetingId) {
  const { error } = await supabase.from('meetings').delete().eq('id', meetingId)
  if (error) throw error
  return true
}

export async function getMeetingRecordings(meetingId) {
  if (!meetingId) return []
  const { data, error } = await supabase
    .from('meeting_recordings')
    .select('*')
    .eq('meeting_id', meetingId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

export async function getClientRecordings(clientId) {
  if (!clientId) return []
  const { data, error } = await supabase
    .from('meeting_recordings')
    .select('*')
    .eq('client_id', clientId)
    .order('recording_start', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
  if (error) throw error
  return data || []
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

export async function getMyPreferences(userId) {
  if (!userId) return null
  const { data, error } = await supabase
    .from('user_preferences')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  return data || null
}

export async function saveMyPreferences(userId, patch) {
  if (!userId) throw new Error('Missing user id for preferences.')
  const { data, error } = await supabase
    .from('user_preferences')
    .upsert({ user_id: userId, ...patch }, { onConflict: 'user_id' })
    .select('*')
    .maybeSingle()
  if (error) throw error
  return data || null
}

