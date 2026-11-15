import './App.css'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'

import Sidebar from './components/layout/Sidebar.jsx'
import Topbar from './components/layout/Topbar.jsx'
import Dashboard from './pages/Dashboard.jsx'
import Tasks from './pages/Tasks.jsx'
import Pipeline from './pages/Pipeline.jsx'
import Clients from './pages/Clients.jsx'
import ClientDetail from './pages/ClientDetail.jsx'
import Leads from './pages/Leads.jsx'
import Team from './pages/Team.jsx'
import Settings from './pages/Settings.jsx'
import Reports from './pages/Reports.jsx'
import Calendar from './pages/Calendar.jsx'
import Auth from './pages/Auth.jsx'
import ResetPassword from './pages/ResetPassword.jsx'
import { AuthProvider, useAuth } from './contexts/AuthContext.jsx'
import { APP_ROLES, rolesForPath } from './lib/access.js'
import { useEffect, useState } from 'react'

function BlockedScreen({ title, subtitle }) {
  const { signOut } = useAuth()
  return (
    <div className="authWrap">
      <div className="authCard" style={{ textAlign: 'left' }}>
        <h1 className="authTitle" style={{ marginTop: 0 }}>
          {title}
        </h1>
        <div className="authSubtitle">{subtitle}</div>
        <button className="btnPrimary" type="button" onClick={() => signOut()} style={{ marginTop: 16 }}>
          Sign out
        </button>
      </div>
    </div>
  )
}

function AuthGate({ children }) {
  const { loading, session, passwordRecovery, profile, profileLoading, profileError } = useAuth()
  const [transitioning, setTransitioning] = useState(false)

  useEffect(() => {
    if (session) {
      setTransitioning(true)
      const t = setTimeout(() => setTransitioning(false), 420)
      return () => clearTimeout(t)
    }
    setTransitioning(false)
  }, [session])

  if (loading) {
    return (
      <div className="authWrap">
        <div className="authCard" style={{ textAlign: 'left' }}>
          <div className="authTitle" style={{ marginTop: 0 }}>
            Loading…
          </div>
          <div className="authSubtitle">Connecting to Supabase session</div>
        </div>
      </div>
    )
  }
  if (!session) return <Auth />
  if (passwordRecovery) return <ResetPassword />
  if (profileLoading || !profile) {
    if (profileError) {
      return (
        <BlockedScreen
          title="Could not load your profile"
          subtitle={profileError.message || 'Check your connection and try again.'}
        />
      )
    }
    if (!profileLoading && !profile) {
      return (
        <BlockedScreen
          title="No profile for this account"
          subtitle="Ask an admin to invite you again. Profiles are created on the server, not in the browser."
        />
      )
    }
    return (
      <div className="authWrap">
        <div className="authCard" style={{ textAlign: 'left' }}>
          <div className="authTitle" style={{ marginTop: 0 }}>
            Loading…
          </div>
          <div className="authSubtitle">Checking your access</div>
        </div>
      </div>
    )
  }
  if (profile.is_active === false) {
    return (
      <BlockedScreen
        title="Account deactivated"
        subtitle="An admin has turned off access for this account. Ask them to reactivate you."
      />
    )
  }
  if (!APP_ROLES.includes(profile.role)) {
    return (
      <BlockedScreen
        title="Access not available"
        subtitle="This account does not have a CRM role. Ask an admin to assign admin, manager, or advisor."
      />
    )
  }
  return (
    <>
      {transitioning ? <div className="loginTransition" aria-hidden="true" /> : null}
      {children}
    </>
  )
}

function RoleRoute({ path, children }) {
  const { profile } = useAuth()
  if (!rolesForPath(path).includes(profile?.role)) {
    return <Navigate to="/dashboard" replace />
  }
  return children
}

function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false)

  return (
    <AuthProvider>
      <BrowserRouter>
        <AuthGate>
          <div className="appShell">
            <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
            <main className="appMain">
              <Topbar
                onOpenSidebar={() => setSidebarOpen(true)}
                onCloseSidebar={() => setSidebarOpen(false)}
                sidebarOpen={sidebarOpen}
              />
              <div className="appContent">
                <Routes>
                  <Route path="/" element={<Navigate to="/dashboard" replace />} />
                  <Route path="/dashboard" element={<RoleRoute path="/dashboard"><Dashboard /></RoleRoute>} />
                  <Route path="/reports" element={<RoleRoute path="/reports"><Reports /></RoleRoute>} />
                  <Route path="/leads" element={<RoleRoute path="/leads"><Leads /></RoleRoute>} />
                  <Route path="/tasks" element={<RoleRoute path="/tasks"><Tasks /></RoleRoute>} />
                  <Route path="/pipeline" element={<RoleRoute path="/pipeline"><Pipeline /></RoleRoute>} />
                  <Route path="/clients" element={<RoleRoute path="/clients"><Clients /></RoleRoute>} />
                  <Route path="/clients/:id" element={<RoleRoute path="/clients"><ClientDetail /></RoleRoute>} />
                  <Route path="/calendar" element={<RoleRoute path="/calendar"><Calendar /></RoleRoute>} />
                  <Route path="/team" element={<RoleRoute path="/team"><Team /></RoleRoute>} />
                  <Route path="/settings" element={<RoleRoute path="/settings"><Settings /></RoleRoute>} />
                  <Route path="*" element={<Navigate to="/dashboard" replace />} />
                </Routes>
              </div>
            </main>
          </div>
        </AuthGate>
      </BrowserRouter>
    </AuthProvider>
  )
}
export default App
