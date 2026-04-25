import { supabase } from './supabaseClient.js'

export async function inviteUser({ email, full_name, role, manager_id }) {
  const { data, error } = await supabase.functions.invoke('invite-user', {
    body: { email, full_name, role, manager_id },
  })
  if (error) throw error
  return data
}

