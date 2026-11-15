import { supabase } from './supabaseClient.js'

const PROFILE_MIN = 'id, full_name, email, role, avatar_url'
const PROFILE_LIST = `${PROFILE_MIN}, manager_id, is_active, created_at`

export const LEAD_COLUMNS =
  'id, first_name, last_name, email, alternate_emails, phone, source, status, assigned_to, notes, created_at, updated_at'
export const CLIENT_COLUMNS =
  'id, lead_id, first_name, last_name, email, alternate_emails, phone, advisor_id, aum, status, next_review_date, created_at'
export const TASK_COLUMNS =
  'id, title, description, status, priority, due_date, assigned_to, client_id, lead_id, created_at'
export const MEETING_COLUMNS =
  'id, title, start_time, end_time, status, status_origin, advisor_id, client_id, lead_id, link_origin, invitee_email, source, notes, meeting_type, meeting_url, external_provider, external_event_uri, external_invitee_uri, location, field_origins, provider_snapshot, zoom_meeting_id, zoom_meeting_uuid, provider_summary, last_writeback_at, last_writeback_error, last_writeback_note'

export function formatAlternateEmails(value) {
  return Array.isArray(value) ? value.filter(Boolean).join(', ') : ''
}

export function parseAlternateEmails(value) {
  const parts = Array.isArray(value) ? value : String(value || '').split(/[,;\s]+/)
  return [...new Set(parts.map((part) => String(part || '').trim().toLowerCase()).filter((part) => part.includes('@')))]
}
export const PIPELINE_ENTRY_COLUMNS =
  'id, lead_id, stage_id, assigned_to, value, probability, entered_at, updated_at'
export const STAGE_COLUMNS = 'id, name, sort_order, is_active'
const ACTIVITY_COLUMNS = 'id, action, details, created_at, actor_id, client_id, lead_id'
const NOTE_COLUMNS = 'id, client_id, author_id, kind, body, created_at'
const DOCUMENT_COLUMNS =
  'id, client_id, uploaded_by, file_name, storage_path, mime_type, file_size, created_at'
const RECORDING_COLUMNS =
  'id, meeting_id, client_id, lead_id, topic, recording_start, created_at, duration_minutes, play_url, share_url, transcript_text, summary, storage_path, transcript_storage_path, storage_error, recording_passcode, external_meeting_id'

export async function getProfilesMap() {
  const { data, error } = await supabase.from('profiles').select(PROFILE_LIST)
  if (error) throw error
  const map = new Map()
  for (const p of data || []) map.set(p.id, p)
  return map
}

export async function getLeadsMap() {
  const { data, error } = await supabase.from('leads').select(LEAD_COLUMNS)
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
    supabase
      .from('meetings')
      .select('id, title, start_time, status, advisor_id, client_id')
      .gte('start_time', new Date().toISOString())
      .lte('start_time', new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()),
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
    supabase.from('tasks').select(TASK_COLUMNS).order('created_at', { ascending: false }),
    supabase.from('leads').select('id, first_name, last_name, email'),
    supabase.from('clients').select('id, first_name, last_name, email'),
  ])
  const err = tasksRes.error || leadsRes.error || clientsRes.error
  if (err) throw err
  return { tasks: tasksRes.data || [], leads: leadsRes.data || [], clients: clientsRes.data || [] }
}

export async function fetchPipelinePageData() {
  const [stagesRes, entriesRes, leadsRes, profilesRes] = await Promise.all([
    supabase.from('pipeline_stages').select(STAGE_COLUMNS).order('sort_order', { ascending: true }),
    supabase.from('pipeline_entries').select(PIPELINE_ENTRY_COLUMNS).order('updated_at', { ascending: false }),
    supabase.from('leads').select('id, first_name, last_name, email'),
    supabase.from('profiles').select(PROFILE_MIN),
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
    supabase.from('clients').select('id, first_name, last_name, status, aum, advisor_id, next_review_date'),
    supabase.from('leads').select('id, first_name, last_name, status, assigned_to, created_at, updated_at'),
    supabase.from('tasks').select('id, status, due_date, assigned_to'),
    supabase.from('pipeline_entries').select('id, stage_id, value, assigned_to'),
    supabase.from('pipeline_stages').select(STAGE_COLUMNS).order('sort_order', { ascending: true }),
    supabase.from('profiles').select(PROFILE_MIN),
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
    supabase.from('clients').select(CLIENT_COLUMNS).order('created_at', { ascending: false }),
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
    supabase.from('clients').select(CLIENT_COLUMNS).eq('id', clientId).maybeSingle(),
    supabase.from('profiles').select(PROFILE_MIN),
    supabase.from('meetings').select(MEETING_COLUMNS).eq('client_id', clientId).order('start_time', { ascending: false }),
    supabase
      .from('tasks')
      .select(TASK_COLUMNS)
      .eq('client_id', clientId)
      .order('due_date', { ascending: true, nullsFirst: false }),
    supabase
      .from('meeting_recordings')
      .select(RECORDING_COLUMNS)
      .eq('client_id', clientId)
      .order('recording_start', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false }),
    supabase
      .from('activity_logs')
      .select(ACTIVITY_COLUMNS)
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })
      .limit(100),
    supabase
      .from('client_notes')
      .select(NOTE_COLUMNS)
      .eq('client_id', clientId)
      .order('created_at', { ascending: false }),
    supabase
      .from('client_documents')
      .select(DOCUMENT_COLUMNS)
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
  const recordings = await recordingsForMeetings(meetingsRes.data || [], recordingsRes.data || [])
  return {
    client: clientRes.data || null,
    profiles: profilesRes.data || [],
    meetings: meetingsRes.data || [],
    tasks: tasksRes.data || [],
    recordings,
    activity: activityRes.data || [],
    notes: notesRes.data || [],
    documents: documentsRes.data || [],
  }
}

