import { useCallback, useEffect, useState } from 'react'
import Login from './components/Login.jsx'
import Dashboard from './components/Dashboard.jsx'
import { Logo } from './components/ui.jsx'
import { api } from './api.js'

export default function App() {
  // undefined = still checking the cookie, null = signed out
  const [session, setSession] = useState(undefined)

  useEffect(() => {
    api
      .session()
      .then((r) => setSession(r.ok ? { name: r.data.user, workspace: 'lan' } : null))
      .catch(() => setSession(null))
  }, [])

  const expired = useCallback(() => setSession(null), [])

  async function logout() {
    await api.logout().catch(() => {})
    setSession(null)
  }

  if (session === undefined) {
    return (
      <div className="min-h-screen bg-page grid place-items-center">
        <Logo size="md" />
      </div>
    )
  }
  if (!session) return <Login onLogin={setSession} />
  return <Dashboard session={session} onLogout={logout} onExpired={expired} />
}
