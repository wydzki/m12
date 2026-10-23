import { useEffect, useRef, useState } from 'react'
import { Hammer, Loader2, ChevronRight } from 'lucide-react'

const OK = '__M12_BUILD_OK__'
const FAIL = '__M12_BUILD_FAIL__'

export default function BuildPanel() {
  const [running, setRunning] = useState(false)
  const [log, setLog] = useState('')
  const [status, setStatus] = useState('idle')
  const [showToken, setShowToken] = useState(false)
  const [token, setToken] = useState(() => {
    try {
      return localStorage.getItem('m12_build_token') || ''
    } catch {
      return ''
    }
  })
  const preRef = useRef(null)

  useEffect(() => {
    if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight
  }, [log])

  async function start() {
    if (running) return
    setRunning(true)
    setStatus('idle')
    setLog('')
    try {
      localStorage.setItem('m12_build_token', token)
    } catch {
      /* private mode */
    }

    try {
      const res = await fetch('/api/build', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', ...(token ? { 'X-M12-Build-Token': token } : {}) },
        body: '{}',
      })

      if (!res.ok || !res.body) {
        let msg = `build failed (${res.status})`
        try {
          const j = await res.json()
          if (j?.error) msg = j.error
        } catch {
          /* non-JSON */
        }
        setLog(msg)
        setStatus('fail')
        return
      }

      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let acc = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        acc += dec.decode(value, { stream: true })
        if (acc.includes(OK)) setStatus('ok')
        else if (acc.includes(FAIL)) setStatus('fail')
        setLog(acc.split('\n').filter((l) => !l.includes(OK) && !l.includes(FAIL)).join('\n'))
      }
    } catch (e) {
      setLog((l) => `${l}\n[error] ${e.message || 'stream error'}`)
      setStatus('fail')
    } finally {
      setRunning(false)
    }
  }

  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0">
          <h2 className="font-mono font-semibold text-[13px] text-bright uppercase tracking-wider">Build</h2>
          <p className="text-muted text-[12px] font-mono mt-0.5">compile MIPS agent and publish to TFTP</p>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {status === 'ok' && <span className="text-ok text-[12px] font-mono font-semibold">build ok</span>}
          {status === 'fail' && <span className="text-bad text-[12px] font-mono font-semibold">build failed</span>}
          <button onClick={start} disabled={running} className="btn btn-primary flex items-center gap-2 disabled:opacity-60">
            {running ? <Loader2 className="size-3.5 animate-spin" /> : <Hammer className="size-3.5" />}
            {running ? 'building...' : 'build'}
          </button>
        </div>
      </div>

      <button
        onClick={() => setShowToken((v) => !v)}
        className="mt-3 inline-flex items-center gap-1 text-[12px] font-mono text-muted hover:text-ink cursor-pointer"
      >
        <ChevronRight className={`size-3 transition-transform ${showToken ? 'rotate-90' : ''}`} />
        token
      </button>
      {showToken && (
        <input
          type="password"
          className="field mt-1 max-w-sm"
          placeholder="X-M12-Build-Token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoComplete="off"
        />
      )}

      {log && (
        <pre
          ref={preRef}
          className="mt-3 max-h-72 overflow-auto rounded bg-page text-ink text-[11px] leading-relaxed p-3 whitespace-pre-wrap break-words font-mono border border-line"
        >
          {log}
        </pre>
      )}
    </section>
  )
}
