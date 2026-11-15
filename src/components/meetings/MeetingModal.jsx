import { useEffect, useMemo, useState } from 'react'
import { Save, Video } from 'lucide-react'
import './MeetingModal.css'
import { createMeeting, getMeetingRecordings, updateMeetingById } from '../../lib/queries.js'
import { createZoomMeeting, getMyZoomConnection, zoomMeetingFields } from '../../lib/zoom.js'
import RecordingList from '../recordings/RecordingList.jsx'
import Select from '../ui/Select.jsx'

const meetingStatusOptions = [
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'completed', label: 'Completed' },
  { value: 'canceled', label: 'Canceled' },
  { value: 'no_show', label: 'No-show' },
]

function toLocalInputValue(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n) => String(n).padStart(2, '0')
  const yyyy = d.getFullYear()
  const mm = pad(d.getMonth() + 1)
  const dd = pad(d.getDate())
  const hh = pad(d.getHours())
  const mi = pad(d.getMinutes())
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`
}

function fromLocalInputValue(v) {
  if (!v) return null
  const d = new Date(v)
  return d.toISOString()
}

function sameFieldValue(a, b) {
  if (a == null && b == null) return true
  if (a == null || b == null) return false
  const left = Date.parse(a)
  const right = Date.parse(b)
  if (!Number.isNaN(left) && !Number.isNaN(right)) return left === right
  return String(a) === String(b)
}

function formatProviderValue(field, value) {
  if (value == null || value === '') return ''
  if (field === 'start_time' || field === 'end_time') {
    const d = new Date(value)
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    }
  }
  return String(value)
}

/** Advisor-owned value when it differs from the last provider payload. */
function providerDrift(draft, field) {
  if (draft?.field_origins?.[field] !== 'advisor') return null
  const snap = draft?.provider_snapshot?.[field]
  if (snap == null || snap === '') return null
  if (sameFieldValue(snap, draft[field])) return null
  return formatProviderValue(field, snap)
}

export default function MeetingModal({
  open,
  onClose,
  meeting,
  me,
  isAdmin,
  profiles = [],
  leads = [],
  clients = [],
  onSaved,
}) {
  const isCalendly = meeting?.source === 'calendly'
  const isNew = !meeting?.id

  const [draft, setDraft] = useState(() => ({
    id: meeting?.id || null,
    advisor_id: meeting?.advisor_id || (me?.id || null),
    title: meeting?.title || '',
    start_time: meeting?.start_time || new Date().toISOString(),
    end_time: meeting?.end_time || null,
    meeting_type: meeting?.meeting_type || '',
    meeting_url: meeting?.meeting_url || '',
    status: meeting?.status || 'scheduled',
    notes: meeting?.notes || '',
    lead_id: meeting?.lead_id || null,
    client_id: meeting?.client_id || null,
    source: meeting?.source || 'manual',
    external_provider: meeting?.external_provider || null,
    external_event_uri: meeting?.external_event_uri || null,
    location: meeting?.location || null,
    field_origins: meeting?.field_origins || {},
    provider_snapshot: meeting?.provider_snapshot || {},
    zoom_meeting_id: meeting?.zoom_meeting_id || meeting?.location?.zoom_meeting_id || null,
    provider_summary: meeting?.provider_summary || '',
  }))

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [hasZoom, setHasZoom] = useState(false)
  const [zoomBusy, setZoomBusy] = useState(false)
  const [zoomError, setZoomError] = useState(null)
  const [recordings, setRecordings] = useState([])

  useEffect(() => {
    let mounted = true
    async function loadZoom() {
      if (!open || !me?.id) return
      try {
        const conn = await getMyZoomConnection(me.id)
        if (mounted) setHasZoom(Boolean(conn))
      } catch {
        if (mounted) setHasZoom(false)
      }
    }
    loadZoom()
    return () => {
      mounted = false
    }
  }, [open, me?.id])

  useEffect(() => {
    let mounted = true
    async function loadRecordings() {
      if (!open || !meeting?.id) {
        setRecordings([])
        return
      }
      try {
        const recs = await getMeetingRecordings(meeting.id, meeting.zoom_meeting_id)
        if (mounted) setRecordings(recs)
      } catch {
        if (mounted) setRecordings([])
      }
    }
    loadRecordings()
    return () => {
      mounted = false
    }
  }, [open, meeting?.id, meeting?.zoom_meeting_id])

  const isZoomMeeting = draft.source === 'zoom' || draft.external_provider === 'zoom'

  const advisors = useMemo(() => {
    return profiles.filter((p) => p.role === 'advisor' || p.role === 'manager' || p.role === 'admin')
  }, [profiles])

  const advisorOptions = useMemo(
    () => [
      { value: '', label: '—' },
      ...advisors.map((p) => ({ value: p.id, label: p.full_name })),
    ],
    [advisors],
  )

  const leadOptions = useMemo(
    () => [
      { value: '', label: '—' },
      ...leads.map((l) => ({ value: l.id, label: l.full_name || l.email || l.id })),
    ],
    [leads],
  )

  const clientOptions = useMemo(
    () => [
      { value: '', label: '—' },
      ...clients.map((c) => ({ value: c.id, label: c.full_name || c.email || c.id })),
    ],
    [clients],
  )

  if (!open) return null

  const canEditCore = !isCalendly
  const titleDrift = providerDrift(draft, 'title')
  const startDrift = providerDrift(draft, 'start_time')
  const providerName = draft.source === 'zoom' || draft.external_provider === 'zoom' ? 'Zoom' : 'Calendly'

  async function onGenerateZoom() {
    setZoomError(null)
    setZoomBusy(true)
    try {
      if (!draft.start_time) throw new Error('Set a start time first.')
      const durationMinutes = draft.end_time
        ? Math.max(5, Math.round((new Date(draft.end_time) - new Date(draft.start_time)) / 60000))
        : 30
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
      const previousId = draft.zoom_meeting_id || draft.location?.zoom_meeting_id || null
      const zoom = await createZoomMeeting({
        title: draft.title.trim() || 'Meeting',
        startTime: draft.start_time,
        durationMinutes,
        timezone,
        action: previousId ? 'regenerate' : 'create',
        zoomMeetingId: previousId,
        crmMeetingId: draft.id,
      })
      if (zoom.previous_delete === 'failed') {
        setZoomError(new Error('The new Zoom meeting is saved. Zoom did not delete the previous one.'))
      }
      setDraft((d) => ({ ...d, ...zoomMeetingFields(zoom) }))
    } catch (e) {
      setZoomError(e)
    } finally {
      setZoomBusy(false)
    }
  }

  async function onSave() {
    setError(null)
    setSaving(true)
    try {
      const payload = {
        advisor_id: draft.advisor_id || null,
        title: draft.title.trim() || 'Meeting',
        start_time: draft.start_time,
        end_time: draft.end_time || null,
        meeting_type: draft.meeting_type || null,
        meeting_url: draft.meeting_url || null,
        status: draft.status || null,
        notes: draft.notes || null,
        lead_id: draft.lead_id || null,
        client_id: draft.client_id || null,
        source: draft.source || 'manual',
        external_provider: draft.external_provider || null,
        external_event_uri: draft.external_event_uri || null,
        location: draft.location || null,
        zoom_meeting_id: draft.zoom_meeting_id || null,
        zoom_meeting_uuid: draft.zoom_meeting_uuid || null,
      }

      // For Calendly meetings, only allow CRM-linkage + notes/status tweaks.
      if (isCalendly) {
        const safePatch = {
          lead_id: payload.lead_id,
          client_id: payload.client_id,
          notes: payload.notes,
          status: payload.status,
        }
        await updateMeetingById(draft.id, safePatch)
      } else if (isNew) {
        await createMeeting(payload)
      } else {
        await updateMeetingById(draft.id, payload)
      }

      await onSaved?.()
    } catch (e) {
      setError(e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modalOverlay" role="dialog" aria-modal="true">
      <div className="modalCard modalLg">
        <div className="modalHeader">
          <div>
            <div className="modalTitle">{isNew ? 'New meeting' : isCalendly ? 'Calendly meeting' : 'Edit meeting'}</div>
            <div className="modalSub">
              {isCalendly
                ? 'Synced from Calendly. Notes, status, and the client or lead link are yours — sync will not overwrite them.'
                : 'Notes, status, and the client or lead link stay when a provider syncs. A time or title you edit is kept too.'}
            </div>
          </div>
          <button className="iconBtn" type="button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="modalBody">
          {error ? <div className="inlineError">{error.message || 'Failed to save meeting.'}</div> : null}

          <div className="formGrid">
            <label className="sField" style={{ gridColumn: '1 / -1' }}>
              <div className="sLabel">Title</div>
              <input
                className="sInput"
                value={draft.title}
                onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                disabled={!canEditCore}
              />
              {titleDrift ? (
                <div className="sHint">{providerName} still has “{titleDrift}”. Your title is kept.</div>
              ) : null}
            </label>

            <label className="sField">
              <div className="sLabel">Start</div>
              <input
                className="sInput"
                type="datetime-local"
                value={toLocalInputValue(draft.start_time)}
                onChange={(e) => setDraft((d) => ({ ...d, start_time: fromLocalInputValue(e.target.value) }))}
                disabled={!canEditCore}
              />
              {startDrift ? (
                <div className="sHint">{providerName} still has {startDrift}. Your time is kept.</div>
              ) : null}
            </label>

            <label className="sField">
              <div className="sLabel">End</div>
              <input
                className="sInput"
                type="datetime-local"
                value={toLocalInputValue(draft.end_time)}
                onChange={(e) => setDraft((d) => ({ ...d, end_time: fromLocalInputValue(e.target.value) }))}
                disabled={!canEditCore}
              />
            </label>

            <label className="sField">
              <div className="sLabel">Advisor</div>
              <Select
                value={draft.advisor_id || ''}
                onChange={(v) => setDraft((d) => ({ ...d, advisor_id: v || null }))}
                options={advisorOptions}
                disabled={!isAdmin || isCalendly}
              />
            </label>

            <label className="sField">
              <div className="sLabel">Status</div>
              <Select
                value={draft.status || ''}
                onChange={(v) => setDraft((d) => ({ ...d, status: v }))}
                options={meetingStatusOptions}
              />
            </label>

            <label className="sField">
              <div className="sLabel">Meeting type</div>
              <input
                className="sInput"
                value={draft.meeting_type || ''}
                onChange={(e) => setDraft((d) => ({ ...d, meeting_type: e.target.value }))}
                placeholder="Zoom / Phone / In person"
                disabled={!canEditCore}
              />
            </label>

            <label className="sField">
              <div className="sLabel">Meeting URL</div>
              <input
                className="sInput"
                value={draft.meeting_url || ''}
                onChange={(e) => setDraft((d) => ({ ...d, meeting_url: e.target.value }))}
                placeholder="https://..."
                disabled={!canEditCore}
              />
            </label>

            {canEditCore ? (
              <div className="sField zoomField" style={{ gridColumn: '1 / -1' }}>
                <div className="sLabel">Zoom</div>
                {zoomError ? (
                  <div className="inlineError">{zoomError.message || 'Could not create Zoom meeting.'}</div>
                ) : null}
                {hasZoom ? (
                  <div className="zoomRow">
                    <button
                      className="btnSecondary"
                      type="button"
                      onClick={onGenerateZoom}
                      disabled={zoomBusy}
                    >
                      <Video size={16} />
                      {zoomBusy
                        ? 'Creating Zoom meeting…'
                        : isZoomMeeting
                          ? 'Regenerate Zoom meeting'
                          : 'Generate Zoom meeting'}
                    </button>
                    {isZoomMeeting && draft.location?.start_url ? (
                      <div className="zoomMeta">
                        <a
                          className="zoomHostLink"
                          href={draft.location.start_url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Start as host
                        </a>
                        {draft.location?.passcode ? (
                          <span className="zoomPasscode">Passcode: {draft.location.passcode}</span>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="sHint">
                    Connect Zoom in Settings → Integrations to generate meeting links here.
                  </div>
                )}
              </div>
            ) : null}

            <label className="sField">
              <div className="sLabel">Link to lead</div>
              <Select
                value={draft.lead_id || ''}
                onChange={(v) =>
                  setDraft((d) => ({
                    ...d,
                    lead_id: v || null,
                    client_id: v ? null : d.client_id,
                  }))
                }
                options={leadOptions}
              />
            </label>

            <label className="sField">
              <div className="sLabel">Link to client</div>
              <Select
                value={draft.client_id || ''}
                onChange={(v) =>
                  setDraft((d) => ({
                    ...d,
                    client_id: v || null,
                    lead_id: v ? null : d.lead_id,
                  }))
                }
                options={clientOptions}
              />
            </label>

            {draft.provider_summary ? (
              <div className="sField" style={{ gridColumn: '1 / -1' }}>
                <div className="sLabel">Zoom summary</div>
                <div className="sHint" style={{ whiteSpace: 'pre-wrap' }}>{draft.provider_summary}</div>
              </div>
            ) : null}

            {recordings.length > 0 ? (
              <div className="sField recSection" style={{ gridColumn: '1 / -1' }}>
                <div className="sLabel">Recordings &amp; transcripts</div>
                <RecordingList recordings={recordings} />
              </div>
            ) : null}

            <label className="sField" style={{ gridColumn: '1 / -1' }}>
              <div className="sLabel">Notes</div>
              <textarea
                className="sInput"
                rows={4}
                value={draft.notes || ''}
                onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
                placeholder="Agenda, prep notes, outcomes…"
              />
            </label>
          </div>
        </div>

        <div className="modalFooter">
          <button className="btnSecondary" type="button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btnPrimary" type="button" onClick={onSave} disabled={saving}>
            <Save size={16} />
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

