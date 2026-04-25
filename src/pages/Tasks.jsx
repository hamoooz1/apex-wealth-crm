import { Plus, Calendar, Link2, Flag, Save, X, Pencil, ChevronDown } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { fetchTasksPageData } from '../lib/queries.js'
import { fetchProfilesPageData } from '../lib/queries.js'
import { supabase } from '../lib/supabaseClient.js'
import { useAuth } from '../contexts/AuthContext.jsx'

function linkedName(t, leadsMap, clientsMap) {
  if (t.client_id) {
    const c = clientsMap.get(t.client_id)
    if (c) return `${c.first_name} ${c.last_name}`
  }
  if (t.lead_id) {
    const l = leadsMap.get(t.lead_id)
    if (l) return `${l.first_name} ${l.last_name}`
  }
  return null
}

function priorityLabel(p) {
  if (p === 'high') return 'High'
  if (p === 'medium') return 'Medium'
  return 'Low'
}

const statusOptions = [
  { value: 'todo', label: 'To Do' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'done', label: 'Done' },
]

export default function Tasks() {
  const { profile: me } = useAuth()
  const [state, setState] = useState({ loading: true, error: null, data: null })
  const [profiles, setProfiles] = useState([])
  const profilesMap = useMemo(
    () => new Map((profiles || []).map((p) => [p.id, p])),
    [profiles],
  )

  const [modalOpen, setModalOpen] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [draft, setDraft] = useState(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [draggingId, setDraggingId] = useState(null)
  const [dropCol, setDropCol] = useState(null)

  useEffect(() => {
    let mounted = true
    async function load() {
      setState({ loading: true, error: null, data: null })
      try {
        const [data, profilesRows] = await Promise.all([
          fetchTasksPageData(),
          fetchProfilesPageData(),
        ])
        if (!mounted) return
        setState({ loading: false, error: null, data })
        setProfiles(profilesRows)
      } catch (e) {
        if (!mounted) return
        setState({ loading: false, error: e, data: null })
      }
    }
    load()
    return () => {
      mounted = false
    }
  }, [])

  const computed = useMemo(() => {
    const tasks = state.data?.tasks || []
    const leads = state.data?.leads || []
    const clients = state.data?.clients || []
    const leadsMap = new Map(leads.map((l) => [l.id, l]))
    const clientsMap = new Map(clients.map((c) => [c.id, c]))

    const todo = tasks.filter((t) => t.status === 'todo')
    const inProgress = tasks.filter((t) => t.status === 'in_progress')
    const done = tasks.filter((t) => t.status === 'done')
    const pendingCount = todo.length + inProgress.length

    return { tasks, leadsMap, clientsMap, todo, inProgress, done, pendingCount }
  }, [state.data, state.loading, state.error])

  const cols = [
    { key: 'todo', title: 'To Do', items: computed.todo || [] },
    { key: 'in_progress', title: 'In Progress', items: computed.inProgress || [] },
    { key: 'done', title: 'Done', items: computed.done || [] },
  ]

  function openCreate() {
    setEditingId(null)
    setDraft({
      title: '',
      description: '',
      status: 'todo',
      priority: 'medium',
      due_date: '',
      assigned_to: me?.id || '',
      lead_id: '',
      client_id: '',
    })
    setDirty(false)
    setModalOpen(true)
  }

  function openEdit(t) {
    setEditingId(t.id)
    setDraft({
      title: t.title || '',
      description: t.description || '',
      status: t.status || 'todo',
      priority: t.priority || 'medium',
      due_date: t.due_date || '',
      assigned_to: t.assigned_to || '',
      lead_id: t.lead_id || '',
      client_id: t.client_id || '',
    })
    setDirty(false)
    setModalOpen(true)
  }

  async function saveTask() {
    if (!draft) return
    setSaving(true)
    setState((s) => ({ ...s, error: null }))
    try {
      const payload = {
        title: draft.title,
        description: draft.description || null,
        status: draft.status,
        priority: draft.priority,
        due_date: draft.due_date || null,
        assigned_to: draft.assigned_to || null,
        lead_id: draft.lead_id || null,
        client_id: draft.client_id || null,
      }

      if (editingId) {
        const { data, error } = await supabase
          .from('tasks')
          .update(payload)
          .eq('id', editingId)
          .select('*')
          .maybeSingle()
        if (error) throw error
        setState((s) => ({
          ...s,
          data: { ...s.data, tasks: (s.data?.tasks || []).map((t) => (t.id === editingId ? data : t)) },
        }))
      } else {
        const insertPayload = { ...payload, created_at: new Date().toISOString() }
        const { data, error } = await supabase
          .from('tasks')
          .insert(insertPayload)
          .select('*')
          .maybeSingle()
        if (error) throw error
        setState((s) => ({
          ...s,
          data: { ...s.data, tasks: [data, ...(s.data?.tasks || [])] },
        }))
      }

      setDirty(false)
      setModalOpen(false)
    } catch (e) {
      setState((s) => ({ ...s, error: e }))
    } finally {
      setSaving(false)
    }
  }

  async function quickSetStatus(taskId, status) {
    setState((s) => ({ ...s, error: null }))
    try {
      // optimistic
      setState((s) => ({
        ...s,
        data: {
          ...s.data,
          tasks: (s.data?.tasks || []).map((t) =>
            t.id === taskId ? { ...t, status } : t,
          ),
        },
      }))

      const { data, error } = await supabase
        .from('tasks')
        .update({ status })
        .eq('id', taskId)
        .select('*')
        .maybeSingle()
      if (error) throw error
      setState((s) => ({
        ...s,
        data: {
          ...s.data,
          tasks: (s.data?.tasks || []).map((t) => (t.id === taskId ? data : t)),
        },
      }))
    } catch (e) {
      // rollback (best-effort): reload tasks list
      try {
        const data = await fetchTasksPageData()
        setState({ loading: false, error: e, data })
      } catch {
        // ignore
      }
      setState((s) => ({ ...s, error: e }))
    }
  }

  function onDragStart(e, taskId) {
    setDraggingId(taskId)
    setDropCol(null)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', taskId)
    // needed for some browsers to show drag image
    e.dataTransfer.setDragImage(e.currentTarget, 20, 20)
  }

  function onDragEnd() {
    setDraggingId(null)
    setDropCol(null)
  }

  function onDragOverCol(e, colKey) {
    e.preventDefault()
    if (dropCol !== colKey) setDropCol(colKey)
    e.dataTransfer.dropEffect = 'move'
  }

  async function onDropCol(e, colKey) {
    e.preventDefault()
    const taskId = e.dataTransfer.getData('text/plain') || draggingId
    setDropCol(null)
    setDraggingId(null)
    if (!taskId) return
    await quickSetStatus(taskId, colKey)
  }

  function assignedName(id) {
    if (!id) return 'Unassigned'
    return profilesMap.get(id)?.full_name || 'Unknown'
  }

  return (
    <div>
      <div className="pageHeader">
        <div>
          <h1 className="pageTitle">Tasks</h1>
          <div className="pageSubtitle">
            {state.loading ? 'Loading…' : `${computed.pendingCount || 0} pending`}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button className="btnPrimary" type="button" onClick={openCreate}>
            <Plus size={16} />
            New Task
          </button>
        </div>
      </div>

      {state.error ? (
        <div className="card" style={{ padding: 14, marginBottom: 12 }}>
          <div className="muted">Error: {state.error.message || 'Something went wrong.'}</div>
        </div>
      ) : null}

      <div className="kanbanBoard">
        {cols.map((col) => (
          <div
            className={[
              'kanbanCol',
              dropCol === col.key ? 'kanbanColDrop' : null,
            ]
              .filter(Boolean)
              .join(' ')}
            key={col.key}
            onDragOver={(e) => onDragOverCol(e, col.key)}
            onDragEnter={(e) => onDragOverCol(e, col.key)}
            onDragLeave={() => setDropCol((x) => (x === col.key ? null : x))}
            onDrop={(e) => onDropCol(e, col.key)}
          >
            <div className="kanbanColHeader">
              <div className="kanbanColTitle">{col.title}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div className="pillCount">{col.items.length} items</div>
                <button className="iconBtn" type="button" aria-label="Add task" onClick={openCreate}>
                  <Plus size={16} />
                </button>
              </div>
            </div>

            {state.loading ? (
              <div className="emptyState">Loading tasks…</div>
            ) : state.error ? (
              <div className="emptyState">Failed to load tasks.</div>
            ) : col.items.length === 0 ? (
              <div className="emptyState">No tasks</div>
            ) : (
              col.items.map((t) => {
                const link = linkedName(t, computed.leadsMap, computed.clientsMap)
                return (
                  <div
                    className={[
                      'taskCard',
                      draggingId === t.id ? 'taskCardDragging' : null,
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    key={t.id}
                    draggable
                    onDragStart={(e) => onDragStart(e, t.id)}
                    onDragEnd={onDragEnd}
                  >
                    <div className="taskTopRow">
                      <h3 className="taskTitle">{t.title}</h3>
                      <button className="iconBtn" type="button" aria-label="Edit task" onClick={() => openEdit(t)}>
                        <Pencil size={16} />
                      </button>
                    </div>
                    <div className="taskDesc">{t.description}</div>
                    <div className="taskMeta">
                      <span className="tag">
                        <ChevronDown size={14} />
                        <select
                          className="inlineSelect"
                          value={t.status || 'todo'}
                          onChange={(e) => quickSetStatus(t.id, e.target.value)}
                        >
                          {statusOptions.map((s) => (
                            <option key={s.value} value={s.value}>
                              {s.label}
                            </option>
                          ))}
                        </select>
                      </span>
                      <span className={['tag', `priority-${t.priority}`].join(' ')}>
                        <Flag size={14} />
                        {priorityLabel(t.priority)}
                      </span>
                      <span className="tag">
                        <Calendar size={14} />
                        {t.due_date || 'No due date'}
                      </span>
                      <span className="tag">
                        <Link2 size={14} />
                        {assignedName(t.assigned_to)}
                      </span>
                      {link ? (
                        <span className="tag">
                          <Link2 size={14} />
                          {link}
                        </span>
                      ) : null}
                    </div>
                  </div>
                )
              })
            )}
          </div>
        ))}
      </div>

      {modalOpen && draft ? (
        <div className="modalOverlay" role="dialog" aria-modal="true">
          <div className="modalCard">
            <div className="modalHeader">
              <div>
                <div className="modalTitle">{editingId ? 'Edit Task' : 'New Task'}</div>
                <div className="modalSub">Task details and linkage</div>
              </div>
              <button className="iconBtn" type="button" onClick={() => setModalOpen(false)} aria-label="Close">
                <X size={16} />
              </button>
            </div>

            <div className="modalBody">
              <div className="formGrid">
                <label className="sField" style={{ gridColumn: '1 / -1' }}>
                  <div className="sLabel">Title</div>
                  <input
                    className="sInput"
                    value={draft.title}
                    onChange={(e) => {
                      setDraft((d) => ({ ...d, title: e.target.value }))
                      setDirty(true)
                    }}
                  />
                </label>
                <label className="sField" style={{ gridColumn: '1 / -1' }}>
                  <div className="sLabel">Description</div>
                  <textarea
                    className="sTextarea"
                    rows={4}
                    value={draft.description}
                    onChange={(e) => {
                      setDraft((d) => ({ ...d, description: e.target.value }))
                      setDirty(true)
                    }}
                  />
                </label>

                <label className="sField">
                  <div className="sLabel">Status</div>
                  <select
                    className="sInput"
                    value={draft.status}
                    onChange={(e) => {
                      setDraft((d) => ({ ...d, status: e.target.value }))
                      setDirty(true)
                    }}
                  >
                    {statusOptions.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="sField">
                  <div className="sLabel">Priority</div>
                  <select
                    className="sInput"
                    value={draft.priority}
                    onChange={(e) => {
                      setDraft((d) => ({ ...d, priority: e.target.value }))
                      setDirty(true)
                    }}
                  >
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                  </select>
                </label>

                <label className="sField">
                  <div className="sLabel">Due date</div>
                  <input
                    className="sInput"
                    type="date"
                    value={draft.due_date}
                    onChange={(e) => {
                      setDraft((d) => ({ ...d, due_date: e.target.value }))
                      setDirty(true)
                    }}
                  />
                </label>

                <label className="sField">
                  <div className="sLabel">Assigned to</div>
                  <select
                    className="sInput"
                    value={draft.assigned_to}
                    onChange={(e) => {
                      setDraft((d) => ({ ...d, assigned_to: e.target.value }))
                      setDirty(true)
                    }}
                  >
                    <option value="">—</option>
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.full_name}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="sField">
                  <div className="sLabel">Linked lead</div>
                  <select
                    className="sInput"
                    value={draft.lead_id}
                    onChange={(e) => {
                      setDraft((d) => ({ ...d, lead_id: e.target.value, client_id: '' }))
                      setDirty(true)
                    }}
                  >
                    <option value="">—</option>
                    {(state.data?.leads || []).map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.first_name} {l.last_name}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="sField">
                  <div className="sLabel">Linked client</div>
                  <select
                    className="sInput"
                    value={draft.client_id}
                    onChange={(e) => {
                      setDraft((d) => ({ ...d, client_id: e.target.value, lead_id: '' }))
                      setDirty(true)
                    }}
                  >
                    <option value="">—</option>
                    {(state.data?.clients || []).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.first_name} {c.last_name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>

            <div className="modalFooter">
              <button className="btnSecondary" type="button" onClick={() => setModalOpen(false)}>
                Cancel
              </button>
              <button
                className="btnPrimary"
                type="button"
                disabled={!dirty || saving || !draft.title}
                onClick={saveTask}
              >
                <Save size={16} />
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

