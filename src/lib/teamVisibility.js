/**
 * Org visibility helpers for Team Profiles + Settings Team.
 *
 * Admin: everyone
 * Manager: self + recursive downline (reports and reports-of-reports)
 * Advisor: self + peers who share the same manager_id
 */

export function buildDownlineIds(profiles, rootId) {
  const byManager = new Map()
  for (const p of profiles || []) {
    if (!p?.manager_id) continue
    const list = byManager.get(p.manager_id) || []
    list.push(p.id)
    byManager.set(p.manager_id, list)
  }

  const out = new Set()
  const stack = [...(byManager.get(rootId) || [])]
  while (stack.length) {
    const id = stack.pop()
    if (!id || out.has(id)) continue
    out.add(id)
    const kids = byManager.get(id)
    if (kids?.length) stack.push(...kids)
  }
  return out
}

export function visibleProfileIds(viewer, profiles) {
  const all = profiles || []
  if (!viewer?.id) return new Set()

  if (viewer.role === 'admin') {
    return new Set(all.map((p) => p.id))
  }

  if (viewer.role === 'manager') {
    const ids = buildDownlineIds(all, viewer.id)
    ids.add(viewer.id)
    return ids
  }

  // Advisor: self + same-manager peers
  const ids = new Set([viewer.id])
  if (viewer.manager_id) {
    for (const p of all) {
      if (p.manager_id === viewer.manager_id) ids.add(p.id)
    }
  }
  return ids
}

export function filterVisibleProfiles(viewer, profiles) {
  const allowed = visibleProfileIds(viewer, profiles)
  return (profiles || []).filter((p) => allowed.has(p.id))
}

export function canManageTeamTab(viewer) {
  return viewer?.role === 'admin' || viewer?.role === 'manager'
}

/** Managers may edit recursive downline only; admins may edit anyone. */
export function canEditTeamMember(viewer, member, profiles) {
  if (!viewer?.id || !member?.id) return false
  if (viewer.role === 'admin') return true
  if (viewer.role === 'manager') {
    return buildDownlineIds(profiles || [], viewer.id).has(member.id)
  }
  return false
}
