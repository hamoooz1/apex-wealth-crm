import { useState } from 'react'
import { FileText, PlayCircle, Sparkles } from 'lucide-react'
import { openRecording } from '../../lib/zoom.js'
import './RecordingList.css'

function formatWhen(value) {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export default function RecordingList({ recordings = [], showDate = false }) {
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState(null)
  if (!recordings.length) return null

  async function onOpen(recording, kind) {
    setError(null)
    setBusyId(recording.id)
    try {
      const result = await openRecording(recording.id, kind)
      if (result.url) window.open(result.url, '_blank', 'noopener,noreferrer')
    } catch (e) {
      setError(e.message || 'Could not open the recording.')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="recList">
      {error ? <div className="inlineError">{error}</div> : null}
      {recordings.map((r) => {
        const when = showDate ? formatWhen(r.recording_start || r.created_at) : ''
        const watchUrl = r.share_url || r.play_url
        return (
          <div className="recCard" key={r.id}>
            <div className="recHead">
              <span className="recTopic">{r.topic || 'Zoom recording'}</span>
              <span className="recMeta">
                {when ? <span className="recWhen">{when}</span> : null}
                {r.duration_minutes ? <span className="recDur">{r.duration_minutes} min</span> : null}
              </span>
            </div>
            <div className="recLinks">
              {r.storage_path ? (
                <button className="recLink recButton" type="button" onClick={() => onOpen(r, 'media')} disabled={busyId === r.id}>
                  <PlayCircle size={15} /> {busyId === r.id ? 'Opening…' : 'Play recording'}
                </button>
              ) : null}
              {watchUrl ? (
                <a className="recLink" href={watchUrl} target="_blank" rel="noreferrer">
                  <PlayCircle size={15} /> Watch on Zoom
                </a>
              ) : null}
              {r.transcript_storage_path ? (
                <button className="recLink recButton" type="button" onClick={() => onOpen(r, 'transcript')} disabled={busyId === r.id}>
                  <FileText size={15} /> Transcript file
                </button>
              ) : null}
            </div>
            {r.recording_passcode ? <div className="recPasscode">Passcode: {r.recording_passcode}</div> : null}
            {r.storage_error && !r.storage_path ? (
              <div className="recNote">The video was left on Zoom{r.storage_error === 'too_large' ? ' because it is over 25 MB' : ''}.</div>
            ) : null}
            {r.summary ? (
              <div className="recSummary">
                <div className="recSummaryHead">
                  <Sparkles size={14} /> AI summary
                </div>
                <div className="recSummaryBody">{r.summary}</div>
              </div>
            ) : null}
            {r.transcript_text ? (
              <details className="recTranscript">
                <summary>Transcript</summary>
                <div className="recSummaryBody">{r.transcript_text}</div>
              </details>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
