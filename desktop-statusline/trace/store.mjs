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
//   <session>/<seq>.head.json      the same without its messages, for a large one
//
// A request body carries the whole conversation, so a request's file keeps
// only the messages that follow the previous request of the same kind, or,
// for one that goes on from an earlier request, the new messages and which
// request that was; the system prompt and the tools, which seldom change, are
// kept once each.

/**
 * What the receiver's `GET /health` answers, so the plugin can tell it from
 * another server, and an older receiver from this one (hooks/trace.ts keeps
 * the same text). Bumped whenever what the receiver serves changes.
 */
export const HEALTH = 'desktop-statusline trace receiver 11'

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

/** The main loop's requests, by the engine's name for where a request came from. */
export function isMain(source) {
  return source === 'sdk' || String(source).startsWith('repl_main_thread')
}

/**
 * Which conversation a request belongs to, by its source: the main loop's
 * sources are one (the CLI's names the output style, which `/output-style`
 * changes mid-session); any other source is its own.
 */
export function sourceKind(source) {
  return isMain(source) ? 'main' : String(source)
}

/**
 * The messages a request sent, whole: each request keeps only what followed
 * the previous one of its kind, so they are rebuilt from the first. One that
 * goes on from an earlier request it names (`after`) adds to that one's, and
 * to its answer, which no body carries: the API holds it.
 */
export function fullMessages(records, seq) {
  const target = records.find(one => one.seq === seq)
  if (!target) return null
  const kind = sourceKind(target.source)
  const named = new Set(records.map(one => one.after).filter(after => typeof after === 'number'))
  const chains = new Map()
  let messages = []
  /** The request `messages` are what it sent. */
  let previous = null
  for (const record of [...records].sort((a, b) => a.seq - b.seq)) {
    if (sourceKind(record.source) !== kind) continue
    // One that could not be read sent what is not known: the store diffed
    // the next against the one before it.
    if (record.unreadable !== undefined) {
      if (record.seq === seq) return []
      continue
    }
    // A head (a request too large for the pane) stands in for its messages.
    const added = record.isHead === true ? headMessages(record) : record.added
    if (goesOn(record, messages.length > 0)) {
      const base = chains.get(record.after) ?? { messages, record: previous }
      messages = [...withAnswer(base.messages, base.record, record.from), ...added]
    } else {
      messages = [...withAnswer(messages, previous, record.from).slice(0, record.from), ...added]
    }
    previous = record
    if (named.has(record.seq)) chains.set(record.seq, { messages, record })
    if (record.seq === seq) break
  }

  return messages
}

/** A request's answer as a message, as the conversation after it holds it; null for none. */
function answerMessage(record) {
  const content = record?.response?.content

  return Array.isArray(content) ? { role: 'assistant', content } : null
}

/**
 * A request's messages, and after them its answer where the store counted it.
 * The store counts an answer in the request's chain once it lands
 * (`TraceStore.answered`), so a request taken after that starts past it: its
 * `from` is one more than the messages before. One taken before it landed, or
 * kept by an older receiver, which counted none, starts at them, and gets none.
 */
function withAnswer(messages, record, from) {
  const answer = answerMessage(record)

  return answer && from > messages.length ? [...messages, answer] : messages
}

/**
 * What a request's file holds past which a head of it is kept beside it
 * (`<seq>.head.json`). The pane reads files with `$.fs.read`, which refuses
 * one over 4 MiB: the head, with the request's messages left out, is what it
 * reads instead. Below the limit by a margin, so the head is there before
 * the file grows past it, as its usage and answer land.
 */
export const HEAD_AFTER_BYTES = 3 * 1024 * 1024

/** The most of an answer a head keeps whole; one larger stands in as a note. */
const MAX_HEAD_ANSWER_BYTES = 1024 * 1024

/** What a placeholder message says, for a request too large to read where it is read. */
export function tooLargeNote(seq) {
  return `(Not shown: request #${seq + 1} is too large to read here. Open it in your browser.)`
}

/**
 * The messages a head stands in for, one placeholder each, so every request
 * after it keeps its place in the conversation. A request's messages are the
 * conversation's from `from` to `messageCount`: every way the store keeps one
 * (sent whole, going on from an earlier one, a body sent again) sets
 * `messageCount` to `from` and the messages it added.
 */
export function headMessages(record) {
  const count = Math.max(0, (record.messageCount ?? 0) - (record.from ?? 0))
  const roles = Array.isArray(record.roles) ? record.roles : []

  return Array.from({ length: count }, (_, index) => ({
    role: typeof roles[index] === 'string' ? roles[index] : 'user',
    content: tooLargeNote(record.seq),
  }))
}

