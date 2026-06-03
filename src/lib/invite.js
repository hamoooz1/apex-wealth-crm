import { supabase } from './supabaseClient.js'
import { parseInvokeError } from './edgeFunctions.js'

export async function inviteUser({ email, full_name, role, manager_id }) {
  const { data, error } = await supabase.functions.invoke('invite-user', {
    body: { email, full_name, role, manager_id },
  })
  const parsed = await parseInvokeError(error, data)
  if (parsed) throw parsed
  if (!data?.ok) throw new Error('Invite failed.')
  return data
}
