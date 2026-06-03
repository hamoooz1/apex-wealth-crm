import { NavLink } from 'react-router-dom'
import {
  Briefcase,
  LayoutDashboard,
  Users,
  Settings,
  KanbanSquare,
  UserRoundSearch,
  ListTodo,
  CalendarDays,
  LogOut,
  BarChart3,
} from 'lucide-react'

import { useAuth } from '../../contexts/AuthContext.jsx'
import apexLogo from '../../assets/apex-wealth-logo.png'
import Avatar from '../ui/Avatar.jsx'

const navSections = [
  {
    label: 'Overview',
    items: [
      { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { to: '/reports', label: 'Reports', icon: BarChart3 },
    ],
  },
  {
    label: 'CRM',
    items: [
      { to: '/leads', label: 'Leads', icon: UserRoundSearch },
      { to: '/pipeline', label: 'Pipeline', icon: KanbanSquare },
      { to: '/clients', label: 'Clients', icon: Briefcase },
      { to: '/calendar', label: 'Calendar', icon: CalendarDays },
      { to: '/tasks', label: 'Tasks', icon: ListTodo },
    ],
  },
  {
    label: 'Team',
    items: [{ to: '/team', label: 'Team Profiles', icon: Users }],
  },
  {
    label: 'Admin',
    items: [{ to: '/settings', label: 'Settings', icon: Settings }],
  },
]

export default function Sidebar({ open = false, onClose }) {
  const { profile, signOut } = useAuth()
  return (
    <>
      <div
        className={['sidebarOverlay', open ? 'isOpen' : null].filter(Boolean).join(' ')}
        aria-hidden={open ? 'false' : 'true'}
        onClick={onClose}
      />
      <aside
        className={['sidebar', open ? 'isMobileOpen' : null].filter(Boolean).join(' ')}
        aria-label="Primary navigation"
      >
      <div className="sidebarTop">
        <img className="brandLogo" src={apexLogo} alt="Apex Wealth CRM" />
      </div>

      <nav className="sidebarNav">
        {navSections.map((section) => (
          <div className="navSection" key={section.label}>
            <div className="navSectionLabel">{section.label}</div>
            <div className="navItems">
              {section.items.map((item) => {
                const Icon = item.icon
                if (item.disabled || !item.to) {
                  return (
                    <div className="navItem navItemDisabled" key={item.label}>
                      <div className="navIcon">
                        <Icon size={16} />
                      </div>
                      <div className="navLabel">{item.label}</div>
                    </div>
                  )
                }

                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    onClick={open ? onClose : undefined}
                    className={({ isActive }) =>
                      ['navItem', isActive ? 'navItemActive' : null]
                        .filter(Boolean)
                        .join(' ')
                    }
                  >
                    <div className="navIcon">
                      <Icon size={16} />
                    </div>
                    <div className="navLabel">{item.label}</div>
                  </NavLink>
                )
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="sidebarBottom">
        <div className="profileBox">
          <Avatar
            name={profile?.full_name || 'Apex User'}
            src={profile?.avatar_url || ''}
            size="md"
          />
          <div className="profileMeta">
            <div className="profileName">{profile?.full_name || 'Apex User'}</div>
            <div className="profileRole">{profile?.role || 'user'}</div>
          </div>
          <button
            className="logoutBtn"
            type="button"
            aria-label="Logout"
            onClick={signOut}
          >
            <LogOut size={16} />
          </button>
        </div>
      </div>
    </aside>
    </>
  )
}

