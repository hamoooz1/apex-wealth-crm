import { supabase } from './supabaseClient.js'

// Lightweight, best-effort workflow automations that run after a primary
// action succeeds. Each helper swallows its own errors and returns a summary
// so it can never break the user's main action. Because tasks/pipeline writes
// fire the existing DB activity triggers, automated changes also show up in the
// dashboard activity feed automatically.

function nowISO() {
  return new Date().toISOString()
}

export function addDaysDate(days) {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10) // YYYY-MM-DD (date column)
}

export function leadDisplayName(lead) {
  return (
    `${lead?.first_name || ''} ${lead?.last_name || ''}`.trim() ||
    lead?.email ||
    'this lead'
  )
}

async function getStages() {
  const { data, error } = await supabase
    .from('pipeline_stages')
    .select('id, name, sort_order')
    .order('sort_order', { ascending: true })
  if (error) throw error
  return data || []
}

function findStage(stages, predicate, fallbackFirst = false) {
  const match = stages.find(predicate)
  if (match) return match
  return fallbackFirst ? stages[0] || null : null
}

async function getPipelineEntryForLead(leadId) {
  const { data, error } = await supabase
    .from('pipeline_entries')
    .select('id, stage_id')
    .eq('lead_id', leadId)
    .maybeSingle()
  if (error) throw error
  return data || null
}

/**
 * When a new lead is created:
 *  - place it in the funnel's first ("Lead") stage so the pipeline always
 *    reflects every prospect (idempotent — skips if an entry already exists)
 *  - create a "Follow up" task so leads don't fall through the cracks
 */
export async function runLeadCreatedAutomations(lead) {
  const summary = { pipelineEntry: null, task: null, errors: [] }
  if (!lead?.id) return summary

  try {
    const stages = await getStages()
    const firstStage = findStage(
      stages,
      (s) => String(s.name).toLowerCase() === 'lead',
      true,
    )
    if (firstStage) {
      const existing = await getPipelineEntryForLead(lead.id)
      if (!existing) {
        const { data, error } = await supabase
          .from('pipeline_entries')
          .insert({
            lead_id: lead.id,
            stage_id: firstStage.id,
            assigned_to: lead.assigned_to || null,
            probability: 10,
            entered_at: nowISO(),
            updated_at: nowISO(),
          })
          .select('*')
          .maybeSingle()
        if (error) throw error
        summary.pipelineEntry = data
      }
    }
  } catch (e) {
    summary.errors.push(e)
  }

  try {
    const { data, error } = await supabase
      .from('tasks')
      .insert({
        title: `Follow up with ${leadDisplayName(lead)}`,
        description: 'Auto-created when the lead was added.',
        status: 'todo',
        priority: 'medium',
        due_date: addDaysDate(2),
        assigned_to: lead.assigned_to || null,
        lead_id: lead.id,
        created_at: nowISO(),
      })
      .select('*')
      .maybeSingle()
    if (error) throw error
    summary.task = data
  } catch (e) {
    summary.errors.push(e)
  }

  return summary
}

/**
 * When a lead converts to a client:
 *  - move (or create) its pipeline entry into "Closed Won" at 100% so the
 *    funnel and team stats stay accurate
 *  - create an onboarding task for the advisor
 */
export async function runLeadConvertedAutomations({ lead, clientId }) {
  const summary = { errors: [] }
  if (!lead?.id) return summary

  try {
    const stages = await getStages()
    const wonStage = findStage(stages, (s) =>
      String(s.name).toLowerCase().includes('closed won'),
    )
    if (wonStage) {
      const entry = await getPipelineEntryForLead(lead.id)
      if (entry) {
        const { error } = await supabase
          .from('pipeline_entries')
          .update({ stage_id: wonStage.id, probability: 100, updated_at: nowISO() })
          .eq('id', entry.id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('pipeline_entries').insert({
          lead_id: lead.id,
          stage_id: wonStage.id,
          assigned_to: lead.assigned_to || null,
          probability: 100,
          entered_at: nowISO(),
          updated_at: nowISO(),
        })
        if (error) throw error
      }
    }
  } catch (e) {
    summary.errors.push(e)
  }

  try {
    const { error } = await supabase.from('tasks').insert({
      title: `Send onboarding packet to ${leadDisplayName(lead)}`,
      description: 'Auto-created when the lead converted to a client.',
      status: 'todo',
      priority: 'high',
      due_date: addDaysDate(3),
      assigned_to: lead.assigned_to || null,
      client_id: clientId || null,
      created_at: nowISO(),
    })
    if (error) throw error
  } catch (e) {
    summary.errors.push(e)
  }

  return summary
}
