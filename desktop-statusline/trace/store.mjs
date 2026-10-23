export const HEALTH = 'desktop-statusline trace receiver 12'

const KEPT_EVENTS = new Set(['api_request_body', 'api_request', 'api_response_body'])

function hashText(text) {
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

function isBillingBlock(block) {
  return /^x-anthropic-billing-header:/.test(String(block?.text ?? ''))
}

export function withBilling(record, blocks) {
  const billing = Array.isArray(record?.billing) ? record.billing : []

  return [...billing.map(text => ({ type: 'text', text })), ...(blocks ?? [])]
}

export function sessionFolder(id) {
  return typeof id === 'string' && /^[A-Za-z0-9-]{1,80}$/.test(id) ? id : null
}

export function isMain(source) {
  return source === 'sdk' || String(source).startsWith('repl_main_thread')
}

function sourceKind(source) {
  return isMain(source) ? 'main' : String(source)
}

export function fullMessages(records, seq) {
  const target = records.find(one => one.seq === seq)
  if (!target) return null
  const kind = sourceKind(target.source)
  const named = new Set(records.map(one => one.after).filter(after => typeof after === 'number'))
  const chains = new Map()
  let messages = []
  let previous = null
  for (const record of [...records].sort((a, b) => a.seq - b.seq)) {
    if (sourceKind(record.source) !== kind) continue
    if (record.unreadable !== undefined) {
      if (record.seq === seq) return []
      continue
    }
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

function chainOf(records, record) {
  const answer = answerMessage(record)

  return {
    seq: record.seq,
    hashes: [...(fullMessages(records, record.seq) ?? []), ...(answer ? [answer] : [])].map(
      hashMessage,
    ),
  }
}

function answerMessage(record) {
  const content = record?.response?.content

  return Array.isArray(content) ? { role: 'assistant', content } : null
}

function withAnswer(messages, record, from) {
  const answer = answerMessage(record)

  return answer && from > messages.length ? [...messages, answer] : messages
}

export const HEAD_AFTER_BYTES = 3 * 1024 * 1024

const MAX_HEAD_ANSWER_BYTES = 1024 * 1024

function tooLargeNote(seq) {
  return `(Not shown: request #${seq + 1} is too large to read here. Open it in your browser.)`
}

export function headMessages(record) {
  const count = Math.max(0, (record.messageCount ?? 0) - (record.from ?? 0))
  const roles = Array.isArray(record.roles) ? record.roles : []

  return Array.from({ length: count }, (_, index) => ({
    role: typeof roles[index] === 'string' ? roles[index] : 'user',
    content: tooLargeNote(record.seq),
  }))
}

function headOf(record) {
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

function utf8Length(text) {
  let bytes = text.length
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0x80) bytes += code < 0x800 || (code >= 0xd800 && code < 0xe000) ? 1 : 2
  }

  return bytes
}

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

const MAX_WAITING = 200

const MAX_CHAINS = 200

function withoutCacheControl(key, value) {
  return key === 'cache_control' ? undefined : value
}

function hashMessage(message) {
  return hashText(JSON.stringify(message, withoutCacheControl))
}

function endsWith(list, tail) {
  if (tail.length > list.length) return false

  return tail.every((hash, index) => list[list.length - tail.length + index] === hash)
}

function remember(map, key, value) {
  map.delete(key)
  map.set(key, value)
  while (map.size > MAX_CHAINS) map.delete(map.keys().next().value)
}

function number(value) {
  const parsed = Number(value)

  return Number.isFinite(parsed) ? parsed : undefined
}

export class TraceStore {
  constructor(write, firstSeq = () => 0, exists = () => true, read = () => [], now = Date.now) {
    this.write = write
    this.firstSeq = firstSeq
    this.exists = exists
    this.read = read
    this.now = now
    this.sessions = new Map()
  }

  prune(idleMs) {
    const before = this.now() - idleMs
    for (const [id, session] of this.sessions) {
      if (session.touched < before) this.sessions.delete(id)
    }
  }

  session(id) {
    let session = this.sessions.get(id)
    if (!session) {
      session = {
        next: this.firstSeq(id),
        written: new Set(),
        last: new Map(),
        chains: new Map(),
        byMessageId: new Map(),
        byBody: new Map(),
        byRequestId: new Map(),
        early: new Map(),
        waiting: [],
        touched: this.now(),
      }
      this.sessions.set(id, session)
    }
    session.touched = this.now()

    return session
  }

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
      const isWithheld =
        attributes.body_withheld === true ||
        attributes.body_withheld === 'true' ||
        typeof body?.not_recorded === 'string'
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
        ...(isWithheld ? { withheld: true } : {}),
      })
      return
    }
    const sent = Array.isArray(body.system)
      ? body.system
      : typeof body.system === 'string'
        ? [{ type: 'text', text: body.system }]
        : []
    const billing = sent.filter(isBillingBlock).map(block => String(block.text))
    const system = sent.filter(block => !isBillingBlock(block))
    const tools = Array.isArray(body.tools) ? body.tools : []
    const systemHash = hashText(JSON.stringify(system, withoutCacheControl))
    const toolsHash = hashText(JSON.stringify(tools, withoutCacheControl))
    this.keep(folder, session, `system-${systemHash}.json`, system)
    this.keep(folder, session, `tools-${toolsHash}.json`, tools)

    const kind = sourceKind(source)
    const hashes = body.messages.map(hashMessage)
    const thread = body.thread !== null && typeof body.thread === 'object' ? body.thread : null
    const isContinuation = thread
      ? thread.type === 'continue'
      : tools.length === 0 && system.length === 0 && billing.length > 0
    const previous =
      typeof thread?.previous_message_id === 'string' ? thread.previous_message_id : null
    const base = isContinuation ? this.chainBefore(folder, session, kind, previous) : null
    let continues = false
    let after = null
    let from = 0
    let chain
    let added = body.messages
    if (base && !base.named && endsWith(base.hashes, hashes)) {
      from = base.hashes.length - hashes.length
      chain = base.hashes
    } else if (base || (isContinuation && kind === 'main')) {
      continues = true
      after = base?.seq ?? null
      from = base?.hashes.length ?? 0
      chain = [...(base?.hashes ?? []), ...hashes]
    } else {
      const before = (session.last.get(kind) ?? this.keptChain(folder, kind))?.hashes ?? []
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
      billing,
      toolCount: tools.length,
      messageCount: chain.length,
      from,
      continues,
      after,
      added,
    })
  }

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

    return { ...chainOf(records, record), named: named !== undefined }
  }

  keptChain(folder, kind) {
    const records = this.kept(folder, kind)
    const record = records.at(-1)

    return record ? chainOf(records, record) : null
  }

  kept(folder, kind) {
    try {
      return this.read(folder)
        .filter(one => sourceKind(one.source) === kind && one.unreadable === undefined)
        .sort((a, b) => a.seq - b.seq)
    } catch {
      return []
    }
  }

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
    while (session.waiting.length > MAX_WAITING) this.forget(session, session.waiting[0])
    this.save(folder, record)
  }

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

  answered(session, record) {
    const answer = answerMessage(record)
    if (!answer) return
    const kind = sourceKind(record.source)
    const known = session.chains.get(record.seq)
    const last = session.last.get(kind)
    const hashes = known?.hashes ?? (last?.seq === record.seq ? last.hashes : null)
    if (!hashes) return
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

  save(folder, record) {
    const name = `${folder}/${String(record.seq).padStart(6, '0')}`
    const text = JSON.stringify(record)
    if (text.length > HEAD_AFTER_BYTES / 3 && utf8Length(text) > HEAD_AFTER_BYTES)
      this.write(`${name}.head.json`, JSON.stringify(headOf(record)))
    this.write(`${name}.json`, text)
  }
}
