import { useEffect, useMemo, useState } from 'react'
import { Search, UserPlus, X, Save } from 'lucide-react'
import './Team.css'
import { useAuth } from '../contexts/AuthContext.jsx'
import { fetchProfilesPageData, updateProfileById } from '../lib/queries.js'
import Avatar from '../components/ui/Avatar.jsx'

function formatDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' })
}

function roleLabel(role) {
  if (role === 'admin') return 'Admin'
  if (role === 'manager') return 'Manager'
  return 'Advisor'
}

export default function Team() {
  const { profile: me } = useAuth()
  const canManage = me?.role === 'admin'

  const [profiles, setProfiles] = useState([])
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const profilesMap = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles])

  useEffect(() => {
    let mounted = true
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const rows = await fetchProfilesPageData()
        if (!mounted) return
        setProfiles(rows)
      } catch (e) {
        if (!mounted) return
        setError(e)
      } finally {
        if (mounted) setLoading(false)
      }
    }
    load()
    return () => {
      mounted = false
    }
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return profiles
    return profiles.filter((p) => {
      return (
        p.full_name.toLowerCase().includes(q) ||
        p.email.toLowerCase().includes(q)
      )
    })
  }, [profiles, query])

  const selected = useMemo(() => profilesMap.get(selectedId) || null, [profilesMap, selectedId])

  // Drawer edit state (separate local state)
  const [draft, setDraft] = useState(null)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    if (!selected) {
      setDraft(null)
      setDirty(false)
      return
    }
    setDraft({
      role: selected.role,
      manager_id: selected.manager_id || '',
      is_active: !!selected.is_active,
    })
    setDirty(false)
  }, [selectedId]) // intentionally keyed by id

  const hierarchy = useMemo(() => {
    const managers = profiles.filter((p) => p.role === 'manager')
    const advisors = profiles.filter((p) => p.role === 'advisor')
    return managers.map((m) => ({
      manager: m,
      advisors: advisors.filter((a) => a.manager_id === m.id),
    }))
  }, [profiles])

  function managerName(managerId) {
    if (!managerId) return '—'
    return profilesMap.get(managerId)?.full_name || '—'
  }

  function onOpen(p) {
    setSelectedId(p.id)
  }

  function onClose() {
    setSelectedId(null)
  }

  async function onSave() {
    if (!selected || !draft) return
    if (!canManage) return
    try {
      const updated = await updateProfileById(selected.id, {
        role: draft.role,
        manager_id: draft.manager_id || null,
        is_active: !!draft.is_active,
      })
      setProfiles((prev) => prev.map((p) => (p.id === selected.id ? updated : p)))
      setDirty(false)
    } catch (e) {
      setError(e)
    }
  }

  return (
    <div>
      <div className="pageHeader">
        <div>
          <h1 className="pageTitle">Team Profiles</h1>
          <div className="pageSubtitle">Manage and view your team structure</div>
        </div>

        <div className="teamHeaderRight">
          <div className="teamSearch">
            <Search size={16} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name or email…"
            />
          </div>
          <button className="btnPrimary" type="button" disabled={!canManage}>
            <UserPlus size={16} />
            Add Team Member
          </button>
        </div>
      </div>

      <div className="teamStack">
        <div className="card teamCard">
          <div className="cardHeader">
            <div className="cardTitle">Team</div>
            <div className="muted">
              {loading ? 'Loading…' : `${filtered.length} members`}
            </div>
          </div>

          <div className="teamTableWrap">
            <table className="teamTable">
              <thead>
                <tr>
                  <th />
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Manager</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={8} className="teamEmpty">
                      Loading team…
                    </td>
                  </tr>
                ) : error ? (
                  <tr>
                    <td colSpan={8} className="teamEmpty">
                      Failed to load profiles. Check RLS + that your user has a `profiles` row.
                    </td>
                  </tr>
                ) : (
                  filtered.map((p) => (
                  <tr key={p.id} onClick={() => onOpen(p)} role="button">
                    <td>
                      <Avatar name={p.full_name} src={p.avatar_url || ''} size="md" />
                    </td>
                    <td className="teamName">{p.full_name}</td>
                    <td className="teamMuted">{p.email}</td>
                    <td>
                      <span className={['roleBadge', `role-${p.role}`].join(' ')}>
                        {roleLabel(p.role)}
                      </span>
                    </td>
                    <td className="teamMuted">{managerName(p.manager_id)}</td>
                    <td>
                      <span className={['statusBadge', p.is_active ? 'on' : 'off'].join(' ')}>
                        {p.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="teamMuted">{formatDate(p.created_at)}</td>
                    <td>
                      <div className="rowActions" onClick={(e) => e.stopPropagation()}>
                        <button className="btnSecondary" type="button" onClick={() => onOpen(p)}>
                          View
                        </button>
                        <button className="btnSecondary" type="button" onClick={() => onOpen(p)} disabled={!canManage}>
                          Edit
                        </button>
                      </div>
                    </td>
                  </tr>
                  ))
                )}
                {!loading && !error && filtered.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="teamEmpty">
                      No team members match your search.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card teamCard">
          <div className="cardHeader">
            <div className="cardTitle">Hierarchy</div>
            <div className="muted">Managers and downline advisors</div>
          </div>
          <div className="hierBody">
            {hierarchy.length === 0 ? (
              <div className="emptyState">No managers found</div>
            ) : (
              hierarchy.map((h) => (
                <div className="hierGroup" key={h.manager.id}>
                  <div className="hierManager">
                    <Avatar name={h.manager.full_name} src={h.manager.avatar_url || ''} size="sm" />
                    <div>
                      <div className="hierName">{h.manager.full_name}</div>
                      <div className="hierMeta">{h.manager.email}</div>
                    </div>
                    <span className="roleBadge role-manager">Manager</span>
                  </div>
                  <div className="hierChildren">
                    {h.advisors.length === 0 ? (
                      <div className="hierEmpty">No advisors</div>
                    ) : (
                      h.advisors.map((a) => (
                        <div className="hierChild" key={a.id} onClick={() => onOpen(a)} role="button">
                          <Avatar name={a.full_name} src={a.avatar_url || ''} size="sm" />
                          <div className="hierName">{a.full_name}</div>
                          <span className="roleBadge role-advisor">Advisor</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <div className={['drawerOverlay', selected ? 'open' : null].filter(Boolean).join(' ')}>
        <div className={['drawer', selected ? 'open' : null].filter(Boolean).join(' ')}>
          <div className="drawerHeader">
            <div>
              <div className="drawerTitle">Profile Detail</div>
              <div className="drawerSub">View and update team member settings</div>
            </div>
            <button className="iconBtn" type="button" onClick={onClose} aria-label="Close">
              <X size={16} />
            </button>
          </div>

          {selected && draft ? (
            <div className="drawerBody">
              <div className="drawerHero">
                <Avatar name={selected.full_name} src={selected.avatar_url || ''} size="lg" />
                <div>
                  <div className="drawerName">{selected.full_name}</div>
                  <div className="drawerEmail">{selected.email}</div>
                </div>
              </div>

              <div className="drawerGrid">
                <label className="field">
                  <div className="fieldLabel">Role</div>
                  <select
                    className="fieldInput"
                    value={draft.role}
                    disabled={!canManage}
                    onChange={(e) => {
                      setDraft((d) => ({ ...d, role: e.target.value }))
                      setDirty(true)
                    }}
                  >
                    <option value="admin">admin</option>
                    <option value="manager">manager</option>
                    <option value="advisor">advisor</option>
                  </select>
                </label>

                <label className="field">
                  <div className="fieldLabel">Manager</div>
                  <select
                    className="fieldInput"
                    value={draft.manager_id}
                    disabled={!canManage}
                    onChange={(e) => {
                      setDraft((d) => ({ ...d, manager_id: e.target.value }))
                      setDirty(true)
                    }}
                  >
                    <option value="">None</option>
                    {profiles
                      .filter((p) => p.role !== 'advisor' && p.id !== selected.id)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.full_name}
                        </option>
                      ))}
                  </select>
                </label>

                <label className="field fieldRow">
                  <div>
                    <div className="fieldLabel">Active</div>
                    <div className="fieldHint">Controls access to the CRM</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={draft.is_active}
                    disabled={!canManage}
                    onChange={(e) => {
                      setDraft((d) => ({ ...d, is_active: e.target.checked }))
                      setDirty(true)
                    }}
                  />
                </label>

                <div className="field">
                  <div className="fieldLabel">Created</div>
                  <div className="fieldRead">{formatDate(selected.created_at)}</div>
                </div>
              </div>

              <div className="drawerFooter">
                <button className="btnSecondary" type="button" onClick={onClose}>
                  Cancel
                </button>
                <button className="btnPrimary" type="button" onClick={onSave} disabled={!dirty || !canManage}>
                  <Save size={16} />
                  Save
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

