// Usage: npm run hash-password
// Prompts for a password (input hidden) and prints the line to put in .env.
// Reads from stdin, never argv, so the password doesn't land in shell history.
import readline from 'node:readline'
import { hashPassword } from './security.js'

// Credentials Mirai-class botnets spray, plus the usual weak picks. Setting any
// of these is the single mistake that gets an open-port box conscripted.
const BLOCKLIST = new Set(
  [
    'password', 'passwd', 'admin', 'administrator', 'root', 'toor', 'user', 'guest', 'default',
    'changeme', 'letmein', 'welcome', 'qwerty', 'dragon', 'monkey', 'master', 'secret', 'login',
    '12345', '123456', '1234567', '12345678', '123456789', '1234567890', '111111', '000000',
    'admin123', 'root123', 'password1', 'password123', 'pass', 'test', 'oracle', 'ubnt', 'support',
    'service', 'supervisor', 'system', 'vizxv', 'xc3511', 'zlxx', 'juantech', '7ujMko0admin', 'xmhdipc',
    'anko', 'realtek', 'mother', 'seiko2005', 'GM8182', 'ikwb', 'hi3518', 'klv123', 'klv1234',
  ].map((s) => s.toLowerCase()),
)

// Reject weak passwords before they ever become the account credential.
function rejectReason(pw, username) {
  if (pw.length < 12) return 'must be at least 12 characters'
  if (BLOCKLIST.has(pw.toLowerCase())) return 'is a known default/common password'
  if (username && pw.toLowerCase().includes(username.toLowerCase())) return 'must not contain the username'
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(pw)).length
  if (classes < 3) return 'must mix at least 3 of: lower, upper, digit, symbol'
  if (/^(.)\1+$/.test(pw)) return 'must not be a single repeated character'
  return null
}

async function readPassword() {
  if (!process.stdin.isTTY) {
    let data = ''
    for await (const chunk of process.stdin) data += chunk
    return data.replace(/\r?\n$/, '')
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  rl._writeToOutput = (s) => {
    if (s.startsWith('Password: ')) process.stdout.write(s)
  }
  const pw = await new Promise((resolve) => rl.question('Password: ', resolve))
  rl.close()
  process.stdout.write('\n')
  return pw
}

const pw = await readPassword()
const username = process.env.M12_USER || process.argv[2] || ''
const reason = rejectReason(pw, username)
if (reason) {
  console.error(`Weak password: it ${reason}.`)
  process.exit(1)
}
console.log(`M12_PASSWORD_HASH='${hashPassword(pw)}'`)
