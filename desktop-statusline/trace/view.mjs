// The trace receiver's pages: a session's requests, and each request whole,
// as the model received it, for a browser on this machine. Plain JavaScript,
// importing only store.mjs, so Node runs it and the tests load it.
//
// The pages draw like the plugin's pane in the desktop app: a warm neutral
// surface, bordered cards of rows with hairline dividers, semibold headings
// with a muted figure at the right, tabular numbers. Everything from a trace
// goes through `escapeHtml`; nothing it holds becomes markup. The one script,
// which expands and collapses sections and copies blocks, runs only with the
// nonce the receiver gives each response, and the pages work without it.

import { fullMessages, goesOn, isMain, promptRecord } from './store.mjs'

export { fullMessages, promptRecord }

/** Text safe inside HTML. */
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Characters per token, as the pane assumes (hooks/tools.ts, CHARS_PER_TOKEN). */
const CHARS_PER_TOKEN = 3.6
/** The most messages a request's page opens by itself. */
const OPEN_AT_MOST = 50

function count(value) {
  return Number(value ?? 0).toLocaleString('en-US')
}

/** `21k`, `18.2k`, `1M`: a count as the pane prints it (hooks/context.ts, formatTokens). */
function short(value) {
  const number = Number(value ?? 0)
  const round = one => one.toFixed(1).replace(/\.0$/, '')
  if (number >= 999_950) return `${round(number / 1_000_000)}M`
  if (number >= 1000) return `${round(number / 1000)}k`

  return String(Math.round(number))
}

function money(usd) {
  return `$${Number(usd).toFixed(usd < 0.01 ? 4 : 2)}`
}

function seconds(ms) {
  return `${(Number(ms) / 1000).toFixed(1)}s`
}

/** `42.1s`, `3m 12s`, `1h 10m`: a span of time, as the status line prints one. */
function duration(ms) {
  const whole = Math.max(0, Math.floor(Number(ms) / 1000))
  if (whole < 60) return seconds(ms)
  const minutes = Math.floor(whole / 60)
  if (minutes < 60) return `${minutes}m ${whole % 60}s`

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** A record's time of day and its date, in this machine's own time zone. */
function when(at) {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return { clock: String(at ?? ''), date: '' }
  const two = one => String(one).padStart(2, '0')

  return {
    clock: `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`,
    date: date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }),
  }
}

/** A text's size, and about how many tokens it takes. */
function sizeOf(chars) {
  return `${short(chars)} chars · ~${short(chars / CHARS_PER_TOKEN)} tokens`
}

