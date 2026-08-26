import { useEffect, useMemo, useState } from 'react'
import { CalendarDays, Camera, Eye, EyeOff, Plus, Save, Video } from 'lucide-react'
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
import {
  canEditTeamMember as canEditTeamMemberFn,
  canManageTeamTab,
  filterVisibleProfiles,
} from '../lib/teamVisibility.js'
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

function Switch({ checked, onChange, disabled, labelledBy }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      className={['sSwitch', checked ? 'isOn' : null].filter(Boolean).join(' ')}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="sSwitchThumb" />
    </button>
  )
}

function calendlyDisplay(uri) {
  if (!uri) return 'Not connected'
  const slug = String(uri).split('/').filter(Boolean).pop()
  return slug || uri
}

export default function Settings() {
  const { profile, user, refreshProfile, profileLoading, profileError } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const isManager = profile?.role === 'manager'
  const canManageTeam = canManageTeamTab(profile)
  const [activeTab, setActiveTab] = useState('profile')

  useEffect(() => {
    if (activeTab === 'team' && !canManageTeam) setActiveTab('profile')
  }, [activeTab, canManageTeam])

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

  // Section 5: Team Management (Admin: all users · Manager: direct reports · Advisor: no access)
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

  const managers = useMemo(() => team.filter((p) => p.role === 'admin' || p.role === 'manager'), [team])
  const visibleTeam = useMemo(() => filterVisibleProfiles(profile, team), [profile, team])
  const canEditMember = (member) => canEditTeamMemberFn(profile, member, team)

  useEffect(() => {
    if (!canManageTeam || !profile?.id) return
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
  }, [canManageTeam, profile?.id])

  async function onSendPasswordReset(member) {
    if (!canEditMember(member)) {
      setInviteError(new Error('You can only reset passwords for your direct reports.'))
      return
    }
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
    setInviteForm({
      email: '',
      full_name: '',
      role: 'advisor',
      manager_id: isAdmin ? '' : profile?.id || '',
    })
    setInviteOpen(true)
  }

  async function updateTeamRow(id, patch) {
    const target = team.find((p) => p.id === id)
    if (!target) return

    if (!canEditMember(target)) {
      setTeamError(new Error('You can only update people on your team.'))
      return
    }

    if (!isAdmin) {
      // Managers may only change active status (not role / manager assignment).
      const allowed = {}
      if ('is_active' in patch) allowed.is_active = patch.is_active
      if (!Object.keys(allowed).length) {
        setTeamError(new Error('Managers can only change active status for their reports.'))
        return
      }
      patch = allowed
    }

    setTeamError(null)
    setTeam((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)))
    try {
      await updateProfileById(id, patch)
    } catch (e) {
      setTeamError(e)
    }
  }

  async function ensureProfileRowExists() {
    if (profile) return profile
    if (!user?.id) return null
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

  return (
    <div>
      <div className="pageHeader">
        <div>
          <h1 className="pageTitle">Settings</h1>
          <div className="pageSubtitle">Your account, alerts, and connected tools</div>
        </div>
      </div>

      <div className="settingsShell">
        <div className="settingsNavTop" role="tablist" aria-label="Settings sections">
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
          {canManageTeam ? (
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
                  <div className="muted">How you appear to the team</div>
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

                <div className="settingsIdentity">
                  <label className="settingsAvatarBtn" title="Change photo">
                    <Avatar name={myProfile.full_name || 'Apex User'} src={myProfile.avatar_url || ''} size="xl" />
                    <span className="settingsAvatarCam">
                      <Camera size={13} />
                    </span>
                    <input
                      type="file"
                      accept="image/*"
                      hidden
                      onChange={(e) => uploadAvatar(e.target.files?.[0])}
                    />
                  </label>
                  <div className="settingsIdentityMain">
                    <div className="settingsIdentityName">{myProfile.full_name || 'Apex User'}</div>
                    <div className="settingsIdentityEmail">{myProfile.email || user?.email || '—'}</div>
                  </div>
                  <span className={['sBadge', `role-${myProfile.role}`].join(' ')}>
                    {roleLabel(myProfile.role)}
                  </span>
                </div>

                <div className="formGrid">
                  <label className="sField">
                    <div className="sLabel">Full name</div>
                    <input
                      className="sInput"
                      value={myProfile.full_name}
                      onChange={(e) => setMyProfile((p) => ({ ...p, full_name: e.target.value }))}
                    />
                  </label>

                  <label className="sField">
                    <div className="sLabel">Email</div>
                    <input className="sInput" value={myProfile.email} readOnly />
                    <div className="sHint">Email is set from your login and can’t be changed here.</div>
                  </label>

                  {isAdmin ? (
                    <div className="sToggleRow">
                      <div>
                        <div className="sLabel" id="active-status-label">
                          Active on the team
                        </div>
                        <div className="sHint">Turn this off to hide yourself from assignment lists.</div>
                      </div>
                      <Switch
                        checked={myProfile.is_active}
                        labelledBy="active-status-label"
                        onChange={(v) => setMyProfile((p) => ({ ...p, is_active: v }))}
                      />
                    </div>
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
                    {savingProfile ? 'Saving…' : 'Save changes'}
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
                  <div className="muted">Choose a password that’s at least 8 characters</div>
                </div>
              </div>
              <div className="settingsBody">
                <div className="settingsNarrow">
                  <label className="sField">
                    <div className="sLabel">Current password</div>
                    <div className="sInputWrap">
                      <input
                        className="sInput"
                        type={showPw ? 'text' : 'password'}
                        value={pw.current}
                        autoComplete="current-password"
                        onChange={(e) => setPw((x) => ({ ...x, current: e.target.value }))}
                      />
                      <button
                        className="sEyeBtn"
                        type="button"
                        aria-label={showPw ? 'Hide passwords' : 'Show passwords'}
                        onClick={() => setShowPw((s) => !s)}
                      >
                        {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                  </label>
                  <label className="sField">
                    <div className="sLabel">New password</div>
                    <input
                      className="sInput"
                      type={showPw ? 'text' : 'password'}
                      value={pw.next}
                      autoComplete="new-password"
                      onChange={(e) => setPw((x) => ({ ...x, next: e.target.value }))}
                    />
                  </label>
                  <label className="sField">
                    <div className="sLabel">Confirm new password</div>
                    <input
                      className="sInput"
                      type={showPw ? 'text' : 'password'}
                      value={pw.confirm}
                      autoComplete="new-password"
                      onChange={(e) => setPw((x) => ({ ...x, confirm: e.target.value }))}
                    />
                  </label>
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
                    {pwSaving ? 'Updating…' : 'Update password'}
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {activeTab === 'preferences' ? (
            <div className="card settingsCard">
              <div className="cardHeader">
                <div>
                  <div className="cardTitle">Notifications</div>
                  <div className="muted">Choose what Apex sends you</div>
                </div>
              </div>
              <div className="settingsBody">
                {prefsError ? (
                  <div className="inlineError">{prefsError.message || 'Failed to save preferences.'}</div>
                ) : null}
                <div className="prefsGrid">
                  <div className="sToggleRow">
                    <div>
                      <div className="sLabel" id="pref-email-label">
                        Email notifications
                      </div>
                      <div className="sHint">Account alerts and CRM updates</div>
                    </div>
                    <Switch
                      checked={prefs.email_notifications}
                      labelledBy="pref-email-label"
                      onChange={(v) => setPrefs((p) => ({ ...p, email_notifications: v }))}
                    />
                  </div>
                  <div className="sToggleRow">
                    <div>
                      <div className="sLabel" id="pref-tasks-label">
                        Task reminders
                      </div>
                      <div className="sHint">Due dates and follow-ups</div>
                    </div>
                    <Switch
                      checked={prefs.task_reminders}
                      labelledBy="pref-tasks-label"
                      onChange={(v) => setPrefs((p) => ({ ...p, task_reminders: v }))}
                    />
                  </div>
                  <div className="sToggleRow">
                    <div>
                      <div className="sLabel" id="pref-weekly-label">
                        Weekly summary
                      </div>
                      <div className="sHint">Pipeline and activity recap once a week</div>
                    </div>
                    <Switch
                      checked={prefs.weekly_summary}
                      labelledBy="pref-weekly-label"
                      onChange={(v) => setPrefs((p) => ({ ...p, weekly_summary: v }))}
                    />
                  </div>
                </div>
                {remindersMsg ? <div className="inlineHint">{remindersMsg}</div> : null}
                <div className="settingsFooter settingsFooterSplit">
                  <button
                    className="btnSecondary"
                    type="button"
                    onClick={onRefreshReminders}
                    disabled={remindersBusy}
                  >
                    {remindersBusy ? 'Sending…' : 'Send reminders now'}
                  </button>
                  <button
                    className="btnPrimary"
                    type="button"
                    onClick={onSavePrefs}
                    disabled={!prefsDirty || prefsSaving}
                  >
                    <Save size={16} />
                    {prefsSaving ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {activeTab === 'integrations' ? (
            <div className="integrationsGrid">
              <div className="card settingsCard">
                <div className="cardHeader">
                  <div className="integHead">
                    <div className="integIcon">
                      <CalendarDays size={18} />
                    </div>
                    <div className="integMeta">
                      <div className="cardTitle">Calendly</div>
                      <div className="muted">Import scheduled meetings into the calendar</div>
                    </div>
                  </div>
                  <span className={['sStatus', calendlyConn ? 'isOn' : null].filter(Boolean).join(' ')}>
                    {calendlyConn ? 'Connected' : 'Not connected'}
                  </span>
                </div>
                <div className="settingsBody">
                  {calendlyError ? (
                    <div className="inlineError">{calendlyError.message || 'Calendly integration error.'}</div>
                  ) : null}
                  {calendlyLoading ? <div className="inlineHint">Checking connection…</div> : null}
                  <div className="sHint">
                    {calendlyConn
                      ? calendlyDisplay(calendlyConn.calendly_user_uri)
                      : 'Connect to pull your bookings into Apex.'}
                  </div>
                  {calendlyConn?.webhook_last_error ? (
                    <div className="inlineHint">
                      {/calendly account to standard|permission denied|upgrade/i.test(
                        calendlyConn.webhook_last_error,
                      )
                        ? 'Connected. Automatic sync needs a paid Calendly plan — use Sync now on the free plan.'
                        : `Connected, but automatic sync may be inactive.`}
                    </div>
                  ) : null}
                  {calendlySyncMsg ? <div className="inlineHint">{calendlySyncMsg}</div> : null}
                  <div className="integActions">
                    {calendlyConn ? (
                      <>
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
                      </>
                    ) : (
                      <button className="btnPrimary" type="button" onClick={onConnectCalendly} disabled={calendlyLoading}>
                        {calendlyLoading ? 'Connecting…' : 'Connect'}
                      </button>
                    )}
                  </div>
                </div>
              </div>

              <div className="card settingsCard">
                <div className="cardHeader">
                  <div className="integHead">
                    <div className="integIcon">
                      <Video size={18} />
                    </div>
                    <div className="integMeta">
                      <div className="cardTitle">Zoom</div>
                      <div className="muted">Create meeting links when you schedule</div>
                    </div>
                  </div>
                  <span className={['sStatus', zoomConn ? 'isOn' : null].filter(Boolean).join(' ')}>
                    {zoomConn ? 'Connected' : 'Not connected'}
                  </span>
                </div>
                <div className="settingsBody">
                  {zoomError ? (
                    <div className="inlineError">{zoomError.message || 'Zoom integration error.'}</div>
                  ) : null}
                  {zoomLoading ? <div className="inlineHint">Checking connection…</div> : null}
                  <div className="sHint">
                    {zoomConn?.email || zoomConn?.zoom_user_id || 'Connect to generate Zoom links from the CRM.'}
                  </div>
                  <div className="integActions">
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
                        {zoomLoading ? 'Connecting…' : 'Connect'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {canManageTeam && activeTab === 'team' ? (
            <div className="card settingsCard">
              <div className="cardHeader">
                <div>
                  <div className="cardTitle">Team</div>
                  <div className="muted">
                    {isAdmin
                      ? 'Full org roster — edit anyone’s role, manager, and access'
                      : 'Your downline — direct reports and their reports'}
                  </div>
                </div>
                <button className="btnPrimary" type="button" onClick={onAddUser}>
                  <Plus size={16} />
                  Invite
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
                        <th>Person</th>
                        <th>Role</th>
                        <th>Manager</th>
                        <th>Status</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {teamLoading ? (
                        <tr>
                          <td colSpan={5} className="tMuted">
                            Loading team…
                          </td>
                        </tr>
                      ) : visibleTeam.length === 0 ? (
                        <tr>
                          <td colSpan={5}>
                            <div className="teamEmpty">
                              <div className="teamEmptyTitle">No teammates yet</div>
                              <div className="tMuted">Invite someone to give them a login.</div>
                            </div>
                          </td>
                        </tr>
                      ) : (
                        visibleTeam.map((p) => {
                          const editable = canEditMember(p)
                          const managerName =
                            managers.find((m) => m.id === p.manager_id)?.full_name ||
                            team.find((m) => m.id === p.manager_id)?.full_name ||
                            '—'
                          return (
                          <tr key={p.id} className={editable || isAdmin ? undefined : 'teamRowReadonly'}>
                            <td>
                              <div className="teamPerson">
                                <Avatar name={p.full_name || p.email} src={p.avatar_url || ''} size="sm" />
                                <div className="teamPersonText">
                                  <div className="tName">{p.full_name || '—'}</div>
                                  <div className="tMuted">{p.email}</div>
                                </div>
                              </div>
                            </td>
                            <td>
                              {isAdmin ? (
                                <Select
                                  size="sm"
                                  value={p.role}
                                  onChange={(v) => updateTeamRow(p.id, { role: v })}
                                  options={roleOptions}
                                />
                              ) : (
                                <span className={['sBadge', `role-${p.role}`].join(' ')}>
                                  {roleLabel(p.role)}
                                </span>
                              )}
                            </td>
                            <td>
                              {isAdmin ? (
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
                              ) : (
                                <span className="tMuted">{managerName}</span>
                              )}
                            </td>
                            <td>
                              <div className="teamStatusCell">
                                <Switch
                                  checked={!!p.is_active}
                                  labelledBy={`status-${p.id}`}
                                  disabled={!editable}
                                  onChange={(v) => updateTeamRow(p.id, { is_active: v })}
                                />
                                <span id={`status-${p.id}`} className="tMuted">
                                  {p.is_active ? 'Active' : 'Off'}
                                </span>
                              </div>
                            </td>
                            <td>
                              <div className="rowActions">
                                <button
                                  className="btnSecondary"
                                  type="button"
                                  onClick={() => onSendPasswordReset(p)}
                                  disabled={!editable || !p.email || resetSendingId === p.id}
                                >
                                  {resetSendingId === p.id ? 'Sending…' : 'Reset password'}
                                </button>
                              </div>
                            </td>
                          </tr>
                          )
                        })
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="adminHint">
                  {isAdmin
                    ? 'Invites email a link to set a password. Use Reset password if they never got it.'
                    : 'You see your reports and their reports. Active status and password resets only work for people in your downline.'}
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
                <div className="modalTitle">{isAdmin ? 'Invite teammate' : 'Invite advisor'}</div>
                <div className="modalSub">
                  {isAdmin
                    ? 'They’ll get an email to join Apex Wealth CRM'
                    : 'They’ll join your team and get an email to set a password'}
                </div>
              </div>
              <button className="iconBtn" type="button" onClick={() => setInviteOpen(false)}>
                ✕
              </button>
            </div>

            <div className="modalBody">
              <div className="inlineHint" style={{ marginBottom: 12 }}>
                They’ll set a password from the invite email before signing in.
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
                  {isAdmin ? (
                    <Select
                      value={inviteForm.role}
                      onChange={(v) => setInviteForm((f) => ({ ...f, role: v }))}
                      options={roleOptions}
                    />
                  ) : (
                    <input className="sInput" value="Advisor" readOnly />
                  )}
                </label>
                <label className="sField">
                  <div className="sLabel">Manager</div>
                  {isAdmin ? (
                    <Select
                      value={inviteForm.manager_id}
                      onChange={(v) => setInviteForm((f) => ({ ...f, manager_id: v }))}
                      options={[
                        { value: '', label: '—' },
                        ...managers.map((m) => ({ value: m.id, label: m.full_name || m.email })),
                      ]}
                    />
                  ) : (
                    <input
                      className="sInput"
                      value={profile?.full_name || profile?.email || 'You'}
                      readOnly
                    />
                  )}
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
                      role: isAdmin ? inviteForm.role : 'advisor',
                      manager_id: isAdmin ? inviteForm.manager_id || null : profile?.id || null,
                    })
                    const rows = await fetchProfilesPageData()
                    setTeam(rows)
                    setInviteForm({
                      email: '',
                      full_name: '',
                      role: 'advisor',
                      manager_id: isAdmin ? '' : profile?.id || '',
                    })
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

