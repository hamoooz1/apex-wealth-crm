export function humanizeAction(action) {
  const a = String(action || '')
  const map = {
    'lead.created': 'created a lead',
    'lead.assigned': 'assigned a lead',
    'lead.status_changed': 'changed lead status',
    'lead.contact_updated': 'updated lead contact',
    'lead.deleted': 'deleted a lead',

    'pipeline.created': 'created an opportunity',
    'pipeline.stage_changed': 'moved an opportunity stage',
    'pipeline.assigned': 'assigned an opportunity',
    'pipeline.value_changed': 'updated opportunity value',
    'pipeline.probability_changed': 'updated opportunity probability',
    'pipeline.deleted': 'deleted an opportunity',

    'task.created': 'created a task',
    'task.status_changed': 'changed task status',
    'task.assigned': 'assigned a task',
    'task.due_date_changed': 'updated task due date',
    'task.priority_changed': 'updated task priority',
    'task.deleted': 'deleted a task',

    'client.created': 'created a client',
    'client.aum_changed': 'updated client AUM',
    'client.status_changed': 'changed client status',
    'client.advisor_changed': 'changed client advisor',
    'client.next_review_changed': 'updated next review date',
    'client.contact_updated': 'updated client contact',
    'client.deleted': 'deleted a client',

    'meeting.created': 'scheduled a meeting',
    'meeting.status_changed': 'updated meeting status',
    'meeting.rescheduled': 'rescheduled a meeting',
    'meeting.advisor_changed': 'reassigned a meeting',
    'meeting.deleted': 'deleted a meeting',
  }
  return map[a] || a.replaceAll('_', ' ')
}

function fmtCurrency(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return String(n ?? '—')
  return v.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
}

function fmtDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return d.toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function fromTo(from, to, fmt) {
  const f = from == null || from === '' ? '—' : fmt ? fmt(from) : String(from)
  const t = to == null || to === '' ? '—' : fmt ? fmt(to) : String(to)
  return `${f} → ${t}`
}

// Lightweight detail summary that does not require stage/profile lookups.
// Suitable for the per-client timeline where most changes are scalar values.
export function summarizeActivityDetails(action, details) {
  const d = details || {}
  const a = String(action || '')
  if (a === 'client.aum_changed' || a === 'pipeline.value_changed') {
    return `${a.includes('aum') ? 'AUM' : 'Value'}: ${fromTo(d.from, d.to, fmtCurrency)}`
  }
  if (a === 'meeting.rescheduled') return `When: ${fromTo(d.from, d.to, fmtDateTime)}`
  if (a.endsWith('status_changed')) return `Status: ${fromTo(d.from, d.to)}`
  if (a === 'client.next_review_changed') return `Next review: ${fromTo(d.from, d.to)}`
  if (a === 'task.due_date_changed') return `Due: ${fromTo(d.from, d.to)}`
  if (a === 'task.priority_changed') return `Priority: ${fromTo(d.from, d.to)}`
  if (d.title) return String(d.title)
  if (d.from != null || d.to != null) return fromTo(d.from, d.to)
  return ''
}
