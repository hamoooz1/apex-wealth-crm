import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { getClientRecordings } from '../../lib/queries.js'
import RecordingList from '../recordings/RecordingList.jsx'

export default function ClientRecordingsModal({ open, onClose, client }) {
  const [state, setState] = useState({ loading: true, error: null, recordings: [] })

  useEffect(() => {
    let mounted = true
    async function load() {
      if (!open || !client?.id) return
      setState({ loading: true, error: null, recordings: [] })
      try {
        const recordings = await getClientRecordings(client.id)
        if (mounted) setState({ loading: false, error: null, recordings })
      } catch (e) {
        if (mounted) setState({ loading: false, error: e, recordings: [] })
      }
    }
    load()
    return () => {
      mounted = false
    }
  }, [open, client?.id])

  if (!open) return null

  const name = [client?.first_name, client?.last_name].filter(Boolean).join(' ') || 'Client'

  return (
    <div className="modalOverlay" role="dialog" aria-modal="true">
      <div className="modalCard modalLg">
        <div className="modalHeader">
          <div>
            <div className="modalTitle">Recordings — {name}</div>
            <div className="modalSub">Cloud recordings, transcripts, and AI summaries from this client&apos;s meetings.</div>
          </div>
          <button className="iconBtn" type="button" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="modalBody">
          {state.loading ? (
            <div className="muted">Loading recordings…</div>
          ) : state.error ? (
            <div className="inlineError">{state.error.message || 'Failed to load recordings.'}</div>
          ) : state.recordings.length === 0 ? (
            <div className="muted">
              No recordings yet. They&apos;ll appear here automatically after a recorded Zoom meeting with this client finishes
              processing.
            </div>
          ) : (
            <RecordingList recordings={state.recordings} showDate />
          )}
        </div>

        <div className="modalFooter">
          <button className="btnSecondary" type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
