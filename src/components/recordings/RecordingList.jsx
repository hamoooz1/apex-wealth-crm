import { FileText, PlayCircle, Sparkles } from 'lucide-react'
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
  if (!recordings.length) return null
  return (
    <div className="recList">
      {recordings.map((r) => {
        const when = showDate ? formatWhen(r.recording_start || r.created_at) : ''
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
              {r.play_url ? (
                <a className="recLink" href={r.play_url} target="_blank" rel="noreferrer">
                  <PlayCircle size={15} /> Watch recording
                </a>
              ) : null}
              {r.transcript_url ? (
                <a className="recLink" href={r.transcript_url} target="_blank" rel="noreferrer">
                  <FileText size={15} /> Transcript
                </a>
              ) : null}
            </div>
            {r.summary ? (
              <div className="recSummary">
                <div className="recSummaryHead">
                  <Sparkles size={14} /> AI summary
                </div>
                <div className="recSummaryBody">{r.summary}</div>
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
