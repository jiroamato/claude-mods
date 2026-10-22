// Readies the package's documents while npm packs the installer (npm runs this
// as `prepack`). npm renders this folder's README away from the repository, so
// its relative links are made absolute, pinned to the commit being packed,
// where every file they name exists; and the repository's LICENSE is copied
// in. `node pack-docs.mjs restore` (npm's `postpack`) puts the README back as
// committed and takes the LICENSE out again.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const REPO = 'jiroamato/claude-mods'
/** This folder, as a path in the repository. */
const FOLDER = 'desktop-statusline'
/** The README as committed, kept aside while npm packs the rewritten one. */
const KEPT = '.README.committed.md'

if (process.argv[2] === 'restore') {
  if (fs.existsSync(KEPT)) fs.renameSync(KEPT, 'README.md')
  fs.rmSync('LICENSE', { force: true })
} else {
  // A pack stopped before `postpack` left the committed README aside: that is
  // the one to rewrite, not the rewritten copy beside it.
  if (!fs.existsSync(KEPT)) fs.copyFileSync('README.md', KEPT)
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  // `[text](target)` and `![alt](target)` whose target is a path in the repository,
  // not a URL or an anchor on the page.
  const readme = fs
    .readFileSync(KEPT, 'utf8')
    .replace(/(!?)\[([^\]]*)\]\((?![a-z]+:|#)([^)\s]+)\)/g, (_, image, text, target) => {
      const file = path.posix.normalize(`${FOLDER}/${target}`)
      const base = image
        ? `https://raw.githubusercontent.com/${REPO}/${commit}`
        : `https://github.com/${REPO}/blob/${commit}`
      return `${image}[${text}](${base}/${file})`
    })
  fs.writeFileSync('README.md', readme)
  fs.copyFileSync('../LICENSE', 'LICENSE')
}
