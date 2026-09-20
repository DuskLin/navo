import {
  createServer as httpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http'
import { createServer as httpsServer } from 'node:https'
import { createHash, randomBytes, timingSafeEqual, X509Certificate } from 'node:crypto'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { generate } from 'selfsigned'
import type { DashboardSettings, DashboardSnapshot, DashboardState } from '../../shared/dashboard'
import type { SecretCodec } from './gateway-store'
import { isPrivateIPv4, lanAddresses } from './lan-addresses'
import { DashboardTunnel, tunnelCredentials } from './dashboard-tunnel'
import { DashboardPublicCheck } from './dashboard-public-check'

const cookieName = '__Host-navo_dashboard'
const sessionMs = 8 * 3600000
const hash = (s: string) => createHash('sha256').update(s).digest()
const defaultSettings: DashboardSettings = {
  enabled: false,
  lan: false,
  port: 61948,
  tunnelMode: 'off',
  hostname: ''
}
export function validateDashboard(value: unknown): DashboardSettings & { token?: string } {
  const v = value as Record<string, unknown>
  if (
    !v ||
    typeof v !== 'object' ||
    typeof v.enabled !== 'boolean' ||
    typeof v.lan !== 'boolean' ||
    !Number.isInteger(v.port) ||
    Number(v.port) < 1024 ||
    Number(v.port) > 65534 ||
    !['off', 'quick', 'named'].includes(String(v.tunnelMode))
  )
    throw new Error('仪表盘设置无效')
  const hostname = String(v.hostname ?? '')
    .trim()
    .toLowerCase()
  if (
    hostname &&
    (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname) ||
      /\.(localhost|local|internal)$/.test(hostname))
  )
    throw new Error('请填写有效的公网域名，不包含协议或路径')
  if (v.tunnelMode === 'named' && !hostname) throw new Error('固定域名不能为空')
  if (
    v.token !== undefined &&
    (typeof v.token !== 'string' || v.token.length > 16384 || /\s/.test(v.token))
  )
    throw new Error('Tunnel 凭证格式无效')
  return {
    enabled: v.enabled,
    lan: v.lan,
    port: Number(v.port),
    tunnelMode: v.tunnelMode as DashboardSettings['tunnelMode'],
    hostname,
    ...(v.token ? { token: v.token as string } : {})
  }
}

