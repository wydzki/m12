// Build endpoint: compiles the MIPS agent via `make` and copies the binary to a
// TFTP dir, streaming compiler output to the browser.
//
// SECURITY: we never use a shell. `spawn('make', [...])` runs the binary directly
// with a fixed argument array, so no request data can be interpreted as a command.
// The toolchain prefix comes only from server config (validated at startup), never
// from the request body. The feature is disabled unless M12_BUILD_ENABLED=1.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

const OK = '__M12_BUILD_OK__'
const FAIL = '__M12_BUILD_FAIL__'

// Allowed characters for a cross-compiler prefix (e.g. "mips-linux-gnu-"). No
// spaces, shell metacharacters, or anything that could be an option/flag.
export const CROSS_RE = /^[A-Za-z0-9._+-]{0,64}$/

function constantTimeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest()
  const hb = crypto.createHash('sha256').update(String(b)).digest()
  return crypto.timingSafeEqual(ha, hb)
}

export function createBuildHandler({ clientDir, cross, dest, binaryName = 'm12-agent', token = null, timeoutMs = 10 * 60_000, log = console.log }) {
  let building = false

  return function build(req, res, session) {
    // Extra gate on top of the session + same-origin check the router already did.
    if (token) {
      const provided = req.headers['x-m12-build-token']
      if (typeof provided !== 'string' || !constantTimeEqual(provided, token)) {
        const body = JSON.stringify({ error: 'Build token required or incorrect.' })
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' })
        return res.end(body)
      }
    }

    if (building) {
      const body = JSON.stringify({ error: 'A build is already running.' })
      res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' })
      return res.end(body)
    }

    building = true
    const user = session?.user || 'unknown'
    log(`build started by ${user} cross=${cross}`)

    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no', // ask proxies not to buffer the stream
    })
    const emit = (line) => res.write(line.endsWith('\n') ? line : line + '\n')
    emit(`[m12] make CROSS=${cross}  (cwd: client/)`)

    // Minimal env: the compiler needs PATH/HOME/LANG, nothing else. This keeps
    // server secrets (password hash, tokens) out of the build subprocess.
    const childEnv = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG || 'C' }

    const child = spawn('make', [`CROSS=${cross}`], {
      cwd: clientDir,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32', // own process group, so we can kill children too
    })

    let finished = false
    const timer = setTimeout(() => {
      emit(`[m12] build timed out after ${Math.round(timeoutMs / 1000)}s — killing`)
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }, timeoutMs)

    child.stdout.on('data', (d) => res.write(d))
    child.stderr.on('data', (d) => res.write(d))

    child.on('error', (err) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      building = false
      log(`build spawn error: ${err.message}`)
      emit(`[m12] failed to start make: ${err.message}`)
      emit(`${FAIL} spawn`)
      res.end()
    })

    child.on('close', async (code) => {
      if (finished) return
      finished = true
      clearTimeout(timer)

      if (code !== 0) {
        building = false
        log(`build failed by ${user} exit=${code}`)
        emit(`[m12] make exited ${code}`)
        emit(`${FAIL} ${code}`)
        return res.end()
      }

      // Build succeeded; publish the binary to the TFTP directory.
      const src = path.join(clientDir, binaryName)
      try {
        await fsp.access(src, fs.constants.R_OK)
        await fsp.mkdir(path.dirname(dest), { recursive: true })
        await fsp.copyFile(src, dest)
        await fsp.chmod(dest, 0o755)
        log(`build ok by ${user}; copied to ${dest}`)
        emit(`[m12] copied ${binaryName} -> ${dest}`)
        emit(`${OK}`)
      } catch (e) {
        log(`build publish failed: ${e.message}`)
        emit(`[m12] build succeeded but publish failed: ${e.message}`)
        emit(`${FAIL} publish`)
      } finally {
        building = false
        res.end()
      }
    })

    // If the client disconnects, let the build finish server-side (don't orphan a
    // compile), but stop writing. Nothing to do here; res.write no-ops after close.
    req.on('aborted', () => log(`build client disconnected (user ${user}); build continues`))
  }
}
