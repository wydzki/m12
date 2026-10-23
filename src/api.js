// All requests are same-origin; the session lives in an HttpOnly cookie the page can't read.
async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  let data = null
  try {
    data = await res.json()
  } catch {
    // empty or non-JSON body
  }
  return { ok: res.ok, status: res.status, data }
}

export const api = {
  session: () => request('/api/session'),
  login: (username, password) => request('/api/login', { method: 'POST', body: { username, password } }),
  logout: () => request('/api/logout', { method: 'POST', body: {} }),
  dashboard: () => request('/api/dashboard'),
  features: () => request('/api/features'),
  nodeExec: (id) => request(`/api/nodes/${encodeURIComponent(id)}/exec`),
  runCommand: (id, command) => request(`/api/nodes/${encodeURIComponent(id)}/exec`, { method: 'POST', body: { command } }),
  fleetExec: (command) => request('/api/fleet/exec', { method: 'POST', body: { command } }),
  fleetTask: (taskId) => request(`/api/fleet/exec/${encodeURIComponent(taskId)}`),
}
