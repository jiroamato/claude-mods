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
export const HEALTH = 'desktop-statusline trace receiver 5'

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

function number(value) {
  const parsed = Number(value)

  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Keeps requests as their events arrive. `write(path, text)` stores a file
 * under the trace root; paths are `<session>/<name>`. `firstSeq(folder)` says
 * where a session already on disk goes on from, so a restarted receiver adds
 * to it rather than writing over it.
 */
export class TraceStore {
  constructor(write, firstSeq = () => 0) {
    this.write = write
    this.firstSeq = firstSeq
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
    if (session.written.has(name)) return
    session.written.add(name)
    this.write(`${folder}/${name}`, JSON.stringify(value))
  }

  takeRequest(folder, session, attributes) {
    let body
    try {
      body = JSON.parse(String(attributes.body ?? ''))
    } catch {
      return
    }
    if (!body || !Array.isArray(body.messages)) return
    const source = String(attributes.query_source ?? 'unknown')
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
    const continues = before.length > 0 && tools.length === 0 && system.every(isBillingBlock)
    let from = 0
    if (continues) {
      from = before.length
      session.last.set(source, [...before, ...hashes])
    } else {
      while (from < before.length && from < hashes.length && before[from] === hashes[from])
        from += 1
      session.last.set(source, hashes)
    }

    const record = {
      seq: session.next,
      at: String(attributes['event.timestamp'] ?? ''),
      source,
      model: String(body.model ?? attributes.model ?? ''),
      promptId: attributes['prompt.id'] ?? null,
      bodyId: attributes.request_body_id ?? null,
      system: systemHash,
      tools: toolsHash,
      toolCount: tools.length,
      messageCount: body.messages.length,
      from,
      continues,
      added: continues ? body.messages : body.messages.slice(from),
      usage: null,
      response: null,
    }
    session.next += 1
    if (record.bodyId) session.byBody.set(record.bodyId, record)
    session.waiting.push(record)
    this.save(folder, record)
  }

  // `api_request` names no body: it is the oldest request of its kind still
  // without usage, as the engine sends the two in the order it made them.
  takeUsage(folder, session, attributes) {
    const source = String(attributes.query_source ?? 'unknown')
    const record = session.waiting.find(one => one.source === source && one.usage === null)
    if (!record) return
    record.usage = {
      input: number(attributes.input_tokens),
      output: number(attributes.output_tokens),
      cacheRead: number(attributes.cache_read_tokens),
      cacheWrite: number(attributes.cache_creation_tokens),
      costUsd: number(attributes.cost_usd),
      durationMs: number(attributes.duration_ms),
      effort: attributes.effort ?? null,
    }
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
    this.save(folder, record)
    this.settle(session, record)
  }

  settle(session, record) {
    if (record.usage === null || record.response === null) return
    session.waiting = session.waiting.filter(one => one !== record)
    if (record.bodyId) session.byBody.delete(record.bodyId)
  }

  save(folder, record) {
    this.write(`${folder}/${String(record.seq).padStart(6, '0')}.json`, JSON.stringify(record))
  }
}
