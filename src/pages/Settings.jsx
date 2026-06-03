import { useEffect, useMemo, useState } from 'react'
import { Eye, EyeOff, Plus, Save, ShieldCheck, Upload } from 'lucide-react'
import './Settings.css'
import { useAuth } from '../contexts/AuthContext.jsx'
import {
  createProfileRow,
  fetchProfilesPageData,
  updateProfileById,
  getMyPreferences,
  saveMyPreferences,
} from '../lib/queries.js'
import { getMyZoomConnection, startZoomConnect, disconnectZoom } from '../lib/zoom.js'
import { syncCalendly } from '../lib/calendly.js'
import { dispatchMyReminders } from '../lib/notifications.js'
import { supabase } from '../lib/supabaseClient.js'
import { inviteUser } from '../lib/invite.js'
import { adminSendPasswordReset } from '../lib/auth.js'
import Avatar from '../components/ui/Avatar.jsx'
import Select from '../components/ui/Select.jsx'

function roleLabel(role) {
  if (role === 'admin') return 'Admin'
  if (role === 'manager') return 'Manager'
  return 'Advisor'
}

const roleOptions = [
  { value: 'admin', label: 'Admin' },
  { value: 'manager', label: 'Manager' },
  { value: 'advisor', label: 'Advisor' },
]