function read(usage) {
  return (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
}

/** A request's figures: tokens read, how much of that came from the cache, tokens written, cost, time. */
function usageParts(usage) {
  if (!usage) return []
  const total = read(usage)
  const cached = total > 0 ? Math.round(((usage.cacheRead ?? 0) / total) * 100) : 0
  const parts = [`${short(total)} in`]
  if (cached > 0) parts.push(`${cached}% cached`)
  parts.push(`${short(usage.output)} out`)
  if (usage.costUsd !== undefined) parts.push(money(usage.costUsd))
  if (usage.durationMs !== undefined) parts.push(seconds(usage.durationMs))
  if (usage.effort) parts.push(`${escapeHtml(usage.effort)} effort`)

  return parts
}

/** Where a side request came from, in a word, and the tone of its pill. */
function sourceTag(source) {
  if (isMain(source)) return null
  if (source === 'generate_session_title') return { label: 'Title', tone: 'amber' }
  if (String(source).startsWith('agent')) return { label: 'Subagent', tone: 'orange' }
  if (String(source).startsWith('compact')) return { label: 'Compact', tone: 'green' }

  return { label: String(source).replace(/_/g, ' '), tone: 'grey' }
}

function pill(label, tone, title) {
  return `<span class="pill tone-${tone}"${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(label)}</span>`
}

const ROLE_TONE = { user: 'blue', assistant: 'orange', system: 'amber' }

/**
 * A message's content as blocks, whatever shape a record holds: a string is
 * one text block, and anything that is not a block is shown as its JSON.
 */
function blocksOf(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (content === null || content === undefined) return []

  return (Array.isArray(content) ? content : [content]).map(one =>
    one !== null && typeof one === 'object' && !Array.isArray(one)
      ? one
      : { type: 'value', value: one },
  )
}

/** A field as text, whatever it holds. */
function textOf(value) {
  return typeof value === 'string'
    ? value
    : value === undefined || value === null
      ? ''
      : JSON.stringify(value)
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return JSON.stringify(content, null, 2)

  return content
    .map(one => (one?.type === 'text' ? one.text : JSON.stringify(one, null, 2)))
    .join('\n\n')
}

function oneLine(text, max) {
  const line = String(text).replace(/\s+/g, ' ').trim()

  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** What a text block is, when it is not the person's or the model's own words. */
function textNote(text) {
  if (/^\s*<system-reminder>/.test(text)) return 'system reminder'
  if (/^\s*<task-notification>/.test(text)) return 'notification'

  return null
}

/** What one block is, in a few words, for a message's row. */
function blockLabel(one) {
  switch (one.type) {
    case 'text':
      return textNote(textOf(one.text)) ?? `“${oneLine(textOf(one.text), 80)}”`
    case 'tool_use':
      return `→ ${textOf(one.name)}`
    case 'tool_result':
      return one.is_error ? 'tool result, an error' : 'tool result'
    case 'thinking':
    case 'redacted_thinking':
      return 'thinking'
    default:
      return textOf(one.type) || 'value'
  }
}

/**
 * How much text a block carries, as the page shows it: an image or a document
 * carries none, its encoded bytes being nothing the model reads as text.
 */
function blockChars(one) {
  switch (one.type) {
    case 'text':
      return textOf(one.text).length
    case 'thinking':
      return textOf(one.thinking).length
    case 'tool_use':
      return JSON.stringify(one.input ?? {}).length
    case 'tool_result':
      return blocksOf(one.content).reduce((sum, block) => sum + blockChars(block), 0)
    case 'image':
    case 'document':
      return 0
    default:
      return JSON.stringify(one).length
  }
}

function pre(text) {
  return `<pre>${escapeHtml(text)}</pre>`
}

/**
 * A tool call's input as its fields: a string as it is, anything else as
 * JSON, so a command or an edit reads as written rather than escaped.
 */
function fields(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return pre(JSON.stringify(input ?? {}, null, 2))
  }
  const entries = Object.entries(input)
  if (entries.length === 0) return '<div class="empty">no input</div>'

  return `<dl class="fields">${entries
    .map(
      ([key, value]) =>
        `<dt>${escapeHtml(key)}</dt><dd>${pre(typeof value === 'string' ? value : JSON.stringify(value, null, 2))}</dd>`,
    )
    .join('')}</dl>`
}

/** One block of a message: its kind above, where it has one, its text below, a copy button beside. */
function block(one) {
  const kind = (label, tone, name) =>
    `<div class="block-head"><span class="dot tone-${tone}"></span><span class="kind">${escapeHtml(label)}</span>${name ? `<code class="name">${escapeHtml(name)}</code>` : ''}</div>`
  const wrap = (cls, head, body) =>
    `<div class="block${cls ? ` ${cls}` : ''}">${head}<div class="body">${body}</div><button class="copy js-only" type="button">Copy</button></div>`
  switch (one.type) {
    case 'text': {
      const text = textOf(one.text)
      const note = textNote(text)

      return wrap(note ? 'quiet' : '', note ? kind(note, 'grey') : '', pre(text))
    }
    case 'thinking':
      return wrap('quiet', kind('thinking', 'grey'), pre(textOf(one.thinking)))
    case 'redacted_thinking':
      return wrap(
        'quiet',
        kind('thinking, redacted', 'grey'),
        '<div class="empty">kept by the API</div>',
      )
    case 'tool_use':
      return wrap('', kind('tool call', 'amber', textOf(one.name)), fields(one.input))
    case 'tool_result':
      return wrap(
        one.is_error ? 'error' : '',
        kind(
          one.is_error ? 'tool result, an error' : 'tool result',
          one.is_error ? 'red' : 'green',
        ),
        pre(contentText(one.content)),
      )
    default:
      return wrap('', kind(textOf(one.type) || 'value', 'grey'), pre(JSON.stringify(one, null, 2)))
  }
}

/** A card's heading row: its name, its figure, and the buttons the script gives it. */
function cardHead(id, title, figure, hasRows) {
  const actions = hasRows
    ? `<span class="actions js-only"><button type="button" data-for="${id}" data-open="1">Expand all</button><button type="button" data-for="${id}" data-open="0">Collapse all</button></span>`
    : ''

  return `<div class="card-head"><h2>${escapeHtml(title)}</h2><span class="figure">${figure}</span>${actions}</div>`
}

/** One row of a card that opens onto its text. */
function row({ cls, id, open, label, tag, preview, figure, body }) {
  return `<details class="row${cls ? ` ${cls}` : ''}"${open ? ' open' : ''}${id ? ` id="${id}"` : ''}><summary><span class="chev"></span><span class="label">${label}</span>${tag ?? ''}<span class="preview">${preview ?? ''}</span><span class="figure">${figure}</span></summary><div class="content">${body}</div></details>`
}

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #f4f3ee; --card: #fcfbf8; --code: #f1efe9; --hover: #0000000a;
  --border: #0000001a; --hair: #00000012;
  --fg: #1f1e1d; --muted: #67655f; --faint: #9c9a92;
  --blue: #2f73c9; --orange: #c24d1f; --green: #13835c; --amber: #9f6a00; --grey: #6f6d66; --red: #c0392b;
  --top: #f4f3eecc;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1a1a19; --card: #232322; --code: #1d1d1c; --hover: #ffffff0a;
    --border: #ffffff14; --hair: #ffffff0f;
    --fg: #ecebe6; --muted: #97958d; --faint: #6b6a64;
    --blue: #3987e5; --orange: #d95926; --green: #199e70; --amber: #c98500; --grey: #97958d; --red: #e5584a;
    --top: #1a1a19d9;
  }
}
* { box-sizing: border-box; }
html { background: var(--bg); color: var(--fg); font: 13.5px/1.5 ui-sans-serif, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
body { margin: 0; }
a { color: inherit; }
code, pre, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.wrap { max-width: 1120px; margin: 0 auto; padding: 0 24px; }
main.wrap { padding-top: 20px; padding-bottom: 64px; }
.num, .figure, .tabular, .stat-value, .top .figures { font-variant-numeric: tabular-nums; }
h1, h2 { margin: 0; font-weight: 600; }
h1 { font-size: 20px; letter-spacing: -0.01em; }
h2 { font-size: 14px; }
.muted { color: var(--muted); }
.faint { color: var(--faint); }

.pill { display: inline-flex; align-items: center; height: 18px; padding: 0 7px; border-radius: 9px; font-size: 11.5px; font-weight: 500; line-height: 1; white-space: nowrap; color: var(--tone); background: color-mix(in srgb, var(--tone) 14%, transparent); }
.tone-blue { --tone: var(--blue); } .tone-orange { --tone: var(--orange); } .tone-green { --tone: var(--green); }
.tone-amber { --tone: var(--amber); } .tone-grey { --tone: var(--grey); } .tone-red { --tone: var(--red); }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--tone); flex: none; }
.tag { display: inline-flex; align-items: center; height: 18px; padding: 0 6px; border-radius: 5px; font-size: 11px; font-weight: 500; color: var(--muted); border: 1px solid var(--border); white-space: nowrap; }
.tag.new { color: var(--blue); border-color: color-mix(in srgb, var(--blue) 40%, transparent); background: color-mix(in srgb, var(--blue) 10%, transparent); }