/** A request's file without its messages, and its answer whole when that is small. */
export function headOf(record) {
  const response =
    record.response && utf8Length(JSON.stringify(record.response)) > MAX_HEAD_ANSWER_BYTES
      ? {
          id: record.response.id,
          stop_reason: record.response.stop_reason ?? null,
          content: [{ type: 'text', text: tooLargeNote(record.seq) }],
        }
      : record.response

  return {
    ...record,
    added: [],
    isHead: true,
    roles: record.added.map(message => String(message?.role ?? 'user')),
    response,
  }
}

/** How many bytes a string takes as UTF-8, as the receiver writes it. */
function utf8Length(text) {
  let bytes = text.length
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    // Two bytes below U+0800, three above; a surrogate pair four, two each.
    if (code >= 0x80) bytes += code < 0x800 || (code >= 0xd800 && code < 0xe000) ? 1 : 2
  }

  return bytes
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
 * or for one that goes on from an earlier one, the last before it in its
 * conversation that carried them. One that goes on sends the billing header
 * alone, and tools only when they changed: those tools are its own.
 */
export function promptRecord(records, seq) {
  const target = records.find(one => one.seq === seq)
  if (!target) return null
  const kind = sourceKind(target.source)
  const mine = records
    .filter(one => sourceKind(one.source) === kind && one.seq <= seq)
    .sort((a, b) => a.seq - b.seq)
  const at = new Map(mine.map((one, index) => [one.seq, index]))
  let tools = null
  let index = at.get(seq)
  while (index !== undefined && index >= 0) {
    const record = mine[index]
    if (tools === null && record.toolCount > 0) tools = record
    if (record.toolCount > 0 && record.continues !== true) {
      return tools === record
        ? record
        : { ...record, tools: tools.tools, toolCount: tools.toolCount }
    }
    const after = record.continues === true ? at.get(record.after) : undefined
    index = after !== undefined && after < index ? after : index - 1
  }

  return tools ?? target
}

/** How many requests may wait for their usage or answer at once, per session. */
const MAX_WAITING = 200

/**
 * How many requests' conversations, and answers' ids, are kept in memory per
 * session, for a request that goes on from one of them; an older one is read
 * back from the folder.
 */
const MAX_CHAINS = 200

function hashMessage(message) {
  return hashText(JSON.stringify(message))
}

/** Whether a list of hashes ends with another. */
function endsWith(list, tail) {
  if (tail.length > list.length) return false

  return tail.every((hash, index) => list[list.length - tail.length + index] === hash)
}

/** Sets a key in a map that keeps only its newest entries. */
function remember(map, key, value) {
  map.delete(key)
  map.set(key, value)
  while (map.size > MAX_CHAINS) map.delete(map.keys().next().value)
}

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
 * `read(folder)` gives back the requests a session has on disk, for one that
 * goes on from a request an earlier receiver kept.
 */
export class TraceStore {
  constructor(write, firstSeq = () => 0, exists = () => true, read = () => []) {
    this.write = write
    this.firstSeq = firstSeq
    this.exists = exists
    this.read = read
    /** Per session: the next request number, what was written, what waits. */
    this.sessions = new Map()
  }

