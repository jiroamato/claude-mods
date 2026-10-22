// While npm packs the installer, the package gets the repository's README and
// LICENSE, so its npm page shows the plugin's documentation (npm runs this as
// `prepack`). npm renders the README away from the repository, so its relative
// links are made absolute, pinned to the commit being packed, where every file
// they name exists. `node pack-docs.mjs remove` (npm's `postpack`) takes both
// out again: the plugin folder keeps no README of its own, so the plugin
// directory reads the repository's.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

const FILES = ['README.md', 'LICENSE']
const REPO = 'jiroamato/claude-mods'

if (process.argv[2] === 'remove') {
  for (const file of FILES) fs.rmSync(file, { force: true })
} else {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  // `[text](target)` and `![alt](target)` whose target is a path in the repository,
  // not a URL or an anchor on the page.
  const readme = fs
    .readFileSync('../README.md', 'utf8')
    .replace(/(!?)\[([^\]]*)\]\((?![a-z]+:|#)([^)\s]+)\)/g, (_, image, text, target) => {
      const base = image
        ? `https://raw.githubusercontent.com/${REPO}/${commit}`
        : `https://github.com/${REPO}/blob/${commit}`
      return `${image}[${text}](${base}/${target})`
    })
  fs.writeFileSync('README.md', readme)
  fs.copyFileSync('../LICENSE', 'LICENSE')
}
