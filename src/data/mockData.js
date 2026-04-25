function makeId(prefix) {
  const rand = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1)
  return `${prefix}-${rand()}${rand()}-${rand()}-${rand()}-${rand()}${rand()}${rand()}`
}

const now = new Date()
const daysAgo = (n) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000).toISOString()
const hoursFromNow = (h) => new Date(now.getTime() + h * 60 * 60 * 1000).toISOString()
const dateFromNow = (d) => {
  const x = new Date(now.getTime() + d * 24 * 60 * 60 * 1000)
  return x.toISOString().slice(0, 10)
}

export const profiles = [
  {
    id: 'profile-admin-001',
    full_name: 'Hamza Kaderi',
    email: 'hamza@apexwealth.com',
    role: 'admin',
    manager_id: null,
    is_active: true,
    created_at: daysAgo(120),
  },
  {
    id: 'profile-mgr-001',
    full_name: 'Maya Patel',
    email: 'maya.patel@apexwealth.com',
    role: 'manager',
    manager_id: 'profile-admin-001',
    is_active: true,
    created_at: daysAgo(210),
  },
  {
    id: 'profile-adv-001',
    full_name: 'Jordan Lee',
    email: 'jordan.lee@apexwealth.com',
    role: 'advisor',
    manager_id: 'profile-mgr-001',
    is_active: true,
    created_at: daysAgo(320),
  },
  {
    id: 'profile-adv-002',
    full_name: 'Sofia Martinez',
    email: 'sofia.martinez@apexwealth.com',
    role: 'advisor',
    manager_id: 'profile-mgr-001',
    is_active: true,
    created_at: daysAgo(280),
  },
]

export const currentUser = profiles[0]

export const leads = [
  {
    id: 'lead-001',
    first_name: 'Evelyn',
    last_name: 'Brooks',
    email: 'evelyn.brooks@gmail.com',
    phone: '(415) 555-0133',
    source: 'Referral',
    status: 'new',
    assigned_to: 'profile-adv-001',
    notes: 'Interested in retirement planning and tax-efficient allocation.',
    created_at: daysAgo(2),
    updated_at: daysAgo(0),
  },
  {
    id: 'lead-002',
    first_name: 'Noah',
    last_name: 'Chen',
    email: 'noah.chen@outlook.com',
    phone: '(212) 555-0198',
    source: 'Website',
    status: 'contacted',
    assigned_to: 'profile-adv-002',
    notes: 'Requested a call. Prefers afternoons.',
    created_at: daysAgo(6),
    updated_at: daysAgo(1),
  },
  {
    id: 'lead-003',
    first_name: 'Amelia',
    last_name: 'Stone',
    email: 'amelia.stone@yahoo.com',
    phone: '(646) 555-0175',
    source: 'Seminar',
    status: 'qualified',
    assigned_to: 'profile-adv-001',
    notes: 'Has rollover 401k; wants guidance on diversification.',
    created_at: daysAgo(12),
    updated_at: daysAgo(3),
  },
  {
    id: 'lead-004',
    first_name: 'Liam',
    last_name: 'Hughes',
    email: 'liam.hughes@gmail.com',
    phone: '(305) 555-0110',
    source: 'Cold Outreach',
    status: 'nurture',
    assigned_to: 'profile-adv-002',
    notes: 'Considering advisor switch. Needs confidence-building materials.',
    created_at: daysAgo(18),
    updated_at: daysAgo(8),
  },
]

export const pipeline_stages = [
  { id: 'stage-001', name: 'New', sort_order: 1, is_active: true, created_at: daysAgo(400) },
  {
    id: 'stage-002',
    name: 'Qualified',
    sort_order: 2,
    is_active: true,
    created_at: daysAgo(400),
  },
  {
    id: 'stage-003',
    name: 'Proposal',
    sort_order: 3,
    is_active: true,
    created_at: daysAgo(400),
  },
  {
    id: 'stage-004',
    name: 'Committed',
    sort_order: 4,
    is_active: true,
    created_at: daysAgo(400),
  },
]

export const pipeline_entries = [
  {
    id: makeId('pe'),
    lead_id: 'lead-001',
    stage_id: 'stage-001',
    assigned_to: 'profile-adv-001',
    value: 120000,
    probability: 20,
    entered_at: daysAgo(2),
    updated_at: daysAgo(0),
  },
  {
    id: makeId('pe'),
    lead_id: 'lead-002',
    stage_id: 'stage-002',
    assigned_to: 'profile-adv-002',
    value: 250000,
    probability: 45,
    entered_at: daysAgo(6),
    updated_at: daysAgo(1),
  },
  {
    id: makeId('pe'),
    lead_id: 'lead-003',
    stage_id: 'stage-003',
    assigned_to: 'profile-adv-001',
    value: 500000,
    probability: 60,
    entered_at: daysAgo(10),
    updated_at: daysAgo(2),
  },
  {
    id: makeId('pe'),
    lead_id: 'lead-004',
    stage_id: 'stage-004',
    assigned_to: 'profile-adv-002',
    value: 800000,
    probability: 80,
    entered_at: daysAgo(14),
    updated_at: daysAgo(3),
  },
]