.card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; margin-bottom: 20px; scroll-margin-top: 96px; }
.card-head { display: flex; align-items: center; gap: 10px; padding: 11px 14px; border-bottom: 1px solid var(--border); }
.card-head .figure { color: var(--muted); font-size: 12.5px; flex: 1 1 auto; min-width: 0; }
.actions { display: flex; gap: 2px; margin-right: -6px; }
.actions button, .copy { font: inherit; font-size: 12px; color: var(--muted); background: none; border: 0; border-radius: 6px; padding: 3px 7px; cursor: pointer; }
.actions button:hover, .copy:hover { background: var(--hover); color: var(--fg); }
.js-only { display: none; }
.js .js-only { display: inline-flex; }
.note { padding: 12px 14px; color: var(--muted); }

.row { scroll-margin-top: 140px; }
/* A closed row is one line; the browser lays the lines of a long list out as they come into view. An
   open one is laid out whole, so a jump to an anchor below it lands where it should. */
.row:not([open]) { content-visibility: auto; contain-intrinsic-size: auto 40px; }
.row + .row { border-top: 1px solid var(--hair); }
.row > summary { display: flex; align-items: center; gap: 10px; padding: 9px 14px; cursor: pointer; list-style: none; user-select: none; }
.row > summary::-webkit-details-marker { display: none; }
.row > summary:hover { background: var(--hover); }
.row[open] > summary { background: var(--hover); }
.chev { width: 6px; height: 6px; margin: 0 5px 0 2px; border-right: 1.5px solid var(--faint); border-bottom: 1.5px solid var(--faint); transform: rotate(-45deg); transition: transform .12s ease; flex: none; }
.row[open] > summary .chev { transform: rotate(45deg); }
.row .label { font-weight: 500; white-space: nowrap; }
.row .preview { flex: 1 1 auto; min-width: 0; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .figure { color: var(--muted); font-size: 12.5px; white-space: nowrap; }
.row .content { padding: 6px 14px 14px 33px; }
.card > .content { padding: 12px 14px 14px; }
.row.new { box-shadow: inset 3px 0 0 var(--blue); }
.row .seq { display: inline-block; min-width: 3em; color: var(--faint); font-size: 12px; font-variant-numeric: tabular-nums; }

pre { margin: 0; padding: 10px 12px; font-size: 12.5px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--code); border: 1px solid var(--hair); border-radius: 7px; }
.block { position: relative; }
.lazy .block { content-visibility: auto; contain-intrinsic-size: auto 80px; }
.block + .block { margin-top: 10px; }
.block-head { display: flex; align-items: center; gap: 7px; margin: 0 0 5px 1px; font-size: 12px; color: var(--muted); }
.block-head .kind { text-transform: uppercase; letter-spacing: .05em; font-weight: 500; font-size: 11px; }
.block-head .name { font-size: 12.5px; color: var(--fg); }
.block.quiet pre { color: var(--muted); }
.block.error pre { border-color: color-mix(in srgb, var(--red) 40%, transparent); }
.copy { position: absolute; top: -4px; right: 0; opacity: 0; }
.block:hover .copy, .copy:focus-visible { opacity: 1; }
.block:not(:has(.block-head)) .copy { top: 4px; right: 4px; }
.fields { margin: 0; display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 12px; align-items: start; }
.fields dt { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: var(--muted); padding-top: 10px; }
.fields dd { margin: 0; min-width: 0; }
.empty { color: var(--faint); font-style: italic; padding: 4px 0; }

