import { useCallback, useEffect, useMemo, useState } from 'react'
import { TopBar, Sidebar, BottomNav } from './Layout.jsx'
import { MetricCard, TrafficChart } from './Charts.jsx'
import { NodesTable, DeploymentsTable } from './Tables.jsx'
import ActivityFeed from './ActivityFeed.jsx'
import SettingsPanel from './SettingsPanel.jsx'
import BuildPanel from './BuildPanel.jsx'
import NodeTerminal from './NodeTerminal.jsx'
import FleetDiagnostics from './FleetDiagnostics.jsx'
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
      setError('Lost connection to the server. Retrying…')
    }
  }, [onExpired])

  // poll every 30s; also keeps "x mins ago" fresh
  useEffect(() => {
    load()
    const id = setInterval(load, 30_000)
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
    return nodes.filter((n) => [n.id, n.ip, n.region, n.status].some((v) => v.toLowerCase().includes(q)))
  }, [nodes, query])

  // typing in search jumps to the node list unless you're already looking at one
  function search(q) {
    setQuery(q)
    if (q && page !== 'overview' && page !== 'nodes') setPage('nodes')
  }

  return (
    <div className="min-h-screen bg-soft pb-16 md:pb-0">
      <TopBar
        session={session}
        workspace={workspace}
        onWorkspace={setWorkspace}
        query={query}
        onQuery={search}
        onLogout={onLogout}
      />

      <div className="flex gap-6 px-4 py-5 max-w-[1400px] mx-auto">
        <Sidebar page={page} onPage={setPage} nodes={nodes ?? []} subnet={data?.subnet} live={data?.live} demo={data?.demo} execEnabled={execEnabled} />

        <main className="flex-1 min-w-0 space-y-4">
          {error && <div className="card px-4 py-3 text-bad text-[14px]">{error}</div>}
          {!data && !error && <div className="card px-4 py-10 text-center text-muted">Loading…</div>}
          {data && data.total === 0 && (
            <div className="card px-4 py-3 text-[14px]">
              <span className="font-semibold">No nodes connected yet.</span>{' '}
              <span className="text-muted">Deploy an agent with a valid client certificate and it'll appear here as it checks in over mTLS.</span>
            </div>
          )}
          {data && data.demo && (
            <div className="card px-4 py-3 text-[14px]">
              <span className="font-semibold">Showing sample data.</span>{' '}
              <span className="text-muted">No real nodes have reported yet — this is a demo fleet. Set <code className="font-mono">M12_DEMO=0</code> to hide it.</span>
            </div>
          )}

          {data && page === 'overview' && (
            <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_340px] gap-4">
              <div className="space-y-4 min-w-0">
                <div className="grid grid-cols-1 sm:grid-cols-2 2xl:grid-cols-4 gap-4">
                  {data.metrics.map((m) => (
                    <MetricCard key={m.key} metric={m} />
                  ))}
                </div>
                <TrafficChart traffic={data.traffic} />
                <NodesTable nodes={filtered} resetKey={query} onTerminal={execEnabled ? setTerminalNode : undefined} />
              </div>
              <ActivityFeed events={data.events} />
            </div>
          )}

          {data && page === 'nodes' && (
            <NodesTable nodes={filtered} resetKey={query} pageSize={25} showFilters title="All Nodes" onTerminal={execEnabled ? setTerminalNode : undefined} />
          )}

          {data && page === 'deployments' && (
            <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_340px] gap-4">
              <div className="space-y-4 min-w-0">
                {buildEnabled && <BuildPanel />}
                <DeploymentsTable deployments={data.deployments} />
              </div>
              <ActivityFeed events={data.events} limit={6} />
            </div>
          )}

          {page === 'fleet' && execEnabled && <FleetDiagnostics />}

          {data && page === 'settings' && <SettingsPanel subnet={data.subnet} />}
        </main>
      </div>

      <BottomNav page={page} onPage={setPage} execEnabled={execEnabled} />
      {terminalNode && <NodeTerminal nodeId={terminalNode} onClose={() => setTerminalNode(null)} />}
    </div>
  )
}
