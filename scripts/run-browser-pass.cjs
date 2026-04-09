const http = require('http')
const { spawn } = require('child_process')
const path = require('path')

const REPO_ROOT = path.resolve(__dirname, '..')
const BASE = process.env.BROWSER_PASS_BASE_URL || 'http://127.0.0.1:4173/'

function isServerReachable(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume()
      resolve(res.statusCode >= 200 && res.statusCode < 500)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(1000, () => {
      req.destroy()
      resolve(false)
    })
  })
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isServerReachable(url)) return true
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

function runBrowserPass() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['scripts/browser-pass.cjs'], {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: 'inherit',
    })
    child.on('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`browser pass exited with code ${code ?? 'null'} signal ${signal ?? 'none'}`))
    })
    child.on('error', reject)
  })
}

async function main() {
  let server = null
  const alreadyRunning = await isServerReachable(BASE)
  if (!alreadyRunning) {
    server = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '4173'], {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })

    const ready = await waitForServer(BASE, 30000)
    if (!ready) {
      server.kill('SIGTERM')
      throw new Error(`dev server did not start at ${BASE}`)
    }
  }

  try {
    await runBrowserPass()
  } finally {
    if (server) {
      server.kill('SIGTERM')
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