export const clients = [
  {
    id: 'client-001',
    lead_id: 'lead-003',
    first_name: 'Amelia',
    last_name: 'Stone',
    email: 'amelia.stone@yahoo.com',
    phone: '(646) 555-0175',
    advisor_id: 'profile-adv-001',
    aum: 650000,
    status: 'active',
    next_review_date: dateFromNow(21),
    created_at: daysAgo(30),
  },
  {
    id: 'client-002',
    lead_id: null,
    first_name: 'Caleb',
    last_name: 'Nguyen',
    email: 'caleb.nguyen@gmail.com',
    phone: '(408) 555-0181',
    advisor_id: 'profile-adv-002',
    aum: 1240000,
    status: 'at_risk',
    next_review_date: dateFromNow(9),
    created_at: daysAgo(220),
  },
  {
    id: 'client-003',
    lead_id: null,
    first_name: 'Grace',
    last_name: 'Henderson',
    email: 'grace.henderson@icloud.com',
    phone: '(312) 555-0149',
    advisor_id: 'profile-adv-001',
    aum: 410000,
    status: 'inactive',
    next_review_date: dateFromNow(45),
    created_at: daysAgo(410),
  },
]

export const meetings = [
  {
    id: makeId('mtg'),
    lead_id: 'lead-001',
    client_id: null,
    advisor_id: 'profile-adv-001',
    title: 'Intro Call — Evelyn Brooks',
    meeting_type: 'Zoom',
    meeting_url: 'https://zoom.us/j/000000000',
    start_time: hoursFromNow(36),
    end_time: hoursFromNow(37),
    status: 'scheduled',
    notes: '',
    created_at: daysAgo(1),
  },
  {
    id: makeId('mtg'),
    lead_id: null,
    client_id: 'client-001',
    advisor_id: 'profile-adv-001',
    title: 'Quarterly Review — Amelia Stone',
    meeting_type: 'Google Meet',
    meeting_url: 'https://meet.google.com/xxx-xxxx-xxx',
    start_time: hoursFromNow(60),
    end_time: hoursFromNow(61),
    status: 'scheduled',
    notes: 'Review allocation + tax-loss harvesting.',
    created_at: daysAgo(4),
  },
]

export const tasks = [
  {
    id: 'task-001',
    title: 'Send onboarding packet',
    description: 'Email forms + welcome letter and schedule next steps.',
    status: 'todo',
    priority: 'high',
    due_date: dateFromNow(-1),
    assigned_to: 'profile-adv-001',
    lead_id: 'lead-001',
    client_id: null,
    created_at: daysAgo(3),
  },
  {
    id: 'task-002',
    title: 'Prepare proposal summary',
    description: 'Draft IPS + allocation recommendations for review.',
    status: 'in_progress',
    priority: 'medium',
    due_date: dateFromNow(2),
    assigned_to: 'profile-adv-002',
    lead_id: 'lead-002',
    client_id: null,
    created_at: daysAgo(5),
  },
  {
    id: 'task-003',
    title: 'Update CRM notes',
    description: 'Add call notes and next steps from last client review.',
    status: 'done',
    priority: 'low',
    due_date: dateFromNow(-4),
    assigned_to: 'profile-adv-001',
    lead_id: null,
    client_id: 'client-001',
    created_at: daysAgo(8),
  },
  {
    id: 'task-004',
    title: 'Schedule annual review',
    description: 'Confirm next review date and send calendar invite.',
    status: 'todo',
    priority: 'medium',
    due_date: dateFromNow(7),
    assigned_to: 'profile-adv-002',
    lead_id: null,
    client_id: 'client-002',
    created_at: daysAgo(2),
  },
]

export const activity_logs = [
  {
    id: makeId('act'),
    actor_id: 'profile-adv-001',
    lead_id: 'lead-001',
    client_id: null,
    action: 'Lead assigned',
    details: { assigned_to: 'profile-adv-001', source: 'Referral' },
    created_at: daysAgo(0),
  },
  {
    id: makeId('act'),
    actor_id: 'profile-adv-002',
    lead_id: 'lead-002',
    client_id: null,
    action: 'Stage updated',
    details: { from: 'New', to: 'Qualified' },
    created_at: daysAgo(1),
  },
  {
    id: makeId('act'),
    actor_id: 'profile-adv-001',
    lead_id: null,
    client_id: 'client-001',
    action: 'Meeting scheduled',
    details: { meeting_type: 'Google Meet', start_time: hoursFromNow(60) },
    created_at: daysAgo(3),
  },
  {
    id: makeId('act'),
    actor_id: 'profile-mgr-001',
    lead_id: null,
    client_id: 'client-002',
    action: 'Task created',
    details: { title: 'Schedule annual review', priority: 'medium' },
    created_at: daysAgo(4),
  },
]

export const uiState = {
  lastSyncAt: new Date(now.getTime() - 23 * 60 * 1000).toISOString(),
}

