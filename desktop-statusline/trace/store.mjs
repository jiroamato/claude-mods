// What the trace receiver keeps of each request Claude Code sends, from the
// OpenTelemetry log events it exports (`OTEL_LOG_RAW_API_BODIES`). Plain
// JavaScript with no imports, so Node runs it as it is and the plugin's tests
// load it too.
//
// One folder per session, under the trace root:
//
//   <session>/system-<hash>.json   a system prompt, its blocks as sent
//   <session>/tools-<hash>.json    a tool list, as sent
//   <session>/<seq>.json           one request: what it added, and its answer
//
// A request body carries the whole conversation, so a request's file keeps
// only the messages that follow the previous request of the same kind; the
// system prompt and the tools, which seldom change, are kept once each.

/**
 * What the receiver's `GET /health` answers, so the plugin can tell it from
 * another server, and an older receiver from this one (hooks/trace.ts keeps
 * the same text). Bumped whenever what the receiver serves changes.
 */
export const HEALTH = 'desktop-statusline trace receiver 9'

/** The events the receiver keeps; the others are left unread. */
export const KEPT_EVENTS = new Set(['api_request_body', 'api_request', 'api_response_body'])

/** A string's FNV-1a hash in hex: a name for content, not a guard against anyone. */
export function hashText(text) {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }

  return hash.toString(16).padStart(8, '0')
}

function attributeValue(value) {
  if (value === null || typeof value !== 'object') return value
  if ('stringValue' in value) return value.stringValue
  if ('intValue' in value) return Number(value.intValue)
  if ('doubleValue' in value) return value.doubleValue
  if ('boolValue' in value) return value.boolValue
  if ('arrayValue' in value) return (value.arrayValue.values ?? []).map(attributeValue)

  return undefined
}

/** The log records of an OTLP/JSON logs request, each as its attributes by key. */
export function logRecords(payload) {
  const records = []
  for (const resource of payload?.resourceLogs ?? []) {
    for (const scope of resource.scopeLogs ?? []) {
      for (const record of scope.logRecords ?? []) {
        const attributes = {}
        for (const one of record.attributes ?? []) attributes[one.key] = attributeValue(one.value)
        records.push(attributes)
      }
    }
  }

  return records
}

/** Whether a system block is the billing header alone, which every request carries. */
export function isBillingBlock(block) {
  return /^x-anthropic-billing-header:/.test(String(block?.text ?? ''))
}

/** A session id safe to name a folder by, or null for one that is not. */
export function sessionFolder(id) {
  return typeof id === 'string' && /^[A-Za-z0-9-]{1,80}$/.test(id) ? id : null
}

// How the pane and the pages read a session's requests back: a request
// keeps only what followed the one before it of its kind.

/**
 * The messages a request sent, whole: each request keeps only what followed
 * the previous one of its kind, so they are rebuilt from the first.
 */
export function fullMessages(records, seq) {
  const target = records.find(one => one.seq === seq)
  if (!target) return null
  let messages = []
  for (const record of [...records].sort((a, b) => a.seq - b.seq)) {
    if (record.source !== target.source) continue
    messages = goesOn(record, messages.length > 0)
      ? [...messages, ...record.added]
      : [...messages.slice(0, record.from), ...record.added]
    if (record.seq === seq) break
  }

  return messages
}

/** The main loop's requests, by the engine's name for where a request came from. */
export function isMain(source) {
  return source === 'sdk' || String(source).startsWith('repl_main_thread')
}

/**
 * Whether a request goes on from the one before, adding to its messages: the
 * receiver marks it so; one it kept before it knew to is a main request with
 * no tools whose messages start afresh.
 */
export function goesOn(record, hasBefore) {
  return (
    record.continues === true ||
    (hasBefore &&
      record.continues === undefined &&
      isMain(record.source) &&
      record.toolCount === 0 &&
      record.from === 0)
  )
}

/**
 * The request whose system prompt and tools a request was sent with: itself,
 * or for one that goes on from the one before, the last of its kind that
 * carried them.
 */
export function promptRecord(records, seq) {
  const target = records.find(one => one.seq === seq)
  if (!target) return null
  const before = records
    .filter(one => one.source === target.source && one.seq <= seq && one.toolCount > 0)
    .sort((a, b) => b.seq - a.seq)

  return target.toolCount > 0 ? target : (before[0] ?? target)
}

/** How many requests may wait for their usage or answer at once, per session. */
const MAX_WAITING = 200

