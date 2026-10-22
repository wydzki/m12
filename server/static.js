import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
}

// Load the built frontend into memory once. Requests are answered from this
// map only, so a crafted URL can never reach the filesystem.
export function loadStatic(dir) {
  const files = new Map()
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = path.join(d, name)
      if (statSync(full).isDirectory()) walk(full)
      else {
        const ext = path.extname(name).toLowerCase()
        if (!TYPES[ext]) continue
        const body = readFileSync(full)
        const urlPath = '/' + path.relative(dir, full).split(path.sep).join('/')
        files.set(urlPath, {
          body,
          type: TYPES[ext],
          etag: '"' + crypto.createHash('sha1').update(body).digest('base64url') + '"',
          cache: urlPath.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
        })
      }
    }
  }
  walk(dir)
  if (!files.has('/index.html')) throw new Error(`No index.html in ${dir}. Run "npm run build" first.`)
  return files
}

export function serveStatic(files, req, res, pathname) {
  let file = files.get(pathname === '/' ? '/index.html' : pathname)
  // SPA fallback for extension-less routes; anything else that isn't a known file is a 404
  if (!file && !path.posix.extname(pathname)) file = files.get('/index.html')
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end('Not found')
  }

  const headers = { 'Content-Type': file.type, 'Cache-Control': file.cache, ETag: file.etag }
  if (req.headers['if-none-match'] === file.etag) {
    res.writeHead(304, headers)
    return res.end()
  }
  res.writeHead(200, { ...headers, 'Content-Length': file.body.length })
  res.end(req.method === 'HEAD' ? undefined : file.body)
}