export class DashboardServer {
  private settings = { ...defaultSettings }
  private password = randomBytes(32).toString('base64url')
  private token = ''
  private certificate?: { cert: string; key: string }
  private tls?: Server
  private origin?: Server
  private sessions = new Map<string, { expires: number; origin: string }>()
  private limits = new Map<string, { count: number; until: number }>()
  private transition: Promise<unknown> = Promise.resolve()
  private error = ''
  readonly tunnel: DashboardTunnel
  private check?: DashboardPublicCheck
  constructor(
    private options: {
      file: string
      assets: string
      binary: string
      codec: SecretCodec
      source: (account?: string) => Promise<DashboardSnapshot>
      publicRequest?: typeof fetch
    }
  ) {
    this.tunnel = new DashboardTunnel(
      options.binary,
      join(dirname(options.file), 'dashboard-tunnel'),
      () => this.check?.configure(this.tunnel.url, this.tunnel.state === 'connected')
    )
    this.check = new DashboardPublicCheck(options.publicRequest ?? fetch)
  }
  async load() {
    await this.tunnel.cleanup()
    try {
      const saved = JSON.parse(await readFile(this.options.file, 'utf8'))
      this.settings = validateDashboard(saved.settings)
      this.password = this.options.codec.decrypt(saved.password)
      this.token = saved.token ? this.options.codec.decrypt(saved.token) : ''
      this.certificate = saved.certificate
        ? JSON.parse(this.options.codec.decrypt(saved.certificate))
        : undefined
      if (!/^[A-Za-z0-9_-]{43}$/.test(this.password)) throw new Error('仪表盘访问码无效')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('无法读取仪表盘安全配置，请检查系统钥匙串')
    }
    if (this.settings.enabled) {
      try {
        await this.start()
      } catch {
        this.error = '仪表盘启动失败，请检查端口或安全存储。'
      }
    }
  }
  private async persist() {
    await mkdir(dirname(this.options.file), { recursive: true })
    const next = `${this.options.file}.tmp`
    await writeFile(
      next,
      JSON.stringify({
        settings: this.settings,
        password: this.options.codec.encrypt(this.password),
        token: this.token ? this.options.codec.encrypt(this.token) : '',
        certificate: this.certificate
          ? this.options.codec.encrypt(JSON.stringify(this.certificate))
          : ''
      }),
      { mode: 0o600 }
    )
    await rename(next, this.options.file)
  }
  private accessUrl(base: string) {
    if (!base) return ''
    const url = new URL(base)
    url.hash = new URLSearchParams({ code: this.password }).toString()
    return url.href
  }
  state(): DashboardState {
    return {
      publicCheck: { ...this.check!.state },
      settings: { ...this.settings },
      running: !!this.tls?.listening,
      localUrl: this.accessUrl(`https://localhost:${this.settings.port}`),
      lanUrls:
        this.settings.lan && this.tls?.listening
          ? lanAddresses().map((ip) => this.accessUrl(`https://${ip}:${this.settings.port}`))
          : [],
      publicUrl: this.accessUrl(this.tunnel.url),
      tunnelOrigin: `http://127.0.0.1:${this.settings.port + 1}`,
      tunnel: this.tunnel.state,
      error: this.error || this.tunnel.error,
      fingerprint: this.certificate
        ? new X509Certificate(this.certificate.cert).fingerprint256
        : '',
      hasTunnelToken: !!this.token
    }
  }
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const work = this.transition.then(fn)
    this.transition = work.catch(() => {})
    return work
  }
  save(value: unknown) {
    return this.exclusive(async () => {
      const next = validateDashboard(value)
      if (next.tunnelMode === 'named' && !next.token && !this.token)
        throw new Error('请填写 Cloudflare Tunnel 凭证')
      if (next.tunnelMode === 'named') tunnelCredentials(next.token || this.token)
      await this.stop()
      const { token, ...settings } = next
      this.settings = settings
      if (token) this.token = token
      await this.persist()
      if (settings.enabled) {
        try {
          await this.start()
        } catch {
          this.error = '仪表盘启动失败，端口可能已被占用。'
          await this.stop()
        }
      }
      return this.state()
    })
  }
  accessCode() {
    return this.password
  }
  async checkPublic() {
    await this.check?.check()
    return this.state()
  }
  rotate() {
    return this.exclusive(async () => {
      this.password = randomBytes(32).toString('base64url')
      this.sessions.clear()
      await this.persist()
      return this.state()
    })
  }
  close() {
    return this.exclusive(() => this.stop())
  }
  private async start() {
    this.error = ''
    const ips = ['127.0.0.1', ...lanAddresses()]
    const current = this.certificate && new X509Certificate(this.certificate.cert)
    if (
      !current ||
      Date.parse(current.validTo) < Date.now() + 86400000 ||
      ips.some((ip) => !current.checkIP(ip))
    ) {
      const pems = await generate([{ name: 'commonName', value: 'Navo local dashboard' }], {
        keyType: 'ec',
        curve: 'P-256',
        algorithm: 'sha256',
        notAfterDate: new Date(Date.now() + 365 * 86400000),
        extensions: [
          { name: 'basicConstraints', cA: false },
          { name: 'keyUsage', digitalSignature: true },
          { name: 'extKeyUsage', serverAuth: true },
          {
            name: 'subjectAltName',
            altNames: [
              { type: 2, value: 'localhost' },
              ...ips.map((ip) => ({ type: 7 as const, ip }))
            ]
          }
        ]
      })
      this.certificate = { cert: pems.cert, key: pems.private }
    }
    await this.persist()
    this.tls = httpsServer(this.certificate!, (req, res) => {
      void this.handle(req, res, false)
    })
    this.origin = httpServer((req, res) => {
      void this.handle(req, res, true)
    })
    try {
      await this.listen(this.tls, this.settings.port, this.settings.lan ? '0.0.0.0' : '127.0.0.1')
      // A distinct loopback-only origin prevents the tunnel from ever reaching the inference gateway.
      await this.listen(this.origin, this.settings.port + 1, '127.0.0.1')
      await this.tunnel.start(this.settings, this.state().tunnelOrigin, this.token)
    } catch (error) {
      await this.stop()
      throw error
    }
  }
  private async listen(server: Server, port: number, host: string) {
    server.maxConnections = 128
    server.headersTimeout = 10000
    server.requestTimeout = 15000
    server.keepAliveTimeout = 5000
    server.on('clientError', (_error, socket) => socket.destroy())
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.off('error', reject)
        resolve()
      })
    })
    server.on('error', () => {
      this.error = '仪表盘监听异常，请重新启用。'
    })
  }
  private async stop() {
    this.check?.close()
    await this.tunnel.stop()
    this.sessions.clear()
    for (const server of [this.tls, this.origin])
      if (server)
        await new Promise<void>((resolve) => {
          server.close(() => resolve())
          server.closeAllConnections()
        })
    this.tls = undefined
    this.origin = undefined
  }
  private allowed(key: string, maximum: number, duration: number) {
    const now = Date.now()
    for (const [k, v] of this.limits) if (v.until < now) this.limits.delete(k)
    if (this.limits.size >= 2048 && !this.limits.has(key)) return false
    const entry = this.limits.get(key) ?? { count: 0, until: now + duration }
    this.limits.set(key, entry)
    return ++entry.count <= maximum
  }
  private async handle(req: IncomingMessage, res: ServerResponse, tunnel: boolean) {
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(value))
    }
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'"
    )
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    try {
      const remote = req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? ''
      if (!tunnel && remote !== '127.0.0.1' && remote !== '::1' && !isPrivateIPv4(remote))
        return send(403, { error: '仅允许局域网访问' })
      const host = req.headers.host ?? ''
      const hosts = tunnel
        ? [this.tunnel.url ? new URL(this.tunnel.url).host : '']
        : ['localhost', '127.0.0.1', ...(this.settings.lan ? lanAddresses() : [])].map(
            (h) => `${h}:${this.settings.port}`
          )
      if (
        !host ||
        !hosts.includes(host) ||
        (tunnel && (remote !== '127.0.0.1' || req.headers['x-forwarded-proto'] !== 'https'))
      )
        return send(403, { error: '访问来源无效' })
      const origin = `https://${host}`
      if (req.headers.origin && req.headers.origin !== origin)
        return send(403, { error: '跨站请求被拒绝' })
      if (req.headers['sec-fetch-site'] === 'cross-site' && (req.url ?? '').startsWith('/api/'))
        return send(403, { error: '跨站请求被拒绝' })
      const url = new URL(req.url ?? '/', origin)
      const address = tunnel
        ? String(req.headers['cf-connecting-ip'] ?? remote).slice(0, 64)
        : remote
      if (url.pathname === '/api/login' && req.method === 'POST') {
        if (req.headers.origin !== origin || req.headers['content-type'] !== 'application/json')
          return send(403, { error: '登录来源无效' })
        if (
          !this.allowed(`login:${address}`, 8, 900000) ||
          !this.allowed('login:global', 60, 900000)
        ) {
          res.setHeader('Retry-After', '900')
          return send(429, { error: '尝试过多，请 15 分钟后重试' })
        }
        let body = ''
        for await (const chunk of req) {
          body += chunk.toString()
          if (Buffer.byteLength(body) > 2048) return send(413, { error: '请求过大' })
        }
        const code = JSON.parse(body).code
        if (typeof code !== 'string' || !timingSafeEqual(hash(code), hash(this.password)))
          return send(401, { error: '访问码不正确' })
        const now = Date.now()
        for (const [k, s] of this.sessions) if (s.expires < now) this.sessions.delete(k)
        if (this.sessions.size >= 64) this.sessions.delete(this.sessions.keys().next().value!)
        const session = randomBytes(32).toString('base64url')
        this.sessions.set(hash(session).toString('hex'), { expires: now + sessionMs, origin })
        res.setHeader(
          'Set-Cookie',
          `${cookieName}=${session}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${sessionMs / 1000}`
        )
        return send(200, { ok: true })
      }
      if (url.pathname.startsWith('/api/')) {
        const id =
          req.headers.cookie
            ?.split(';')
            .map((s) => s.trim())
            .find((s) => s.startsWith(`${cookieName}=`))
            ?.slice(cookieName.length + 1) ?? ''
        const key = hash(id).toString('hex'),
          session = this.sessions.get(key)
        if (!session || session.expires <= Date.now() || session.origin !== origin) {
          this.sessions.delete(key)
          return send(401, { error: '请登录仪表盘' })
        }
        if (!this.allowed(`api:${key}`, 120, 60000)) return send(429, { error: '请求过于频繁' })
        if (
          url.pathname === '/api/logout' &&
          req.method === 'POST' &&
          req.headers.origin === origin
        ) {
          this.sessions.delete(key)
          res.setHeader(
            'Set-Cookie',
            `${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
          )
          return send(200, { ok: true })
        }
        if (url.pathname === '/api/snapshot' && req.method === 'GET') {
          const account = url.searchParams.get('account') ?? ''
          if (account.length > 120) return send(400, { error: '账号无效' })
          return send(200, { ...(await this.options.source(account)), tunnel: this.tunnel.state })
        }
        return send(404, { error: '接口不存在' })
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { error: '不支持此操作' })
      const path =
        url.pathname === '/' || url.pathname === '/mobile.html'
          ? 'mobile.html'
          : /^\/assets\/[a-zA-Z0-9_.-]+\.(js|css|png|svg|woff2?)$/.test(url.pathname)
            ? url.pathname.slice(1)
            : ''
      if (!path) return send(404, { error: '页面不存在' })
      const file = await readFile(join(this.options.assets, path))
      const ext = path.split('.').pop()!
      const mime: Record<string, string> = {
        html: 'text/html; charset=utf-8',
        js: 'text/javascript',
        css: 'text/css',
        png: 'image/png',
        svg: 'image/svg+xml',
        woff: 'font/woff',
        woff2: 'font/woff2'
      }
      res.writeHead(200, { 'Content-Type': mime[ext], 'Content-Length': file.length })
      res.end(req.method === 'HEAD' ? undefined : file)
    } catch {
      if (!res.headersSent) send(503, { error: '数据暂时不可用，请稍后重试' })
      else res.end()
    }
  }
}
