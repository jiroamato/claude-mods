// The trace receiver: a local OTLP/HTTP endpoint for Claude Code's log events,
// and the pages that show what it kept. The plugin starts it with Node (`node
// receiver.mjs <root> <port>`); one runs for every session on the machine, and
// a second start finds the port taken and leaves. It listens on the loopback
// address only, and its pages answer only with the token it writes beside the
// traces, which the plugin reads to link to them.

import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import { HEALTH, logRecords, sessionFolder, TraceStore } from './store.mjs'
import { promptRecord, requestPage, sessionPage } from './view.mjs'

/** The most one OTLP request may carry; a request body is a conversation. */
const MAX_POST_BYTES = 64 * 1024 * 1024
// A trace holds the whole conversation: on a system with other users, only
// the person reads it (Windows keeps a profile's folders to its owner already).
const PRIVATE_FOLDER = 0o700
const PRIVATE_FILE = 0o600

const [root, portText] = process.argv.slice(2)
const port = Number(portText)
if (!root || !Number.isInteger(port)) {
  process.stderr.write('usage: node receiver.mjs <root> <port>\n')
  process.exit(2)
}
// Every trace is kept until the person deletes it: the receiver deletes nothing.
fs.mkdirSync(root, { recursive: true, mode: PRIVATE_FOLDER })
// A folder made before, by an earlier receiver or the plugin, closed too: with
// it closed, nothing under it can be reached by another user.
try {
  fs.chmodSync(root, PRIVATE_FOLDER)
} catch {
  // Not the owner's to change, or a system without modes: left as it is.
}

// One page or record the receiver cannot handle is dropped, not the receiver
// every session's trace goes to.
process.on('uncaughtException', error => {
  process.stderr.write(`trace receiver: ${error?.stack ?? error}\n`)
})

/** Whether this receiver holds the port, and so owns the token file. */
let isListening = false

const store = new TraceStore(
  (name, text) => {
    const file = path.join(root, name)
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: PRIVATE_FOLDER })
    fs.writeFileSync(file, text, { mode: PRIVATE_FILE })
    // The person may have deleted the folder, token and all: the pane's links
    // need it back.
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

/**
 * What a page link carries, so no other page or program on the machine reads
 * the traces. Kept beside them and read again by the next receiver, so a link
 * the pane drew before a restart still opens.
 */
const tokenFile = path.join(root, '.view-token')
const token = (() => {
  try {
    const kept = fs.readFileSync(tokenFile, 'utf8').trim()
    if (/^[0-9a-f]{32}$/.test(kept)) return kept
  } catch {
    // None kept yet: this receiver makes the first.
  }

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

/** A session's requests as the store wrote them, or null for a session it never saw. */
function sessionRecords(session) {
  const folder = path.join(root, session)
  if (!fs.existsSync(folder)) return null

  return fs
    .readdirSync(folder)
    .filter(name => /^\d{6}\.json$/.test(name))
    .map(name => readJson(path.join(folder, name)))
    .filter(Boolean)
}

/** A page of the trace, or a plain 500 when a record holds what it cannot draw. */
function view(url, response) {
  try {
    page(url, response)
  } catch (error) {
    process.stderr.write(`trace receiver: ${error?.stack ?? error}\n`)
    if (!response.headersSent) response.writeHead(500)
    response.end()
  }
}

/** A page of the trace: the session's list, or one request whole. */
function page(url, response) {
  const match = /^\/view\/([^/]+)(?:\/(\d+))?$/.exec(url.pathname)
  const session = sessionFolder(match?.[1])
  const records = session ? sessionRecords(session) : null
  if (!records || url.searchParams.get('t') !== token) {
    response.writeHead(404)
    response.end()
    return
  }
  // The page's one script runs by a nonce made for this response alone: no
  // other script, inline or fetched, does.
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
            system: readJson(path.join(root, session, `system-${base.system}.json`)),
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
    // The token is in the address, and the page holds the whole conversation:
    // neither is handed to another site, nor kept by the browser.
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  })
  response.end(html)
}

function handle(request, response) {
  // Only this machine's own name for itself: a page elsewhere that points a
  // name of its own at 127.0.0.1 gets nothing.
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
  // A newer plugin replaces this receiver: it asks it to leave, with the token.
  if (request.method === 'POST' && request.url === `/quit?t=${token}`) {
    response.writeHead(200)
    response.end()
    server.close()
    process.exit(0)
  }
  // Claude Code sends JSON; a page elsewhere cannot, without asking first.
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
      for (const record of logRecords(JSON.parse(Buffer.concat(chunks).toString('utf8')))) {
        store.take(record)
      }
    } catch (error) {
      // Not OTLP/JSON, or not ours: answered as heard, and dropped.
      process.stderr.write(`trace receiver: an export could not be read: ${error}\n`)
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{}')
  })
}

const server = http.createServer(handle)

server.on('error', error => {
  // Another receiver holds the port already: that one serves this session too.
  process.exit(error.code === 'EADDRINUSE' ? 0 : 1)
})
// The token is written once the port is this receiver's, never over a running one's.
server.on('listening', () => {
  isListening = true
  writeToken()
  // A browser may reach `localhost` over IPv6 first: the pages answer there too.
  const v6 = http.createServer(handle)
  v6.on('error', () => undefined)
  v6.listen(port, '::1')
})
server.listen(port, '127.0.0.1')
