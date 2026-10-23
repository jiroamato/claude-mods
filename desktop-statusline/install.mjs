#!/usr/bin/env node

import { spawnSync } from 'node:child_process'

const MARKETPLACE = 'claude-mods'
const REPO = 'jiroamato/claude-mods'
const PLUGIN = `desktop-statusline@${MARKETPLACE}`
const README =
  'https://github.com/jiroamato/claude-mods/tree/main/desktop-statusline#in-the-claude-desktop-app'

function claude(args, { show = false } = {}) {
  return spawnSync(`claude ${args}`, {
    shell: true,
    encoding: 'utf8',
    stdio: show ? 'inherit' : 'pipe',
  })
}

function fail(message) {
  process.stderr.write(`\n${message}\n`)
  process.exit(1)
}

function isThisRepo(marketplace) {
  if (marketplace.source === 'github') return marketplace.repo?.toLowerCase() === REPO
  return /github\.com[/:]jiroamato\/claude-mods(\.git)?\/?$/i.test(marketplace.url ?? '')
}

if (claude('--version').status !== 0) {
  fail(
    'The `claude` command is not available here, so the plugin cannot be installed from\n' +
      'this terminal. Install Claude Code and run this again, or install the plugin from\n' +
      `the Claude desktop app's Plugins page:\n\n  ${README}`,
  )
}

const listed = claude('plugin marketplace list --json')
let marketplaces
try {
  marketplaces = JSON.parse(listed.stdout)
} catch {
  fail(
    'Could not read your marketplaces from `claude plugin marketplace list --json`.\n' +
      'Update Claude Code and run this again.' +
      (listed.stderr ? `\n\n${listed.stderr.trim()}` : ''),
  )
}

const existing = marketplaces.find(marketplace => marketplace.name === MARKETPLACE)
if (!existing) {
  const added = claude(`plugin marketplace add ${REPO}`, { show: true })
  if (added.status !== 0) process.exit(added.status ?? 1)
} else if (!isThisRepo(existing)) {
  fail(
    `A marketplace named ${MARKETPLACE} is already added from another source, so this one\n` +
      `cannot be added beside it. Remove it with \`claude plugin marketplace remove ${MARKETPLACE}\`\n` +
      'and run this again.',
  )
}

const installed = claude(`plugin install ${PLUGIN}`, { show: true })
if (installed.status !== 0) process.exit(installed.status ?? 1)

process.stdout.write(
  '\nStart a new Code session in the Claude desktop app and the status bar appears\n' +
    'above the prompt. Running sessions keep what they had until they end.\n',
)
