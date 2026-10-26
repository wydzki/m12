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
  fleetDryRun: (selector, commandType) => request('/api/fleet/dry-run', { method: 'POST', body: { selector, commandType } }),
  fleetExec: (command, selector, confirm_token) => request('/api/fleet/exec', { method: 'POST', body: { command, selector, confirm_token } }),
  fleetTask: (taskId) => request(`/api/fleet/exec/${encodeURIComponent(taskId)}`),
  nodeTags: (id) => request(`/api/nodes/${encodeURIComponent(id)}/tags`),
  setTags: (id, tags) => request(`/api/nodes/${encodeURIComponent(id)}/tags`, { method: 'PUT', body: { tags } }),
  deleteTag: (id, key) => request(`/api/nodes/${encodeURIComponent(id)}/tags`, { method: 'DELETE', body: { key } }),
  configPush: (addresses, selector, confirm_token) => request('/api/fleet/config', { method: 'POST', body: { addresses, selector, confirm_token } }),
  removeNode: (id) => request(`/api/nodes/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  opHeartbeat: (opId) => request(`/api/ops/${encodeURIComponent(opId)}/heartbeat`, { method: 'POST', body: {} }),
  opClose: (opId) => request(`/api/ops/${encodeURIComponent(opId)}/close`, { method: 'POST', body: {} }),
  opList: () => request('/api/ops'),
  filePush: (path, data, selector, confirm_token) => request('/api/fleet/push', { method: 'POST', body: { path, data, selector, confirm_token } }),
  filePull: (path, selector, confirm_token) => request('/api/fleet/pull', { method: 'POST', body: { path, selector, confirm_token } }),
  fileDownload: (fileId) => request(`/api/files/${encodeURIComponent(fileId)}`),
  audit: () => request('/api/audit'),
}