.top { position: sticky; top: 0; z-index: 2; background: var(--top); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border-bottom: 1px solid var(--border); }
.top .wrap { display: flex; flex-direction: column; }
.top-row { display: flex; align-items: center; gap: 10px; min-height: 46px; }
.top-row.sections { min-height: 36px; margin-top: -6px; }
.top .back { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); text-decoration: none; padding: 4px 8px 4px 4px; margin-left: -4px; border-radius: 6px; }
.top .back:hover { background: var(--hover); color: var(--fg); }
.top .back .chev { transform: rotate(135deg); margin: 0 0 0 4px; }
.top .sep { width: 1px; height: 18px; background: var(--border); }
.top .figures { margin-left: auto; color: var(--muted); font-size: 12.5px; white-space: nowrap; }
.top .step { display: flex; gap: 2px; }
.top .step > * { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 6px; color: var(--muted); text-decoration: none; }
.top .step a:hover { background: var(--hover); }
.top .step a:hover .chev { border-color: var(--fg); }
.top .step > span { opacity: .4; }
.top .step .chev { margin: 0; }
.top .step .prev .chev { transform: rotate(135deg); }
.top .step .next .chev { transform: rotate(-45deg); }
.sections a { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 9px; border-radius: 6px; color: var(--muted); text-decoration: none; font-size: 12.5px; }
.sections a:hover { background: var(--hover); color: var(--fg); }
.sections a b { font-weight: 500; color: var(--fg); font-variant-numeric: tabular-nums; }
.sections a.new-link { color: var(--blue); }
.sections a.new-link b { color: var(--blue); }

