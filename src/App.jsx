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
import { useEffect, useState } from 'react'

function AuthGate({ children }) {
  const { loading, session, passwordRecovery } = useAuth()
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
  return (
    <>
      {transitioning ? <div className="loginTransition" aria-hidden="true" /> : null}
      {children}
    </>
  )
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
                  <Route path="/dashboard" element={<Dashboard />} />
                  <Route path="/reports" element={<Reports />} />
                  <Route path="/leads" element={<Leads />} />
                  <Route path="/tasks" element={<Tasks />} />
                  <Route path="/pipeline" element={<Pipeline />} />
                  <Route path="/clients" element={<Clients />} />
                  <Route path="/clients/:id" element={<ClientDetail />} />
                  <Route path="/calendar" element={<Calendar />} />
                  <Route path="/team" element={<Team />} />
                  <Route path="/settings" element={<Settings />} />
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
