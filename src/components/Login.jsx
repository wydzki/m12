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
        setError(`Too many attempts. Try again in ${mins} min.`)
      } else {
        setError(r.data?.error || 'Sign in failed.')
      }
    } catch {
      setError('Could not reach the server.')
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
    <div className="min-h-screen flex flex-col">
      <div className="flex-1 grid lg:grid-cols-2">
        <div className="hidden lg:grid place-items-center">
          <Logo size="xl" tagline />
        </div>

        <main className="flex flex-col justify-center px-6 py-12 max-w-lg w-full mx-auto lg:mx-0">
          <div className="lg:hidden mb-8">
            <Logo size="md" tagline />
          </div>
          <h1 className="text-4xl sm:text-6xl font-black tracking-tight leading-tight">Watching your network now</h1>
          <h2 className="text-2xl sm:text-3xl font-bold mt-8 mb-6">Sign in to m12.</h2>

          <form onSubmit={submit} className="space-y-3 max-w-sm">
            <input
              className="field"
              placeholder="Username"
              value={name}
              onChange={clearError(setName)}
              autoComplete="username"
              maxLength={128}
              required
            />
            <input
              type="password"
              className="field"
              placeholder="Password"
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

            {error && <p className="text-bad text-[14px]">{error}</p>}

            <button type="submit" disabled={busy} className="pill pill-dark w-full py-2.5 disabled:opacity-60">
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <p className="greentext text-[13px] mt-6 leading-relaxed">
            &gt;be sysadmin
            <br />
            &gt;forget password
            <br />
            &gt;locked out of own subnet
          </p>
        </main>
      </div>

      <footer className="flex flex-wrap justify-center gap-x-4 gap-y-1 px-4 py-4 text-[13px] text-muted">
        <span>© 2026 m12</span>
      </footer>
    </div>
  )
}