.page-head { padding: 32px 0 20px; }
.page-head .sub { display: flex; align-items: center; gap: 8px; color: var(--muted); margin-top: 6px; flex-wrap: wrap; }
.page-head code { font-size: 12.5px; padding: 1px 6px; border-radius: 5px; background: var(--hover); border: 1px solid var(--hair); }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 20px; }
.stat { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px 11px; }
.stat-label { font-size: 12px; color: var(--muted); }
.stat-value { font-size: 20px; font-weight: 600; line-height: 1.3; margin-top: 2px; letter-spacing: -0.01em; }
.stat-note { font-size: 12px; color: var(--muted); margin-top: 1px; }

.grid { --cols: minmax(150px, 0.8fr) 80px 86px minmax(170px, 1fr) 70px 80px 70px 20px; }
.grid-head, .grid-row { display: grid; grid-template-columns: var(--cols); gap: 14px; align-items: center; padding: 0 14px; }
.grid-head { height: 34px; color: var(--muted); font-size: 12px; border-bottom: 1px solid var(--border); }
.grid-row { min-height: 38px; color: inherit; text-decoration: none; content-visibility: auto; contain-intrinsic-size: auto 38px; }
.grid-row + .grid-row { border-top: 1px solid var(--hair); }
.grid-row:hover { background: var(--hover); }
.grid-row:last-child { border-radius: 0 0 10px 10px; }
.grid-row .name { display: flex; align-items: center; gap: 8px; font-weight: 500; }
.grid-row .time { color: var(--muted); }
.grid-row .cost, .grid-row .out, .grid-row .msgs, .grid-row .secs { color: var(--fg); }
.grid-row .waiting { grid-column: span 4; color: var(--faint); font-style: italic; }
.grid-row .go { color: var(--faint); display: flex; justify-content: flex-end; }
.grid-row .go .chev { transform: rotate(-45deg); margin: 0; }
.grid-row:hover .go .chev { border-color: var(--muted); }
.tokens { display: flex; align-items: center; justify-content: flex-end; gap: 10px; }
.bar { width: 64px; height: 6px; border-radius: 3px; background: var(--hover); overflow: hidden; display: flex; flex: none; }
.bar i { display: block; height: 100%; }
.bar .cached { background: var(--grey); opacity: .55; } .bar .written { background: var(--amber); } .bar .fresh { background: var(--blue); }
.legend { display: inline-flex; gap: 12px; color: var(--muted); font-size: 12px; }
.legend span { display: inline-flex; align-items: center; gap: 5px; }
.legend i { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
@media (max-width: 760px) {
  .grid { --cols: minmax(120px, 1fr) 70px 70px 70px 20px; }
  .grid .tokens, .grid .cost, .grid .secs, .grid-head .hide-narrow { display: none; }
  .top .figures { display: none; }
}
`

const SCRIPT = `
document.documentElement.classList.add('js')
document.addEventListener('click', event => {
  const button = event.target.closest('button')
  if (!button) return
  if (button.dataset.open !== undefined) {
    // Every row of a section open is more than a browser lays out at once:
    // such a section lays its blocks out as they come into view.
    const section = document.getElementById(button.dataset.for)
    const open = button.dataset.open === '1'
    section.classList.toggle('lazy', open)
    for (const one of section.querySelectorAll('details')) one.open = open
  } else if (button.classList.contains('copy')) {
    const text = button.parentElement.querySelector('.body').innerText
    navigator.clipboard.writeText(text).then(() => {
      button.textContent = 'Copied'
      setTimeout(() => { button.textContent = 'Copy' }, 1500)
    })
  }
})
`

function page(title, body, nonce) {
  const script = nonce ? `<script nonce="${escapeHtml(nonce)}">${SCRIPT}</script>` : ''

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>${body}${script}</body></html>`
}

