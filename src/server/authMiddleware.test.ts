import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createHttpServer, request, type IncomingMessage, type Server } from 'node:http'
import { WebSocket } from 'ws'
import { createAuthSession } from './authMiddleware.js'
import { createServer, type ServerInstance } from './httpServer.js'

const isolated = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:os')>()
  return { ...original, homedir: () => isolated.home }
})

const password = 'test-password-not-a-real-secret'
const token = 'a'.repeat(64)
const addresses = ['127.0.0.1', '::1', '::ffff:127.0.0.1', '100.101.125.16', '::ffff:100.101.125.16', 'fd7a:115c:a1e0::1', '203.0.113.5']
let server: Server | undefined
let instance: ServerInstance | undefined
let port = 0

beforeEach(() => {
  if (process.env.CODEX_HOME) throw new Error('Run these tests with CODEX_HOME unset to keep session storage isolated')
  isolated.home = mkdtempSync(join(tmpdir(), 'codexui-auth-test-'))
  mkdirSync(join(isolated.home, '.codex'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  instance?.dispose()
  instance = undefined
  if (server) {
    const active = server
    server = undefined
    await new Promise<void>((resolve, reject) => active.close((error) => error ? reject(error) : resolve()))
  }
  rmSync(isolated.home, { recursive: true, force: true })
})

function saveSession(expiresAt: number) {
  writeFileSync(join(isolated.home, '.codex', 'webui-auth-sessions.json'), JSON.stringify({ tokens: [{ value: token, expiresAt }] }))
}

function incoming(remoteAddress: string, cookie?: string): IncomingMessage {
  return { socket: { remoteAddress }, headers: { host: 'localhost:5900', cookie } } as IncomingMessage
}

async function startServer() {
  instance = createServer({ password })
  server = createHttpServer(instance.app)
  instance.attachWebSocket(server)
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
}

function http(path: string, options: { method?: string, cookie?: string, body?: string, host?: string } = {}) {
  return new Promise<{ status: number, body: string, cookie?: string }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: {
      Host: options.host ?? `localhost:${port}`,
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    } }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode!, body, cookie: res.headers['set-cookie']?.[0]?.split(';')[0] }))
    })
    req.on('error', reject)
    req.end(options.body)
  })
}

function websocket(cookie?: string) {
  return new Promise<{ status: number, message?: string }>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/codex-api/ws`, { headers: { Host: `localhost:${port}`, ...(cookie ? { Cookie: cookie } : {}) } })
    ws.on('unexpected-response', (_req, res) => { res.resume(); resolve({ status: res.statusCode! }) })
    ws.on('error', reject)
    ws.once('message', (data) => {
      const message = String(data)
      ws.once('close', () => resolve({ status: 101, message }))
      ws.close()
    })
  })
}

describe('mandatory password regardless of source address', () => {
  for (const remote of addresses) {
    it.each([undefined, 'portal_session=forged'])('rejects %s from ' + remote, (cookie) => {
      expect(createAuthSession(password).isRequestAuthorized(incoming(remote, cookie))).toBe(false)
    })
    it('rejects expired cookie from ' + remote, () => {
      saveSession(Date.now() - 1000)
      expect(createAuthSession(password).isRequestAuthorized(incoming(remote, `portal_session=${token}`))).toBe(false)
    })
    it('accepts valid cookie from ' + remote, () => {
      saveSession(Date.now() + 60000)
      expect(createAuthSession(password).isRequestAuthorized(incoming(remote, `portal_session=${token}`))).toBe(true)
    })
  }

  it('checks expiry at request time', () => {
    const now = Date.now()
    saveSession(now + 1000)
    const auth = createAuthSession(password)
    vi.spyOn(Date, 'now').mockReturnValue(now + 1001)
    expect(auth.isRequestAuthorized(incoming('127.0.0.1', `portal_session=${token}`))).toBe(false)
  })
})

describe('real production HTTP and WebSocket routes', () => {
  it('serves login instead of protected file route for localhost and Tailscale Host', async () => {
    await startServer()
    for (const host of [`localhost:${port}`, `100.101.125.16:${port}`]) {
      const res = await http('/codex-local-file', { host })
      expect(res.status).toBe(200)
      expect(res.body).toContain('autocomplete="current-password"')
    }
  })

  it('rejects wrong password and malformed login', async () => {
    await startServer()
    const wrong = await http('/auth/login', { method: 'POST', body: JSON.stringify({ password: 'wrong' }) })
    expect(wrong.status).toBe(401)
    expect(wrong.cookie).toBeUndefined()
    expect((await http('/auth/login', { method: 'POST', body: '{' })).status).toBe(400)
  })

  it('rejects unauthenticated and forged WebSocket sessions', async () => {
    await startServer()
    expect((await websocket()).status).toBe(401)
    expect((await websocket('portal_session=forged')).status).toBe(401)
  })

  it('password login permits HTTP and WebSocket, persisting the session', async () => {
    await startServer()
    const login = await http('/auth/login', { method: 'POST', body: JSON.stringify({ password }) })
    expect(login.status).toBe(200)
    expect(JSON.parse(login.body)).toEqual({ ok: true })
    expect(login.cookie).toMatch(/^portal_session=[a-f0-9]{64}$/)
    const protectedRoute = await http('/codex-local-file', { cookie: login.cookie })
    expect(protectedRoute.status).toBe(400)
    expect(JSON.parse(protectedRoute.body)).toEqual({ error: 'Expected absolute local file path.' })
    const ws = await websocket(login.cookie)
    expect(ws.status).toBe(101)
    expect(JSON.parse(ws.message!).method).toBe('ready')
    expect(createAuthSession(password).isRequestAuthorized(incoming('100.101.125.16', login.cookie))).toBe(true)
  })

  it('expired sessions cannot reach protected HTTP or WebSocket routes', async () => {
    saveSession(Date.now() - 1000)
    await startServer()
    const cookie = `portal_session=${token}`
    expect((await http('/codex-local-file', { cookie })).body).toContain('autocomplete="current-password"')
    expect((await websocket(cookie)).status).toBe(401)
  })
})
