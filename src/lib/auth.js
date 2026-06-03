import { supabase } from './supabaseClient.js'
import { parseInvokeError } from './edgeFunctions.js'

export function passwordResetRedirectUrl() {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}/`
  }
  return undefined
}

/** Self-service: sends a password reset email to the signed-out user. */
export async function requestPasswordReset(email) {
  const normalized = String(email || '').trim().toLowerCase()
  if (!normalized) throw new Error('Email is required.')

  const { error } = await supabase.auth.resetPasswordForEmail(normalized, {
    redirectTo: passwordResetRedirectUrl(),
  })
  if (error) throw error
  return true
}

/** Admin-only via edge function: resend password reset email to a team member. */
export async function adminSendPasswordReset(email) {
  const { data, error } = await supabase.functions.invoke('send-password-reset', {
    body: { email: String(email || '').trim().toLowerCase() },
  })
  const parsed = await parseInvokeError(error, data)
  if (parsed) throw parsed
  if (!data?.ok) throw new Error('Failed to send password reset.')
  return data
}

/** Complete the flow after the user opens the reset link from email. */
export async function updatePassword(newPassword) {
  const { error } = await supabase.auth.updateUser({ password: newPassword })
  if (error) throw error
  return true
}
