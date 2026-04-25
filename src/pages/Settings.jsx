import { useEffect, useMemo, useState } from 'react'
import { Eye, EyeOff, Plus, Save, ShieldCheck } from 'lucide-react'
import './Settings.css'
import { useAuth } from '../contexts/AuthContext.jsx'
import { createProfileRow, fetchProfilesPageData, updateProfileById } from '../lib/queries.js'
import { supabase } from '../lib/supabaseClient.js'
import { inviteUser } from '../lib/invite.js'

function roleLabel(role) {
  if (role === 'admin') return 'Admin'
  if (role === 'manager') return 'Manager'
  return 'Advisor'
}

export default function Settings() {
  const { profile, user, refreshProfile, profileLoading, profileError } = useAuth()
  const isAdmin = profile?.role === 'admin'

  // Section 1: My Profile
  const [myProfile, setMyProfile] = useState({
    full_name: '',
    email: '',
    role: '',
    is_active: true,
  })
  const [savedProfile, setSavedProfile] = useState(myProfile)
  const [savingProfile, setSavingProfile] = useState(false)
  const [profileSaveError, setProfileSaveError] = useState(null)
  const profileDirty = useMemo(() => {
    return (
      myProfile.full_name !== savedProfile.full_name ||
      myProfile.is_active !== savedProfile.is_active
    )
  }, [myProfile, savedProfile])

  useEffect(() => {
    if (!profile) return
    const next = {
      full_name: profile.full_name || '',
      email: profile.email || user?.email || '',
      role: profile.role || '',
      is_active: profile.is_active !== false,
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

  // Section 3: Preferences
  const [prefs, setPrefs] = useState({
    email_notifications: true,
    task_reminders: true,
    weekly_summary: false,
  })
  const [savedPrefs, setSavedPrefs] = useState(prefs)
  const prefsDirty = useMemo(() => {
    return (
      prefs.email_notifications !== savedPrefs.email_notifications ||
      prefs.task_reminders !== savedPrefs.task_reminders ||
      prefs.weekly_summary !== savedPrefs.weekly_summary
    )
  }, [prefs, savedPrefs])

  // Section 4: Team Management (Admin only)
  const [team, setTeam] = useState([])
  const [teamLoading, setTeamLoading] = useState(false)
  const [teamError, setTeamError] = useState(null)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteLoading, setInviteLoading] = useState(false)
  const [inviteError, setInviteError] = useState(null)
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

      const patch = { full_name: myProfile.full_name }
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

  function onSavePrefs() {
    setSavedPrefs(prefs)
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

  async function onAddUser() {
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

      <div className="settingsStack">
        {/* Section 1 */}
        <div className="card settingsCard">
          <div className="cardHeader">
            <div className="cardTitle">My Profile</div>
            <div className="muted">Account details</div>
          </div>
          <div className="settingsBody">
            {profileLoading ? <div className="inlineHint">Loading profile…</div> : null}
            {profileError ? (
              <div className="inlineError">Failed to load profile. Make sure a `profiles` row exists.</div>
            ) : null}
            {profileSaveError ? (
              <div className="inlineError">{profileSaveError.message || 'Failed to save profile.'}</div>
            ) : null}
            <div className="formGrid">
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

              <div className="sField">
                <div className="sLabel">Role</div>
                <div className="sReadRow">
                  <span className={['sBadge', `role-${myProfile.role}`].join(' ')}>
                    <ShieldCheck size={14} />
                    {roleLabel(myProfile.role)}
                  </span>
                  <span className="muted">Read-only</span>
                </div>
              </div>

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

        {/* Section 2 */}
        <div className="card settingsCard">
          <div className="cardHeader">
            <div className="cardTitle">Password</div>
            <div className="muted">Update your password</div>
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

        {/* Section 3 */}
        <div className="card settingsCard">
          <div className="cardHeader">
            <div className="cardTitle">Preferences</div>
            <div className="muted">Notification settings</div>
          </div>
          <div className="settingsBody">
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
            <div className="settingsFooter">
              <button className="btnPrimary" type="button" onClick={onSavePrefs} disabled={!prefsDirty}>
                <Save size={16} />
                Save Preferences
              </button>
            </div>
          </div>
        </div>

        {/* Section 4 */}
        {isAdmin ? (
          <div className="card settingsCard">
            <div className="cardHeader">
              <div className="cardTitle">Team Management</div>
              <div className="muted">Admin-only controls</div>
            </div>
            <div className="settingsBody">
              {teamError ? (
                <div className="inlineError">{teamError.message || 'Team update failed.'}</div>
              ) : null}
              {inviteError ? (
                <div className="inlineError">{inviteError.message || 'Invite failed.'}</div>
              ) : null}
              <div className="adminTop">
                <button className="btnPrimary" type="button" onClick={onAddUser}>
                  <Plus size={16} />
                  Invite User
                </button>
              </div>

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
                          <select
                            className="tSelect"
                            value={p.role}
                            onChange={(e) => updateTeamRow(p.id, { role: e.target.value })}
                          >
                            <option value="admin">admin</option>
                            <option value="manager">manager</option>
                            <option value="advisor">advisor</option>
                          </select>
                        </td>
                        <td>
                          <select
                            className="tSelect"
                            value={p.manager_id || ''}
                            onChange={(e) => updateTeamRow(p.id, { manager_id: e.target.value || null })}
                          >
                            <option value="">—</option>
                            {managers
                              .filter((m) => m.id !== p.id)
                              .map((m) => (
                                <option key={m.id} value={m.id}>
                                  {m.full_name}
                                </option>
                              ))}
                          </select>
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
                            <button className="btnSecondary" type="button">
                              Edit
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
                Invites create a real login via an Edge Function (service role). Profiles are created/updated server-side.
              </div>
            </div>
          </div>
        ) : null}
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
                  <select
                    className="sInput"
                    value={inviteForm.role}
                    onChange={(e) => setInviteForm((f) => ({ ...f, role: e.target.value }))}
                  >
                    <option value="admin">admin</option>
                    <option value="manager">manager</option>
                    <option value="advisor">advisor</option>
                  </select>
                </label>
                <label className="sField">
                  <div className="sLabel">Manager</div>
                  <select
                    className="sInput"
                    value={inviteForm.manager_id}
                    onChange={(e) => setInviteForm((f) => ({ ...f, manager_id: e.target.value }))}
                  >
                    <option value="">—</option>
                    {managers
                      .filter((m) => m.id !== profile?.id)
                      .map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.full_name}
                        </option>
                      ))}
                  </select>
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
                  setInviteLoading(true)
                  try {
                    await inviteUser({
                      email: inviteForm.email.trim(),
                      full_name: inviteForm.full_name.trim(),
                      role: inviteForm.role,
                      manager_id: inviteForm.manager_id || null,
                    })
                    const rows = await fetchProfilesPageData()
                    setTeam(rows)
                    setInviteForm({ email: '', full_name: '', role: 'advisor', manager_id: '' })
                    setInviteOpen(false)
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