export async function addClientNote({ clientId, authorId, kind, body }) {
  const { data, error } = await supabase
    .from('client_notes')
    .insert({ client_id: clientId, author_id: authorId, kind: kind || 'note', body })
    .select(NOTE_COLUMNS)
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
    .select(PROFILE_LIST)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

export async function fetchTeamProfilesPageData() {
  const monthStart = new Date()
  monthStart.setDate(1)
  monthStart.setHours(0, 0, 0, 0)
  const monthEnd = new Date(monthStart)
  monthEnd.setMonth(monthEnd.getMonth() + 1)

  const [profilesRes, clientsRes, meetingsRes, entriesRes, stagesRes] = await Promise.all([
    supabase.from('profiles').select(PROFILE_LIST).order('created_at', { ascending: false }),
    supabase.from('clients').select('id, advisor_id, aum'),
    supabase
      .from('meetings')
      .select('id, advisor_id, start_time')
      .gte('start_time', monthStart.toISOString())
      .lt('start_time', monthEnd.toISOString()),
    supabase.from('pipeline_entries').select('id, stage_id, assigned_to, value'),
    supabase.from('pipeline_stages').select(STAGE_COLUMNS).order('sort_order', { ascending: true }),
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
    .select(MEETING_COLUMNS)
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

async function recordingsForMeetings(meetings, already) {
  const meetingIds = meetings.map((m) => m.id).filter(Boolean)
  const zoomIds = [...new Set(meetings.map((m) => m.zoom_meeting_id).filter(Boolean))]
  if (!meetingIds.length && !zoomIds.length) return already
  const filters = []
  if (meetingIds.length) filters.push(`meeting_id.in.(${meetingIds.join(',')})`)
  if (zoomIds.length) filters.push(`external_meeting_id.in.(${zoomIds.join(',')})`)
  const { data, error } = await supabase.from('meeting_recordings').select(RECORDING_COLUMNS).or(filters.join(','))
  if (error) throw error
  const byId = new Map((already || []).map((row) => [row.id, row]))
  for (const row of data || []) byId.set(row.id, row)
  return [...byId.values()]
}

export async function getMeetingRecordings(meetingId, zoomMeetingId = null) {
  if (!meetingId && !zoomMeetingId) return []
  let q = supabase.from('meeting_recordings').select(RECORDING_COLUMNS).order('created_at', { ascending: false })
  if (meetingId && zoomMeetingId) q = q.or(`meeting_id.eq.${meetingId},external_meeting_id.eq.${zoomMeetingId}`)
  else if (zoomMeetingId) q = q.eq('external_meeting_id', zoomMeetingId)
  else q = q.eq('meeting_id', meetingId)
  const { data, error } = await q
  if (error) throw error
  return data || []
}

export async function getLeadMeetings(leadId) {
  if (!leadId) return []
  const { data, error } = await supabase
    .from('meetings')
    .select(MEETING_COLUMNS)
    .eq('lead_id', leadId)
    .order('start_time', { ascending: false })
  if (error) throw error
  return data || []
}

export async function getClientRecordings(clientId) {
  if (!clientId) return []
  const { data, error } = await supabase
    .from('meeting_recordings')
    .select(RECORDING_COLUMNS)
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

export async function updateProfileAccess(profileId, patch) {
  const { data, error } = await supabase.rpc('update_profile_access', {
    target_id: profileId,
    new_role: patch.role ?? null,
    new_manager_id: Object.prototype.hasOwnProperty.call(patch, 'manager_id') ? patch.manager_id : null,
    new_is_active: Object.prototype.hasOwnProperty.call(patch, 'is_active') ? patch.is_active : null,
    set_role: Object.prototype.hasOwnProperty.call(patch, 'role'),
    set_manager: Object.prototype.hasOwnProperty.call(patch, 'manager_id'),
    set_active: Object.prototype.hasOwnProperty.call(patch, 'is_active'),
  })
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

