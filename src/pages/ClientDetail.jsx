import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft,
  Calendar as CalendarIcon,
  Check,
  ClipboardList,
  FileText,
  Film,
  FolderOpen,
  History,
  LayoutGrid,
  Mail,
  MessageSquare,
  Pencil,
  Phone,
  Plus,
  StickyNote,
  Trash2,
  Upload,
  Video,
  X,
} from 'lucide-react'
import { addClientNote, deleteClientNote, fetchClientDetail } from '../lib/queries.js'
import {
  deleteClientDocument,
  formatFileSize,
  getDocumentDownloadUrl,
  uploadClientDocument,
} from '../lib/documents.js'
import DocumentPreviewModal from '../components/documents/DocumentPreviewModal.jsx'
import { humanizeAction, summarizeActivityDetails } from '../lib/activity.js'
import { supabase } from '../lib/supabaseClient.js'
import { useAuth } from '../contexts/AuthContext.jsx'
import Avatar from '../components/ui/Avatar.jsx'
import RecordingList from '../components/recordings/RecordingList.jsx'
import MeetingModal from '../components/meetings/MeetingModal.jsx'
import Select from '../components/ui/Select.jsx'
import './ClientDetail.css'

const NOTE_KINDS = [
  { value: 'note', label: 'Note' },
  { value: 'call', label: 'Call' },
  { value: 'email', label: 'Email' },
  { value: 'meeting', label: 'Meeting' },
]

const taskPriorityOptions = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
]

function noteKindLabel(k) {
  return NOTE_KINDS.find((x) => x.value === k)?.label || 'Note'
}

function NoteKindIcon({ kind, size = 14 }) {
  if (kind === 'call') return <Phone size={size} />
  if (kind === 'email') return <Mail size={size} />
  if (kind === 'meeting') return <Video size={size} />
  return <StickyNote size={size} />
}

function formatCurrency(n) {
  const v = Number(n || 0)
  return v.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
}

function statusLabel(s) {
  if (s === 'active') return 'Active'
  if (s === 'at_risk') return 'At Risk'
  if (s === 'inactive') return 'Inactive'
  return String(s || '')
}

function statusClass(s) {
  if (s === 'active') return 'active'
  if (s === 'at_risk') return 'at-risk'
  if (s === 'inactive') return 'inactive'
  return ''
}

function initials(first, last) {
  return `${(first || '').charAt(0)}${(last || '').charAt(0)}`.toUpperCase() || '—'
}

function formatDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function taskStatusLabel(s) {
  if (s === 'todo') return 'To do'
  if (s === 'in_progress') return 'In progress'
  if (s === 'done') return 'Done'
  return String(s || '')
}

