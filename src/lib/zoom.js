import { supabase } from './supabaseClient.js'

// Zoom integration helpers. Mirrors the Calendly pattern: a per-user OAuth
// connection plus edge functions that do the privileged work server-side.

export async function getMyZoomConnection(userId) {
  if (!userId) return null
  const { data, error } = await supabase
    .from('zoom_connections')
    .select('*')
    .eq('user_id', userId)
    .is('revoked_at', null)
    .maybeSingle()
  if (error) throw error
  return data || null
}

export async function startZoomConnect() {
  const { data, error } = await supabase.functions.invoke('zoom-oauth-start')
  if (error) throw error
  if (!data?.authorize_url) throw new Error('Zoom did not return an authorize URL.')
  return data.authorize_url
}

export async function disconnectZoom() {
  const { data, error } = await supabase.functions.invoke('zoom-disconnect', { body: {} })
  if (error) throw error
  return data
}

/**
 * Creates a real Zoom meeting via the edge function (which holds the OAuth
 * token). Returns { join_url, start_url, passcode, zoom_meeting_id, ... }.
 * Does NOT persist a CRM meeting row — the caller saves that through the normal
 * createMeeting path so RLS + CRM linkage stay in the app layer.
 */
export async function createZoomMeeting({ title, startTime, durationMinutes, timezone }) {
  const { data, error } = await supabase.functions.invoke('zoom-create-meeting', {
    body: {
      title,
      start_time: startTime,
      duration: durationMinutes,
      timezone,
    },
  })
  if (error) throw error
  if (!data?.ok) throw new Error(data?.error || 'Zoom meeting creation failed.')
  return data
}

/**
 * Builds the meetings-table fields for a Zoom-generated meeting so the modal can
 * merge them into its createMeeting payload.
 */
export function zoomMeetingFields(zoom) {
  return {
    source: 'zoom',
    external_provider: 'zoom',
    external_event_uri: zoom?.zoom_meeting_id ? `zoom:${zoom.zoom_meeting_id}` : null,
    meeting_type: 'zoom',
    meeting_url: zoom?.join_url || null,
    location: {
      provider: 'zoom',
      zoom_meeting_id: zoom?.zoom_meeting_id || null,
      join_url: zoom?.join_url || null,
      start_url: zoom?.start_url || null,
      passcode: zoom?.passcode || null,
    },
  }
}
