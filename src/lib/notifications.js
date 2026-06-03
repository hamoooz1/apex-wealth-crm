import { supabase } from './supabaseClient.js'
import { parseInvokeError } from './edgeFunctions.js'

export async function getMyNotifications(userId, { limit = 30 } = {}) {
  if (!userId) return []
  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .eq('user_id', userId)
    .neq('kind', 'email.digest')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return data || []
}

export async function getUnreadNotificationCount(userId) {
  if (!userId) return 0
  const { count, error } = await supabase
    .from('notifications')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .neq('kind', 'email.digest')
    .is('read_at', null)
  if (error) throw error
  return count || 0
}

export async function markNotificationRead(notificationId) {
  const { error } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('id', notificationId)
  if (error) throw error
  return true
}

export async function markAllNotificationsRead(userId) {
  if (!userId) return true
  const { error } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('user_id', userId)
    .is('read_at', null)
  if (error) throw error
  return true
}

export async function dispatchMyReminders() {
  const { data, error } = await supabase.functions.invoke('notification-dispatch', { method: 'POST' })
  const parsed = await parseInvokeError(error, data)
  if (parsed) throw parsed
  return data
}

export function subscribeToNotifications(userId, onChange) {
  if (!userId) return () => {}
  const channel = supabase
    .channel(`notifications:${userId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` },
      () => onChange?.(),
    )
    .subscribe()
  return () => {
    supabase.removeChannel(channel)
  }
}
