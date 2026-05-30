import { supabase } from './supabaseClient.js'

// Pull-based Calendly sync. Works on the free Calendly plan (no webhooks):
// the edge function lists the advisor's scheduled events + invitees and upserts
// them into the meetings table, mirroring the webhook's mapping.
export async function syncCalendly() {
  const { data, error } = await supabase.functions.invoke('calendly-sync', { body: {} })
  if (error) throw error
  if (!data?.ok) throw new Error(data?.error || 'Calendly sync failed.')
  return data
}