/** One request whole: its system prompt, its tools, every message, and the answer. */
export function requestPage({ session, records, seq, system, tools, link, nonce }) {
  const record = records.find(one => one.seq === seq)
  if (!record) return null
  const messages = (fullMessages(records, seq) ?? []).filter(
    one => one !== null && typeof one === 'object',
  )
  // What this request added comes last, however it was sent.
  const firstNew = Math.max(0, messages.length - record.added.length)
  const newCount = messages.length - firstNew
  const tag = sourceTag(record.source)
  const time = when(record.at)
  const seqs = records.map(one => one.seq)
  const step = (cls, to, title) =>
    seqs.includes(to)
      ? `<a class="${cls}" href="${link(session, to)}" title="${title}"><span class="chev"></span></a>`
      : `<span class="${cls}"><span class="chev"></span></span>`

  const systemBlocks = blocksOf(Array.isArray(system) ? system : [])
  const systemChars = systemBlocks.reduce((sum, one) => sum + textOf(one.text).length, 0)
  const systemRows = systemBlocks
    .map((one, index) =>
      row({
        label: `Block ${index + 1}`,
        tag: one.cache_control ? '<span class="tag">cached</span>' : '',
        preview: escapeHtml(oneLine(textOf(one.text), 120)),
        figure: `${short(textOf(one.text).length)} chars`,
        body: pre(textOf(one.text)),
      }),
    )
    .join('')

  const toolList = blocksOf(Array.isArray(tools) ? tools : [])
  const toolChars = toolList.reduce((sum, one) => sum + JSON.stringify(one).length, 0)
  const toolRows = toolList
    .map(one =>
      row({
        label: `<code>${escapeHtml(textOf(one.name) || 'tool')}</code>`,
        preview: escapeHtml(oneLine(textOf(one.description), 120)),
        figure: `${short(JSON.stringify(one).length)} chars`,
        body: pre(JSON.stringify(one, null, 2)),
      }),
    )
    .join('')

  // A request that sends the conversation afresh adds it whole: every message
  // is new, and all open would be more than a browser lays out. The last of
  // them open; the rest are marked and stay closed.
  const firstOpen = Math.max(firstNew, messages.length - OPEN_AT_MOST)
  let messageChars = 0
  const messageRows = messages
    .map((message, index) => {
      const isNew = index >= firstNew
      const blocks = blocksOf(message.content)
      const chars = blocks.reduce((sum, one) => sum + blockChars(one), 0)
      messageChars += chars
      const role = String(message.role)
      const labels = blocks.map(blockLabel)
      const preview =
        labels.length > 4 ? [...labels.slice(0, 4), `+${labels.length - 4} more`] : labels

      return row({
        cls: isNew ? 'new' : '',
        id: index === firstNew && isNew ? 'new' : '',
        open: index >= firstOpen,
        label: `<span class="seq">#${index + 1}</span>${pill(role, ROLE_TONE[role] ?? 'grey')}`,
        tag: isNew ? '<span class="tag new">new</span>' : '',
        preview: escapeHtml(preview.join(' · ')),
        figure: `${blocks.length === 1 ? '1 block' : `${blocks.length} blocks`} · ${short(chars)} chars`,
        body: blocks.map(block).join(''),
      })
    })
    .join('')

  const response = record.response
  const answerBlocks = response ? blocksOf(response.content) : []
  const answer = !response
    ? '<div class="note">No answer recorded yet.</div>'
    : `<div class="content">${answerBlocks.map(block).join('') || pre(JSON.stringify(response, null, 2))}</div>`
  const answerFigure = [
    response?.stop_reason ? escapeHtml(response.stop_reason) : '',
    record.usage?.output !== undefined ? `${short(record.usage.output)} tokens out` : '',
  ]
    .filter(Boolean)
    .join(' · ')

  const messagesFigure = [
    `${count(messages.length)} ${messages.length === 1 ? 'message' : 'messages'}`,
    newCount > 0 ? `${count(newCount)} new in this request` : 'none new',
    firstOpen > firstNew ? `the last ${count(messages.length - firstOpen)} open` : '',
    sizeOf(messageChars),
  ]
    .filter(Boolean)
    .join(' · ')

  return page(
    `Request #${seq + 1}${tag ? ` · ${tag.label}` : ''}`,
    `<header class="top"><div class="wrap">
<div class="top-row">
<a class="back" href="${link(session)}"><span class="chev"></span>Session</a>
<span class="sep"></span>
<h1>Request #${seq + 1}</h1>${tag ? pill(tag.label, tag.tone, record.source) : ''}
<span class="muted" title="${escapeHtml(record.at)}">${escapeHtml(record.model)} · ${escapeHtml(time.clock)}</span>
<span class="figures">${record.usage ? usageParts(record.usage).join(' · ') : 'waiting for its answer'}</span>
<nav class="step">${step('prev', seq - 1, 'Previous request')}${step('next', seq + 1, 'Next request')}</nav>
</div>
<nav class="top-row sections">
<a href="#system">System prompt <b>${systemBlocks.length}</b></a>
<a href="#tools">Tools <b>${toolList.length}</b></a>
<a href="#messages">Messages <b>${count(messages.length)}</b></a>
${newCount > 0 ? `<a class="new-link" href="#new">New <b>${newCount}</b></a>` : ''}
<a href="#answer">Answer</a>
</nav>
</div></header>
<main class="wrap">
<section class="card" id="system">${cardHead('system', 'System prompt', `${systemBlocks.length} ${systemBlocks.length === 1 ? 'block' : 'blocks'} · ${sizeOf(systemChars)}`, systemBlocks.length > 0)}${systemRows || '<div class="note">No system prompt.</div>'}</section>
<section class="card" id="tools">${cardHead('tools', 'Tools', `${toolList.length} ${toolList.length === 1 ? 'tool' : 'tools'} · ${sizeOf(toolChars)}`, toolList.length > 0)}${toolRows || '<div class="note">No tools.</div>'}</section>
<section class="card" id="messages">${cardHead('messages', 'Messages', messagesFigure, messages.length > 0)}${messageRows || '<div class="note">No messages.</div>'}</section>
<section class="card" id="answer">${cardHead('answer', 'Answer', answerFigure, false)}${answer}</section>
</main>`,
    nonce,
  )
}

