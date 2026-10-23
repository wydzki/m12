import { useState } from 'react'
import { Logo } from './ui.jsx'
import { WORKSPACES } from '../constants.js'
import { api } from '../api.js'

export default function Login({ onLogin }) {
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [workspace, setWorkspace] = useState('lan')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const r = await api.login(name.trim(), password)
      if (r.ok) return onLogin({ name: r.data.user, workspace })
      if (r.status === 429) {
        const mins = Math.max(1, Math.ceil((r.data?.retryAfter ?? 60) / 60))
        setError(`rate limited. retry in ${mins}m.`)
      } else {
        setError(r.data?.error || 'auth failed.')
      }
    } catch {
      setError('connection failed.')
    } finally {
      setPassword('')
      setBusy(false)
    }
  }

  const clearError = (set) => (e) => {
    set(e.target.value)
    setError('')
  }

  return (
    <div className="min-h-screen flex flex-col bg-page">
      <div className="flex-1 grid lg:grid-cols-2">
        <div className="hidden lg:grid place-items-center bg-surface border-r border-line">
          <div className="text-center">
            <Logo size="xl" tagline />
            <div className="mt-4 font-mono text-[12px] text-muted">mTLS fleet management</div>
          </div>
        </div>

        <main className="flex flex-col justify-center px-6 py-12 max-w-sm w-full mx-auto">
          <div className="lg:hidden mb-6">
            <Logo size="md" tagline />
          </div>

          <h1 className="font-mono text-[13px] text-muted uppercase tracking-wider mb-6">authenticate</h1>

          <form onSubmit={submit} className="space-y-3">
            <input
              className="field"
              placeholder="username"
              value={name}
              onChange={clearError(setName)}
              autoComplete="username"
              maxLength={128}
              required
            />
            <input
              type="password"
              className="field"
              placeholder="password"
              value={password}
              onChange={clearError(setPassword)}
              autoComplete="current-password"
              maxLength={256}
              required
            />
            <select className="field" value={workspace} onChange={(e) => setWorkspace(e.target.value)}>
              {WORKSPACES.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.label}
                </option>
              ))}
            </select>

            {error && <p className="text-bad text-[12px] font-mono">{error}</p>}

            <button type="submit" disabled={busy} className="btn btn-primary w-full py-2.5 disabled:opacity-60">
              {busy ? 'authenticating...' : 'login'}
            </button>
          </form>
        </main>
      </div>
    </div>
  )
}
