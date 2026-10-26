import { useCallback, useEffect, useMemo, useState } from 'react'
import { TopBar, Sidebar, BottomNav } from './Layout.jsx'
import { MetricCard } from './Charts.jsx'
import { NodesTable, DeploymentsTable } from './Tables.jsx'
import SettingsPanel from './SettingsPanel.jsx'
import BuildPanel from './BuildPanel.jsx'
import NodeTerminal from './NodeTerminal.jsx'
import FleetDiagnostics from './FleetDiagnostics.jsx'
import Listeners from './Listeners.jsx'
import { WORKSPACES } from '../constants.js'
import { api } from '../api.js'

export default function Dashboard({ session, onLogout, onExpired }) {
  const [page, setPage] = useState('overview')
  const [workspace, setWorkspace] = useState(session.workspace)
  const [query, setQuery] = useState('')
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [buildEnabled, setBuildEnabled] = useState(false)
  const [execEnabled, setExecEnabled] = useState(false)
  const [terminalNode, setTerminalNode] = useState(null)

  useEffect(() => {
    api
      .features()
      .then((r) => {
        if (!r.ok) return
        setBuildEnabled(Boolean(r.data?.build))
        setExecEnabled(Boolean(r.data?.exec))
      })
      .catch(() => {})
  }, [])

  const load = useCallback(async () => {
    try {
      const r = await api.dashboard()
      if (r.status === 401) return onExpired()
      if (!r.ok) throw new Error()
      setData(r.data)
      setError('')
    } catch {
      setError('connection lost. retrying...')
    }
  }, [onExpired])

  useEffect(() => {
    load()
    const id = setInterval(load, 15_000)
    return () => clearInterval(id)
  }, [load])

  const ws = WORKSPACES.find((w) => w.id === workspace)

  useEffect(() => {
    document.title = `m12 · ${ws.label}`
  }, [ws])

  const nodes = data?.nodes
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!nodes || !q) return nodes ?? []
    return nodes.filter((n) => [n.id, n.ip, n.externalIp, n.region, n.status, n.hostname, n.systemType, n.user].some((v) => v && v.toLowerCase().includes(q)))
  }, [nodes, query])

  function search(q) {
    setQuery(q)
    if (q && page !== 'overview' && page !== 'nodes') setPage('overview')
  }

  return (
    <div className="min-h-screen bg-page pb-14 md:pb-0">
      <TopBar
        session={session}
        workspace={workspace}
        onWorkspace={setWorkspace}
        query={query}
        onQuery={search}
        onLogout={onLogout}
      />

      <div className="flex gap-4 px-4 py-4 max-w-[1400px] mx-auto">
        <Sidebar page={page} onPage={setPage} nodes={nodes ?? []} subnet={data?.subnet} live={data?.live} demo={data?.demo} execEnabled={execEnabled} />

        <main className="flex-1 min-w-0 space-y-3">
          {error && <div className="card px-3 py-2.5 text-bad text-[13px] font-mono">{error}</div>}
          {!data && !error && <div className="card px-3 py-8 text-center text-muted font-mono text-[13px]">loading...</div>}
          {data && data.total === 0 && !data.demo && (
            <div className="card px-3 py-2.5 text-[13px] font-mono">
              <span className="text-warn">no clients checking in.</span>{' '}
              <span className="text-muted">deploy a client with a valid mTLS cert to begin.</span>
            </div>
          )}

          {data && page === 'overview' && (
            <div className="space-y-3 min-w-0">
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
                {data.metrics.map((m) => (
                  <MetricCard key={m.key} metric={m} />
                ))}
              </div>
              <NodesTable nodes={filtered} resetKey={query} onTerminal={execEnabled ? setTerminalNode : undefined} />
            </div>
          )}

          {data && page === 'listeners' && execEnabled && <Listeners nodes={filtered} onTerminal={setTerminalNode} />}

          {page === 'fleet' && execEnabled && <FleetDiagnostics />}

          {data && page === 'deployments' && (
            <div className="space-y-3 min-w-0">
              {buildEnabled && <BuildPanel />}
              <DeploymentsTable deployments={data.deployments} />
            </div>
          )}

          {data && page === 'settings' && <SettingsPanel subnet={data.subnet} />}
        </main>
      </div>

      <BottomNav page={page} onPage={setPage} execEnabled={execEnabled} />
      {terminalNode && <NodeTerminal nodeId={terminalNode} onClose={() => setTerminalNode(null)} />}
    </div>
  )
}
