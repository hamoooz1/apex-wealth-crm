import { Plus, Calendar, Link2, Flag } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { fetchTasksPageData } from '../lib/queries.js'

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

export default function Tasks() {
  const [state, setState] = useState({ loading: true, error: null, data: null })

  useEffect(() => {
    let mounted = true
    async function load() {
      setState({ loading: true, error: null, data: null })
      try {
        const data = await fetchTasksPageData()
        if (!mounted) return
        setState({ loading: false, error: null, data })
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

  return (
    <div>
      <div className="pageHeader">
        <div>
          <h1 className="pageTitle">Tasks</h1>
          <div className="pageSubtitle">
            {state.loading ? 'Loading…' : `${computed.pendingCount || 0} pending`}
          </div>
        </div>
      </div>

      <div className="kanbanBoard">
        {cols.map((col) => (
          <div className="kanbanCol" key={col.key}>
            <div className="kanbanColHeader">
              <div className="kanbanColTitle">{col.title}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div className="pillCount">{col.items.length} items</div>
                <button className="iconBtn" type="button" aria-label="Add task">
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
                  <div className="taskCard" key={t.id}>
                    <h3 className="taskTitle">{t.title}</h3>
                    <div className="taskDesc">{t.description}</div>
                    <div className="taskMeta">
                      <span className={['tag', `priority-${t.priority}`].join(' ')}>
                        <Flag size={14} />
                        {priorityLabel(t.priority)}
                      </span>
                      <span className="tag">
                        <Calendar size={14} />
                        {t.due_date || 'No due date'}
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
    </div>
  )
}

