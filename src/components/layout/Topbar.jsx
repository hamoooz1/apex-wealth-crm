import { Bell, RefreshCw } from 'lucide-react'
import { useMemo, useState } from 'react'

function formatLastSync(iso) {
  const dt = new Date(iso)
  const mins = Math.max(0, Math.round((Date.now() - dt.getTime()) / 60000))
  if (mins < 1) return 'Just now'
  if (mins === 1) return '1m ago'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  return `${hrs}h ago`
}

export default function Topbar() {
  const [lastSyncAt, setLastSyncAt] = useState(new Date().toISOString())
  const lastSyncLabel = useMemo(() => formatLastSync(lastSyncAt), [lastSyncAt])

  return (
    <div className="topbar">
      <div className="topbarLeft">
        <div className="searchWrap">
          <input
            className="searchInput"
            placeholder="Search clients, emails, phone…"
            type="text"
          />
        </div>
      </div>

      <div className="topbarRight">
        <button
          className="syncBtn"
          type="button"
          onClick={() => setLastSyncAt(new Date().toISOString())}
        >
          <RefreshCw size={16} />
          Sync
        </button>
        <button className="iconBtn" type="button" aria-label="Notifications">
          <Bell size={16} />
        </button>
        <div className="lastSync">
          <div className="lastSyncLabel">Last sync</div>
          <div className="lastSyncValue">{lastSyncLabel}</div>
        </div>
      </div>
    </div>
  )
}