/** A session's requests, newest first, each linking to its page. */
export function sessionPage({ session, records, link, nonce }) {
  const sorted = [...records].sort((a, b) => b.seq - a.seq)
  const used = records.filter(one => one.usage)
  const total = {
    cost: used.reduce((sum, one) => sum + (one.usage.costUsd ?? 0), 0),
    read: used.reduce((sum, one) => sum + read(one.usage), 0),
    cached: used.reduce((sum, one) => sum + (one.usage.cacheRead ?? 0), 0),
    out: used.reduce((sum, one) => sum + (one.usage.output ?? 0), 0),
    ms: used.reduce((sum, one) => sum + (one.usage.durationMs ?? 0), 0),
  }
  const mainCount = records.filter(one => isMain(one.source)).length
  const widest = Math.max(1, ...used.map(one => read(one.usage)))
  const times = records.map(one => when(one.at)).filter(one => one.date !== '')
  const first = [...records].sort((a, b) => a.seq - b.seq)[0]
  const last = sorted[0]
  const span =
    times.length === 0
      ? ''
      : (() => {
          const from = when(first.at)
          const to = when(last.at)
          const at = one => one.clock.slice(0, 5)

          return from.date === to.date
            ? `${from.date} · ${at(from)} to ${at(to)}`
            : `${from.date} ${at(from)} to ${to.date} ${at(to)}`
        })()

  const rows = sorted
    .map(record => {
      const tag = sourceTag(record.source)
      const usage = record.usage
      const time = when(record.at)
      const width = part => `${((Number(part ?? 0) / widest) * 100).toFixed(1)}%`
      const figures = usage
        ? `<span class="tokens num"><span>${short(read(usage))}</span><span class="bar" title="${count(usage.cacheRead)} from the cache, ${count(usage.cacheWrite)} written to it, ${count(usage.input)} fresh"><i class="cached" style="width:${width(usage.cacheRead)}"></i><i class="written" style="width:${width(usage.cacheWrite)}"></i><i class="fresh" style="width:${width(usage.input)}"></i></span></span><span class="out num">${short(usage.output)}</span><span class="cost num">${usage.costUsd === undefined ? '' : money(usage.costUsd)}</span><span class="secs num">${usage.durationMs === undefined ? '' : seconds(usage.durationMs)}</span>`
        : '<span class="waiting">waiting for its answer</span>'

      return `<a class="grid-row" href="${link(session, record.seq)}"><span class="name">#${record.seq + 1}${tag ? pill(tag.label, tag.tone, record.source) : ''}</span><span class="time num" title="${escapeHtml(record.at)}">${escapeHtml(time.clock)}</span><span class="msgs num">${count(record.messageCount)}</span>${figures}<span class="go"><span class="chev"></span></span></a>`
    })
    .join('')
  const legend =
    '<span class="legend"><span><i class="cached" style="background:var(--grey);opacity:.55"></i>cached</span><span><i style="background:var(--amber)"></i>written to cache</span><span><i style="background:var(--blue)"></i>fresh</span></span>'
  const stat = (label, value, note) =>
    `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${value}</div><div class="stat-note">${note}</div></div>`

  return page(
    `Trace ${session}`,
    `<main class="wrap">
<header class="page-head"><h1>Trace</h1><div class="sub"><code>${escapeHtml(session)}</code>${span ? `<span>·</span><span>${escapeHtml(span)}</span>` : ''}</div></header>
<section class="stats">
${stat('Requests', count(records.length), `${count(mainCount)} conversation · ${count(records.length - mainCount)} side`)}
${stat('Cost', `$${total.cost.toFixed(2)}`, used.length === records.length ? 'every request answered' : `${count(records.length - used.length)} still waiting`)}
${stat('Tokens in', short(total.read), total.read > 0 ? `${Math.round((total.cached / total.read) * 100)}% from the cache` : 'none yet')}
${stat('Tokens out', short(total.out), used.length > 0 ? `${short(total.out / used.length)} per request` : 'none yet')}
${stat('Model time', duration(total.ms), 'summed over every request')}
</section>
<section class="card"><div class="card-head"><h2>Requests</h2><span class="figure">newest first</span>${legend}</div>
<div class="grid"><div class="grid-head"><span>Request</span><span>Time</span><span class="num">Messages</span><span class="num hide-narrow">Tokens in</span><span class="num hide-narrow">Out</span><span class="num hide-narrow">Cost</span><span class="num hide-narrow">Duration</span><span></span></div>${rows || '<div class="note">No requests yet.</div>'}</div></section>
</main>`,
    nonce,
  )
}
