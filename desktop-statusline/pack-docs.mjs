import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const REPO = 'jiroamato/claude-mods'
const FOLDER = 'desktop-statusline'
const KEPT = '.README.committed.md'

if (process.argv[2] === 'restore') {
  if (fs.existsSync(KEPT)) fs.renameSync(KEPT, 'README.md')
  fs.rmSync('LICENSE', { force: true })
} else {
  if (!fs.existsSync(KEPT)) fs.copyFileSync('README.md', KEPT)
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
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
