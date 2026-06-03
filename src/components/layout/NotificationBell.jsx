import { Bell, CheckCheck } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext.jsx'
import {
  dispatchMyReminders,
  getMyNotifications,
  getUnreadNotificationCount,
  markAllNotificationsRead,
  markNotificationRead,
  subscribeToNotifications,
} from '../../lib/notifications.js'

function formatWhen(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const mins = Math.round((Date.now() - d.getTime()) / 60000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export default function NotificationBell() {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const wrapRef = useRef(null)
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState([])
  const [unread, setUnread] = useState(0)
  const [loading, setLoading] = useState(false)

  async function refresh() {
    if (!profile?.id) return
    setLoading(true)
    try {
      const [rows, count] = await Promise.all([
        getMyNotifications(profile.id),
        getUnreadNotificationCount(profile.id),
      ])
      setItems(rows)
      setUnread(count)
    } catch {
      // keep last known state
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!profile?.id) return
    const dayKey = new Date().toISOString().slice(0, 10)
    const storageKey = `apex-reminders:${profile.id}:${dayKey}`
    if (!sessionStorage.getItem(storageKey)) {
      sessionStorage.setItem(storageKey, '1')
      dispatchMyReminders()
        .then(() => refresh())
        .catch(() => {})
    }
  }, [profile?.id])

  useEffect(() => {
    refresh()
    const unsub = subscribeToNotifications(profile?.id, refresh)
    const poll = setInterval(refresh, 60_000)
    return () => {
      unsub()
      clearInterval(poll)
    }
  }, [profile?.id])

  useEffect(() => {
    function onDocClick(e) {
      if (!wrapRef.current?.contains(e.target)) setOpen(false)
    }
    if (open) document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  async function onItemClick(n) {
    if (!n.read_at) {
      await markNotificationRead(n.id)
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)))
      setUnread((c) => Math.max(0, c - 1))
    }
    setOpen(false)
    if (n.href) navigate(n.href)
  }

  async function onMarkAll() {
    if (!profile?.id) return
    await markAllNotificationsRead(profile.id)
    setItems((prev) => prev.map((x) => ({ ...x, read_at: x.read_at || new Date().toISOString() })))
    setUnread(0)
  }

  return (
    <div className="notifWrap" ref={wrapRef}>
      <button
        className="iconBtn notifBtn"
        type="button"
        aria-label="Notifications"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Bell size={16} />
        {unread > 0 ? <span className="notifBadge">{unread > 99 ? '99+' : unread}</span> : null}
      </button>

      {open ? (
        <div className="notifPanel" role="menu">
          <div className="notifHead">
            <div className="notifTitle">Notifications</div>
            {unread > 0 ? (
              <button className="notifMarkAll" type="button" onClick={onMarkAll}>
                <CheckCheck size={14} /> Mark all read
              </button>
            ) : null}
          </div>

          <div className="notifList">
            {loading && items.length === 0 ? (
              <div className="notifEmpty">Loading…</div>
            ) : items.length === 0 ? (
              <div className="notifEmpty">You&apos;re all caught up.</div>
            ) : (
              items.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  className={['notifItem', n.read_at ? 'isRead' : ''].filter(Boolean).join(' ')}
                  onClick={() => onItemClick(n)}
                >
                  <div className="notifItemTitle">{n.title}</div>
                  {n.body ? <div className="notifItemBody">{n.body}</div> : null}
                  <div className="notifItemTime">{formatWhen(n.created_at)}</div>
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
