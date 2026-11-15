import { supabase } from './supabaseClient.js'

const CALENDLY_HEALTH =
  'id, user_id, calendly_user_uri, status, revoked_at, connected_at, webhook_subscription_uri, webhook_last_error, token_expires_at, token_status, token_status_at, last_synced_at, last_sync_error, last_webhook_at, last_reconcile_at'
const CALENDLY_BASE =
  'id, user_id, calendly_user_uri, status, revoked_at, connected_at, webhook_subscription_uri, webhook_last_error'

const ZOOM_HEALTH =
  'id, user_id, zoom_user_id, zoom_account_id, email, status, revoked_at, connected_at, webhook_last_error, token_expires_at, token_status, token_status_at, last_synced_at, last_sync_error, last_webhook_at, last_reconcile_at'
const ZOOM_BASE =
  'id, user_id, zoom_user_id, zoom_account_id, email, status, revoked_at, connected_at, webhook_last_error'

function missingColumn(error) {
  const message = error?.message || ''
  return /column|schema cache/i.test(message)
}

async function selectRows(table, columns, fallback, apply) {
  let first = apply(supabase.from(table).select(columns))
  let res = await first
  if (res.error && missingColumn(res.error)) {
    res = await apply(supabase.from(table).select(fallback))
  }
  if (res.error) throw res.error
  return res.data || []
}

export async function loadMyCalendlyConnection(userId) {
  if (!userId) return null
  const rows = await selectRows('calendly_connections', CALENDLY_HEALTH, CALENDLY_BASE, (q) =>
    q.eq('user_id', userId).is('revoked_at', null).limit(1),
  )
  return rows[0] || null
}

export async function loadMyZoomConnection(userId) {
  if (!userId) return null
  const rows = await selectRows('zoom_connections', ZOOM_HEALTH, ZOOM_BASE, (q) =>
    q.eq('user_id', userId).is('revoked_at', null).limit(1),
  )
  return rows[0] || null
}

export async function loadTeamIntegrationHealth() {
  const [calendly, zoom] = await Promise.all([
    selectRows('calendly_connections', CALENDLY_HEALTH, CALENDLY_BASE, (q) => q.is('revoked_at', null)),
    selectRows('zoom_connections', ZOOM_HEALTH, ZOOM_BASE, (q) => q.is('revoked_at', null)),
  ])
  const ids = [...new Set([...calendly, ...zoom].map((row) => row.user_id).filter(Boolean))]
  let profiles = []
  if (ids.length) {
    const { data, error } = await supabase.from('profiles').select('id, full_name, email').in('id', ids)
    if (error) throw error
    profiles = data || []
  }
  const names = new Map(profiles.map((p) => [p.id, p.full_name || p.email || 'Advisor']))
  return ids.map((id) => ({
    userId: id,
    name: names.get(id) || 'Advisor',
    calendly: calendly.find((row) => row.user_id === id) || null,
    zoom: zoom.find((row) => row.user_id === id) || null,
  }))
}

export function formatWhen(iso) {
  if (!iso) return 'Never'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'Never'
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function tokenHealth(status, expiresAt) {
  if (status === 'valid') {
    return {
      label: expiresAt ? `Valid · expires ${formatWhen(expiresAt)}` : 'Valid',
      tone: 'good',
    }
  }
  if (status === 'expired') return { label: 'Expired', tone: 'bad' }
  if (status === 'refresh_failed') return { label: 'Refresh failed', tone: 'bad' }
  if (status === 'missing') return { label: 'Missing · reconnect', tone: 'bad' }
  return { label: 'Not checked yet', tone: 'muted' }
}

export function calendlyUpdateMode(conn) {
  if (!conn) return 'Not connected'
  if (conn.webhook_subscription_uri) return 'Webhook, plus a 30-minute reconcile'
  return 'Reconcile every 30 minutes (no webhook)'
}
