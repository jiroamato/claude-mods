// The trace receiver's pages: a session's requests, and each request whole,
// as the model received it, for a browser on this machine. Plain JavaScript
// with no imports, like store.mjs, so Node runs it and the tests load it.

/** Text safe inside HTML. */
export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

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
    messages = [...messages.slice(0, record.from), ...record.added]
    if (record.seq === seq) break
  }

  return messages
}

function count(value) {
  return Number(value ?? 0).toLocaleString('en-US')
}

function blocksOf(content) {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : (content ?? [])
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return JSON.stringify(content, null, 2)

  return content
    .map(one => (one?.type === 'text' ? one.text : JSON.stringify(one, null, 2)))
    .join('\n\n')
}

function block(one) {
  switch (one.type) {
    case 'text':
      return `<pre>${escapeHtml(one.text ?? '')}</pre>`
    case 'thinking':
      return `<div class="kind">thinking</div><pre>${escapeHtml(one.thinking ?? '')}</pre>`
    case 'redacted_thinking':
      return '<div class="kind">thinking, redacted</div>'
    case 'tool_use':
      return `<div class="kind">tool call: ${escapeHtml(one.name)}</div><pre>${escapeHtml(JSON.stringify(one.input ?? {}, null, 2))}</pre>`
    case 'tool_result':
      return `<div class="kind">tool result${one.is_error ? ', an error' : ''}</div><pre>${escapeHtml(contentText(one.content))}</pre>`
    default:
      return `<div class="kind">${escapeHtml(one.type)}</div><pre>${escapeHtml(JSON.stringify(one, null, 2))}</pre>`
  }
}

function size(text) {
  return `${count(String(text).length)} characters`
}

const STYLE = `
:root { color-scheme: light dark; --fg: #1f1f1d; --muted: #6d6b67; --rule: #0000001a; --card: #00000008; }
@media (prefers-color-scheme: dark) { :root { --fg: #efefec; --muted: #9f9e98; --rule: #ffffff1a; --card: #ffffff08; } }
body { font: 14px/1.5 system-ui, sans-serif; color: var(--fg); max-width: 1100px; margin: 2rem auto; padding: 0 1.5rem; }
h1 { font-size: 1.3rem; margin: 0 0 .25rem; } h2 { font-size: 1rem; margin: 2rem 0 .5rem; }
.meta { color: var(--muted); margin-bottom: 1.5rem; } a { color: inherit; }
details { border: 1px solid var(--rule); border-radius: 8px; margin: .5rem 0; background: var(--card); }
summary { cursor: pointer; padding: .5rem .75rem; } summary .muted { color: var(--muted); }
details > :not(summary) { margin: 0 .75rem .75rem; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 12.5px/1.5 ui-monospace, monospace; margin: .25rem 0 .75rem; }
.kind { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; margin-top: .5rem; }
.new { border-left: 3px solid #3987e5; }
table { border-collapse: collapse; width: 100%; } td, th { text-align: left; padding: .4rem .5rem; border-top: 1px solid var(--rule); vertical-align: top; }
th { color: var(--muted); font-weight: 500; } .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
`

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`
}

function usageText(usage) {
  if (!usage) return 'no usage recorded yet'
  const read = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
  const parts = [
    `${count(read)} tokens in (${count(usage.cacheRead)} from the cache)`,
    `${count(usage.output)} out`,
  ]
  if (usage.costUsd !== undefined) parts.push(`$${usage.costUsd.toFixed(4)}`)
  if (usage.durationMs !== undefined) parts.push(`${(usage.durationMs / 1000).toFixed(1)}s`)

  return parts.join(' · ')
}

/** One request whole: its system prompt, its tools, every message, and the answer. */
export function requestPage({ session, records, seq, system, tools, link }) {
  const record = records.find(one => one.seq === seq)
  if (!record) return null
  const messages = fullMessages(records, seq) ?? []
  const firstNew = record.from
  const systemBlocks = (system ?? [])
    .map(
      (one, index) =>
        `<details><summary>Block ${index + 1} <span class="muted">${size(one.text ?? '')}</span></summary><pre>${escapeHtml(one.text ?? '')}</pre></details>`,
    )
    .join('')
  const toolList = (tools ?? [])
    .map(
      one =>
        `<details><summary>${escapeHtml(one.name ?? 'tool')} <span class="muted">${size(JSON.stringify(one))}</span></summary><pre>${escapeHtml(JSON.stringify(one, null, 2))}</pre></details>`,
    )
    .join('')
  const messageList = messages
    .map((message, index) => {
      const isNew = index >= firstNew
      const text = blocksOf(message.content).map(block).join('')

      return `<details class="${isNew ? 'new' : ''}"${isNew ? ' open' : ''}><summary>#${index + 1} ${escapeHtml(message.role)}${isNew ? ' <span class="muted">new in this request</span>' : ''}</summary>${text}</details>`
    })
    .join('')
  const answer = record.response
    ? blocksOf(record.response.content).map(block).join('') ||
      `<pre>${escapeHtml(JSON.stringify(record.response, null, 2))}</pre>`
    : '<p class="meta">No answer recorded yet.</p>'

  return page(
    `Request #${seq + 1}`,
    `<p><a href="${link(session)}">← Every request of this session</a></p>
<h1>Request #${seq + 1} · ${escapeHtml(record.source)}</h1>
<div class="meta">${escapeHtml(record.at)} · ${escapeHtml(record.model)} · ${usageText(record.usage)}</div>
<h2>System prompt <span class="muted">(${(system ?? []).length} blocks)</span></h2>${systemBlocks}
<h2>Tools <span class="muted">(${(tools ?? []).length})</span></h2>${toolList}
<h2>Messages <span class="muted">(${messages.length}; the ${messages.length - firstNew} new in this request are open)</span></h2>${messageList}
<h2>Answer${record.response?.stop_reason ? ` <span class="muted">(${escapeHtml(record.response.stop_reason)})</span>` : ''}</h2>${answer}`,
  )
}

/** A session's requests, newest first, each linking to its page. */
export function sessionPage({ session, records, link }) {
  const rows = [...records]
    .sort((a, b) => b.seq - a.seq)
    .map(record => {
      const cost = record.usage?.costUsd
      const tokens = record.usage
        ? (record.usage.input ?? 0) + (record.usage.cacheRead ?? 0) + (record.usage.cacheWrite ?? 0)
        : null

      return `<tr><td><a href="${link(session, record.seq)}">#${record.seq + 1}</a></td><td>${escapeHtml(record.at)}</td><td>${escapeHtml(record.source)}</td><td class="num">${record.messageCount}</td><td class="num">${tokens === null ? '' : count(tokens)}</td><td class="num">${count(record.usage?.output ?? '')}</td><td class="num">${cost === undefined ? '' : `$${cost.toFixed(4)}`}</td></tr>`
    })
    .join('')
  const total = records.reduce((sum, one) => sum + (one.usage?.costUsd ?? 0), 0)

  return page(
    `Trace ${session}`,
    `<h1>Trace</h1><div class="meta">Session ${escapeHtml(session)} · ${records.length} requests · $${total.toFixed(2)}</div>
<table><tr><th>Request</th><th>Sent</th><th>From</th><th class="num">Messages</th><th class="num">Tokens in</th><th class="num">Out</th><th class="num">Cost</th></tr>${rows}</table>`,
  )
}
