export const APP_ROLES = ['admin', 'manager', 'advisor']

// Reports is an org-wide AUM and team rollup. Advisors keep the dashboard.
const ROUTE_ROLES = [
  { prefix: '/reports', roles: ['admin', 'manager'] },
  { prefix: '/dashboard', roles: APP_ROLES },
  { prefix: '/leads', roles: APP_ROLES },
  { prefix: '/tasks', roles: APP_ROLES },
  { prefix: '/pipeline', roles: APP_ROLES },
  { prefix: '/clients', roles: APP_ROLES },
  { prefix: '/calendar', roles: APP_ROLES },
  { prefix: '/team', roles: APP_ROLES },
  { prefix: '/settings', roles: APP_ROLES },
]

export function rolesForPath(pathname) {
  const path = pathname || '/'
  const match = ROUTE_ROLES.find(
    (route) => path === route.prefix || path.startsWith(`${route.prefix}/`),
  )
  return match ? match.roles : APP_ROLES
}