export default function Settings() {
  const { profile, user, refreshProfile, profileLoading, profileError } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const [activeTab, setActiveTab] = useState('profile')

  // Land on the Integrations tab after an OAuth redirect (?zoom=connected|error or ?calendly=...)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const zoom = params.get('zoom')
    const calendly = params.get('calendly')
    if (zoom || calendly) {
      setActiveTab('integrations')
      if (zoom === 'error') setZoomError(new Error(params.get('message') || 'Zoom connection failed.'))
      params.delete('zoom')
      params.delete('calendly')
      params.delete('message')
      const qs = params.toString()
      window.history.replaceState({}, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`)
    }
  }, [])

  // Section 1: My Profile
  const [myProfile, setMyProfile] = useState({
    full_name: '',
    email: '',
    role: '',
    is_active: true,
    avatar_url: '',
  })
  const [savedProfile, setSavedProfile] = useState(myProfile)
  const [savingProfile, setSavingProfile] = useState(false)
  const [profileSaveError, setProfileSaveError] = useState(null)
  const profileDirty = useMemo(() => {
    return (
      myProfile.full_name !== savedProfile.full_name ||
      myProfile.is_active !== savedProfile.is_active ||
      myProfile.avatar_url !== savedProfile.avatar_url
    )
  }, [myProfile, savedProfile])

  useEffect(() => {
    if (!profile) return
    const next = {
      full_name: profile.full_name || '',
      email: profile.email || user?.email || '',
      role: profile.role || '',
      is_active: profile.is_active !== false,
      avatar_url: profile.avatar_url || '',
    }
    setMyProfile(next)
    setSavedProfile(next)
  }, [profile?.id])

  // Section 2: Password (UI only)
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' })
  const [showPw, setShowPw] = useState(false)
  const [pwSaving, setPwSaving] = useState(false)
  const [pwError, setPwError] = useState(null)
  const pwMismatch = pw.next.length > 0 && pw.confirm.length > 0 && pw.next !== pw.confirm
  const pwDirty = pw.current || pw.next || pw.confirm
  const pwValid = pwDirty && !pwMismatch && pw.next.length >= 8 && pw.current.length > 0

  // Section 3: Preferences (persisted in user_preferences)
  const [prefs, setPrefs] = useState({
    email_notifications: true,
    task_reminders: true,
    weekly_summary: false,
  })
  const [savedPrefs, setSavedPrefs] = useState(prefs)
  const [prefsSaving, setPrefsSaving] = useState(false)
  const [prefsError, setPrefsError] = useState(null)
  const [remindersBusy, setRemindersBusy] = useState(false)
  const [remindersMsg, setRemindersMsg] = useState('')
  const prefsDirty = useMemo(() => {
    return (
      prefs.email_notifications !== savedPrefs.email_notifications ||
      prefs.task_reminders !== savedPrefs.task_reminders ||
      prefs.weekly_summary !== savedPrefs.weekly_summary
    )
  }, [prefs, savedPrefs])

  useEffect(() => {
    let mounted = true
    async function loadPrefs() {
      if (!profile?.id) return
      try {
        const row = await getMyPreferences(profile.id)
        if (!mounted || !row) return
        const next = {
          email_notifications: row.email_notifications,
          task_reminders: row.task_reminders,
          weekly_summary: row.weekly_summary,
        }
        setPrefs(next)
        setSavedPrefs(next)
      } catch (e) {
        if (mounted) setPrefsError(e)
      }
    }
    loadPrefs()
    return () => {
      mounted = false
    }
  }, [profile?.id])

  // Section 4: Calendly
  const [calendlyConn, setCalendlyConn] = useState(null)
  const [calendlyLoading, setCalendlyLoading] = useState(false)
  const [calendlyError, setCalendlyError] = useState(null)

  async function loadCalendlyConnection(userId) {
    if (!userId) return null
    const { data, error } = await supabase
      .from('calendly_connections')
      .select('*')
      .eq('user_id', userId)
      .is('revoked_at', null)
      .maybeSingle()
    if (error) throw error
    return data || null
  }

  useEffect(() => {
    let mounted = true
    async function load() {
      if (!profile?.id) {
        setCalendlyConn(null)
        setCalendlyError(null)
        return
      }
      setCalendlyLoading(true)
      setCalendlyError(null)
      try {
        const row = await loadCalendlyConnection(profile.id)
        if (!mounted) return
        setCalendlyConn(row)
      } catch (e) {
        if (!mounted) return
        setCalendlyConn(null)
        setCalendlyError(e)
      } finally {
        if (mounted) setCalendlyLoading(false)
      }
    }
    load()
    return () => {
      mounted = false
    }
  }, [profile?.id])

  async function onConnectCalendly() {
    setCalendlyError(null)
    setCalendlyLoading(true)
    try {
      const { data, error } = await supabase.functions.invoke('calendly-oauth-start')
      if (error) throw error
      const url = data?.authorize_url
      if (!url) throw new Error('Missing authorize_url from calendly-oauth-start.')
      window.location.assign(url)
    } catch (e) {
      setCalendlyError(e)
      setCalendlyLoading(false)
    }
  }

  async function onDisconnectCalendly() {
    setCalendlyError(null)
    setCalendlyLoading(true)
    try {
      const { error } = await supabase.functions.invoke('calendly-disconnect', { body: {} })
      if (error) throw error
      const row = await loadCalendlyConnection(profile?.id)
      setCalendlyConn(row)
    } catch (e) {
      setCalendlyError(e)
    } finally {
      setCalendlyLoading(false)
    }
  }

  const [calendlySyncing, setCalendlySyncing] = useState(false)
  const [calendlySyncMsg, setCalendlySyncMsg] = useState(null)

  async function onSyncCalendly() {
    setCalendlyError(null)
    setCalendlySyncMsg(null)
    setCalendlySyncing(true)
    try {
      const res = await syncCalendly()
      const added = res?.inserted || 0
      const updated = res?.updated || 0
      setCalendlySyncMsg(
        `Synced ${res?.events || 0} event${res?.events === 1 ? '' : 's'} · ${added} added, ${updated} updated.`,
      )
    } catch (e) {
      setCalendlyError(e)
    } finally {
      setCalendlySyncing(false)
    }
  }

  // Section 4b: Zoom
  const [zoomConn, setZoomConn] = useState(null)
  const [zoomLoading, setZoomLoading] = useState(false)
  const [zoomError, setZoomError] = useState(null)

  useEffect(() => {
    let mounted = true
    async function load() {
      if (!profile?.id) {
        setZoomConn(null)
        setZoomError(null)
        return
      }
      setZoomLoading(true)
      setZoomError(null)
      try {
        const row = await getMyZoomConnection(profile.id)
        if (!mounted) return
        setZoomConn(row)
      } catch (e) {
        if (!mounted) return
        setZoomConn(null)
        setZoomError(e)
      } finally {
        if (mounted) setZoomLoading(false)
      }
    }
    load()
    return () => {
      mounted = false
    }
  }, [profile?.id])

  async function onConnectZoom() {
    setZoomError(null)
    setZoomLoading(true)
    try {
      const url = await startZoomConnect()
      window.location.assign(url)
    } catch (e) {
      setZoomError(e)
      setZoomLoading(false)
    }
  }

  async function onDisconnectZoom() {
    setZoomError(null)
    setZoomLoading(true)
    try {
      await disconnectZoom()
      const row = await getMyZoomConnection(profile?.id)
      setZoomConn(row)
    } catch (e) {
      setZoomError(e)
    } finally {
      setZoomLoading(false)
    }
  }

  // Section 5: Team Management (Admin only)
  const [team, setTeam] = useState([])
  const [teamLoading, setTeamLoading] = useState(false)
  const [teamError, setTeamError] = useState(null)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteLoading, setInviteLoading] = useState(false)
  const [inviteError, setInviteError] = useState(null)
  const [inviteSuccess, setInviteSuccess] = useState(null)
  const [resetSendingId, setResetSendingId] = useState(null)
  const [inviteForm, setInviteForm] = useState({
    email: '',
    full_name: '',
    role: 'advisor',
    manager_id: '',
  })

  const managers = useMemo(() => team.filter((p) => p.role !== 'advisor'), [team])
  const byId = useMemo(() => new Map(team.map((p) => [p.id, p])), [team])

  function managerName(managerId) {
    if (!managerId) return '—'
    return byId.get(managerId)?.full_name || '—'
  }

  async function ensureProfileRowExists() {
    if (profile) return profile
    if (!user?.id) return null
    // If there's no row (common when no auth trigger exists), try to create one.
    const payload = {
      id: user.id,
      full_name: user.user_metadata?.full_name || user.email?.split('@')?.[0] || 'New User',
      email: user.email,
      role: 'advisor',
      manager_id: null,
      is_active: true,
    }
    const created = await createProfileRow(payload)
    await refreshProfile()
    return created
  }

  async function onSaveProfile() {
    setProfileSaveError(null)
    setSavingProfile(true)
    try {
      const p = await ensureProfileRowExists()
      const id = p?.id || profile?.id
      if (!id) throw new Error('No profile row found for current user.')

      const patch = { full_name: myProfile.full_name, avatar_url: myProfile.avatar_url || null }
      if (isAdmin) patch.is_active = !!myProfile.is_active

      await updateProfileById(id, patch)
      await refreshProfile()
      setSavedProfile(myProfile)
    } catch (e) {
      setProfileSaveError(e)
    } finally {
      setSavingProfile(false)
    }
  }

  async function uploadAvatar(file) {
    if (!file) return
    setProfileSaveError(null)
    setSavingProfile(true)
    try {
      const p = await ensureProfileRowExists()
      const id = p?.id || profile?.id
      if (!id) throw new Error('No profile row found for current user.')

      const ext = file.name.split('.').pop() || 'png'
      const path = `${id}/avatar.${ext}`

      const { error: upErr } = await supabase.storage
        .from('avatars')
        .upload(path, file, { upsert: true, contentType: file.type })
      if (upErr) throw upErr

      const { data: pub } = supabase.storage.from('avatars').getPublicUrl(path)
      const publicUrl = pub?.publicUrl
      if (!publicUrl) throw new Error('Failed to get public URL for uploaded avatar.')

      setMyProfile((x) => ({ ...x, avatar_url: publicUrl }))
    } catch (e) {
      setProfileSaveError(e)
    } finally {
      setSavingProfile(false)
    }
  }

  async function onUpdatePassword() {
    setPwError(null)
    setPwSaving(true)
    try {
      // Supabase does not validate "current password" client-side; keep it as UI guard.
      const { error } = await supabase.auth.updateUser({ password: pw.next })
      if (error) throw error
      setPw({ current: '', next: '', confirm: '' })
    } catch (e) {
      setPwError(e)
    } finally {
      setPwSaving(false)
    }
  }

  async function onSavePrefs() {
    if (!profile?.id) return
    setPrefsError(null)
    setPrefsSaving(true)
    try {
      await saveMyPreferences(profile.id, {
        email_notifications: prefs.email_notifications,
        task_reminders: prefs.task_reminders,
        weekly_summary: prefs.weekly_summary,
      })
      setSavedPrefs(prefs)
    } catch (e) {
      setPrefsError(e)
    } finally {
      setPrefsSaving(false)
    }
  }

  async function onRefreshReminders() {
    setRemindersMsg('')
    setRemindersBusy(true)
    try {
      const data = await dispatchMyReminders()
      const created = data?.results?.[0]?.created ?? 0
      setRemindersMsg(`Reminders refreshed (${created} notification${created === 1 ? '' : 's'} upserted).`)
    } catch (e) {
      setRemindersMsg(e.message || 'Failed to refresh reminders.')
    } finally {
      setRemindersBusy(false)
    }
  }

  useEffect(() => {
    if (!isAdmin) return
    let mounted = true
    async function loadTeam() {
      setTeamLoading(true)
      setTeamError(null)
      try {
        const rows = await fetchProfilesPageData()
        if (!mounted) return
        setTeam(rows)
      } catch (e) {
        if (!mounted) return
        setTeamError(e)
      } finally {
        if (mounted) setTeamLoading(false)
      }
    }
    loadTeam()
    return () => {
      mounted = false
    }
  }, [isAdmin])

  async function onSendPasswordReset(member) {
    setInviteError(null)
    setInviteSuccess(null)
    setResetSendingId(member.id)
    try {
      await adminSendPasswordReset(member.email)
      setInviteSuccess(`Password reset email sent to ${member.email}.`)
    } catch (e) {
      setInviteError(e)
    } finally {
      setResetSendingId(null)
    }
  }

  async function onAddUser() {
    setInviteError(null)
    setInviteSuccess(null)
    setInviteOpen(true)
  }

  async function updateTeamRow(id, patch) {
    setTeamError(null)
    setTeam((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)))
    try {
      await updateProfileById(id, patch)
    } catch (e) {
      setTeamError(e)
    }
  }

  function deactivateUser(id) {
    updateTeamRow(id, { is_active: false })
  }

  return (
    <div>
      <div className="pageHeader">
        <div>
          <h1 className="pageTitle">Settings</h1>
          <div className="pageSubtitle">Manage your account and system settings</div>
        </div>
      </div>

      <div className="settingsShell">
        <div className="settingsNav settingsNavTop" role="tablist" aria-label="Settings sections">
          <button
            type="button"
            className={['settingsTab', activeTab === 'profile' ? 'isActive' : null].filter(Boolean).join(' ')}
            onClick={() => setActiveTab('profile')}
            role="tab"
            aria-selected={activeTab === 'profile'}
          >
            Profile
          </button>
          <button
            type="button"
            className={['settingsTab', activeTab === 'security' ? 'isActive' : null].filter(Boolean).join(' ')}
            onClick={() => setActiveTab('security')}
            role="tab"
            aria-selected={activeTab === 'security'}
          >
            Security
          </button>
          <button
            type="button"
            className={['settingsTab', activeTab === 'preferences' ? 'isActive' : null].filter(Boolean).join(' ')}
            onClick={() => setActiveTab('preferences')}
            role="tab"
            aria-selected={activeTab === 'preferences'}
          >
            Preferences
          </button>
          <button
            type="button"
            className={['settingsTab', activeTab === 'integrations' ? 'isActive' : null].filter(Boolean).join(' ')}
            onClick={() => setActiveTab('integrations')}
            role="tab"
            aria-selected={activeTab === 'integrations'}
          >
            Integrations
          </button>
          {isAdmin ? (
            <button
              type="button"
              className={['settingsTab', activeTab === 'team' ? 'isActive' : null].filter(Boolean).join(' ')}
              onClick={() => setActiveTab('team')}
              role="tab"
              aria-selected={activeTab === 'team'}
            >
              Team
            </button>
          ) : null}
        </div>

        <section className="settingsPanel">
          {activeTab === 'profile' ? (
            <div className="card settingsCard">
              <div className="cardHeader">
                <div>
                  <div className="cardTitle">Profile</div>
                  <div className="muted">Account details</div>
                </div>
              </div>
              <div className="settingsBody">
                {profileLoading ? <div className="inlineHint">Loading profile…</div> : null}
                {profileError ? (
                  <div className="inlineError">Failed to load profile. Make sure a `profiles` row exists.</div>
                ) : null}
                {profileSaveError ? (
                  <div className="inlineError">{profileSaveError.message || 'Failed to save profile.'}</div>
                ) : null}

                <div className="settingsRow">
                  <Avatar name={myProfile.full_name || 'Apex User'} src={myProfile.avatar_url || ''} size="lg" />
                  <div className="settingsRowMain">
                    <div className="settingsRowTitle">{myProfile.full_name || 'Apex User'}</div>
                    <div className="settingsRowSub">{myProfile.email || user?.email || '—'}</div>
                  </div>
                  <div className="settingsRowRight">
                    <span className={['sBadge', `role-${myProfile.role}`].join(' ')}>
                      <ShieldCheck size={14} />
                      {roleLabel(myProfile.role)}
                    </span>
                  </div>
                </div>

                <div className="formGrid" style={{ marginTop: 12 }}>
                  <div className="sField" style={{ gridColumn: '1 / -1' }}>
                    <div className="sLabel">Profile picture</div>
                    <label className="btnSecondary settingsUploadBtn">
                      <Upload size={16} />
                      Upload
                      <input
                        type="file"
                        accept="image/*"
                        style={{ display: 'none' }}
                        onChange={(e) => uploadAvatar(e.target.files?.[0])}
                      />
                    </label>
                    <div className="sHint">PNG/JPG, square preferred.</div>
                  </div>

                  <label className="sField">
                    <div className="sLabel">Full Name</div>
                    <input
                      className="sInput"
                      value={myProfile.full_name}
                      onChange={(e) => setMyProfile((p) => ({ ...p, full_name: e.target.value }))}
                    />
                  </label>

                  <label className="sField">
                    <div className="sLabel">Email</div>
                    <input className="sInput" value={myProfile.email} readOnly />
                  </label>

                  {isAdmin ? (
                    <label className="sToggleRow">
                      <div>
                        <div className="sLabel">Active status</div>
                        <div className="sHint">Only admins can change this for themselves</div>
                      </div>
                      <input
                        type="checkbox"
                        checked={myProfile.is_active}
                        onChange={(e) => setMyProfile((p) => ({ ...p, is_active: e.target.checked }))}
                      />
                    </label>
                  ) : null}
                </div>

                <div className="settingsFooter">
                  <button
                    className="btnPrimary"
                    type="button"
                    onClick={onSaveProfile}
                    disabled={!profileDirty || savingProfile}
                  >
                    <Save size={16} />
                    {savingProfile ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {activeTab === 'security' ? (
            <div className="card settingsCard">
              <div className="cardHeader">
                <div>
                  <div className="cardTitle">Password</div>
                  <div className="muted">Update your password</div>
                </div>
              </div>
              <div className="settingsBody">
                <div className="pwRow">
                  <div className="pwGrid">
                    <label className="sField">
                      <div className="sLabel">Current password</div>
                      <input
                        className="sInput"
                        type={showPw ? 'text' : 'password'}
                        value={pw.current}
                        onChange={(e) => setPw((x) => ({ ...x, current: e.target.value }))}
                      />
                    </label>
                    <label className="sField">
                      <div className="sLabel">New password</div>
                      <input
                        className="sInput"
                        type={showPw ? 'text' : 'password'}
                        value={pw.next}
                        onChange={(e) => setPw((x) => ({ ...x, next: e.target.value }))}
                      />
                    </label>
                    <label className="sField">
                      <div className="sLabel">Confirm password</div>
                      <input
                        className="sInput"
                        type={showPw ? 'text' : 'password'}
                        value={pw.confirm}
                        onChange={(e) => setPw((x) => ({ ...x, confirm: e.target.value }))}
                      />
                    </label>
                  </div>

                  <button className="btnSecondary pwToggle" type="button" onClick={() => setShowPw((s) => !s)}>
                    {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                    {showPw ? 'Hide' : 'Show'}
                  </button>
                </div>

                {pwMismatch ? <div className="inlineError">Passwords do not match</div> : null}
                {pwError ? <div className="inlineError">{pwError.message || 'Failed to update password.'}</div> : null}
                {pw.next.length > 0 && pw.next.length < 8 ? (
                  <div className="inlineHint">New password should be at least 8 characters</div>
                ) : null}

                <div className="settingsFooter">
                  <button
                    className="btnPrimary"
                    type="button"
                    onClick={onUpdatePassword}
                    disabled={!pwValid || pwSaving}
                  >
                    {pwSaving ? 'Updating…' : 'Update Password'}
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {activeTab === 'preferences' ? (
            <div className="card settingsCard">
              <div className="cardHeader">
                <div>
                  <div className="cardTitle">Preferences</div>
                  <div className="muted">Notification settings</div>
                </div>
              </div>
              <div className="settingsBody">
                {prefsError ? (
                  <div className="inlineError">{prefsError.message || 'Failed to save preferences.'}</div>
                ) : null}
                <div className="prefsGrid">
                  <label className="sToggleRow">
                    <div>
                      <div className="sLabel">Email notifications</div>
                      <div className="sHint">Account alerts and CRM updates</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={prefs.email_notifications}
                      onChange={(e) => setPrefs((p) => ({ ...p, email_notifications: e.target.checked }))}
                    />
                  </label>
                  <label className="sToggleRow">
                    <div>
                      <div className="sLabel">Task reminders</div>
                      <div className="sHint">Due date reminders and follow-ups</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={prefs.task_reminders}
                      onChange={(e) => setPrefs((p) => ({ ...p, task_reminders: e.target.checked }))}
                    />
                  </label>
                  <label className="sToggleRow">
                    <div>
                      <div className="sLabel">Weekly summary emails</div>
                      <div className="sHint">Pipeline and activity summary every week</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={prefs.weekly_summary}
                      onChange={(e) => setPrefs((p) => ({ ...p, weekly_summary: e.target.checked }))}
                    />
                  </label>
                </div>
                {remindersMsg ? <div className="inlineHint">{remindersMsg}</div> : null}
                <div className="settingsFooter" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
                  <button
                    className="btnSecondary"
                    type="button"
                    onClick={onRefreshReminders}
                    disabled={remindersBusy}
                  >
                    {remindersBusy ? 'Refreshing…' : 'Refresh reminders now'}
                  </button>
                  <button
                    className="btnPrimary"
                    type="button"
                    onClick={onSavePrefs}
                    disabled={!prefsDirty || prefsSaving}
                  >
                    <Save size={16} />
                    {prefsSaving ? 'Saving…' : 'Save Preferences'}
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {activeTab === 'integrations' ? (
            <div className="card settingsCard">
              <div className="cardHeader">
                <div>
                  <div className="cardTitle">Calendly</div>
                  <div className="muted">Connect your scheduling account</div>
                </div>
              </div>
              <div className="settingsBody">
                {calendlyError ? (
                  <div className="inlineError">{calendlyError.message || 'Calendly integration error.'}</div>
                ) : null}

                {calendlyLoading ? <div className="inlineHint">Loading Calendly connection…</div> : null}

                <div className="settingsRow">
                  <div className="settingsRowMain">
                    <div className="settingsRowTitle">Connection</div>
                    <div className="settingsRowSub">
                      {calendlyConn?.calendly_user_uri ? calendlyConn.calendly_user_uri : 'Not connected'}
                    </div>
                  </div>
                  <div className="settingsRowRight">
                    <span className={['sBadge', calendlyConn ? 'role-advisor' : 'role-manager'].join(' ')}>
                      {calendlyConn ? 'Connected' : 'Not connected'}
                    </span>
                  </div>
                </div>

                {calendlyConn?.webhook_last_error ? (
                  <div className="inlineHint" style={{ marginTop: 10 }}>
                    {/calendly account to standard|permission denied|upgrade/i.test(
                      calendlyConn.webhook_last_error,
                    )
                      ? 'Your account is connected. Automatic meeting sync uses Calendly webhooks, which require a paid Calendly plan (Standard or higher). On the free plan, use “Sync now” below to import your meetings on demand.'
                      : `Connected, but automatic meeting sync may be inactive: ${calendlyConn.webhook_last_error}`}
                  </div>
                ) : null}

                {calendlySyncMsg ? (
                  <div className="inlineHint" style={{ marginTop: 10 }}>
                    {calendlySyncMsg}
                  </div>
                ) : null}

                <div className="settingsFooter settingsFooterSplit">
                  {calendlyConn ? (
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        className="btnPrimary"
                        type="button"
                        onClick={onSyncCalendly}
                        disabled={calendlySyncing}
                      >
                        {calendlySyncing ? 'Syncing…' : 'Sync now'}
                      </button>
                      <button
                        className="btnSecondary"
                        type="button"
                        onClick={onDisconnectCalendly}
                        disabled={calendlyLoading}
                      >
                        Disconnect
                      </button>
                    </div>
                  ) : (
                    <button className="btnPrimary" type="button" onClick={onConnectCalendly} disabled={calendlyLoading}>
                      {calendlyLoading ? 'Connecting…' : 'Connect Calendly'}
                    </button>
                  )}

                  <div className="muted" style={{ fontSize: 11 }}>
                    Advisors can only see their own meetings. Admins can see all.
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {activeTab === 'integrations' ? (
            <div className="card settingsCard">
              <div className="cardHeader">
                <div>
                  <div className="cardTitle">Zoom</div>
                  <div className="muted">Create Zoom meetings straight from the CRM</div>
                </div>
              </div>
              <div className="settingsBody">
                {zoomError ? (
                  <div className="inlineError">{zoomError.message || 'Zoom integration error.'}</div>
                ) : null}

                {zoomLoading ? <div className="inlineHint">Loading Zoom connection…</div> : null}

                <div className="settingsRow">
                  <div className="settingsRowMain">
                    <div className="settingsRowTitle">Connection</div>
                    <div className="settingsRowSub">
                      {zoomConn?.email || zoomConn?.zoom_user_id || 'Not connected'}
                    </div>
                  </div>
                  <div className="settingsRowRight">
                    <span className={['sBadge', zoomConn ? 'role-advisor' : 'role-manager'].join(' ')}>
                      {zoomConn ? 'Connected' : 'Not connected'}
                    </span>
                  </div>
                </div>

                <div className="settingsFooter settingsFooterSplit">
                  {zoomConn ? (
                    <button
                      className="btnSecondary"
                      type="button"
                      onClick={onDisconnectZoom}
                      disabled={zoomLoading}
                    >
                      Disconnect
                    </button>
                  ) : (
                    <button className="btnPrimary" type="button" onClick={onConnectZoom} disabled={zoomLoading}>
                      {zoomLoading ? 'Connecting…' : 'Connect Zoom'}
                    </button>
                  )}

                  <div className="muted" style={{ fontSize: 11 }}>
                    Once connected, you can generate a Zoom link when scheduling a meeting.
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {isAdmin ? (
            <div className="card settingsCard">
              <div className="cardHeader">
                <div>
                  <div className="cardTitle">Team management</div>
                  <div className="muted">Manage roles, managers, and active status</div>
                </div>
                <button className="btnPrimary" type="button" onClick={onAddUser}>
                  <Plus size={16} />
                  Invite user
                </button>
              </div>
              <div className="settingsBody">
                {teamError ? <div className="inlineError">{teamError.message || 'Team update failed.'}</div> : null}
                {inviteError ? <div className="inlineError">{inviteError.message || 'Invite failed.'}</div> : null}
                {inviteSuccess ? <div className="inlineSuccess">{inviteSuccess}</div> : null}

                <div className="adminTableWrap">
                  <table className="adminTable">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Email</th>
                      <th>Role</th>
                      <th>Manager</th>
                      <th>Status</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {teamLoading ? (
                      <tr>
                        <td colSpan={6} className="tMuted">
                          Loading team…
                        </td>
                      </tr>
                    ) : (
                      team.map((p) => (
                      <tr key={p.id}>
                        <td className="tName">{p.full_name}</td>
                        <td className="tMuted">{p.email}</td>
                        <td>
                          <Select
                            size="sm"
                            value={p.role}
                            onChange={(v) => updateTeamRow(p.id, { role: v })}
                            options={roleOptions}
                          />
                        </td>
                        <td>
                          <Select
                            size="sm"
                            value={p.manager_id || ''}
                            onChange={(v) => updateTeamRow(p.id, { manager_id: v || null })}
                            options={[
                              { value: '', label: '—' },
                              ...managers
                                .filter((m) => m.id !== p.id)
                                .map((m) => ({ value: m.id, label: m.full_name })),
                            ]}
                          />
                        </td>
                        <td>
                          <label className="inlineToggle">
                            <input
                              type="checkbox"
                              checked={!!p.is_active}
                              onChange={(e) => updateTeamRow(p.id, { is_active: e.target.checked })}
                            />
                            <span className={['statusBadge', p.is_active ? 'on' : 'off'].join(' ')}>
                              {p.is_active ? 'Active' : 'Inactive'}
                            </span>
                          </label>
                        </td>
                        <td>
                          <div className="rowActions">
                            <button
                              className="btnSecondary"
                              type="button"
                              onClick={() => onSendPasswordReset(p)}
                              disabled={!p.email || resetSendingId === p.id}
                            >
                              {resetSendingId === p.id ? 'Sending…' : 'Send reset'}
                            </button>
                            <button
                              className="btnSecondary"
                              type="button"
                              onClick={() => deactivateUser(p.id)}
                              disabled={!p.is_active}
                            >
                              Deactivate
                            </button>
                          </div>
                        </td>
                      </tr>
                      ))
                    )}
                  </tbody>
                  </table>
                </div>

                <div className="adminHint">
                  Invites create a real login via an Edge Function. Use <strong>Send reset</strong> if someone cannot sign in or missed their invite email.
                </div>
              </div>
            </div>
          ) : null}
        </section>
      </div>

      {inviteOpen ? (
        <div className="modalOverlay" role="dialog" aria-modal="true">
          <div className="modalCard">
            <div className="modalHeader">
              <div>
                <div className="modalTitle">Invite User</div>
                <div className="modalSub">Send an email invite to join Apex Wealth CRM</div>
              </div>
              <button className="iconBtn" type="button" onClick={() => setInviteOpen(false)}>
                ✕
              </button>
            </div>

            <div className="modalBody">
              <div className="inlineHint" style={{ marginBottom: 12 }}>
                Invited users must click the email link and set a password before they can sign in here.
              </div>
              <div className="formGrid">
                <label className="sField">
                  <div className="sLabel">Email</div>
                  <input
                    className="sInput"
                    value={inviteForm.email}
                    onChange={(e) => setInviteForm((f) => ({ ...f, email: e.target.value }))}
                    placeholder="name@apexwealth.com"
                  />
                </label>
                <label className="sField">
                  <div className="sLabel">Full name</div>
                  <input
                    className="sInput"
                    value={inviteForm.full_name}
                    onChange={(e) => setInviteForm((f) => ({ ...f, full_name: e.target.value }))}
                    placeholder="Full name"
                  />
                </label>
                <label className="sField">
                  <div className="sLabel">Role</div>
                  <Select
                    value={inviteForm.role}
                    onChange={(v) => setInviteForm((f) => ({ ...f, role: v }))}
                    options={roleOptions}
                  />
                </label>
                <label className="sField">
                  <div className="sLabel">Manager</div>
                  <Select
                    value={inviteForm.manager_id}
                    onChange={(v) => setInviteForm((f) => ({ ...f, manager_id: v }))}
                    options={[
                      { value: '', label: '—' },
                      ...managers
                        .filter((m) => m.id !== profile?.id)
                        .map((m) => ({ value: m.id, label: m.full_name })),
                    ]}
                  />
                </label>
              </div>
            </div>

            <div className="modalFooter">
              <button className="btnSecondary" type="button" onClick={() => setInviteOpen(false)}>
                Cancel
              </button>
              <button
                className="btnPrimary"
                type="button"
                disabled={inviteLoading || !inviteForm.email}
                onClick={async () => {
                  setInviteError(null)
                  setInviteSuccess(null)
                  setInviteLoading(true)
                  try {
                    const invitedEmail = inviteForm.email.trim()
                    const result = await inviteUser({
                      email: invitedEmail,
                      full_name: inviteForm.full_name.trim(),
                      role: inviteForm.role,
                      manager_id: inviteForm.manager_id || null,
                    })
                    const rows = await fetchProfilesPageData()
                    setTeam(rows)
                    setInviteForm({ email: '', full_name: '', role: 'advisor', manager_id: '' })
                    setInviteOpen(false)
                    setInviteSuccess(
                      result?.existing
                        ? result.message ||
                            `${invitedEmail} is already on the team. Profile updated — they should sign in or use Forgot password if needed.`
                        : `Invite sent to ${invitedEmail}. They must open the email and set a password before signing in.`,
                    )
                  } catch (e) {
                    setInviteError(e)
                  } finally {
                    setInviteLoading(false)
                  }
                }}
              >
                {inviteLoading ? 'Sending…' : 'Send invite'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