  session(id) {
    let session = this.sessions.get(id)
    if (!session) {
      session = {
        next: this.firstSeq(id),
        written: new Set(),
        /** Per kind (`sourceKind`): the last request's number and its messages' hashes. */
        last: new Map(),
        /** Recent requests' messages' hashes and kind, by number. */
        chains: new Map(),
        /** Recent requests' numbers, by the API's id for their answer. */
        byMessageId: new Map(),
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
        after: null,
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

    // Newer Claude Code sends the system prompt and the tools once, then
    // bodies that name the answer they go on from (`thread.previous_message_id`)
    // and carry the billing header alone, tools only when they changed, and
    // the new messages, the API holding the rest. Told by the body alone, so
    // a receiver started mid-session tells it too; a body with no `thread` is
    // told by its shape.
    const kind = sourceKind(source)
    const hashes = body.messages.map(hashMessage)
    const thread = body.thread !== null && typeof body.thread === 'object' ? body.thread : null
    const isContinuation = thread
      ? thread.type === 'continue'
      : tools.length === 0 && system.length > 0 && system.every(isBillingBlock)
    const previous =
      typeof thread?.previous_message_id === 'string' ? thread.previous_message_id : null
    const base = isContinuation ? this.chainBefore(folder, session, kind, previous) : null
    let continues = false
    let after = null
    let from = 0
    let chain
    let added = body.messages
    if (base && !base.named && endsWith(base.hashes, hashes)) {
      // The same body again, the conversation already ending with it: kept
      // as one that sent the conversation whole, so it is not added twice.
      from = base.hashes.length - hashes.length
      chain = base.hashes
    } else if (base || (isContinuation && kind === 'main')) {
      // A main request goes on from the main requests before it even when
      // none is to be found here: the pages rebuild those from the folder.
      continues = true
      after = base?.seq ?? null
      from = base?.hashes.length ?? 0
      chain = [...(base?.hashes ?? []), ...hashes]
    } else {
      // The messages after what the previous request of this kind already sent.
      const before = session.last.get(kind)?.hashes ?? []
      while (from < before.length && from < hashes.length && before[from] === hashes[from])
        from += 1
      chain = hashes
      added = body.messages.slice(from)
    }
    session.last.set(kind, { seq: session.next, hashes: chain })
    remember(session.chains, session.next, { kind, hashes: chain })

    this.open(folder, session, attributes, {
      source,
      model: String(body.model ?? attributes.model ?? ''),
      system: systemHash,
      tools: toolsHash,
      toolCount: tools.length,
      // The conversation's length with this request's messages, not only theirs.
      messageCount: chain.length,
      from,
      continues,
      after,
      added,
    })
  }

  /**
   * The request one that goes on was sent after, with its messages' hashes:
   * the one whose answer it names, else, for the main loop, the last main
   * request. Read back from the folder only while this receiver has kept no
   * request of the kind (one started mid-session), so the folder is read once
   * per kind at most. `named` says it was found by its answer's id.
   *
   * Every subagent of a type shares one source, parallel ones interleave, and
   * the log record names no agent: so a subagent's request whose answer is not
   * to be found is not joined to the last of its source, which may be another
   * subagent's. It is kept as a conversation of its own.
   */
  chainBefore(folder, session, kind, previous) {
    if (previous !== null) {
      const seq = session.byMessageId.get(previous)
      const known = seq === undefined ? undefined : session.chains.get(seq)
      if (known?.kind === kind) return { seq, hashes: known.hashes, named: true }
    }
    const last = session.last.get(kind)
    if (last) return kind === 'main' ? { ...last, named: false } : null
    if (previous === null && kind !== 'main') return null
    const records = this.kept(folder, kind)
    const named =
      previous === null ? undefined : records.findLast(one => one.response?.id === previous)
    const record = named ?? (kind === 'main' ? records.at(-1) : undefined)
    if (!record) return null
    // Its answer counted as `answered` counts it, had this receiver kept it.
    const answer = answerMessage(record)

    return {
      seq: record.seq,
      hashes: [...(fullMessages(records, record.seq) ?? []), ...(answer ? [answer] : [])].map(
        hashMessage,
      ),
      named: named !== undefined,
    }
  }

  /** The requests of a kind a session has on disk, in order, those read whole. */
  kept(folder, kind) {
    try {
      return this.read(folder)
        .filter(one => sourceKind(one.source) === kind && one.unreadable === undefined)
        .sort((a, b) => a.seq - b.seq)
    } catch {
      return []
    }
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
    const isFirst = record.response === null
    try {
      record.response = JSON.parse(String(attributes.body ?? ''))
    } catch {
      record.response = { unreadable: String(attributes.body ?? '').slice(0, 2000) }
    }
    if (typeof record.response?.id === 'string')
      remember(session.byMessageId, record.response.id, record.seq)
    if (isFirst) this.answered(session, record)
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

  /**
   * Counts a request's answer in its chain, as the conversation after it
   * holds it, by its hash alone: a request that goes on from it starts past
   * it (`from`), and counts it in `messageCount`. Readers put the answer
   * there from the record's `response` (`withAnswer`).
   *
   * A whole body sent again after it carries the answer as Claude Code keeps
   * it, which may or may not be `{ role, content }` of the response exactly
   * (the API may add fields to a block, or Claude Code drop some). Where its
   * hash is the same, the diff against the chain goes on past it; where not,
   * `from` stops before it, the body's own copy is among the messages the
   * request added, and the readers' `messages.slice(0, from)` is still a
   * prefix of the conversation. Either way the rebuilt body is the one sent.
   */
  answered(session, record) {
    const answer = answerMessage(record)
    if (!answer) return
    const kind = sourceKind(record.source)
    const known = session.chains.get(record.seq)
    const last = session.last.get(kind)
    const hashes = known?.hashes ?? (last?.seq === record.seq ? last.hashes : null)
    if (!hashes) return
    // A new list: a body sent again shares its chain with the request before.
    const chain = [...hashes, hashMessage(answer)]
    if (known) session.chains.set(record.seq, { ...known, hashes: chain })
    if (last?.seq === record.seq) session.last.set(kind, { seq: record.seq, hashes: chain })
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

  /**
   * Writes a request's file, and past `HEAD_AFTER_BYTES` its head first, so
   * the head is there by the time the file is too large to read. A record
   * only grows (its usage and answer land on it), so once one has a head,
   * every later save writes it again: it stays in step, and is never removed.
   */
  save(folder, record) {
    const name = `${folder}/${String(record.seq).padStart(6, '0')}`
    const text = JSON.stringify(record)
    if (text.length > HEAD_AFTER_BYTES / 3 && utf8Length(text) > HEAD_AFTER_BYTES)
      this.write(`${name}.head.json`, JSON.stringify(headOf(record)))
    this.write(`${name}.json`, text)
  }
}