function number(value) {
  const parsed = Number(value)

  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Keeps requests as their events arrive. `write(path, text)` stores a file
 * under the trace root; paths are `<session>/<name>`. `firstSeq(folder)` says
 * where a session already on disk goes on from, so a restarted receiver adds
 * to it rather than writing over it. `exists(path)` says whether a file is
 * still there, so one the person deleted is written again when next needed.
 */
export class TraceStore {
  constructor(write, firstSeq = () => 0, exists = () => true) {
    this.write = write
    this.firstSeq = firstSeq
    this.exists = exists
    /** Per session: the next request number, what was written, what waits. */
    this.sessions = new Map()
  }

  session(id) {
    let session = this.sessions.get(id)
    if (!session) {
      session = {
        next: this.firstSeq(id),
        written: new Set(),
        last: new Map(),
        byBody: new Map(),
        byRequestId: new Map(),
        /** Usage that came before its request's answer named it, by request id. */
        early: new Map(),
        waiting: [],
      }
      this.sessions.set(id, session)
    }

    return session
  }

  /** Takes one log record, as `logRecords` reads it. */
  take(attributes) {
    const name = attributes['event.name']
    if (!KEPT_EVENTS.has(name)) return
    const folder = sessionFolder(attributes['session.id'])
    if (!folder) return
    const session = this.session(folder)
    if (name === 'api_request_body') this.takeRequest(folder, session, attributes)
    else if (name === 'api_request') this.takeUsage(folder, session, attributes)
    else this.takeResponse(folder, session, attributes)
  }

  keep(folder, session, name, value) {
    if (session.written.has(name) && this.exists(`${folder}/${name}`)) return
    session.written.add(name)
    this.write(`${folder}/${name}`, JSON.stringify(value))
  }

  takeRequest(folder, session, attributes) {
    const source = String(attributes.query_source ?? 'unknown')
    let body
    try {
      body = JSON.parse(String(attributes.body ?? ''))
    } catch {
      body = null
    }
    if (!body || !Array.isArray(body.messages)) {
      // Cut short (a body longer than the export's limit) or not a request:
      // kept as a request that could not be read, so its usage and answer
      // still land on it and the numbering says nothing was lost.
      this.open(folder, session, attributes, {
        source,
        model: String(attributes.model ?? ''),
        system: null,
        tools: null,
        toolCount: 0,
        messageCount: 0,
        from: 0,
        continues: false,
        added: [],
        unreadable: String(attributes.body ?? '').length,
      })
      return
    }
    const system = Array.isArray(body.system)
      ? body.system
      : typeof body.system === 'string'
        ? [{ type: 'text', text: body.system }]
        : []
    const tools = Array.isArray(body.tools) ? body.tools : []
    const systemHash = hashText(JSON.stringify(system))
    const toolsHash = hashText(JSON.stringify(tools))
    this.keep(folder, session, `system-${systemHash}.json`, system)
    this.keep(folder, session, `tools-${toolsHash}.json`, tools)

    // The messages after what the previous request of this kind already sent.
    // A request that goes on from the one before (newer Claude Code sends the
    // system prompt and the tools once, then only the billing header, no tools
    // and the new messages, the API holding the rest) adds all it carries.
    const hashes = body.messages.map(message => hashText(JSON.stringify(message)))
    const before = session.last.get(source) ?? []
    const continues =
      before.length > 0 && tools.length === 0 && system.length > 0 && system.every(isBillingBlock)
    let from = 0
    if (continues) {
      from = before.length
      session.last.set(source, [...before, ...hashes])
    } else {
      while (from < before.length && from < hashes.length && before[from] === hashes[from])
        from += 1
      session.last.set(source, hashes)
    }

    this.open(folder, session, attributes, {
      source,
      model: String(body.model ?? attributes.model ?? ''),
      system: systemHash,
      tools: toolsHash,
      toolCount: tools.length,
      messageCount: body.messages.length,
      from,
      continues,
      added: continues ? body.messages : body.messages.slice(from),
    })
  }

  /** Numbers a request and keeps it, waiting for its usage and its answer. */
  open(folder, session, attributes, fields) {
    const record = {
      seq: session.next,
      at: String(attributes['event.timestamp'] ?? ''),
      promptId: attributes['prompt.id'] ?? null,
      bodyId: attributes.request_body_id ?? null,
      requestId: null,
      ...fields,
      usage: null,
      response: null,
    }
    session.next += 1
    if (record.bodyId) session.byBody.set(record.bodyId, record)
    session.waiting.push(record)
    // A request that never hears back (interrupted, failed and retried) goes
    // after a while, so the ones waiting stay few.
    while (session.waiting.length > MAX_WAITING) this.forget(session, session.waiting[0])
    this.save(folder, record)
  }

  // `api_request` (the usage) names no body, only the API's request id, which
  // the answer carries beside its body's id: the answer joins the two. Usage
  // that comes first waits for its answer; an engine whose usage names no
  // request id gets the oldest request of its kind still without usage.
  takeUsage(folder, session, attributes) {
    const usage = {
      input: number(attributes.input_tokens),
      output: number(attributes.output_tokens),
      cacheRead: number(attributes.cache_read_tokens),
      cacheWrite: number(attributes.cache_creation_tokens),
      costUsd: number(attributes.cost_usd),
      durationMs: number(attributes.duration_ms),
      effort: attributes.effort ?? null,
    }
    const requestId = attributes.request_id ? String(attributes.request_id) : null
    let record
    if (requestId) {
      record = session.byRequestId.get(requestId)
      if (!record) {
        session.early.set(requestId, usage)
        while (session.early.size > MAX_WAITING)
          session.early.delete(session.early.keys().next().value)
        return
      }
    } else {
      const source = String(attributes.query_source ?? 'unknown')
      record = session.waiting.find(one => one.source === source && one.usage === null)
      if (!record) return
    }
    record.usage = usage
    this.save(folder, record)
    this.settle(session, record)
  }

  takeResponse(folder, session, attributes) {
    const record = session.byBody.get(attributes.request_body_id)
    if (!record) return
    try {
      record.response = JSON.parse(String(attributes.body ?? ''))
    } catch {
      record.response = { unreadable: String(attributes.body ?? '').slice(0, 2000) }
    }
    const requestId = attributes.request_id ? String(attributes.request_id) : null
    if (requestId) {
      record.requestId = requestId
      session.byRequestId.set(requestId, record)
      const early = session.early.get(requestId)
      if (early && record.usage === null) {
        record.usage = early
        session.early.delete(requestId)
      }
    }
    this.save(folder, record)
    this.settle(session, record)
  }

  settle(session, record) {
    if (record.usage === null || record.response === null) return
    this.forget(session, record)
  }

  forget(session, record) {
    session.waiting = session.waiting.filter(one => one !== record)
    if (record.bodyId) session.byBody.delete(record.bodyId)
    if (record.requestId) session.byRequestId.delete(record.requestId)
  }

  save(folder, record) {
    this.write(`${folder}/${String(record.seq).padStart(6, '0')}.json`, JSON.stringify(record))
  }
}