export default function ClientDetail() {
  const { id } = useParams()
  const { profile: me } = useAuth()
  const isAdmin = me?.role === 'admin'
  const [searchParams] = useSearchParams()
  const initialTab = ['overview', 'recordings', 'activity', 'notes', 'documents'].includes(
    searchParams.get('tab'),
  )
    ? searchParams.get('tab')
    : 'overview'
  const [state, setState] = useState({ loading: true, error: null, data: null })
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(null)
  const [saving, setSaving] = useState(false)
  const [tab, setTab] = useState(initialTab)

  const [noteKind, setNoteKind] = useState('note')
  const [noteBody, setNoteBody] = useState('')
  const [noteSaving, setNoteSaving] = useState(false)

  const [meetingOpen, setMeetingOpen] = useState(false)
  const [taskOpen, setTaskOpen] = useState(false)
  const [taskDraft, setTaskDraft] = useState(null)
  const [taskSaving, setTaskSaving] = useState(false)

  const [docUploading, setDocUploading] = useState(false)
  const [docError, setDocError] = useState(null)
  const [previewDoc, setPreviewDoc] = useState(null)

  const reload = useCallback(async () => {
    const data = await fetchClientDetail(id)
    setState({ loading: false, error: null, data })
    return data
  }, [id])

  useEffect(() => {
    let mounted = true
    async function load() {
      setState({ loading: true, error: null, data: null })
      try {
        const data = await fetchClientDetail(id)
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
  }, [id])

  const computed = useMemo(() => {
    const client = state.data?.client || null
    const profiles = state.data?.profiles || []
    const meetings = state.data?.meetings || []
    const tasks = state.data?.tasks || []
    const recordings = state.data?.recordings || []
    const activity = state.data?.activity || []
    const notes = state.data?.notes || []
    const documents = state.data?.documents || []
    const profilesMap = new Map(profiles.map((p) => [p.id, p]))
    const profile = (pid) => profilesMap.get(pid) || null
    const profileName = (pid) => profilesMap.get(pid)?.full_name || 'Someone'
    const advisorName = client?.advisor_id ? profilesMap.get(client.advisor_id)?.full_name || 'Unknown' : '—'
    const advisorOptions = [
      { value: '', label: '—' },
      ...profiles.map((p) => ({ value: p.id, label: p.full_name })),
    ]
    const statusOptions = [
      { value: 'active', label: 'Active' },
      { value: 'at_risk', label: 'At Risk' },
      { value: 'inactive', label: 'Inactive' },
    ]
    const now = Date.now()
    const upcoming = meetings
      .filter((m) => m.start_time && new Date(m.start_time).getTime() >= now && m.status !== 'canceled')
      .sort((a, b) => new Date(a.start_time) - new Date(b.start_time))
    const past = meetings
      .filter((m) => !(m.start_time && new Date(m.start_time).getTime() >= now && m.status !== 'canceled'))
      .sort((a, b) => new Date(b.start_time) - new Date(a.start_time))
    const openTasks = tasks.filter((t) => t.status !== 'done')
    return {
      client,
      advisorName,
      advisorOptions,
      statusOptions,
      upcoming,
      past,
      openTasks,
      recordings,
      activity,
      notes,
      documents,
      profile,
      profileName,
    }
  }, [state.data])

  function startEdit() {
    const c = computed.client
    if (!c) return
    setDraft({
      first_name: c.first_name || '',
      last_name: c.last_name || '',
      email: c.email || '',
      phone: c.phone || '',
      advisor_id: c.advisor_id || '',
      aum: c.aum ?? '',
      status: c.status || 'active',
      next_review_date: c.next_review_date || '',
    })
    setEditing(true)
  }

  function cancelEdit() {
    setEditing(false)
    setDraft(null)
  }

  async function saveEdit() {
    if (!draft) return
    setSaving(true)
    setState((s) => ({ ...s, error: null }))
    try {
      const patch = {
        first_name: draft.first_name || null,
        last_name: draft.last_name || null,
        email: draft.email || null,
        phone: draft.phone || null,
        advisor_id: draft.advisor_id || null,
        aum: draft.aum === '' ? null : Number(draft.aum),
        status: draft.status || null,
        next_review_date: draft.next_review_date || null,
      }
      const { data, error } = await supabase.from('clients').update(patch).eq('id', id).select('*').maybeSingle()
      if (error) throw error
      setState((s) => ({ ...s, data: { ...s.data, client: data } }))
      cancelEdit()
    } catch (e) {
      setState((s) => ({ ...s, error: e }))
    } finally {
      setSaving(false)
    }
  }

  async function onAddNote() {
    const body = noteBody.trim()
    if (!body || !me?.id) return
    setNoteSaving(true)
    setState((s) => ({ ...s, error: null }))
    try {
      await addClientNote({ clientId: id, authorId: me.id, kind: noteKind, body })
      setNoteBody('')
      setNoteKind('note')
      await reload()
    } catch (e) {
      setState((s) => ({ ...s, error: e }))
    } finally {
      setNoteSaving(false)
    }
  }

  async function onDeleteNote(noteId) {
    if (!window.confirm('Delete this note?')) return
    setState((s) => ({ ...s, error: null }))
    try {
      await deleteClientNote(noteId)
      await reload()
    } catch (e) {
      setState((s) => ({ ...s, error: e }))
    }
  }

  function openNewTask() {
    setTaskDraft({
      title: '',
      due_date: '',
      priority: 'medium',
      assigned_to: computed.client?.advisor_id || me?.id || '',
    })
    setTaskOpen(true)
  }

  async function onCreateTask() {
    if (!taskDraft?.title?.trim()) return
    setTaskSaving(true)
    setState((s) => ({ ...s, error: null }))
    try {
      const { error } = await supabase.from('tasks').insert({
        title: taskDraft.title.trim(),
        status: 'todo',
        priority: taskDraft.priority || 'medium',
        due_date: taskDraft.due_date || null,
        assigned_to: taskDraft.assigned_to || null,
        client_id: id,
        created_at: new Date().toISOString(),
      })
      if (error) throw error
      setTaskOpen(false)
      setTaskDraft(null)
      await reload()
    } catch (e) {
      setState((s) => ({ ...s, error: e }))
    } finally {
      setTaskSaving(false)
    }
  }

  async function onUploadDocument(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !me?.id) return
    setDocError(null)
    setDocUploading(true)
    try {
      await uploadClientDocument({ clientId: id, userId: me.id, file })
      await reload()
    } catch (err) {
      setDocError(err)
    } finally {
      setDocUploading(false)
    }
  }

  async function onDownloadDocument(doc) {
    setDocError(null)
    try {
      const url = await getDocumentDownloadUrl(doc.storage_path)
      if (!url) throw new Error('Could not generate download link.')
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (err) {
      setDocError(err)
    }
  }

  async function onDeleteDocument(doc) {
    if (!window.confirm(`Delete "${doc.file_name}"?`)) return
    setDocError(null)
    try {
      await deleteClientDocument(doc)
      await reload()
    } catch (err) {
      setDocError(err)
    }
  }

  if (state.loading) {
    return (
      <div>
        <Link to="/clients" className="backLink">
          <ArrowLeft size={16} /> Clients
        </Link>
        <div className="card" style={{ padding: 16, marginTop: 12 }}>
          <div className="muted">Loading client…</div>
        </div>
      </div>
    )
  }

  if (state.error || !computed.client) {
    return (
      <div>
        <Link to="/clients" className="backLink">
          <ArrowLeft size={16} /> Clients
        </Link>
        <div className="card" style={{ padding: 16, marginTop: 12 }}>
          <div className="muted">{state.error?.message || 'Client not found.'}</div>
        </div>
      </div>
    )
  }

  const c = computed.client
  const fullName = [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Client'

  return (
    <div className="clientDetail">
      <Link to="/clients" className="backLink">
        <ArrowLeft size={16} /> Clients
      </Link>

      {state.error ? (
        <div className="card" style={{ padding: 14, margin: '12px 0' }}>
          <div className="muted">Error: {state.error.message || 'Something went wrong.'}</div>
        </div>
      ) : null}

      <div className="card cdHeader">
        <div className="cdIdentity">
          <div className="cdAvatar" aria-hidden="true">
            {initials(c.first_name, c.last_name)}
          </div>
          <div>
            <div className="cdName">{fullName}</div>
            <div className="cdSubRow">
              <span className={['statusPill', statusClass(c.status)].join(' ')}>{statusLabel(c.status)}</span>
              <span className="muted">Advisor: {computed.advisorName}</span>
            </div>
          </div>
        </div>
        <div className="cdHeaderRight">
          <div className="cdAum">
            <div className="cdAumLabel">AUM</div>
            <div className="cdAumValue">{formatCurrency(c.aum)}</div>
          </div>
          <div className="cdActions">
            <button className="btnSecondary" type="button" onClick={() => setMeetingOpen(true)}>
              <Video size={16} /> New meeting
            </button>
            <button className="btnSecondary" type="button" onClick={openNewTask}>
              <Plus size={16} /> New task
            </button>
            {!editing ? (
              <button className="btnSecondary" type="button" onClick={startEdit}>
                <Pencil size={16} /> Edit
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {editing && draft ? (
        <div className="card cdEditCard">
          <div className="formGrid">
            <label className="sField">
              <div className="sLabel">First name</div>
              <input className="sInput" value={draft.first_name} onChange={(e) => setDraft((d) => ({ ...d, first_name: e.target.value }))} />
            </label>
            <label className="sField">
              <div className="sLabel">Last name</div>
              <input className="sInput" value={draft.last_name} onChange={(e) => setDraft((d) => ({ ...d, last_name: e.target.value }))} />
            </label>
            <label className="sField">
              <div className="sLabel">Email</div>
              <input className="sInput" value={draft.email} onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))} />
            </label>
            <label className="sField">
              <div className="sLabel">Phone</div>
              <input className="sInput" value={draft.phone} onChange={(e) => setDraft((d) => ({ ...d, phone: e.target.value }))} />
            </label>
            <label className="sField">
              <div className="sLabel">Advisor</div>
              <Select value={draft.advisor_id} onChange={(v) => setDraft((d) => ({ ...d, advisor_id: v }))} options={computed.advisorOptions} placeholder="—" />
            </label>
            <label className="sField">
              <div className="sLabel">AUM</div>
              <input className="sInput" type="number" value={draft.aum} onChange={(e) => setDraft((d) => ({ ...d, aum: e.target.value }))} />
            </label>
            <label className="sField">
              <div className="sLabel">Status</div>
              <Select value={draft.status} onChange={(v) => setDraft((d) => ({ ...d, status: v }))} options={computed.statusOptions} />
            </label>
            <label className="sField">
              <div className="sLabel">Next review date</div>
              <input className="sInput" type="date" value={draft.next_review_date} onChange={(e) => setDraft((d) => ({ ...d, next_review_date: e.target.value }))} />
            </label>
          </div>
          <div className="cdEditActions">
            <button className="btnSecondary" type="button" onClick={cancelEdit} disabled={saving}>
              <X size={16} /> Cancel
            </button>
            <button className="btnPrimary" type="button" onClick={saveEdit} disabled={saving}>
              <Check size={16} /> {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      ) : (
        <div className="card cdFacts">
          <div className="cdFact">
            <div className="cdFactLabel">Email</div>
            <div className="cdFactValue">{c.email || '—'}</div>
          </div>
          <div className="cdFact">
            <div className="cdFactLabel">Phone</div>
            <div className="cdFactValue">{c.phone || '—'}</div>
          </div>
          <div className="cdFact">
            <div className="cdFactLabel">Next review</div>
            <div className="cdFactValue">{c.next_review_date || '—'}</div>
          </div>
        </div>
      )}

      <div className="cdTabs" role="tablist">
        <button
          type="button"
          role="tab"
          className={['cdTab', tab === 'overview' ? 'isActive' : ''].join(' ')}
          onClick={() => setTab('overview')}
        >
          <LayoutGrid size={15} /> Overview
        </button>
        <button
          type="button"
          role="tab"
          className={['cdTab', tab === 'recordings' ? 'isActive' : ''].join(' ')}
          onClick={() => setTab('recordings')}
        >
          <Film size={15} /> Recordings
          {computed.recordings.length ? <span className="cdTabCount">{computed.recordings.length}</span> : null}
        </button>
        <button
          type="button"
          role="tab"
          className={['cdTab', tab === 'notes' ? 'isActive' : ''].join(' ')}
          onClick={() => setTab('notes')}
        >
          <MessageSquare size={15} /> Notes
          {computed.notes.length ? <span className="cdTabCount">{computed.notes.length}</span> : null}
        </button>
        <button
          type="button"
          role="tab"
          className={['cdTab', tab === 'documents' ? 'isActive' : ''].join(' ')}
          onClick={() => setTab('documents')}
        >
          <FolderOpen size={15} /> Documents
          {computed.documents.length ? (
            <span className="cdTabCount">{computed.documents.length}</span>
          ) : null}
        </button>
        <button
          type="button"
          role="tab"
          className={['cdTab', tab === 'activity' ? 'isActive' : ''].join(' ')}
          onClick={() => setTab('activity')}
        >
          <History size={15} /> Activity
        </button>
      </div>

      {tab === 'overview' ? (
      <div className="cdGrid">
        <div className="card cdPanel">
          <div className="cdPanelHead">
            <CalendarIcon size={16} />
            <span>Upcoming meetings</span>
            <span className="cdCount">{computed.upcoming.length}</span>
          </div>
          {computed.upcoming.length === 0 ? (
            <div className="muted cdEmpty">No upcoming meetings.</div>
          ) : (
            <ul className="cdList">
              {computed.upcoming.map((m) => (
                <li key={m.id} className="cdListItem">
                  <div className="cdItemMain">{m.title || 'Meeting'}</div>
                  <div className="cdItemMeta">{formatDateTime(m.start_time)}</div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card cdPanel">
          <div className="cdPanelHead">
            <CalendarIcon size={16} />
            <span>Past meetings</span>
            <span className="cdCount">{computed.past.length}</span>
          </div>
          {computed.past.length === 0 ? (
            <div className="muted cdEmpty">No past meetings.</div>
          ) : (
            <ul className="cdList">
              {computed.past.slice(0, 8).map((m) => (
                <li key={m.id} className="cdListItem">
                  <div className="cdItemMain">{m.title || 'Meeting'}</div>
                  <div className="cdItemMeta">
                    {formatDateTime(m.start_time)}
                    {m.status ? <span className="cdItemStatus"> · {m.status}</span> : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card cdPanel">
          <div className="cdPanelHead">
            <ClipboardList size={16} />
            <span>Open tasks</span>
            <span className="cdCount">{computed.openTasks.length}</span>
          </div>
          {computed.openTasks.length === 0 ? (
            <div className="muted cdEmpty">No open tasks.</div>
          ) : (
            <ul className="cdList">
              {computed.openTasks.map((t) => (
                <li key={t.id} className="cdListItem">
                  <div className="cdItemMain">{t.title}</div>
                  <div className="cdItemMeta">
                    {t.due_date ? `Due ${t.due_date}` : 'No due date'}
                    <span className="cdItemStatus"> · {taskStatusLabel(t.status)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      ) : null}

      {tab === 'recordings' ? (
        <div className="card cdPanel cdTabPanel">
          <div className="cdPanelHead">
            <Film size={16} />
            <span>Recordings &amp; transcripts</span>
            <span className="cdCount">{computed.recordings.length}</span>
          </div>
          {computed.recordings.length === 0 ? (
            <div className="muted cdEmpty">
              No recordings yet. They appear automatically once a recorded Zoom meeting with this client finishes processing.
            </div>
          ) : (
            <RecordingList recordings={computed.recordings} showDate />
          )}
        </div>
      ) : null}

      {tab === 'notes' ? (
        <div className="card cdPanel cdTabPanel">
          <div className="cdNoteComposer">
            <div className="cdNoteComposerTop">
              <Select value={noteKind} onChange={setNoteKind} options={NOTE_KINDS} size="sm" />
            </div>
            <textarea
              className="sInput"
              rows={3}
              value={noteBody}
              onChange={(e) => setNoteBody(e.target.value)}
              placeholder="Log a call, email, or note about this client…"
            />
            <div className="cdNoteComposerActions">
              <button
                className="btnPrimary"
                type="button"
                onClick={onAddNote}
                disabled={!noteBody.trim() || noteSaving}
              >
                <Plus size={16} /> {noteSaving ? 'Saving…' : 'Add note'}
              </button>
            </div>
          </div>

          {computed.notes.length === 0 ? (
            <div className="muted cdEmpty">No notes yet. Log your first interaction above.</div>
          ) : (
            <ul className="cdNotes">
              {computed.notes.map((n) => (
                <li key={n.id} className="cdNote">
                  <div className="cdNoteIcon">
                    <NoteKindIcon kind={n.kind} />
                  </div>
                  <div className="cdNoteBody">
                    <div className="cdNoteMeta">
                      <span className="cdNoteKind">{noteKindLabel(n.kind)}</span>
                      <span className="cdNoteAuthor">{computed.profileName(n.author_id)}</span>
                      <span className="cdNoteTime">{formatDateTime(n.created_at)}</span>
                      {n.author_id === me?.id || isAdmin ? (
                        <button
                          className="cdNoteDelete"
                          type="button"
                          onClick={() => onDeleteNote(n.id)}
                          aria-label="Delete note"
                          title="Delete note"
                        >
                          <Trash2 size={14} />
                        </button>
                      ) : null}
                    </div>
                    <div className="cdNoteText">{n.body}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {tab === 'documents' ? (
        <div className="card cdPanel cdTabPanel">
          <div className="cdPanelHead">
            <FolderOpen size={16} />
            <span>Compliance vault</span>
            <span className="cdCount">{computed.documents.length}</span>
          </div>

          <div className="cdDocUpload">
            <label className="btnSecondary cdDocUploadBtn">
              <Upload size={16} />
              {docUploading ? 'Uploading…' : 'Upload document'}
              <input
                type="file"
                hidden
                disabled={docUploading}
                onChange={onUploadDocument}
                accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.txt,.csv"
              />
            </label>
            <div className="sHint">Statements, agreements, KYC forms — up to 50 MB.</div>
          </div>

          {docError ? (
            <div className="inlineError">{docError.message || 'Document error.'}</div>
          ) : null}

          {computed.documents.length === 0 ? (
            <div className="muted cdEmpty">No documents uploaded yet.</div>
          ) : (
            <ul className="cdDocList">
              {computed.documents.map((doc) => (
                <li key={doc.id} className="cdDocItem">
                  <span className="cdDocIcon">
                    <FileText size={16} />
                  </span>
                  <button
                    type="button"
                    className="cdDocBody cdDocOpen"
                    onClick={() => setPreviewDoc(doc)}
                    title="Preview document"
                  >
                    <div className="cdDocName">{doc.file_name}</div>
                    <div className="cdDocMeta">
                      {formatFileSize(doc.file_size)} · {computed.profileName(doc.uploaded_by)} ·{' '}
                      {formatDateTime(doc.created_at)}
                    </div>
                  </button>
                  <div className="cdDocActions">
                    <button className="btnSecondary" type="button" onClick={() => onDownloadDocument(doc)}>
                      Download
                    </button>
                    {doc.uploaded_by === me?.id || isAdmin ? (
                      <button className="btnSecondary" type="button" onClick={() => onDeleteDocument(doc)}>
                        <Trash2 size={14} />
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {tab === 'activity' ? (
        <div className="card cdPanel cdTabPanel">
          <div className="cdPanelHead">
            <History size={16} />
            <span>Activity timeline</span>
            <span className="cdCount">{computed.activity.length}</span>
          </div>
          {computed.activity.length === 0 ? (
            <div className="muted cdEmpty">No activity recorded for this client yet.</div>
          ) : (
            <ul className="cdTimeline">
              {computed.activity.map((a) => {
                const detail = summarizeActivityDetails(a.action, a.details)
                return (
                  <li key={a.id} className="cdTimelineItem">
                    <Avatar
                      name={computed.profileName(a.actor_id)}
                      src={computed.profile(a.actor_id)?.avatar_url || ''}
                      size="sm"
                    />
                    <div className="cdTimelineBody">
                      <div className="cdTimelineMain">
                        <span className="cdTimelineActor">{computed.profileName(a.actor_id)}</span>{' '}
                        <span className="cdTimelineAction">{humanizeAction(a.action)}</span>
                      </div>
                      {detail ? <div className="cdTimelineDetail">{detail}</div> : null}
                      <div className="cdTimelineTime">{formatDateTime(a.created_at)}</div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      ) : null}

      {meetingOpen ? (
        <MeetingModal
          open={meetingOpen}
          onClose={() => setMeetingOpen(false)}
          meeting={{ client_id: id, advisor_id: c.advisor_id || me?.id || null }}
          me={me}
          isAdmin={isAdmin}
          profiles={state.data?.profiles || []}
          leads={[]}
          clients={[{ id: c.id, full_name: fullName, email: c.email }]}
          onSaved={async () => {
            setMeetingOpen(false)
            await reload()
          }}
        />
      ) : null}

      {taskOpen && taskDraft ? (
        <div className="modalOverlay" role="dialog" aria-modal="true">
          <div className="modalCard">
            <div className="modalHeader">
              <div>
                <div className="modalTitle">New task</div>
                <div className="modalSub">For {fullName}</div>
              </div>
              <button className="iconBtn" type="button" onClick={() => setTaskOpen(false)} aria-label="Close">
                <X size={16} />
              </button>
            </div>
            <div className="modalBody">
              <div className="formGrid">
                <label className="sField" style={{ gridColumn: '1 / -1' }}>
                  <div className="sLabel">Title</div>
                  <input
                    className="sInput"
                    value={taskDraft.title}
                    onChange={(e) => setTaskDraft((d) => ({ ...d, title: e.target.value }))}
                    placeholder="Follow up, prep review, send documents…"
                  />
                </label>
                <label className="sField">
                  <div className="sLabel">Due date</div>
                  <input
                    className="sInput"
                    type="date"
                    value={taskDraft.due_date}
                    onChange={(e) => setTaskDraft((d) => ({ ...d, due_date: e.target.value }))}
                  />
                </label>
                <label className="sField">
                  <div className="sLabel">Priority</div>
                  <Select
                    value={taskDraft.priority}
                    onChange={(v) => setTaskDraft((d) => ({ ...d, priority: v }))}
                    options={taskPriorityOptions}
                  />
                </label>
                <label className="sField">
                  <div className="sLabel">Assign to</div>
                  <Select
                    value={taskDraft.assigned_to || ''}
                    onChange={(v) => setTaskDraft((d) => ({ ...d, assigned_to: v }))}
                    options={computed.advisorOptions}
                    placeholder="—"
                  />
                </label>
              </div>
            </div>
            <div className="modalFooter">
              <button className="btnSecondary" type="button" onClick={() => setTaskOpen(false)} disabled={taskSaving}>
                Cancel
              </button>
              <button
                className="btnPrimary"
                type="button"
                onClick={onCreateTask}
                disabled={!taskDraft.title.trim() || taskSaving}
              >
                <Check size={16} /> {taskSaving ? 'Creating…' : 'Create task'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <DocumentPreviewModal
        doc={previewDoc}
        open={Boolean(previewDoc)}
        onClose={() => setPreviewDoc(null)}
      />
    </div>
  )
}
