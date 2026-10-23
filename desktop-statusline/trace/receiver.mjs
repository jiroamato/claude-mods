import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import zlib from 'node:zlib'

import { HEALTH, logRecords, sessionFolder, TraceStore, withBilling } from './store.mjs'
import { promptRecord, requestPage, sessionPage } from './view.mjs'

const MAX_POST_BYTES = 64 * 1024 * 1024
const SESSION_IDLE_MS = 30 * 60 * 1000
const PRIVATE_FOLDER = 0o700
const PRIVATE_FILE = 0o600

const [root, portText] = process.argv.slice(2)
const port = Number(portText)
if (!root || !Number.isInteger(port)) {
  process.stderr.write('usage: node receiver.mjs <root> <port>\n')
  process.exit(2)
}
fs.mkdirSync(root, { recursive: true, mode: PRIVATE_FOLDER })
try {
  fs.chmodSync(root, PRIVATE_FOLDER)
} catch {}

process.on('uncaughtException', error => {
  process.stderr.write(`trace receiver: ${error?.stack ?? error}\n`)
})

let isListening = false

const store = new TraceStore(
  (name, text) => {
    const file = path.join(root, name)
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: PRIVATE_FOLDER })
    fs.writeFileSync(file, text, { mode: PRIVATE_FILE })
    if (isListening && !fs.existsSync(tokenFile)) writeToken()
  },
  folder => {
    try {
      const seqs = fs
        .readdirSync(path.join(root, folder))
        .map(name => /^(\d{6})\.json$/.exec(name)?.[1])
        .filter(Boolean)
        .map(Number)

      return seqs.length === 0 ? 0 : Math.max(...seqs) + 1
    } catch {
      return 0
    }
  },
  name => fs.existsSync(path.join(root, name)),
  folder => sessionRecords(folder) ?? [],
)

const tokenFile = path.join(root, '.view-token')
const token = (() => {
  try {
    const kept = fs.readFileSync(tokenFile, 'utf8').trim()
    if (/^[0-9a-f]{32}$/.test(kept)) return kept
  } catch {}

  return randomBytes(16).toString('hex')
})()
const link = (session, seq) => `/view/${session}${seq === undefined ? '' : `/${seq}`}?t=${token}`

function writeToken() {
  fs.mkdirSync(root, { recursive: true, mode: PRIVATE_FOLDER })
  fs.writeFileSync(tokenFile, token, { mode: PRIVATE_FILE })
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function sessionRecords(session) {
  const folder = path.join(root, session)
  if (!fs.existsSync(folder)) return null

  return fs
    .readdirSync(folder)
    .filter(name => /^\d{6}\.json$/.test(name))
    .map(name => readJson(path.join(folder, name)))
    .filter(Boolean)
}

function view(url, response) {
  try {
    page(url, response)
  } catch (error) {
    process.stderr.write(`trace receiver: ${error?.stack ?? error}\n`)
    if (!response.headersSent) response.writeHead(500)
    response.end()
  }
}

function page(url, response) {
  const match = /^\/view\/([^/]+)(?:\/(\d+))?$/.exec(url.pathname)
  const session = sessionFolder(match?.[1])
  const records = session ? sessionRecords(session) : null
  if (!records || url.searchParams.get('t') !== token) {
    response.writeHead(404)
    response.end()
    return
  }
  const nonce = randomBytes(16).toString('base64')
  let html
  if (match[2] === undefined) {
    html = sessionPage({ session, records, link, nonce })
  } else {
    const seq = Number(match[2])
    const record = records.find(one => one.seq === seq)
    const base = promptRecord(records, seq)
    html =
      record && base
        ? requestPage({
            session,
            records,
            seq,
            system: withBilling(
              record,
              readJson(path.join(root, session, `system-${base.system}.json`)),
            ),
            tools: readJson(path.join(root, session, `tools-${base.tools}.json`)),
            link,
            nonce,
          })
        : null
  }
  if (html === null) {
    response.writeHead(404)
    response.end()
    return
  }
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  })
  response.end(html)
}

function handle(request, response) {
  const host = request.headers.host ?? ''
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    response.writeHead(403)
    response.end()
    return
  }
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end(HEALTH)
    return
  }
  if (request.method === 'GET' && request.url?.startsWith('/view/')) {
    view(new URL(request.url, `http://${host}`), response)
    return
  }
  if (request.method === 'POST' && request.url === `/quit?t=${token}`) {
    response.writeHead(200)
    response.end()
    server.close()
    process.exit(0)
  }
  if (!String(request.headers['content-type'] ?? '').startsWith('application/json')) {
    response.writeHead(415)
    response.end()
    return
  }
  if (request.method !== 'POST' || request.url !== '/v1/logs') {
    response.writeHead(404)
    response.end()
    return
  }
  const chunks = []
  let size = 0
  request.on('data', chunk => {
    size += chunk.length
    if (size <= MAX_POST_BYTES) chunks.push(chunk)
  })
  request.on('end', () => {
    if (size > MAX_POST_BYTES) {
      process.stderr.write(`trace receiver: dropped a ${size}-byte export, over the limit\n`)
      response.writeHead(413)
      response.end()
      return
    }
    try {
      const raw = Buffer.concat(chunks)
      const encoding = String(request.headers['content-encoding'] ?? '').toLowerCase()
      const text = (
        encoding === 'gzip' ? zlib.gunzipSync(raw, { maxOutputLength: MAX_POST_BYTES }) : raw
      ).toString('utf8')
      for (const record of logRecords(JSON.parse(text))) {
        store.take(record)
      }
    } catch (error) {
      process.stderr.write(`trace receiver: an export could not be read: ${error}\n`)
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{}')
  })
}

const server = http.createServer(handle)
setInterval(() => store.prune(SESSION_IDLE_MS), SESSION_IDLE_MS / 10).unref()

server.on('error', error => {
  process.exit(error.code === 'EADDRINUSE' ? 0 : 1)
})
server.on('listening', () => {
  isListening = true
  writeToken()
  const v6 = http.createServer(handle)
  v6.on('error', () => undefined)
  v6.listen(port, '::1')
})
server.listen(port, '127.0.0.1')
